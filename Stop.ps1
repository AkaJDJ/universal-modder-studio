$ErrorActionPreference = 'Stop'
$PidFile = Join-Path $PSScriptRoot 'workspace\server.pid'
if (-not (Test-Path -LiteralPath $PidFile)) {
    Write-Host 'Universal Modder Studio is not running.'
    exit 0
}

$AppProcessId = 0
if (-not [int]::TryParse((Get-Content -LiteralPath $PidFile -Raw).Trim(), [ref]$AppProcessId)) {
    Remove-Item -LiteralPath $PidFile -Force
    Write-Host 'Removed an invalid app process record.'
    exit 0
}

$AppProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $AppProcessId" -ErrorAction SilentlyContinue
if (-not $AppProcess -or $AppProcess.CommandLine -notlike '*server.mjs*') {
    Remove-Item -LiteralPath $PidFile -Force
    Write-Host 'The recorded app server is no longer running.'
    exit 0
}

Stop-Process -Id $AppProcessId -Force
Remove-Item -LiteralPath $PidFile -Force
Write-Host 'Universal Modder Studio is closed.'
