param(
  [string]$ProjectId = "geo-attendance-system-db9ca",
  [string]$Region = "australia-southeast1",
  [string]$CloudRunService = "geo-backend",
  [string]$RuntimeServiceAccount = "geo-backend-runtime@geo-attendance-system-db9ca.iam.gserviceaccount.com",
  [ValidateSet("neon", "cloudsql")]
  [string]$DatabaseProvider = "neon",
  [string]$CloudSqlInstance = "geo-attendance-system",
  [string]$UploadBucket = "geo-attendance-system-db9ca-uploads",
  [string]$UploadObjectPrefix = "uploads",
  [string]$UploadCustomRoleId = "geoBackendUploadObjects",
  [string]$DatabaseSecret = "geo-backend-database-url",
  [string]$JwtSecret = "geo-backend-jwt-secret",
  [int]$MinimumUploadSoftDeleteDays = 30,
  [int]$MinimumNeonHistoryHours = 6,
  [int]$MaximumRecoveryEvidenceAgeDays = 30,
  [string]$NeonRecoveryEvidence = "docs/evidence/neon-recovery-proof-*.json",
  [string]$UploadRecoveryEvidence = "docs/evidence/upload-recovery-proof-*.json",
  [string]$HostedReadinessCheck = "Geo Attendance hosted readiness",
  [string]$HostedReadinessHost = "geo-attendance-system-db9ca.web.app",
  [string]$HostedReadinessPolicy = "Geo Attendance: hosted readiness",
  [string]$CloudRun5xxPolicy = "Geo Attendance: Cloud Run 5xx",
  [switch]$AllowIncidentOnlyMonitoring,
  [string]$BillingAccount = ""
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
$repoRoot = Split-Path -Parent $PSScriptRoot

function Pass($message) {
  Write-Host "ok - $message"
}

function Warn($message) {
  $warnings.Add([string]$message) | Out-Null
  Write-Host "warn - $message"
}

function Fail($message) {
  $failures.Add([string]$message) | Out-Null
  Write-Host "not ok - $message"
}

function Invoke-GcloudJson([string[]]$Arguments) {
  $result = Invoke-GcloudResult (@($Arguments) + @("--format=json"))
  if ($result.ExitCode -ne 0) {
    throw "gcloud $($Arguments -join ' ') failed"
  }
  $text = $result.Output
  if (-not $text) {
    return $null
  }

  return ($text | ConvertFrom-Json)
}

function Invoke-GcloudResult([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "gcloud-stderr-$([Guid]::NewGuid().ToString('N')).txt"
  try {
    $output = (& gcloud @Arguments 2>$stderrPath | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    $errorOutput = if (Test-Path -LiteralPath $stderrPath) {
      (Get-Content -LiteralPath $stderrPath -Raw | Out-String).Trim()
    } else { "" }
  } finally {
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = $previousPreference
  }
  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output
    ErrorOutput = $errorOutput
  }
}

function Invoke-NeonJson([string[]]$Arguments) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $output = (& npx -y neon@2.32.0 @Arguments --no-analytics -o json 2>$null | Out-String).Trim()
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($exitCode -ne 0 -or -not $output) {
    throw "pinned Neon CLI read-only query failed"
  }
  return ($output | ConvertFrom-Json)
}

function Invoke-GoogleApiJson([string]$Uri) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $tokenOutput = (& gcloud auth print-access-token 2>$null | Out-String).Trim()
  $tokenExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($tokenExitCode -ne 0 -or -not $tokenOutput) {
    throw "gcloud could not provide an access token for a read-only Monitoring API check"
  }

  try {
    return Invoke-RestMethod -Method Get -Uri $Uri -Headers @{
      Authorization = "Bearer $tokenOutput"
    }
  } finally {
    $tokenOutput = $null
  }
}

function Get-PropertyValue($Value, [string]$PrimaryName, [string]$AlternateName = "") {
  if ($null -eq $Value) {
    return $null
  }
  if ($Value.PSObject.Properties.Name -contains $PrimaryName) {
    return $Value.$PrimaryName
  }
  if ($AlternateName -and $Value.PSObject.Properties.Name -contains $AlternateName) {
    return $Value.$AlternateName
  }
  return $null
}

function Resolve-RepoPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return $Path
  }
  return Join-Path $repoRoot $Path
}

function Read-RecoveryEvidence([string]$Path, [string]$Label) {
  $resolvedPattern = Resolve-RepoPath $Path
  $matches = @(
    Get-ChildItem -Path $resolvedPattern -File -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending
  )
  if ($matches.Count -eq 0) {
    Fail "$Label recovery evidence is missing: $Path"
    return $null
  }
  $candidates = @()
  foreach ($match in $matches) {
    try {
      $candidateEvidence = Get-Content -LiteralPath $match.FullName -Raw | ConvertFrom-Json
      $candidateCompleted = [DateTime]::Parse([string]$candidateEvidence.completedAtUtc).ToUniversalTime()
      $candidates += [pscustomobject]@{
        Evidence = $candidateEvidence
        Completed = $candidateCompleted
      }
    } catch {
      continue
    }
  }
  if ($candidates.Count -eq 0) {
    Fail "$Label recovery evidence has no valid JSON result with a completion time"
    return $null
  }

  try {
    $selected = @($candidates | Sort-Object Completed -Descending)[0]
    $evidence = $selected.Evidence
    $completed = $selected.Completed
    $ageDays = ([DateTime]::UtcNow - $completed).TotalDays
    if ($ageDays -lt (-5 / 1440) -or $ageDays -gt $MaximumRecoveryEvidenceAgeDays) {
      Fail "$Label recovery evidence is not within $MaximumRecoveryEvidenceAgeDays days"
      return $evidence
    }
    Pass "$Label recovery evidence is current ($($completed.ToString('yyyy-MM-ddTHH:mm:ssZ')))"
    return $evidence
  } catch {
    Fail "$Label recovery evidence completion time is invalid"
    return $null
  }
}

