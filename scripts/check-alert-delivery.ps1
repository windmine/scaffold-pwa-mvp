# Offline boundary for the production Monitoring gate. Never contacts a provider or
# treats an incident/configuration/error-log absence as proof of recipient delivery.
# Provider verification semantics:
# https://docs.cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.notificationChannels#VerificationStatus
function Get-AlertDeliveryResourceName($Value, [string]$Collection, [string]$ProjectId, [string]$ProjectNumber) {
  $pattern = '^projects/([^/]+)/' + [regex]::Escape($Collection) + '/([a-zA-Z0-9._-]+)$'
  $resourceMatch = [regex]::Match([string]$Value, $pattern)
  if (-not $resourceMatch.Success -or $resourceMatch.Groups[1].Value -cnotin @($ProjectId, $ProjectNumber)) {
    throw "resource does not belong to expected project"
  }
  return "projects/$ProjectId/$Collection/$($resourceMatch.Groups[2].Value)"
}

function Get-AlertDeliveryUtcTime($Value) {
  # PowerShell 7 versions before -DateKind String deserialize ISO dates as UTC
  # DateTime values; Windows PowerShell preserves the original JSON strings.
  if ($Value -is [DateTime] -and $Value.Kind -eq [DateTimeKind]::Utc) { return [DateTimeOffset]$Value }
  if ($Value -isnot [string] -or $Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$') {
    throw "evidence timestamp must be explicit UTC"
  }
  return [DateTimeOffset]::Parse($Value, [Globalization.CultureInfo]::InvariantCulture)
}

