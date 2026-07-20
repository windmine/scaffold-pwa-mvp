param(
  [string]$ProjectId = "geo-attendance-system-db9ca",
  [string]$UploadBucket = "geo-attendance-system-db9ca-uploads",
  [string]$ProbeFile = "ops/recovery/upload-recovery-probe.txt",
  [int]$MinimumSoftDeleteDays = 30,
  [string]$EvidencePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not [System.IO.Path]::IsPathRooted($ProbeFile)) {
  $ProbeFile = Join-Path $repoRoot $ProbeFile
}
if ($EvidencePath -and -not [System.IO.Path]::IsPathRooted($EvidencePath)) {
  $EvidencePath = Join-Path $repoRoot $EvidencePath
}

function Invoke-GcloudText([string[]]$Arguments, [bool]$AllowFailure = $false) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $stderrPath = Join-Path ([System.IO.Path]::GetTempPath()) "gcloud-stderr-$([Guid]::NewGuid().ToString('N')).txt"
  try {
    $output = (& gcloud @Arguments 2>$stderrPath | Out-String)
    $exitCode = $LASTEXITCODE
    $errorOutput = if (Test-Path -LiteralPath $stderrPath) {
      (Get-Content -LiteralPath $stderrPath -Raw | Out-String).Trim()
    } else { "" }
  } finally {
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    $ErrorActionPreference = $previousPreference
  }

  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "gcloud operation failed"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $output.Trim()
    ErrorOutput = $errorOutput
  }
}

function Invoke-GcloudJson([string[]]$Arguments) {
  $result = Invoke-GcloudText $Arguments
  if (-not $result.Output) {
    throw "gcloud returned no JSON"
  }
  try {
    return ($result.Output | ConvertFrom-Json)
  } catch {
    throw "gcloud returned invalid JSON"
  }
}

function Read-Property($Value, [string]$SnakeCase, [string]$CamelCase) {
  if ($null -eq $Value) {
    return $null
  }
  if ($Value.PSObject.Properties.Name -contains $SnakeCase) {
    return $Value.$SnakeCase
  }
  if ($Value.PSObject.Properties.Name -contains $CamelCase) {
    return $Value.$CamelCase
  }
  return $null
}

function Test-ExplicitNotFound($Result) {
  return (
    $Result.ExitCode -ne 0 -and
    [string]$Result.ErrorOutput -match '(?i)(HTTPError\s+404|\bNOT_FOUND\b|not found:\s*404)'
  )
}

function Wait-ForLiveObjectAbsent([string]$Url, [string]$Project) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $result = Invoke-GcloudText @(
      "storage", "objects", "describe", $Url,
      "--project", $Project,
      "--format=json"
    ) $true
    if ($result.ExitCode -eq 0) {
      Start-Sleep -Seconds 2
      continue
    }
    if (Test-ExplicitNotFound $result) {
      return $true
    }
    throw "live object absence check failed for a reason other than not-found"
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "live object was still present after the delete deadline"
}

function Get-LocalMd5Base64([string]$Path) {
  $hex = (Get-FileHash -LiteralPath $Path -Algorithm MD5).Hash
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($index = 0; $index -lt $hex.Length; $index += 2) {
    $bytes[$index / 2] = [Convert]::ToByte($hex.Substring($index, 2), 16)
  }
  return [Convert]::ToBase64String($bytes)
}

function Test-OwnedObject(
  $Object,
  [string]$ExpectedName,
  [string]$ExpectedMarker,
  [string]$ExpectedMd5,
  [int64]$ExpectedSize
) {
  if (-not $Object) {
    return $false
  }
  $metadata = Read-Property $Object "custom_fields" "customFields"
  if (-not $metadata) {
    $metadata = Read-Property $Object "metadata" "metadata"
  }
  $marker = if ($metadata -and $metadata.PSObject.Properties.Name -contains "recovery-proof-run") {
    [string]$metadata.'recovery-proof-run'
  } else { "" }
  return (
    [string]$Object.name -eq $ExpectedName -and
    [string]$Object.generation -match '^\d+$' -and
    $marker -eq $ExpectedMarker -and
    [string](Read-Property $Object "md5_hash" "md5Hash") -eq $ExpectedMd5 -and
    [int64](Read-Property $Object "size" "size") -eq $ExpectedSize
  )
}

