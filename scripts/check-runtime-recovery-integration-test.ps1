# Offline integration: execute the complete, unmodified canonical parent in a
# child PowerShell. Only external provider/Python boundaries are mocked. The
# Python semantic validator has its own fixture suite; these tests prove parent
# dispatch, argument propagation, safe queries, cleanup, and failure retention.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $temporaryRoot ('runtime-gate-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
try {
  $runner = Join-Path $directory 'runner.ps1'
  @'
param($Root, $Directory, $Case)
$ErrorActionPreference = 'Stop'
$global:testDirectory = $Directory
$global:caseName = $Case
function global:gcloud {
  $global:LASTEXITCODE = 0
  Add-Content -LiteralPath (Join-Path $global:testDirectory 'commands.jsonl') -Value (ConvertTo-Json -InputObject @($args) -Compress)
  if ($global:caseName -eq 'provider-failure' -and $args[0] -eq 'builds') {
    $global:LASTEXITCODE = 1
    Write-Error 'PRIVATE_PROVIDER_ERROR_SENTINEL' -ErrorAction Continue
    return '{"error":"PRIVATE_PROVIDER_JSON_SENTINEL"}'
  }
  if ($args[0] -eq 'builds') { return '{"sourceProvenance":{"resolvedStorageSource":{"bucket":"fixture-build-bucket","object":"source/fixture.tgz","generation":"123456"}}}' }
  if (($args[0..1] -join ' ') -eq 'storage cp') {
    if ($global:caseName -eq 'archive-download-failure') { $global:LASTEXITCODE = 1; return 'PRIVATE_PROVIDER_JSON_SENTINEL' }
    [IO.File]::WriteAllBytes($args[3], [byte[]]@(1, 2, 3))
    return
  }
  if (($args[0..1] -join ' ') -eq 'projects describe') { return '{"projectNumber":"123456"}' }
  if (($args[0..2] -join ' ') -eq 'iam service-accounts describe') { return '{"disabled":true}' }
  if (($args[0..1] -join ' ') -eq 'auth print-access-token') { return 'offline-token' }
  if (($args[0..1] -join ' ') -eq 'sql instances') { return '{"ipAddresses":[{"type":"PRIMARY"}],"settings":{"backupConfiguration":{"enabled":false,"pointInTimeRecoveryEnabled":false}}}' }
  return '{}'
}
function global:npx {
  $global:LASTEXITCODE = 0
  Add-Content -LiteralPath (Join-Path $global:testDirectory 'commands.jsonl') -Value (ConvertTo-Json -InputObject @($args) -Compress)
  if ($global:caseName -eq 'neon-provider-failure') {
    $global:LASTEXITCODE = 1
    Write-Error 'PRIVATE_PROVIDER_ERROR_SENTINEL' -ErrorAction Continue
    return '{"error":"PRIVATE_PROVIDER_JSON_SENTINEL"}'
  }
  return '{}'
}
function global:Invoke-RestMethod { return [pscustomobject]@{} }
function global:Get-ChildItem {
  [CmdletBinding()]param([string]$Path, [string]$LiteralPath, [switch]$File)
  if ($Path -and ($Path -like '*upload-recovery-proof-*.json' -or $Path -like '*alert-delivery-diagnosis-*.json')) { return }
  if ($Path -and ($Path -like '*neon-recovery-proof-*.json' -or $Path -like '*selected-runtime-*.json')) {
    return Microsoft.PowerShell.Management\Get-ChildItem -Path (Join-Path $global:testDirectory 'evidence*.json') -File
  }
  if ($LiteralPath) { return Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $LiteralPath -File:$File }
  return Microsoft.PowerShell.Management\Get-ChildItem -Path $Path -File:$File
}
function global:python {
  $requestPath = $args[-1]
  ($input | Out-String) | Set-Content -LiteralPath (Join-Path $global:testDirectory 'request.json')
  Set-Content -LiteralPath (Join-Path $global:testDirectory 'request-path.txt') -Value $requestPath
  if ($global:caseName -eq 'validator-failure') { $global:LASTEXITCODE = 1; return '{"passed":false}' }
  $global:LASTEXITCODE = 0
  return '{"passed":true}'
}
$parameters = @{}
if ($Case -eq 'override') {
  $parameters = @{
    ProjectId = 'fixture-project'; Region = 'us-central1'; RuntimeServiceAccount = 'fixture@fixture-project.iam.gserviceaccount.com'
    DatabaseSecret = 'fixture-database'; JwtSecret = 'fixture-jwt'; MinimumNeonHistoryHours = 48
    MaximumRecoveryEvidenceAgeDays = 7; ReleasePhase = 'PreMigration'; PreMigrationRecoveryHead = '0017_global_admin_supervisor_invariant'
    NeonRecoveryEvidence = 'selected-runtime-*.json'
  }
}
if ($Case -eq 'cloudsql') { $parameters.DatabaseProvider = 'cloudsql' }
if ($Case -eq 'explicit-context') { $parameters.NeonContextFile = Join-Path $Directory 'explicit-context.json' }
& (Join-Path $Root 'scripts/check-production-hardening.ps1') @parameters
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding utf8
  foreach ($case in @('default', 'override', 'explicit-context', 'validator-failure', 'provider-failure', 'neon-provider-failure', 'archive-download-failure', 'string-schema', 'cloudsql', 'unsafe-name')) {
    $caseDirectory = Join-Path $directory $case
    $null = New-Item -ItemType Directory -Path $caseDirectory
    if ($case -eq 'explicit-context') { '{"projectId":"fixture-explicit-neon-context"}' | Set-Content -LiteralPath (Join-Path $caseDirectory 'explicit-context.json') }
    $evidence = [ordered]@{
      schemaVersion = 4; completedAtUtc = [DateTime]::UtcNow.ToString('o')
      productionBranch = @{ historyRetentionSeconds = 21600 }
      runtime = @{ execution = 'proof-run-abc'; job = 'proof-run'; buildId = '11111111-2222-3333-4444-555555555555' }
      migration = @{ execution = 'migration-run-abc'; job = 'migration-run' }
    }
    if ($case -eq 'string-schema') { $evidence.schemaVersion = '4' }
    if ($case -eq 'unsafe-name') { $evidence.runtime.execution = 'x" OR true' }
    $evidence | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $caseDirectory 'evidence.json') -Encoding utf8
    @{schemaVersion=4;completedAtUtc=[DateTime]::UtcNow.AddDays(-1).ToString('o');runtime=@{execution='old-run';job='old-job';buildId='old-build'}} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $caseDirectory 'evidence-z-older.json') -Encoding utf8
    '{"schemaVersion":4,"completedAtUtc":"invalid"}' | Set-Content -LiteralPath (Join-Path $caseDirectory 'evidence-zz-invalid.json') -Encoding utf8
    $output = (& (Get-Process -Id $PID).Path -NoProfile -File $runner -Root $root -Directory $caseDirectory -Case $case 2>&1 | Out-String)
    Assert ($LASTEXITCODE -eq 1) "$case must retain unrelated hardening failures (exit $LASTEXITCODE): $output"
    Assert (-not $output.Contains('PRIVATE_PROVIDER_')) "$case must not print raw provider errors or JSON"
    foreach ($label in @('dedicated runtime service account is disabled', 'hosted readiness uptime check is missing or duplicated', 'required alert policy is missing or duplicated', 'upload bucket public access prevention is not enforced', 'Upload recovery evidence is missing')) {
      Assert ($output.Contains($label)) "$case lost existing check: $label"
    }
    $requestFile = Join-Path $caseDirectory 'request.json'
    if ($case -in @('string-schema', 'cloudsql', 'unsafe-name', 'provider-failure', 'neon-provider-failure', 'archive-download-failure')) {
      Assert (-not (Test-Path -LiteralPath $requestFile)) "$case must not reach runtime validator"
      if ($case -in @('provider-failure', 'neon-provider-failure', 'unsafe-name', 'archive-download-failure')) {
        Assert ($output.Contains('runtime recovery evidence failed strict validation')) "$case must have sanitized failure label"
        Assert ($output.Contains('runtime Neon recovery proof does not satisfy')) "$case must fail parent"
        Assert (-not $output.Contains('Neon history retention is only')) "$case must not warn using unvalidated history"
      }
      if ($case -eq 'cloudsql') {
        foreach ($label in @('Cloud SQL still has public IPv4 assigned', 'Cloud SQL automated backups are disabled', 'Cloud SQL point-in-time recovery is disabled')) {
          Assert ($output.Contains($label)) "Cloud SQL check lost: $label"
        }
      }
    } else {
      Assert (Test-Path -LiteralPath $requestFile) "$case must invoke runtime validator: $output"
      $request = Get-Content -LiteralPath $requestFile -Raw | ConvertFrom-Json
      Assert ((@($request.PSObject.Properties.Name | Sort-Object) -join ',') -eq 'caller,contract,evidenceFile,evidencePath,providers,repoRoot') 'request must use exact interface keys'
      Assert ($request.repoRoot -eq $root) 'source root must be canonical repo'
      Assert ($request.evidenceFile -eq (Join-Path $caseDirectory 'evidence.json')) 'selected raw evidence file must be passed'
      $removedPath = (Get-Content -LiteralPath (Join-Path $caseDirectory 'request-path.txt') -Raw).Trim()
      Assert ($removedPath -ceq '-') 'provider payload must use stdin, never a request temporary file'
      Assert (-not (Test-Path -LiteralPath $request.providers.buildArchiveFile)) 'downloaded archive temporary must be cleaned after success or failure'
      $expectedNeonProject = if ($case -eq 'explicit-context') { 'fixture-explicit-neon-context' } else { (Get-Content (Join-Path $root '.neon') -Raw | ConvertFrom-Json).projectId }
      Assert ($request.caller.neonProjectId -ceq $expectedNeonProject) 'selected Neon context project must propagate'
      Assert (-not (Get-Content -LiteralPath $requestFile -Raw).Contains('explicit-context.json')) 'local context path must never propagate into validator request'
      if ($case -eq 'override') {
        $expected = @{projectId='fixture-project';region='us-central1';runtimeServiceAccount='fixture@fixture-project.iam.gserviceaccount.com';databaseSecret='fixture-database';jwtSecret='fixture-jwt';minimumHistoryHours=48;maximumAgeDays=7;releasePhase='PreMigration';preMigrationHead='0017_global_admin_supervisor_invariant'}
        Assert ($request.evidencePath -eq 'selected-runtime-*.json') 'evidence override lost'
      } else {
        $expected = @{projectId='geo-attendance-system-db9ca';region='australia-southeast1';runtimeServiceAccount='geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com';databaseSecret='geo-backend-database-url';jwtSecret='geo-backend-jwt-secret';minimumHistoryHours=6;maximumAgeDays=30;releasePhase='Current';preMigrationHead=''}
        Assert ($request.evidencePath -eq 'docs/evidence/neon-recovery-proof-*.json') 'default evidence pattern lost'
      }
      foreach ($key in $expected.Keys) { Assert ($request.caller.$key -ceq $expected[$key]) "caller $key lost in $case" }
      Assert ($request.contract.ReleasePhase -eq $expected.releasePhase) 'canonical contract phase lost'
      Assert ($request.contract.CandidateLedger.Count -ge 28) 'canonical source ledger lost'
      $commands = @(Get-Content -LiteralPath (Join-Path $caseDirectory 'commands.jsonl') | ForEach-Object { ,($_ | ConvertFrom-Json) })
      $logCommands = @($commands | Where-Object { $_[0] -eq 'logging' })
      Assert ($logCommands.Count -eq 2) 'both exact executions require independent logs'
      $buildCommands = @($commands | Where-Object { $_[0] -eq 'builds' })
      $copyCommands = @($commands | Where-Object { $_[0] -eq 'storage' -and $_[1] -eq 'cp' })
      Assert ($copyCommands.Count -eq 1 -and $copyCommands[0][2] -ceq 'gs://fixture-build-bucket/source/fixture.tgz#123456' -and $copyCommands[0][3] -eq $request.providers.buildArchiveFile) 'exact immutable source generation must be downloaded to temporary file'
      Assert ($buildCommands.Count -eq 1) 'exact regional build must be read once'
      Assert (($buildCommands[0] -join ' ') -ceq ('builds describe 11111111-2222-3333-4444-555555555555 --project ' + $expected.projectId + ' --region ' + $expected.region + ' --format=json')) 'regional build binding lost'
      for ($logIndex = 0; $logIndex -lt $logCommands.Count; $logIndex++) {
        $command = $logCommands[$logIndex]
        $job = @('proof-run', 'migration-run')[$logIndex]
        $expectedFilter = 'resource.type="cloud_run_job" AND resource.labels.project_id="{0}" AND resource.labels.location="{1}" AND resource.labels.job_name="{2}" AND labels."run.googleapis.com/execution_name"="{2}-abc" AND logName="projects/{0}/logs/run.googleapis.com%2Fstdout"' -f $expected.projectId, $expected.region, $job
        Assert ($command[2] -ceq $expectedFilter) 'exact project/region/job/execution/stdout log binding lost'
        Assert (($command -join ' ').Contains('--limit 1000')) 'log limit lost'
        Assert (($command -join ' ').Contains('--freshness ' + ($expected.maximumAgeDays + 1) + 'd')) 'explicit evidence-age log window lost'
      }
      if ($case -eq 'validator-failure') {
        Assert ($output.Contains('runtime Neon recovery proof does not satisfy')) 'validator failure must fail parent'
        Assert (-not $output.Contains('Neon history retention is only')) 'invalid evidence must not drive history warning'
      } else {
        Assert ($output.Contains('runtime Neon recovery proof matches')) 'successful runtime check must execute without clearing other failures'
        Assert ($output.Contains('Neon history retention is only 6 hours; choose a longer paid window or external logical backups before relying on it for production recovery')) 'successful schema4 gate must preserve short-history warning'
      }
    }
    Write-Host "ok - full canonical parent: $case (provider and Python boundaries mocked)"
  }
} finally {
  $resolved = [IO.Path]::GetFullPath($directory)
  if (-not $resolved.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'runtime-gate-tests-*') { throw 'Unsafe test cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $resolved -ErrorAction Stop) { throw 'Test cleanup directory remains' }
}
# Expected nonzero child exits are assertions, not this suite's exit status.
# Run only after every assertion and the guarded cleanup have succeeded.
$global:LASTEXITCODE = 0
