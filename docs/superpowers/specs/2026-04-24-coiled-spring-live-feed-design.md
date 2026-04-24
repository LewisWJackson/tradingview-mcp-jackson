# Coiled Spring Live Feed — Design Spec

**Date:** 2026-04-24
**Owner:** Lauren Murphy
**Status:** Approved, ready for implementation planning

---

## 1. Purpose

Turn the coiled spring screener from a periodic snapshot into a live feed that surfaces **in-the-moment** guidance when a candidate crosses its alert trigger.

Today's workflow: run the scanner, look at a static JSON that shows "APH alert at $152.81," and hope you notice when it actually crosses. Tomorrow's workflow: the dashboard pings you with a Windows toast the moment APH touches $152.81, so you can act on the setup without babysitting the tab.

## 2. Success criteria

- Top-15 candidate prices refresh in the dashboard every 15 seconds during regular trading hours (9:30 AM – 4:00 PM ET, Mon–Fri).
- When a candidate crosses its alert trigger, the user sees a visible banner in the dashboard **and** a Windows desktop toast within one polling cycle (≤15s after the cross).
- The fire event persists in a daily log (`coiled_spring_fires_YYYY-MM-DD.json`) so post-close review is possible even after closing the browser.
- The live feed runs automatically when the user logs into Windows — no manual startup required.
- After-hours and weekend prices are not polled (no spurious fires from thin prints).
- A notification for a given ticker fires **once** per arm/fire cycle — no spam if the price hovers around the trigger.

## 3. Non-goals (explicit YAGNI)

- Phone push notifications (Pushover / ntfy.sh) — dashboard + desktop toast is enough
- TradingView auto-alert creation
- Multi-timeframe (intraday scans) — scanner stays daily, live feed only watches the daily top-15
- Position-aware filtering (all top 15 get watched; user judges whether to act)
- Historical fire analytics / backtest dashboard (out of scope, can be a follow-up)

## 4. Architecture

```
                         ┌─────────────────────────────┐
                         │  live_server.js (always on) │
                         └──────────┬──────────────────┘
                                    │
     ┌──────────────────────────────┼─────────────────────────────┐
     │                              │                             │
     ▼                              ▼                             ▼
┌──────────┐             ┌──────────────────┐          ┌──────────────┐
│ Scanner  │             │  Price Poller    │          │ HTTP server  │
│ every 30m│             │  every 15s (RTH) │          │  + SSE feed  │
│ writes   │             │  reads top 15    │          │  port 3333   │
│ results  │             │  Yahoo batch     │          └──────┬───────┘
│  .json   │             │  detects fires   │                 │
└──────────┘             └──────┬───────────┘                 │
                                │                             │
                                ▼                             ▼
                     ┌─────────────────────┐        ┌──────────────────┐
                     │ fires_YYYY-MM-DD    │        │  Dashboard.html  │
                     │ .json               │◀──────▶│  SSE client +    │
                     │ (daily fire log)    │        │  Notification API│
                     └─────────────────────┘        └──────────────────┘
                                                           │
                                                           ▼
                                                 ┌──────────────────┐
                                                 │ Windows toast    │
                                                 │ "LIN fired @     │
                                                 │  $510.56"        │
                                                 └──────────────────┘
```

The three green boxes (Scanner, Poller, HTTP server) live inside one long-running Node process: `live_server.js`. The scanner already runs on a 30-minute interval via `live_server.js`. The poller and SSE feed are additive; existing behavior is untouched.

## 5. Components

### 5.1 `scripts/scanner/live_price_poller.js` (new, ~100 LOC)

Standalone module exporting a single function:

```js
startPolling({
  getCandidates,   // () => [{symbol, trigger, confidence, setupType}, ...]
  intervalMs,      // default 15_000
  onFire,          // ({symbol, trigger, firedPrice, timestamp, ...}) => void
  onTick,          // optional — ({symbol, price, ...}) => void for UI updates
  onError,         // (err) => void
})
```

Responsibilities:
- Market-hours gate: skip cycles outside 9:30 AM – 4:00 PM ET (Mon–Fri) using `Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York' })`.
- One Yahoo batch quote request per cycle for all candidates (≤50 symbols per batch).
- Per-ticker state machine: `ARMED → FIRED`. Edge-triggered: fire callback runs **once** when the price first crosses `trigger`. Re-arms if price drops back below.
- Exponential backoff on HTTP errors: 15s → 30s → 60s → 120s. Calls `onError` with the latest status.
- Refreshes its watchlist automatically when the input from `getCandidates()` changes (new scanner output → new top 15).

