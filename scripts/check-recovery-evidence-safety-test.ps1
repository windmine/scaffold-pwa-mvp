$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'check-recovery-migration-contract.ps1')
. (Join-Path $PSScriptRoot 'check-recovery-evidence-safety.ps1')
$migrationDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) 'backend/migrations/versions'

function New-TestEvidence($Contract) {
  $checksums = [pscustomobject]([ordered]@{})
  foreach ($entry in $Contract.ExpectedLedger) {
    $checksums | Add-Member -NotePropertyName $entry.version -NotePropertyValue $entry.checksum
  }
  return [pscustomobject]@{
    schemaVersion = 3; releasePhase = $Contract.ReleasePhase
    candidateHead = $Contract.CandidateHead; expectedRecoveryHead = $Contract.ExpectedRecoveryHead
    expectedMigrationHead = $Contract.ExpectedRecoveryHead
    candidateMigrationLedger = $Contract.CandidateLedger; expectedRecoveryMigrationLedger = $Contract.ExpectedLedger
    verification = [pscustomobject]@{ migrationCount = $Contract.ExpectedLedger.Count
      migrationHead = $Contract.ExpectedRecoveryHead; migrationVersions = @($Contract.ExpectedLedger.version)
      migrationChecksums = $checksums }
  }
}

$contract = Get-RecoveryMigrationContract -MigrationsDirectory $migrationDirectory
$evidence = New-TestEvidence $contract
if (-not (Test-RecoveryMigrationEvidence $contract $evidence)) { throw 'Test fixture must satisfy the real source/checksum contract' }
if (-not (Test-NeonRecoveryEvidenceSanitized $contract $evidence)) { throw 'Valid exact 0022 recovery migration identifier must not be treated as a password secret' }
Write-Host 'ok - exact validated Current migration ledger including 0022 passes the actual gate predicate'

$pre = Get-RecoveryMigrationContract -MigrationsDirectory $migrationDirectory -ReleasePhase PreMigration -PreMigrationRecoveryHead '0021_worker_invitations'
if (-not (Test-NeonRecoveryEvidenceSanitized $pre (New-TestEvidence $pre))) { throw 'PreMigration proof with candidate 0022 must pass' }
Write-Host 'ok - PreMigration proof permits exact validated candidate identifier without weakening ledger validation'

foreach ($secret in @(
    @{ password = 'synthetic-secret' },
    @{ ConnectionURI = 'synthetic-secret' },
    @{ nested = @{ innocent = 'postgresql://synthetic:secret@example.invalid/db' } },
    @{ nested = @{ innocent = 'postgres://synthetic:secret@example.invalid/db' } },
    @{ note = 'password hidden in free text' },
    @{ note = 'prefix0022_worker_password_recovery' },
    @{ note = '0022_worker_password_recovery_suffix' },
    @{ note = '0022_WORKER_PASSWORD_RECOVERY' },
    @{ note = '0099_unbundled_password' },
    @{ note = 'quoted "0022_worker_password_recovery" inside prose' }
)) {
  $unsafe = New-TestEvidence $contract
  $unsafe | Add-Member -NotePropertyName extra -NotePropertyValue $secret
  if (Test-NeonRecoveryEvidenceSanitized $contract $unsafe) { throw 'Sensitive/arbitrary text must remain rejected' }
}
Write-Host 'ok - secret keys, nested secrets, database URLs, substrings, lookalikes and embedded quoted prose remain rejected'

$tampered = New-TestEvidence $contract
$tampered.candidateHead = '0022_worker_password_recovery_suffix'
if (Test-NeonRecoveryEvidenceSanitized $contract $tampered) { throw 'Invalid migration contract must fail before sanitization' }
Write-Host 'ok - migration contract mismatches fail closed'

$expected = [DateTimeOffset]::Parse('2026-09-29T02:03:04Z', [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
$json = '{"completedAtUtc":"2026-09-29T02:03:04Z"}' | ConvertFrom-Json
foreach ($value in @('2026-09-29T02:03:04Z', '2026-09-29T15:03:04+13:00', $expected,
    $expected.ToLocalTime(), [DateTimeOffset]::Parse('2026-09-29T15:03:04+13:00'), $json.completedAtUtc)) {
  $actual = ConvertTo-RecoveryEvidenceUtc $value
  if ($actual.Kind -ne [DateTimeKind]::Utc -or $actual.Ticks -ne $expected.Ticks) { throw 'String and typed timestamps must preserve the same UTC instant' }
}
Write-Host 'ok - JSON string/typed DateTime/DateTimeOffset and explicit-offset timestamps retain the exact UTC instant'

foreach ($invalid in @($null, '', '2026-09-29T02:03:04', [DateTime]::SpecifyKind($expected, [DateTimeKind]::Unspecified), 'not-a-timestamp')) {
  $rejected = $false
  try { ConvertTo-RecoveryEvidenceUtc $invalid | Out-Null } catch { $rejected = $true }
  if (-not $rejected) { throw 'Missing or timezone-ambiguous timestamps must fail closed' }
}
Write-Host 'ok - missing, malformed and timezone-ambiguous evidence timestamps fail closed'

$gate = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'check-production-hardening.ps1') -Raw
if ($gate -notmatch 'Test-NeonRecoveryEvidenceSanitized \$recoveryMigrationContract \$neonEvidence' -or
    $gate -match '\[DateTime\]::Parse\(\[string\]\$(?:neonEvidence|uploadEvidence|candidateEvidence)') {
  throw 'Actual production gate must use the tested sanitization and typed timestamp helpers'
}
Write-Host 'ok - production gate call sites use the tested helpers; no unsafe evidence timestamp casts remain'
