@echo off
:: ============================================================
::  Installs TradingView CDP auto-launch on Windows startup
::  Uses Task Scheduler (more reliable than Startup folder)
::  Run ONCE — right-click and "Run as administrator"
:: ============================================================

set SCRIPT=%~dp0launch-tv-cdp.ps1
set TASK_NAME=TradingView-CDP-AutoLaunch

:: Apply loopback exemption so CDP works with the Store version
echo Applying network loopback exemption for TradingView...
CheckNetIsolation.exe LoopbackExempt -a -n="TradingView.Desktop_n534cwy3pjxzj" >nul 2>&1

echo Creating scheduled task: %TASK_NAME%

:: Delete any existing task with this name
schtasks /Delete /TN "%TASK_NAME%" /F >nul 2>&1

:: Create new task: runs at logon, runs as current user, hidden window
schtasks /Create /TN "%TASK_NAME%" /TR "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%SCRIPT%\" -Silent" /SC ONLOGON /DELAY 0000:15 /RL HIGHEST /F

if %ERRORLEVEL% == 0 (
    echo.
    echo  SUCCESS! TradingView will launch with CDP automatically at every logon.
    echo.
    echo  Task name: %TASK_NAME%
    echo  To remove: run uninstall-startup.bat
    echo.
) else (
    echo.
    echo  ERROR: Could not create scheduled task.
    echo  Try right-clicking this file and selecting "Run as administrator".
    echo.
)
pause
