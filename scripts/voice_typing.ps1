# Start voice server (no-op if already running — server handles EADDRINUSE gracefully)
Start-Process "node" -ArgumentList "C:\Users\ricke\voice-server.js" -WindowStyle Hidden

# Give server a moment to bind if it was just started
Start-Sleep -Milliseconds 800

# Open the voice typing widget as a standalone Chrome app window
Start-Process "C:\Program Files\Google\Chrome\Application\chrome.exe" `
    -ArgumentList '--app=http://localhost:7777', '--window-size=360,390', '--window-position=20,20'
