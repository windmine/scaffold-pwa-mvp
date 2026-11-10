param([Parameter(Mandatory = $true)][string]$RequestPath, [string]$ContextFile = '')
# Read-only acquisition only. Does not create a branch, fetch credentials, update
# a runner, execute a job, migrate a database, or delete anything.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'check-recovery-migration-contract.ps1')
. (Join-Path $PSScriptRoot 'check-recovery-evidence-safety.ps1')
function Read-NeonMetadata([string[]]$Arguments) {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $raw = @(& npx -y neon@2.32.0 @Arguments --no-analytics -o json 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'provider read failed' }
    return (($raw -join "`n") | ConvertFrom-Json)
  } finally { $ErrorActionPreference = $old }
}
try {
  $request = Get-Content -LiteralPath $RequestPath -Raw | ConvertFrom-Json
  $root = Split-Path -Parent $PSScriptRoot
  if ([IO.Path]::GetFullPath($request.repoRoot) -cne [IO.Path]::GetFullPath($root)) { throw 'wrong source root' }
  $contextPath = if (-not $ContextFile) { Join-Path $root '.neon' } elseif ([IO.Path]::IsPathRooted($ContextFile)) { $ContextFile } else { Join-Path $root $ContextFile }
  $context = Get-Content -LiteralPath $contextPath -Raw | ConvertFrom-Json
  $projectId = $request.caller.neonProjectId
  if ($projectId -isnot [string] -or $projectId -cnotmatch '^[a-z0-9-]+$' -or $projectId -cne $context.projectId) { throw 'wrong Neon context' }
  $contract = Get-RecoveryMigrationContract -MigrationsDirectory (Join-Path $root 'backend/migrations/versions') `
    -ReleasePhase $request.caller.releasePhase -PreMigrationRecoveryHead $request.caller.preMigrationHead
  $request.config.contract = $contract
  if ($request.config.mode -cin @('recovery','backup-inventory')) {
    $target = $request.config.target
    $branchId = $target.branch.id
    if ($branchId -isnot [string] -or $branchId -cnotmatch '^br-[a-z0-9-]+$') { throw 'invalid branch' }
    $rawBranch = Read-NeonMetadata @('branch', 'get', $branchId, '--project-id', $projectId)
    $branch = if ($rawBranch.PSObject.Properties.Name -contains 'branch') { $rawBranch.branch } else { $rawBranch }
    $rawEndpoints = Read-NeonMetadata @('api', "/projects/$projectId/branches/$branchId/endpoints", '--method', 'GET')
    $endpoints = @($rawEndpoints.endpoints)
    $branches = @(Read-NeonMetadata @('branch', 'list', '--project-id', $projectId))
    $production = @($branches | Where-Object { $_.id -ceq $branch.parent_id -and $_.name -ceq 'production' })
    if ($production.Count -ne 1 -or $production[0].default -isnot [bool] -or -not $production[0].default -or
        $production[0].primary -isnot [bool] -or -not $production[0].primary -or
        $production[0].current_state -cne 'ready') { throw 'production parent mismatch' }
    if ($endpoints.Count -ne 1) { throw 'endpoint count mismatch' }
    $endpoint = $endpoints[0]
    $selectedBranch = [ordered]@{}
    foreach ($key in @('id','project_id','parent_id','name','default','primary','parent_timestamp','created_at','expires_at','current_state')) {
      $selectedBranch[$key] = $branch.$key
    }
    $selectedEndpoint = [ordered]@{}
    foreach ($key in @('id','project_id','branch_id','type','host','current_state')) {
      $selectedEndpoint[$key] = $endpoint.$key
    }
    # Exact provider snapshot replaces no caller claim silently: any supplied
    # expected field must match, then the acquired snapshot is frozen in payload.
    foreach ($key in $selectedBranch.Keys) {
      if (($target.branch.$key | ConvertTo-Json -Compress) -cne ($selectedBranch[$key] | ConvertTo-Json -Compress)) { throw 'branch snapshot changed' }
    }
    foreach ($key in $selectedEndpoint.Keys) {
      if (($target.endpoint.$key | ConvertTo-Json -Compress) -cne ($selectedEndpoint[$key] | ConvertTo-Json -Compress)) { throw 'endpoint snapshot changed' }
    }
    if ($branch.project_id -cne $projectId -or $endpoint.project_id -cne $projectId -or
        $endpoint.branch_id -cne $branchId -or $endpoint.type -cne 'read_only' -or
        $branch.default -isnot [bool] -or $branch.default -or $branch.primary -isnot [bool] -or $branch.primary -or
        $branch.current_state -cne 'ready' -or $endpoint.current_state -cnotin @('active','idle')) { throw 'ownership snapshot mismatch' }
    $expectedName = if ($request.config.mode -ceq 'recovery') { 'recovery-proof-' + $request.config.runId } else { 'reportflow-recipdir-backup-20261110' }
    if ($branch.name -cne $expectedName) { throw 'unowned branch name' }
    $started = ConvertTo-RecoveryEvidenceUtc $target.request.startedAtUtc
    $expiry = ConvertTo-RecoveryEvidenceUtc $target.request.expiresAtUtc
    $actualExpiry = ConvertTo-RecoveryEvidenceUtc $branch.expires_at
    $created = ConvertTo-RecoveryEvidenceUtc $branch.created_at
    if ($actualExpiry -le [DateTime]::UtcNow -or $started -gt [DateTime]::UtcNow -or $created -gt [DateTime]::UtcNow -or
        [Math]::Abs(($actualExpiry - $expiry).TotalSeconds) -gt 120) { throw 'unsafe recovery time window' }
    if ($request.config.mode -ceq 'recovery') {
      $restore = ConvertTo-RecoveryEvidenceUtc $target.request.restorePointUtc
      $actualRestore = ConvertTo-RecoveryEvidenceUtc $branch.parent_timestamp
      if ($actualExpiry -gt $started.AddMinutes(15) -or $created -lt $started.AddMinutes(-1) -or
          $restore -ge $started.AddMinutes(-1) -or $actualRestore -ge $started.AddMinutes(-1) -or
          [Math]::Abs(($actualRestore - $restore).TotalSeconds) -gt 120) { throw 'unsafe recovery time window' }
    }
    $request.config.target.branch = [pscustomobject]$selectedBranch
    $request.config.target.endpoint = [pscustomobject]$selectedEndpoint
  } elseif ($request.config.mode -cnotin @('production-inventory','production-migrate')) { throw 'unsupported mode' }
  $json = $request | ConvertTo-Json -Depth 100 -Compress
  $json | & python (Join-Path $PSScriptRoot 'runtime_recovery.py') prepare --request -
  if ($LASTEXITCODE -ne 0) { throw 'payload preparation failed' }
} catch {
  Write-Output '{"passed":false,"failureCode":"runtime_recovery_preparation_rejected"}'
  exit 1
}
