#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$WorkerPath,
  [Parameter(Mandatory=$true)][string]$MsiPath,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedHash,
  [Parameter(Mandatory=$true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(Mandatory=$true)][string]$DataRoot,
  [Parameter(Mandatory=$true)][string]$InstallDir
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -le 5) {
  $env:PSModulePath = (Join-Path $PSHOME 'Modules') + [IO.Path]::PathSeparator + $env:PSModulePath
}
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -MsiPath "{1}" -ExpectedHash {2} -Version {3} -DataRoot "{4}" -InstallDir "{5}"' -f $WorkerPath, $MsiPath, $ExpectedHash, $Version, $DataRoot, $InstallDir
$action = New-ScheduledTaskAction -Execute $ps -Argument $arguments
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'IN-OUT Board Update' -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'IN-OUT Board Update' -ErrorAction Stop
# Do not report success until the independent worker acknowledges its own PID.
for ($i = 0; $i -lt 40; $i++) {
  $status = Join-Path $DataRoot 'updates\status.json'
  if (Test-Path $status) {
    try {
      $state = Get-Content $status -Raw | ConvertFrom-Json
      if ($state.state -in @('backing_up','installing','complete')) { exit 0 }
      if ($state.state -eq 'error') { throw $state.message }
    } catch { if ($_.Exception.Message -notmatch 'JSON') { throw } }
  }
  Start-Sleep -Milliseconds 250
}
throw 'The update task did not start. See Windows Task Scheduler.'