function Test-TrueBoolean($Value) {
  return $Value -is [bool] -and $Value -eq $true
}

function Test-Sha256([string]$Value) {
  return [bool]($Value -match '^[0-9a-f]{64}$')
}

function Get-RepoSha256([string]$RelativePath) {
  return (Get-FileHash -LiteralPath (Join-Path $repoRoot $RelativePath) -Algorithm SHA256).Hash.ToLowerInvariant()
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Fail "gcloud CLI is not installed or not on PATH"
  exit 1
}

$readinessCheckId = $null
try {
  $project = Invoke-GcloudJson @("projects", "describe", $ProjectId)
  Pass "gcloud can read project $ProjectId"
} catch {
  Fail $_
  exit 1
}

$defaultComputeServiceAccount = "$($project.projectNumber)-compute@developer.gserviceaccount.com"
$runtimeMember = "serviceAccount:$RuntimeServiceAccount"
$defaultComputeMember = "serviceAccount:$defaultComputeServiceAccount"
$uploadRole = "projects/$ProjectId/roles/$UploadCustomRoleId"
$neonContextProjectId = $null
$expectedMigrationHead = $null
$expectedMigrationCount = 0
if ($DatabaseProvider -eq "neon") {
  try {
    if (-not (Get-Command npx -ErrorAction SilentlyContinue)) {
      throw "npx is unavailable for the pinned Neon read-only verification"
    }
    $neonContext = Get-Content -LiteralPath (Join-Path $repoRoot ".neon") -Raw | ConvertFrom-Json
    $neonContextProjectId = [string]$neonContext.projectId
    $migrationFiles = @(
      Get-ChildItem -LiteralPath (Join-Path $repoRoot "backend/migrations/versions") -File |
        Where-Object { $_.Name -match '^\d{4}_.+\.py$' } |
        Sort-Object Name
    )
    if (-not $neonContextProjectId -or $migrationFiles.Count -eq 0) {
      throw "Neon context or migration head is unavailable"
    }
    $expectedMigrationHead = [System.IO.Path]::GetFileNameWithoutExtension($migrationFiles[-1].Name)
    $expectedMigrationCount = $migrationFiles.Count
    Pass "Neon evidence will be bound to project $neonContextProjectId and migration $expectedMigrationHead"
  } catch {
    Fail $_
  }
}

try {
  $ancestors = @(Invoke-GcloudJson @(
    "projects", "get-ancestors", $ProjectId
  ))
  $parentAncestors = @($ancestors | Where-Object { $_.type -ne "project" })
  if ($parentAncestors.Count -gt 0) {
    Fail "project has folder/organization ancestors whose inherited IAM must be reviewed separately"
  } else {
    Pass "project has no folder/organization ancestor IAM to expand"
  }

  $runtimeAccount = Invoke-GcloudJson @(
    "iam", "service-accounts", "describe", $RuntimeServiceAccount,
    "--project", $ProjectId
  )
  if ($runtimeAccount.disabled -is [bool] -and $runtimeAccount.disabled -eq $true) {
    Fail "dedicated runtime service account is disabled"
  } else {
    Pass "dedicated runtime service account is enabled"
  }

  $runtimeAccountPolicy = Invoke-GcloudJson @(
    "iam", "service-accounts", "get-iam-policy", $RuntimeServiceAccount,
    "--project", $ProjectId
  )
  $runtimeAccountBindings = @($runtimeAccountPolicy.bindings | Where-Object { $_ })
  if ($runtimeAccountBindings.Count -gt 0) {
    Fail "dedicated runtime service account has direct impersonation/access bindings"
  } else {
    Pass "dedicated runtime service account has no direct impersonation bindings"
  }
} catch {
  Fail $_
}

try {
  $runService = Invoke-GcloudJson @(
    "run", "services", "describe", $CloudRunService,
    "--project", $ProjectId,
    "--region", $Region
  )
  Pass "Cloud Run service $CloudRunService is readable"

  $serviceAccount = [string]$runService.spec.template.spec.serviceAccountName
  if ($serviceAccount -ne $RuntimeServiceAccount) {
    Fail "Cloud Run uses $serviceAccount instead of dedicated runtime identity $RuntimeServiceAccount"
  } else {
    Pass "Cloud Run uses dedicated runtime identity $RuntimeServiceAccount"
  }

  $liveTraffic = @($runService.status.traffic | Where-Object { [int]$_.percent -gt 0 })
  if ($liveTraffic.Count -ne 1 -or [int]$liveTraffic[0].percent -ne 100) {
    Fail "Cloud Run production traffic is not pinned 100% to one revision"
  } else {
    $liveRevisionName = [string]$liveTraffic[0].revisionName
    Pass "Cloud Run production traffic is 100% on $liveRevisionName"
    $liveRevision = Invoke-GcloudJson @(
      "run", "revisions", "describe", $liveRevisionName,
      "--project", $ProjectId,
      "--region", $Region
    )
    if ([string]$liveRevision.spec.serviceAccountName -ne $RuntimeServiceAccount) {
      Fail "traffic-serving revision does not use the dedicated runtime identity"
    } else {
      Pass "traffic-serving revision uses the dedicated runtime identity"
    }

    $revisionEnv = @{}
    foreach ($entry in @($liveRevision.spec.containers[0].env | Where-Object { $_ })) {
      $revisionEnv[[string]$entry.name] = $entry
    }
    $databaseSecretRef = [string]$revisionEnv["DATABASE_URL"].valueFrom.secretKeyRef.name
    $jwtSecretRef = [string]$revisionEnv["GEO_SECRET_KEY"].valueFrom.secretKeyRef.name
    if (
      [string]$revisionEnv["UPLOAD_STORAGE_BACKEND"].value -ne "gcs" -or
      [string]$revisionEnv["UPLOAD_BUCKET"].value -ne $UploadBucket -or
      [string]$revisionEnv["UPLOAD_OBJECT_PREFIX"].value -ne $UploadObjectPrefix -or
      $databaseSecretRef -ne $DatabaseSecret -or
      $jwtSecretRef -ne $JwtSecret
    ) {
      Fail "traffic-serving revision storage or Secret references differ from the checked resources"
    } else {
      Pass "traffic-serving revision uses the checked GCS and Secret resources"
    }
  }

  $projectPolicy = Invoke-GcloudJson @(
    "projects", "get-iam-policy", $ProjectId,
    "--flatten=bindings[].members",
    "--filter=bindings.members:$runtimeMember"
  )
  $projectRoles = @($projectPolicy | ForEach-Object { $_.bindings.role } | Where-Object { $_ })
  if ($DatabaseProvider -eq "neon" -and $projectRoles.Count -ne 0) {
    Fail "Neon-backed runtime identity must have zero project roles; found: $($projectRoles -join ', ')"
  } elseif ($DatabaseProvider -eq "neon") {
    Pass "Neon-backed runtime identity has zero project-level IAM bindings"
  } elseif (((@($projectRoles | Sort-Object)) -join ",") -ne "roles/cloudsql.client") {
    Fail "Cloud SQL-backed runtime identity must have only roles/cloudsql.client"
  } else {
    Pass "Cloud SQL-backed runtime identity has only roles/cloudsql.client"
  }
} catch {
  Fail $_
}