function Wait-ForSoftDeletedObject([string]$UrlWithGeneration, [string]$Project) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $result = Invoke-GcloudText @(
      "storage", "objects", "describe", $UrlWithGeneration,
      "--soft-deleted",
      "--project", $Project,
      "--format=json"
    ) $true
    if ($result.ExitCode -eq 0 -and $result.Output) {
      try {
        return $result.Output | ConvertFrom-Json
      } catch {
        throw "gcloud returned invalid soft-delete JSON"
      }
    }
    if (-not (Test-ExplicitNotFound $result)) {
      throw "soft-delete discovery failed for a reason other than not-found"
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "soft-deleted object was not discoverable"
}

function Write-EvidenceFile([string]$Path, [string]$Json) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $temporary = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($temporary, "$Json`n", $utf8NoBom)
  Move-Item -LiteralPath $temporary -Destination $Path -Force
}

$startedAt = [DateTime]::UtcNow
$runMarker = [Guid]::NewGuid().ToString("N")
$uniqueSuffix = $runMarker.Substring(0, 10)
$probeName = "recovery-probes/upload-recovery-proof-$($startedAt.ToString('yyyyMMddTHHmmssZ').ToLowerInvariant())-$uniqueSuffix.txt"
$probeUrl = "gs://$UploadBucket/$probeName"
$stage = "preflight"
$failureStage = $null
$cleanupFailureStage = $null
$project = $null
$bucket = $null
$initialObject = $null
$restoredObject = $null
$initialSoftDeletedObject = $null
$finalSoftDeletedObject = $null
$softDeleteObserved = $false
$restored = $false
$restoredContentMatched = $false
$finalDeleteObserved = $false
$finalLiveObjectAbsent = $false
$liveObjectExists = $false
$uploadAttempted = $false
$ownedLiveGeneration = $null
$downloadPath = Join-Path ([System.IO.Path]::GetTempPath()) "upload-recovery-$runMarker.tmp"
$probeSha256 = $null
$probeMd5 = $null
$probeSize = 0
$bucketProjectMatched = $false

