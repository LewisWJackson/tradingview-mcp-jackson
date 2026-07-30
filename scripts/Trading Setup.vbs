Dim oShell, oVoice, scriptDir
Set oShell = CreateObject("WScript.Shell")
Set oVoice = CreateObject("SAPI.SpVoice")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' 0. Voice greeting
oVoice.Speak "Good morning. Starting your trading session."

' 0a. Start voice typing server now (needs time to bind before Chrome opens later)
oShell.Run "cmd /c node ""C:\Users\ricke\voice-server.js"" >nul 2>&1", 0, False

' 1. Launch TradingView with CDP (hidden PS window, wait for it to finish activating)
oShell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "launch_tv_debug.ps1""", 0, True

' 2. Pull latest bot/dashboard code (sync so server starts with fresh code)
oShell.Run "cmd /c cd /d ""C:\Users\ricke\claude-tradingview-mcp-trading"" && git pull --ff-only >nul 2>&1", 0, True

' 3. Start Claude Bot Dashboard server in background (hidden, from bot directory)
oShell.Run "cmd /c cd /d ""C:\Users\ricke\claude-tradingview-mcp-trading"" && node dashboard.js >nul 2>&1", 0, False

' 4. Give server 3 seconds to bind port 3333
WScript.Sleep 3000

' 5. Open Claude Bot Dashboard in default browser
oShell.Run "http://localhost:3333"

' 6. Open Railway logs in a new browser tab (short delay so tabs open in order)
WScript.Sleep 500
oShell.Run "https://railway.com/project/7c96f024-ef3a-4d2f-9afa-2d3d5cd9c67f/service/9a79abf1-7b9f-490b-be43-cee90b20e586"

' 7. Launch Hermes (gateway check + chat window)
WScript.Sleep 500
oShell.Run "wscript.exe ""C:\Users\ricke\AppData\Local\hermes\start_hermes.vbs""", 0, False

' 8. Open Claude Code in Windows Terminal (supports Win+H voice typing)
WScript.Sleep 500
oShell.Run "wt -d ""C:\Users\ricke\tradingview-mcp-jackson"" cmd /k claude", 1, False

' 9. Voice confirmation once everything is up
WScript.Sleep 2000
oVoice.Speak "Trading setup complete. Good luck today."

' 10. Bring TradingView to front (MSIX launch opens it in background)
WScript.Sleep 4000
oShell.AppActivate "TradingView"

' 11. Open voice typing widget last so it floats above TradingView
WScript.Sleep 1000
oShell.Run """C:\Program Files\Google\Chrome\Application\chrome.exe"" --app=http://localhost:7777 --window-size=360,390 --window-position=20,20", 1, False
