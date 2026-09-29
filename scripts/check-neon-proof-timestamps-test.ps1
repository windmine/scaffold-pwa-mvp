Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Extract only pure functions; never execute the cloud proof's top-level code.
$source = Join-Path $PSScriptRoot 'prove-neon-recovery.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Proof script parse errors' }
foreach ($name in @('Parse-Utc', 'Test-ProofBranchOwnership')) {
  $node = $ast.Find({ param($candidate) $candidate -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $candidate.Name -eq $name }, $true)
  if (-not $node) { throw "Missing pure function $name" }
  . ([scriptblock]::Create($node.Extent.Text))
}
$start = [DateTime]::UtcNow
$restore = $start.AddMinutes(-5)
$expires = $start.AddMinutes(60)
foreach ($encoding in @('string', 'utc', 'local', 'json')) {
  $branch = [pscustomobject]@{
    id = 'br-owned'; name = 'proof-owned'; project_id = 'project-owned'; parent_id = 'br-production'
    current_state = 'ready'; default = $false; primary = $false
    created_at = $start.ToString('o'); parent_timestamp = $restore.ToString('o'); expires_at = $expires.ToString('o')
  }
  if ($encoding -eq 'utc') { $branch.created_at=$start; $branch.parent_timestamp=$restore; $branch.expires_at=$expires }
  if ($encoding -eq 'local') { $branch.created_at=$start.ToLocalTime(); $branch.parent_timestamp=$restore.ToLocalTime(); $branch.expires_at=$expires.ToLocalTime() }
  if ($encoding -eq 'json') { $branch = $branch | ConvertTo-Json | ConvertFrom-Json }
  if (-not (Test-ProofBranchOwnership $branch 'br-owned' 'proof-owned' 'project-owned' 'br-production' $start $restore $expires $false)) {
    throw "Ownership failed for $encoding timestamps"
  }
  $branch.parent_id = 'br-unrelated'
  if (Test-ProofBranchOwnership $branch 'br-owned' 'proof-owned' 'project-owned' 'br-production' $start $restore $expires $false) {
    throw 'Unrelated parent accepted'
  }
  Write-Output "ok - $encoding timestamps retain exact instant and reject unrelated ownership"
}
Write-Output 'Neon proof timestamp tests passed without cloud access'
