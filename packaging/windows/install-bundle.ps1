param(
  [Parameter(Mandatory = $true, Position = 0)][string]$BundlePath,
  [Parameter(Mandatory = $true, Position = 1)][string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) {
  throw "[agent-bridge-windows] $Message"
}

function Get-EnvOrDefault([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) { return $Default }
  return $value
}

$TestMode = (Get-EnvOrDefault 'KAB_TEST_MODE' '0') -eq '1'
$InstallRoot = Get-EnvOrDefault 'KAB_INSTALL_ROOT' (Join-Path $env:ProgramFiles 'Kairoseth\AgentBridge')
$ConfigRoot = Get-EnvOrDefault 'KAB_CONFIG_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\config')
$StateRoot = Get-EnvOrDefault 'KAB_STATE_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\state')
$LogRoot = Get-EnvOrDefault 'KAB_LOG_ROOT' (Join-Path $env:ProgramData 'Kairoseth\AgentBridge\logs')
$NodeBin = Get-EnvOrDefault 'KAB_NODE_BIN' 'node.exe'

if (-not (Test-Path -LiteralPath $BundlePath -PathType Leaf)) { Fail "Bundle does not exist: $BundlePath" }
if ($ExpectedSha256 -notmatch '^[a-fA-F0-9]{64}$') { Fail 'Expected bundle SHA-256 is invalid.' }

$ActualSha256 = (Get-FileHash -LiteralPath $BundlePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualSha256 -ne $ExpectedSha256.ToLowerInvariant()) { Fail 'Windows bundle SHA-256 does not match the expected digest.' }

try {
  $NodeMajor = [int](& $NodeBin -p "Number(process.versions.node.split('.')[0])")
} catch {
  Fail "Unable to execute Node.js: $NodeBin"
}
if ($NodeMajor -lt 22) { Fail 'Agent Bridge requires Node.js 22 or newer.' }

if (-not $TestMode) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Fail 'Windows service installation requires Administrator privileges.'
  }
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $BundlePath))
try {
  if ($archive.Entries.Count -eq 0) { Fail 'Windows bundle is empty.' }
  $topLevels = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($entry in $archive.Entries) {
    $name = $entry.FullName
    if ([string]::IsNullOrWhiteSpace($name)) { continue }
    if ($name -match '^[\\/]' -or $name -match '^[A-Za-z]:' -or $name -match '(^|[\\/])\.\.([\\/]|$)') {
      Fail "Windows bundle contains an unsafe path: $name"
    }
    $first = ($name -split '[\\/]')[0]
    if (-not [string]::IsNullOrWhiteSpace($first)) { [void]$topLevels.Add($first) }
  }
  if ($topLevels.Count -ne 1) { Fail 'Windows bundle must contain exactly one top-level directory.' }
  $TopLevel = @($topLevels)[0]
} finally {
  $archive.Dispose()
}

