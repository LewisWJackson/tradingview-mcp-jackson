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

### 5.1 `scripts/scanner/live_price_poller.js` (new, ~180 LOC)

Standalone module exporting a single function:

```js
startPolling({
  getCandidates,   // () => [{symbol, trigger, confidence, setupType}, ...]
  intervalMs,      // default 15_000
  onFire,          // ({symbol, trigger, firedPrice, timestamp, ...}) => void
  onTick,          // optional — ({symbol, price, ...}) => void for UI updates
  onError,         // (err) => void
  quoteSource,     // optional override: default = fallback chain (§12)
})
```

Responsibilities:
- **Market-hours gate** (see §7 for full behavior including holidays, halts, early close days).
- Fetches quotes via the **data-source fallback chain** (see §12).
- Per-ticker state machine: `ARMED → PENDING → FIRED`. See §13 for debouncing rules.
- **Edge-triggered** fire callback: runs once per arm/fire cycle. Re-arms only when hysteresis condition in §13 is met.
- **Circuit breaker**: after 5 consecutive quote-fetch failures across all data sources, pauses for 5 minutes and emits `onError({type:'circuit_open'})`. Resumes with a single probe request before restoring full polling.
- Refreshes its watchlist automatically when the input from `getCandidates()` changes (new scanner output → new top 15).
- **Gap detection**: on first poll of the day, compares current price to prior close; if |gap| > 2% OR > 2× 14-day ATR, tags the ticker's watch state with `gap_risk=true` (feeds into §14 risk flags).

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

### 6.1 `coiled_spring_fires_YYYY-MM-DD.json` — fire audit log

Every fire event captures **full context at the moment of fire** so we can do post-hoc analysis ("why did this fire, was it real, did the risk flags predict well").

```json
{
  "date": "2026-04-24",
  "fires": [
    {
      "eventId": "uuid-v4",
      "ticker": "LIN",
      "firedAt": "2026-04-24T17:45:13.000Z",
      "firedAtET": "2026-04-24 13:45:13 EDT",
      "pollSequence": 847,

      "trigger": {
        "level": 510.41,
        "source": "scanner_v3",
        "scanRunId": "20260424T133000Z",
        "entryTriggerText": "watchlist — alert at 510.41"
      },

      "price": {
        "firedPrice": 510.56,
        "bid": 510.48,
        "ask": 510.62,
        "spreadAbsolute": 0.14,
        "spreadPctOfPrice": 0.027,
        "quoteSource": "yahoo",
        "quoteAgeMs": 312,
        "openToday": 505.12,
        "prevClose": 504.88,
        "dayChangePct": 1.12,
        "gapFromPrevClose": 0.048
      },

      "debounce": {
        "confirmPollCount": 2,
        "firstCrossObservedAt": "2026-04-24T17:44:58.000Z",
        "confirmedAt": "2026-04-24T17:45:13.000Z",
        "latencyFromFirstCrossMs": 15000
      },

      "setup": {
        "confidence": "MODERATE",
        "confidenceBand": {"low": 54, "mid": 59, "high": 64},
        "setupType": "building_base",
        "compositeScore": 64,
        "probabilityScore": 60,
        "rank": 15
      },

      "marketContext": {
        "vix": 18.63,
        "vixRegime": "constructive",
        "spxChangePct": 0.70,
        "qqqChangePct": 1.75,
        "regimeMultiplier": 1.0,
        "sectorMomentumRank": 6
      },

      "riskFlags": {
        "earnings": {"active": false, "daysUntil": null},
        "liquidity": {"flag": "ok", "avgDailyVol": 3214500, "todayRelVolAtFire": 1.14},
        "spread": {"flag": "ok", "bpsOfPrice": 2.7},
        "newsGap": {"flag": "ok", "todayGapSigma": 0.4},
        "mergerPending": false,
        "shortFloatPct": 0,
        "recentNewsCount24h": 2,
        "overallRiskBand": "green"
      },

      "deliveryStatus": {
        "sseBroadcast": true,
        "toastDispatched": true,
        "recorded": true
      }
    }
  ]
}
```

