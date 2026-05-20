@echo off
setlocal EnableDelayedExpansion

:: Check for administrator privileges — elevate via UAC if needed
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process cmd -ArgumentList '/c \"%~f0\"' -Verb RunAs"
    exit /b
)

echo [1/4] Stopping existing TradingView processes...
powershell -NoProfile -Command "Stop-Process -Name TradingView -Force -ErrorAction SilentlyContinue"
timeout /t 2 /nobreak >nul

echo [2/4] Locating TradingView (Microsoft Store / MSIX install)...
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "(Get-ChildItem 'C:\Program Files\WindowsApps\TradingView.Desktop_*_x64__n534cwy3pjxzj' -Recurse -Filter TradingView.exe -ErrorAction SilentlyContinue | Select-Object -First 1).FullName"`) do set "TV_PATH=%%i"

if "!TV_PATH!"=="" (
    echo.
    echo ERROR: TradingView not found in WindowsApps.
    echo To find it manually open PowerShell as Admin and run:
    echo   Get-ChildItem 'C:\Program Files\WindowsApps' -Recurse -Filter TradingView.exe
    echo.
    pause
    exit /b 1
)

echo Found: !TV_PATH!
echo [3/4] Launching with --remote-debugging-port=9222 ...
start "" "!TV_PATH!" --remote-debugging-port=9222

echo [4/4] Waiting for CDP to respond (max 60s)...
set /a TRIES=0
:wait_loop
    timeout /t 2 /nobreak >nul
    set /a TRIES+=1
    powershell -NoProfile -Command "try { Invoke-RestMethod http://localhost:9222/json/version -ErrorAction Stop | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
    if !errorlevel! equ 0 goto :cdp_ready
    if !TRIES! geq 30 goto :cdp_timeout
    echo    Intento !TRIES!/30...
    goto :wait_loop

:cdp_ready
echo.
echo  CDP listo en http://localhost:9222
echo  Abre Claude Code en C:\Users\juant\tradingview-mcp-jackson y ejecuta tv_health_check
echo.
pause
exit /b 0

:cdp_timeout
echo.
echo  ADVERTENCIA: CDP no responde tras 60s. TradingView puede seguir cargando.
echo  Espera un minuto y ejecuta tv_health_check en Claude Code.
echo.
pause
exit /b 0
