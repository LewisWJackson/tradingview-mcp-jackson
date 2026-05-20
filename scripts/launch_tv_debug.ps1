# Launch TradingView Desktop (Microsoft Store / MSIX) with Chrome DevTools Protocol
# Must run as Administrator — WindowsApps requires elevated access
# Usage: Right-click > Run with PowerShell as Administrator
#        Or: Start-Process powershell -Verb RunAs -ArgumentList "-File `"$PSScriptRoot\launch_tv_debug.ps1`""

param([int]$Port = 9222)

# Check if running as Administrator
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Relaunching as Administrator..." -ForegroundColor Yellow
    Start-Process powershell -Verb RunAs -ArgumentList "-File `"$PSCommandPath`" -Port $Port"
    exit
}

Write-Host "Killing existing TradingView instances..." -ForegroundColor Cyan
Stop-Process -Name "TradingView" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Locate TradingView MSIX install
$tv = Get-ChildItem "C:\Program Files\WindowsApps\TradingView.Desktop_*_x64__n534cwy3pjxzj" `
    -Recurse -Filter "TradingView.exe" -ErrorAction SilentlyContinue | Select-Object -First 1

if (-not $tv) {
    Write-Host "Error: TradingView not found in WindowsApps." -ForegroundColor Red
    Write-Host "Run manually: Get-ChildItem 'C:\Program Files\WindowsApps' -Recurse -Filter TradingView.exe"
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Found: $($tv.FullName)" -ForegroundColor Green
Write-Host "Starting with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
Start-Process $tv.FullName -ArgumentList "--remote-debugging-port=$Port"

# Wait for CDP to respond
Write-Host "Waiting for CDP..." -ForegroundColor Cyan
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    try {
        $response = Invoke-RestMethod "http://localhost:$Port/json/version" -ErrorAction Stop
        Write-Host ""
        Write-Host "CDP ready at http://localhost:$Port" -ForegroundColor Green
        Write-Host "Browser: $($response.Browser)" -ForegroundColor Green
        $ready = $true
        break
    } catch {
        Write-Host "." -NoNewline
    }
}

if (-not $ready) {
    Write-Host ""
    Write-Host "Warning: CDP not responding after 60s. TradingView may still be loading." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "Done. Now open Claude Code in C:\Users\juant\tradingview-mcp-jackson and run tv_health_check" -ForegroundColor Cyan
Read-Host "Press Enter to close"
