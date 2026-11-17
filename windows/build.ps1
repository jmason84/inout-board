#Requires -Version 5.1
<#
.SYNOPSIS
  Builds dist\InOutBoard-<version>-x64.msi and dist\InOutBoard-Setup-<version>-x64.exe.

.DESCRIPTION
  Run on Windows (the GitHub Actions workflow does this on windows-latest):

    powershell -File windows\build.ps1 -Version 1.0.0

  It downloads the official Node.js 22 Windows build, verifies it against the
  checksum file published next to it, stages the app, then runs WiX. Nothing
  else is bundled: HTTPS is served by the app itself.
  Set NODE_VERSION (for example 22.12.0) to pin an exact Node release; otherwise
  the newest 22.x is used.
  Needs the WiX CLI:  dotnet tool install --global wix --version 5.0.2
                      wix extension add -g WixToolset.BootstrapperApplications.wixext/5.0.2
#>
param(
  [string]$Version = '1.0.0',
  [string]$OutDir = 'dist'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root  = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Work  = Join-Path $Root 'build\windows'
$Stage = Join-Path $Work 'stage'
$Dl    = Join-Path $Work 'download'
$Dist  = Join-Path $Root $OutDir

if ($Version -notmatch '^\d+\.\d+\.\d+(\.\d+)?$') { throw "Version must look like 1.2.3, got '$Version'" }

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $Stage, $Dl, $Dist | Out-Null

function Get-Verified([string]$Url, [string]$ExpectedHash, [string]$OutFile) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  # The publisher's checksum file decides the algorithm: 64 hex = SHA-256, 128 = SHA-512.
  $alg = switch ($ExpectedHash.Length) { 64 { 'SHA256' } 128 { 'SHA512' } default { throw "Unexpected checksum length for $Url" } }
  $actual = (Get-FileHash -Algorithm $alg -Path $OutFile).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedHash.ToLowerInvariant()) {
    throw "Checksum mismatch for $Url`
 expected $ExpectedHash`
 actual   $actual"
  }
  Write-Host "  $alg ok ($actual)"
}

# ---- Node.js 22 (has built-in SQLite) ---------------------------------------
$nodeBase = 'https://nodejs.org/dist/latest-v22.x'
if ($env:NODE_VERSION) {
  if ($env:NODE_VERSION -notmatch '^22\.\d+\.\d+$') { throw "NODE_VERSION must look like 22.12.0, got '$($env:NODE_VERSION)'" }
  $nodeBase = "https://nodejs.org/dist/v$($env:NODE_VERSION)"
}
$sums = (Invoke-WebRequest -Uri "$nodeBase/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
$nodeLine = $sums | Where-Object { $_ -match 'node-v[\d.]+-win-x64\.zip\s*$' } | Select-Object -First 1
if (-not $nodeLine) { throw 'Could not find the Node.js win-x64 zip in SHASUMS256.txt' }
$nodeHash, $nodeFile = ($nodeLine.Trim() -split '\s+')
$nodeZip = Join-Path $Dl $nodeFile
Get-Verified "$nodeBase/$nodeFile" $nodeHash $nodeZip
Expand-Archive -Path $nodeZip -DestinationPath (Join-Path $Dl 'node') -Force
$nodeDir = Get-ChildItem (Join-Path $Dl 'node') -Directory | Select-Object -First 1
Copy-Item (Join-Path $nodeDir.FullName 'node.exe') $Stage
Copy-Item (Join-Path $nodeDir.FullName 'LICENSE') (Join-Path $Stage 'NODE-LICENSE.txt')
& (Join-Path $Stage 'node.exe') -e "require('node:sqlite'); console.log('node ' + process.version + ' with node:sqlite OK')"
if ($LASTEXITCODE -ne 0) { throw 'Bundled Node.js cannot load node:sqlite' }

# ---- the app itself ---------------------------------------------------------
Copy-Item (Join-Path $Root 'server.js'), (Join-Path $Root 'package.json') $Stage
# The update checker must report the installed build, not the source placeholder.
$packagePath = Join-Path $Stage 'package.json'
$package = Get-Content $packagePath -Raw | ConvertFrom-Json
$package.version = $Version
$json = $package | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($packagePath, $json, (New-Object Text.UTF8Encoding($false)))
foreach ($d in @('public', 'scripts')) { Copy-Item (Join-Path $Root $d) (Join-Path $Stage $d) -Recurse }
# assets/ is deliberately NOT shipped: it holds the original office board photo.
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'assets') | Out-Null
Set-Content -Path (Join-Path $Stage 'assets\README.txt') -Value 'Reserved for static files.' -Encoding ASCII
Copy-Item (Join-Path $Root 'windows\InOutBoard.ps1') $Stage
Copy-Item (Join-Path $Root 'windows\windows-update.ps1') $Stage
Copy-Item (Join-Path $Root 'windows\windows-launch-update.ps1') $Stage
Copy-Item (Join-Path $Root 'windows\README-WINDOWS.txt') (Join-Path $Stage 'README-WINDOWS.txt')
# never ship demo screenshots scripts or dev-only helpers that need Playwright
Remove-Item (Join-Path $Stage 'scripts\screenshots.js'), (Join-Path $Stage 'scripts\build-pages.js') -ErrorAction SilentlyContinue

# ---- WiX ---------------------------------------------------------------------
$msi = Join-Path $Dist "InOutBoard-$Version-x64.msi"
$exe = Join-Path $Dist "InOutBoard-Setup-$Version-x64.exe"

& wix build (Join-Path $Root 'windows\Package.wxs') -arch x64 -pdbtype none -d "Version=$Version" -d "StageDir=$Stage" -o $msi
if ($LASTEXITCODE -ne 0) { throw 'wix build (MSI) failed' }

& wix build (Join-Path $Root 'windows\Bundle.wxs') -arch x64 -pdbtype none -ext WixToolset.BootstrapperApplications.wixext `
    -d "Version=$Version" -d "MsiPath=$msi" -o $exe
if ($LASTEXITCODE -ne 0) { throw 'wix build (EXE) failed' }

# Only the two installers and their checksums are published.
Get-ChildItem $Dist -File | Where-Object { $_.Extension -notin '.msi', '.exe' -and $_.Name -ne 'SHA256SUMS.txt' } | Remove-Item -Force

$stageBytes = (Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum
'Staged payload (uncompressed): {0:N1} MB   node.exe: {1:N1} MB' -f ($stageBytes / 1MB), ((Get-Item (Join-Path $Stage 'node.exe')).Length / 1MB)

Get-ChildItem $Dist -File | Where-Object Name -ne 'SHA256SUMS.txt' | ForEach-Object {
  $h = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
  '{0}  {1}' -f $h, $_.Name
} | Set-Content (Join-Path $Dist 'SHA256SUMS.txt') -Encoding ASCII
Get-ChildItem $Dist | Format-Table Name, Length -AutoSize
