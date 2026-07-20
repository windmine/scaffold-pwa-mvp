param(
  [string]$ContextFile = "",
  [int]$RestoreOffsetMinutes = 5,
  [int]$BranchLifetimeMinutes = 60,
  [string]$ProductionBranchName = "production",
  [string]$DatabaseName = "neondb",
  [string]$RoleName = "neondb_owner",
  [string]$PythonCommand = "python",
  [ValidateSet("neon@2.32.0")]
  [string]$NeonCliPackage = "neon@2.32.0",
  [string]$EvidencePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$verifyScript = Join-Path $PSScriptRoot "verify-neon-recovery.py"
$migrationsDir = Join-Path $repoRoot "backend/migrations/versions"

if (-not $ContextFile) {
  $ContextFile = Join-Path $repoRoot ".neon"
} elseif (-not [System.IO.Path]::IsPathRooted($ContextFile)) {
  $ContextFile = Join-Path $repoRoot $ContextFile
}
if ($EvidencePath -and -not [System.IO.Path]::IsPathRooted($EvidencePath)) {
  $EvidencePath = Join-Path $repoRoot $EvidencePath
}

function Invoke-NeonText([string[]]$Arguments, [bool]$AllowFailure = $false) {
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $raw = (& npx -y $NeonCliPackage @Arguments --no-analytics 2>$null | Out-String)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference

  if (-not $AllowFailure -and $exitCode -ne 0) {
    throw "Neon CLI operation failed"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = $raw.Trim()
  }
}

function Invoke-NeonJson([string[]]$Arguments) {
  $result = Invoke-NeonText (@($Arguments) + @("-o", "json"))
  if (-not $result.Output) {
    throw "Neon CLI returned no JSON"
  }

  try {
    return $result.Output | ConvertFrom-Json
  } catch {
    throw "Neon CLI returned invalid JSON"
  }
}

function Get-BranchCollection($Value) {
  if ($null -eq $Value) {
    return @()
  }
  if ($Value.PSObject.Properties.Name -contains "branches") {
    return @($Value.branches | Where-Object { $_ })
  }
  return @($Value | Where-Object { $_ })
}

function Get-BranchValue($Value) {
  if ($Value.PSObject.Properties.Name -contains "branch") {
    return $Value.branch
  }
  return $Value
}

function Get-OperationIds($Value) {
  $ids = New-Object System.Collections.Generic.List[string]
  if ($null -eq $Value) {
    return @()
  }
  if ($Value.PSObject.Properties.Name -contains "operations") {
    foreach ($operation in @($Value.operations | Where-Object { $_ })) {
      if ($operation.PSObject.Properties.Name -contains "id" -and $operation.id) {
        $ids.Add([string]$operation.id) | Out-Null
      }
    }
  }
  if ($Value.PSObject.Properties.Name -contains "operation") {
    $operation = $Value.operation
    if ($operation -and $operation.PSObject.Properties.Name -contains "id" -and $operation.id) {
      $ids.Add([string]$operation.id) | Out-Null
    }
  }
  return @($ids | Sort-Object -Unique)
}

function Remove-ProofBranch([string]$ProjectId, [string]$BranchId) {
  $result = Invoke-NeonText @(
    "branch", "delete", $BranchId,
    "--project-id", $ProjectId,
    "-o", "json"
  ) $true
  if ($result.ExitCode -ne 0) {
    return [pscustomobject]@{ Deleted = $false; OperationIds = @() }
  }

  $operationIds = @()
  if ($result.Output) {
    try {
      $operationIds = Get-OperationIds ($result.Output | ConvertFrom-Json)
    } catch {
      $operationIds = @()
    }
  }
  return [pscustomobject]@{ Deleted = $true; OperationIds = $operationIds }
}

function Parse-Utc([string]$Value, [string]$FieldName) {
  if (-not $Value) {
    throw "$FieldName is unavailable"
  }
  try {
    return [DateTime]::Parse($Value).ToUniversalTime()
  } catch {
    throw "$FieldName is invalid"
  }
}

function Test-ProofBranchOwnership(
  $Branch,
  [string]$ExpectedId,
  [string]$ExpectedName,
  [string]$ExpectedProjectId,
  [string]$ExpectedParentId,
  [DateTime]$RunStartedAt,
  [DateTime]$RequestedRestorePoint,
  [DateTime]$RequestedExpiresAt,
  [bool]$AllowInitializing = $false
) {
  if (-not $Branch) {
    return $false
  }
  try {
    $createdAt = Parse-Utc ([string]$Branch.created_at) "Proof ownership creation time"
    $parentTimestamp = Parse-Utc ([string]$Branch.parent_timestamp) "Proof ownership parent timestamp"
    $expiresAt = Parse-Utc ([string]$Branch.expires_at) "Proof ownership expiry"
    return (
      (-not $ExpectedId -or [string]$Branch.id -eq $ExpectedId) -and
      [string]$Branch.name -eq $ExpectedName -and
      [string]$Branch.project_id -eq $ExpectedProjectId -and
      [string]$Branch.parent_id -eq $ExpectedParentId -and
      (
        $Branch.current_state -eq "ready" -or
        ($AllowInitializing -and $Branch.current_state -eq "init")
      ) -and
      $Branch.default -is [bool] -and $Branch.default -eq $false -and
      $Branch.primary -is [bool] -and $Branch.primary -eq $false -and
      $createdAt -ge $RunStartedAt.AddMinutes(-1) -and
      $createdAt -le [DateTime]::UtcNow.AddMinutes(1) -and
      [Math]::Abs(($parentTimestamp - $RequestedRestorePoint).TotalSeconds) -le 120 -and
      [Math]::Abs(($expiresAt - $RequestedExpiresAt).TotalSeconds) -le 120
    )
  } catch {
    return $false
  }
}

function Test-PythonPreflight([string]$Command, [string]$VerifierPath) {
  if (-not (Test-Path -LiteralPath $VerifierPath)) {
    throw "Recovery verifier is unavailable"
  }
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $null = (& $Command -c "import psycopg" 2>$null | Out-String)
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  if ($exitCode -ne 0) {
    throw "Python psycopg dependency is unavailable"
  }
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
$uniqueSuffix = [Guid]::NewGuid().ToString("N").Substring(0, 10)
$proofBranchName = "recovery-proof-$($startedAt.ToString('yyyyMMddTHHmmssZ').ToLowerInvariant())-$uniqueSuffix"
$requestedRestorePoint = $startedAt.AddMinutes(-1 * $RestoreOffsetMinutes)
$requestedExpiresAt = $startedAt.AddMinutes($BranchLifetimeMinutes)
$stage = "preflight"
$failureStage = $null
$projectId = $null
$project = $null
$production = $null
$proofBranchId = $null
$proofBranchMetadata = $null
$branchCreationAttempted = $false
$branchOwned = $false
$verification = $null
$neonVersion = $null
$expectedMigrationHead = $null
$createOperationIds = @()
$deleteOperationIds = @()
$deleted = $false
$absenceVerified = $false
$cleanupFailureStage = $null

try {
  if (-not (Test-Path -LiteralPath $ContextFile)) {
    throw "Neon context is unavailable"
  }
  Test-PythonPreflight $PythonCommand $verifyScript

  $migrationFiles = @(
    Get-ChildItem -LiteralPath $migrationsDir -File |
      Where-Object { $_.Name -match '^\d{4}_.+\.py$' } |
      Sort-Object Name
  )
  if ($migrationFiles.Count -eq 0) {
    throw "Migration head is unavailable"
  }
  $expectedMigrationHead = [System.IO.Path]::GetFileNameWithoutExtension($migrationFiles[-1].Name)

  $versionResult = Invoke-NeonText @("--version")
  $neonVersion = $versionResult.Output
  $expectedCliVersion = ($NeonCliPackage -split "@")[-1]
  if ($neonVersion -ne $expectedCliVersion) {
    throw "Neon CLI version does not match the pinned package"
  }

  $context = Get-Content -LiteralPath $ContextFile -Raw | ConvertFrom-Json
  $projectId = [string]$context.projectId
  if (-not $projectId) {
    throw "Neon project ID is unavailable"
  }

  $projectResult = Invoke-NeonJson @("projects", "get", $projectId)
  $project = if ($projectResult.PSObject.Properties.Name -contains "project") {
    $projectResult.project
  } else {
    $projectResult
  }
  $production = Get-BranchValue (Invoke-NeonJson @(
    "branch", "get", $ProductionBranchName, "--project-id", $projectId
  ))

  $retentionSeconds = [int]$project.history_retention_seconds
  if ($retentionSeconds -lt (($RestoreOffsetMinutes + 2) * 60)) {
    throw "Neon history window is too short for this proof"
  }
  if (-not $production.default -or -not $production.primary -or $production.current_state -ne "ready") {
    throw "Production branch is not ready and primary"
  }

  $existingBranches = Get-BranchCollection (Invoke-NeonJson @(
    "branch", "list", "--project-id", $projectId
  ))
  if (@($existingBranches | Where-Object { $_.name -eq $proofBranchName }).Count -ne 0) {
    throw "Generated proof branch name is not unique"
  }

  $stage = "create_branch"
  $branchCreationAttempted = $true
  $createResult = Invoke-NeonJson @(
    "branch", "create",
    "--project-id", $projectId,
    "--name", $proofBranchName,
    "--parent", $requestedRestorePoint.ToString("yyyy-MM-ddTHH:mm:ssZ"),
    "--type", "read_only",
    "--expires-at", $requestedExpiresAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  )
  $createdBranch = Get-BranchValue $createResult
  $proofBranchId = [string]$createdBranch.id
  $createOperationIds = Get-OperationIds $createResult
  $createdBranch = $null
  $createResult = $null
  if (-not $proofBranchId) {
    throw "Proof branch ID is unavailable"
  }

  $stage = "wait_for_branch"
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  $proofBranch = $null
  do {
    $proofBranch = Get-BranchValue (Invoke-NeonJson @(
      "branch", "get", $proofBranchId, "--project-id", $projectId
    ))
    if ($proofBranch.current_state -eq "ready") {
      break
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $proofBranch -or $proofBranch.current_state -ne "ready") {
    throw "Proof branch did not become ready"
  }
  if (-not (Test-ProofBranchOwnership `
    $proofBranch `
    $proofBranchId `
    $proofBranchName `
    $projectId `
    ([string]$production.id) `
    $startedAt `
    $requestedRestorePoint `
    $requestedExpiresAt `
    $false
  )) {
    throw "Proof branch ownership metadata did not match this run"
  }
  $branchOwned = $true

  $actualParentTimestamp = Parse-Utc ([string]$proofBranch.parent_timestamp) "Proof parent timestamp"
  $actualExpiresAt = Parse-Utc ([string]$proofBranch.expires_at) "Proof branch expiry"
  $actualCreatedAt = Parse-Utc ([string]$proofBranch.created_at) "Proof branch creation time"
  $parentDeltaSeconds = [Math]::Abs(($actualParentTimestamp - $requestedRestorePoint).TotalSeconds)
  $expiryDeltaSeconds = [Math]::Abs(($actualExpiresAt - $requestedExpiresAt).TotalSeconds)
  if ($parentDeltaSeconds -gt 120 -or $actualParentTimestamp -ge $startedAt.AddMinutes(-1)) {
    throw "Proof branch does not match the requested historical point"
  }
  if ($expiryDeltaSeconds -gt 120 -or $actualExpiresAt -le $startedAt) {
    throw "Proof branch expiry does not match the requested safety window"
  }
  if ($actualCreatedAt -lt $startedAt.AddMinutes(-1) -or $actualCreatedAt -gt [DateTime]::UtcNow.AddMinutes(1)) {
    throw "Proof branch creation time is outside this run"
  }

  $proofBranchMetadata = [ordered]@{
    id = $proofBranchId
    name = [string]$proofBranch.name
    parentId = [string]$proofBranch.parent_id
    parentTimestampUtc = $actualParentTimestamp.ToString("yyyy-MM-ddTHH:mm:ssZ")
    createdAtUtc = $actualCreatedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
    expiresAtUtc = $actualExpiresAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
    endpointType = $null
  }
  $proofBranch = $null

  $stage = "connect_read_only"
  $connectionResult = Invoke-NeonText @(
    "connection-string", $proofBranchId,
    "--project-id", $projectId,
    "--database-name", $DatabaseName,
    "--role-name", $RoleName,
    "--endpoint-type", "read_only",
    "--ssl", "require"
  )
  $connectionOutput = $connectionResult.Output
  $connectionResult = $null
  $connectionString = @(
    $connectionOutput -split "`r?`n" |
      Where-Object { $_ -match '^postgres(ql)?://' }
  )[-1]
  $connectionOutput = $null
  if (-not $connectionString) {
    throw "Recovery connection was unavailable"
  }

  $env:NEON_RECOVERY_DATABASE_URL = $connectionString.Trim()
  $connectionString = $null
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  $verificationRaw = (& $PythonCommand $verifyScript 2>$null | Out-String)
  $verificationExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousPreference
  Remove-Item Env:NEON_RECOVERY_DATABASE_URL -ErrorAction SilentlyContinue
  if ($verificationExitCode -ne 0) {
    throw "Recovered database verification failed"
  }

  $verification = $verificationRaw | ConvertFrom-Json
  $verificationRaw = $null
  if (
    $verification.status -ne "passed" -or
    $verification.migrationHead -ne $expectedMigrationHead -or
    $verification.businessDataPresent.department -isnot [bool] -or
    $verification.businessDataPresent.department -ne $true -or
    $verification.businessDataPresent.site -isnot [bool] -or
    $verification.businessDataPresent.site -ne $true -or
    $verification.businessDataPresent.user -isnot [bool] -or
    $verification.businessDataPresent.user -ne $true
  ) {
    throw "Recovered database does not match the current migration head"
  }
  $proofBranchMetadata.endpointType = "read_only"

  $stage = "cleanup"
} catch {
  $failureStage = $stage
} finally {
  Remove-Item Env:NEON_RECOVERY_DATABASE_URL -ErrorAction SilentlyContinue
  $connectionOutput = $null
  $connectionString = $null

  if ((-not $proofBranchId -or -not $branchOwned) -and $projectId -and $production) {
    try {
      $safeMatches = @()
      $discoveryDeadline = [DateTime]::UtcNow.AddSeconds(30)
      do {
        $branches = Get-BranchCollection (Invoke-NeonJson @(
          "branch", "list", "--project-id", $projectId
        ))
        $safeMatches = @($branches | Where-Object {
          Test-ProofBranchOwnership `
            $_ `
            "" `
            $proofBranchName `
            $projectId `
            ([string]$production.id) `
            $startedAt `
            $requestedRestorePoint `
            $requestedExpiresAt `
            $true
        })
        if ($safeMatches.Count -eq 1) {
          break
        }
        Start-Sleep -Seconds 2
      } while ([DateTime]::UtcNow -lt $discoveryDeadline)
      if ($safeMatches.Count -eq 1) {
        $proofBranchId = [string]$safeMatches[0].id
        $branchOwned = $true
      }
    } catch {
      $branchOwned = $false
    }
  }

  if ($proofBranchId -and $projectId -and $branchOwned) {
    try {
      $currentBranch = Get-BranchValue (Invoke-NeonJson @(
        "branch", "get", $proofBranchId, "--project-id", $projectId
      ))
      if (-not (Test-ProofBranchOwnership `
        $currentBranch `
        $proofBranchId `
        $proofBranchName `
        $projectId `
        ([string]$production.id) `
        $startedAt `
        $requestedRestorePoint `
        $requestedExpiresAt `
        $true
      )) {
        throw "Proof branch ownership changed before cleanup"
      }

      $deleteResult = Remove-ProofBranch $projectId $proofBranchId
      $deleted = [bool]$deleteResult.Deleted
      $deleteOperationIds = @($deleteResult.OperationIds)
      if (-not $deleted) {
        $cleanupFailureStage = "cleanup_delete_failed"
      } else {
        $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
          try {
            $branches = Get-BranchCollection (Invoke-NeonJson @(
              "branch", "list", "--project-id", $projectId
            ))
            $stillPresent = @($branches | Where-Object { $_.id -eq $proofBranchId }).Count -gt 0
            if (-not $stillPresent) {
              $absenceVerified = $true
              break
            }
          } catch {
            $stillPresent = $true
          }
          Start-Sleep -Seconds 2
        } while ([DateTime]::UtcNow -lt $cleanupDeadline)
        if (-not $absenceVerified) {
          $cleanupFailureStage = "cleanup_absence_unverified"
        }
      }
    } catch {
      $cleanupFailureStage = "cleanup_ownership_unverified"
    }
  } elseif ($branchCreationAttempted) {
    $cleanupFailureStage = "cleanup_ownership_unverified"
  }
}

$passed = (
  -not $failureStage -and
  $verification -and
  $verification.status -eq "passed" -and
  $branchOwned -and
  $deleted -and
  $absenceVerified -and
  -not $cleanupFailureStage
)
$completedAt = [DateTime]::UtcNow
$evidence = [ordered]@{
  schemaVersion = 2
  provider = "neon"
  environment = "production"
  status = if ($passed) { "passed" } else { "failed" }
  failureStage = if ($failureStage) { $failureStage } else { $cleanupFailureStage }
  primaryFailureStage = $failureStage
  projectId = if ($project) { [string]$project.id } else { $projectId }
  productionBranch = if ($production) {
    [ordered]@{
      id = [string]$production.id
      name = [string]$production.name
      historyRetentionSeconds = [int]$project.history_retention_seconds
    }
  } else { $null }
  requestedRestorePointUtc = $requestedRestorePoint.ToString("yyyy-MM-ddTHH:mm:ssZ")
  requestedExpiresAtUtc = $requestedExpiresAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  proofBranch = $proofBranchMetadata
  verification = $verification
  expectedMigrationHead = $expectedMigrationHead
  operations = [ordered]@{
    create = @($createOperationIds)
    delete = @($deleteOperationIds)
  }
  cleanup = [ordered]@{
    ownershipVerified = $branchOwned
    deleted = $deleted
    absenceVerified = $absenceVerified
    failureStage = $cleanupFailureStage
  }
  startedAtUtc = $startedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  completedAtUtc = $completedAt.ToString("yyyy-MM-ddTHH:mm:ssZ")
  toolVersions = [ordered]@{
    neonCliPackage = $NeonCliPackage
    neonCli = $neonVersion
    python = if ($verification) { [string]$verification.pythonVersion } else { $null }
    psycopg = if ($verification) { [string]$verification.psycopgVersion } else { $null }
  }
  artifactHashes = [ordered]@{
    proofScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
    verifierScriptSha256 = (Get-FileHash -LiteralPath $verifyScript -Algorithm SHA256).Hash.ToLowerInvariant()
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