try {
  $defaultPolicy = Invoke-GcloudJson @(
    "projects", "get-iam-policy", $ProjectId,
    "--flatten=bindings[].members",
    "--filter=bindings.members:$defaultComputeMember"
  )
  $defaultRoles = @($defaultPolicy | ForEach-Object { $_.bindings.role } | Where-Object { $_ })
  if ($defaultRoles.Count -ne 1 -or $defaultRoles[0] -ne "roles/run.builder") {
    Fail "default Compute service account must have exactly roles/run.builder; found: $($defaultRoles -join ', ')"
  } else {
    Pass "default Compute service account has exactly the source-build role"
  }
} catch {
  Fail $_
}

try {
  $role = Invoke-GcloudJson @(
    "iam", "roles", "describe", $UploadCustomRoleId,
    "--project", $ProjectId
  )
  $actualPermissions = @($role.includedPermissions | Sort-Object)
  $expectedPermissions = @(
    "storage.objects.create",
    "storage.objects.delete",
    "storage.objects.get"
  ) | Sort-Object
  if (
    ($actualPermissions -join ",") -ne ($expectedPermissions -join ",") -or
    $role.stage -ne "GA" -or
    ($role.deleted -is [bool] -and $role.deleted -eq $true)
  ) {
    Fail "upload custom role permissions differ from the three-permission runtime contract"
  } else {
    Pass "upload custom role is active at GA and limited to create/get/delete"
  }
} catch {
  Fail $_
}

foreach ($secret in @($DatabaseSecret, $JwtSecret)) {
  try {
    $secretPolicy = Invoke-GcloudJson @(
      "secrets", "get-iam-policy", $secret,
      "--project", $ProjectId
    )
    $accessor = @($secretPolicy.bindings | Where-Object {
      $_.role -eq "roles/secretmanager.secretAccessor"
    })
    $members = @($accessor | ForEach-Object { $_.members } | Where-Object { $_ })
    $hasConditionalAccessor = @($accessor | Where-Object { $_.condition }).Count -gt 0
    if (
      $accessor.Count -ne 1 -or
      $members.Count -ne 1 -or
      $members[0] -ne $runtimeMember -or
      $hasConditionalAccessor
    ) {
      Fail "$secret must grant secretAccessor to exactly the dedicated runtime identity"
    } else {
      Pass "$secret is available to the dedicated runtime identity only"
    }
  } catch {
    Fail $_
  }
}

if ($DatabaseProvider -eq "cloudsql") {
  try {
    $sql = Invoke-GcloudJson @(
      "sql", "instances", "describe", $CloudSqlInstance,
      "--project", $ProjectId
    )
    Pass "Cloud SQL instance $CloudSqlInstance is readable"

    $publicAddresses = @($sql.ipAddresses | Where-Object { $_.type -eq "PRIMARY" })
    if ($publicAddresses.Count -gt 0) {
      Fail "Cloud SQL still has public IPv4 assigned"
    } else {
      Pass "Cloud SQL has no public IPv4 address"
    }
    if (-not $sql.settings.backupConfiguration.enabled) {
      Fail "Cloud SQL automated backups are disabled"
    } else {
      Pass "Cloud SQL automated backups are enabled"
    }
    if (-not $sql.settings.backupConfiguration.pointInTimeRecoveryEnabled) {
      Fail "Cloud SQL point-in-time recovery is disabled"
    } else {
      Pass "Cloud SQL point-in-time recovery is enabled"
    }
  } catch {
    Fail $_
  }
} else {
  Pass "live database provider is Neon; legacy Cloud SQL checks are not used as production evidence"
}

