# Coiled Spring Live Feed — Operations Guide

This guide covers running the live feed locally: starting the server, enabling shadow mode, where output files live, and the planned autostart workflow.

## Start the live server

```bash
node scripts/dashboard/live_server.js
```

Then open http://localhost:3333 in your browser. The dashboard auto-builds on first request (this can take a few seconds the first time).

The server exposes:
- `GET /` — the dashboard HTML
- `GET /events` — Server-Sent Events stream for real-time tick / fire / source_status / scan_refreshed events

## Shadow mode (recommended for the first 2 weeks)

Run with the `SHADOW_MODE=1` environment variable to suppress Windows desktop toasts. Fires still fire — they're written to the audit log and shown as in-page banners — but no OS-level notification is dispatched.

```bash
SHADOW_MODE=1 node scripts/dashboard/live_server.js
```

When shadow mode is active:
- The server's startup banner shows `Shadow: ON`
- The Coiled Springs tab shows an orange `🛡 SHADOW MODE` banner at the top
- The fire banner gets a dashed white border as a visual tell

Use shadow mode while you tune the debouncing parameters and confirm fire-detection quality before enabling toasts in production.

## Files produced

| Path | Purpose |
|---|---|
| `data/coiled_spring_fires_YYYY-MM-DD.json` | Daily append-only fire audit log (one file per ET trading day). Full event payload including risk flags, audit metadata, fire-strength level, and the strict tradePlan placeholder. |
| `data/poller_state.json` | Poller in-memory state snapshot, written every 60s and on graceful shutdown. Used to restore detector state across server restarts. |
| `scripts/scanner/coiled_spring_results.json` | Latest scanner output (top 15 candidates with entry triggers). Read by the poller every cycle. |

## Polling cadence

| Event | Cadence |
|---|---|
| Quote fetch + fire detection | Every 15 seconds during market hours |
| State snapshot | Every 60 seconds |
| Scanner refresh | Every 30 minutes (existing) |
| Daily fire counter reset | At PRE_WARM transition (9:25 AM ET) |
| Recovery probe (when chain degraded) | Up to once per 5 minutes |

## Market-hours behavior

The poller respects NYSE hours via `data/nyse_calendar.json`:

| Mode | Window (ET) | Behavior |
|---|---|---|
| PRE_WARM | 9:25 – 9:30 AM | Polling on; fires detected (Phase A-G logic decides toast) |
| REGULAR | 9:30 AM – session close | Full operation |
| CLOSE_CAPTURE | session close to +5 min | Continues polling to capture closing prints |
| PAUSED | All other times | No polling, no SSE ticks |

PAUSED reasons surfaced: `weekend`, `holiday` (with `holiday: '<name>'`), `early_close`, `outside_hours`.

## Autostart on logon

Register the live server as a Windows scheduled task so it boots automatically each time you log in:

```powershell
./scripts/setup_autostart.ps1
```

This adds a task named **"TradingView Live Dashboard"** that:

- Triggers at logon of the current user
- Runs `node scripts/dashboard/live_server.js` in a minimized window
- Restarts up to 3 times if the process crashes (1-minute interval)
- Has unlimited execution time
- Logs combined stdout/stderr to `data/live_server.log`

To verify after registering:

```powershell
Get-ScheduledTask -TaskName 'TradingView Live Dashboard' | Format-List
```

To remove:

```powershell
./scripts/setup_autostart.ps1 -Remove
```

The script runs as your normal user (not Administrator), creates an interactive task, and is idempotent — running it again replaces any existing task with the same name.

**Shadow mode + autostart:** to run the autostarted server in shadow mode, edit the registered task's argument list and add `set SHADOW_MODE=1 &&` before the node invocation, OR re-register after exporting the variable persistently. (A `-ShadowMode` flag on the script is a future enhancement.)

## Reviewing a day's fires

Open the JSON directly:

```bash
cat data/coiled_spring_fires_2026-04-24.json | jq .fires[0]
```

Or use the (post-ship) outcome tagger CLI:

```bash
node scripts/dashboard/outcome_tagger.js --date=2026-04-24
```

## Stopping the server

`Ctrl+C` for a foreground process. The state store does NOT write on every fire — only every 60s — so a fast Ctrl+C may lose up to 60 seconds of state. The fire log is append-only and writes synchronously on every fire, so no fire data is ever lost.

## Common issues

**No fires showing up during market hours**

1. Check the server log for `[poller] tick error: ...` lines. If Yahoo is rate-limiting, the chain falls back to TradingView Desktop CDP — but CDP only works for symbols watched in your TV.
2. Confirm `scripts/scanner/coiled_spring_results.json` is fresh (< 30 minutes old). The scanner must produce a new file before the poller can re-evaluate.
3. Confirm the dashboard's source-status banner doesn't say "stale" — if it does, all fire detection is suppressed for safety.

**Toasts not appearing**

1. Confirm `window.__shadowMode === false` in the dashboard DevTools console.
2. Confirm `Notification.permission === "granted"` (re-grant via browser site settings if needed).
3. Some browsers block notifications in inactive tabs — the in-page banner still fires.

**Dashboard not updating in real time**

1. Open DevTools Network tab — `/events` should be a pending long-poll request.
2. Check for SSE reconnect messages in the source-status banner.