$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("agent-bridge-win-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $TempRoot | Out-Null
try {
  Expand-Archive -LiteralPath $BundlePath -DestinationPath $TempRoot
  $StagedRoot = Join-Path $TempRoot $TopLevel
  $DescriptorPath = Join-Path $StagedRoot 'runtime-release.json'
  $PackagePath = Join-Path $StagedRoot 'package.json'
  $RuntimeCli = Join-Path $StagedRoot 'dist\src\cli\agent-bridge-runtime.js'
  $NodeModules = Join-Path $StagedRoot 'node_modules'
  $ServiceExe = Join-Path $StagedRoot 'packaging\windows\agent-bridge-service.exe'
  $TemplatePath = Join-Path $StagedRoot 'packaging\windows\agent-bridge-service.xml.template'

  foreach ($required in @($DescriptorPath, $PackagePath, $RuntimeCli, $ServiceExe, $TemplatePath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { Fail "Windows bundle is missing required file: $required" }
  }
  if (-not (Test-Path -LiteralPath $NodeModules -PathType Container)) { Fail 'Windows bundle is missing production dependencies.' }

  try { $descriptor = Get-Content -LiteralPath $DescriptorPath -Raw | ConvertFrom-Json } catch { Fail 'Windows release descriptor is invalid JSON.' }
  if ($descriptor.schemaVersion -ne 'kab.runtime-release.v1' -or
      $descriptor.technicalProductId -ne 'agent-bridge' -or
      [string]::IsNullOrWhiteSpace([string]$descriptor.packageVersion) -or
      ([string]$descriptor.artifactSha256) -notmatch '^[a-fA-F0-9]{64}$' -or
      ([string]$descriptor.sourceCommit) -notmatch '^[a-fA-F0-9]{40,64}$' -or
      @('stable','candidate') -notcontains [string]$descriptor.channel) {
    Fail 'Windows release descriptor is invalid.'
  }

  $ArtifactSha256 = ([string]$descriptor.artifactSha256).ToLowerInvariant()
  $ReleaseRoot = Join-Path $InstallRoot 'releases'
  $ReleaseDir = Join-Path $ReleaseRoot ("sha256-$ArtifactSha256")
  New-Item -ItemType Directory -Force -Path $ReleaseRoot, $ConfigRoot, $StateRoot, $LogRoot | Out-Null

  if (Test-Path -LiteralPath $ReleaseDir) {
    $ExistingDescriptor = Join-Path $ReleaseDir 'runtime-release.json'
    if (-not (Test-Path -LiteralPath $ExistingDescriptor -PathType Leaf)) { Fail "Existing release directory is malformed: $ReleaseDir" }
    if ((Get-Content -LiteralPath $ExistingDescriptor -Raw) -ne (Get-Content -LiteralPath $DescriptorPath -Raw)) {
      Fail 'Digest-bound release directory already exists with different metadata.'
    }
  } else {
    $TempRelease = Join-Path $ReleaseRoot (".install-sha256-$ArtifactSha256-" + [guid]::NewGuid().ToString('N'))
    Move-Item -LiteralPath $StagedRoot -Destination $TempRelease
    Move-Item -LiteralPath $TempRelease -Destination $ReleaseDir
  }

  $EnvFile = Join-Path $ConfigRoot 'agent-bridge.env'
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) {
    $EnvTemplate = Get-Content -LiteralPath (Join-Path $ReleaseDir 'packaging\windows\agent-bridge.env.example') -Raw
    $EscapedStateRoot = $StateRoot -replace '\$', '\\'
    $InitialEnv = [regex]::Replace(
      $EnvTemplate,
      '(?m)^KAB_STATE_DIR=.*$',
      "KAB_STATE_DIR=$EscapedStateRoot"
    )
    Set-Content -LiteralPath $EnvFile -Value $InitialEnv -Encoding utf8
  }

  if (-not $TestMode) {
    & icacls.exe $StateRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
    & icacls.exe $LogRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)M' | Out-Null
    & icacls.exe $ConfigRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-19:(OI)(CI)RX' | Out-Null
  }

  $CurrentPointer = Join-Path $InstallRoot 'current.txt'
  if (-not (Test-Path -LiteralPath $CurrentPointer -PathType Leaf)) {
    $tmp = "$CurrentPointer.tmp"
    Set-Content -LiteralPath $tmp -Value $ReleaseDir -NoNewline
    Move-Item -Force -LiteralPath $tmp -Destination $CurrentPointer
  }

  Write-Output "packageVersion=$($descriptor.packageVersion)"
  Write-Output "artifactSha256=$ArtifactSha256"
  Write-Output "sourceCommit=$(([string]$descriptor.sourceCommit).ToLowerInvariant())"
  Write-Output "channel=$($descriptor.channel)"
  Write-Output "releasePath=$ReleaseDir"
} finally {
  if (Test-Path -LiteralPath $TempRoot) { Remove-Item -LiteralPath $TempRoot -Recurse -Force }
}
