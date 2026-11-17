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
    .\InOutBoard.ps1 -Action ResetAdmin   # admin / admin again (asks for a new password at sign-in)

  Layout
    <install dir>\            program files (replaced on upgrade)
    C:\ProgramData\InOutBoard\
        inout-board.env       settings (kept on upgrade and uninstall)
        data\                 inout.sqlite + uploads\   (kept)
        backups\              nightly backups            (kept)
        logs\                 app.log, install.log
        tls\                  private CA + server certificate (re-issued when the IPs change)

  The app serves HTTPS itself on every address of this PC (one port, default
  8443). Its certificate is signed by a private CA created at first start; the
  CA certificate is downloadable at https://<ip>:<port>/ca.crt.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Install', 'Remove', 'Purge', 'Stop', 'Start', 'Restart', 'RunApp', 'RunTls', 'Backup', 'Status', 'Addresses', 'ResetAdmin')]
  [string]$Action,
  [int]$TlsPort = 8443,
  [string]$ExtraAddresses = '',
  [string]$DataRoot = (Join-Path $env:ProgramData 'InOutBoard')
)

$ErrorActionPreference = 'Stop'
$InstallDir = Split-Path -Parent $PSCommandPath
$Node       = Join-Path $InstallDir 'node.exe'
$Caddy      = Join-Path $InstallDir 'caddy.exe'   # only to clean up older installs
$DataDir    = Join-Path $DataRoot 'data'
$BackupDir  = Join-Path $DataRoot 'backups'
$LogDir     = Join-Path $DataRoot 'logs'
$TlsDir     = Join-Path $DataRoot 'tls'
$LegacyCaDir = Join-Path $DataRoot 'caddy\caddy\pki\authorities\local'   # from versions that used Caddy
$EnvFile    = Join-Path $DataRoot 'inout-board.env'
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

function Set-EnvValue([string]$Name, [string]$Value) {
  $lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch ('^\s*' + [regex]::Escape($Name) + '\s*=') })
  $lines += ('{0}={1}' -f $Name, $Value)
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
}

function Remove-EnvKey([string]$Name) {
  $lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch ('^\s*' + [regex]::Escape($Name) + '\s*=') })
  Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
}

