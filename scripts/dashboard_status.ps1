$ErrorActionPreference = "Continue"

$ProjectRoot = "D:\AI\tradingview-mcp-jackson"
$EnvPath = Join-Path $ProjectRoot ".env"
$TunnelDashboardUrlPath = Join-Path $ProjectRoot "paper-data\tunnel-dashboard-url.txt"

function Read-EnvFile {
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

$EnvValues = Read-EnvFile
$HostName = if ($env:DASHBOARD_HOST) { $env:DASHBOARD_HOST } elseif ($EnvValues.DASHBOARD_HOST) { $EnvValues.DASHBOARD_HOST } else { "127.0.0.1" }
$Port = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } elseif ($EnvValues.DASHBOARD_PORT) { $EnvValues.DASHBOARD_PORT } else { "8787" }
$Token = if ($env:DASHBOARD_TOKEN) { $env:DASHBOARD_TOKEN } elseif ($EnvValues.DASHBOARD_TOKEN) { $EnvValues.DASHBOARD_TOKEN } else { "" }

$LocalDashboardUrl = "http://${HostName}:${Port}/?token=$Token"
$Status = [ordered]@{
    local_dashboard_url = $LocalDashboardUrl
    tunnel_dashboard_url = if (Test-Path -LiteralPath $TunnelDashboardUrlPath) { (Get-Content -LiteralPath $TunnelDashboardUrlPath -Raw).Trim() } else { $null }
    processes = @(Get-CimInstance Win32_Process |
        Where-Object { $_.CommandLine -match "dashboard_server\.mjs|cloudflared.*127\.0\.0\.1:8787" } |
        Select-Object ProcessId, CommandLine)
    tasks = @()
    api = $null
}

foreach ($TaskName in @("TV MCP Dashboard", "TV MCP Cloudflare Quick Tunnel", "TV MCP Paper Scan 15m")) {
    $Task = schtasks /Query /TN $TaskName /FO LIST 2>$null
    $Status.tasks += [ordered]@{ name = $TaskName; installed = [bool]$Task; raw = ($Task -join "`n") }
}

try {
    $Status.api = Invoke-RestMethod -Uri "http://${HostName}:${Port}/api/status" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
} catch {
    $Status.api = [ordered]@{ success = $false; error = $_.Exception.Message }
}

$Status | ConvertTo-Json -Depth 8
