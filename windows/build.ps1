#Requires -Version 5.1
<#
.SYNOPSIS
  Builds dist\InOutBoard-<version>-x64.msi and dist\InOutBoard-Setup-<version>-x64.exe.

.DESCRIPTION
  Run on Windows (the GitHub Actions workflow does this on windows-latest):

    powershell -File windows\build.ps1 -Version 1.0.0

  It downloads the official Node.js 22 and Caddy Windows builds, verifies each
  against the checksum file published next to it, stages the app, then runs WiX.
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

function Get-Verified([string]$Url, [string]$ExpectedSha256, [string]$OutFile) {
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -Path $OutFile).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "Checksum mismatch for $Url`n expected $ExpectedSha256`n actual   $actual"
  }
  Write-Host "  sha256 ok ($actual)"
}

# ---- Node.js 22 (latest 22.x, which has built-in SQLite) -------------------
$nodeBase = 'https://nodejs.org/dist/latest-v22.x'
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

# ---- Caddy (latest release) -------------------------------------------------
$hdr = @{ 'User-Agent' = 'inout-board-build'; 'Accept' = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $hdr['Authorization'] = "Bearer $($env:GITHUB_TOKEN)" }
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/caddyserver/caddy/releases/latest' -Headers $hdr
$cv = $rel.tag_name.TrimStart('v')
$zipAsset = $rel.assets | Where-Object { $_.name -eq "caddy_${cv}_windows_amd64.zip" }
$sumAsset = $rel.assets | Where-Object { $_.name -eq "caddy_${cv}_checksums.txt" }
if (-not $zipAsset -or -not $sumAsset) { throw "Caddy $cv assets not found" }
$caddySums = (Invoke-WebRequest -Uri $sumAsset.browser_download_url -UseBasicParsing).Content -split "`n"
$caddyLine = $caddySums | Where-Object { $_ -match [regex]::Escape($zipAsset.name) + '\s*$' } | Select-Object -First 1
if (-not $caddyLine) { throw 'Caddy checksum line not found' }
$caddyHash = ($caddyLine.Trim() -split '\s+')[0]
$caddyZip = Join-Path $Dl $zipAsset.name
Get-Verified $zipAsset.browser_download_url $caddyHash $caddyZip
Expand-Archive -Path $caddyZip -DestinationPath (Join-Path $Dl 'caddy') -Force
Copy-Item (Join-Path $Dl 'caddy\caddy.exe') $Stage
if (Test-Path (Join-Path $Dl 'caddy\LICENSE')) { Copy-Item (Join-Path $Dl 'caddy\LICENSE') (Join-Path $Stage 'CADDY-LICENSE.txt') }
& (Join-Path $Stage 'caddy.exe') version

# ---- the app itself ---------------------------------------------------------
Copy-Item (Join-Path $Root 'server.js'), (Join-Path $Root 'package.json') $Stage
foreach ($d in @('public', 'scripts')) { Copy-Item (Join-Path $Root $d) (Join-Path $Stage $d) -Recurse }
# assets/ is deliberately NOT shipped: it holds the original office board photo.
New-Item -ItemType Directory -Force -Path (Join-Path $Stage 'assets') | Out-Null
Set-Content -Path (Join-Path $Stage 'assets\README.txt') -Value 'Reserved for static files.' -Encoding ASCII
Copy-Item (Join-Path $Root 'windows\InOutBoard.ps1') $Stage
Copy-Item (Join-Path $Root 'windows\README-WINDOWS.txt') (Join-Path $Stage 'README-WINDOWS.txt')
# never ship demo screenshots scripts or dev-only helpers that need Playwright
Remove-Item (Join-Path $Stage 'scripts\screenshots.js'), (Join-Path $Stage 'scripts\build-pages.js') -ErrorAction SilentlyContinue

# ---- WiX ---------------------------------------------------------------------
$msi = Join-Path $Dist "InOutBoard-$Version-x64.msi"
$exe = Join-Path $Dist "InOutBoard-Setup-$Version-x64.exe"

& wix build (Join-Path $Root 'windows\Package.wxs') -arch x64 -d "Version=$Version" -d "StageDir=$Stage" -o $msi
if ($LASTEXITCODE -ne 0) { throw 'wix build (MSI) failed' }

& wix build (Join-Path $Root 'windows\Bundle.wxs') -arch x64 -ext WixToolset.BootstrapperApplications.wixext `
    -d "Version=$Version" -d "MsiPath=$msi" -o $exe
if ($LASTEXITCODE -ne 0) { throw 'wix build (EXE) failed' }

Get-ChildItem $Dist | ForEach-Object {
  $h = (Get-FileHash -Algorithm SHA256 $_.FullName).Hash.ToLowerInvariant()
  '{0}  {1}' -f $h, $_.Name
} | Set-Content (Join-Path $Dist 'SHA256SUMS.txt') -Encoding ASCII
Get-ChildItem $Dist | Format-Table Name, Length -AutoSize