**Field meanings:**
- `eventId` — UUID so we can reference a fire uniquely in later tooling
- `pollSequence` — which poll cycle fired; lets us reconstruct the full tick history for a session
- `trigger.scanRunId` — timestamp of the scanner output that set this trigger; pins the fire to a specific scanner snapshot
- `price.quoteAgeMs` — how fresh the Yahoo response was when we compared to trigger; >2s is suspicious
- `price.bid/ask/spreadPctOfPrice` — captured at fire time, used for "wide spread" risk flag
- `debounce.firstCrossObservedAt` vs `confirmedAt` — measures how long the price was above trigger before we confirmed
- `marketContext` — snapshot of broader market so we can ask later "did fires in risk-off regimes perform worse?"
- `riskFlags` — populated from the sources in §14; `overallRiskBand` is green/yellow/red summary

One file per trading day, named by the **America/New_York trading date** (not local date). Created lazily on first fire.

### 6.2 `poller_state.json` — in-memory state, persisted for crash recovery

Written every 60 seconds and on graceful shutdown. Used on startup to resume without losing `FIRED` state (§8).

```json
{
  "asOf": "2026-04-24T17:45:20.000Z",
  "tickers": {
    "LIN":  {"state": "FIRED",   "trigger": 510.41, "lastPrice": 510.56, "lastPollAt": "...", "firedEventId": "..."},
    "APH":  {"state": "ARMED",   "trigger": 152.81, "lastPrice": 150.38, "lastPollAt": "...", "firedEventId": null},
    "ITT":  {"state": "PENDING", "trigger": 221.69, "lastPrice": 221.82, "lastPollAt": "...", "pendingSince": "...", "confirmsSeen": 1}
  },
  "circuitBreaker": {"status": "closed", "consecutiveFailures": 0, "openedAt": null}
}
```

### 6.3 SSE event payloads

```
event: tick
data: {"symbol":"LIN","price":510.56,"change":0.12,"timestamp":"..."}

event: fire
data: {"ticker":"LIN","trigger":510.41,"firedPrice":510.56,"timestamp":"...","confidence":"MODERATE","setupType":"building_base","rank":15}

event: scan_refreshed
data: {"generatedAt":"...","universe":1273,"top":[...]}
```

## 7. Error handling & market-hours behavior

### 7.1 Market-hours state machine

The poller has four runtime modes driven by the `America/New_York` clock and a market-calendar file:

| Mode | Window (ET) | Behavior |
|---|---|---|
| **PRE_WARM** | 9:25 – 9:30 AM | Poll at 15s to warm caches and detect gap-ups *before* the bell. Fires are **suppressed** (audit-logged but no toast) so the opening cross is logged but not noisy. |
| **REGULAR**        | 9:30 AM – 3:59:59 PM | Full polling + fire detection + notification. |
| **CLOSE_CAPTURE**  | 4:00 PM – 4:04:59 PM | Keep polling for 5 extra minutes to capture the closing auction print. Fires in this window are tagged `session: closing_auction`. |
| **PAUSED** | All other times (including weekends, holidays, early-close afternoons, market halts) | No polling, no SSE ticks. Dashboard shows "Market closed — live feed paused" with the next session time. |

**Market-calendar file** (`data/nyse_calendar.json`, manually maintained / regenerated yearly) lists:
- Full market closures (New Year, MLK, Presidents Day, Good Friday, Memorial Day, Juneteenth, July 4, Labor Day, Thanksgiving, Christmas)
- Early-close days (1:00 PM ET close on day after Thanksgiving, Christmas Eve when weekday, etc.)
- Format: `{"date": "2026-12-25", "status": "closed"}` or `{"date": "2026-11-27", "status": "early_close", "closeTimeET": "13:00"}`

**DST handling:** `America/New_York` IANA timezone handles EST/EDT transitions automatically. Tests must cover the two transition days.

### 7.2 Failure modes

