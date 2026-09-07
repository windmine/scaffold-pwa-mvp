$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "check-alert-delivery.ps1")

$alertTestProject = "alert-test-project"
$alertTestChannel = "projects/$alertTestProject/notificationChannels/1234"
$alertTestNow = [DateTimeOffset]::Parse("2026-09-07T04:00:00Z")
$alertTestPolicies = @(
  [pscustomobject]@{ notificationChannels = @($alertTestChannel) },
  [pscustomobject]@{ notificationChannels = @($alertTestChannel) }
)
$alertTestChannelSnapshot = [pscustomobject]@{
  name = $alertTestChannel
  type = "email"
  enabled = $true
  labels = [pscustomobject]@{ email_address = "operator@example.invalid" }
}
$alertTestEvidence = @'
{
  "schemaVersion": 1,
  "projectId": "alert-test-project",
  "projectNumber": "1234567890",
  "status": "recipient_confirmed_delivery",
  "completedAtUtc": "2026-09-07T03:32:11Z",
  "readOnlyDiagnostics": { "channelEnabledAndRecipientMatchesUserSelection": true },
  "metricTest": {
    "policy": "projects/alert-test-project/alertPolicies/9876",
    "displayName": "TEST ONLY - Report MVP email metric delivery - 1234abcd",
    "runId": "report-email-metric-aaaaaaaaaaaaaaaaaaaaaaaa1234abcd",
    "createdAtUtc": "2026-09-07T03:25:18.929481979Z",
    "channel": "projects/alert-test-project/notificationChannels/1234",
    "recipientSha256": "9ec0cfd2a226e8373b804ce5ebab202421590338d4fe43e7913a580e0c94e822",
    "incidentObserved": true,
    "incidentName": "projects/alert-test-project/alerts/0.example123",
    "incidentOpenedAtUtc": "2026-09-07T03:28:35Z",
    "incidentReadBackAtUtc": "2026-09-07T03:30:32.3122081Z",
    "recipientConfirmedReceipt": true,
    "receiptEvidenceRecordedAtUtc": "2026-09-07T03:32:11Z",
    "cleanup": {
      "exactPolicyOwnershipVerified": true,
      "temporaryPolicyDeleted": true,
      "absenceVerified": true,
      "absenceHttpStatus": 404,
      "completedAtUtc": "2026-09-07T03:31:37.4587885Z",
      "productionPoliciesEnabledAndChannelRetained": true,
      "productionPolicyMutationTimesUnchanged": true
    }
  }
}
'@

function Invoke-AlertDeliveryFixture {
  param([string[]]$EvidenceJson = @($alertTestEvidence), $Channel = $alertTestChannelSnapshot)
  Test-AlertDelivery -ProjectId $alertTestProject -ProjectNumber "1234567890" `
    -Policies $alertTestPolicies -Channels @($Channel) -EvidenceJson $EvidenceJson `
    -NowUtc $alertTestNow
}

$result = Invoke-AlertDeliveryFixture
if (-not $result.Passed) { throw "recipient-confirmed email delivery with omitted verification status must pass: $($result.Reasons -join '; ')" }
Write-Host "ok - recipient-confirmed email delivery with omitted verification status passes"

$unverifiedChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$unverifiedChannel | Add-Member -NotePropertyName verificationStatus -NotePropertyValue "UNVERIFIED"
if ((Invoke-AlertDeliveryFixture -Channel $unverifiedChannel).Passed) { throw "UNVERIFIED must fail even with recipient confirmation" }
Write-Host "ok - UNVERIFIED fails even with recipient confirmation"

$noReceiptEvidence = $alertTestEvidence | ConvertFrom-Json
$noReceiptEvidence.metricTest.recipientConfirmedReceipt = $false
if ((Invoke-AlertDeliveryFixture -EvidenceJson @($noReceiptEvidence | ConvertTo-Json -Depth 15)).Passed) {
  throw "an incident and empty notification error logs are not recipient receipt"
}
Write-Host "ok - incident without actual recipient receipt fails"

function Assert-RejectedEvidence {
  param([string]$Name, [scriptblock]$Change)
  $candidate = $alertTestEvidence | ConvertFrom-Json
  & $Change $candidate
  $check = Invoke-AlertDeliveryFixture -EvidenceJson @($candidate | ConvertTo-Json -Depth 20)
  if ($check.Passed) { throw "$Name must fail" }
  Write-Host "ok - $Name fails"
}

Assert-RejectedEvidence "wrong project" { param($item) $item.projectId = "another-project" }
Assert-RejectedEvidence "stale delivery evidence" { param($item) $item.completedAtUtc = "2026-08-01T03:32:11Z" }
Assert-RejectedEvidence "unverified exact cleanup" { param($item) $item.metricTest.cleanup.exactPolicyOwnershipVerified = $false }

$redirectedChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$redirectedChannel.labels.email_address = "different@example.invalid"
if ((Invoke-AlertDeliveryFixture -Channel $redirectedChannel).Passed) { throw "changed recipient on same channel must fail" }
Write-Host "ok - changed recipient on same channel fails"
Assert-RejectedEvidence "plaintext recipient in proof" { param($item) $item | Add-Member -NotePropertyName recipientEmail -NotePropertyValue "operator@example.invalid" }

