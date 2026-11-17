#Requires -Version 5.1
<#
.SYNOPSIS
  Installs, runs, backs up and removes the IN/OUT Board on Windows.

.DESCRIPTION
  Shipped inside the MSI / Setup EXE and run by it, but safe to run by hand
  from an elevated PowerShell:

    .\InOutBoard.ps1 -Action Status       # health, listeners, firewall, URLs (works without admin too)
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

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

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

# Start a program with stdout+stderr appended to a log file and return the
# process. cmd.exe does the redirect, which is the most reliable way to capture
# both in Windows PowerShell.
function Start-Logged([string]$Exe, [string]$ArgString, [string]$LogPath, [string]$WorkDir) {
  Rotate-Log $LogPath
  $inner = '"{0}" {1} >> "{2}" 2>&1' -f $Exe, $ArgString, $LogPath
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "$env:SystemRoot\System32\cmd.exe"
  $psi.Arguments = '/d /s /c "' + $inner + '"'
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  return [System.Diagnostics.Process]::Start($psi)
}

function Invoke-Logged([string]$Exe, [string]$ArgString, [string]$LogPath, [string]$WorkDir) {
  $p = Start-Logged $Exe $ArgString $LogPath $WorkDir
  $p.WaitForExit()
  return $p.ExitCode
}

function Stop-ByPath([string]$Exe) {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and ($_.ExecutablePath -ieq $Exe) } |
    ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch { } }
}

