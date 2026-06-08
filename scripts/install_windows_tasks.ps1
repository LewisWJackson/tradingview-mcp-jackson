$ErrorActionPreference = "Stop"

$ProjectRoot = "D:\AI\tradingview-mcp-jackson"
$DashboardScript = Join-Path $ProjectRoot "scripts\start_dashboard.ps1"
$TunnelScript = Join-Path $ProjectRoot "scripts\start_cloudflare_quick_tunnel.ps1"
$PaperScript = Join-Path $ProjectRoot "scripts\run_mtf_paper_daily.bat"

function Register-Task {
    param(
        [string]$Name,
        [string]$Command,
        [string[]]$ScheduleArgs
    )

    $args = @("/Create", "/TN", $Name, "/TR", $Command, "/F", "/RL", "LIMITED") + $ScheduleArgs
    & schtasks @args | Write-Output
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create scheduled task: $Name"
    }
}

Register-Task `
    -Name "TV MCP Dashboard" `
    -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$DashboardScript`"" `
    -ScheduleArgs @("/SC", "ONLOGON")

Register-Task `
    -Name "TV MCP Cloudflare Quick Tunnel" `
    -Command "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$TunnelScript`"" `
    -ScheduleArgs @("/SC", "ONLOGON")

Register-Task `
    -Name "TV MCP Paper Scan 15m" `
    -Command "`"$PaperScript`"" `
    -ScheduleArgs @("/SC", "MINUTE", "/MO", "15")

try {
    $LongRunningSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew

    Set-ScheduledTask -TaskName "TV MCP Dashboard" -Settings $LongRunningSettings | Out-Null
    Set-ScheduledTask -TaskName "TV MCP Cloudflare Quick Tunnel" -Settings $LongRunningSettings | Out-Null

    $ScanSettings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit (New-TimeSpan -Minutes 45) `
        -MultipleInstances IgnoreNew

    Set-ScheduledTask -TaskName "TV MCP Paper Scan 15m" -Settings $ScanSettings | Out-Null
} catch {
    Write-Warning "Could not tune scheduled task settings: $($_.Exception.Message)"
}

Write-Output "Installed tasks:"
schtasks /Query /TN "TV MCP Dashboard"
schtasks /Query /TN "TV MCP Cloudflare Quick Tunnel"
schtasks /Query /TN "TV MCP Paper Scan 15m"

Write-Output ""
Write-Output "To start them now:"
Write-Output 'schtasks /Run /TN "TV MCP Dashboard"'
Write-Output 'schtasks /Run /TN "TV MCP Cloudflare Quick Tunnel"'
Write-Output 'schtasks /Run /TN "TV MCP Paper Scan 15m"'
