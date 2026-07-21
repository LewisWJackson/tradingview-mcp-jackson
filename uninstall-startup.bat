@echo off
set SHORTCUT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TradingView-CDP.lnk
if exist "%SHORTCUT%" (
    del "%SHORTCUT%"
    echo Removed TradingView CDP from Windows Startup.
) else (
    echo Startup shortcut not found - already removed.
)
pause
