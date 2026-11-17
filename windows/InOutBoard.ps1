#Requires -Version 5.1
<#
.SYNOPSIS
  Installs, runs, backs up and removes the IN/OUT Board on Windows.

.DESCRIPTION
  Shipped inside the MSI / Setup EXE and run by it, but safe to run by hand
  from an elevated PowerShell:

    .\InOutBoard.ps1 -Action Status       # what is running, URLs, CA file
    .\InOutBoard.ps1 -Action Addresses    # URLs for every address on this PC
    .\InOutBoard.ps1 -Action Backup       # one backup now
    .\InOutBoard.ps1 -Action Restart      # after editing inout-board.env

  Layout
    <install dir>\            program files (replaced on upgrade)
    C:\ProgramData\InOutBoard\
        inout-board.env       settings (kept on upgrade and uninstall)
        data\                 inout.sqlite + uploads\   (kept)
        backups\              nightly backups            (kept)
        logs\                 app.log, tls.log, install.log
        caddy\                TLS front-end state and the local CA
        Caddyfile             regenerated at every start from the live IPs

  The app listens only on 127.0.0.1 (private). Caddy terminates HTTPS on all
  addresses of this PC and forwards to it, so the internal port is never
  exposed.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Remove', 'Stop', 'Start', 'Restart', 'RunApp', 'RunTls', 'Backup', 'Status', 'Addresses')]
  [string]$Action,
  [int]$TlsPort = 8443,
  [int]$AppPort = 3000,
  [string]$ExtraAddresses = '',
  [string]$DataRoot = (Join-Path $env:ProgramData 'InOutBoard')
)

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $PSCommandPath
$Node       = Join-Path $InstallDir 'node.exe'
$Caddy      = Join-Path $InstallDir 'caddy.exe'
$DataDir    = Join-Path $DataRoot 'data'
$BackupDir  = Join-Path $DataRoot 'backups'
$LogDir     = Join-Path $DataRoot 'logs'
$CaddyDir   = Join-Path $DataRoot 'caddy'
$EnvFile    = Join-Path $DataRoot 'inout-board.env'
$Caddyfile  = Join-Path $DataRoot 'Caddyfile'
$CaCopy     = Join-Path $DataRoot 'InOutBoard-Local-CA.crt'

$TaskApp    = 'IN-OUT Board'
$TaskTls    = 'IN-OUT Board HTTPS'
$TaskBackup = 'IN-OUT Board Backup'
$FirewallRule = 'IN/OUT Board HTTPS'

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

function Write-Log([string]$Message, [string]$File = 'install.log') {
  $line = '{0} {1}' -f (Get-Date -Format 's'), $Message
  Write-Host $line
  try {
    if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
    Add-Content -Path (Join-Path $LogDir $File) -Value $line -Encoding UTF8
  } catch { }
}

function Read-EnvFile {
  $map = @{}
  if (Test-Path $EnvFile) {
    foreach ($line in Get-Content $EnvFile) {
      if ($line -match '^\s*#') { continue }
      if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $key = $Matches[1]
        $v = $Matches[2]
        if ($v -match '^(["''])(.*)\1$') { $v = $Matches[2] }
        $map[$key] = $v
      }
    }
  }
  return $map
}

function Get-Setting([hashtable]$Cfg, [string]$Name, $Default) {
  if ($Cfg.ContainsKey($Name) -and $Cfg[$Name] -ne '') { return $Cfg[$Name] }
  return $Default
}

function Protect-DataRoot {
  # Only SYSTEM and local Administrators may read the database and settings.
  # Well-known SIDs, so this works on any Windows language.
  & icacls.exe $DataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
}

function Rotate-Log([string]$Path, [int]$MaxMB = 10) {
  if ((Test-Path $Path) -and ((Get-Item $Path).Length -gt ($MaxMB * 1MB))) {
    Move-Item -Path $Path -Destination ($Path + '.1') -Force
  }
}

# Run a program with stdout+stderr appended to a log file. cmd.exe does the
# redirect, which is the most reliable way to capture both in Windows PowerShell.
function Invoke-Logged([string]$Exe, [string]$ArgString, [string]$LogPath, [string]$WorkDir) {
  Rotate-Log $LogPath
  $inner = '"{0}" {1} >> "{2}" 2>&1' -f $Exe, $ArgString, $LogPath
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
  $psi.Arguments = '/d /s /c "' + $inner + '"'
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $p.WaitForExit()
  return $p.ExitCode
}

function Stop-OurProcesses {
  foreach ($exe in @($Node, $Caddy)) {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $exe) } |
      ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
  }
}

function Stop-Board {
  foreach ($t in @($TaskApp, $TaskTls)) {
    try { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue } catch { }
  }
  Start-Sleep -Milliseconds 500
  Stop-OurProcesses
}

function Register-BoardTask([string]$Name, [string]$ActionName, $Trigger, [string]$Description) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Action {1} -DataRoot "{2}"' -f $PSCommandPath, $ActionName, $DataRoot
  $act = New-ScheduledTaskAction -Execute $ps -Argument $arg -WorkingDirectory $InstallDir
  $pri = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
           -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew `
           -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $Name -Action $act -Trigger $Trigger -Principal $pri -Settings $set `
    -Description $Description -Force | Out-Null
}

