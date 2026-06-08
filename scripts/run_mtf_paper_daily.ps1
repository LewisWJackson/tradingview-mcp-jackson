$ErrorActionPreference = "Stop"

$ProjectRoot = "D:\AI\tradingview-mcp-jackson"
$LogDir = Join-Path $ProjectRoot "paper-data\logs"
$LockPath = Join-Path $ProjectRoot "paper-data\mtf_paper.lock"
$DataDir = Join-Path $ProjectRoot "paper-data"
$Date = Get-Date -Format "yyyy-MM-dd"
$LogPath = Join-Path $LogDir "$Date.daily.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectRoot

function Write-Log {
    param([string]$Message)
    $Line = "$(Get-Date -Format o) $Message"
    Write-Output $Line
    Add-Content -LiteralPath $LogPath -Value $Line
}

function Test-CdpReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Enter-RunLock {
    try {
        New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
        Set-Content -LiteralPath (Join-Path $LockPath "owner.txt") -Value "pid=$PID started=$(Get-Date -Format o)"
        return
    } catch {
        if (-not (Test-Path -LiteralPath $LockPath)) {
            throw
        }
    }

    $Lock = Get-Item -LiteralPath $LockPath
    if ($Lock.LastWriteTime -gt (Get-Date).AddHours(-4)) {
        Write-Log "Another MTF paper run appears active; skipping this scheduled run"
        exit 0
    }

    Write-Log "Removing stale MTF paper lock"
    Remove-RunLock
    New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
    Set-Content -LiteralPath (Join-Path $LockPath "owner.txt") -Value "pid=$PID started=$(Get-Date -Format o)"
}

function Remove-RunLock {
    $FullLockPath = [System.IO.Path]::GetFullPath($LockPath)
    $FullDataDir = [System.IO.Path]::GetFullPath($DataDir)
    if (-not $FullLockPath.StartsWith($FullDataDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to remove lock outside paper-data: $FullLockPath"
    }
    Remove-Item -LiteralPath $LockPath -Force -Recurse -ErrorAction SilentlyContinue
}

function Exit-RunLock {
    Remove-RunLock
}

function Start-TradingViewDebug {
    if (Test-CdpReady) {
    Write-Log "TradingView CDP already ready on 127.0.0.1:9222"
        return
    }

    Write-Log "Starting TradingView with --remote-debugging-port=9222"
    Get-Process -Name TradingView -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2

    $package = Get-AppxPackage TradingView.Desktop
    if ($package) {
        $tv = Join-Path $package.InstallLocation "TradingView.exe"
    } else {
        $candidates = @(
            "$env:LOCALAPPDATA\TradingView\TradingView.exe",
            "$env:LOCALAPPDATA\Programs\TradingView\TradingView.exe",
            "$env:ProgramFiles\TradingView\TradingView.exe",
            "${env:ProgramFiles(x86)}\TradingView\TradingView.exe"
        )
        $tv = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }

    if (-not $tv) {
        throw "TradingView.exe not found"
    }

    Start-Process -FilePath $tv -ArgumentList "--remote-debugging-port=9222"

    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline) {
        if (Test-CdpReady) {
            Write-Log "TradingView CDP ready"
            return
        }
        Start-Sleep -Seconds 2
    }

    throw "TradingView CDP did not become ready on 127.0.0.1:9222"
}

Enter-RunLock

try {
    Write-Log "Starting MTF paper daily run"
    Start-TradingViewDebug

    $env:TRADINGVIEW_CDP_HOST = "127.0.0.1"
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & node scripts\mtf_paper_system.mjs --symbols=universe 2>&1
        $exit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }
    $output | ForEach-Object { Add-Content -LiteralPath $LogPath -Value $_ }

    if ($exit -ne 0) {
        Write-Log "MTF paper daily run failed with exit code $exit"
        exit $exit
    }

    Write-Log "MTF paper daily run completed"
} finally {
    Exit-RunLock
}