| Failure mode | Behavior |
|---|---|
| Yahoo HTTP 429 (rate limit) | Exponential backoff **per source**: 15s → 30s → 60s → 120s → 300s (cap). After 5 consecutive failures, flip to fallback source (§12). Dashboard shows amber "rate limited — retrying." |
| Yahoo HTTP 5xx / timeout | Same backoff as 429. After 3 timeouts in 5 minutes, flip to fallback. |
| Yahoo HTTP 401 (crumb expired) | Re-authenticate via `getCrumb()`, retry once. If re-auth itself fails, flip to fallback. |
| Yahoo returns partial batch (missing symbols) | Use the quotes we got. Symbols without a quote this cycle retain their prior `lastPrice` and are tagged `stale` in `onTick`; **fire detection is skipped for stale tickers** to prevent false fires from stale data. Retry on next cycle. |
| All data sources failing | Circuit breaker opens (§5.1). Dashboard shows red "ALL QUOTE SOURCES DOWN — feed suspended." No polling for 5 min, then probe. |
| `coiled_spring_results.json` missing or unparseable | Poller pauses. Dashboard banner: "Scanner output missing — awaiting first scan." Polling resumes automatically when a valid file appears. |
| SSE client disconnects | Browser's `EventSource` auto-reconnects with exponential backoff. Server tolerates unlimited clients (each is its own long-lived response, no shared state). |
| Server crashes | Task Scheduler re-runs node on next logon. `poller_state.json` (§6.2) + daily fire log restore state. Tickers still `FIRED` with price still above trigger are **not re-notified**. |
| Candidate drops out of top 15 mid-day (new scan) | Poller drops it on next `getCandidates()` refresh. A fire that already happened stays in the daily log and in the "Today's fires" section. The row disappears from the live table. |
| Ticker halted | Yahoo will return the last trade with a stale timestamp. Poller detects `quoteAgeMs > 60s` and marks the ticker `halted` in UI. No fire triggered on halt-period prints. Re-enters active state when a fresh timestamp appears. |
| Notification permission denied | Dashboard banner + sticky badges still work. Hint shows: "Enable browser notifications for desktop alerts." |
| Scanner output changes mid-cycle | Poller uses the **start-of-cycle snapshot** of candidates; a mid-cycle scan refresh doesn't destabilize the current poll. New tickers pick up on the next cycle. |

## 8. State & persistence

- **In-memory state:** poller's per-ticker `ARMED`/`PENDING`/`FIRED` status (see §13 for the full state machine), plus `pendingSince`, `confirmsSeen`, and circuit-breaker status.
- **On-disk state:**
  - `coiled_spring_fires_YYYY-MM-DD.json` — append-only daily fire audit log (§6.1)
  - `poller_state.json` — snapshot of in-memory state, written every 60s and on graceful shutdown (§6.2)
  - `coiled_spring_results.json` — scanner output, existing
- **On restart**, the poller:
  1. Reads `poller_state.json` if present and fresh (< 10 min old); if stale or missing, initializes all tickers as `ARMED`.
  2. Reads today's fire log and cross-checks: tickers that fired today and whose latest observed price is still above trigger stay `FIRED` (no duplicate notification); tickers that dropped below trigger since their fire go to `ARMED` (eligible to fire again if hysteresis condition met).
  3. Re-evaluates state on next poll — a ticker may be promoted to `PENDING` if price is above trigger, then `FIRED` if the confirm count hits N (§13).

## 9. Testing approach

### Unit tests
- **Market-hours gate** — mock `Date`, verify gates at 9:30 AM / 4:00 PM ET precisely. Covers holidays, early-close days, DST-transition weekends, pre-warm window, close-capture window.
- **Fire detector state machine** — fixtures for:
  - Clean breakout (steady rise through trigger, N confirms) → fires once
  - Whipsaw (spike through, revert, spike through again within same cycle) → does not fire
  - Revert then re-cross with hysteresis met → fires second time
  - Revert then re-cross *without* hysteresis met (< 0.5% pullback) → does not fire
  - Daily cap exceeded → third cross suppressed + logged
  - Stale-data guard (quoteAgeMs > 5s) → fire blocked
- **Risk flag evaluators** — pure-function tests for each dimension in §14.1 using fixture quote + scanner data.
- **Fallback chain** — mock Yahoo failures, verify flip to TV CDP, verify recovery probe, verify stale-mode suppression of fires.
- **Fire log & poller state persistence** — write, read, verify schema, NYC-timezone date resolution, restart-state reconstruction.
- **Earnings sentinel handling** — feed the corrupt `earningsDaysOut: -20547` input, verify flag falls back to yellow (not green).