### 5.2 `scripts/dashboard/fire_events.js` (new, ~60 LOC)

Fire event store:

```js
recordFire({ ticker, trigger, firedPrice, timestamp, confidence, setupType })
  → appends to coiled_spring_fires_YYYY-MM-DD.json (creates if missing)

getTodaysFires()
  → returns array of today's fires for dashboard hydration

getFiresForDate(dateStr)
  → returns array of fires for a given date (for future review tooling)
```

Date resolution uses the `America/New_York` timezone (the "trading day") so the file doesn't roll over at local midnight in other zones.

### 5.3 `scripts/dashboard/live_server.js` (modified, additive only)

Three changes:

1. **Spin up the poller** on startup. The poller's `getCandidates()` is wired to read `coiled_spring_results.json` fresh on each cycle so it picks up scanner refreshes automatically.
2. **Expose `/events` as a Server-Sent Events endpoint.** One persistent HTTP connection per open dashboard tab. Events:
   - `fire` — when a candidate crosses its trigger
   - `tick` — 15-second price updates for the top 15
   - `scan_refreshed` — when the scanner JSON updates
3. **On poller `onFire`:** record via `fire_events.js`, broadcast SSE `fire` event to all connected clients.

Existing behavior unchanged: the 60s rebuild interval, options cache, news fetch, scanner runner.

### 5.4 `scripts/dashboard/build_dashboard_html.js` (modified)

Additive UI layer:

- **Notification permission request** on page load (one-time prompt). If denied, dashboard still works — only the toast channel is lost.
- **SSE client** (`new EventSource('/events')`) that handles `tick` / `fire` / `scan_refreshed` events without full page reload. Replaces the 60s meta-refresh for the Coiled Springs tab only; other tabs keep meta-refresh.
- **Top banner** (hidden by default, fades in on `fire`): shows ticker, fired price, and time. Auto-fades after 60 seconds, dismissible by click.
- **Live price + Δ-to-trigger column** on the Coiled Springs tab, updated on each `tick`.
- **"FIRED TODAY" sticky badge** on any row that fired today (hydrated on page load from `getTodaysFires()`, updated in real time via SSE). Stays lit all day even if price drops back below trigger.
- **"Today's fires" section** at the top of the Coiled Springs tab listing every fire with time + price.

### 5.5 `scripts/setup_autostart.ps1` (new, ~40 LOC)

PowerShell script that registers a Windows Task Scheduler entry:

- **Name:** `TradingView Live Dashboard`
- **Trigger:** At logon of the current user
- **Action:** `node C:\Users\lam61\tradingview-mcp-jackson\scripts\dashboard\live_server.js`
- **Settings:** runs whether user is logged on or not = **no** (only when logged in); restart on failure (up to 3 retries, 1-minute delay)
- **Window:** minimized (not hidden — you can still see the logs by clicking the taskbar icon)

Idempotent: if the task already exists, updates it. Provides an `unregister` mode (`setup_autostart.ps1 -Remove`) for cleanup.

## 6. Data formats

### 6.1 `coiled_spring_fires_YYYY-MM-DD.json`

```json
{
  "date": "2026-04-24",
  "fires": [
    {
      "ticker": "LIN",
      "trigger": 510.41,
      "firedPrice": 510.56,
      "timestamp": "2026-04-24T17:45:13.000Z",
      "confidence": "MODERATE",
      "setupType": "building_base",
      "rank": 15
    }
  ]
}
```

One file per trading day. Created lazily on first fire.

### 6.2 SSE event payloads

```
event: tick
data: {"symbol":"LIN","price":510.56,"change":0.12,"timestamp":"..."}

event: fire
data: {"ticker":"LIN","trigger":510.41,"firedPrice":510.56,"timestamp":"...","confidence":"MODERATE","setupType":"building_base","rank":15}

event: scan_refreshed
data: {"generatedAt":"...","universe":1273,"top":[...]}
```

## 7. Error handling

