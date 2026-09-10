# Windows Task Scheduler wrapper for the TradingView scanner.
#
#  - Runs `npm run scan:live` (live) ONLY if the marker file
#      scripts\.scan-live
#    exists. Otherwise runs `npm run scan:dry` (formats/validates, sends nothing).
#    scan:live is `node scripts/scan-run.js --notify`: scan-run.js sends each
#    BUY/SELL to Telegram (notify-telegram.js --signal) the moment that symbol
#    is evaluated, so a timeout later in the run cannot drop an alert. The old
#    `scan:notify` pipe buffered delivery behind a reader that this wrapper's
#    taskkill would terminate mid-stream.
#  - Only runs inside the market-session window (India time): weekdays,
#    09:10-23:40 IST (covers NSE 09:15-15:30 + MCX GOLD to 23:30).
#  - Appends all output to logs\scan-<yyyy-MM-dd>.log.
#  - Never handles or prints the Telegram bot token; the notifier reads it from
#    .env on its own and redacts it from every line.
#
# Exit 0 = ran or intentionally skipped. Non-zero = the scan pipeline failed.
#
# ASCII only - PowerShell 5.1 reads this file as ANSI.

$ErrorActionPreference = 'Continue'
$proj = 'C:\Users\gurjo\tradingview-mcp-jackson'
Set-Location -LiteralPath $proj

# ---- logging ----
$logDir = Join-Path $proj 'logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$log = Join-Path $logDir ('scan-{0:yyyy-MM-dd}.log' -f (Get-Date))
function Log([string]$m) {
  $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $m
  Add-Content -LiteralPath $log -Value $line -Encoding utf8
}

# ---- India-time clock ----
try {
  $istTz = [System.TimeZoneInfo]::FindSystemTimeZoneById('India Standard Time')
  $ist   = [System.TimeZoneInfo]::ConvertTime([DateTime]::UtcNow, $istTz)
} catch {
  $ist = [DateTime]::UtcNow.AddHours(5).AddMinutes(30)
}
$mins = $ist.Hour * 60 + $ist.Minute
$dow  = [int]$ist.DayOfWeek

# ---- session window: weekdays, 09:10-23:40 IST ----
$openMin  = 9 * 60 + 10
$closeMin = 23 * 60 + 40
if ($dow -eq 0 -or $dow -eq 6) {
  Log ('skip: weekend (IST {0})' -f $ist.ToString('ddd HH:mm'))
  exit 0
}
if ($mins -lt $openMin -or $mins -gt $closeMin) {
  Log ('skip: outside session window (IST {0})' -f $ist.ToString('HH:mm'))
  exit 0
}

# ---- live vs dry-run ----
$liveMarker = Join-Path $proj 'scripts\.scan-live'
$isLive = Test-Path -LiteralPath $liveMarker
if ($isLive) { $npmScript = 'scan:live'; $mode = 'LIVE' }
else         { $npmScript = 'scan:dry';  $mode = 'DRY-RUN' }

Log ('run : npm run {0}   (mode={1}, IST {2})' -f $npmScript, $mode, $ist.ToString('HH:mm'))

# ---- run the scan pipeline with a hard timeout ----
# Start-Process + WaitForExit + taskkill /T terminates the whole process tree
# (npm -> cmd -> node [-> node] ) if a CDP call to TradingView stalls.
# The timeout is set ABOVE scan-run.js's own --deadline (420s) so on a merely
# slow run scan-run.js exits cleanly on its own and taskkill only ever fires on
# a genuinely hung tree.
#
# CDP listens on 127.0.0.1 only, but "localhost" resolves to ::1 first. In the
# Task Scheduler session the ::1 attempt hangs instead of failing fast, so force
# IPv4 DNS ordering for every node process this task spawns.
$env:NODE_OPTIONS = '--dns-result-order=ipv4first'

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCmd) { $npm = $npmCmd.Source } else { $npm = 'npm.cmd' }

$TIMEOUT_MS = 8 * 60 * 1000
$tmpOut = [System.IO.Path]::GetTempFileName()
$tmpErr = [System.IO.Path]::GetTempFileName()
$code = 0
try {
  $p = Start-Process -FilePath $npm -ArgumentList 'run', $npmScript `
        -WorkingDirectory $proj -NoNewWindow -PassThru `
        -RedirectStandardOutput $tmpOut -RedirectStandardError $tmpErr
  if ($p.WaitForExit($TIMEOUT_MS)) {
    $code = $p.ExitCode
  } else {
    Log ('TIMEOUT: pipeline exceeded {0}s - killing process tree (pid {1})' -f ($TIMEOUT_MS / 1000), $p.Id)
    & taskkill.exe /PID $p.Id /T /F *> $null
    $code = 124
  }
} catch {
  Log ('ERROR launching pipeline: {0}' -f $_.Exception.Message)
  $code = 1
}

if ($null -eq $code) { $code = 0 }

foreach ($fn in @($tmpErr, $tmpOut)) {
  if (Test-Path -LiteralPath $fn) {
    Get-Content -LiteralPath $fn -ErrorAction SilentlyContinue |
      ForEach-Object { Add-Content -LiteralPath $log -Value $_ -Encoding utf8 }
    Remove-Item -LiteralPath $fn -Force -ErrorAction SilentlyContinue
  }
}

Log ('done: exit {0}' -f $code)
exit $code
