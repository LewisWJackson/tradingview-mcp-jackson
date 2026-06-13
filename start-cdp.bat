@echo off
echo Starting TradingView Desktop with Chrome DevTools Protocol...
echo.

REM Kill any existing TradingView instances
echo Closing any existing TradingView instances...
taskkill /F /IM "TradingView.exe" 2>nul
timeout /t 2 /nobreak >nul

REM Launch TradingView with CDP enabled (port 9222)
echo Launching TradingView with CDP on port 9222...
start "" "C:\Program Files\WindowsApps\TradingView.Desktop_3.2.0.7916_x64__n534cwy3pjxzj\TradingView.exe" --remote-debugging-port=9222

echo.
echo TradingView is starting with CDP enabled...
echo Wait a few seconds, then you can use tv_health_check to verify the connection.
echo.