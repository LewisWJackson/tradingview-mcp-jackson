# ============================================================
#  TradingView CDP Launcher — TraderXO Setup
#  Works with both Windows Store version AND direct install
#  Run this script to launch TradingView with CDP on port 9222
# ============================================================

param(
    [int]$Port = 9222,
    [switch]$Silent
)

$TV_EXE    = "C:\Program Files\WindowsApps\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\TradingView.exe"
$TV_AUMID  = "TradingView.Desktop_n534cwy3pjxzj!App"
$CDP_FLAG  = "--remote-debugging-port=$Port"

function Write-Status($msg, $color = "Cyan") {
    if (-not $Silent) { Write-Host "  $msg" -ForegroundColor $color }
}

# ── 1. Find the latest version if path changed (Store auto-updates) ──────────
if (-not (Test-Path $TV_EXE)) {
    $found = Get-ChildItem "C:\Program Files\WindowsApps" -Filter "TradingView.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $TV_EXE = $found.FullName
        Write-Status "Found updated TV at: $TV_EXE" "Yellow"
    }
}

# ── 2. Kill any existing TradingView instance ────────────────────────────────
$existing = Get-Process -Name "TradingView" -ErrorAction SilentlyContinue
if ($existing) {
    Write-Status "Closing existing TradingView..." "Yellow"
    $existing | Stop-Process -Force
    Start-Sleep -Seconds 2
}

Write-Status "Launching TradingView with CDP on port $Port..." "Cyan"

# ── 3. Try Method A: Direct exe launch (works if you have access) ─────────────
$launched = $false
if (Test-Path $TV_EXE) {
    try {
        Start-Process -FilePath $TV_EXE -ArgumentList $CDP_FLAG -ErrorAction Stop
        $launched = $true
        Write-Status "Launched via direct exe." "Green"
    } catch {
        Write-Status "Direct launch failed, trying Store activation..." "Yellow"
    }
}

# ── 4. Method B: IApplicationActivationManager (Store app with args) ──────────
if (-not $launched) {
    try {
        $type = [Type]::GetTypeFromCLSID([Guid]"{45BA127D-10A8-46EA-8AB7-56EA9078943C}")
        $activator = [Activator]::CreateInstance($type)
        $pid = 0
        $activator.ActivateApplication($TV_AUMID, $CDP_FLAG, [UInt32]0, [ref]$pid)
        $launched = $true
        Write-Status "Launched via Store activation (PID: $pid)." "Green"
    } catch {
        Write-Status "Store activation failed: $_" "Red"
    }
}

# ── 5. Method C: Fallback — use explorer shell with no args (last resort) ─────
if (-not $launched) {
    Write-Status "WARNING: Launching without CDP flags (fallback)." "Red"
    Write-Status "CDP will NOT be available. Consider downloading TradingView from tradingview.com/desktop" "Red"
    Start-Process "explorer.exe" "shell:AppsFolder\$TV_AUMID"
}

# ── 6. Wait for TradingView to start and verify CDP ───────────────────────────
if ($launched) {
    Write-Status "Waiting for TradingView to load..." "Cyan"
    $connected = $false
    for ($i = 1; $i -le 20; $i++) {
        Start-Sleep -Seconds 2
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:$Port/json/version" -TimeoutSec 2 -ErrorAction Stop
            Write-Status "CDP connected on port $Port!" "Green"
            $connected = $true
            break
        } catch {
            Write-Status "Waiting... ($($i*2)s)" "DarkGray"
        }
    }
    if (-not $connected) {
        Write-Status ""
        Write-Status "CDP not reachable on port $Port after 24s." "Red"
        Write-Status "The Store version may block the --remote-debugging-port flag." "Red"
        Write-Status "Solution: Download the direct installer from tradingview.com/desktop" "Yellow"
    }
}
