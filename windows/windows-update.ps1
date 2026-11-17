#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$MsiPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedHash,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
$updates = Join-Path $DataRoot 'updates'
$statusPath = Join-Path $updates 'status.json'
$pendingPath = Join-Path $updates 'pending.json'
$boardScript = Join-Path $InstallDir 'InOutBoard.ps1'
$exitCode = 0
New-Item -ItemType Directory -Path $updates -Force | Out-Null
function Set-UpdateStatus([string]$State, [string]$Message) {
  $data = @{ state=$State; message=$Message; version=$Version; updated_at=[DateTime]::UtcNow.ToString('o') }
  $json = $data | ConvertTo-Json
  [IO.File]::WriteAllText(($statusPath + '.tmp'), $json, (New-Object Text.UTF8Encoding($false)))
  Move-Item ($statusPath + '.tmp') $statusPath -Force
}
try {
  if ((Get-FileHash $MsiPath -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Installer checksum verification failed.' }
  Set-UpdateStatus 'backing_up' 'Backing up the database and uploaded pictures before updating.'
  $global:LASTEXITCODE = 0
  & $boardScript -Action Backup -DataRoot $DataRoot
  if ($LASTEXITCODE -ne 0) { throw 'Backup failed; update cancelled.' }
  # Keep a recovery copy of settings and TLS keys alongside the pre-update data backup.
  $snapshot = Join-Path $updates ('configuration-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $snapshot -Force | Out-Null
  Copy-Item (Join-Path $DataRoot 'inout-board.env') $snapshot
  if (Test-Path (Join-Path $DataRoot 'tls')) { Copy-Item (Join-Path $DataRoot 'tls') $snapshot -Recurse }
  Set-UpdateStatus 'installing' 'Installing the update. The board will be unavailable briefly.'
  & $boardScript -Action Stop -DataRoot $DataRoot
  $log = Join-Path $updates 'installer.log'
  $p = Start-Process msiexec.exe -ArgumentList ('/i "{0}" /qn /norestart /l*v "{1}"' -f $MsiPath, $log) -Wait -PassThru
  if ($p.ExitCode -ne 0 -and $p.ExitCode -ne 3010) { throw "Windows Installer failed (exit $($p.ExitCode)). See updates\installer.log." }
  $installed = Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json
  if ($installed.version -ne $Version) { throw "The installed version is $($installed.version), expected $Version." }
  $portLine = Get-Content (Join-Path $DataRoot 'inout-board.env') | Where-Object { $_ -match '^PORT=(\d+)\s*$' } | Select-Object -Last 1
  $port = 8443
  if ($portLine -match '^PORT=(\d+)\s*$') { $port = [int]$Matches[1] }
  $healthy = $false
  for ($i = 0; $i -lt 20; $i++) {
    $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
    $code = & $curl -k -s -o NUL -m 3 -w '%{http_code}' "https://127.0.0.1:$port/api/health" 2>$null
    if ($code -eq '200') { $healthy = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { throw 'The new version installed but HTTPS did not start. See logs\app.log.' }
  Set-UpdateStatus 'complete' 'Update installed. Reload the page to use the new version.'
  Remove-Item $MsiPath -Force -ErrorAction SilentlyContinue
} catch {
  $exitCode = 1
  Set-UpdateStatus 'error' $_.Exception.Message
  # MSI rolls back failed transactions. Try to bring the installed board back online.
  try { & $boardScript -Action Start -DataRoot $DataRoot } catch { }
} finally {
  Remove-Item $pendingPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
