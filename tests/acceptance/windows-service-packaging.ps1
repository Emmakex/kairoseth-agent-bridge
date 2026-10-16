$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Join-Path ([IO.Path]::GetTempPath()) ("kab-win-acceptance-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Root | Out-Null

try {
  $InstallRoot = Join-Path $Root 'ProgramFiles\AgentBridge'
  $ConfigRoot = Join-Path $Root 'ProgramData\config'
  $StateRoot = Join-Path $Root 'ProgramData\state'
  $LogRoot = Join-Path $Root 'ProgramData\logs'
  $ServiceState = Join-Path $Root 'service-state.txt'
  $FakeServiceCtl = Join-Path $Root 'fake-service.cmd'
  $NodeBin = (Get-Command node.exe).Source
  $PreviousDigest = ('a' * 64)
  $CandidateDigest = ('b' * 64)
  $PreviousCommit = ('1' * 40)
  $CandidateCommit = ('2' * 40)

  @'
@echo off
setlocal
if "%1"=="start" (
  > "%FAKE_SERVICE_STATE%" echo active
  exit /b 0
)
if "%1"=="stop" (
  > "%FAKE_SERVICE_STATE%" echo inactive
  exit /b 0
)
if "%1"=="install" exit /b 0
if "%1"=="uninstall" exit /b 0
exit /b 2
'@ | Set-Content -LiteralPath $FakeServiceCtl -Encoding ascii

  function New-FixtureBundle(
    [string]$Name,
    [string]$Version,
    [string]$Digest,
    [string]$Commit,
    [bool]$Healthy
  ) {
    $StageParent = Join-Path $Root "stage-$Name"
    $Stage = Join-Path $StageParent $Name
    New-Item -ItemType Directory -Force -Path `
      (Join-Path $Stage 'dist\src\cli'), `
      (Join-Path $Stage 'node_modules'), `
      (Join-Path $Stage 'packaging\windows') | Out-Null

    Copy-Item -LiteralPath 'packaging\windows\agent-bridge-service.xml.template' -Destination (Join-Path $Stage 'packaging\windows\')
    Copy-Item -LiteralPath 'packaging\windows\agent-bridge.env.example' -Destination (Join-Path $Stage 'packaging\windows\')
    Set-Content -LiteralPath (Join-Path $Stage 'packaging\windows\agent-bridge-service.exe') -Value 'fixture' -Encoding ascii
    Set-Content -LiteralPath (Join-Path $Stage 'package.json') -Value '{"type":"module"}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $Stage 'package-lock.json') -Value '{}' -Encoding utf8
    Set-Content -LiteralPath (Join-Path $Stage 'node_modules\.fixture') -Value 'fixture' -Encoding utf8

    $descriptor = [ordered]@{
      schemaVersion = 'kab.runtime-release.v1'
      technicalProductId = 'agent-bridge'
      packageVersion = $Version
      artifactSha256 = $Digest
      sourceCommit = $Commit
      channel = 'stable'
    }
    $descriptor | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $Stage 'runtime-release.json') -Encoding utf8

    $runtimePath = Join-Path $Stage 'dist\src\cli\agent-bridge-runtime.js'
    if ($Healthy) {
      @'
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] !== "healthcheck") process.exit(2);
const state = process.env.KAB_STATE_DIR;
if (!state) process.exit(2);
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "previous-health.marker"), "healthy\n");
process.exit(0);
'@ | Set-Content -LiteralPath $runtimePath -Encoding utf8
    } else {
      @'
import fs from "node:fs";
import path from "node:path";
if (process.argv[2] !== "healthcheck") process.exit(2);
const state = process.env.KAB_STATE_DIR;
if (!state) process.exit(2);
fs.mkdirSync(state, { recursive: true });
fs.writeFileSync(path.join(state, "candidate-attempt.marker"), "attempted\n");
process.exit(1);
'@ | Set-Content -LiteralPath $runtimePath -Encoding utf8
    }

    $Archive = Join-Path $Root "$Name.zip"
    Compress-Archive -Path $Stage -DestinationPath $Archive -CompressionLevel Optimal
    return $Archive
  }

  $PreviousBundle = New-FixtureBundle 'previous-windows' '1.0.0' $PreviousDigest $PreviousCommit $true
  $CandidateBundle = New-FixtureBundle 'candidate-windows' '1.1.0' $CandidateDigest $CandidateCommit $false
  $PreviousBundleSha = (Get-FileHash -LiteralPath $PreviousBundle -Algorithm SHA256).Hash.ToLowerInvariant()
  $CandidateBundleSha = (Get-FileHash -LiteralPath $CandidateBundle -Algorithm SHA256).Hash.ToLowerInvariant()

  $env:KAB_TEST_MODE = '1'
  $env:KAB_INSTALL_ROOT = $InstallRoot
  $env:KAB_CONFIG_ROOT = $ConfigRoot
  $env:KAB_STATE_ROOT = $StateRoot
  $env:KAB_LOG_ROOT = $LogRoot
  $env:KAB_NODE_BIN = $NodeBin
  $env:KAB_SERVICE_CTL = $FakeServiceCtl
  $env:FAKE_SERVICE_STATE = $ServiceState

  & pwsh -NoProfile -File 'packaging\windows\install-bundle.ps1' $PreviousBundle $PreviousBundleSha | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Previous Windows bundle install failed.' }

  $PreviousRelease = Join-Path $InstallRoot "releases\sha256-$PreviousDigest"
  $CandidateRelease = Join-Path $InstallRoot "releases\sha256-$CandidateDigest"
  if ((Get-Content -LiteralPath (Join-Path $InstallRoot 'current.txt') -Raw).Trim() -ne $PreviousRelease) {
    throw 'Initial Windows current pointer is incorrect.'
  }

  Add-Content -LiteralPath (Join-Path $ConfigRoot 'agent-bridge.env') -Value 'CUSTOM_OPERATOR_VALUE=preserve-me'
  & pwsh -NoProfile -File 'packaging\windows\install-bundle.ps1' $CandidateBundle $CandidateBundleSha | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Candidate Windows bundle install failed.' }
  if ((Get-Content -LiteralPath (Join-Path $InstallRoot 'current.txt') -Raw).Trim() -ne $PreviousRelease) {
    throw 'Candidate install changed current without activation.'
  }
  if (-not (Select-String -LiteralPath (Join-Path $ConfigRoot 'agent-bridge.env') -Pattern '^CUSTOM_OPERATOR_VALUE=preserve-me$' -Quiet)) {
    throw 'Operator configuration was not preserved.'
  }

  New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null
  Set-Content -LiteralPath (Join-Path $StateRoot 'durable.marker') -Value 'durable-state' -NoNewline
  Set-Content -LiteralPath $ServiceState -Value 'active' -NoNewline

  $env:KAB_HEALTH_TIMEOUT_SECONDS = '1'
  $env:KAB_CANDIDATE_RELEASE_PATH = $CandidateRelease
  $env:KAB_EXPECTED_CURRENT_ARTIFACT_SHA256 = $PreviousDigest
  $env:KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256 = $CandidateDigest

  & pwsh -NoProfile -File 'packaging\windows\activate-with-rollback.ps1' activate | Out-Null
  $ActivationStatus = $LASTEXITCODE
  if ($ActivationStatus -ne 20) { throw "Expected rollback exit code 20, got $ActivationStatus." }

  if ((Get-Content -LiteralPath (Join-Path $InstallRoot 'current.txt') -Raw).Trim() -ne $PreviousRelease) {
    throw 'Exact previous Windows release was not restored.'
  }
  if (Test-Path -LiteralPath (Join-Path $InstallRoot 'previous.txt')) { throw 'Rollback pointer was not cleared after automatic restore.' }
  if ((Get-Content -LiteralPath $ServiceState -Raw).Trim() -ne 'active') { throw 'Previous Windows service was not restored to active state.' }
  if ((Get-Content -LiteralPath (Join-Path $StateRoot 'durable.marker') -Raw).Trim() -ne 'durable-state') { throw 'Durable state changed during rollback.' }
  if (-not (Test-Path -LiteralPath (Join-Path $StateRoot 'candidate-attempt.marker'))) { throw 'Candidate healthcheck was not attempted.' }
  if (-not (Test-Path -LiteralPath (Join-Path $StateRoot 'previous-health.marker'))) { throw 'Previous release healthcheck was not executed.' }

  $template = Get-Content -LiteralPath 'packaging\windows\agent-bridge-service.xml.template' -Raw
  if ($template -notmatch 'NT AUTHORITY\\LocalService') { throw 'Windows service must run as LocalService.' }
  if ($template -notmatch '<stoptimeout>30sec</stoptimeout>') { throw 'Windows graceful stop timeout is missing.' }
  if ($template -notmatch '<onfailure action="restart"') { throw 'Windows service restart policy is missing.' }
  if ($template -notmatch '--env-file=') { throw 'Windows service must load external environment configuration.' }

  Write-Output "Installed Windows rollback drill passed: candidate failed, exact previous digest $PreviousDigest restored with durable state."
} finally {
  Remove-Item Env:KAB_TEST_MODE -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_INSTALL_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_CONFIG_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_STATE_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_LOG_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_NODE_BIN -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_SERVICE_CTL -ErrorAction SilentlyContinue
  Remove-Item Env:FAKE_SERVICE_STATE -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_HEALTH_TIMEOUT_SECONDS -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_CANDIDATE_RELEASE_PATH -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_EXPECTED_CURRENT_ARTIFACT_SHA256 -ErrorAction SilentlyContinue
  Remove-Item Env:KAB_EXPECTED_CANDIDATE_ARTIFACT_SHA256 -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $Root) { Remove-Item -LiteralPath $Root -Recurse -Force }
}
