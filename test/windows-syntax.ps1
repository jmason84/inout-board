#Requires -Version 5.1
# Parse without executing installers, tasks, certificate stores, or deletion.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$failed = $false
foreach ($file in Get-ChildItem (Join-Path $root 'windows') -Filter '*.ps1') {
  $bytes = [IO.File]::ReadAllBytes($file.FullName)
  $sources = @{ UTF8 = [Text.Encoding]::UTF8.GetString($bytes) }
  # Windows PowerShell 5.1 reads BOM-less scripts using the system ANSI codepage.
  # Exercise the runner's Windows-1252 decoding even when this test runs in pwsh.
  if (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) {
    $sources.ANSI = [Text.Encoding]::GetEncoding(1252).GetString($bytes)
  }
  foreach ($encoding in $sources.Keys) {
    $tokens = $null
    $parseErrors = $null
    [void][Management.Automation.Language.Parser]::ParseInput($sources[$encoding], [ref]$tokens, [ref]$parseErrors)
    foreach ($problem in $parseErrors) {
      Write-Host ('{0}:{1} ({2}): {3}' -f $file.Name, $problem.Extent.StartLineNumber, $encoding, $problem.Message)
      $failed = $true
    }
  }
}
if ($failed) { throw 'Windows PowerShell syntax/encoding validation failed' }
Write-Host 'Windows scripts parse correctly as UTF-8 and Windows ANSI.'