try {
  if (-not (Test-Path -LiteralPath $ProbeFile)) {
    throw "Upload recovery probe file is missing"
  }

  $probeSha256 = (Get-FileHash -LiteralPath $ProbeFile -Algorithm SHA256).Hash.ToLowerInvariant()
  $probeMd5 = Get-LocalMd5Base64 $ProbeFile
  $probeSize = [int64](Get-Item -LiteralPath $ProbeFile).Length
  $project = Invoke-GcloudJson @(
    "projects", "describe", $ProjectId,
    "--format=json"
  )

  $bucket = Invoke-GcloudJson @(
    "storage", "buckets", "describe", "gs://$UploadBucket",
    "--project", $ProjectId,
    "--format=json"
  )
  $rawBucket = Invoke-GcloudJson @(
    "storage", "buckets", "describe", "gs://$UploadBucket",
    "--raw",
    "--project", $ProjectId,
    "--format=json"
  )
  $softDeletePolicy = Read-Property $bucket "soft_delete_policy" "softDeletePolicy"
  $retentionSeconds = [int64](Read-Property $softDeletePolicy "retentionDurationSeconds" "retentionDurationSeconds")
  if ($retentionSeconds -lt ($MinimumSoftDeleteDays * 86400)) {
    throw "Upload bucket soft delete retention is below policy"
  }
  $bucketProjectNumber = [string](Read-Property $rawBucket "project_number" "projectNumber")
  $bucketProjectMatched = $bucketProjectNumber -eq [string]$project.projectNumber
  if (-not $bucketProjectMatched) {
    throw "Upload bucket does not belong to the selected project"
  }

  $stage = "upload_probe"
  $uploadAttempted = $true
  $null = Invoke-GcloudText @(
    "storage", "cp", $ProbeFile, $probeUrl,
    "--if-generation-match=0",
    "--custom-metadata=recovery-proof-run=$runMarker",
    "--project", $ProjectId,
    "--quiet"
  )
  $liveObjectExists = $true
  $initialObject = Invoke-GcloudJson @(
    "storage", "objects", "describe", $probeUrl,
    "--project", $ProjectId,
    "--format=json"
  )
  $initialGeneration = [string]$initialObject.generation
  if (-not (Test-OwnedObject $initialObject $probeName $runMarker $probeMd5 $probeSize)) {
    throw "Initial probe ownership metadata did not match this run"
  }
  $ownedLiveGeneration = $initialGeneration

  $stage = "soft_delete_probe"
  $null = Invoke-GcloudText @(
    "storage", "rm", $probeUrl,
    "--if-generation-match=$initialGeneration",
    "--project", $ProjectId,
    "--quiet"
  )
  $finalLiveObjectAbsent = Wait-ForLiveObjectAbsent $probeUrl $ProjectId
  $liveObjectExists = $false
  $ownedLiveGeneration = $null

  $initialSoftDeletedObject = Wait-ForSoftDeletedObject "$probeUrl#$initialGeneration" $ProjectId
  $softDeleteObserved = (
    [string]$initialSoftDeletedObject.generation -eq $initialGeneration -and
    (Test-OwnedObject $initialSoftDeletedObject $probeName $runMarker $probeMd5 $probeSize)
  )
  if (-not $softDeleteObserved) {
    throw "Exact soft-deleted probe generation was not verified"
  }

  $stage = "restore_probe"
  $null = Invoke-GcloudText @(
    "storage", "restore", "$probeUrl#$initialGeneration",
    "--if-generation-match=0",
    "--project", $ProjectId,
    "--quiet"
  )
  $liveObjectExists = $true
  $restoredObject = Invoke-GcloudJson @(
    "storage", "objects", "describe", $probeUrl,
    "--project", $ProjectId,
    "--format=json"
  )

  $initialMd5 = [string](Read-Property $initialObject "md5_hash" "md5Hash")
  $restoredMd5 = [string](Read-Property $restoredObject "md5_hash" "md5Hash")
  $initialSize = [int64](Read-Property $initialObject "size" "size")
  $restoredSize = [int64](Read-Property $restoredObject "size" "size")
  $restoredGeneration = [string]$restoredObject.generation
  $restored = (
    (Test-OwnedObject $restoredObject $probeName $runMarker $probeMd5 $probeSize) -and
    $restoredGeneration -and
    $restoredGeneration -ne $initialGeneration -and
    $initialMd5 -and
    $initialMd5 -eq $restoredMd5 -and
    $initialSize -eq $restoredSize
  )
  if (-not $restored) {
    throw "Restored probe did not match the original object"
  }
  $ownedLiveGeneration = $restoredGeneration

  $null = Invoke-GcloudText @(
    "storage", "cp", "$probeUrl#$restoredGeneration", $downloadPath,
    "--project", $ProjectId,
    "--quiet"
  )
  $restoredSha256 = (Get-FileHash -LiteralPath $downloadPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $restoredContentMatched = $restoredSha256 -eq $probeSha256
  if (-not $restoredContentMatched) {
    throw "Restored probe SHA-256 did not match the fixture"
  }

  $stage = "cleanup"
  $null = Invoke-GcloudText @(
    "storage", "rm", $probeUrl,
    "--if-generation-match=$restoredGeneration",
    "--project", $ProjectId,
    "--quiet"
  )
  $finalLiveObjectAbsent = Wait-ForLiveObjectAbsent $probeUrl $ProjectId
  $liveObjectExists = $false
  $ownedLiveGeneration = $null
  if (-not $finalLiveObjectAbsent) {
    throw "Cleanup left a live recovery probe"
  }

  $finalSoftDeletedObject = Wait-ForSoftDeletedObject "$probeUrl#$restoredGeneration" $ProjectId
  $finalDeleteObserved = (
    [string]$finalSoftDeletedObject.generation -eq $restoredGeneration -and
    (Test-OwnedObject $finalSoftDeletedObject $probeName $runMarker $probeMd5 $probeSize)
  )
  if (-not $finalDeleteObserved) {
    throw "Cleanup did not soft-delete the restored generation"
  }
} catch {
  $failureStage = $stage
} finally {
  Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
  if ($uploadAttempted) {
    try {
      $liveCheck = Invoke-GcloudText @(
        "storage", "objects", "describe", $probeUrl,
        "--project", $ProjectId,
        "--format=json"
      ) $true
      if ($liveCheck.ExitCode -eq 0 -and $liveCheck.Output) {
        $candidateObject = $liveCheck.Output | ConvertFrom-Json
        if (-not (Test-OwnedObject $candidateObject $probeName $runMarker $probeMd5 $probeSize)) {
          $liveObjectExists = $true
          $cleanupFailureStage = "cleanup_ownership_unverified"
        } else {
          $candidateGeneration = [string]$candidateObject.generation
          $null = Invoke-GcloudText @(
            "storage", "rm", $probeUrl,
            "--if-generation-match=$candidateGeneration",
            "--project", $ProjectId,
            "--quiet"
          )
          $null = Wait-ForLiveObjectAbsent $probeUrl $ProjectId
          $liveObjectExists = $false
          $ownedLiveGeneration = $null
        }
      } elseif (Test-ExplicitNotFound $liveCheck) {
        $liveObjectExists = $false
        $ownedLiveGeneration = $null
      } else {
        $liveObjectExists = $true
        $cleanupFailureStage = "cleanup_absence_unverified"
      }
    } catch {
      $liveObjectExists = $true
      $cleanupFailureStage = "cleanup_delete_failed"
    }
  }
}

$passed = (
  -not $failureStage -and
  $softDeleteObserved -and
  $restored -and
  $restoredContentMatched -and
  $finalDeleteObserved -and
  $finalLiveObjectAbsent -and
  -not $liveObjectExists -and
  -not $cleanupFailureStage
)
$softDeletePolicy = if ($bucket) {
  Read-Property $bucket "soft_delete_policy" "softDeletePolicy"
} else { $null }
$retentionSeconds = if ($softDeletePolicy) {
  [int64](Read-Property $softDeletePolicy "retentionDurationSeconds" "retentionDurationSeconds")
} else { 0 }
$completedAt = [DateTime]::UtcNow

$evidence = [ordered]@{
  schemaVersion = 2
  provider = "google-cloud-storage"
  environment = "production"
  status = if ($passed) { "passed" } else { "failed" }
  failureStage = if ($failureStage) { $failureStage } else { $cleanupFailureStage }
  primaryFailureStage = $failureStage
  projectId = $ProjectId
  bucket = $UploadBucket
  policy = [ordered]@{
    softDeleteRetentionSeconds = $retentionSeconds
    softDeleteRetentionDays = [math]::Round($retentionSeconds / 86400, 2)
    publicAccessPrevention = if ($bucket) {
      [string](Read-Property $bucket "public_access_prevention" "publicAccessPrevention")
    } else { $null }
    uniformBucketLevelAccess = if ($bucket) {
      [bool](Read-Property $bucket "uniform_bucket_level_access" "uniformBucketLevelAccess")
    } else { $false }
  }
  proofObject = [ordered]@{
    name = $probeName
    ownershipMarker = $runMarker
    originalGeneration = if ($initialObject) { [string]$initialObject.generation } else { $null }
    restoredGeneration = if ($restoredObject) { [string]$restoredObject.generation } else { $null }
    contentSha256 = $probeSha256
  }
  verification = [ordered]@{
    bucketProjectMatched = $bucketProjectMatched
    exactOriginalGenerationSoftDeleted = $softDeleteObserved
    restored = $restored
    restoredContentMatched = $restoredContentMatched
    finalLiveObjectAbsent = $finalLiveObjectAbsent
    exactRestoredGenerationSoftDeleted = $finalDeleteObserved
    cleanupFailureStage = $cleanupFailureStage
  }
  startedAtUtc = $startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  completedAtUtc = $completedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  artifactHashes = [ordered]@{
    proofScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    probeFileSha256 = (Get-FileHash -LiteralPath $ProbeFile -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

$json = $evidence | ConvertTo-Json -Depth 10
if ($EvidencePath) {
  Write-EvidenceFile $EvidencePath $json
}
$json
if (-not $passed) {
  exit 1
}
