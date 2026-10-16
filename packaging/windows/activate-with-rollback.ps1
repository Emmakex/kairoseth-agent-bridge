param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('activate','rollback','finalize')]
  [string]$Action
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message, [int]$Code = 1) {
  Write-Error "[agent-bridge-windows] $Message"
  exit $Code
}

function Get-EnvOrDefault([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

function Read-Pointer([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  $value = (Get-Content -LiteralPath $Path -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($value)) { return $null }
  return $value
}

function Write-Pointer([string]$Path, [string]$Value) {
  $temp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  Set-Content -LiteralPath $temp -Value $Value -NoNewline
  Move-Item -Force -LiteralPath $temp -Destination $Path
}

function Read-Release([string]$ReleaseDir) {
  $descriptorPath = Join-Path $ReleaseDir 'runtime-release.json'
  if (-not (Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { Fail "Release is missing runtime-release.json: $ReleaseDir" }
  try { $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json } catch { Fail "Release descriptor is invalid JSON: $ReleaseDir" }
  if ($descriptor.schemaVersion -ne 'kab.runtime-release.v1' -or
      $descriptor.technicalProductId -ne 'agent-bridge' -or
      ([string]$descriptor.artifactSha256) -notmatch '^[a-fA-F0-9]{64}$' -or
      ([string]$descriptor.sourceCommit) -notmatch '^[a-fA-F0-9]{40,64}$' -or
      @('stable','candidate') -notcontains [string]$descriptor.channel) {
    Fail "Release descriptor is invalid: $ReleaseDir"
  }
  return $descriptor
}

function Escape-Xml([string]$Value) {
  return [Security.SecurityElement]::Escape($Value)
}

function Render-ServiceConfig([string]$ReleaseDir) {
  $templatePath = Join-Path $ReleaseDir 'packaging\windows\agent-bridge-service.xml.template'
  if (-not (Test-Path -LiteralPath $templatePath -PathType Leaf)) { Fail "Service template is missing: $templatePath" }
  $runtimeEntry = Join-Path $ReleaseDir 'dist\src\cli\agent-bridge-runtime.js'
  $serviceExe = Join-Path $ReleaseDir 'packaging\windows\agent-bridge-service.exe'
  if (-not (Test-Path -LiteralPath $runtimeEntry -PathType Leaf)) { Fail "Runtime entry is missing: $runtimeEntry" }
  if (-not (Test-Path -LiteralPath $serviceExe -PathType Leaf)) { Fail "Service wrapper is missing: $serviceExe" }

  $content = Get-Content -LiteralPath $templatePath -Raw
  $content = $content.Replace('__NODE_EXE__', (Escape-Xml $NodeBin))
  $content = $content.Replace('__ENV_FILE__', (Escape-Xml $EnvFile))
  $content = $content.Replace('__RUNTIME_ENTRY__', (Escape-Xml $runtimeEntry))
  $content = $content.Replace('__RELEASE_DIR__', (Escape-Xml $ReleaseDir))
  $content = $content.Replace('__LOG_DIR__', (Escape-Xml $LogRoot))

  New-Item -ItemType Directory -Force -Path $ServiceStateRoot | Out-Null
  $temp = "$ServiceConfig.$([guid]::NewGuid().ToString('N')).tmp"
  Set-Content -LiteralPath $temp -Value $content -Encoding utf8
  Move-Item -Force -LiteralPath $temp -Destination $ServiceConfig
}

function Invoke-ServiceCtl([string]$ReleaseDir, [string]$Command, [switch]$IgnoreFailure) {
  $exe = if ($TestMode) { $ServiceCtlOverride } else { Join-Path $ReleaseDir 'packaging\windows\agent-bridge-service.exe' }
  if ([string]::IsNullOrWhiteSpace($exe) -or -not (Test-Path -LiteralPath $exe -PathType Leaf)) {
    Fail "Service control executable is missing: $exe"
  }

  & $exe $Command $ServiceConfig
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0 -and -not $IgnoreFailure) {
    Fail "Service control command '$Command' failed with exit code $exitCode."
  }
}

function Test-ReleaseHealth([string]$ReleaseDir) {
  $runtimeEntry = Join-Path $ReleaseDir 'dist\src\cli\agent-bridge-runtime.js'
  $deadline = [DateTime]::UtcNow.AddSeconds($HealthTimeoutSeconds)
  do {
    & $NodeBin "--env-file=$EnvFile" $runtimeEntry healthcheck *> $null
    if ($LASTEXITCODE -eq 0) { return $true }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  return $false
}

function Assert-ExpectedDigest([object]$Descriptor, [string]$Expected, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Expected)) { return }
  if ($Expected -notmatch '^[a-fA-F0-9]{64}$') { Fail "$Label expected digest is invalid." }
  if (([string]$Descriptor.artifactSha256).ToLowerInvariant() -ne $Expected.ToLowerInvariant()) {
    Fail "$Label digest does not match the expected release."
  }
}

$TestMode = (Get-EnvOrDefault 'KAB_TEST_MODE' '0') -eq '1'
$InstallRoot = Get-EnvOrDefault 'KAB_INSTALL_ROOT' (Join-Path $env:ProgramFiles 'Kairoseth\AgentBridge')
$ConfigRoot = Get-EnvOrDefault 'KAB_CONFIG_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\config')
$StateRoot = Get-EnvOrDefault 'KAB_STATE_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\state')
$LogRoot = Get-EnvOrDefault 'KAB_LOG_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\logs')
$NodeBin = Get-EnvOrDefault 'KAB_NODE_BIN' 'node.exe'
$HealthTimeoutSeconds = [int](Get-EnvOrDefault 'KAB_HEALTH_TIMEOUT_SECONDS' '45')
$ServiceCtlOverride = Get-EnvOrDefault 'KAB_SERVICE_CTL' ''
$ExpectedCurrent = Get-EnvOrDefault 'KAB_EXPECTED_CURRENT_ARTIFACT_SHA256' ''
$ExpectedCandidate = Get-EnvOrDefault 'KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256' ''
$CandidateOverride = Get-EnvOrDefault 'KAB_CANDIDATE_RELEASE_PATH' ''
$CurrentPointer = Join-Path $InstallRoot 'current.txt'
$PreviousPointer = Join-Path $InstallRoot 'previous.txt'
$ServiceStateRoot = Join-Path $InstallRoot 'service'
$ServiceConfig = Join-Path $ServiceStateRoot 'agent-bridge-service.xml'
$EnvFile = Join-Path $ConfigRoot 'agent-bridge.env'

