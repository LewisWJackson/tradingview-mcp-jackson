# Live Dashboard

This project includes a read-only live dashboard for monitoring:

- TradingView MCP CDP health
- Current active TradingView chart, quote, OHLCV summary, and visible study values
- Paper trading equity, realized PnL, latest unrealized PnL, open positions, closed trade events, and recent signals
- Report freshness and Git working tree status

It is informational only. It does not place trades, create or change alerts, or modify watchlists.

## Local Run

PowerShell:

```powershell
$env:DASHBOARD_TOKEN = "replace-with-a-long-random-token"
npm run dashboard -- --host=127.0.0.1 --port=8787
```

Open:

```text
http://127.0.0.1:8787/?token=replace-with-a-long-random-token
```

If `DASHBOARD_TOKEN` is not set, the server generates a one-time token and prints a full local URL.

Useful options:

```text
DASHBOARD_HOST=127.0.0.1       # default; recommended
DASHBOARD_PORT=8787            # default
DASHBOARD_TOKEN=<secret>       # protects /api/status and /api/report.md
DASHBOARD_REFRESH_MS=3000      # dashboard live refresh/cache window
DASHBOARD_LIVE_CDP=0           # disable live TradingView reads, keep paper-data only
```

The server refuses non-loopback hosts by default. Cloudflare Tunnel does not need `0.0.0.0`; point it to `http://127.0.0.1:8787`.

## Cloudflare Quick Tunnel

For a temporary public URL:

```powershell
cloudflared tunnel --url http://127.0.0.1:8787
```

Cloudflare prints a public URL. Open it with the dashboard token:

```text
https://<generated-host>.trycloudflare.com/?token=<dashboard-token>
```

For automatic Quick Tunnel startup on Windows, use:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\start_cloudflare_quick_tunnel.ps1
```

The latest generated URLs are written to:

```text
paper-data\tunnel-url.txt
paper-data\tunnel-dashboard-url.txt
```

Quick Tunnel URLs change when the tunnel restarts.

## Cloudflare Named Tunnel

For a stable hostname:

```powershell
cloudflared tunnel login
cloudflared tunnel create tradingview-dashboard
```

Copy `config/cloudflared-dashboard.example.yml` to your cloudflared config path and replace:

- `<TUNNEL-UUID>`
- `C:\Users\<YOU>\.cloudflared\<TUNNEL-UUID>.json`
- `dashboard.example.com`

Then route DNS and run:

```powershell
cloudflared tunnel route dns tradingview-dashboard dashboard.example.com
cloudflared tunnel run tradingview-dashboard
```

Recommended production hardening:

- Put the hostname behind Cloudflare Access or equivalent SSO.
- Keep `DASHBOARD_TOKEN` enabled even when Cloudflare Access is enabled.
- Run `cloudflared` as a service if the dashboard should survive restarts.

## API

The dashboard UI uses:

```text
GET /api/status
GET /api/report.md
```

Both require:

```text
Authorization: Bearer <dashboard-token>
```

The HTML shell itself is public, but it contains no PnL or TradingView data until a valid token is supplied.

## Safety

- Do not expose `localhost:9222` to the LAN or internet.
- Do not tunnel MCP stdio.
- Tunnel only the dashboard service: `http://127.0.0.1:8787`.
- Treat all dashboard output as informational only, not financial advice.
- The dashboard reads live chart state, but it never sends chart-changing commands.

## Candidate Selection

The paper system does not depend on a manually maintained TradingView watchlist by default. It reads `config\universe.default.json`, rotates through that larger multi-asset pool, and preselects candidates using daily trend, momentum, relative strength, RSI, ATR, and liquidity checks.

Each symbol is scored both ways:

- `LONG`: upward trend, constructive momentum, and relative strength.
- `SHORT`: downward trend, negative momentum, and bearish reset conditions.

The stronger side is shown in the dashboard candidate table. The strategy still waits for MTF pullback/trigger conditions before opening a virtual position, so a candidate is not automatically a paper trade.

## Windows Automation

Install the scheduled tasks:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\install_windows_tasks.ps1
```

This installs:

```text
TV MCP Dashboard                 # starts the local read-only dashboard at logon
TV MCP Cloudflare Quick Tunnel   # starts a Quick Tunnel at logon
TV MCP Paper Scan 15m            # runs paper scan every 15 minutes
```

Start them immediately:

```powershell
schtasks /Run /TN "TV MCP Dashboard"
schtasks /Run /TN "TV MCP Cloudflare Quick Tunnel"
schtasks /Run /TN "TV MCP Paper Scan 15m"
```

Check current status:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\dashboard_status.ps1
```

The paper scan runner uses `paper-data\mtf_paper.lock` as an atomic lock directory to avoid overlapping scans. If a previous run crashes, locks older than four hours are treated as stale and removed automatically.