try {
  $bucketPolicy = Invoke-GcloudJson @(
    "storage", "buckets", "get-iam-policy", "gs://$UploadBucket",
    "--project", $ProjectId
  )
  $publicMembers = @($bucketPolicy.bindings.members | Where-Object {
    $_ -in @("allUsers", "allAuthenticatedUsers")
  })
  if ($publicMembers.Count -gt 0) {
    Fail "upload bucket has public IAM members: $($publicMembers -join ', ')"
  } else {
    Pass "upload bucket IAM is not public"
  }

  $runtimeBindings = @($bucketPolicy.bindings | Where-Object {
    @($_.members) -contains $runtimeMember
  })
  $expectedBinding = @($runtimeBindings | Where-Object {
    $_.role -eq $uploadRole -and
    $_.condition.expression -eq "resource.name.startsWith('projects/_/buckets/$UploadBucket/objects/$UploadObjectPrefix/')"
  })
  if ($expectedBinding.Count -ne 1 -or $runtimeBindings.Count -ne 1) {
    Fail "runtime bucket access is not the single prefix-scoped custom-role binding"
  } else {
    Pass "runtime bucket access is restricted to $UploadObjectPrefix/ with the custom role"
  }

  $defaultBucketBindings = @($bucketPolicy.bindings | Where-Object {
    @($_.members) -contains $defaultComputeMember
  })
  if ($defaultBucketBindings.Count -gt 0) {
    Fail "default Compute identity still has direct upload-bucket access"
  } else {
    Pass "default Compute identity has no upload-bucket binding"
  }
} catch {
  Fail $_
}

try {
  $bucket = Invoke-GcloudJson @(
    "storage", "buckets", "describe", "gs://$UploadBucket",
    "--project", $ProjectId
  )
  $publicAccessPrevention = [string](Get-PropertyValue $bucket "public_access_prevention" "publicAccessPrevention")
  $uniformAccess = Test-TrueBoolean (Get-PropertyValue $bucket "uniform_bucket_level_access" "uniformBucketLevelAccess")
  $softDeletePolicy = Get-PropertyValue $bucket "soft_delete_policy" "softDeletePolicy"
  $softDeleteSeconds = [int64](Get-PropertyValue $softDeletePolicy "retentionDurationSeconds")
  $versioning = Get-PropertyValue $bucket "versioning"
  $versioningEnabled = Test-TrueBoolean (Get-PropertyValue $versioning "enabled")
  $retentionPolicy = Get-PropertyValue $bucket "retention_policy" "retentionPolicy"
  $retentionPeriod = [int64](Get-PropertyValue $retentionPolicy "retention_period" "retentionPeriod")
  $retentionLocked = Test-TrueBoolean (Get-PropertyValue $retentionPolicy "is_locked" "isLocked")
  $defaultEventHold = Test-TrueBoolean (Get-PropertyValue $bucket "default_event_based_hold" "defaultEventBasedHold")
  $objectRetention = Get-PropertyValue $bucket "object_retention" "objectRetention"

  if ($publicAccessPrevention -ne "enforced") {
    Fail "upload bucket public access prevention is not enforced"
  } else {
    Pass "upload bucket public access prevention is enforced"
  }
  if (-not $uniformAccess) {
    Fail "upload bucket uniform bucket-level access is disabled"
  } else {
    Pass "upload bucket uses uniform bucket-level access"
  }
  if ($softDeleteSeconds -lt ($MinimumUploadSoftDeleteDays * 86400)) {
    Fail "upload bucket soft delete is shorter than $MinimumUploadSoftDeleteDays days"
  } else {
    Pass "upload bucket soft delete retains deleted objects for $([math]::Round($softDeleteSeconds / 86400, 2)) days"
  }
  if ($versioningEnabled) {
    Fail "upload bucket Object Versioning is enabled; the recovery policy requires bounded soft delete only"
  } else {
    Pass "upload bucket Object Versioning is disabled as required by the recovery policy"
  }
  if ($retentionPeriod -gt 0 -or $retentionLocked -or $defaultEventHold -or $objectRetention) {
    Fail "upload bucket has an incompatible retention lock, event hold, or object-retention policy"
  } else {
    Pass "upload bucket has no retention lock or hold that would break application cleanup"
  }
} catch {
  Fail $_
}

try {
  $uptimeChecks = @(Invoke-GcloudJson @(
    "monitoring", "uptime", "list-configs",
    "--project", $ProjectId
  ))
  $readinessCheck = @($uptimeChecks | Where-Object { $_.displayName -eq $HostedReadinessCheck })
  if ($readinessCheck.Count -ne 1) {
    Fail "hosted readiness uptime check is missing or duplicated"
  } else {
    $check = $readinessCheck[0]
    $acceptedStatuses = @($check.httpCheck.acceptedResponseStatusCodes | ForEach-Object { [int]$_.statusValue })
    $contentMatchers = @($check.contentMatchers | Where-Object { $_ })
    $selectedRegions = @($check.selectedRegions | Where-Object { $_ })
    if (
      $check.checkerType -ne "STATIC_IP_CHECKERS" -or
      $selectedRegions.Count -ne 0 -or
      $check.httpCheck.path -ne "/api/health/ready" -or
      [int]$check.httpCheck.port -ne 443 -or
      $check.httpCheck.requestMethod -ne "GET" -or
      -not (Test-TrueBoolean $check.httpCheck.useSsl) -or
      -not (Test-TrueBoolean $check.httpCheck.validateSsl) -or
      $acceptedStatuses.Count -ne 1 -or $acceptedStatuses[0] -ne 200 -or
      $check.monitoredResource.type -ne "uptime_url" -or
      $check.monitoredResource.labels.host -ne $HostedReadinessHost -or
      $check.monitoredResource.labels.project_id -ne $ProjectId -or
      $check.period -ne "60s" -or $check.timeout -ne "10s" -or
      $contentMatchers.Count -ne 1 -or
      $contentMatchers[0].matcher -ne "MATCHES_JSON_PATH" -or
      $contentMatchers[0].content -ne '"ok"' -or
      $contentMatchers[0].jsonPathMatcher.jsonPath -ne '$.status' -or
      $contentMatchers[0].jsonPathMatcher.jsonMatcher -ne "EXACT_MATCH"
    ) {
      Fail "hosted readiness uptime check differs from the full HTTPS/body contract"
    } else {
      $readinessCheckId = ([string]$check.name -split "/")[-1]
      Pass "hosted readiness uptime check validates HTTPS 200 and status=ok through JSONPath"
    }
  }
} catch {
  Fail $_
}

