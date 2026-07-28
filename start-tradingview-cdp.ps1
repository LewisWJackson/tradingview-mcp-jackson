# Launch TradingView in Chrome with CDP (Chrome DevTools Protocol) enabled.
#
# Why Chrome and not TradingView Desktop:
#   TradingView Desktop on Windows ships as an MSIX/Store package. Windows blocks
#   direct execution of MSIX binaries ("Access is denied"), so the --remote-debugging-port
#   flag can't be passed to it. The connector only needs *a* Chromium page on port 9222
#   whose URL matches tradingview.com/chart -- see src/connection.js findChartTarget().
#   Chrome gives us that with no sandbox in the way.
#
# Usage:  powershell -ExecutionPolicy Bypass -File start-tradingview-cdp.ps1

$ErrorActionPreference = 'Stop'

$port    = 9222
$chrome  = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$profile = Join-Path $HOME "tradingview-cdp-profile"
$url     = "https://www.tradingview.com/chart/"

if (-not (Test-Path $chrome)) {
    Write-Host "Chrome not found at $chrome" -ForegroundColor Red
    exit 1
}

# Already running with CDP up? Don't launch a second one.
try {
    $null = Invoke-WebRequest "http://localhost:$port/json/version" -UseBasicParsing -TimeoutSec 3
    Write-Host "CDP already live on port $port - reusing it." -ForegroundColor Yellow
} catch {
    Write-Host "Starting Chrome with remote debugging on port $port..."
    Start-Process $chrome -ArgumentList `
        "--remote-debugging-port=$port", `
        "--user-data-dir=$profile", `
        $url
}

# Wait for CDP to answer (up to 45s)
$ready = $false
for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    try {
        $null = Invoke-WebRequest "http://localhost:$port/json/version" -UseBasicParsing -TimeoutSec 2
        $ready = $true
        break
    } catch { }
}

if (-not $ready) {
    Write-Host "CDP never came up on port $port." -ForegroundColor Red
    exit 1
}

# Make sure a tradingview.com/chart tab actually exists; open one if not.
$targets = (Invoke-WebRequest "http://localhost:$port/json/list" -UseBasicParsing).Content | ConvertFrom-Json
$chart   = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'tradingview\.com/chart' }

if (-not $chart) {
    Write-Host "No chart tab found - opening one..."
    Invoke-WebRequest -Method PUT -Uri "http://localhost:$port/json/new?$url" -UseBasicParsing | Out-Null
    Start-Sleep -Seconds 12
    $targets = (Invoke-WebRequest "http://localhost:$port/json/list" -UseBasicParsing).Content | ConvertFrom-Json
    $chart   = $targets | Where-Object { $_.type -eq 'page' -and $_.url -match 'tradingview\.com/chart' }
}

if ($chart) {
    Write-Host ""
    Write-Host "Ready. Chart tab: $($chart.title)" -ForegroundColor Green
    Write-Host "CDP endpoint:     http://localhost:$port" -ForegroundColor Green
    Write-Host ""
    Write-Host "Claude can now read this chart. Ask it: 'run my brief'"
} else {
    Write-Host "Chrome is up but no TradingView chart tab was found." -ForegroundColor Red
    exit 1
}
