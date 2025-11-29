# Start both Frontend and Backend
Write-Host "Starting Twinly - Frontend and Backend" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta

# Get the script directory (handle both direct execution and file execution)
if ($PSScriptRoot) {
    $scriptDir = $PSScriptRoot
} elseif ($MyInvocation.MyCommand.Path) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
} else {
    $scriptDir = Get-Location
}

# Ensure we're in the right directory
Set-Location $scriptDir

# Start backend in a new window (bypass execution policy)
Write-Host "`nStarting Backend Agent in new window..." -ForegroundColor Cyan
$backendScript = Join-Path $scriptDir "start-backend.ps1"
Start-Process powershell -ArgumentList "-NoExit", "-ExecutionPolicy", "Bypass", "-File", $backendScript

# Wait a moment
Start-Sleep -Seconds 2

# Start frontend in current window
Write-Host "Starting Frontend in this window..." -ForegroundColor Cyan
$frontendScript = Join-Path $scriptDir "start-frontend.ps1"
& $frontendScript
