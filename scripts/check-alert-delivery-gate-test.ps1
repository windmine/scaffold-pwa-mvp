# Exercise the actual production Monitoring section with only provider/filesystem
# boundaries replaced. No gcloud process, HTTP request, or cloud mutation runs.
$ErrorActionPreference = "Stop"
$gateTestRepo = Split-Path -Parent $PSScriptRoot
$gateTestTokens = $null
$gateTestParseErrors = $null
$gateTestAst = [Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PSScriptRoot "check-production-hardening.ps1"), [ref]$gateTestTokens, [ref]$gateTestParseErrors
)
if ($gateTestParseErrors.Count) { throw "Production gate syntax failed" }
$monitoringStatements = @($gateTestAst.EndBlock.Statements | Where-Object {
  $_ -is [Management.Automation.Language.TryStatementAst] -and
  $_.Extent.Text.Contains('"monitoring", "policies", "list"')
})
if ($monitoringStatements.Count -ne 1) { throw "Expected one production Monitoring boundary" }
$monitoringBlock = [scriptblock]::Create('param([string]$PSScriptRoot)' + [Environment]::NewLine + $monitoringStatements[0].Extent.Text)

function Invoke-MonitoringGateFixture([bool]$WithReceipt, [bool]$IncidentOnly) {
  $ProjectId = "alert-test-project"
  $project = [pscustomobject]@{ projectNumber = "1234567890" }
  $Region = "australia-southeast1"
  $CloudRunService = "geo-backend"
  $HostedReadinessPolicy = "Geo Attendance: hosted readiness"
  $CloudRun5xxPolicy = "Geo Attendance: Cloud Run 5xx"
  $readinessCheckId = "geo-attendance-hosted-readiness-PLiPFZtq2oQ"
  $AlertDeliveryEvidence = "fixture-delivery-proof"
  $MaximumAlertDeliveryEvidenceAgeDays = 30
  $AllowIncidentOnlyMonitoring = $IncidentOnly
  $gateTestMessages = [pscustomobject]@{
    Passes = New-Object System.Collections.Generic.List[string]
    Failures = New-Object System.Collections.Generic.List[string]
    Warnings = New-Object System.Collections.Generic.List[string]
  }
  $channelName = "projects/$ProjectId/notificationChannels/1234"
  $gateTestChannel = [pscustomobject]@{
    name = $channelName; type = "email"; enabled = $true
    labels = [pscustomobject]@{ email_address = "operator@example.invalid" }
  }
  $gateTestPolicies = @(
    Microsoft.PowerShell.Management\Get-Content -LiteralPath (Join-Path $gateTestRepo "ops/monitoring/hosted-readiness.json") -Raw | ConvertFrom-Json
    Microsoft.PowerShell.Management\Get-Content -LiteralPath (Join-Path $gateTestRepo "ops/monitoring/cloud-run-5xx.json") -Raw | ConvertFrom-Json
  )
  foreach ($policy in $gateTestPolicies) { $policy | Add-Member -NotePropertyName notificationChannels -NotePropertyValue @($channelName) }
  $now = [DateTimeOffset]::UtcNow
  $gateTestEvidence = [pscustomobject]@{
    schemaVersion = 1; projectId = $ProjectId; projectNumber = "1234567890"
    status = "recipient_confirmed_delivery"; completedAtUtc = $now.AddMinutes(-1).ToString("yyyy-MM-ddTHH:mm:ssZ")
    metricTest = [pscustomobject]@{
      channel = $channelName; policy = "projects/$ProjectId/alertPolicies/9876"
      displayName = "TEST ONLY - Report MVP email metric delivery - 1234abcd"
      runId = "report-email-metric-aaaaaaaaaaaaaaaaaaaaaaaa1234abcd"
      createdAtUtc = $now.AddMinutes(-10).ToString("yyyy-MM-ddTHH:mm:ssZ")
      recipientSha256 = "9ec0cfd2a226e8373b804ce5ebab202421590338d4fe43e7913a580e0c94e822"
      incidentObserved = $true; incidentName = "projects/$ProjectId/alerts/0.example123"
      incidentOpenedAtUtc = $now.AddMinutes(-7).ToString("yyyy-MM-ddTHH:mm:ssZ")
      incidentReadBackAtUtc = $now.AddMinutes(-6).ToString("yyyy-MM-ddTHH:mm:ssZ")
      recipientConfirmedReceipt = $WithReceipt
      receiptEvidenceRecordedAtUtc = $now.AddMinutes(-2).ToString("yyyy-MM-ddTHH:mm:ssZ")
      cleanup = [pscustomobject]@{
        exactPolicyOwnershipVerified = $true; temporaryPolicyDeleted = $true; absenceVerified = $true
        absenceHttpStatus = 404; completedAtUtc = $now.AddMinutes(-3).ToString("yyyy-MM-ddTHH:mm:ssZ")
        productionPoliciesEnabledAndChannelRetained = $true; productionPolicyMutationTimesUnchanged = $true
      }
    }
  }
  function Pass($Message) { $gateTestMessages.Passes.Add([string]$Message) | Out-Null }
  function Fail($Message) { $gateTestMessages.Failures.Add([string]$Message) | Out-Null }
  function Warn($Message) { $gateTestMessages.Warnings.Add([string]$Message) | Out-Null }
  function Test-TrueBoolean($Value) { return $Value -is [bool] -and $Value }
  function Get-PropertyValue($Value, [string]$Name) { return $Value.$Name }
  function Resolve-RepoPath([string]$Path) { return $Path }
  function Invoke-GcloudJson([string[]]$Arguments) {
    if (($Arguments -join ',') -cne "monitoring,policies,list,--project,$ProjectId") { throw "Unexpected provider operation" }
    return $gateTestPolicies
  }
  function Invoke-GoogleApiJson([string]$Uri) {
    if ($Uri -cne "https://monitoring.googleapis.com/v3/projects/$ProjectId/notificationChannels?pageSize=100") { throw "Unexpected HTTP operation" }
    return [pscustomobject]@{ notificationChannels = @($gateTestChannel); nextPageToken = "" }
  }
  function Get-ChildItem([string]$Path, [switch]$File, [string]$ErrorAction) {
    if ($Path -cne $AlertDeliveryEvidence) { throw "Unexpected evidence enumeration" }
    return [pscustomobject]@{ FullName = "fixture-delivery-proof" }
  }
  function Get-Content([string]$LiteralPath, [switch]$Raw, [string]$ErrorAction) {
    if ($LiteralPath -cne "fixture-delivery-proof") { throw "Unexpected evidence read" }
    return $gateTestEvidence | ConvertTo-Json -Depth 15
  }
  & $monitoringBlock (Join-Path $gateTestRepo "scripts")
  return $gateTestMessages
}

$confirmed = Invoke-MonitoringGateFixture $true $false
if ($confirmed.Failures.Count -or $confirmed.Warnings.Count -or
    @($confirmed.Passes | Where-Object { $_ -match "recipient-confirmed delivery evidence" }).Count -ne 1) {
  throw "Strict production Monitoring must accept exact confirmed delivery: $($confirmed.Failures -join '; ')"
}
Write-Host "ok - actual strict Monitoring section accepts confirmed delivery"
$unconfirmed = Invoke-MonitoringGateFixture $false $false
if (-not $unconfirmed.Failures.Count -or $unconfirmed.Warnings.Count) { throw "Strict production Monitoring must reject absent receipt" }
Write-Host "ok - actual strict Monitoring section rejects absent receipt"
$incidentOnly = Invoke-MonitoringGateFixture $false $true
if ($incidentOnly.Failures.Count -or $incidentOnly.Warnings.Count -ne 1 -or
    $incidentOnly.Warnings[0] -notmatch "incident-only monitoring was explicitly allowed") { throw "Explicit incident-only exception must remain a warning, not verified delivery" }
Write-Host "ok - explicit incident-only exception warns without claiming delivery"
Write-Host "Monitoring gate integration offline checks passed"