if ($readinessCheckId) {
  try {
    $intervalEnd = [DateTime]::UtcNow
    $intervalStart = $intervalEnd.AddMinutes(-15)
    $metricFilter = 'metric.type = "monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id = "{0}"' -f $readinessCheckId
    $seriesUri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/timeSeries?filter=$([Uri]::EscapeDataString($metricFilter))&interval.startTime=$([Uri]::EscapeDataString($intervalStart.ToString('o')))&interval.endTime=$([Uri]::EscapeDataString($intervalEnd.ToString('o')))&view=FULL"
    $seriesResponse = Invoke-GoogleApiJson $seriesUri
    $timeSeries = @($seriesResponse.timeSeries | Where-Object { $_ })
    $latestResults = @()
    foreach ($series in $timeSeries) {
      $points = @($series.points | Where-Object { $_ })
      if ($points.Count -gt 0) {
        $latestResults += $points[0].value.boolValue
      }
    }
    $failedLatestResults = @($latestResults | Where-Object { -not (Test-TrueBoolean $_) })
    if ($latestResults.Count -lt 3 -or $failedLatestResults.Count -gt 0) {
      Fail "hosted readiness has fewer than three recent passing checker-region results"
    } else {
      Pass "hosted readiness has recent passing observations from $($latestResults.Count) checker regions"
    }
  } catch {
    Fail "hosted readiness recent observations could not be verified"
  }
}

try {
  $policies = @(Invoke-GcloudJson @(
    "monitoring", "policies", "list",
    "--project", $ProjectId
  ))
  $requiredPolicies = @($HostedReadinessPolicy, $CloudRun5xxPolicy)
  $resolvedPolicies = @()
  $policyByName = @{}
  foreach ($displayName in $requiredPolicies) {
    $matching = @($policies | Where-Object { $_.displayName -eq $displayName })
    if ($matching.Count -ne 1) {
      Fail "required alert policy is missing or duplicated: $displayName"
    } elseif (-not (Test-TrueBoolean ($matching[0].enabled))) {
      Fail "required alert policy is disabled: $displayName"
    } elseif (Get-PropertyValue $matching[0] "validity") {
      Fail "required alert policy is invalid: $displayName"
    } else {
      $resolvedPolicies += $matching[0]
      $policyByName[$displayName] = $matching[0]
      Pass "required alert policy is enabled: $displayName"
    }
  }

  if ($policyByName.ContainsKey($HostedReadinessPolicy)) {
    $policy = $policyByName[$HostedReadinessPolicy]
    $conditions = @($policy.conditions | Where-Object { $_ })
    $threshold = if ($conditions.Count -eq 1) { $conditions[0].conditionThreshold } else { $null }
    $aggregations = @($threshold.aggregations | Where-Object { $_ })
    $aggregation = if ($aggregations.Count -eq 1) { $aggregations[0] } else { $null }
    $expectedFilter = 'metric.type="monitoring.googleapis.com/uptime_check/check_passed" AND metric.label.check_id="{0}" AND resource.type="uptime_url"' -f $readinessCheckId
    if (
      -not $readinessCheckId -or
      $policy.combiner -ne "OR" -or
      -not $threshold -or -not $aggregation -or
      (Get-PropertyValue $threshold "denominatorFilter") -or
      (Get-PropertyValue $threshold "denominatorAggregations") -or
      (Get-PropertyValue $threshold "evaluationMissingData") -or
      (Get-PropertyValue $threshold "forecastOptions") -or
      [string]$threshold.filter -ne $expectedFilter -or
      $threshold.comparison -ne "COMPARISON_GT" -or
      [double]$threshold.thresholdValue -ne 1 -or
      $threshold.duration -ne "120s" -or
      [int]$threshold.trigger.count -ne 1 -or
      $aggregation.alignmentPeriod -ne "300s" -or
      $aggregation.perSeriesAligner -ne "ALIGN_NEXT_OLDER" -or
      $aggregation.crossSeriesReducer -ne "REDUCE_COUNT_FALSE" -or
      (@($aggregation.groupByFields) -join ",") -ne "resource.label.*"
    ) {
      Fail "hosted readiness policy differs from the expected failure threshold contract"
    } else {
      Pass "hosted readiness policy matches the configured failure threshold contract"
    }
  }

  if ($policyByName.ContainsKey($CloudRun5xxPolicy)) {
    $policy = $policyByName[$CloudRun5xxPolicy]
    $conditions = @($policy.conditions | Where-Object { $_ })
    $threshold = if ($conditions.Count -eq 1) { $conditions[0].conditionThreshold } else { $null }
    $aggregations = @($threshold.aggregations | Where-Object { $_ })
    $aggregation = if ($aggregations.Count -eq 1) { $aggregations[0] } else { $null }
    $expectedFilter = 'resource.type="cloud_run_revision" AND resource.label.service_name="{0}" AND resource.label.location="{1}" AND metric.type="run.googleapis.com/request_count" AND metric.label.response_code_class="5xx"' -f $CloudRunService, $Region
    if (
      $policy.combiner -ne "OR" -or
      -not $threshold -or -not $aggregation -or
      (Get-PropertyValue $threshold "denominatorFilter") -or
      (Get-PropertyValue $threshold "denominatorAggregations") -or
      (Get-PropertyValue $threshold "evaluationMissingData") -or
      (Get-PropertyValue $threshold "forecastOptions") -or
      [string]$threshold.filter -ne $expectedFilter -or
      $threshold.comparison -ne "COMPARISON_GT" -or
      [double]$threshold.thresholdValue -ne 0 -or
      $threshold.duration -ne "0s" -or
      [int]$threshold.trigger.count -ne 1 -or
      $aggregation.alignmentPeriod -ne "300s" -or
      $aggregation.perSeriesAligner -ne "ALIGN_SUM" -or
      $aggregation.crossSeriesReducer -ne "REDUCE_SUM" -or
      (@($aggregation.groupByFields | Sort-Object) -join ",") -ne "resource.label.location,resource.label.service_name"
    ) {
      Fail "Cloud Run 5xx policy differs from the expected threshold contract"
    } else {
      Pass "Cloud Run 5xx policy matches the expected threshold contract"
    }
  }

  $notificationChannelNames = @(
    $resolvedPolicies |
      ForEach-Object { $_.notificationChannels } |
      Where-Object { $_ } |
      Sort-Object -Unique
  )
  $deliveryComplete = $false
  if ($notificationChannelNames.Count -gt 0) {
    $availableChannels = @()
    $nextPageToken = ""
    do {
      $channelsUri = "https://monitoring.googleapis.com/v3/projects/$ProjectId/notificationChannels?pageSize=100"
      if ($nextPageToken) {
        $channelsUri += "&pageToken=$([Uri]::EscapeDataString($nextPageToken))"
      }
      $channelResponse = Invoke-GoogleApiJson $channelsUri
      $availableChannels += @($channelResponse.notificationChannels | Where-Object { $_ })
      $nextPageToken = [string]$channelResponse.nextPageToken
    } while ($nextPageToken)
    $verifiedChannelNames = @(
      $availableChannels |
        Where-Object {
          $_.enabled -is [bool] -and $_.enabled -eq $true -and
          $_.verificationStatus -eq "VERIFIED"
        } |
        ForEach-Object { $_.name }
    )
    $policiesWithoutDelivery = @(
      $resolvedPolicies | Where-Object {
        $references = @($_.notificationChannels | Where-Object { $_ })
        @($references | Where-Object { $verifiedChannelNames -contains $_ }).Count -eq 0
      }
    )
    $deliveryComplete = (
      $resolvedPolicies.Count -eq $requiredPolicies.Count -and
      $policiesWithoutDelivery.Count -eq 0
    )
  }

  if ($deliveryComplete) {
    Pass "each required alert policy uses an enabled, verified notification channel"
  } elseif ($AllowIncidentOnlyMonitoring) {
    Warn "incident-only monitoring was explicitly allowed; alert policies do not all use an enabled, verified notification channel"
  } else {
    Fail "each alert policy must use an enabled, verified notification channel; pass -AllowIncidentOnlyMonitoring only for an explicit controlled-test exception"
  }
} catch {
  Fail $_
}

