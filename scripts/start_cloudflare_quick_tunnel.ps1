$ErrorActionPreference = "Stop"

$ProjectRoot = "D:\AI\tradingview-mcp-jackson"
$LogDir = Join-Path $ProjectRoot "paper-data\logs"
$TunnelUrlPath = Join-Path $ProjectRoot "paper-data\tunnel-url.txt"
$TunnelDashboardUrlPath = Join-Path $ProjectRoot "paper-data\tunnel-dashboard-url.txt"
$LogPath = Join-Path $LogDir "cloudflared-quick-tunnel.log"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $ProjectRoot

function Write-Log {
    param([string]$Message)
    $Line = "$(Get-Date -Format o) $Message"
    Write-Output $Line
    Add-Content -LiteralPath $LogPath -Value $Line
}

function Read-EnvFile {
    $EnvPath = Join-Path $ProjectRoot ".env"
    $Values = @{}
    if (Test-Path -LiteralPath $EnvPath) {
        Get-Content -LiteralPath $EnvPath | ForEach-Object {
            $Line = $_.Trim()
            if (-not $Line -or $Line.StartsWith("#") -or -not $Line.Contains("=")) { return }
            $Name, $Value = $Line.Split("=", 2)
            $Values[$Name.Trim()] = $Value.Trim().Trim('"')
        }
    }
    return $Values
}

function Test-DashboardReady {
    param([string]$HostName, [string]$Port)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://${HostName}:${Port}/healthz" -TimeoutSec 3
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

$Existing = Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match "cloudflared.*tunnel.*http://127\.0\.0\.1:8787" -and $_.ProcessId -ne $PID }
if ($Existing) {
    Write-Log "Cloudflare quick tunnel already running as PID $($Existing[0].ProcessId)"
    exit 0
}

$EnvValues = Read-EnvFile
$HostName = if ($env:DASHBOARD_HOST) { $env:DASHBOARD_HOST } elseif ($EnvValues.DASHBOARD_HOST) { $EnvValues.DASHBOARD_HOST } else { "127.0.0.1" }
$Port = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } elseif ($EnvValues.DASHBOARD_PORT) { $EnvValues.DASHBOARD_PORT } else { "8787" }
$Token = if ($env:DASHBOARD_TOKEN) { $env:DASHBOARD_TOKEN } elseif ($EnvValues.DASHBOARD_TOKEN) { $EnvValues.DASHBOARD_TOKEN } else { "" }
$LocalUrl = "http://${HostName}:${Port}"

$Cloudflared = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $Cloudflared) {
    throw "cloudflared not found in PATH"
}

Write-Log "Waiting for dashboard at $LocalUrl"
$Deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $Deadline) {
    if (Test-DashboardReady -HostName $HostName -Port $Port) { break }
    Start-Sleep -Seconds 3
}

if (-not (Test-DashboardReady -HostName $HostName -Port $Port)) {
    throw "Dashboard did not become ready at $LocalUrl"
}

function Update-TunnelUrlFromLogs {
    param([string[]]$Paths)

    foreach ($Path in $Paths) {
        if (-not (Test-Path -LiteralPath $Path)) { continue }
        $Text = Get-Content -LiteralPath $Path -Raw -ErrorAction SilentlyContinue
        if (-not $Text) { continue }
        $Matches = [regex]::Matches($Text, "https://[a-zA-Z0-9-]+\.trycloudflare\.com")
        if ($Matches.Count -eq 0) { continue }

        $Url = $Matches[$Matches.Count - 1].Value
        $Previous = if (Test-Path -LiteralPath $TunnelUrlPath) { (Get-Content -LiteralPath $TunnelUrlPath -Raw).Trim() } else { "" }
        Set-Content -LiteralPath $TunnelUrlPath -Value $Url
        if ($Token) {
            Set-Content -LiteralPath $TunnelDashboardUrlPath -Value "$Url/?token=$Token"
        }
        if ($Url -ne $Previous) {
            Write-Log "Quick tunnel URL: $Url"
        }
        return $true
    }

    return $false
}

while ($true) {
    $RuntimeOut = Join-Path $LogDir "cloudflared-runtime.out.log"
    $RuntimeErr = Join-Path $LogDir "cloudflared-runtime.err.log"
    Remove-Item -LiteralPath $RuntimeOut, $RuntimeErr -ErrorAction SilentlyContinue

    Write-Log "Starting Cloudflare quick tunnel to $LocalUrl"
    $Process = Start-Process `
        -FilePath $Cloudflared.Source `
        -ArgumentList @("tunnel", "--url", $LocalUrl) `
        -WorkingDirectory $ProjectRoot `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput $RuntimeOut `
        -RedirectStandardError $RuntimeErr

    $UrlDetected = $false
    $Deadline = (Get-Date).AddSeconds(90)
    while (-not $Process.HasExited -and (Get-Date) -lt $Deadline) {
        if (Update-TunnelUrlFromLogs -Paths @($RuntimeOut, $RuntimeErr)) {
            $UrlDetected = $true
            break
        }
        Start-Sleep -Seconds 2
        $Process.Refresh()
    }

    if (-not $UrlDetected) {
        Update-TunnelUrlFromLogs -Paths @($RuntimeOut, $RuntimeErr) | Out-Null
    }

    while (-not $Process.HasExited) {
        Start-Sleep -Seconds 10
        $Process.Refresh()
        Update-TunnelUrlFromLogs -Paths @($RuntimeOut, $RuntimeErr) | Out-Null
    }

    Write-Log "cloudflared exited with code $($Process.ExitCode); restarting in 10 seconds"
    Start-Sleep -Seconds 10
}
