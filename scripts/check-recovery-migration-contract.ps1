# Shared, offline release-phase contract. Migration checksums are hashes of exact
# bundled bytes, identical to app.migrations; never normalize or repair history.
function Get-RecoveryMigrationContract {
  param(
    [Parameter(Mandatory = $true)][string]$MigrationsDirectory,
    [ValidateSet("Current", "PreMigration")][string]$ReleasePhase = "Current",
    [string]$PreMigrationRecoveryHead = ""
  )
  $files = @(Get-ChildItem -LiteralPath $MigrationsDirectory -File -ErrorAction Stop |
    Where-Object { $_.Extension -ceq ".py" -and $_.Name -cne "__init__.py" } | Sort-Object Name)
  if ($files.Count -eq 0) { throw "Bundled migrations are missing" }
  $ledger = @($files | ForEach-Object {
    if ($_.Name -cnotmatch '^\d{4}_[a-z0-9_]+\.py$') { throw "Unexpected bundled migration filename" }
    $version = [IO.Path]::GetFileNameWithoutExtension($_.Name)
    $declarations = [regex]::Matches(
      (Get-Content -LiteralPath $_.FullName -Raw),
      '(?m)^revision\s*=\s*["'']([^"'']+)["'']\s*(?:#.*)?$'
    )
    if ($declarations.Count -ne 1 -or $declarations[0].Groups[1].Value -cne $version) {
      throw "Bundled migration revision must exactly match its filename"
    }
    [pscustomobject]@{
      version = $version
      checksum = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $expectedLedger = $ledger
  $phase = if ($ReleasePhase -eq "Current") { "Current" } else { "PreMigration" }
  if ($phase -ceq "Current") {
    if ($PreMigrationRecoveryHead) { throw "PreMigrationRecoveryHead is allowed only in explicit PreMigration phase" }
  } else {
    if (-not $PreMigrationRecoveryHead) { throw "PreMigration requires an explicit deployed recovery head" }
    $headIndex = [array]::IndexOf([string[]]@($ledger.version), $PreMigrationRecoveryHead)
    if ($headIndex -lt 0 -or $headIndex -ge ($ledger.Count - 1)) {
      throw "PreMigration recovery head must be an exact known prefix strictly before the candidate head"
    }
    $expectedLedger = @($ledger[0..$headIndex])
  }
  return [pscustomobject]@{
    ReleasePhase = $phase
    CandidateHead = $ledger[-1].version
    ExpectedRecoveryHead = $expectedLedger[-1].version
    CandidateLedger = $ledger
    ExpectedLedger = $expectedLedger
  }
}

function Test-RecoveryMigrationLedger($ExpectedLedger, $ActualLedger) {
  try {
    $expected = @($ExpectedLedger)
    $actual = @($ActualLedger)
    if ($expected.Count -eq 0 -or $actual.Count -ne $expected.Count) { return $false }
    for ($index = 0; $index -lt $expected.Count; $index++) {
      if ($actual[$index].version -isnot [string] -or $actual[$index].version -cne $expected[$index].version -or
          $actual[$index].checksum -isnot [string] -or $actual[$index].checksum -cnotmatch '^[0-9a-f]{64}$' -or
          $actual[$index].checksum -cne $expected[$index].checksum) { return $false }
    }
    return $true
  } catch { return $false }
}

function Test-RecoveryMigrationVerification($Contract, $Verification) {
  try {
    $versions = @($Verification.migrationVersions)
    $checksumProperties = @($Verification.migrationChecksums.PSObject.Properties)
    if ($Verification.migrationCount -isnot [int] -and $Verification.migrationCount -isnot [long] -or
        $Verification.migrationCount -ne $Contract.ExpectedLedger.Count -or
        $Verification.migrationHead -cne $Contract.ExpectedRecoveryHead -or
        $versions.Count -ne $Contract.ExpectedLedger.Count -or $checksumProperties.Count -ne $versions.Count) { return $false }
    $actualLedger = @($versions | ForEach-Object {
      [pscustomobject]@{ version = $_; checksum = $Verification.migrationChecksums.$_ }
    })
    return Test-RecoveryMigrationLedger $Contract.ExpectedLedger $actualLedger
  } catch { return $false }
}

function Test-RecoveryMigrationEvidence($Contract, $Evidence) {
  try {
    return (
      $Evidence.schemaVersion -eq 3 -and
      $Evidence.releasePhase -ceq $Contract.ReleasePhase -and
      $Evidence.candidateHead -ceq $Contract.CandidateHead -and
      $Evidence.expectedRecoveryHead -ceq $Contract.ExpectedRecoveryHead -and
      $Evidence.expectedMigrationHead -ceq $Contract.ExpectedRecoveryHead -and
      (Test-RecoveryMigrationLedger $Contract.CandidateLedger $Evidence.candidateMigrationLedger) -and
      (Test-RecoveryMigrationLedger $Contract.ExpectedLedger $Evidence.expectedRecoveryMigrationLedger) -and
      (Test-RecoveryMigrationVerification $Contract $Evidence.verification)
    )
  } catch { return $false }
}
