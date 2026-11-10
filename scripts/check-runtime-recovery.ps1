# Read-only schema 4 adapter. The Python validator owns the evidence contract.
function Test-RuntimeRecovery {
  param(
    $Evidence, $Contract,
    [string]$EvidencePath, [string]$ProjectId, [string]$Region,
    [string]$RuntimeServiceAccount, [string]$DatabaseSecret, [string]$JwtSecret,
    [int]$MinimumHistoryHours, [int]$MaximumAgeDays,
    [string]$ReleasePhase, [string]$PreMigrationHead, [string]$NeonProjectId
  )
  $savedPreference = $ErrorActionPreference
  $savedExitCode = $global:LASTEXITCODE
  $buildArchivePath = $null
  try {
    $ErrorActionPreference = 'Stop'
    $candidates = @()
    foreach ($file in @(Get-ChildItem -Path (Resolve-RepoPath $EvidencePath) -File -ErrorAction SilentlyContinue | Sort-Object Name -Descending)) {
      try {
        $value = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        $completed = ConvertTo-RecoveryEvidenceUtc $value.completedAtUtc
        $candidates += [pscustomobject]@{ File = $file.FullName; Evidence = $value; Completed = $completed }
      } catch { continue }
    }
    if ($candidates.Count -eq 0) { throw 'invalid' }
    $selected = @($candidates | Sort-Object Completed -Descending)[0]
    if (($selected.Evidence | ConvertTo-Json -Depth 100 -Compress) -cne ($Evidence | ConvertTo-Json -Depth 100 -Compress)) { throw 'invalid' }
    if (($Evidence.schemaVersion -isnot [int] -and $Evidence.schemaVersion -isnot [long]) -or $Evidence.schemaVersion -ne 4) { throw 'invalid' }
    # Never interpolate untrusted identifiers into a Logging query or CLI option.
    foreach ($identifier in @($ProjectId, $Region, $NeonProjectId, $Evidence.runtime.execution, $Evidence.runtime.job, $Evidence.runtime.buildId)) {
      if ($identifier -isnot [string] -or $identifier -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$') { throw 'invalid' }
    }
    if ($null -ne $Evidence.migration) {
      foreach ($identifier in @($Evidence.migration.execution, $Evidence.migration.job)) {
        if ($identifier -isnot [string] -or $identifier -cnotmatch '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$') { throw 'invalid' }
      }
    }
    $providers = [ordered]@{
      project = Invoke-NeonJson @('projects', 'get', $NeonProjectId)
      branches = @(Invoke-NeonJson @('branch', 'list', '--project-id', $NeonProjectId))
      endpoints = Invoke-NeonJson @('api', "/projects/$NeonProjectId/endpoints", '--method', 'GET')
      execution = Invoke-GcloudJson @('run', 'jobs', 'executions', 'describe', $Evidence.runtime.execution, '--project', $ProjectId, '--region', $Region)
      logs = $null
      build = Invoke-GcloudJson @('builds', 'describe', $Evidence.runtime.buildId, '--project', $ProjectId, '--region', $Region)
      buildArchiveFile = $null
      migrationExecution = $null
      migrationLogs = $null
    }
    $source = $providers.build.sourceProvenance.resolvedStorageSource
    if ($source.bucket -isnot [string] -or $source.bucket -cnotmatch '^[a-z0-9][a-z0-9._-]{1,221}[a-z0-9]$' -or
        $source.object -isnot [string] -or $source.object -cnotmatch '^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$' -or
        @($source.object.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -gt 0 -or
        $source.generation -isnot [string] -or $source.generation -cnotmatch '^[1-9][0-9]{0,24}$') { throw 'invalid' }
    $buildArchivePath = Join-Path ([IO.Path]::GetTempPath()) ('runtime-build-' + [Guid]::NewGuid().ToString('N') + '.tgz')
    $sourceUrl = 'gs://' + $source.bucket + '/' + $source.object + '#' + $source.generation
    $copyResult = Invoke-GcloudResult @('storage', 'cp', $sourceUrl, $buildArchivePath, '--project', $ProjectId)
    if ($copyResult.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $buildArchivePath -PathType Leaf) -or
        (Get-Item -LiteralPath $buildArchivePath).Length -gt (64 * 1024 * 1024)) { throw 'invalid' }
    $providers.buildArchiveFile = $buildArchivePath
    $filter = 'resource.type="cloud_run_job" AND resource.labels.project_id="{0}" AND resource.labels.location="{1}" AND resource.labels.job_name="{2}" AND labels."run.googleapis.com/execution_name"="{3}" AND logName="projects/{0}/logs/run.googleapis.com%2Fstdout"' -f $ProjectId, $Region, $Evidence.runtime.job, $Evidence.runtime.execution
    # Include the proof's start near the maximum-age boundary, not only its
    # completion. Python independently enforces the exact evidence age limit.
    $logFreshness = ([Math]::Max(1, $MaximumAgeDays) + 1).ToString() + 'd'
    $providers.logs = @(Invoke-GcloudJson @('logging', 'read', $filter, '--project', $ProjectId, '--limit', '1000', '--freshness', $logFreshness))
    if ($null -ne $Evidence.migration) {
      $providers.migrationExecution = Invoke-GcloudJson @('run', 'jobs', 'executions', 'describe', $Evidence.migration.execution, '--project', $ProjectId, '--region', $Region)
      $filter = 'resource.type="cloud_run_job" AND resource.labels.project_id="{0}" AND resource.labels.location="{1}" AND resource.labels.job_name="{2}" AND labels."run.googleapis.com/execution_name"="{3}" AND logName="projects/{0}/logs/run.googleapis.com%2Fstdout"' -f $ProjectId, $Region, $Evidence.migration.job, $Evidence.migration.execution
      $providers.migrationLogs = @(Invoke-GcloudJson @('logging', 'read', $filter, '--project', $ProjectId, '--limit', '1000', '--freshness', $logFreshness))
    }
    $request = [ordered]@{
      repoRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
      evidencePath = $EvidencePath
      evidenceFile = $selected.File
      contract = $Contract
      caller = [ordered]@{
        projectId = $ProjectId; region = $Region; runtimeServiceAccount = $RuntimeServiceAccount
        databaseSecret = $DatabaseSecret; jwtSecret = $JwtSecret
        minimumHistoryHours = $MinimumHistoryHours; maximumAgeDays = $MaximumAgeDays
        releasePhase = $ReleasePhase; preMigrationHead = $PreMigrationHead; neonProjectId = $NeonProjectId
      }
      providers = $providers
    }
    # Provider payloads may contain unexpected secrets: never persist them.
    $output = @(($request | ConvertTo-Json -Depth 100) | & python (Join-Path $PSScriptRoot 'runtime_recovery.py') validate --request - 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'invalid' }
    $result = ($output -join "`n") | ConvertFrom-Json
    if ($result.passed -isnot [bool] -or -not $result.passed) { throw 'invalid' }
    return $true
  } catch {
    Write-Host 'not ok - runtime recovery evidence failed strict validation'
    return $false
  } finally {
    if ($buildArchivePath -and (Test-Path -LiteralPath $buildArchivePath)) { Remove-Item -LiteralPath $buildArchivePath -Force -ErrorAction SilentlyContinue }
    $global:LASTEXITCODE = $savedExitCode
    $ErrorActionPreference = $savedPreference
  }
}
