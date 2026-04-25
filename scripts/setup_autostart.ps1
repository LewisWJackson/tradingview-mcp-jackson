<#
.SYNOPSIS
  Register (or unregister) the TradingView Live Dashboard as a Windows scheduled
  task that auto-starts on user logon.

.PARAMETER Remove
  Unregister the task and exit.

.EXAMPLE
  ./scripts/setup_autostart.ps1            # install / update
  ./scripts/setup_autostart.ps1 -Remove    # uninstall

.NOTES
  Run from a regular (non-elevated) PowerShell prompt. The task registers under
  your user account and triggers at logon. The server starts in a minimized
  window so logs are accessible from the taskbar.
#>

param(
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$TaskName = 'TradingView Live Dashboard'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ServerScript = Join-Path $RepoRoot 'scripts\dashboard\live_server.js'
$LogPath = Join-Path $RepoRoot 'data\live_server.log'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered task '$TaskName'."
  } else {
    Write-Host "Task '$TaskName' not found."
  }
  exit 0
}

# Validate inputs
if (-not (Test-Path $ServerScript)) {
  Write-Error "Server script not found: $ServerScript"
  exit 1
}
$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
  Write-Error "node not found on PATH. Install Node.js or add it to PATH first."
  exit 1
}
$NodeExe = $NodeCmd.Source

# Ensure log directory exists
$LogDir = Split-Path $LogPath -Parent
if (-not (Test-Path $LogDir)) {
  New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
}

# Build the action: cmd /c start "<title>" /min "<node>" "<script>" 1>> "<log>" 2>&1
# This launches Node in a minimized cmd window so:
#   - Logs are visible if the user opens the window
#   - The window can be closed without killing the server (it's the cmd that's minimized, not the node child)
# Actually `cmd /c start /min ...` launches a new minimized window that stays as long as node runs.
$Argument = '/c start "TradingView Live Dashboard" /min "' + $NodeExe + '" "' + $ServerScript + '" 1>> "' + $LogPath + '" 2>&1'

$Action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $Argument
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)   # 0 = unlimited
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

# Idempotent: unregister any existing task with this name first
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Principal $Principal | Out-Null

Write-Host "Registered task '$TaskName'."
Write-Host "  Script:   $ServerScript"
Write-Host "  Trigger:  At logon of $env:USERNAME"
Write-Host "  Logs:     $LogPath"
Write-Host ""
Write-Host "To test:    log out and back in, then open http://localhost:3333"
Write-Host "To remove:  ./scripts/setup_autostart.ps1 -Remove"
Write-Host "To verify:  Get-ScheduledTask -TaskName '$TaskName' | Format-List"
