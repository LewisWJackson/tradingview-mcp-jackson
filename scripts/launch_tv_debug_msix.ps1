# Launch TradingView Desktop with Chrome DevTools Protocol enabled, for the tradingview MCP.
#
# TradingView ships as an MSIX package. Running the exe directly means Windows activates it via
# the shell activation manager and argv never reaches Chromium, so the debug port never opens.
# Invoke-CommandInDesktopPackage launches it inside the package container, where the flag survives.
# Requires Developer Mode (Settings > System > For developers).

param([int]$Port = 9222)

$ErrorActionPreference = 'Stop'

$pkg = Get-AppxPackage -Name 'TradingView.Desktop'
if (-not $pkg) { throw 'TradingView.Desktop is not installed.' }

# Resolve from the package, never a hardcoded path: WindowsApps paths are version-pinned and break
# on every auto-update (3.1.0.7818 -> 3.3.0.7992 silently broke the previous version of this script).
$exe = Join-Path $pkg.InstallLocation 'TradingView.exe'
if (-not (Test-Path -LiteralPath $exe)) { throw "Not found: $exe" }

if (Get-Process -Name 'TradingView*' -ErrorAction SilentlyContinue) {
    throw 'TradingView is already running. Close it first - Electron focuses the existing window and ignores the debug flag.'
}

Write-Host "Launching $($pkg.Name) $($pkg.Version) with CDP on port $Port..."

# -Command must be the FULL exe path. A bare 'TradingView.exe' hangs indefinitely and never
# starts the app.
Invoke-CommandInDesktopPackage `
    -PackageFamilyName $pkg.PackageFamilyName `
    -AppId 'TradingView.Desktop' `
    -Command $exe `
    -Args "--remote-debugging-port=$Port"

for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
        Write-Host "CDP listening on $Port."
        Write-Host 'Now open a chart. A cold start lands on "New tab" and the MCP reports'
        Write-Host 'api_available: false until a tradingview.com/chart target exists.'
        exit 0
    }
}

throw "Port $Port never opened after 30s."