# Settings from the Caddy-based versions (app on 127.0.0.1:3000 behind a proxy on TLS_PORT) are
# converted once: the app now serves HTTPS itself on that same public port.
function Convert-LegacyEnv {
  $cfg = Read-EnvFile
  if ((Get-Setting $cfg 'HTTPS' '') -ne '' -or (Get-Setting $cfg 'TLS_CERT' '') -ne '') { return }
  Copy-Item $EnvFile ($EnvFile + '.before-https-builtin') -Force
  $port = [int](Get-Setting $cfg 'TLS_PORT' $TlsPort)
  Set-EnvValue 'HOST' '0.0.0.0'
  Set-EnvValue 'PORT' ([string]$port)
  Set-EnvValue 'HTTPS' 'auto'
  Set-EnvValue 'TLS_DIR' $TlsDir
  Set-EnvValue 'TLS_LEGACY_CA_DIR' $LegacyCaDir
  $cert = Get-Setting $cfg 'TLS_CERT_FILE' ''
  $key  = Get-Setting $cfg 'TLS_KEY_FILE' ''
  if ($cert -and $key) { Set-EnvValue 'TLS_CERT' $cert; Set-EnvValue 'TLS_KEY' $key }
  foreach ($k in @('TRUST_PROXY', 'COOKIE_SECURE', 'TLS_PORT', 'PUBLIC_SCHEME', 'PUBLIC_PORT', 'TLS_CERT_FILE', 'TLS_KEY_FILE')) { Remove-EnvKey $k }
  Write-Log "Converted settings to built-in HTTPS on port $port (previous file kept as inout-board.env.before-https-builtin)"
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

function Publish-LocalCa {
  # The app creates its private CA the first time it starts with HTTPS. Copy the public
  # certificate to a stable place so it can be handed to client devices.
  $src = Join-Path $TlsDir 'ca.crt'
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
  $tls = [int](Get-Setting $cfg 'PORT' $TlsPort)
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
    foreach ($d in @($DataRoot, $DataDir, $BackupDir, $LogDir, $TlsDir)) {
      if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    Write-Log "Installing from $InstallDir (data in $DataRoot)"
    Protect-DataRoot

    if (-not (Test-Path $EnvFile)) {
      $envText = @"
# IN/OUT Board settings. Lines starting with # are ignored.
# After editing, apply with:  InOutBoard.ps1 -Action Restart   (or reboot).

# The board serves HTTPS itself on this port, on every address of this PC.
# 443 gives https://<ip>/ ; otherwise https://<ip>:<port>/
HOST=0.0.0.0
PORT=$TlsPort
DATA_DIR=$DataDir
HTTPS=auto
TLS_DIR=$TlsDir
TLS_LEGACY_CA_DIR=$LegacyCaDir

# Extra addresses to serve HTTPS on, comma separated (for example the public
# WAN address that the router forwards to this PC).
EXTRA_ADDRESSES=$ExtraAddresses

# Which address is shown first in links. Leave empty to use the active route.
PREFERRED_ADDRESS=

# Optional: use your own certificate instead of the built-in private CA
# (remove HTTPS=auto above or leave it; these take priority). Re-read every 6 hours.
# TLS_CERT=C:\ProgramData\InOutBoard\certs\board.crt
# TLS_KEY=C:\ProgramData\InOutBoard\certs\board.key

# First admin account. Used ONLY on the very first start.
# Sign in as admin / admin; you are required to choose a new password immediately.
ADMIN_USER=admin
ADMIN_PASSWORD=admin
"@
      Set-Content -Path $EnvFile -Value $envText -Encoding ASCII
      Write-Log "Wrote default settings to $EnvFile"
    } else {
      Write-Log "Kept existing settings in $EnvFile"
      Convert-LegacyEnv
      # A settings file from an older install can have ADMIN_PASSWORD blank, which would generate a
      # random password. If there is no database yet, no admin exists, so use the documented default.
      $existingCfg = Read-EnvFile
      if ((-not (Test-Path (Join-Path $DataDir 'inout.sqlite'))) -and ((Get-Setting $existingCfg 'ADMIN_PASSWORD' '') -eq '')) {
        $lines = @(Get-Content $EnvFile | Where-Object { $_ -notmatch '^\s*ADMIN_PASSWORD\s*=' })
        $lines += 'ADMIN_PASSWORD=admin'
        Set-Content -Path $EnvFile -Value $lines -Encoding ASCII
        Write-Log 'No database yet: set ADMIN_PASSWORD=admin in the settings file (you will be asked to change it at first sign-in).'
      }
    }

    Stop-Board
    $cfg = Read-EnvFile
    $tls = [int](Get-Setting $cfg 'PORT' $TlsPort)

    # Older versions ran a separate HTTPS front end (Caddy); it is no longer needed.
    Unregister-ScheduledTask -TaskName $TaskTls -Confirm:$false -ErrorAction SilentlyContinue
    Stop-ByPath $Caddy

    $boot = New-ScheduledTaskTrigger -AtStartup
    Register-BoardTask $TaskApp 'RunApp' $boot 'IN/OUT Board (serves HTTPS)'
    $nightly = New-ScheduledTaskTrigger -Daily -At '02:15'
    Register-BoardTask $TaskBackup 'Backup' $nightly 'Nightly IN/OUT Board backup (keeps 14)'

    # Open the HTTPS port by number on every network profile (Domain, Private and
    # Public). Windows often labels home and office Wi-Fi as "Public", and a rule
    # that only covers Private networks silently blocks other devices.
    Get-NetFirewallRule -DisplayName $FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName $FirewallRule -Direction Inbound -Action Allow -Protocol TCP `
      -LocalPort $tls -Profile Any -Enabled True | Out-Null
    Write-Log "Firewall: allowed inbound TCP $tls on all network profiles"

    Start-ScheduledTask -TaskName $TaskApp

    if (Publish-LocalCa) {
      Write-Log "Local CA certificate: $CaCopy"
      if (Add-CaTrust) { Write-Log 'Local CA is now trusted on this PC (Trusted Root Certification Authorities).' }
    } else {
      Write-Log "WARNING: local CA certificate not created yet; check $LogDir\app.log"
    }

    # Prove HTTPS answers on every address of this PC, not just loopback.
    foreach ($ip in (@('127.0.0.1') + (Get-Ipv4List))) {
      $ok = Wait-Https $ip $tls 40
      if ($ok -eq $true) { Write-Log "HTTPS answers on ${ip}:$tls" }
      elseif ($ok -eq $false) { Write-Log "WARNING: HTTPS did not answer on ${ip}:$tls. See $LogDir\app.log" }
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

  'Purge' {
    # Full Remove first (stops services, removes tasks, firewall, CA trust)
    & $PSCommandPath -Action Remove -TlsPort $TlsPort -DataRoot $DataRoot -ErrorAction SilentlyContinue
    # Then delete all application data (database, TLS certs, backups, uploads, logs)
    if (Test-Path $DataRoot) {
      Write-Log "Removing all data in $DataRoot"
      Remove-Item -Recurse -Force $DataRoot
      Write-Log 'Data directory removed'
    } else {
      Write-Log "Data directory $DataRoot does not exist — nothing to purge"
    }
    Write-Log 'Purge complete. All IN/OUT Board data has been removed.'
  }

  'Stop'    { Stop-Board; Write-Log 'Stopped' }
  'Start'   {
    Start-ScheduledTask -TaskName $TaskApp
    Write-Log 'Started'
  }
  'Restart' {
    Stop-Board
    Start-ScheduledTask -TaskName $TaskApp
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
    # Left over from versions that used a separate HTTPS front end. The app serves HTTPS itself now.
    Write-Log 'RunTls is no longer used; the app serves HTTPS itself.' 'install.log'
  }

  'Backup' {
    $env:DATA_DIR = $DataDir
    $env:KEEP = '14'
    $code = Invoke-Logged $Node ('--disable-warning=ExperimentalWarning "{0}" "{1}"' -f (Join-Path $InstallDir 'scripts\backup.js'), $BackupDir) (Join-Path $LogDir 'backup.log') $InstallDir
    Write-Log "Backup finished with code $code (see $LogDir\backup.log)"
    if ($code -ne 0) { exit $code }
  }

  'Addresses' { Show-Urls }

  'ResetAdmin' {
    # Stops the app, resets the admin account to admin / admin (forced change at next sign-in), starts it again.
    $cfg = Read-EnvFile
    $dd = Get-Setting $cfg 'DATA_DIR' $DataDir
    Stop-Board
    $env:DATA_DIR = $dd
    $out = & $Node --disable-warning=ExperimentalWarning (Join-Path $InstallDir 'scripts\reset-admin.js') 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { Write-Log ([string]$_) }
    Start-ScheduledTask -TaskName $TaskApp
    if ($code -ne 0) { throw "Reset failed (exit $code)" }
  }

  'Status' {
    $cfg = Read-EnvFile
    $tls = [int](Get-Setting $cfg 'PORT' $TlsPort)
    $admin = Test-Admin

    Write-Host 'IN/OUT Board status'
    Write-Host '-------------------'

    if ($admin) {
      foreach ($t in @($TaskApp, $TaskBackup)) {
        $task = Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
        if ($task) { Write-Host ('{0,-26} {1}' -f $t, $task.State) } else { Write-Host ('{0,-26} NOT INSTALLED' -f $t) }
      }
    } else {
      Write-Host 'Scheduled tasks and firewall rules can only be read from an elevated PowerShell'
      Write-Host '(right-click PowerShell, Run as administrator). Checking what can be seen without it:'
    }

    # What is actually listening. This works without administrator rights.
    $listen = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $tls })
    if ($listen.Count -eq 0) { Write-Host ('Port {0,-5} NOT LISTENING' -f $tls) }
    else { Write-Host ('Port {0,-5} listening on {1}' -f $tls, ((($listen | ForEach-Object { $_.LocalAddress }) | Select-Object -Unique) -join ', ')) }

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