function Stop-OurProcesses {
  Stop-ByPath $Node
  Stop-ByPath $Caddy
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

# HTTPS check that ignores certificate trust (we only want to know it answers).
# curl.exe ships with Windows 10 1803 and later.
function Test-Https([string]$Address, [int]$Port) {
  $curl = Join-Path $env:SystemRoot 'System32\curl.exe'
  if (-not (Test-Path $curl)) { return $null }
  $h = $Address
  if ($Address -match ':') { $h = "[$Address]" }
  $code = & $curl -k -s -o NUL -m 5 -w '%{http_code}' ("https://{0}:{1}/api/health" -f $h, $Port) 2>$null
  return ($code -eq '200')
}

function Wait-Https([string]$Address, [int]$Port, [int]$Seconds = 40) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $r = Test-Https $Address $Port
    if ($r -eq $null) { return $null }
    if ($r) { return $true }
    Start-Sleep -Seconds 2
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

function Get-Ipv4List {
  $info = Get-Addresses
  return @($info.addresses | Where-Object { $_.family -eq 'IPv4' } | ForEach-Object { [string]$_.address })
}

# A short string that changes when this PC's IPv4 addresses (or the extra
# addresses in the settings file) change; the HTTPS front end restarts then.
function Get-AddressSignature {
  $cfg = Read-EnvFile
  return ((Get-Ipv4List) -join ',') + '|' + (Get-Setting $cfg 'EXTRA_ADDRESSES' '')
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
  foreach ($ip in (Get-Ipv4List)) { $hosts.Add($ip) }
  foreach ($e in ($extra -split '[,; ]+')) { if ($e) { $hosts.Add($e.Trim()) } }
  $sites = ($hosts | Select-Object -Unique | ForEach-Object { 'https://{0}:{1}' -f $_, $tls }) -join ', '

  if ($certFile -and $keyFile -and (Test-Path $certFile) -and (Test-Path $keyFile)) {
    $tlsLine = 'tls "{0}" "{1}"' -f ($certFile -replace '\\', '/'), ($keyFile -replace '\\', '/')
  } else {
    $tlsLine = 'tls internal'
  }
  $caRoot = $DataRoot -replace '\\', '/'

  # skip_install_trust: this script trusts the CA itself (machine-wide), so Caddy must not try.
  # protocols h1 h2: no HTTP/3 (UDP) listener, so only the one TCP port needs to be open.
  $text = @"
# Generated by InOutBoard.ps1 at every start. Edit inout-board.env, not this file.
{
	admin off
	auto_https disable_redirects
	local_certs
	skip_install_trust
	servers {
		protocols h1 h2
	}
}

$sites {
	$tlsLine
	encode gzip

	# Public certificate of the private CA, so other devices can download and trust it.
	handle /ca.crt {
		root * "$caRoot"
		rewrite * /InOutBoard-Local-CA.crt
		header Content-Type application/x-x509-ca-cert
		header Content-Disposition "attachment; filename=InOutBoard-Local-CA.crt"
		file_server
	}

	handle {
		reverse_proxy 127.0.0.1:$app
	}
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

function Open-RootStore {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store -ArgumentList 'Root', 'LocalMachine'
  $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
  return $store
}

# Trust the board's CA on this PC so Chrome and Edge show a normal padlock here.
# (Other devices install it themselves from https://<ip>:<port>/ca.crt.)
function Add-CaTrust {
  if (-not (Test-Path $CaCopy)) { return $false }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $CaCopy
  $store = Open-RootStore
  try { $store.Add($cert) } finally { $store.Close() }
  return $true
}

function Remove-CaTrust {
  if (-not (Test-Path $CaCopy)) { return }
  $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $CaCopy
  $store = Open-RootStore
  try {
    $found = $store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, $cert.Thumbprint, $false)
    if ($found.Count -gt 0) { $store.RemoveRange($found) }
  } finally { $store.Close() }
}

function Show-Urls {
  $cfg = Read-EnvFile
  $tls = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
  $info = Get-Addresses
  $port = ''
  if ($tls -ne 443) { $port = ':' + $tls }
  Write-Host ''
  Write-Host 'Open the board at:'
  foreach ($a in $info.addresses) {
    if ($a.family -ne 'IPv4') { continue }
    $suffix = ''
    if ($a.address -eq $info.preferred) { $suffix = '   <- preferred' }
    Write-Host ('  https://{0}{1}/        admin: https://{0}{1}/admin{2}' -f $a.address, $port, $suffix)
  }
  $first = $info.preferred
  if ($first) {
    Write-Host ''
    Write-Host ('Other devices: open https://{0}{1}/ca.crt once to download the certificate, install it as a trusted' -f $first, $port)
    Write-Host 'root, then open the board. (This PC already trusts it.)'
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

# First admin account. Used ONLY on the very first start.
# Sign in as admin / admin; you are required to choose a new password immediately.
ADMIN_USER=admin
ADMIN_PASSWORD=admin
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

    # Open the HTTPS port by number on every network profile (Domain, Private and
    # Public). Windows often labels home and office Wi-Fi as "Public", and a rule
    # that only covers Private networks silently blocks other devices.
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $tls -Profile Any -Enabled True | Out-Null
    Write-Log "Firewall: allowed inbound TCP $tls on all network profiles (app port $app stays private)"

    Start-ScheduledTask -TaskName $TaskApp
    Start-ScheduledTask -TaskName $TaskTls

    if (Wait-Healthy $app) {
      Write-Log "App is healthy on 127.0.0.1:$app"
    } else {
      Write-Log "WARNING: app did not answer within 40 s. See $LogDir\app.log"
    }

    if (Publish-LocalCa) {
      Write-Log "Local CA certificate: $CaCopy"
      if (Add-CaTrust) { Write-Log 'Local CA is now trusted on this PC (Trusted Root Certification Authorities).' }
    } else {
      Write-Log "WARNING: local CA certificate not created yet; check $LogDir\tls.log"
    }

    # Prove HTTPS answers on every address of this PC, not just loopback.
    foreach ($ip in (@('127.0.0.1') + (Get-Ipv4List))) {
      $ok = Wait-Https $ip $tls 40
      if ($ok -eq $true) { Write-Log "HTTPS answers on ${ip}:$tls" }
      elseif ($ok -eq $false) { Write-Log "WARNING: HTTPS did not answer on ${ip}:$tls. See $LogDir\tls.log" }
    }
    Show-Urls
  }

  'Remove' {
    Write-Log 'Removing tasks, firewall rule and CA trust (data is kept)'
    Stop-Board
    foreach ($t in @($TaskApp, $TaskTls, $TaskBackup)) {
      Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
    }
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    try { Remove-CaTrust } catch { Write-Log "Could not remove CA trust: $($_.Exception.Message)" }
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
      $signature = Get-AddressSignature
      Write-Log "Starting HTTPS front end for: $signature" 'tls.log'
      $p = Start-Logged $Caddy ('run --config "{0}" --adapter caddyfile' -f $Caddyfile) $log $InstallDir
      # While it runs, watch for the PC's address changing (DHCP renewal, Wi-Fi/Ethernet switch,
      # VPN). A new address needs a new certificate, so restart Caddy when that happens.
      while (-not $p.HasExited) {
        Start-Sleep -Seconds 30
        if ($p.HasExited) { break }
        $now = Get-AddressSignature
        if ($now -ne $signature) {
          Write-Log "Addresses changed ($signature -> $now); restarting HTTPS front end" 'tls.log'
          Stop-ByPath $Caddy
          break
        }
      }
      $p.WaitForExit()
      Write-Log 'HTTPS front end stopped; restarting in 5 s' 'tls.log'
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
    $tls = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
    $admin = Test-Admin

    Write-Host 'IN/OUT Board status'
    Write-Host '-------------------'

    if ($admin) {
      foreach ($t in @($TaskApp, $TaskTls, $TaskBackup)) {
        $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($task) { Write-Host ('{0,-26} {1}' -f $t, $task.State) } else { Write-Host ('{0,-26} NOT INSTALLED' -f $t) }
      }
    } else {
      Write-Host 'Scheduled tasks and firewall rules can only be read from an elevated PowerShell'
      Write-Host '(right-click PowerShell, Run as administrator). Checking what can be seen without it:'
    }

    # What is actually listening. This works without administrator rights.
    $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @($app, $tls) })
    foreach ($port in @($app, $tls)) {
      $rows = @($listen | Where-Object { $_.LocalPort -eq $port })
      if ($rows.Count -eq 0) { Write-Host ('Port {0,-5} NOT LISTENING' -f $port) }
      else { Write-Host ('Port {0,-5} listening on {1}' -f $port, ((($rows | ForEach-Object { $_.LocalAddress }) | Select-Object -Unique) -join ', ')) }
    }
    $appRows = @($listen | Where-Object { $_.LocalPort -eq $app -and $_.LocalAddress -notin @('127.0.0.1', '::1') })
    if ($appRows.Count -gt 0) { Write-Host "  WARNING: the app port $app is reachable beyond this PC; it should be 127.0.0.1 only." }

    if (Wait-Healthy $app 3) { Write-Host "App health      OK (127.0.0.1:$app)" } else { Write-Host "App health      NOT answering on 127.0.0.1:$app" }

    # HTTPS on every address of this PC. Passing here proves the service works; it
    # does NOT prove the firewall lets other devices in (traffic to your own IP
    # never goes through the firewall).
    foreach ($ip in (Get-Ipv4List)) {
      $r = Test-Https $ip $tls
      if ($r -eq $true) { Write-Host ("HTTPS on {0,-15} OK" -f $ip) } elseif ($r -eq $false) { Write-Host ("HTTPS on {0,-15} NOT answering" -f $ip) }
    }

    if ($admin) {
      $rule = Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue
      if ($rule) {
        $pf = $rule | Get-NetFirewallPortFilter
        Write-Host ('Firewall rule   "{0}": enabled={1} action={2} profiles={3} port={4}' -f $FirewallRule, $rule.Enabled, $rule.Action, $rule.Profile, $pf.LocalPort)
      } else {
        Write-Host ('Firewall rule   "{0}" MISSING. Other devices will be blocked. Re-run: InOutBoard.ps1 -Action Install' -f $FirewallRule)
      }
    }

    try {
      foreach ($c in (Get-NetConnectionProfile -ErrorAction Stop)) {
        Write-Host ('Network         {0}: {1} ({2})' -f $c.Name, $c.NetworkCategory, $c.InterfaceAlias)
      }
    } catch { }

    Show-Urls
    if (Test-Path $CaCopy) { Write-Host "`nCertificate authority file (admins only): $CaCopy" }
    Write-Host "Settings: $EnvFile"
    Write-Host "Logs:     $LogDir"
    Write-Host ''
    Write-Host 'If another device cannot connect but this PC can, the cause is almost always outside this PC:'
    Write-Host '  - the router has "AP / client isolation" or a separate guest network turned on'
    Write-Host '  - the other device is on a different subnet or VPN'
    Write-Host '  - a third-party antivirus firewall is in use'
    Write-Host '  Test from the other device:  open https://<this-PC-IP>:<port>/api/health  (a certificate warning is expected before the CA is installed).'
  }
}
