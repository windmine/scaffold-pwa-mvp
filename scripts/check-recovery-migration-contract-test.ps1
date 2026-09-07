$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "check-recovery-migration-contract.ps1")
$migrationTestDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) "backend/migrations/versions"
$currentContract = Get-RecoveryMigrationContract -MigrationsDirectory $migrationTestDirectory
if ($currentContract.ReleasePhase -cne "Current" -or
    $currentContract.CandidateHead -cne $currentContract.ExpectedRecoveryHead -or
    $currentContract.ExpectedLedger.Count -lt 19) { throw "Current must require every exact bundled migration" }
Write-Host "ok - Current requires the full exact source migration ledger"
$baselineHead = "0017_global_admin_supervisor_invariant"
$baselineContract = Get-RecoveryMigrationContract -MigrationsDirectory $migrationTestDirectory `
  -ReleasePhase PreMigration -PreMigrationRecoveryHead $baselineHead
if ($baselineContract.ExpectedRecoveryHead -cne $baselineHead -or $baselineContract.ExpectedLedger.Count -ne 17 -or
    $baselineContract.CandidateHead -cne $currentContract.CandidateHead) { throw "PreMigration must retain candidate identity and require the exact declared source prefix" }
Write-Host "ok - explicit PreMigration requires the exact declared source prefix"
$baselineVerification = [pscustomobject]@{
  migrationCount = 17
  migrationHead = $baselineHead
  migrationVersions = @($baselineContract.ExpectedLedger.version)
  migrationChecksums = [pscustomobject]([ordered]@{})
}
foreach ($entry in $baselineContract.ExpectedLedger) {
  $baselineVerification.migrationChecksums | Add-Member -NotePropertyName $entry.version -NotePropertyValue $entry.checksum
}
if (-not (Test-RecoveryMigrationVerification -Contract $baselineContract -Verification $baselineVerification)) {
  throw "exact ordered source prefix with every checksum must pass PreMigration"
}
if (Test-RecoveryMigrationVerification -Contract $currentContract -Verification $baselineVerification) {
  throw "baseline recovery must not satisfy Current"
}
Write-Host "ok - exact prefix passes PreMigration but cannot pass Current"

function Assert-ContractRejected([string]$Name, [scriptblock]$Action) {
  $rejected = $false
  try { & $Action | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw "$Name must fail" }
  Write-Host "ok - $Name fails"
}
Assert-ContractRejected "Current baseline override" {
  Get-RecoveryMigrationContract -MigrationsDirectory $migrationTestDirectory -PreMigrationRecoveryHead $baselineHead
}
Assert-ContractRejected "implicit PreMigration baseline" {
  Get-RecoveryMigrationContract -MigrationsDirectory $migrationTestDirectory -ReleasePhase PreMigration
}
foreach ($head in @("0017", "0017_unknown", "9999_future", $currentContract.CandidateHead)) {
  Assert-ContractRejected "unknown, abbreviated, future or non-prefix head $head" {
    Get-RecoveryMigrationContract -MigrationsDirectory $migrationTestDirectory -ReleasePhase PreMigration -PreMigrationRecoveryHead $head
  }
}

foreach ($entry in $currentContract.CandidateLedger) {
  $exactHash = (Get-FileHash -LiteralPath (Join-Path $migrationTestDirectory "$($entry.version).py") -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($entry.checksum -cne $exactHash) { throw "migration hashes must use exact source bytes" }
}
Write-Host "ok - source checksums match exact file bytes"

$baselineEvidence = [pscustomobject]@{
  schemaVersion = 3
  releasePhase = "PreMigration"
  candidateHead = $baselineContract.CandidateHead
  expectedRecoveryHead = $baselineContract.ExpectedRecoveryHead
  expectedMigrationHead = $baselineContract.ExpectedRecoveryHead
  candidateMigrationLedger = $baselineContract.CandidateLedger
  expectedRecoveryMigrationLedger = $baselineContract.ExpectedLedger
  verification = $baselineVerification
}
if (-not (Test-RecoveryMigrationEvidence $baselineContract $baselineEvidence)) { throw "exact phase-bound baseline evidence must pass" }
if (Test-RecoveryMigrationEvidence $currentContract $baselineEvidence) { throw "Current cannot reuse phase-bound baseline evidence" }
Write-Host "ok - schema 3 evidence is bound to its exact release phase and candidate"

function Assert-EvidenceRejected([string]$Name, [scriptblock]$Change) {
  $candidate = $baselineEvidence | ConvertTo-Json -Depth 15 | ConvertFrom-Json
  & $Change $candidate
  if (Test-RecoveryMigrationEvidence $baselineContract $candidate) { throw "$Name must fail" }
  Write-Host "ok - $Name fails"
}
Assert-EvidenceRejected "old schema without full source checksums" { param($item) $item.schemaVersion = 2 }
Assert-EvidenceRejected "wrong candidate head" { param($item) $item.candidateHead = "9999_future" }
Assert-EvidenceRejected "wrong declared baseline" { param($item) $item.expectedRecoveryHead = "0016_review_queue_indexes" }
Assert-EvidenceRejected "wrong release phase" { param($item) $item.releasePhase = "Current" }
Assert-EvidenceRejected "missing source candidate checksum ledger" { param($item) $item.PSObject.Properties.Remove("candidateMigrationLedger") }
Assert-EvidenceRejected "candidate source changed after proof" { param($item) $item.candidateMigrationLedger[-1].checksum = ('a' * 64) }
Assert-EvidenceRejected "baseline source changed after proof" { param($item) $item.expectedRecoveryMigrationLedger[0].checksum = ('a' * 64) }
Assert-EvidenceRejected "missing database checksums" { param($item) $item.verification.PSObject.Properties.Remove("migrationChecksums") }
Assert-EvidenceRejected "database checksum mismatch" { param($item) $item.verification.migrationChecksums.'0001_initial_schema' = ('a' * 64) }
Assert-EvidenceRejected "unexpected database ledger version" { param($item) $item.verification.migrationChecksums | Add-Member -NotePropertyName '9999_future' -NotePropertyValue ('a' * 64) }
Assert-EvidenceRejected "missing middle migration with unchanged head" { param($item) $item.verification.migrationVersions = @($item.verification.migrationVersions | Where-Object { $_ -ne '0002_work_form_photo_metadata' }) }
Assert-EvidenceRejected "out-of-order database ledger" { param($item) [array]::Reverse($item.verification.migrationVersions) }
Assert-EvidenceRejected "duplicate database ledger version" { param($item) $item.verification.migrationVersions[1] = $item.verification.migrationVersions[0] }
Assert-EvidenceRejected "wrong ledger count" { param($item) $item.verification.migrationCount = 16 }
Assert-EvidenceRejected "wrong database head" { param($item) $item.verification.migrationHead = '0016_review_queue_indexes' }

$currentVerification = [pscustomobject]@{
  migrationCount = $currentContract.ExpectedLedger.Count
  migrationHead = $currentContract.ExpectedRecoveryHead
  migrationVersions = @($currentContract.ExpectedLedger.version)
  migrationChecksums = [pscustomobject]([ordered]@{})
}
foreach ($entry in $currentContract.ExpectedLedger) {
  $currentVerification.migrationChecksums | Add-Member -NotePropertyName $entry.version -NotePropertyValue $entry.checksum
}
if (-not (Test-RecoveryMigrationVerification $currentContract $currentVerification)) { throw "full exact ledger must pass Current" }
if (Test-RecoveryMigrationVerification $baselineContract $currentVerification) { throw "migrated ledger must not pass the old baseline contract" }
Write-Host "ok - full exact candidate ledger passes Current, not the old baseline contract"
Write-Host "recovery migration contract offline checks passed"
