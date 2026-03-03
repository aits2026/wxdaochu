param(
  [Parameter(Mandatory = $true)]
  [string]$RepoDir,
  [string]$Branch = "",
  [string]$Command = "npm run build",
  [string]$LogRoot = "C:\codex-logs\codex-remote",
  [switch]$SkipInstall,
  [switch]$SkipGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Action
  )

  Write-Host ""
  Write-Host "==== $Name ===="
  & $Action
  if ($LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runDir = Join-Path $LogRoot $timestamp
New-Item -ItemType Directory -Path $runDir -Force | Out-Null

$runLog = Join-Path $runDir "run.log"
$commandLog = Join-Path $runDir "command.log"
$summaryFile = Join-Path $runDir "summary.json"

$status = "success"
$errorMessage = ""
$resolvedBranch = ""

Start-Transcript -Path $runLog -Force | Out-Null

try {
  if (-not (Test-Path $RepoDir)) {
    throw "RepoDir not found: $RepoDir"
  }

  Set-Location $RepoDir

  $resolvedBranch = $Branch
  if (-not $SkipGit.IsPresent) {
    if ([string]::IsNullOrWhiteSpace($resolvedBranch)) {
      $resolvedBranch = (& git rev-parse --abbrev-ref HEAD)
      if ($LASTEXITCODE -ne 0) {
        throw "cannot resolve git branch from $RepoDir"
      }
      $resolvedBranch = $resolvedBranch.Trim()
    }

    if ([string]::IsNullOrWhiteSpace($resolvedBranch) -or $resolvedBranch -eq "HEAD") {
      throw "invalid branch: $resolvedBranch"
    }

    Invoke-Step -Name "git fetch" -Action { & git fetch origin --prune }
    Invoke-Step -Name "git switch $resolvedBranch" -Action { & git switch $resolvedBranch }
    Invoke-Step -Name "git pull" -Action { & git pull --ff-only origin $resolvedBranch }
  }

  if (-not $SkipInstall.IsPresent) {
    Invoke-Step -Name "npm ci" -Action { & npm ci }
  }

  Write-Host ""
  Write-Host "==== run command ===="
  Write-Host $Command
  & cmd.exe /d /s /c "$Command" *>&1 | Tee-Object -FilePath $commandLog
  if ($LASTEXITCODE -ne 0) {
    throw "command failed with exit code $LASTEXITCODE"
  }
}
catch {
  $status = "failed"
  $errorMessage = $_.Exception.Message
  Write-Error $_
}
finally {
  $summary = [ordered]@{
    status      = $status
    repoDir     = $RepoDir
    branch      = $resolvedBranch
    command     = $Command
    skipInstall = [bool]$SkipInstall.IsPresent
    skipGit     = [bool]$SkipGit.IsPresent
    runDir      = $runDir
    runLog      = $runLog
    commandLog  = $commandLog
    summaryFile = $summaryFile
    error       = $errorMessage
    finishedAt  = (Get-Date).ToString("o")
  }
  $summary | ConvertTo-Json -Depth 4 | Set-Content -Path $summaryFile -Encoding UTF8
  Stop-Transcript | Out-Null

  Write-Host ""
  Write-Host "RUN_DIR=$runDir"
  Write-Host "SUMMARY_FILE=$summaryFile"
  Write-Host "STATUS=$status"

  if ($status -ne "success") {
    exit 1
  }
}