function Wait-Healthy([int]$Port, [int]$Seconds = 40) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $r = Invoke-WebRequest -Uri ("http://127.0.0.1:{0}/api/health" -f $Port) -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { return $true }
    } catch { }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Get-Addresses {
  # Asks the app's own discovery code, so the installer and the app agree.
  $cfg = Read-EnvFile
  $env:PREFERRED_ADDRESS = Get-Setting $cfg 'PREFERRED_ADDRESS' ''
  $json = & $Node (Join-Path $InstallDir 'scripts\netinfo.js') 2>$null
  if (-not $json) { return @{ preferred = $null; addresses = @() } }
  return ($json | Out-String | ConvertFrom-Json)
}

function Write-Caddyfile {
  $cfg = Read-EnvFile
  $tls = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
  $app = [int](Get-Setting $cfg 'PORT' $AppPort)
  $extra = Get-Setting $cfg 'EXTRA_ADDRESSES' ''
  $certFile = Get-Setting $cfg 'TLS_CERT_FILE' ''
  $keyFile  = Get-Setting $cfg 'TLS_KEY_FILE' ''

  $hosts = New-Object System.Collections.Generic.List[string]
  foreach ($h in @('localhost', '127.0.0.1')) { $hosts.Add($h) }
  $info = Get-Addresses
  foreach ($a in $info.addresses) { if ($a.family -eq 'IPv4') { $hosts.Add([string]$a.address) } }
  foreach ($e in ($extra -split '[,; ]+')) { if ($e) { $hosts.Add($e.Trim()) } }
  $sites = ($hosts | Select-Object -Unique | ForEach-Object { 'https://{0}:{1}' -f $_, $tls }) -join ', '

  if ($certFile -and $keyFile -and (Test-Path $certFile) -and (Test-Path $keyFile)) {
    $tlsLine = 'tls "{0}" "{1}"' -f ($certFile -replace '\\', '/'), ($keyFile -replace '\\', '/')
  } else {
    $tlsLine = 'tls internal'
  }

  $text = @"
# Generated by InOutBoard.ps1 at every start. Edit inout-board.env, not this file.
{
	admin off
	auto_https disable_redirects
	local_certs
}

$sites {
	$tlsLine
	encode gzip
	reverse_proxy 127.0.0.1:$app
}
"@
  Set-Content -Path $Caddyfile -Value $text -Encoding ASCII
}

function Publish-LocalCa {
  # Caddy creates its private CA the first time it serves an IP. Copy the public
  # certificate to a stable place so it can be handed to client devices.
  $src = Join-Path $CaddyDir 'caddy\pki\authorities\local\root.crt'
  for ($i = 0; $i -lt 30 -and -not (Test-Path $src); $i++) { Start-Sleep -Seconds 1 }
  if (Test-Path $src) { Copy-Item $src $CaCopy -Force; return $true }
  return $false
}

function Show-Urls {
  $cfg = Read-EnvFile
  $tls = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
  $info = Get-Addresses
  Write-Host ''
  Write-Host 'Open the board at:'
  foreach ($a in $info.addresses) {
    if ($a.family -ne 'IPv4') { continue }
    $suffix = ''
    if ($a.address -eq $info.preferred) { $suffix = '   <- preferred' }
    $port = ''
    if ($tls -ne 443) { $port = ':' + $tls }
    Write-Host ('  https://{0}{1}/        admin: https://{0}{1}/admin{2}' -f $a.address, $port, $suffix)
  }
}

# --------------------------------------------------------------------------
# actions
# --------------------------------------------------------------------------