| Failure mode | Behavior |
|---|---|
| Yahoo API 429/5xx | Exponential backoff (15s → 30s → 60s → 120s). Dashboard shows "quote feed paused — retrying" indicator. Poller keeps retrying indefinitely. |
| Yahoo returns partial batch | Use the quotes we got, log missing symbols, retry on next cycle. |
| `coiled_spring_results.json` missing or unparseable | Poller pauses. Dashboard banner: "Scanner output missing — awaiting first scan." |
| SSE client disconnects | Browser's `EventSource` auto-reconnects. Server tolerates any number of clients (each is its own long-lived response). |
| Server crashes | Task Scheduler re-runs the node process on next logon. Daily fire log on disk means history isn't lost. Running fires for tickers that had already fired will not re-fire (state is lost on crash, but the log on disk prevents duplicate notifications on reload — see §8). |
| Candidate drops out of top 15 mid-day | Poller drops it on next `getCandidates()` refresh. A fire that already happened stays logged; the row is removed from the Coiled Springs table (but remains in "Today's fires" section). |
| After hours / weekend | Poller skips cycles. No SSE ticks emitted. Dashboard shows "Market closed — live feed paused." |
| Notification permission denied | Dashboard banner + sticky badges still work. One-line hint: "Enable notifications in browser for desktop alerts." |

## 8. State & persistence

- **In-memory state:** poller's per-ticker `ARMED`/`FIRED` status. Lost on process restart.
- **On-disk state:** `coiled_spring_fires_YYYY-MM-DD.json` (fires), `coiled_spring_results.json` (scanner output, existing).
- **On restart:** poller reads today's fire log and starts each ticker in its correct state — tickers that already fired today and whose price is still above trigger stay `FIRED` (no re-notification); tickers that fired but dropped back below go to `ARMED`.

## 9. Testing approach

### Unit tests
- **Market-hours gate** — mock `Date`, verify it gates at 9:30 AM and 4:00 PM ET precisely, including DST transitions.
- **Fire detector** — feed a sequence of prices per ticker, verify edge-triggered callback fires exactly once per arm/fire cycle.
- **Fire log persistence** — write, read, verify schema and timezone handling.

### Integration tests
- Poller + mock Yahoo responses (fixture data) → fires broadcast to SSE mock → log written correctly.

### Manual E2E
1. Start `live_server.js` during market hours.
2. Temporarily edit `coiled_spring_results.json` to lower one candidate's `entry_trigger` below its current price.
3. Verify: dashboard banner appears within 15s, Windows toast fires, `coiled_spring_fires_YYYY-MM-DD.json` contains the event.
4. Revert the edit; verify row remains "FIRED TODAY" (sticky badge) but no duplicate notification.

## 10. Open design decisions (approved defaults)

| Decision | Chosen | Alternative considered |
|---|---|---|
| Price refresh cadence | **15 seconds** | 5s (too aggressive for Yahoo), 30s (less live-feel) |
| Notification channel | **Dashboard banner + Windows desktop toast** | Phone push, TradingView alerts, chat |
| Market-hours window | **9:30 AM – 4:00 PM ET only** | Extended hours, 24/7 |
| Auto-start mechanism | **Windows Task Scheduler at logon** | Manual start, Windows Service |
| Scanner cadence | **Keep 30 min** (existing) | Faster (stage 1 bottleneck makes this expensive) |
| Toast dismissal | **Auto-fade after 60s in dashboard; Windows action center keeps the toast** | Sticky until clicked |
| SSE scope | **Coiled Springs tab only; other tabs keep 60s meta-refresh** | Live everywhere (scope creep) |
| Fire semantics | **Edge-triggered, one fire per arm/fire cycle** | Fire on every tick above trigger (too spammy) |

## 11. Implementation order (for the plan)

1. **Extract candidate reader** — utility that parses `coiled_spring_results.json` → top-15 list with `{symbol, trigger, ...}`.
2. **Market-hours gate utility** — small helper with unit tests.
3. **`live_price_poller.js`** — core module with fire detection, in-memory state, unit tests.
4. **`fire_events.js`** — persistence layer with unit tests.
5. **SSE endpoint in `live_server.js`** — plumbing without UI changes yet.
6. **Dashboard SSE client + banner + sticky badges + live price column** — UI layer.
7. **Notification API integration** — browser permission + toast dispatch.
8. **`setup_autostart.ps1`** — Task Scheduler registration.
9. **Manual E2E test** — full loop with synthetic fire.

Each step is independently testable and leaves the system in a working state.