foreach ($status in @("VERIFIED", "VERIFICATION_STATUS_UNSPECIFIED")) {
  $candidateChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $candidateChannel | Add-Member -NotePropertyName verificationStatus -NotePropertyValue $status
  if (-not (Invoke-AlertDeliveryFixture -Channel $candidateChannel).Passed) { throw "$status with confirmed delivery must pass" }
  if ((Invoke-AlertDeliveryFixture -Channel $candidateChannel -EvidenceJson @()).Passed) { throw "$status without delivery proof must fail" }
  Write-Host "ok - $status requires actual delivery proof"
}
foreach ($status in @("UNSPECIFIED", "UNKNOWN", "verified", "unverified")) {
  $candidateChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $candidateChannel | Add-Member -NotePropertyName verificationStatus -NotePropertyValue $status
  if ((Invoke-AlertDeliveryFixture -Channel $candidateChannel).Passed) { throw "unsupported verification state must fail" }
  Write-Host "ok - unsupported verification state $status fails"
}
foreach ($enabled in @($false, "true", 1, $null)) {
  $candidateChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
  $candidateChannel.enabled = $enabled
  if ((Invoke-AlertDeliveryFixture -Channel $candidateChannel).Passed) { throw "non-true Boolean enabled must fail" }
}
Write-Host "ok - disabled or malformed enabled flags fail"
foreach ($badJson in @("", "{", "null", "[]", "{}", "true")) {
  if ((Invoke-AlertDeliveryFixture -EvidenceJson @($badJson)).Passed) { throw "missing or malformed evidence must fail" }
}
Write-Host "ok - missing and malformed evidence fail"

Assert-RejectedEvidence "wrong project number" { param($item) $item.projectNumber = "9999999999" }
Assert-RejectedEvidence "wrong channel" { param($item) $item.metricTest.channel = "projects/alert-test-project/notificationChannels/9999" }
Assert-RejectedEvidence "wrong incident project" { param($item) $item.metricTest.incidentName = "projects/another-project/alerts/0.example123" }
Assert-RejectedEvidence "missing incident" { param($item) $item.metricTest.PSObject.Properties.Remove("incidentName") }
Assert-RejectedEvidence "missing test policy" { param($item) $item.metricTest.PSObject.Properties.Remove("policy") }
Assert-RejectedEvidence "wrong test policy project" { param($item) $item.metricTest.policy = "projects/another-project/alertPolicies/9876" }
Assert-RejectedEvidence "missing test ownership identity" { param($item) $item.metricTest.runId = "unrelated" }
Assert-RejectedEvidence "string receipt flag" { param($item) $item.metricTest.recipientConfirmedReceipt = "true" }
Assert-RejectedEvidence "unconfirmed status" { param($item) $item.status = "incident_observed" }
Assert-RejectedEvidence "incident not observed" { param($item) $item.metricTest.incidentObserved = $false }
Assert-RejectedEvidence "future evidence" { param($item) $item.completedAtUtc = "2026-09-07T04:00:01Z" }
Assert-RejectedEvidence "future receipt hidden by old completion" { param($item) $item.metricTest.receiptEvidenceRecordedAtUtc = "2026-09-07T05:00:00Z" }
Assert-RejectedEvidence "stale receipt with refreshed completion" { param($item) $item.metricTest.receiptEvidenceRecordedAtUtc = "2026-08-01T03:32:11Z" }
Assert-RejectedEvidence "unparseable timestamp" { param($item) $item.metricTest.createdAtUtc = "not-a-date" }
Assert-RejectedEvidence "timezone-ambiguous timestamp" { param($item) $item.metricTest.createdAtUtc = "2026-09-07T03:25:18" }
Assert-RejectedEvidence "incident before policy creation" { param($item) $item.metricTest.incidentOpenedAtUtc = "2026-09-07T03:00:00Z" }
Assert-RejectedEvidence "missing cleanup" { param($item) $item.metricTest.PSObject.Properties.Remove("cleanup") }
Assert-RejectedEvidence "cleanup without deletion" { param($item) $item.metricTest.cleanup.temporaryPolicyDeleted = $false }
Assert-RejectedEvidence "cleanup without observed absence" { param($item) $item.metricTest.cleanup.absenceVerified = $false }
Assert-RejectedEvidence "cleanup with denied access instead of 404" { param($item) $item.metricTest.cleanup.absenceHttpStatus = 403 }
Assert-RejectedEvidence "string cleanup flag" { param($item) $item.metricTest.cleanup.exactPolicyOwnershipVerified = "true" }
Assert-RejectedEvidence "production policy mutation during test" { param($item) $item.metricTest.cleanup.productionPolicyMutationTimesUnchanged = $false }
Assert-RejectedEvidence "missing recipient fingerprint" { param($item) $item.metricTest.PSObject.Properties.Remove("recipientSha256") }
Assert-RejectedEvidence "incorrect recipient fingerprint" { param($item) $item.metricTest.recipientSha256 = ('a' * 64) }

$numericChannel = $alertTestChannelSnapshot | ConvertTo-Json -Depth 10 | ConvertFrom-Json
$numericChannel.name = "projects/1234567890/notificationChannels/1234"
if (-not (Invoke-AlertDeliveryFixture -Channel $numericChannel).Passed) { throw "same project's numeric resource alias must pass" }
Write-Host "ok - project ID and numeric resource names resolve to the same channel"
$uncoveredPolicy = [pscustomobject]@{ notificationChannels = @("projects/$alertTestProject/notificationChannels/9999") }
$uncovered = Test-AlertDelivery -ProjectId $alertTestProject -ProjectNumber "1234567890" `
  -Policies @($alertTestPolicies[0], $uncoveredPolicy) -Channels @($alertTestChannelSnapshot) `
  -EvidenceJson @($alertTestEvidence) -NowUtc $alertTestNow
if ($uncovered.Passed) { throw "every policy must have proven delivery coverage" }
Write-Host "ok - one covered policy cannot hide another policy without delivery"

Write-Host "alert delivery offline checks passed"
