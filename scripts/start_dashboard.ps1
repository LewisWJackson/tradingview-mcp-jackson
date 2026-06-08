$ErrorActionPreference = "Stop"

$ProjectRoot = "D:\AI\tradingview-mcp-jackson"
$LogDir = Join-Path $ProjectRoot "paper-data\logs"
$LogPath = Join-Path $LogDir "dashboard.log"

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

$EnvValues = Read-EnvFile
$HostName = if ($env:DASHBOARD_HOST) { $env:DASHBOARD_HOST } elseif ($EnvValues.DASHBOARD_HOST) { $EnvValues.DASHBOARD_HOST } else { "127.0.0.1" }
$Port = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } elseif ($EnvValues.DASHBOARD_PORT) { $EnvValues.DASHBOARD_PORT } else { "8787" }

if (Test-DashboardReady -HostName $HostName -Port $Port) {
    Write-Log "Dashboard already ready on http://${HostName}:${Port}"
    exit 0
}

Write-Log "Starting dashboard on http://${HostName}:${Port}"
while ($true) {
    & node scripts\dashboard_server.mjs "--host=$HostName" "--port=$Port" *>> $LogPath
    $ExitCode = $LASTEXITCODE
    Write-Log "Dashboard process exited with code $ExitCode; restarting in 5 seconds"
    Start-Sleep -Seconds 5
}