### Integration tests
- **End-to-end mock run** — poller + mocked fallback chain + real `fire_events.js` + real SSE server + test SSE client. Simulate one clean fire, one whipsaw-no-fire, one degraded-source fire, one post-close fire (suppressed).
- **Market-hours rollover** — simulate clock crossing 9:30 AM and 4:00 PM during a test run; verify state transitions.

### Manual E2E
1. Start `live_server.js` during market hours.
2. Temporarily edit `coiled_spring_results.json` to lower one candidate's `entry_trigger` below its current price.
3. Verify: dashboard banner appears within ~30s (§13 debouncing), Windows toast fires, `coiled_spring_fires_YYYY-MM-DD.json` contains the full audit event with all §6.1 fields populated.
4. Revert the edit; verify row remains "FIRED TODAY" (sticky badge) but no duplicate notification on next scan refresh.
5. **Fallback test**: kill the network briefly (airplane mode 30s), verify dashboard shows "quote feed paused — retrying" and recovers when network returns.
6. **Shadow mode test**: enable shadow mode flag, trigger a fire; verify dashboard banner + log entry but **no** Windows toast dispatched.

## 10. Open design decisions (approved defaults)

| Decision | Chosen | Alternative considered |
|---|---|---|
| Price refresh cadence | **15 seconds** | 5s (too aggressive for Yahoo), 30s (less live-feel) |
| Notification channel | **Dashboard banner + Windows desktop toast** | Phone push, TradingView alerts, chat |
| Market-hours window | **9:30 AM – 4:00 PM ET only** (plus 5-min pre-warm + 5-min close-capture) | Extended hours, 24/7 |
| Auto-start mechanism | **Windows Task Scheduler at logon** | Manual start, Windows Service |
| Scanner cadence | **Keep 30 min** (existing) | Faster (stage 1 bottleneck makes this expensive) |
| Toast dismissal | **Auto-fade after 60s in dashboard; Windows action center keeps the toast** | Sticky until clicked |
| SSE scope | **Coiled Springs tab only; other tabs keep 60s meta-refresh** | Live everywhere (scope creep) |
| Fire semantics | **Edge-triggered, three-state (ARMED/PENDING/FIRED), 2-poll confirmation, 0.5% hysteresis on re-arm, max 2 fires/ticker/day** | One-state (fire on any cross — too spammy) |
| Fallback quote source | **Yahoo → TradingView CDP → stale cache (fire suppressed)** | Yahoo-only (brittle), paid feed (cost) |
| Pre-ship validation | **2-week shadow mode with manual outcome tagging** | Ship with toasts on day 1 |
| Risk-flag strictness | **Default "notify all fires"; optional toggle to suppress red-flag toasts** | Default to suppress red (too paternalistic) |

## 11. Data-source fallback chain

Yahoo is unreliable on busy days (we saw timeouts today on stage-1 scans). The poller must degrade gracefully, not silently.

### 11.1 Source chain (in priority order)

| # | Source | When used | Latency | Notes |
|---|---|---|---|---|
| 1 | **Yahoo Finance batch quote API** | Default | ~300–800ms | 1 HTTP request for up to 50 symbols. Already used by `gen_brief.js`. |
| 2 | **TradingView CDP (`quote_get` MCP tool)** | Yahoo down or 5+ consecutive failures | ~200ms per symbol | Requires TradingView Desktop running with CDP on :9222. Slower per-symbol but no rate limit. **Only the symbols currently on the user's TV chart watchlist will have data** — symbols not watched in TV return `null`. |
| 3 | **Stale cache** (last known price) | Both sources down | 0ms | Returns last price with `quoteAgeMs` set to true age. Fire detection is **suppressed** for stale-source prices. Dashboard shows "stale" badge. |

### 11.2 Flip triggers