if ($DatabaseProvider -eq "neon") {
  $neonEvidence = Read-RecoveryEvidence $NeonRecoveryEvidence "Neon"
  if ($neonEvidence) {
    try {
      $startedAt = [DateTime]::Parse([string]$neonEvidence.startedAtUtc).ToUniversalTime()
      $completedAt = [DateTime]::Parse([string]$neonEvidence.completedAtUtc).ToUniversalTime()
      $requestedRestorePoint = [DateTime]::Parse([string]$neonEvidence.requestedRestorePointUtc).ToUniversalTime()
      $actualRestorePoint = [DateTime]::Parse([string]$neonEvidence.proofBranch.parentTimestampUtc).ToUniversalTime()
      $branchCreatedAt = [DateTime]::Parse([string]$neonEvidence.proofBranch.createdAtUtc).ToUniversalTime()
      $requestedExpiry = [DateTime]::Parse([string]$neonEvidence.requestedExpiresAtUtc).ToUniversalTime()
      $actualExpiry = [DateTime]::Parse([string]$neonEvidence.proofBranch.expiresAtUtc).ToUniversalTime()
      $historySeconds = [int64]$neonEvidence.productionBranch.historyRetentionSeconds
      $serializedEvidence = $neonEvidence | ConvertTo-Json -Depth 12 -Compress
      $expectedCliVersion = ([string]$neonEvidence.toolVersions.neonCliPackage -split "@")[-1]
      $artifactHashesValid = (
        (Test-Sha256 ([string]$neonEvidence.artifactHashes.proofScriptSha256)) -and
        (Test-Sha256 ([string]$neonEvidence.artifactHashes.verifierScriptSha256)) -and
        [string]$neonEvidence.artifactHashes.proofScriptSha256 -eq (Get-RepoSha256 "scripts/prove-neon-recovery.ps1") -and
        [string]$neonEvidence.artifactHashes.verifierScriptSha256 -eq (Get-RepoSha256 "scripts/verify-neon-recovery.py")
      )
      $timestampsValid = (
        $completedAt -ge $startedAt -and
        ($completedAt - $startedAt).TotalMinutes -le 15 -and
        $branchCreatedAt -ge $startedAt.AddMinutes(-1) -and
        $branchCreatedAt -le $completedAt.AddMinutes(1) -and
        $requestedRestorePoint -lt $startedAt.AddMinutes(-1) -and
        $actualRestorePoint -lt $startedAt.AddMinutes(-1) -and
        [Math]::Abs(($actualRestorePoint - $requestedRestorePoint).TotalSeconds) -le 120 -and
        ($startedAt - $actualRestorePoint).TotalSeconds -le $historySeconds -and
        $requestedExpiry -gt $startedAt -and
        $actualExpiry -gt $completedAt -and
        [Math]::Abs(($actualExpiry - $requestedExpiry).TotalSeconds) -le 120
      )
      $metadataValid = (
        [int]$neonEvidence.schemaVersion -eq 2 -and
        $neonEvidence.provider -eq "neon" -and
        $neonEvidence.environment -eq "production" -and
        $neonEvidence.status -eq "passed" -and
        -not $neonEvidence.failureStage -and
        $neonEvidence.projectId -eq $neonContextProjectId -and
        $neonEvidence.productionBranch.name -eq "production" -and
        $neonEvidence.productionBranch.id -eq $neonEvidence.proofBranch.parentId -and
        $neonEvidence.proofBranch.id -and
        $neonEvidence.proofBranch.id -ne $neonEvidence.productionBranch.id -and
        [string]$neonEvidence.proofBranch.name -match '^recovery-proof-' -and
        $neonEvidence.proofBranch.endpointType -eq "read_only" -and
        $neonEvidence.expectedMigrationHead -eq $expectedMigrationHead -and
        $neonEvidence.toolVersions.neonCliPackage -eq "neon@2.32.0" -and
        $neonEvidence.toolVersions.neonCli -eq $expectedCliVersion -and
        $serializedEvidence -notmatch 'postgres(?:ql)?://' -and
        $serializedEvidence -notmatch 'connectionUri|password'
      )
      $verificationValid = (
        $neonEvidence.verification.status -eq "passed" -and
        (Test-TrueBoolean $neonEvidence.verification.connected) -and
        (Test-TrueBoolean $neonEvidence.verification.transactionReadOnly) -and
        [int]$neonEvidence.verification.migrationCount -eq $expectedMigrationCount -and
        $neonEvidence.verification.migrationHead -eq $expectedMigrationHead -and
        [int]$neonEvidence.verification.publicTableCount -gt 0 -and
        (Test-Sha256 ([string]$neonEvidence.verification.schemaSha256)) -and
        (Test-Sha256 ([string]$neonEvidence.verification.rowCountSha256)) -and
        (Test-TrueBoolean $neonEvidence.verification.businessDataPresent.department) -and
        (Test-TrueBoolean $neonEvidence.verification.businessDataPresent.site) -and
        (Test-TrueBoolean $neonEvidence.verification.businessDataPresent.user) -and
        (Test-TrueBoolean $neonEvidence.cleanup.ownershipVerified) -and
        (Test-TrueBoolean $neonEvidence.cleanup.deleted) -and
        (Test-TrueBoolean $neonEvidence.cleanup.absenceVerified) -and
        -not $neonEvidence.cleanup.failureStage
      )

      if (-not $metadataValid -or -not $timestampsValid -or -not $artifactHashesValid -or -not $verificationValid) {
        Fail "Neon recovery evidence is not bound to this project, migration head, artifact set, historical point, and exact cleanup contract"
      } else {
        Pass "Neon PITR proof is project-bound, historical, read-only, schema-verified, and cleaned up"
      }

      $neonProjectResult = Invoke-NeonJson @("projects", "get", $neonContextProjectId)
      $neonProject = if ($neonProjectResult.PSObject.Properties.Name -contains "project") {
        $neonProjectResult.project
      } else { $neonProjectResult }
      $currentBranches = @(Invoke-NeonJson @(
        "branch", "list", "--project-id", $neonContextProjectId
      ))
      $currentProduction = @($currentBranches | Where-Object {
        $_.id -eq $neonEvidence.productionBranch.id -and
        $_.name -eq "production" -and
        $_.default -is [bool] -and $_.default -eq $true -and
        $_.primary -is [bool] -and $_.primary -eq $true
      })
      $proofStillPresent = @($currentBranches | Where-Object {
        $_.id -eq $neonEvidence.proofBranch.id -or
        $_.name -eq $neonEvidence.proofBranch.name
      })
      if (
        [string]$neonProject.id -ne $neonContextProjectId -or
        [int64]$neonProject.history_retention_seconds -ne $historySeconds -or
        $currentProduction.Count -ne 1 -or
        $proofStillPresent.Count -ne 0
      ) {
        Fail "current Neon project/production state or proof-branch absence differs from the evidence"
      } else {
        Pass "current Neon project retains the same production branch and the exact proof branch is absent"
      }

      if ($historySeconds -lt ($MinimumNeonHistoryHours * 3600)) {
        Fail "Neon history window is below the $MinimumNeonHistoryHours-hour minimum"
      } else {
        Pass "Neon history window meets the configured $MinimumNeonHistoryHours-hour minimum"
      }
      if ($historySeconds -lt (7 * 86400)) {
        Warn "Neon history retention is only $([math]::Round($historySeconds / 3600, 2)) hours; choose a longer paid window or external logical backups before relying on it for production recovery"
      }
    } catch {
      Fail "Neon recovery evidence failed strict validation"
    }
  }
}