switch ($Action) {

  'Install' {
    foreach ($d in @($DataRoot, $DataDir, $BackupDir, $LogDir, $CaddyDir)) {
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    Write-Log "Installing from $InstallDir (data in $DataRoot)"
    Protect-DataRoot

    if (-not (Test-Path $EnvFile)) {
      $envText = @"
# IN/OUT Board settings. Lines starting with # are ignored.
# After editing, apply with:  InOutBoard.ps1 -Action Restart   (or reboot).

# The app listens only on this private address; HTTPS is added in front of it.
HOST=127.0.0.1
PORT=$AppPort
DATA_DIR=$DataDir
TRUST_PROXY=1
COOKIE_SECURE=1

# HTTPS port that people use (https://<ip>:<port>/). 443 gives https://<ip>/
TLS_PORT=$TlsPort
PUBLIC_SCHEME=https
PUBLIC_PORT=$TlsPort

# Extra addresses to serve HTTPS on, comma separated (for example the public
# WAN address that the router forwards to this PC).
EXTRA_ADDRESSES=$ExtraAddresses

# Which address is shown first in links. Leave empty to use the active route.
PREFERRED_ADDRESS=

# Optional: use your own certificate instead of the built-in private CA.
# TLS_CERT_FILE=C:\ProgramData\InOutBoard\certs\board.crt
# TLS_KEY_FILE=C:\ProgramData\InOutBoard\certs\board.key

# First admin account. Used ONLY on the very first start. If the password is
# left empty a random one is printed once in logs\app.log
ADMIN_USER=admin
ADMIN_PASSWORD=
"@
      Set-Content -Path $EnvFile -Value $envText -Encoding ASCII
      Write-Log "Wrote default settings to $EnvFile"
    } else {
      Write-Log "Kept existing settings in $EnvFile"
    }

    Stop-Board
    $cfg = Read-EnvFile
    $tls = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
    $app = [int](Get-Setting $cfg 'PORT' $AppPort)

    $boot = New-ScheduledTaskTrigger -AtStartup
    Register-BoardTask $TaskApp 'RunApp' $boot 'IN/OUT Board application (private, 127.0.0.1)'
    Register-BoardTask $TaskTls 'RunTls' $boot 'IN/OUT Board HTTPS front end'
    $nightly = New-ScheduledTaskTrigger -Daily -At '02:15'
    Register-BoardTask $TaskBackup 'Backup' $nightly 'Nightly IN/OUT Board backup (keeps 14)'

    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $tls -Program $Caddy -Profile Any | Out-Null
    Write-Log "Firewall: allowed inbound TCP $tls for caddy.exe only (app port $app stays private)"

    Start-ScheduledTask -TaskName $TaskApp
    Start-ScheduledTask -TaskName $TaskTls

    if (Wait-Healthy $app) {
      Write-Log "App is healthy on 127.0.0.1:$app"
    } else {
      Write-Log "WARNING: app did not answer within 40 s. See $LogDir\app.log"
    }
    if (Publish-LocalCa) { Write-Log "Local CA certificate for client devices: $CaCopy" }
    else { Write-Log "Local CA certificate not created yet; check $LogDir\tls.log" }
    Show-Urls
  }

  'Remove' {
    Write-Log 'Removing tasks and firewall rule (data is kept)'
    Stop-Board
    foreach ($t in @($TaskApp, $TaskTls, $TaskBackup)) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    Write-Log "Done. Your data remains in $DataRoot"
  }

  'Stop'    { Stop-Board; Write-Log 'Stopped' }
  'Start'   {
    Start-ScheduledTask -TaskName $TaskApp
    Start-ScheduledTask -TaskName $TaskTls
    Write-Log 'Started'
  }
  'Restart' {
    Stop-Board
    Start-ScheduledTask -TaskName $TaskApp
    Start-ScheduledTask -TaskName $TaskTls
    Write-Log 'Restarted'
  }

  'RunApp' {
    # Supervisor loop: if node ever exits, start it again after a short pause.
    Stop-OurProcesses
    $cfg = Read-EnvFile
    $env:INOUT_ENV_FILE = $EnvFile
    $log = Join-Path $LogDir 'app.log'
    while ($true) {
      Write-Log 'Starting app' 'app.log'
      $code = Invoke-Logged $Node ('--disable-warning=ExperimentalWarning "{0}"' -f (Join-Path $InstallDir 'server.js')) $log $InstallDir
      Write-Log "App exited with code $code; restarting in 5 s" 'app.log'
      Start-Sleep -Seconds 5
    }
  }

  'RunTls' {
    $env:XDG_DATA_HOME   = $CaddyDir
    $env:XDG_CONFIG_HOME = $CaddyDir
    $log = Join-Path $LogDir 'tls.log'
    while ($true) {
      # Re-discover addresses on every start so a changed IP is picked up.
      Write-Caddyfile
      Write-Log 'Starting HTTPS front end' 'tls.log'
      $code = Invoke-Logged $Caddy ('run --config "{0}" --adapter caddyfile' -f $Caddyfile) $log $InstallDir
      Write-Log "Caddy exited with code $code; restarting in 5 s" 'tls.log'
      Start-Sleep -Seconds 5
    }
  }

  'Backup' {
    $env:DATA_DIR = $DataDir
    $env:KEEP = '14'
    $code = Invoke-Logged $Node ('--disable-warning=ExperimentalWarning "{0}" "{1}"' -f (Join-Path $InstallDir 'scripts\backup.js'), $BackupDir) (Join-Path $LogDir 'backup.log') $InstallDir
    Write-Log "Backup finished with code $code (see $LogDir\backup.log)"
    if ($code -ne 0) { exit $code }
  }

  'Addresses' { Show-Urls }

  'Status' {
    $cfg = Read-EnvFile
    $app = [int](Get-Setting $cfg 'PORT' $AppPort)
    foreach ($t in @($TaskApp, $TaskTls, $TaskBackup)) {
      $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
      if ($task) { Write-Host ('{0,-26} {1}' -f $t, $task.State) } else { Write-Host ('{0,-26} not installed' -f $t) }
    }
    if (Wait-Healthy $app 3) { Write-Host "App health: OK (127.0.0.1:$app)" } else { Write-Host "App health: NOT answering on 127.0.0.1:$app" }
    Show-Urls
    if (Test-Path $CaCopy) { Write-Host "`nClient CA certificate: $CaCopy" }
    Write-Host "Settings: $EnvFile"
    Write-Host "Logs:     $LogDir"
  }
}