- **Yahoo → TradingView**: 5 consecutive poll cycles with any HTTP failure, OR 3 consecutive 429s, OR a 401 that re-auth can't recover.
- **TradingView → stale**: CDP unreachable (no :9222 connection), or CDP returns errors for >50% of symbols.
- **Recovery**: every 5 minutes while in a degraded state, the poller sends a single probe to the primary source. On success, flips back up the chain and resumes normal operation. An audit event `source_switched` is emitted.

### 11.3 Source labeling

Every `tick` and `fire` event carries `quoteSource: "yahoo" | "tv_cdp" | "stale"` so downstream can tell where the number came from. Fires sourced from `tv_cdp` are marked in the audit log with `degradedMode: true`. Fires from `stale` **cannot happen** — detection is gated.

### 11.4 TradingView CDP bootstrap

On poller startup, probe the TV MCP connection once:
- If reachable, log `[poller] tv_cdp fallback available`.
- If not, log a warning; chain shortens to Yahoo → stale only.

This check runs once at startup and again whenever Yahoo degrades. No continuous heartbeat.

---

## 12. Score stability & debouncing

A naive "price > trigger = fire" implementation is noisy. Stocks whipsaw around breakout levels. Quote feeds occasionally return a single aberrant tick. The poller needs to distinguish real crosses from noise.

### 12.1 Fire confirmation (PENDING state)

The state machine is **`ARMED → PENDING → FIRED`**, not just two states.

- **ARMED**: price below trigger. Default state on startup (unless restored from `poller_state.json`).
- **PENDING**: price observed above trigger on one poll. Waiting for confirmation.
- **FIRED**: price observed above trigger on **N consecutive polls**.

**Default N = 2 polls = 30 seconds above trigger.** Tunable via config. This means:
- A one-tick spike through the trigger that reverts on the next 15s poll → **no fire**
- A sustained push that stays above for 30+ seconds → fire, event logged

`PENDING` state is visible in `poller_state.json` and surfaces in the dashboard as an amber "probing trigger" badge on the row.

### 12.2 Re-arm hysteresis

After `FIRED`, the ticker will not re-fire until it drops materially below the trigger. Threshold: **0.5% below trigger** (tunable). Example for APH (trigger $152.81): must drop below $152.05 to re-arm. A brief dip to $152.70 does not re-arm.

Without hysteresis, a ticker oscillating around the trigger by a few cents could fire repeatedly. With it, we get a meaningful "up, then meaningful pullback, then up again" pattern before a second fire.

### 12.3 Max fires per ticker per day

Even with hysteresis, a very volatile stock could theoretically fire 3–4 times in a day. Cap: **2 fires per ticker per trading day**. Additional crosses are logged as `fire_suppressed_daily_cap` in the audit log but don't notify.

### 12.4 Stale-data guard

Fire detection requires `quoteAgeMs < 5000`. Any `PENDING → FIRED` transition where the latest quote is older than 5 seconds is blocked and logged as `fire_suppressed_stale`.

### 12.5 Scanner score-change debouncing

If the scanner refresh changes a ticker's `entry_trigger` value mid-day (rare but possible — the 20-day high can update), the poller updates the trigger but **preserves the current state**. A ticker that was `FIRED` at the old trigger stays `FIRED`; the new trigger is used for the next arm/fire cycle only.

### 12.6 Fire strength levels

A fire event is not a single binary. The detector emits a `fireStrength` ∈ {null, 1, 2, 3} on every `observe()` return:

| Level | Name | State | Meaning |
|---|---|---|---|
| null | — | ARMED | Idle, below trigger |
| 1 | WATCH | PENDING | Price above trigger, awaiting confirmation. Informational only — **not a trade action** |
| 2 | CONFIRMED | FIRED | Breakout confirmed. Default for any fire without strong context. Eligible for a **standard alert**. |
| 3 | HIGH CONVICTION | FIRED | Confirmed fire PLUS volume expansion, relative strength, clean technical structure, and a green risk band. Eligible for a **priority alert**. |

**Promotion to Level 3** requires ALL of these in the `strengthContext` passed to `observe()`:
- `volumeExpansion === true`
- `relativeStrength === true`
- `cleanStructure === true`
- `riskBand === 'green'`

If any is false/missing, the fire is Level 2.

