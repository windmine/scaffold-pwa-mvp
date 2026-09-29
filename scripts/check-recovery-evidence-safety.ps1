# Offline helpers shared by the production hardening gate and its regressions.
function Test-NeonRecoveryEvidenceSanitized($Contract, $Evidence) {
  if (-not (Test-RecoveryMigrationEvidence $Contract $Evidence)) { return $false }
  $serializedEvidence = $Evidence | ConvertTo-Json -Depth 12 -Compress
  # A known migration identifier is public source metadata, not a credential.
  # Remove only exact JSON string/key tokens after validating the complete
  # source/checksum contract. Substrings, arbitrary words, escaped prose and
  # unbundled migration names still pass through the original secret scan.
  foreach ($entry in $Contract.CandidateLedger) {
    if ($entry.version -isnot [string] -or $entry.version -cnotmatch '^\d{4}_[a-z0-9_]+$') { return $false }
    $serializedEvidence = $serializedEvidence.Replace(('"' + $entry.version + '"'), '"known_migration_identifier"')
  }
  return $serializedEvidence -notmatch 'postgres(?:ql)?://' -and $serializedEvidence -notmatch 'connectionUri|password'
}

function ConvertTo-RecoveryEvidenceUtc($Value) {
  if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
  if ($Value -is [DateTime]) {
    if ($Value.Kind -eq [DateTimeKind]::Unspecified) { throw 'Evidence timestamp timezone is required' }
    return $Value.ToUniversalTime()
  }
  if ($Value -isnot [string] -or $Value -notmatch '(Z|[+-]\d{2}:\d{2})$') { throw 'Evidence timestamp timezone is required' }
  try { return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime }
  catch { throw 'Evidence timestamp is invalid' }
}