$uploadEvidence = Read-RecoveryEvidence $UploadRecoveryEvidence "Upload"
if ($uploadEvidence) {
  try {
    $startedAt = [DateTime]::Parse([string]$uploadEvidence.startedAtUtc).ToUniversalTime()
    $completedAt = [DateTime]::Parse([string]$uploadEvidence.completedAtUtc).ToUniversalTime()
    $originalGeneration = [string]$uploadEvidence.proofObject.originalGeneration
    $restoredGeneration = [string]$uploadEvidence.proofObject.restoredGeneration
    $ownershipMarker = [string]$uploadEvidence.proofObject.ownershipMarker
    $probeHash = Get-RepoSha256 "ops/recovery/upload-recovery-probe.txt"
    $artifactHashesValid = (
      (Test-Sha256 ([string]$uploadEvidence.artifactHashes.proofScriptSha256)) -and
      (Test-Sha256 ([string]$uploadEvidence.artifactHashes.probeFileSha256)) -and
      [string]$uploadEvidence.artifactHashes.proofScriptSha256 -eq (Get-RepoSha256 "scripts/prove-upload-recovery.ps1") -and
      [string]$uploadEvidence.artifactHashes.probeFileSha256 -eq $probeHash -and
      [string]$uploadEvidence.proofObject.contentSha256 -eq $probeHash
    )
    $metadataValid = (
      [int]$uploadEvidence.schemaVersion -eq 2 -and
      $uploadEvidence.provider -eq "google-cloud-storage" -and
      $uploadEvidence.environment -eq "production" -and
      $uploadEvidence.status -eq "passed" -and
      -not $uploadEvidence.failureStage -and
      $uploadEvidence.projectId -eq $ProjectId -and
      $uploadEvidence.bucket -eq $UploadBucket -and
      [string]$uploadEvidence.proofObject.name -match '^recovery-probes/upload-recovery-proof-' -and
      $ownershipMarker -match '^[0-9a-f]{32}$' -and
      $originalGeneration -match '^\d+$' -and
      $restoredGeneration -match '^\d+$' -and
      $originalGeneration -ne $restoredGeneration -and
      [int64]$uploadEvidence.policy.softDeleteRetentionSeconds -ge ($MinimumUploadSoftDeleteDays * 86400) -and
      $uploadEvidence.policy.publicAccessPrevention -eq "enforced" -and
      (Test-TrueBoolean $uploadEvidence.policy.uniformBucketLevelAccess)
    )
    $verificationValid = (
      (Test-TrueBoolean $uploadEvidence.verification.bucketProjectMatched) -and
      (Test-TrueBoolean $uploadEvidence.verification.exactOriginalGenerationSoftDeleted) -and
      (Test-TrueBoolean $uploadEvidence.verification.restored) -and
      (Test-TrueBoolean $uploadEvidence.verification.restoredContentMatched) -and
      (Test-TrueBoolean $uploadEvidence.verification.finalLiveObjectAbsent) -and
      (Test-TrueBoolean $uploadEvidence.verification.exactRestoredGenerationSoftDeleted) -and
      -not $uploadEvidence.verification.cleanupFailureStage
    )
    $timestampsValid = (
      $completedAt -ge $startedAt -and
      ($completedAt - $startedAt).TotalMinutes -le 15
    )

    if (-not $metadataValid -or -not $verificationValid -or -not $timestampsValid -or -not $artifactHashesValid) {
      Fail "upload recovery evidence is not bound to this bucket, exact generations, current artifacts, and cleanup contract"
    } else {
      Pass "upload recovery proof restored the exact generation, matched content, and soft-deleted the cleanup generation"
    }

    $proofUrl = "gs://$UploadBucket/$($uploadEvidence.proofObject.name)"
    $originalResult = Invoke-GcloudResult @(
      "storage", "objects", "describe", "$proofUrl#$originalGeneration",
      "--soft-deleted",
      "--project", $ProjectId,
      "--format=json"
    )
    $restoredResult = Invoke-GcloudResult @(
      "storage", "objects", "describe", "$proofUrl#$restoredGeneration",
      "--soft-deleted",
      "--project", $ProjectId,
      "--format=json"
    )
    $liveResult = Invoke-GcloudResult @(
      "storage", "objects", "describe", $proofUrl,
      "--project", $ProjectId,
      "--format=json"
    )
    if ($originalResult.ExitCode -ne 0 -or $restoredResult.ExitCode -ne 0) {
      Fail "exact upload proof generations are no longer independently visible as soft-deleted objects"
    } elseif (
      $liveResult.ExitCode -eq 0 -or
      [string]$liveResult.ErrorOutput -notmatch '(?i)(HTTPError\s+404|\bNOT_FOUND\b|not found:\s*404)'
    ) {
      Fail "upload proof object live absence could not be independently verified"
    } else {
      $originalObject = $originalResult.Output | ConvertFrom-Json
      $restoredObject = $restoredResult.Output | ConvertFrom-Json
      $originalMetadata = Get-PropertyValue $originalObject "custom_fields" "customFields"
      if (-not $originalMetadata) {
        $originalMetadata = Get-PropertyValue $originalObject "metadata"
      }
      $restoredMetadata = Get-PropertyValue $restoredObject "custom_fields" "customFields"
      if (-not $restoredMetadata) {
        $restoredMetadata = Get-PropertyValue $restoredObject "metadata"
      }
      $originalMarker = if ($originalMetadata) { [string]$originalMetadata.'recovery-proof-run' } else { "" }
      $restoredMarker = if ($restoredMetadata) { [string]$restoredMetadata.'recovery-proof-run' } else { "" }
      $originalMd5 = [string](Get-PropertyValue $originalObject "md5_hash" "md5Hash")
      $restoredMd5 = [string](Get-PropertyValue $restoredObject "md5_hash" "md5Hash")
      if (
        [string]$originalObject.generation -ne $originalGeneration -or
        [string]$restoredObject.generation -ne $restoredGeneration -or
        $originalMarker -ne $ownershipMarker -or
        $restoredMarker -ne $ownershipMarker -or
        -not $originalMd5 -or
        $originalMd5 -ne $restoredMd5 -or
        [int64](Get-PropertyValue $originalObject "size") -ne [int64](Get-PropertyValue $restoredObject "size")
      ) {
        Fail "soft-deleted proof generation metadata differs from the evidence ownership/content contract"
      } else {
        Pass "GCS independently confirms both exact soft-deleted generations and no live probe"
      }
    }
  } catch {
    Fail "upload recovery evidence failed strict validation"
  }
}

if ($BillingAccount) {
  try {
    $budgets = @(Invoke-GcloudJson @(
      "billing", "budgets", "list",
      "--billing-account", $BillingAccount
    ))
    if ($budgets.Count -gt 0) {
      Pass "billing budgets exist for $BillingAccount"
    } else {
      Fail "no billing budgets found for $BillingAccount"
    }
  } catch {
    Warn "could not verify billing budgets"
  }
} else {
  Warn "billing budget check skipped; pass -BillingAccount to verify budget alerts"
}

if ($warnings.Count -gt 0) {
  Write-Host ""
  Write-Host "$($warnings.Count) warning(s) need review."
}

if ($failures.Count -gt 0) {
  Write-Host ""
  Write-Host "$($failures.Count) production hardening check(s) failed."
  exit 1
}

Write-Host ""
Write-Host "production hardening checks passed"
