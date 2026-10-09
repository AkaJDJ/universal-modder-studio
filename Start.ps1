$ErrorActionPreference = 'Stop'
$AppRoot = $PSScriptRoot
$NodeExecutable = $null

$NodeOnPath = Get-Command node -ErrorAction SilentlyContinue
if ($NodeOnPath) { $NodeExecutable = $NodeOnPath.Source }

if (-not $NodeExecutable -and $env:LOCALAPPDATA) {
    $CodexNodeRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $CodexNodeRoot) { $NodeExecutable = $CodexNodeRoot }
}

if (-not $NodeExecutable) {
    Write-Host 'Node.js was not found. Install Node.js, then run Start.ps1 again.' -ForegroundColor Yellow
    Read-Host 'Press Enter to close'
    exit 1
}

if (-not $env:UNIVERSAL_MODDER_REPO) {
    $env:UNIVERSAL_MODDER_REPO = [System.IO.Path]::GetFullPath((Join-Path $AppRoot '..\..\universal-modder'))
}

$Address = 'http://127.0.0.1:8765'
try {
    $null = Invoke-WebRequest -Uri "$Address/api/config" -TimeoutSec 1 -UseBasicParsing
    Start-Process $Address
    exit 0
} catch { }

$NodeArgs = '"' + (Join-Path $AppRoot 'server.mjs') + '"'
$LogRoot = Join-Path $AppRoot 'workspace'
$ServerOutput = Join-Path $LogRoot 'server-output.log'
$ServerError = Join-Path $LogRoot 'server-error.log'
$ServerProcess = Start-Process -FilePath $NodeExecutable -ArgumentList $NodeArgs -WorkingDirectory $AppRoot -WindowStyle Hidden -RedirectStandardOutput $ServerOutput -RedirectStandardError $ServerError -PassThru
Set-Content -LiteralPath (Join-Path $LogRoot 'server.pid') -Value $ServerProcess.Id

$Ready = $false
for ($Attempt = 0; $Attempt -lt 40; $Attempt++) {
    Start-Sleep -Milliseconds 250
    try {
        $null = Invoke-WebRequest -Uri "$Address/api/config" -TimeoutSec 1 -UseBasicParsing
        $Ready = $true
        break
    } catch { }
}

if ($Ready) {
    Start-Process $Address
} else {
    Write-Host 'Universal Modder Studio did not start. Check that Node.js is available and port 8765 is free.' -ForegroundColor Red
    if (Test-Path -LiteralPath $ServerError) { Get-Content -LiteralPath $ServerError -Tail 12 }
    Read-Host 'Press Enter to close'
    exit 1
}