**Downgrade:** yellow or red risk always caps strength at 2, even with all technical signals green. This is additive, not blocking — the fire still fires with `fireStrength: 2`. Red-flag fires still notify the user; the risk context is surfaced separately (§13).

**Stale/degraded data:** stale quotes or `fireSuppressed: true` inputs never promote any state. ARMED stays, PENDING resets to ARMED, FIRED state and its existing `fireStrength` are preserved without update.

**Daily cap:** when a cap-suppressed transition occurs, the existing `fireStrength` from the prior fire is preserved (not overwritten to null).

**Consumer guidance (Task 12+):**
- `fireStrength === 1` → dashboard-only status chip ("WATCH"), no notification
- `fireStrength === 2` → dashboard banner + standard desktop toast
- `fireStrength === 3` → dashboard banner + priority toast (optional audio, sticky badge)

---

## 13. Risk flags & fire tagging

Every fire is enriched with risk context so the notification and dashboard can guide action, not just announce crosses. A ticker that's firing the day before earnings is a different trade than one firing on a clean chart.

### 13.1 Risk flag dimensions

| Flag | Green | Yellow | Red | Source |
|---|---|---|---|---|
| **Earnings** | No earnings in next 7 days | Earnings in 3–7 days | Earnings in ≤2 days | Yahoo earnings calendar (fetched at scanner time, cached in scanner output) |
| **Liquidity** | 20-day avg vol ≥ 500k shares | 200k–500k | < 200k | Yahoo quote fields (`averageDailyVolume10Day`) |
| **Spread** | ask−bid ≤ 0.10% of price | 0.10%–0.50% | > 0.50% | Yahoo quote fields at fire time |
| **News gap** | Today's open within ±1 ATR of prior close | ±1–2 ATR | > 2 ATR OR news in last 12h tagged "breaking" | `gap_risk` from poller + news RSS freshness |
| **Merger pending** | Not flagged | (n/a) | Flagged in scanner output | Scanner `notes` field |
| **Short float** | < 10% | 10–20% | > 20% | Yahoo quote `sharesShort` / `sharesShortPriorMonth` (already in scanner `details`) |

### 13.2 Overall risk band

Single summary: `green`, `yellow`, `red`.
- **Red** if any flag is red
- **Yellow** if any flag is yellow (and none red)
- **Green** otherwise

### 13.3 Surfacing in UI and notifications

**Dashboard row** (on the Coiled Springs tab): colored chip per flag plus the overall band color as row background tint.

**Toast notification** format includes the risk band:
- 🟢 Green: `"APH fired @ $152.83 — clean setup"`
- 🟡 Yellow: `"APH fired @ $152.83 ⚠ earnings in 5 days"`
- 🔴 Red: `"APH fired @ $152.83 🚨 EARNINGS TOMORROW — read before acting"`

**Banner at top of dashboard** includes a 1-line reason if red/yellow.

### 13.4 Optional filter

Dashboard setting (persisted to `localStorage`): **"Only notify me if overall risk is green or yellow."** Red-flag fires still appear in the dashboard (you can see them) but don't trigger a Windows toast. Default: **off** (notify all fires, let the user judge).

### 13.5 Earnings data source caveat

Yahoo's earnings calendar is not 100% reliable. If `earningsDaysOut` is missing or shows the corrupt sentinel we saw in today's ITT row (-20547), the flag defaults to **yellow** ("earnings date unverified — check broker") rather than green. Never silently treat "missing" as "no risk."

---

## 14. Validation, shadow mode & ongoing tuning

The point of this feature is **making money**. Shipping it without measuring whether fires lead to real continuation is shipping a toy. Plan:

### 14.1 Shadow mode (first 2 weeks)

Before enabling Windows toasts at all:

- Run the poller in **shadow mode** — fires are logged to disk and SSE'd to the dashboard, but `Notification` dispatch is **disabled**.
- User reviews the daily fire log each evening, adding a post-hoc "outcome" field:
  - `continued` — stock closed above trigger and was higher the next day
  - `faded` — fired but closed below trigger same day
  - `whipsaw` — multiple fires in one day
  - `earnings_gap` — fire was caused by a morning earnings gap
- Manual tagging for ≥30 fires across ≥2 weeks to get a baseline.

