Dim oShell, scriptDir
Set oShell = CreateObject("WScript.Shell")
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))

' 1. Launch TradingView with CDP (hidden PS window, wait for it to finish activating)
oShell.Run "powershell -NoProfile -ExecutionPolicy Bypass -File """ & scriptDir & "launch_tv_debug.ps1""", 0, True

' 2. Start Claude Bot Dashboard server in background (hidden, from bot directory)
oShell.Run "cmd /c cd /d ""C:\Users\ricke\claude-tradingview-mcp-trading"" && node dashboard.js > nul 2>&1", 0, False

' 3. Give server 2.5 seconds to bind port 3333
WScript.Sleep 2500

' 4. Open Claude Bot Dashboard in default browser
oShell.Run "http://localhost:3333"

' 5. Open Railway logs in a new browser tab (short delay so tabs open in order)
WScript.Sleep 500
oShell.Run "https://railway.com/project/7c96f024-ef3a-4d2f-9afa-2d3d5cd9c67f/service/9a79abf1-7b9f-490b-be43-cee90b20e586"

' 6. Open Claude Code in a cmd window in the MCP project directory
WScript.Sleep 500
oShell.Run "cmd /k ""cd /d C:\Users\ricke\tradingview-mcp-jackson && claude""", 1, False
