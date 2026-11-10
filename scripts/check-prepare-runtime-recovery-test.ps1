# Offline producer integration: actual canonical acquisition script, mocked
# pinned Neon command and Python payload boundary. No external reads or writes.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$directory = Join-Path $tempRoot ('prepare-runtime-tests-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $directory
function Assert($Value, $Message) { if (-not $Value) { throw $Message } }
try {
  $runner = Join-Path $directory 'runner.ps1'
  @'
param($Root, $Directory)
$global:fixtureDirectory = $Directory
function global:npx {
  $global:LASTEXITCODE = 0
  Add-Content -LiteralPath (Join-Path $global:fixtureDirectory 'commands.jsonl') -Value (ConvertTo-Json -InputObject @($args) -Compress)
  if ($args[2] -eq 'branch' -and $args[3] -eq 'get') { return Get-Content -LiteralPath (Join-Path $global:fixtureDirectory 'branch.json') -Raw }
  if ($args[2] -eq 'branch' -and $args[3] -eq 'list') { return Get-Content -LiteralPath (Join-Path $global:fixtureDirectory 'branches.json') -Raw }
  if ($args[2] -eq 'api') { return Get-Content -LiteralPath (Join-Path $global:fixtureDirectory 'endpoints.json') -Raw }
  throw 'unexpected provider operation'
}
function global:python {
  if ($args[-1] -cne '-') { throw 'payload must use stdin' }
  ($input | Out-String) | Set-Content -LiteralPath (Join-Path $global:fixtureDirectory 'captured.json')
  $global:LASTEXITCODE = 0
  return '{"passed":true}'
}
$parameters = @{RequestPath = (Join-Path $Directory 'request.json')}
if (Test-Path -LiteralPath (Join-Path $Directory 'explicit-context.json')) { $parameters.ContextFile = Join-Path $Directory 'explicit-context.json' }
& (Join-Path $Root 'scripts/prepare-runtime-recovery.ps1') @parameters
exit $LASTEXITCODE
'@ | Set-Content -LiteralPath $runner -Encoding utf8
  $project = (Get-Content -LiteralPath (Join-Path $root '.neon') -Raw | ConvertFrom-Json).projectId
  foreach ($case in @('happy', 'explicit-context', 'wrong-explicit-context', 'wrong-parent', 'default', 'primary', 'endpoint-type', 'host-mismatch', 'expired', 'rewritten-local-metadata', 'production-not-primary')) {
    $caseDir = Join-Path $directory $case
    $null = New-Item -ItemType Directory -Path $caseDir
    if ($case -eq 'explicit-context') { @{projectId=$project} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseDir 'explicit-context.json') }
    if ($case -eq 'wrong-explicit-context') { '{"projectId":"wrong-project"}' | Set-Content -LiteralPath (Join-Path $caseDir 'explicit-context.json') }
    $now = [DateTime]::UtcNow
    $branch = [ordered]@{id='br-proof';project_id=$project;parent_id='br-production';name='recovery-proof-fixture';default=$false;primary=$false;parent_timestamp=$now.AddMinutes(-6).ToString('o');created_at=$now.AddMinutes(-1).ToString('o');expires_at=$now.AddMinutes(8).ToString('o');current_state='ready'}
    $endpoint = [ordered]@{id='ep-proof';project_id=$project;branch_id='br-proof';type='read_only';host='ep-proof.example.neon.tech';current_state='active'}
    $production = [ordered]@{id='br-production';name='production';default=$true;primary=$true;current_state='ready'}
    if ($case -eq 'wrong-parent') { $branch.parent_id = 'br-wrong' }
    if ($case -eq 'default') { $branch.default = $true }
    if ($case -eq 'primary') { $branch.primary = $true }
    if ($case -eq 'endpoint-type') { $endpoint.type = 'read_write' }
    if ($case -eq 'expired') { $branch.expires_at = $now.AddMinutes(-1).ToString('o') }
    if ($case -eq 'production-not-primary') { $production.primary = $false }
    $request = [ordered]@{
      repoRoot=$root
      caller=@{neonProjectId=$project;releasePhase='Current';preMigrationHead=''}
      config=@{mode='recovery';runId='fixture';contract=@{CandidateHead='untrusted-local-contract'};target=@{
        branch=($branch | ConvertTo-Json | ConvertFrom-Json)
        endpoint=($endpoint | ConvertTo-Json | ConvertFrom-Json)
        request=@{startedAtUtc=$now.AddMinutes(-2).ToString('o');restorePointUtc=$now.AddMinutes(-6).ToString('o');expiresAtUtc=$branch.expires_at}
      }}
    }
    if ($case -eq 'host-mismatch') { $request.config.target.endpoint.host = 'attacker.invalid' }
    if ($case -eq 'rewritten-local-metadata') { $request.config.target.branch.created_at = $now.AddMinutes(-10).ToString('o') }
    $request | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath (Join-Path $caseDir 'request.json') -Encoding utf8
    $branch | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $caseDir 'branch.json') -Encoding utf8
    ConvertTo-Json -InputObject @($production) | Set-Content -LiteralPath (Join-Path $caseDir 'branches.json') -Encoding utf8
    @{endpoints=@($endpoint)} | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $caseDir 'endpoints.json') -Encoding utf8
    $output = (& (Get-Process -Id $PID).Path -NoProfile -File $runner -Root $root -Directory $caseDir 2>&1 | Out-String)
    if ($case -in @('happy', 'explicit-context')) {
      Assert ($LASTEXITCODE -eq 0) "happy acquisition failed: $output"
      $captured = Get-Content -LiteralPath (Join-Path $caseDir 'captured.json') -Raw | ConvertFrom-Json
      Assert (-not (Get-Content -LiteralPath (Join-Path $caseDir 'captured.json') -Raw).Contains('explicit-context.json')) 'physical context path must not reach prepared payload'
      Assert ($captured.config.contract.CandidateLedger.Count -ge 28 -and $captured.config.contract.CandidateHead -ne 'untrusted-local-contract') 'source migration contract must replace local contract'
      foreach ($key in $branch.Keys) {
        if ($key -in @('parent_timestamp', 'created_at', 'expires_at')) { Assert (([DateTime]$captured.config.target.branch.$key).ToUniversalTime().ToString('o') -ceq ([DateTimeOffset]::Parse($branch[$key])).UtcDateTime.ToString('o')) "acquired branch timestamp lost: $key" }
        else { Assert ($captured.config.target.branch.$key -eq $branch[$key]) "acquired branch field lost: $key" }
      }
      foreach ($key in $endpoint.Keys) { Assert ($captured.config.target.endpoint.$key -eq $endpoint[$key]) "acquired endpoint field lost: $key" }
      $commands = @(Get-Content -LiteralPath (Join-Path $caseDir 'commands.jsonl') | ForEach-Object { ,($_ | ConvertFrom-Json) })
      $expected = @("-y neon@2.32.0 branch get br-proof --project-id $project --no-analytics -o json", "-y neon@2.32.0 api /projects/$project/branches/br-proof/endpoints --method GET --no-analytics -o json", "-y neon@2.32.0 branch list --project-id $project --no-analytics -o json")
      Assert ($commands.Count -eq 3) 'exact three provider reads required'
      for ($i=0; $i -lt 3; $i++) { Assert (($commands[$i] -join ' ') -ceq $expected[$i]) 'unexpected provider command' }
    } else {
      Assert ($LASTEXITCODE -eq 1 -and $output.Contains('runtime_recovery_preparation_rejected')) "$case must fail safely: $output"
      Assert (-not (Test-Path -LiteralPath (Join-Path $caseDir 'captured.json'))) "$case must be rejected before payload preparation"
    }
    Write-Host "ok - canonical read-only producer: $case (provider and Python mocked)"
  }
} finally {
  $resolved = [IO.Path]::GetFullPath($directory)
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notlike 'prepare-runtime-tests-*') { throw 'Unsafe cleanup path' }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
}