### 14.2 Metrics to track

Computed daily from the audit log:

- **Fires per day** (target: 3–8; if >15, debouncing is too loose)
- **Red-flag fire rate** (if high, the user's wheel rule is saving them from bad entries — good)
- **Continuation rate by confidence band** (HIGH should outperform MODERATE)
- **Continuation rate by risk band** (green > yellow > red expected)
- **Median latency** (first cross → fire notification)
- **Degraded-mode fires per week** (if Yahoo flakes often, we rely more on fallback)
- **False-fire rate** (fires that reverted within 30 min → did debouncing catch the real ones?)

### 14.3 Backtest harness (optional but recommended)

Offline tool: `scripts/scanner/replay_fires.js`.

- Input: a date range + the scanner output snapshots from those days + Yahoo historical 1-min bars for the top-15 tickers on each day.
- Simulates: what the live feed *would have done* on those days. Replays the 1-min bars through the poller logic.
- Output: a dated JSON of simulated fires, matchable against what actually happened in price the rest of that day / next day.
- Used to tune debouncing parameters (N polls, hysteresis %) without waiting 2 weeks of live observation.

**Defer to a follow-up spec if shadow-mode alone is sufficient.** Don't build until shadow mode proves it's needed.

### 14.4 Tuning loop

After shadow mode, before enabling toasts:

1. Review baseline stats with user.
2. Adjust debouncing (§13) if noise is too high or too low.
3. Adjust risk flag thresholds (§14) based on observed correlation with outcomes.
4. Turn toasts on with the tuned config.
5. Schedule a 1-month and 3-month review.

---

## 15. Implementation order (for the plan)

Each step is independently testable and leaves the system in a working state.

**Phase A — foundations**
1. **Market-hours module** — `lib/market_hours.js` with NYSE calendar file + DST-aware tests.
2. **Candidate reader** — utility that parses `coiled_spring_results.json` → top-15 list with `{symbol, trigger, ...}`.
3. **Fire event schema + persistence layer** — `fire_events.js` with the full §6.1 schema. Unit tests.
4. **Poller state persistence** — `poller_state.json` read/write with tests (§6.2).

**Phase B — quote fetching**
5. **Yahoo quote client** — factored out of `gen_brief.js` into `lib/quote_sources/yahoo.js`. Rate-limit + 429 handling.
6. **TradingView CDP quote client** — `lib/quote_sources/tv_cdp.js` wrapping the MCP `quote_get` call.
7. **Fallback chain orchestrator** — `lib/quote_sources/chain.js` implementing §12.

**Phase C — fire detection**
8. **Debouncer + state machine** — `lib/fire_detector.js` with the ARMED/PENDING/FIRED logic and hysteresis. Unit tests including whipsaw fixture.
9. **Live price poller** — `live_price_poller.js` pulling it all together. Unit tests with mocked quote source.

**Phase D — risk flags**
10. **Risk flag evaluators** — one function per dimension in §14.1, pure functions with unit tests.
11. **Fire enrichment** — wire risk flags into the fire event schema + audit log.

**Phase E — server & UI**
12. **SSE endpoint in `live_server.js`** — backend plumbing. Manual test: `curl -N http://localhost:3333/events`.
13. **Dashboard SSE client + live price column + banner + sticky badges** — UI layer.
14. **Risk flag chips in dashboard table + toast message templating**.
15. **Notification API integration** — browser permission + toast dispatch.

**Phase F — shadow mode & autostart**
16. **Shadow mode toggle** — config flag that disables toast dispatch while keeping everything else on.
17. **`setup_autostart.ps1`** — Task Scheduler registration script.
18. **Manual E2E test** — full loop with synthetic fire, then live verification during market hours.

**Phase G — validation (post-ship)**
19. **Daily fire outcome tagger** — small CLI/UI for the user to label each day's fires (`continued` / `faded` / etc.) for 2 weeks.
20. **Metrics dashboard** — simple HTML view over the labeled audit logs (§15.2).
21. **Decision point: enable toasts**, or tune first based on metrics.
22. *(Optional)* Backtest harness (§15.3) if live observation is insufficient.