function Test-AlertDelivery {
  param(
    [Parameter(Mandatory = $true)][string]$ProjectId,
    [Parameter(Mandatory = $true)][string]$ProjectNumber,
    [object[]]$Policies = @(),
    [object[]]$Channels = @(),
    [string[]]$EvidenceJson = @(),
    [ValidateRange(1, 365)][int]$MaximumEvidenceAgeDays = 30,
    [DateTimeOffset]$NowUtc = [DateTimeOffset]::UtcNow
  )

  $reasons = New-Object System.Collections.Generic.List[string]
  $validChannelNames = New-Object System.Collections.Generic.List[string]
  $evidenceItems = @()
  foreach ($json in $EvidenceJson) {
    try {
      if ([string]::IsNullOrWhiteSpace($json)) { throw "missing" }
      if ($json -match '(?i)([^\s"@]+@[^\s"@]+\.[^\s"@]+|postgres(?:ql)?://|bearer\s+|"(?:password|accessToken|refreshToken|verificationCode)"\s*:)') {
        throw "evidence must be sanitized"
      }
      $jsonArguments = @{ InputObject = $json; ErrorAction = "Stop" }
      if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey("DateKind")) { $jsonArguments.DateKind = "String" }
      $item = ConvertFrom-Json @jsonArguments
      if ($null -eq $item -or $item -is [array] -or $item -isnot [pscustomobject]) { throw "malformed" }
      if (($item | ConvertTo-Json -Depth 30 -Compress) -match '(?i)([^\s"@]+@[^\s"@]+\.[^\s"@]+|postgres(?:ql)?://|bearer\s+|"(?:password|accessToken|refreshToken|verificationCode)"\s*:)') {
        throw "evidence must be sanitized"
      }
      if ($item.schemaVersion -isnot [int] -and $item.schemaVersion -isnot [long] -or $item.schemaVersion -ne 1 -or
          $item.projectId -cne $ProjectId -or [string]$item.projectNumber -cne $ProjectNumber) {
        throw "wrong evidence schema or project"
      }
      $test = $item.metricTest
      $test.channel = Get-AlertDeliveryResourceName $test.channel "notificationChannels" $ProjectId $ProjectNumber
      $test.policy = Get-AlertDeliveryResourceName $test.policy "alertPolicies" $ProjectId $ProjectNumber
      $test.incidentName = Get-AlertDeliveryResourceName $test.incidentName "alerts" $ProjectId $ProjectNumber
      if ([string]$test.runId -cnotmatch '^report-email-metric-[0-9a-f]{32}$' -or
          [string]$test.displayName -cne "TEST ONLY - Report MVP email metric delivery - $(([string]$test.runId).Substring(([string]$test.runId).Length - 8))") {
        throw "test ownership identity missing"
      }
      if ($item.status -cne "recipient_confirmed_delivery" -or
          $item.metricTest.recipientConfirmedReceipt -isnot [bool] -or
          -not $item.metricTest.recipientConfirmedReceipt -or
          $item.metricTest.incidentObserved -isnot [bool] -or -not $item.metricTest.incidentObserved) {
        throw "recipient receipt missing"
      }
      $created = Get-AlertDeliveryUtcTime $test.createdAtUtc
      $opened = Get-AlertDeliveryUtcTime $test.incidentOpenedAtUtc
      $readBack = Get-AlertDeliveryUtcTime $test.incidentReadBackAtUtc
      $receiptRecorded = Get-AlertDeliveryUtcTime $test.receiptEvidenceRecordedAtUtc
      $cleanupCompleted = Get-AlertDeliveryUtcTime $test.cleanup.completedAtUtc
      $completed = Get-AlertDeliveryUtcTime $item.completedAtUtc
      $timestamps = @($created, $opened, $readBack, $receiptRecorded, $cleanupCompleted, $completed)
      if (@($timestamps | Where-Object { $_ -gt $NowUtc -or ($NowUtc - $_).TotalDays -gt $MaximumEvidenceAgeDays }).Count -gt 0 -or
          $created -gt $opened -or $opened -gt $readBack -or $readBack -gt $receiptRecorded -or
          $readBack -gt $cleanupCompleted -or $cleanupCompleted -gt $completed -or $receiptRecorded -gt $completed) {
        throw "evidence is stale, future-dated, or out of order"
      }
      foreach ($property in @("exactPolicyOwnershipVerified", "temporaryPolicyDeleted", "absenceVerified", "productionPoliciesEnabledAndChannelRetained", "productionPolicyMutationTimesUnchanged")) {
        if ($test.cleanup.$property -isnot [bool] -or -not $test.cleanup.$property) { throw "cleanup not verified" }
      }
      if ($test.cleanup.absenceHttpStatus -isnot [int] -and $test.cleanup.absenceHttpStatus -isnot [long] -or $test.cleanup.absenceHttpStatus -ne 404) {
        throw "exact temporary policy absence not verified"
      }
      $evidenceItems += $item
    } catch {
      $reasons.Add("alert delivery evidence is missing or malformed") | Out-Null
    }
  }
  if ($evidenceItems.Count -eq 0) {
    $reasons.Add("no readable recipient-confirmed alert delivery evidence") | Out-Null
  }

  foreach ($channel in $Channels) {
    try {
      $channelName = Get-AlertDeliveryResourceName $channel.name "notificationChannels" $ProjectId $ProjectNumber
    } catch {
      $reasons.Add("notification channel does not belong to the expected project") | Out-Null
      continue
    }
    $verificationStatus = [string]$channel.verificationStatus
    $verificationEligible = (
      $verificationStatus -ceq "VERIFIED" -or
      ($channel.type -ceq "email" -and $verificationStatus -cin @("", "VERIFICATION_STATUS_UNSPECIFIED"))
    )
    if ($channel.enabled -isnot [bool] -or -not $channel.enabled -or -not $verificationEligible) {
      $reasons.Add("notification channel is disabled, unverified, or has unsupported verification status") | Out-Null
      continue
    }
    # This evidence schema proves email delivery. A future channel type needs its
    # own destination binding; a VERIFIED label alone never bypasses receipt.
    $recipient = ([string]$channel.labels.email_address).Trim().ToLowerInvariant()
    if ($channel.type -cne "email" -or -not $recipient -or $recipient -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$') {
      $reasons.Add("current channel destination cannot be bound to email delivery evidence") | Out-Null
      continue
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
      $recipientSha256 = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($recipient)))).Replace("-", "").ToLowerInvariant()
    } finally {
      $sha.Dispose()
      $recipient = $null
    }
    foreach ($item in $evidenceItems) {
      if ([string]$item.metricTest.channel -ceq $channelName -and
          [string]$item.metricTest.recipientSha256 -cmatch '^[0-9a-f]{64}$' -and
          [string]$item.metricTest.recipientSha256 -ceq $recipientSha256) {
        $validChannelNames.Add($channelName) | Out-Null
        break
      }
    }
  }
  $uncoveredPolicies = @($Policies | Where-Object {
    $references = @($_.notificationChannels | Where-Object { $_ } | ForEach-Object {
      try { Get-AlertDeliveryResourceName $_ "notificationChannels" $ProjectId $ProjectNumber } catch { "" }
    })
    @($references | Where-Object { $validChannelNames -ccontains $_ }).Count -eq 0
  })
  if ($Policies.Count -eq 0 -or $uncoveredPolicies.Count -gt 0) {
    $reasons.Add("each required policy needs a channel with valid recipient-confirmed delivery evidence") | Out-Null
  }
  return [pscustomobject]@{
    Passed = ($Policies.Count -gt 0 -and $uncoveredPolicies.Count -eq 0)
    ChannelNames = @($validChannelNames | Sort-Object -Unique)
    Reasons = @($reasons | Sort-Object -Unique)
  }
}
