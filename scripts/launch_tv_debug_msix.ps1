<#
    Launch TradingView Desktop (MSIX / Microsoft Store build) with the Chrome
    DevTools Protocol enabled.

    Why this exists: the bundled scripts\launch_tv_debug.bat cannot find MSIX
    installs. C:\Program Files\WindowsApps is not enumerable by a normal user,
    so the .bat's `dir /s /b "...\WindowsApps\TradingView*\TradingView.exe"` and
    `where TradingView.exe` probes both return nothing -- and because the .bat
    runs `taskkill` *before* detection, it kills a running TradingView and then
    exits with "TradingView not found". This script resolves the executable
    through the package manifest, checks the port first, and refuses to kill a
    running instance unless -Force is given.

    Usage:
      powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug_msix.ps1
      powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug_msix.ps1 -Force
      powershell -ExecutionPolicy Bypass -File scripts\launch_tv_debug_msix.ps1 -Port 9333 -Force

    Exit codes: 0 = CDP ready, 1 = error, 2 = needs -Force to restart TradingView.
#>
[CmdletBinding()]
param(
    [int]$Port = 9222,
    [switch]$Force
)

function Test-CdpPort {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $Port)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Show-CdpVersion {
    param([int]$Port)
    try {
        (Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -UseBasicParsing -TimeoutSec 5).Content
    } catch {
        Write-Warning "Port is open but /json/version did not respond: $($_.Exception.Message)"
    }
}

# 1. Already listening? Then there is nothing to do.
if (Test-CdpPort -Port $Port) {
    Write-Host "CDP is already available at http://localhost:$Port" -ForegroundColor Green
    Show-CdpVersion -Port $Port
    exit 0
}

# 2. Resolve TradingView.exe -- MSIX package first, then classic install paths.
$exe = $null
$pkg = Get-AppxPackage -Name 'TradingView*' -ErrorAction SilentlyContinue | Select-Object -First 1

if ($pkg) {
    $candidate = Join-Path $pkg.InstallLocation 'TradingView.exe'
    if (Test-Path $candidate) { $exe = $candidate }
}

if (-not $exe) {
    $classic = @(
        (Join-Path $env:LOCALAPPDATA 'TradingView\TradingView.exe'),
        (Join-Path $env:ProgramFiles  'TradingView\TradingView.exe')
    )
    if (${env:ProgramFiles(x86)}) {
        $classic += (Join-Path ${env:ProgramFiles(x86)} 'TradingView\TradingView.exe')
    }
    foreach ($c in $classic) {
        if (Test-Path $c) { $exe = $c; break }
    }
}

if (-not $exe) {
    Write-Error "TradingView Desktop not found (checked the MSIX package and the classic install paths). Install it, or launch manually: '<path>\TradingView.exe' --remote-debugging-port=$Port"
    exit 1
}

Write-Host "Found TradingView: $exe"

# 3. A running instance has no debug port (we checked above), so it must be
#    restarted. That is disruptive, so require an explicit -Force.
$running = @(Get-Process -Name 'TradingView' -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
    if (-not $Force) {
        Write-Host ""
        Write-Host "TradingView is already running ($($running.Count) processes) WITHOUT the debug port." -ForegroundColor Yellow
        Write-Host "The debug port can only be enabled at startup, so the app has to be restarted." -ForegroundColor Yellow
        Write-Host "Save anything you care about, then re-run this script with -Force." -ForegroundColor Yellow
        exit 2
    }
    Write-Host "Stopping $($running.Count) TradingView process(es)..."
    Stop-Process -Name 'TradingView' -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# 4. Launch with the debug flag.
Write-Host "Starting with --remote-debugging-port=$Port ..."
$launched = $false
try {
    Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=$Port" -ErrorAction Stop
    $launched = $true
} catch {
    Write-Warning "Direct launch failed: $($_.Exception.Message)"
    if ($pkg) {
        Write-Host "Falling back to AppsFolder activation (note: the debug flag may be ignored this way)..."
        try {
            Start-Process "shell:AppsFolder\$($pkg.PackageFamilyName)!TradingView.Desktop" -ErrorAction Stop
            $launched = $true
        } catch {
            Write-Warning "AppsFolder activation also failed: $($_.Exception.Message)"
        }
    }
}

if (-not $launched) {
    Write-Error "Could not start TradingView. Launch it by hand with: '$exe' --remote-debugging-port=$Port"
    exit 1
}

# 5. Wait for CDP, with a timeout (the bundled .bat loops forever here).
Write-Host "Waiting for CDP on port $Port (up to 60s)..."
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Date) -lt $deadline) {
    if (Test-CdpPort -Port $Port) {
        Write-Host ""
        Write-Host "CDP ready at http://localhost:$Port" -ForegroundColor Green
        Show-CdpVersion -Port $Port
        exit 0
    }
    Start-Sleep -Seconds 2
}

Write-Error "Timed out after 60s: port $Port never opened. This TradingView build may ignore --remote-debugging-port, or the flag was dropped by MSIX activation."
exit 1