if ($HealthTimeoutSeconds -lt 1 -or $HealthTimeoutSeconds -gt 300) { Fail 'KAB_HEALTH_TIMEOUT_SECONDS must be between 1 and 300.' }
if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { Fail "Runtime environment file is missing: $EnvFile" }
if ($TestMode -and [string]::IsNullOrWhiteSpace($ServiceCtlOverride)) { Fail 'KAB_SERVICE_CTL is required in test mode.' }

if ($Action -eq 'finalize') {
  if (Test-Path -LiteralPath $PreviousPointer -PathType Leaf) { Remove-Item -LiteralPath $PreviousPointer -Force }
  Write-Output 'finalized=true'
  exit 0
}

$CurrentRelease = Read-Pointer $CurrentPointer
if ([string]::IsNullOrWhiteSpace($CurrentRelease)) { Fail 'No current Windows release is installed.' }
$CurrentDescriptor = Read-Release $CurrentRelease
Assert-ExpectedDigest $CurrentDescriptor $ExpectedCurrent 'Current release'

if ($Action -eq 'rollback') {
  $CandidateRelease = Read-Pointer $PreviousPointer
  if ([string]::IsNullOrWhiteSpace($CandidateRelease)) { Fail 'No previous Windows release is available for rollback.' }
} else {
  if ([string]::IsNullOrWhiteSpace($CandidateOverride)) { Fail 'KAB_CANDIDATE_RELEASE_PATH is required for activation.' }
  $CandidateRelease = $CandidateOverride
}

$CandidateRelease = (Resolve-Path -LiteralPath $CandidateRelease).Path
$CurrentRelease = (Resolve-Path -LiteralPath $CurrentRelease).Path
$CandidateDescriptor = Read-Release $CandidateRelease
Assert-ExpectedDigest $CandidateDescriptor $ExpectedCandidate 'Candidate release'

if ($CandidateRelease -eq $CurrentRelease) {
  Write-Output 'activation=noop'
  exit 0
}

$CandidateDigest = ([string]$CandidateDescriptor.artifactSha256).ToLowerInvariant()
$ExpectedCandidateDir = (Join-Path (Join-Path $InstallRoot 'releases') ("sha256-$CandidateDigest"))
if (([IO.Path]::GetFullPath($CandidateRelease)).TrimEnd('\') -ne ([IO.Path]::GetFullPath($ExpectedCandidateDir)).TrimEnd('\')) {
  Fail 'Candidate release path is not bound to its artifact SHA-256.'
}

$OldServiceConfig = $null
if (Test-Path -LiteralPath $ServiceConfig -PathType Leaf) { $OldServiceConfig = Get-Content -LiteralPath $ServiceConfig -Raw }

Invoke-ServiceCtl $CurrentRelease 'stop' -IgnoreFailure
Invoke-ServiceCtl $CurrentRelease 'uninstall' -IgnoreFailure
Write-Pointer $PreviousPointer $CurrentRelease
Render-ServiceConfig $CandidateRelease
Invoke-ServiceCtl $CandidateRelease 'install'
Invoke-ServiceCtl $CandidateRelease 'start'

if (Test-ReleaseHealth $CandidateRelease) {
  Write-Pointer $CurrentPointer $CandidateRelease
  Write-Output "activation=success"
  Write-Output "artifactSha256=$CandidateDigest"
  exit 0
}

Invoke-ServiceCtl $CandidateRelease 'stop' -IgnoreFailure
Invoke-ServiceCtl $CandidateRelease 'uninstall' -IgnoreFailure

try {
  if ($null -ne $OldServiceConfig) {
    Set-Content -LiteralPath $ServiceConfig -Value $OldServiceConfig -Encoding utf8
  } else {
    Render-ServiceConfig $CurrentRelease
  }
  Invoke-ServiceCtl $CurrentRelease 'install'
  Invoke-ServiceCtl $CurrentRelease 'start'
  if (-not (Test-ReleaseHealth $CurrentRelease)) { throw 'Previous release failed its healthcheck.' }
  Write-Pointer $CurrentPointer $CurrentRelease
  if (Test-Path -LiteralPath $PreviousPointer -PathType Leaf) { Remove-Item -LiteralPath $PreviousPointer -Force }
  Write-Output 'activation=rolled-back'
  Write-Output "artifactSha256=$(([string]$CurrentDescriptor.artifactSha256).ToLowerInvariant())"
  exit 20
} catch {
  Fail "Candidate failed and exact previous release could not be restored: $($_.Exception.Message)" 21
}
