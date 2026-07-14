param(
  [string]$ProjectId = "geo-attendance-system-db9ca",
  [string]$Region = "australia-southeast1",
  [string]$CloudRunService = "geo-backend",
  [string]$CloudSqlInstance = "geo-attendance-system",
  [string]$UploadBucket = "geo-attendance-system-db9ca-uploads",
  [string]$BillingAccount = ""
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Pass($message) {
  Write-Host "ok - $message"
}

function Warn($message) {
  $warnings.Add($message) | Out-Null
  Write-Host "warn - $message"
}

function Fail($message) {
  $failures.Add($message) | Out-Null
  Write-Host "not ok - $message"
}

function Invoke-GcloudJson([string[]]$Arguments) {
  $output = & gcloud @Arguments --format=json 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud $($Arguments -join ' ') failed: $($output | Out-String)"
  }

  $text = ($output | Out-String).Trim()
  if (-not $text) {
    return $null
  }

  return $text | ConvertFrom-Json
}

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  Fail "gcloud CLI is not installed or not on PATH"
  exit 1
}

try {
  $project = Invoke-GcloudJson @("projects", "describe", $ProjectId)
  Pass "gcloud can read project $ProjectId"
} catch {
  Fail $_
  exit 1
}

try {
  $runService = Invoke-GcloudJson @(
    "run", "services", "describe", $CloudRunService,
    "--project", $ProjectId,
    "--region", $Region
  )
  Pass "Cloud Run service $CloudRunService is readable"

  $serviceAccount = $runService.spec.template.spec.serviceAccountName
  $defaultComputeServiceAccount = "$($project.projectNumber)-compute@developer.gserviceaccount.com"

  if (-not $serviceAccount) {
    Fail "Cloud Run service has no explicit service account"
  } elseif ($serviceAccount -eq $defaultComputeServiceAccount) {
    Fail "Cloud Run still uses the default Compute Engine service account"
  } else {
    Pass "Cloud Run uses dedicated service account $serviceAccount"
  }

  $projectPolicy = Invoke-GcloudJson @(
    "projects", "get-iam-policy", $ProjectId,
    "--flatten=bindings[].members",
    "--filter=bindings.members:serviceAccount:$serviceAccount"
  )
  $projectRoles = @($projectPolicy | ForEach-Object { $_.bindings.role } | Where-Object { $_ })

  if ($projectRoles -contains "roles/editor" -or $projectRoles -contains "roles/owner") {
    Fail "Cloud Run service account has broad project role: $($projectRoles -join ', ')"
  } else {
    Pass "Cloud Run service account does not have project Owner/Editor"
  }

  if ($projectRoles -contains "roles/cloudsql.client") {
    Pass "Cloud Run service account has roles/cloudsql.client"
  } else {
    Fail "Cloud Run service account is missing roles/cloudsql.client"
  }
} catch {
  Fail $_
}

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

  if ($sql.settings.availabilityType -eq "REGIONAL") {
    Pass "Cloud SQL uses REGIONAL HA"
  } else {
    Warn "Cloud SQL is $($sql.settings.availabilityType); keep this only if the accepted production tradeoff is lower cost over automatic failover"
  }

  if ($sql.settings.backupConfiguration.enabled) {
    Pass "Cloud SQL automated backups are enabled"
  } else {
    Fail "Cloud SQL automated backups are disabled"
  }

  if ($sql.settings.backupConfiguration.pointInTimeRecoveryEnabled) {
    Pass "Cloud SQL point-in-time recovery is enabled"
  } else {
    Fail "Cloud SQL point-in-time recovery is disabled"
  }

  $users = Invoke-GcloudJson @(
    "sql", "users", "list",
    "--project", $ProjectId,
    "--instance", $CloudSqlInstance
  )
  $migrationRunner = @($users | Where-Object { $_.name -eq "geo_migration_runner" })
  if ($migrationRunner.Count -gt 0) {
    Fail "geo_migration_runner database user still exists; remove, rotate, or formally approve it before launch"
  } else {
    Pass "geo_migration_runner database user is absent"
  }
} catch {
  Fail $_
}

try {
  $bucketPolicy = Invoke-GcloudJson @(
    "storage", "buckets", "get-iam-policy", "gs://$UploadBucket",
    "--project", $ProjectId
  )
  $publicMembers = @($bucketPolicy.bindings.members | Where-Object { $_ -in @("allUsers", "allAuthenticatedUsers") })
  if ($publicMembers.Count -gt 0) {
    Fail "upload bucket has public IAM members: $($publicMembers -join ', ')"
  } else {
    Pass "upload bucket IAM is not public"
  }
} catch {
  Warn "could not verify upload bucket IAM: $_"
}

try {
  $policies = Invoke-GcloudJson @(
    "monitoring", "policies", "list",
    "--project", $ProjectId
  )
  if (@($policies).Count -gt 0) {
    Pass "monitoring alert policies exist"
  } else {
    Fail "no monitoring alert policies found"
  }
} catch {
  Warn "could not verify monitoring alert policies: $_"
}

if ($BillingAccount) {
  try {
    $budgets = Invoke-GcloudJson @(
      "billing", "budgets", "list",
      "--billing-account", $BillingAccount
    )
    if (@($budgets).Count -gt 0) {
      Pass "billing budgets exist for $BillingAccount"
    } else {
      Fail "no billing budgets found for $BillingAccount"
    }
  } catch {
    Warn "could not verify billing budgets: $_"
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
