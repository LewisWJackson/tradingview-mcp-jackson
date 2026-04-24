# Coiled Spring Live Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the coiled spring screener from a periodic snapshot into a live feed — the top-15 candidate prices refresh every 15 seconds during market hours, fires (price crossing the entry trigger) surface as a dashboard banner + Windows desktop toast within one polling cycle, and every fire is enriched with earnings/liquidity/spread/news risk flags for actionable guidance.

**Architecture:** One long-running Node process (`live_server.js`) hosts three cooperating components — the existing 30-minute scanner runner, a new 15s price poller with a 3-state fire detector (ARMED → PENDING → FIRED with debouncing and hysteresis), and a Server-Sent Events endpoint the dashboard subscribes to for real-time updates. Quote source degrades gracefully Yahoo → TradingView CDP → stale-cache. Two weeks of shadow mode (log fires without notifying) precedes enabling Windows toasts.

**Tech Stack:** Node.js (ESM, built-in `node:test`), browser EventSource + Notification API, Yahoo Finance REST (crumb/cookie auth), TradingView CDP via existing `src/core/data.js`, Windows Task Scheduler for autostart.

**Spec:** `docs/superpowers/specs/2026-04-24-coiled-spring-live-feed-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `src/lib/market_hours.js` | Create | Timezone-aware NYSE clock; PRE_WARM / REGULAR / CLOSE_CAPTURE / PAUSED mode decisions |
| `data/nyse_calendar.json` | Create | Market holidays + early-close days for 2026; loaded by market_hours |
| `src/lib/candidate_reader.js` | Create | Reads `coiled_spring_results.json` → normalized top-N list with triggers |
| `src/lib/fire_events.js` | Create | Append-only daily fire audit log (`coiled_spring_fires_YYYY-MM-DD.json`) |
| `src/lib/poller_state.js` | Create | In-memory state snapshot to `poller_state.json` for crash recovery |
| `src/lib/quote_sources/yahoo.js` | Create | Yahoo batch quote client factored from `scripts/dashboard/gen_brief.js` |
| `src/lib/quote_sources/tv_cdp.js` | Create | TradingView CDP quote client via MCP `quote_get` path |
| `src/lib/quote_sources/chain.js` | Create | Fallback orchestrator with flip triggers + recovery probe |
| `src/lib/fire_detector.js` | Create | ARMED/PENDING/FIRED state machine + hysteresis + daily cap |
| `src/lib/risk_flags.js` | Create | Earnings / liquidity / spread / news-gap / merger / short-float evaluators |
| `scripts/scanner/live_price_poller.js` | Create | Orchestrates quote fetch → detector → risk flags → emit |
| `scripts/dashboard/live_server.js` | Modify | Wire poller + SSE endpoint; preserve existing build loop |
| `scripts/dashboard/build_dashboard_html.js` | Modify | Inject SSE client, banner, sticky badges, live price column, risk chips, toast dispatcher |
| `scripts/setup_autostart.ps1` | Create | Windows Task Scheduler registration script |
| `scripts/dashboard/outcome_tagger.js` | Create (Phase G) | CLI for manual outcome labeling during shadow mode |
| `scripts/dashboard/fire_metrics.js` | Create (Phase G) | Compute daily metrics from audit logs |
| `tests/market_hours.test.js` | Create | Unit tests — gate, holidays, DST, close-capture window |
| `tests/candidate_reader.test.js` | Create | Unit tests — valid input, missing file, empty results |
| `tests/fire_events.test.js` | Create | Unit tests — schema, date resolution, persistence, reload |
| `tests/poller_state.test.js` | Create | Unit tests — write, read, stale-detection |
| `tests/quote_sources_yahoo.test.js` | Create | Unit tests — request builder, 429 backoff, partial batch |
| `tests/quote_sources_chain.test.js` | Create | Unit tests — flip triggers, recovery probe, stale mode |
| `tests/fire_detector.test.js` | Create | Unit tests — clean fire, whipsaw, hysteresis, daily cap, stale guard |
| `tests/risk_flags.test.js` | Create | Unit tests — each dimension + overall band |
| `tests/live_price_poller.test.js` | Create | Integration test — end-to-end with mocked quote source |

All new source files live under `src/lib/` (fits the existing `src/core/` convention for business logic). Tests live in `tests/` flat (matches existing convention per package.json).

---

## Task 1: Market-Hours Module + NYSE Calendar

**Files:**
- Create: `data/nyse_calendar.json`
- Create: `src/lib/market_hours.js`
- Create: `tests/market_hours.test.js`

- [ ] **Step 1: Create the NYSE calendar file**

Write the list of 2026 full-closure holidays and early-close afternoons. NYSE official schedule, cross-check at https://www.nyse.com/markets/hours-calendars.

Create `data/nyse_calendar.json` with exactly this content:

```json
{
  "description": "NYSE full closures and early closes for 2026. Source: nyse.com/markets/hours-calendars.",
  "year": 2026,
  "days": [
    { "date": "2026-01-01", "status": "closed", "name": "New Year's Day" },
    { "date": "2026-01-19", "status": "closed", "name": "MLK Day" },
    { "date": "2026-02-16", "status": "closed", "name": "Presidents' Day" },
    { "date": "2026-04-03", "status": "closed", "name": "Good Friday" },
    { "date": "2026-05-25", "status": "closed", "name": "Memorial Day" },
    { "date": "2026-06-19", "status": "closed", "name": "Juneteenth" },
    { "date": "2026-07-03", "status": "early_close", "closeTimeET": "13:00", "name": "Day Before July 4 (observed)" },
    { "date": "2026-09-07", "status": "closed", "name": "Labor Day" },
    { "date": "2026-11-26", "status": "closed", "name": "Thanksgiving" },
    { "date": "2026-11-27", "status": "early_close", "closeTimeET": "13:00", "name": "Day After Thanksgiving" },
    { "date": "2026-12-24", "status": "early_close", "closeTimeET": "13:00", "name": "Christmas Eve" },
    { "date": "2026-12-25", "status": "closed", "name": "Christmas Day" }
  ]
}
```

- [ ] **Step 2: Write the failing test file**

Create `tests/market_hours.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { getMarketMode } from '../src/lib/market_hours.js';

// All tests pin a fixed "now" so they're deterministic across runs.
// Times are expressed in UTC; the module converts to America/New_York.

test('REGULAR during the 10 AM ET hour on a normal Thursday', () => {
  const now = new Date('2026-04-23T14:00:00Z'); // 10:00 EDT
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('PRE_WARM 9:27 AM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T13:27:00Z'); // 9:27 EDT
  assert.strictEqual(getMarketMode(now).mode, 'PRE_WARM');
});

test('CLOSE_CAPTURE at 4:02 PM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T20:02:00Z'); // 16:02 EDT
  assert.strictEqual(getMarketMode(now).mode, 'CLOSE_CAPTURE');
});

test('PAUSED after 4:05 PM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T20:10:00Z'); // 16:10 EDT
  assert.strictEqual(getMarketMode(now).mode, 'PAUSED');
});

test('PAUSED on Saturday at 11 AM ET', () => {
  const now = new Date('2026-04-25T15:00:00Z'); // 11:00 EDT Sat
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'weekend');
});

test('PAUSED on Good Friday 2026 at 11 AM ET', () => {
  const now = new Date('2026-04-03T15:00:00Z');
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'holiday');
  assert.strictEqual(result.holiday, 'Good Friday');
});

test('REGULAR at 12 PM ET on an early-close day (Day After Thanksgiving)', () => {
  const now = new Date('2026-11-27T17:00:00Z'); // 12:00 EST
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('PAUSED at 2 PM ET on an early-close day', () => {
  const now = new Date('2026-11-27T19:00:00Z'); // 14:00 EST
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'early_close');
});

test('CLOSE_CAPTURE at 1:02 PM ET on an early-close day', () => {
  const now = new Date('2026-11-27T18:02:00Z'); // 13:02 EST
  assert.strictEqual(getMarketMode(now).mode, 'CLOSE_CAPTURE');
});

test('DST transition — REGULAR 10 AM ET on 2026-03-09 (first EDT day)', () => {
  // DST 2026 starts Sun Mar 8; Monday Mar 9 is first EDT trading day
  const now = new Date('2026-03-09T14:00:00Z'); // 10:00 EDT
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('DST transition — REGULAR 10 AM ET on 2026-11-02 (first EST day)', () => {
  const now = new Date('2026-11-02T15:00:00Z'); // 10:00 EST
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});
```

- [ ] **Step 3: Run the test — expect failure**

```bash
node --test tests/market_hours.test.js
```

Expected: all tests fail because `src/lib/market_hours.js` does not exist yet (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 4: Implement `src/lib/market_hours.js`**

Create `src/lib/market_hours.js`:

```js
/**
 * NYSE market-hours gate.
 *
 * Computes which operational mode the poller should be in given the current UTC time.
 * Uses IANA America/New_York timezone for DST correctness.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_PATH = path.resolve(__dirname, '..', '..', 'data', 'nyse_calendar.json');

let calendarCache = null;
function loadCalendar() {
  if (calendarCache) return calendarCache;
  const raw = fs.readFileSync(CALENDAR_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  calendarCache = new Map(parsed.days.map(d => [d.date, d]));
  return calendarCache;
}

/**
 * Convert a JS Date to {y, m, d, dow, hour, minute} in America/New_York.
 * dow: 0=Sun...6=Sat.
 */
function toET(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = name => parts.find(p => p.type === name)?.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl.DateTimeFormat with hour12:false can output "24" at midnight on some engines — normalize.
  let hour = parseInt(g('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    y: g('year'), m: g('month'), d: g('day'),
    dow: dowMap[g('weekday')],
    hour,
    minute: parseInt(g('minute'), 10),
    dateStr: `${g('year')}-${g('month')}-${g('day')}`,
  };
}

function minuteOfDay(hour, minute) {
  return hour * 60 + minute;
}

/**
 * Returns { mode, reason?, holiday?, etClock, closeTimeET? } where mode is one of:
 *   'PRE_WARM'       — 9:25 ≤ t < 9:30 ET
 *   'REGULAR'        — 9:30 ≤ t < sessionClose ET
 *   'CLOSE_CAPTURE'  — sessionClose ≤ t < sessionClose + 5 ET
 *   'PAUSED'         — all other times, with reason in {weekend, holiday, early_close, outside_hours}
 *
 * sessionClose is 16:00 ET on normal days, or the early-close time on calendar-flagged days.
 */
export function getMarketMode(nowDate = new Date()) {
  const cal = loadCalendar();
  const et = toET(nowDate);

  if (et.dow === 0 || et.dow === 6) {
    return { mode: 'PAUSED', reason: 'weekend', etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}` };
  }

  const calEntry = cal.get(et.dateStr);
  if (calEntry && calEntry.status === 'closed') {
    return { mode: 'PAUSED', reason: 'holiday', holiday: calEntry.name, etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}` };
  }

  // Determine session close (default 16:00, or early-close override)
  let closeHour = 16, closeMin = 0;
  let closeTimeET = '16:00';
  if (calEntry && calEntry.status === 'early_close') {
    const [h, m] = calEntry.closeTimeET.split(':').map(Number);
    closeHour = h; closeMin = m;
    closeTimeET = calEntry.closeTimeET;
  }

  const nowMin = minuteOfDay(et.hour, et.minute);
  const preWarmStart = minuteOfDay(9, 25);
  const regularStart = minuteOfDay(9, 30);
  const closeMin_ = minuteOfDay(closeHour, closeMin);
  const captureEnd = closeMin_ + 5;

  if (nowMin >= preWarmStart && nowMin < regularStart) {
    return { mode: 'PRE_WARM', etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}`, closeTimeET };
  }
  if (nowMin >= regularStart && nowMin < closeMin_) {
    return { mode: 'REGULAR', etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}`, closeTimeET };
  }
  if (nowMin >= closeMin_ && nowMin < captureEnd) {
    return { mode: 'CLOSE_CAPTURE', etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}`, closeTimeET };
  }

  const reason = (calEntry && calEntry.status === 'early_close' && nowMin >= captureEnd) ? 'early_close' : 'outside_hours';
  return { mode: 'PAUSED', reason, etClock: `${et.hour}:${String(et.minute).padStart(2, '0')}`, closeTimeET };
}

/**
 * Returns the ET trading-date string (YYYY-MM-DD) for a given instant.
 * Used so that fires logged at 3:45 PM PT / 6:45 PM ET get assigned to the correct trading day.
 */
export function tradingDate(nowDate = new Date()) {
  return toET(nowDate).dateStr;
}
```

- [ ] **Step 5: Run the tests — expect all 11 to pass**

```bash
node --test tests/market_hours.test.js
```

Expected: `# pass 11`. If any fail, examine the Intl.DateTimeFormat parts on your Node version — some older engines report weekday differently.

- [ ] **Step 6: Commit**

```bash
git add data/nyse_calendar.json src/lib/market_hours.js tests/market_hours.test.js
git commit -m "feat(live-feed): market-hours gate with NYSE calendar and DST-aware tests"
```

---

## Task 2: Candidate Reader Utility

**Files:**
- Create: `src/lib/candidate_reader.js`
- Create: `tests/candidate_reader.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/candidate_reader.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCandidates } from '../src/lib/candidate_reader.js';

function writeTempResults(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reader-'));
  const p = path.join(dir, 'results.json');
  fs.writeFileSync(p, JSON.stringify(contents));
  return p;
}

test('parses top-15 candidates with alert triggers', () => {
  const p = writeTempResults({
    generated_at: '2026-04-24T16:20:00Z',
    results: [
      { symbol: 'APH', price: 150.38, entry_trigger: 'watchlist — alert at 152.81', probability_score: 66, setup_type: 'building_base', composite_confidence: 'high', rank: 6, confidence_band: { low: 61, mid: 66, high: 71 } },
      { symbol: 'LIN', price: 510.56, entry_trigger: 'watchlist — alert at 510.41', probability_score: 59, setup_type: 'building_base', composite_confidence: 'medium', rank: 15, confidence_band: { low: 54, mid: 59, high: 64 } },
      { symbol: 'NEM', price: 119.89, entry_trigger: 'no entry', probability_score: 62, setup_type: 'extended', composite_confidence: 'high', rank: 4, confidence_band: { low: 57, mid: 62, high: 67 } },
    ],
  });
  const out = readCandidates(p);
  assert.strictEqual(out.scanRunId, '2026-04-24T16:20:00Z');
  assert.strictEqual(out.candidates.length, 2, 'NEM (no entry) should be excluded — no trigger to watch');
  assert.deepStrictEqual(out.candidates[0], {
    symbol: 'APH', trigger: 152.81, triggerText: 'watchlist — alert at 152.81',
    confidence: 'HIGH', setupType: 'building_base', rank: 6,
    confidenceBand: { low: 61, mid: 66, high: 71 }, probabilityScore: 66,
  });
  assert.strictEqual(out.candidates[1].trigger, 510.41);
});

test('returns empty list when results file is missing', () => {
  const out = readCandidates('/nonexistent/path.json');
  assert.strictEqual(out.candidates.length, 0);
  assert.strictEqual(out.error, 'missing');
});

test('returns empty list on malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reader-'));
  const p = path.join(dir, 'results.json');
  fs.writeFileSync(p, '{not json');
  const out = readCandidates(p);
  assert.strictEqual(out.candidates.length, 0);
  assert.strictEqual(out.error, 'parse');
});

test('normalizes confidence casing to uppercase', () => {
  const p = writeTempResults({
    generated_at: '2026-04-24T16:20:00Z',
    results: [
      { symbol: 'X', price: 10, entry_trigger: 'alert at 11', composite_confidence: 'moderate', setup_type: 'building_base', rank: 1 },
    ],
  });
  assert.strictEqual(readCandidates(p).candidates[0].confidence, 'MODERATE');
});

test('respects topN limit when specified', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ symbol: `T${i}`, price: 10, entry_trigger: 'alert at 11', setup_type: 'building_base', rank: i + 1 });
  const p = writeTempResults({ generated_at: 't', results: rows });
  assert.strictEqual(readCandidates(p, { topN: 5 }).candidates.length, 5);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/candidate_reader.test.js
```

Expected: fails with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/lib/candidate_reader.js`**

Create `src/lib/candidate_reader.js`:

```js
/**
 * Reads coiled_spring_results.json and returns a normalized top-N list of
 * candidates that have an actionable alert trigger.
 *
 * Entries with entry_trigger like "no entry" (the scanner's "extended" verdict)
 * are filtered out — there's no trigger price to watch.
 */

import fs from 'node:fs';

const ALERT_RX = /alert\s+at\s+([\d.]+)/i;

function parseTrigger(text) {
  const m = (text || '').match(ALERT_RX);
  return m ? parseFloat(m[1]) : null;
}

export function readCandidates(resultsPath, { topN = 15 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(resultsPath, 'utf8');
  } catch {
    return { candidates: [], error: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { candidates: [], error: 'parse' };
  }
  const list = parsed.results || parsed.top_15 || parsed.top || [];
  const out = [];
  for (const row of list) {
    const trigger = parseTrigger(row.entry_trigger);
    if (trigger == null) continue;
    out.push({
      symbol: row.symbol || row.ticker,
      trigger,
      triggerText: row.entry_trigger,
      confidence: String(row.composite_confidence || row.setup_quality || 'UNKNOWN').toUpperCase(),
      setupType: row.setup_type || 'unknown',
      rank: row.rank ?? null,
      confidenceBand: row.confidence_band || null,
      probabilityScore: row.probability_score ?? null,
    });
    if (out.length >= topN) break;
  }
  return { scanRunId: parsed.generated_at || parsed.generatedAt || null, candidates: out };
}
```

- [ ] **Step 4: Run tests — expect all 5 to pass**

```bash
node --test tests/candidate_reader.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/candidate_reader.js tests/candidate_reader.test.js
git commit -m "feat(live-feed): candidate reader normalizes scanner output for poller"
```

---

## Task 3: Fire Events — Audit Log Persistence

**Files:**
- Create: `src/lib/fire_events.js`
- Create: `tests/fire_events.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/fire_events.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFireLog } from '../src/lib/fire_events.js';

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fire-')); }

test('recordFire writes a new file with one entry', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  const event = log.recordFire({
    ticker: 'LIN',
    trigger: 510.41,
    firedPrice: 510.56,
    timestamp: '2026-04-24T17:45:13.000Z',
    confidence: 'MODERATE',
    setupType: 'building_base',
    rank: 15,
  });
  assert.ok(event.eventId);
  assert.strictEqual(event.ticker, 'LIN');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('coiled_spring_fires_'));
  assert.strictEqual(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(parsed.fires.length, 1);
  assert.strictEqual(parsed.fires[0].ticker, 'LIN');
});

test('recordFire appends to existing file on same trading day', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'A', trigger: 10, firedPrice: 11, timestamp: '2026-04-24T17:00:00.000Z' });
  log.recordFire({ ticker: 'B', trigger: 20, firedPrice: 21, timestamp: '2026-04-24T17:30:00.000Z' });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('coiled_spring_fires_'));
  assert.strictEqual(files.length, 1, 'same trading day → one file');
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(parsed.fires.length, 2);
});

test('getTodaysFires returns empty when nothing logged', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  assert.deepStrictEqual(log.getTodaysFires(new Date('2026-04-24T17:00:00Z')), []);
});

test('getTodaysFires returns events for the ET trading day', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'X', trigger: 1, firedPrice: 2, timestamp: '2026-04-24T23:00:00.000Z' }); // 7 PM ET (after close — same trading day)
  const fires = log.getTodaysFires(new Date('2026-04-24T23:00:00Z'));
  assert.strictEqual(fires.length, 1);
});

test('fire event preserves all audit fields when provided', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  const event = log.recordFire({
    ticker: 'APH', trigger: 152.81, firedPrice: 152.83,
    timestamp: '2026-04-24T18:00:00.000Z',
    confidence: 'HIGH', setupType: 'building_base', rank: 6,
    pollSequence: 847, scanRunId: '2026-04-24T17:00:00Z',
    price: { bid: 152.80, ask: 152.86, spreadAbsolute: 0.06, spreadPctOfPrice: 0.04, quoteSource: 'yahoo', quoteAgeMs: 312 },
    debounce: { confirmPollCount: 2, firstCrossObservedAt: '2026-04-24T17:59:45.000Z', confirmedAt: '2026-04-24T18:00:00.000Z' },
    marketContext: { vix: 18.63, vixRegime: 'constructive' },
    riskFlags: { overallRiskBand: 'green', earnings: { active: false } },
  });
  assert.strictEqual(event.price.spreadPctOfPrice, 0.04);
  assert.strictEqual(event.riskFlags.overallRiskBand, 'green');
  assert.ok(event.eventId);
});

test('getFiresForDate returns events for an arbitrary date', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'OLD', trigger: 1, firedPrice: 2, timestamp: '2026-04-22T17:00:00.000Z' });
  log.recordFire({ ticker: 'NEW', trigger: 1, firedPrice: 2, timestamp: '2026-04-24T17:00:00.000Z' });
  assert.strictEqual(log.getFiresForDate('2026-04-22').length, 1);
  assert.strictEqual(log.getFiresForDate('2026-04-22')[0].ticker, 'OLD');
  assert.strictEqual(log.getFiresForDate('2026-04-24').length, 1);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/fire_events.test.js
```

Expected: `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement `src/lib/fire_events.js`**

Create `src/lib/fire_events.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tradingDate } from './market_hours.js';

/**
 * Append-only daily fire audit log.
 *
 * Files named coiled_spring_fires_YYYY-MM-DD.json, where YYYY-MM-DD is the
 * America/New_York trading date for the fire's timestamp.
 *
 * Schema per §6.1 of the design spec — fields passed through so callers can
 * enrich freely without us having to re-edit here.
 */
export function createFireLog({ baseDir }) {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  function filePathForDate(dateStr) {
    return path.join(baseDir, `coiled_spring_fires_${dateStr}.json`);
  }

  function loadFile(fp) {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }

  function recordFire(event) {
    const ts = event.timestamp || new Date().toISOString();
    const dateStr = tradingDate(new Date(ts));
    const fp = filePathForDate(dateStr);
    const existing = loadFile(fp) || { date: dateStr, fires: [] };

    const firedAtET = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'short',
    }).format(new Date(ts));

    const stored = {
      eventId: event.eventId || randomUUID(),
      ticker: event.ticker,
      firedAt: ts,
      firedAtET,
      ...event,
      timestamp: undefined, // normalized into firedAt
    };
    // Drop undefined keys (timestamp we just replaced)
    for (const k of Object.keys(stored)) if (stored[k] === undefined) delete stored[k];

    existing.fires.push(stored);
    fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
    return stored;
  }

  function getTodaysFires(now = new Date()) {
    return getFiresForDate(tradingDate(now));
  }

  function getFiresForDate(dateStr) {
    const fp = filePathForDate(dateStr);
    const parsed = loadFile(fp);
    return parsed ? parsed.fires : [];
  }

  return { recordFire, getTodaysFires, getFiresForDate, filePathForDate };
}
```

- [ ] **Step 4: Run tests — expect 6 passes**

```bash
node --test tests/fire_events.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/fire_events.js tests/fire_events.test.js
git commit -m "feat(live-feed): daily fire audit log persistence"
```

---

## Task 4: Poller State Persistence

**Files:**
- Create: `src/lib/poller_state.js`
- Create: `tests/poller_state.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/poller_state.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStateStore } from '../src/lib/poller_state.js';

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-state-')); }

test('read returns empty state when file missing', () => {
  const dir = mktmp();
  const store = createStateStore({ filePath: path.join(dir, 'state.json') });
  const s = store.read();
  assert.deepStrictEqual(s.tickers, {});
  assert.strictEqual(s.circuitBreaker.status, 'closed');
});

test('write + read roundtrip preserves state', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp });
  store.write({
    asOf: '2026-04-24T17:45:20.000Z',
    tickers: {
      APH: { state: 'ARMED', trigger: 152.81, lastPrice: 150.38, lastPollAt: '2026-04-24T17:45:05.000Z', firedEventId: null },
    },
    circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
  });
  const s = store.read();
  assert.strictEqual(s.tickers.APH.state, 'ARMED');
  assert.strictEqual(s.tickers.APH.trigger, 152.81);
});

test('isFresh returns false when snapshot is older than max age', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp, maxAgeMs: 10 * 60_000 });
  store.write({ asOf: '2026-04-24T00:00:00.000Z', tickers: {}, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.isFresh(new Date('2026-04-24T00:15:00.000Z')), false);
});

test('isFresh returns true when snapshot is within max age', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp, maxAgeMs: 10 * 60_000 });
  store.write({ asOf: '2026-04-24T00:00:00.000Z', tickers: {}, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.isFresh(new Date('2026-04-24T00:05:00.000Z')), true);
});

test('write survives malformed prior file', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  fs.writeFileSync(fp, '{not json');
  const store = createStateStore({ filePath: fp });
  const s = store.read();
  assert.deepStrictEqual(s.tickers, {}, 'falls back to empty state on parse error');
  store.write({ asOf: 't', tickers: { X: { state: 'ARMED' } }, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.read().tickers.X.state, 'ARMED');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/poller_state.test.js
```

- [ ] **Step 3: Implement `src/lib/poller_state.js`**

Create `src/lib/poller_state.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000;

export function createStateStore({ filePath, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  function read() {
    if (!fs.existsSync(filePath)) {
      return emptyState();
    }
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return emptyState();
    }
  }

  function write(state) {
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  function isFresh(now = new Date()) {
    if (!fs.existsSync(filePath)) return false;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return false;
    }
    if (!parsed.asOf) return false;
    const ageMs = now - new Date(parsed.asOf);
    return ageMs >= 0 && ageMs <= maxAgeMs;
  }

  return { read, write, isFresh };
}

function emptyState() {
  return {
    asOf: null,
    tickers: {},
    circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
  };
}
```

- [ ] **Step 4: Run tests — expect 5 passes**

```bash
node --test tests/poller_state.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/poller_state.js tests/poller_state.test.js
git commit -m "feat(live-feed): poller state persistence for crash recovery"
```

---

## Task 5: Yahoo Quote Client

**Files:**
- Create: `src/lib/quote_sources/yahoo.js`
- Create: `tests/quote_sources_yahoo.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/quote_sources_yahoo.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { buildQuoteUrl, parseQuoteResponse, normalizeQuoteRow } from '../src/lib/quote_sources/yahoo.js';

test('buildQuoteUrl encodes symbols and crumb', () => {
  const url = buildQuoteUrl(['AAPL', 'MSFT', '^GSPC'], 'abc=def');
  assert.ok(url.includes('symbols=AAPL%2CMSFT%2C%5EGSPC'));
  assert.ok(url.includes('crumb=abc%3Ddef'));
});

test('parseQuoteResponse turns Yahoo response into a symbol→quote map', () => {
  const body = JSON.stringify({
    quoteResponse: {
      result: [
        { symbol: 'AAPL', regularMarketPrice: 250.1, bid: 250.05, ask: 250.15, regularMarketTime: 1776960000, averageDailyVolume10Day: 50_000_000 },
        { symbol: 'MSFT', regularMarketPrice: 418.9, bid: 418.80, ask: 418.95, regularMarketTime: 1776960000, averageDailyVolume10Day: 22_000_000 },
      ],
    },
  });
  const map = parseQuoteResponse(body);
  assert.strictEqual(map.AAPL.price, 250.1);
  assert.strictEqual(map.MSFT.ask, 418.95);
});

test('normalizeQuoteRow computes spread fields', () => {
  const r = normalizeQuoteRow({ symbol: 'X', regularMarketPrice: 100, bid: 99.80, ask: 100.10, regularMarketTime: 1776960000, averageDailyVolume10Day: 1_000_000 });
  assert.strictEqual(r.spreadAbsolute, 0.30);
  assert.strictEqual(r.spreadPctOfPrice.toFixed(2), '0.30');
});

test('normalizeQuoteRow handles missing bid/ask gracefully', () => {
  const r = normalizeQuoteRow({ symbol: 'X', regularMarketPrice: 100, regularMarketTime: 1776960000 });
  assert.strictEqual(r.bid, null);
  assert.strictEqual(r.spreadAbsolute, null);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/quote_sources_yahoo.test.js
```

- [ ] **Step 3: Implement `src/lib/quote_sources/yahoo.js`**

Create the directory and file `src/lib/quote_sources/yahoo.js`:

```js
/**
 * Yahoo Finance batch quote client.
 *
 * Factored from scripts/dashboard/gen_brief.js. The HTTP + auth flow is the
 * same; this module exposes a clean fetchQuotes(symbols) Promise and adds
 * per-symbol spread + quote-age enrichment for the live feed.
 */

import https from 'node:https';

const TIMEOUT_MS = 15_000;
const BATCH_URL = 'https://query2.finance.yahoo.com/v7/finance/quote';
const CRUMB_URL = 'https://query2.finance.yahoo.com/v1/test/getcrumb';
const FC_URL = 'https://fc.yahoo.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function httpGet(url, { cookies } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': UA };
    if (cookies) headers.Cookie = cookies;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpGet(res.headers.location, { cookies }).then(resolve, reject);
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function authenticate() {
  const init = await httpGet(FC_URL);
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await httpGet(CRUMB_URL, { cookies });
  if (crumbRes.status !== 200) throw new Error(`getCrumb failed: status ${crumbRes.status}`);
  return { crumb: crumbRes.body.trim(), cookies };
}

export function buildQuoteUrl(symbols, crumb) {
  return `${BATCH_URL}?symbols=${encodeURIComponent(symbols.join(','))}&crumb=${encodeURIComponent(crumb)}`;
}

export function normalizeQuoteRow(r) {
  const price = r.regularMarketPrice ?? null;
  const bid = r.bid ?? null;
  const ask = r.ask ?? null;
  const spreadAbsolute = (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null;
  const spreadPctOfPrice = (spreadAbsolute != null && price) ? +((spreadAbsolute / price) * 100).toFixed(2) : null;
  const marketTimeEpochSec = r.regularMarketTime ?? null;
  return {
    symbol: r.symbol,
    price, bid, ask, spreadAbsolute, spreadPctOfPrice,
    averageDailyVolume10Day: r.averageDailyVolume10Day ?? null,
    volume: r.regularMarketVolume ?? null,
    prevClose: r.regularMarketPreviousClose ?? null,
    openToday: r.regularMarketOpen ?? null,
    marketTimeEpochSec,
    marketTimeIso: marketTimeEpochSec ? new Date(marketTimeEpochSec * 1000).toISOString() : null,
  };
}

export function parseQuoteResponse(body) {
  const parsed = JSON.parse(body);
  const rows = parsed?.quoteResponse?.result || [];
  const map = {};
  for (const r of rows) {
    map[r.symbol] = normalizeQuoteRow(r);
  }
  return map;
}

/**
 * Fetch a batch of quotes. Returns { quotes: Map<symbol, quote>, fetchedAt }.
 * Throws on HTTP error (429, 5xx, timeout) so callers can decide backoff policy.
 */
export async function fetchQuotes(symbols, session = null) {
  if (symbols.length === 0) return { quotes: {}, fetchedAt: new Date() };
  if (symbols.length > 50) throw new Error('Yahoo batch max is 50 symbols');

  const active = session ?? await authenticate();
  const url = buildQuoteUrl(symbols, active.crumb);
  const fetchedAt = new Date();
  const res = await httpGet(url, { cookies: active.cookies });

  if (res.status === 401) {
    // Crumb expired — re-authenticate once and retry.
    const fresh = await authenticate();
    const retry = await httpGet(buildQuoteUrl(symbols, fresh.crumb), { cookies: fresh.cookies });
    if (retry.status !== 200) {
      const err = new Error(`Yahoo status ${retry.status} after re-auth`);
      err.status = retry.status;
      throw err;
    }
    return { quotes: parseQuoteResponse(retry.body), fetchedAt, session: fresh };
  }

  if (res.status !== 200) {
    const err = new Error(`Yahoo status ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return { quotes: parseQuoteResponse(res.body), fetchedAt, session: active };
}

export { authenticate };
```

- [ ] **Step 4: Run tests — expect 4 passes**

```bash
node --test tests/quote_sources_yahoo.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote_sources/yahoo.js tests/quote_sources_yahoo.test.js
git commit -m "feat(live-feed): Yahoo batch quote client with 401 re-auth + spread fields"
```

---

## Task 6: TradingView CDP Quote Client

**Files:**
- Create: `src/lib/quote_sources/tv_cdp.js`

- [ ] **Step 1: Write the failing test**

Append to existing test file — create `tests/quote_sources_tv_cdp.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { tvCdpFetchQuotes } from '../src/lib/quote_sources/tv_cdp.js';

test('tvCdpFetchQuotes returns a quote map using the provided dataCore', async () => {
  const calls = [];
  const dataCore = {
    async getQuote(sym) {
      calls.push(sym);
      if (sym === 'APH') return { symbol: 'APH', last: 150.38, bid: 150.30, ask: 150.42, time: 1776960000 };
      if (sym === 'LIN') return { symbol: 'LIN', last: 510.56, bid: 510.48, ask: 510.62, time: 1776960000 };
      return null;
    },
  };
  const out = await tvCdpFetchQuotes(['APH', 'LIN'], { dataCore });
  assert.strictEqual(out.quotes.APH.price, 150.38);
  assert.strictEqual(out.quotes.LIN.bid, 510.48);
  assert.deepStrictEqual(calls, ['APH', 'LIN']);
});

test('tvCdpFetchQuotes returns null entries for missing symbols (not watched in TV)', async () => {
  const dataCore = { async getQuote() { return null; } };
  const out = await tvCdpFetchQuotes(['UNKNOWN'], { dataCore });
  assert.strictEqual(out.quotes.UNKNOWN, null);
});

test('tvCdpFetchQuotes throws if dataCore unreachable', async () => {
  const dataCore = { async getQuote() { throw new Error('CDP unreachable'); } };
  await assert.rejects(() => tvCdpFetchQuotes(['X'], { dataCore }));
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/quote_sources_tv_cdp.test.js
```

- [ ] **Step 3: Implement `src/lib/quote_sources/tv_cdp.js`**

Create `src/lib/quote_sources/tv_cdp.js`:

```js
/**
 * TradingView Desktop CDP quote client.
 *
 * Fallback source for the live feed. Requires TradingView Desktop running with
 * --remote-debugging-port=9222 and the symbol visible in the user's TV
 * watchlist (TV only keeps live quotes for symbols it's subscribed to).
 *
 * Only used when Yahoo degrades. Per-symbol calls, not a batch — TV's internal
 * API is one-at-a-time. That's fine for 15 symbols at 15s cadence (~1s total).
 */

/**
 * @param {string[]} symbols - tickers to quote (Yahoo format accepted; strips prefixes)
 * @param {object}   options
 * @param {object}   options.dataCore - injected getter with { getQuote(symbol): Promise<quote|null> }.
 *                                      In production this is src/core/data.js's getQuote wrapper.
 */
export async function tvCdpFetchQuotes(symbols, { dataCore }) {
  const fetchedAt = new Date();
  const quotes = {};
  const failed = [];

  for (const sym of symbols) {
    try {
      const raw = await dataCore.getQuote(sym);
      if (!raw) {
        quotes[sym] = null;
        continue;
      }
      const bid = raw.bid ?? null;
      const ask = raw.ask ?? null;
      const price = raw.last ?? raw.close ?? null;
      const spreadAbsolute = (bid != null && ask != null) ? +(ask - bid).toFixed(4) : null;
      const spreadPctOfPrice = (spreadAbsolute != null && price) ? +((spreadAbsolute / price) * 100).toFixed(2) : null;
      const epoch = raw.time ?? null;
      quotes[sym] = {
        symbol: sym,
        price, bid, ask, spreadAbsolute, spreadPctOfPrice,
        averageDailyVolume10Day: null,
        volume: raw.volume ?? null,
        prevClose: raw.prevClose ?? null,
        openToday: raw.open ?? null,
        marketTimeEpochSec: epoch,
        marketTimeIso: epoch ? new Date(epoch * 1000).toISOString() : null,
      };
    } catch (err) {
      failed.push({ symbol: sym, error: err.message });
    }
  }

  if (failed.length === symbols.length) {
    const err = new Error(`TV CDP all-symbol failure: ${failed[0].error}`);
    err.sourceFailures = failed;
    throw err;
  }

  return { quotes, fetchedAt, failed };
}
```

- [ ] **Step 4: Run tests — expect 3 passes**

```bash
node --test tests/quote_sources_tv_cdp.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote_sources/tv_cdp.js tests/quote_sources_tv_cdp.test.js
git commit -m "feat(live-feed): TradingView CDP quote client as fallback"
```

---

## Task 7: Fallback Chain Orchestrator

**Files:**
- Create: `src/lib/quote_sources/chain.js`
- Create: `tests/quote_sources_chain.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/quote_sources_chain.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { createQuoteChain } from '../src/lib/quote_sources/chain.js';

function mkMockSource(name, impl) {
  return { name, fetch: impl };
}

test('uses primary source when healthy', async () => {
  const primary = mkMockSource('yahoo', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 100, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const secondary = mkMockSource('tv_cdp', async () => { throw new Error('should not be called'); });
  const chain = createQuoteChain({ sources: [primary, secondary] });
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.price, 100);
  assert.strictEqual(out.quotes.APH.quoteSource, 'yahoo');
});

test('flips to secondary after 5 consecutive primary failures', async () => {
  let primaryCalls = 0;
  const primary = mkMockSource('yahoo', async () => { primaryCalls++; throw new Error('rate limit'); });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 5 });
  for (let i = 0; i < 4; i++) {
    try { await chain.fetchQuotes(['APH']); } catch {}
  }
  assert.strictEqual(chain.activeSourceName(), 'yahoo');
  try { await chain.fetchQuotes(['APH']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp', 'flipped after 5th failure');
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.quoteSource, 'tv_cdp');
  assert.strictEqual(primaryCalls, 5, 'primary not retried while degraded');
});

test('serves stale cache with fire suppression when all sources fail', async () => {
  const primary = mkMockSource('yahoo', async () => { throw new Error('down'); });
  const secondary = mkMockSource('tv_cdp', async () => { throw new Error('down'); });
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1 });
  // Seed the cache
  chain.cachePrime('APH', { symbol: 'APH', price: 100, marketTimeIso: new Date(Date.now() - 60_000).toISOString() }, 'yahoo');
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.quoteSource, 'stale');
  assert.strictEqual(out.quotes.APH.fireSuppressed, true);
  assert.ok(out.quotes.APH.quoteAgeMs >= 60_000);
});

test('recovery probe flips back to primary after success', async () => {
  let primaryShouldSucceed = false;
  const primary = mkMockSource('yahoo', async syms => {
    if (!primaryShouldSucceed) throw new Error('down');
    return { quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 101, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() };
  });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1, probeIntervalMs: 0 });
  // Force a flip
  try { await chain.fetchQuotes(['APH']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp');
  primaryShouldSucceed = true;
  // A manual probe attempt
  await chain.probe(['APH']);
  assert.strictEqual(chain.activeSourceName(), 'yahoo');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/quote_sources_chain.test.js
```

- [ ] **Step 3: Implement `src/lib/quote_sources/chain.js`**

Create `src/lib/quote_sources/chain.js`:

```js
/**
 * Fallback chain orchestrator: tries sources in priority order.
 *
 * Each "source" is { name, fetch(symbols): Promise<{quotes, fetchedAt}> }.
 * Chain tracks per-source consecutive-failure counts. Flips when a source
 * exceeds flipAfterFailures. A periodic "probe" re-tests the primary and
 * flips back on success.
 *
 * When ALL sources fail, the chain serves last-known quotes from an internal
 * cache with source="stale" and fireSuppressed=true so the caller can skip
 * fire detection for stale data.
 */

export function createQuoteChain({ sources, flipAfterFailures = 5, probeIntervalMs = 5 * 60_000 }) {
  if (!sources.length) throw new Error('createQuoteChain: need at least one source');

  let activeIdx = 0;
  const failureCounts = sources.map(() => 0);
  const cache = new Map(); // symbol → { quote, source, cachedAt }
  let lastProbeAt = 0;

  function activeSource() { return sources[activeIdx]; }

  async function tryFetch(source, symbols) {
    const out = await source.fetch(symbols);
    // Tag each quote with quoteSource and quoteAgeMs (from marketTimeIso if present)
    const now = Date.now();
    for (const sym of Object.keys(out.quotes)) {
      const q = out.quotes[sym];
      if (q == null) continue;
      const marketTime = q.marketTimeIso ? new Date(q.marketTimeIso).getTime() : now;
      q.quoteSource = source.name;
      q.quoteAgeMs = Math.max(0, now - marketTime);
      // Update the cache
      cache.set(sym, { quote: { ...q }, source: source.name, cachedAt: now });
    }
    return out;
  }

  async function fetchQuotes(symbols) {
    try {
      const out = await tryFetch(activeSource(), symbols);
      failureCounts[activeIdx] = 0;
      return out;
    } catch (err) {
      failureCounts[activeIdx]++;
      // Time to flip?
      if (failureCounts[activeIdx] >= flipAfterFailures && activeIdx < sources.length - 1) {
        activeIdx++;
        // Try the new active source immediately
        try {
          return await tryFetch(activeSource(), symbols);
        } catch (err2) {
          failureCounts[activeIdx]++;
          return serveStale(symbols, err2);
        }
      }
      // Still on active — if only source, serve stale
      if (activeIdx === sources.length - 1) {
        return serveStale(symbols, err);
      }
      // Propagate — caller will re-try on next cycle
      throw err;
    }
  }

  function serveStale(symbols, underlyingErr) {
    const now = Date.now();
    const quotes = {};
    for (const sym of symbols) {
      const entry = cache.get(sym);
      if (!entry) {
        quotes[sym] = null;
        continue;
      }
      quotes[sym] = {
        ...entry.quote,
        quoteSource: 'stale',
        quoteAgeMs: now - entry.cachedAt,
        fireSuppressed: true,
      };
    }
    return { quotes, fetchedAt: new Date(now), degraded: true, error: underlyingErr?.message || 'all sources failed' };
  }

  async function probe(symbols) {
    if (activeIdx === 0) return; // already on primary
    if (Date.now() - lastProbeAt < probeIntervalMs) return;
    lastProbeAt = Date.now();
    try {
      await tryFetch(sources[0], symbols);
      activeIdx = 0;
      failureCounts.fill(0);
    } catch {
      // Stay degraded
    }
  }

  function cachePrime(symbol, quote, sourceName) {
    cache.set(symbol, { quote: { ...quote }, source: sourceName, cachedAt: Date.now() });
  }

  function activeSourceName() { return sources[activeIdx].name; }

  return { fetchQuotes, probe, activeSourceName, cachePrime };
}
```

- [ ] **Step 4: Run tests — expect 4 passes**

```bash
node --test tests/quote_sources_chain.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/quote_sources/chain.js tests/quote_sources_chain.test.js
git commit -m "feat(live-feed): fallback chain orchestrator with flip + stale mode"
```

---

## Task 8: Fire Detector State Machine

**Files:**
- Create: `src/lib/fire_detector.js`
- Create: `tests/fire_detector.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/fire_detector.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { createFireDetector } from '../src/lib/fire_detector.js';

// Helper: drive a sequence of (price, ageMs) pairs through the detector for one ticker.
function driveTicker(detector, sym, trigger, seq) {
  const fires = [];
  detector.upsertTicker({ symbol: sym, trigger });
  for (const { price, ageMs = 100 } of seq) {
    const result = detector.observe(sym, { price, quoteAgeMs: ageMs });
    if (result.fired) fires.push(result);
  }
  return fires;
}

test('clean breakout fires once after 2 consecutive polls above trigger', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'APH', 152.81, [
    { price: 150.40 }, // below — ARMED
    { price: 152.85 }, // above #1 — PENDING
    { price: 152.90 }, // above #2 — FIRED
  ]);
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].firedPrice, 152.90);
  assert.strictEqual(fires[0].confirmPollCount, 2);
});

test('whipsaw (one-poll spike) does not fire', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'X', 100, [
    { price: 99 },
    { price: 101 }, // PENDING
    { price: 99 },  // back to ARMED
    { price: 99 },
  ]);
  assert.strictEqual(fires.length, 0);
});

test('hysteresis: re-arm requires price drop of ≥ 0.5% below trigger', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5 });
  const fires = driveTicker(det, 'Y', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // fire #1
    { price: 99.7 }, // 0.3% below — NOT re-armed
    { price: 102 }, { price: 102 }, // should NOT fire (still in FIRED state)
    { price: 99.3 }, // 0.7% below — re-armed
    { price: 101 }, { price: 101 }, // fire #2
  ]);
  assert.strictEqual(fires.length, 2);
});

test('daily fire cap (default 2) suppresses third fire', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5, maxFiresPerDay: 2 });
  driveTicker(det, 'Z', 100, [
    { price: 99 }, { price: 101 }, { price: 101 },
    { price: 99 }, { price: 101 }, { price: 101 },
    { price: 99 }, { price: 101 }, { price: 101 }, // 3rd — should be capped
  ]);
  const state = det.getState('Z');
  assert.strictEqual(state.firesToday, 2);
  assert.ok(state.lastSuppression);
  assert.strictEqual(state.lastSuppression.reason, 'daily_cap');
});

test('stale quote suppresses fire confirmation', () => {
  const det = createFireDetector({ confirmPolls: 2, staleQuoteMaxAgeMs: 5000 });
  const fires = driveTicker(det, 'Q', 100, [
    { price: 99, ageMs: 100 },
    { price: 101, ageMs: 100 },      // PENDING
    { price: 101, ageMs: 10_000 },   // stale — NOT promoted
    { price: 101, ageMs: 200 },      // fresh, but still PENDING (stale reset confirm count)
    { price: 101, ageMs: 200 },      // now FIRED
  ]);
  assert.strictEqual(fires.length, 1);
});

test('fireSuppressed flag (from stale source) blocks fire', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'S', 100, [
    { price: 99 },
    // Simulate two observations from the stale source
  ]);
  det.observe('S', { price: 101, quoteAgeMs: 100, fireSuppressed: true });
  det.observe('S', { price: 101, quoteAgeMs: 100, fireSuppressed: true });
  const state = det.getState('S');
  assert.notStrictEqual(state.state, 'FIRED');
});

test('restoreState correctly resumes FIRED ticker', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.restoreState({
    APH: { state: 'FIRED', trigger: 152.81, lastPrice: 152.90, firedEventId: 'abc', firesToday: 1 },
  });
  // Now observe another above-trigger print — should NOT re-fire (already FIRED)
  const result = det.observe('APH', { price: 153.00, quoteAgeMs: 100 });
  assert.strictEqual(result.fired, false);
  assert.strictEqual(det.getState('APH').state, 'FIRED');
});

test('upsertTicker changes trigger while preserving FIRED state', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5 });
  driveTicker(det, 'T', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // FIRED at 100 trigger
  ]);
  det.upsertTicker({ symbol: 'T', trigger: 105 }); // scanner updated trigger
  assert.strictEqual(det.getState('T').state, 'FIRED', 'state preserved');
  assert.strictEqual(det.getState('T').trigger, 105, 'trigger updated');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/fire_detector.test.js
```

- [ ] **Step 3: Implement `src/lib/fire_detector.js`**

Create `src/lib/fire_detector.js`:

```js
/**
 * Fire detector state machine: ARMED → PENDING → FIRED.
 *
 * Configurable:
 *   confirmPolls        Required consecutive above-trigger observations before FIRED (default 2)
 *   hysteresisPct       % below trigger price must reach before re-arming (default 0.5)
 *   maxFiresPerDay      Cap per ticker per trading day (default 2)
 *   staleQuoteMaxAgeMs  Quotes older than this are ignored for state transitions (default 5000)
 */

export function createFireDetector({
  confirmPolls = 2,
  hysteresisPct = 0.5,
  maxFiresPerDay = 2,
  staleQuoteMaxAgeMs = 5000,
} = {}) {
  /** @type {Map<string, object>} */
  const tickers = new Map();

  function emptyState(symbol, trigger) {
    return {
      symbol, trigger,
      state: 'ARMED',        // ARMED | PENDING | FIRED
      lastPrice: null,
      pendingSince: null,
      confirmsSeen: 0,
      firstCrossObservedAt: null,
      firedEventId: null,
      firesToday: 0,
      lastSuppression: null,
    };
  }

  function upsertTicker({ symbol, trigger }) {
    const existing = tickers.get(symbol);
    if (existing) {
      existing.trigger = trigger;
      return;
    }
    tickers.set(symbol, emptyState(symbol, trigger));
  }

  function removeTicker(symbol) { tickers.delete(symbol); }

  function restoreState(persistedTickers) {
    for (const [symbol, state] of Object.entries(persistedTickers)) {
      tickers.set(symbol, {
        ...emptyState(symbol, state.trigger),
        ...state,
      });
    }
  }

  function getState(symbol) { return tickers.get(symbol); }

  function snapshot() {
    const out = {};
    for (const [symbol, state] of tickers) out[symbol] = { ...state };
    return out;
  }

  /**
   * Observe a new quote for a ticker. Returns:
   *   { fired: boolean, firedPrice?, confirmPollCount?, firstCrossObservedAt? }
   */
  function observe(symbol, { price, quoteAgeMs = 0, fireSuppressed = false, timestamp = new Date() }) {
    const s = tickers.get(symbol);
    if (!s) return { fired: false };
    s.lastPrice = price;

    // Stale guard: block any state promotion when the quote is old.
    // Reset pending so we re-confirm with fresh data.
    if (quoteAgeMs > staleQuoteMaxAgeMs || fireSuppressed) {
      s.lastSuppression = { reason: fireSuppressed ? 'source_stale' : 'quote_stale', at: timestamp.toISOString() };
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
      }
      return { fired: false };
    }

    if (s.state === 'FIRED') {
      // Check hysteresis for potential re-arm
      const hysBand = s.trigger * (1 - hysteresisPct / 100);
      if (price < hysBand) {
        // Pull back enough to re-arm
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.firstCrossObservedAt = null;
      }
      return { fired: false };
    }

    if (price < s.trigger) {
      // Below trigger — reset to ARMED
      if (s.state === 'PENDING') {
        s.state = 'ARMED';
        s.pendingSince = null;
        s.confirmsSeen = 0;
        s.firstCrossObservedAt = null;
      }
      return { fired: false };
    }

    // price >= trigger
    if (s.state === 'ARMED') {
      s.state = 'PENDING';
      s.pendingSince = timestamp.toISOString();
      s.firstCrossObservedAt = timestamp.toISOString();
      s.confirmsSeen = 1;
      return { fired: false };
    }

    // s.state === 'PENDING'
    s.confirmsSeen++;
    if (s.confirmsSeen >= confirmPolls) {
      if (s.firesToday >= maxFiresPerDay) {
        // Daily cap — suppress
        s.lastSuppression = { reason: 'daily_cap', at: timestamp.toISOString() };
        // Promote to FIRED anyway so we don't keep confirming; will only re-fire after hysteresis reset
        s.state = 'FIRED';
        s.firedEventId = null;
        return { fired: false };
      }
      s.state = 'FIRED';
      s.firesToday++;
      return {
        fired: true,
        firedPrice: price,
        confirmPollCount: confirmPolls,
        firstCrossObservedAt: s.firstCrossObservedAt,
        confirmedAt: timestamp.toISOString(),
      };
    }
    return { fired: false };
  }

  /** Reset all tickers' daily-fire counters (called at start of each trading day). */
  function resetDailyCounters() {
    for (const s of tickers.values()) s.firesToday = 0;
  }

  return { upsertTicker, removeTicker, restoreState, observe, getState, snapshot, resetDailyCounters };
}
```

- [ ] **Step 4: Run tests — expect 8 passes**

```bash
node --test tests/fire_detector.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/fire_detector.js tests/fire_detector.test.js
git commit -m "feat(live-feed): fire detector with 3-state machine, hysteresis, daily cap"
```

---

## Task 9: Risk Flag Evaluators

**Files:**
- Create: `src/lib/risk_flags.js`
- Create: `tests/risk_flags.test.js`

- [ ] **Step 1: Write the failing tests**

Create `tests/risk_flags.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateRiskFlags } from '../src/lib/risk_flags.js';

const base = () => ({
  scannerRow: {
    details: { earningsDaysOut: 30, shortFloat: 5, sectorMomentumRank: 6 },
    notes: '4-stage VCP, extreme contraction',
  },
  quote: {
    averageDailyVolume10Day: 1_000_000,
    spreadPctOfPrice: 0.05,
    prevClose: 100,
    openToday: 101,
  },
  recentNewsCount24h: 2,
  atr14: 2.5,
});

test('green: clean setup, no risks', () => {
  const r = evaluateRiskFlags(base());
  assert.strictEqual(r.overallRiskBand, 'green');
  assert.strictEqual(r.earnings.flag, 'green');
  assert.strictEqual(r.liquidity.flag, 'green');
  assert.strictEqual(r.spread.flag, 'green');
});

test('red earnings: ≤2 days out', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = 1;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'red');
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('yellow earnings: 3-7 days out', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = 5;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'yellow');
  assert.strictEqual(r.overallRiskBand, 'yellow');
});

test('yellow earnings: corrupt sentinel defaults to yellow (never silently green)', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = -20547;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'yellow');
  assert.ok(r.earnings.reason.includes('unverified'));
});

test('yellow liquidity: 200k–500k ADV', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 300_000;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.liquidity.flag, 'yellow');
});

test('red liquidity: < 200k ADV', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 100_000;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.liquidity.flag, 'red');
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('red spread: > 0.5% of price', () => {
  const ctx = base();
  ctx.quote.spreadPctOfPrice = 0.8;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.spread.flag, 'red');
});

test('yellow spread: 0.10%–0.50%', () => {
  const ctx = base();
  ctx.quote.spreadPctOfPrice = 0.3;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.spread.flag, 'yellow');
});

test('red news gap: today opened >2 ATR from prior close', () => {
  const ctx = base();
  ctx.quote.openToday = 106;    // +6 vs prev 100
  ctx.atr14 = 2.5;              // 6 / 2.5 = 2.4 ATR
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.newsGap.flag, 'red');
});

test('yellow news gap: 1-2 ATR', () => {
  const ctx = base();
  ctx.quote.openToday = 103;    // +3 vs 100, 1.2 ATR
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.newsGap.flag, 'yellow');
});

test('merger flag red when scanner notes mention merger', () => {
  const ctx = base();
  ctx.scannerRow.notes = 'merger_pending flagged';
  ctx.scannerRow.mergerPending = true;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.mergerPending, true);
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('overall band: any red wins over yellow', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 100_000; // red
  ctx.scannerRow.details.earningsDaysOut = 5;  // yellow
  assert.strictEqual(evaluateRiskFlags(ctx).overallRiskBand, 'red');
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/risk_flags.test.js
```

- [ ] **Step 3: Implement `src/lib/risk_flags.js`**

Create `src/lib/risk_flags.js`:

```js
/**
 * Risk flag evaluators: earnings, liquidity, spread, news gap, merger, short float.
 *
 * Each dimension returns { flag: 'green'|'yellow'|'red', ...reasonFields }.
 * The overallRiskBand is red if any flag is red, yellow if any yellow, else green.
 */

function flagEarnings(daysOut) {
  // Corrupt sentinel (like ITT's -20547) → yellow with "unverified"
  if (daysOut == null || daysOut < -30 || Number.isNaN(daysOut)) {
    return { flag: 'yellow', daysUntil: null, reason: 'earnings date unverified — check broker' };
  }
  if (daysOut >= 0 && daysOut <= 2) return { flag: 'red',    daysUntil: daysOut, reason: `earnings in ${daysOut}d` };
  if (daysOut >= 3 && daysOut <= 7) return { flag: 'yellow', daysUntil: daysOut, reason: `earnings in ${daysOut}d` };
  return { flag: 'green', daysUntil: daysOut };
}

function flagLiquidity(adv10d, currentVolume) {
  const relVol = (adv10d && currentVolume) ? +(currentVolume / adv10d).toFixed(2) : null;
  if (adv10d == null) return { flag: 'yellow', avgDailyVol: null, reason: 'ADV unavailable', todayRelVolAtFire: relVol };
  if (adv10d >= 500_000) return { flag: 'green',  avgDailyVol: adv10d, todayRelVolAtFire: relVol };
  if (adv10d >= 200_000) return { flag: 'yellow', avgDailyVol: adv10d, todayRelVolAtFire: relVol };
  return { flag: 'red', avgDailyVol: adv10d, reason: 'ADV < 200k shares', todayRelVolAtFire: relVol };
}

function flagSpread(spreadPct) {
  if (spreadPct == null) return { flag: 'yellow', bpsOfPrice: null, reason: 'bid/ask unavailable' };
  const bps = +(spreadPct * 100).toFixed(1);
  if (spreadPct <= 0.10) return { flag: 'green',  bpsOfPrice: bps };
  if (spreadPct <= 0.50) return { flag: 'yellow', bpsOfPrice: bps };
  return { flag: 'red', bpsOfPrice: bps, reason: 'spread > 50 bps' };
}

function flagNewsGap(quote, atr14, newsCount24h) {
  if (!quote || quote.prevClose == null || quote.openToday == null || atr14 == null || atr14 === 0) {
    return { flag: 'yellow', todayGapSigma: null, reason: 'gap data unavailable' };
  }
  const gap = Math.abs(quote.openToday - quote.prevClose);
  const sigma = +(gap / atr14).toFixed(2);
  if (sigma <= 1) return { flag: 'green',  todayGapSigma: sigma, newsCount24h };
  if (sigma <= 2) return { flag: 'yellow', todayGapSigma: sigma, newsCount24h };
  return { flag: 'red', todayGapSigma: sigma, newsCount24h, reason: `open gapped ${sigma.toFixed(1)} ATR` };
}

function flagShortFloat(sfPct) {
  if (sfPct == null) return { flag: 'green', pct: null };
  if (sfPct >= 20) return { flag: 'red',    pct: sfPct, reason: `short float ${sfPct}%` };
  if (sfPct >= 10) return { flag: 'yellow', pct: sfPct };
  return { flag: 'green', pct: sfPct };
}

export function evaluateRiskFlags({ scannerRow = {}, quote = {}, recentNewsCount24h = 0, atr14 = null } = {}) {
  const details = scannerRow.details || {};
  const earnings   = flagEarnings(details.earningsDaysOut);
  const liquidity  = flagLiquidity(quote.averageDailyVolume10Day, quote.volume);
  const spread     = flagSpread(quote.spreadPctOfPrice);
  const newsGap    = flagNewsGap(quote, atr14, recentNewsCount24h);
  const shortFloat = flagShortFloat(details.shortFloat);
  const mergerPending = !!(scannerRow.mergerPending || /merger[_\- ]?pending/i.test(scannerRow.notes || ''));

  const dims = { earnings, liquidity, spread, newsGap, shortFloat };
  const anyRed = Object.values(dims).some(d => d.flag === 'red') || mergerPending;
  const anyYellow = Object.values(dims).some(d => d.flag === 'yellow');
  const overallRiskBand = anyRed ? 'red' : (anyYellow ? 'yellow' : 'green');

  return { ...dims, mergerPending, recentNewsCount24h, overallRiskBand };
}
```

- [ ] **Step 4: Run tests — expect 12 passes**

```bash
node --test tests/risk_flags.test.js
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/risk_flags.js tests/risk_flags.test.js
git commit -m "feat(live-feed): risk flag evaluators with green/yellow/red bands"
```

---

## Task 10: Live Price Poller (Integration)

**Files:**
- Create: `scripts/scanner/live_price_poller.js`
- Create: `tests/live_price_poller.test.js`

- [ ] **Step 1: Write the failing integration test**

Create `tests/live_price_poller.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { createLivePoller } from '../scripts/scanner/live_price_poller.js';

function mkFakeChain(priceSeq) {
  let tick = 0;
  return {
    async fetchQuotes(symbols) {
      const priceForTick = priceSeq[tick++] || priceSeq[priceSeq.length - 1];
      const quotes = {};
      for (const s of symbols) {
        quotes[s] = {
          symbol: s, price: priceForTick[s] ?? null,
          bid: priceForTick[s] ? priceForTick[s] - 0.05 : null,
          ask: priceForTick[s] ? priceForTick[s] + 0.05 : null,
          spreadAbsolute: 0.10, spreadPctOfPrice: 0.01,
          averageDailyVolume10Day: 1_000_000, volume: 500_000,
          prevClose: 150, openToday: 150.5,
          marketTimeIso: new Date().toISOString(),
          quoteSource: 'yahoo', quoteAgeMs: 100,
        };
      }
      return { quotes, fetchedAt: new Date() };
    },
    async probe() {},
    activeSourceName: () => 'yahoo',
    cachePrime: () => {},
  };
}

test('fires when a candidate crosses trigger with 2-poll confirmation', async () => {
  const chain = mkFakeChain([
    { APH: 150.00 },   // below trigger
    { APH: 153.00 },   // above #1 — PENDING
    { APH: 153.10 },   // above #2 — FIRE
  ]);
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'APH', trigger: 152.81, confidence: 'HIGH', setupType: 'building_base', rank: 6, confidenceBand: { low: 61, mid: 66, high: 71 }, probabilityScore: 66 }] }),
    chain,
    onFire: (e) => fires.push(e),
    onError: () => {},
    isMarketOpen: () => true,
  });
  await poller.tick();
  await poller.tick();
  await poller.tick();
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].ticker, 'APH');
  assert.strictEqual(fires[0].price.firedPrice, 153.10);
});

test('does not poll when market is closed', async () => {
  let chainCalls = 0;
  const chain = {
    async fetchQuotes() { chainCalls++; return { quotes: {}, fetchedAt: new Date() }; },
    async probe() {}, activeSourceName: () => 'yahoo', cachePrime: () => {},
  };
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'X', trigger: 10 }] }),
    chain, onFire: () => {}, onError: () => {},
    isMarketOpen: () => false,
  });
  await poller.tick();
  assert.strictEqual(chainCalls, 0);
});
```

- [ ] **Step 2: Run — expect failure**

```bash
node --test tests/live_price_poller.test.js
```

- [ ] **Step 3: Implement `scripts/scanner/live_price_poller.js`**

Create `scripts/scanner/live_price_poller.js`:

```js
/**
 * Live price poller — orchestrates quote-source chain + fire detector + risk flags.
 *
 * Designed for injection: the server wires real dependencies; tests wire mocks.
 */

import { createFireDetector } from '../../src/lib/fire_detector.js';
import { evaluateRiskFlags } from '../../src/lib/risk_flags.js';

export function createLivePoller({
  getCandidates,      // () => { candidates: [...], scanRunId?: string }
  chain,              // quote-source chain
  onFire,             // (event) => void
  onTick,             // optional (tickerSnapshot) => void
  onError,            // (err) => void
  isMarketOpen,       // () => boolean
  getMarketContext,   // optional () => { vix, spxChangePct, qqqChangePct, regimeMultiplier, vixRegime }
  detectorOptions,    // passed through
}) {
  const detector = createFireDetector(detectorOptions);
  let pollSequence = 0;
  let lastCandidateSet = new Set();

  function syncCandidates() {
    const c = getCandidates();
    const current = new Set(c.candidates.map(x => x.symbol));
    // Upsert all current candidates
    for (const cand of c.candidates) detector.upsertTicker({ symbol: cand.symbol, trigger: cand.trigger });
    // Remove ones that dropped out
    for (const sym of lastCandidateSet) if (!current.has(sym)) detector.removeTicker(sym);
    lastCandidateSet = current;
    return c;
  }

  async function tick() {
    if (!isMarketOpen()) return { skipped: 'market_closed' };
    pollSequence++;

    const { candidates, scanRunId } = syncCandidates();
    if (!candidates.length) return { skipped: 'no_candidates' };

    const symbols = candidates.map(c => c.symbol);
    let fetchResult;
    try {
      fetchResult = await chain.fetchQuotes(symbols);
    } catch (err) {
      onError?.({ type: 'fetch_error', error: err.message });
      return { skipped: 'fetch_error' };
    }

    const now = new Date();
    const marketContext = getMarketContext ? getMarketContext() : {};

    for (const cand of candidates) {
      const quote = fetchResult.quotes[cand.symbol];
      if (!quote || quote.price == null) {
        onTick?.({ symbol: cand.symbol, price: null, stale: true });
        continue;
      }

      onTick?.({
        symbol: cand.symbol,
        price: quote.price,
        trigger: cand.trigger,
        source: quote.quoteSource,
        state: detector.getState(cand.symbol)?.state,
      });

      const result = detector.observe(cand.symbol, {
        price: quote.price,
        quoteAgeMs: quote.quoteAgeMs,
        fireSuppressed: quote.fireSuppressed,
        timestamp: now,
      });

      if (result.fired) {
        const risk = evaluateRiskFlags({
          scannerRow: cand.raw ?? { details: {}, notes: '' },
          quote,
          recentNewsCount24h: cand.recentNewsCount24h ?? 0,
          atr14: cand.atr14 ?? null,
        });
        const event = {
          ticker: cand.symbol,
          trigger: { level: cand.trigger, source: 'scanner_v3', scanRunId, entryTriggerText: cand.triggerText },
          price: {
            firedPrice: quote.price, bid: quote.bid, ask: quote.ask,
            spreadAbsolute: quote.spreadAbsolute, spreadPctOfPrice: quote.spreadPctOfPrice,
            quoteSource: quote.quoteSource, quoteAgeMs: quote.quoteAgeMs,
            openToday: quote.openToday, prevClose: quote.prevClose,
            dayChangePct: quote.prevClose ? +((quote.price - quote.prevClose) / quote.prevClose * 100).toFixed(2) : null,
            gapFromPrevClose: quote.prevClose ? +((quote.openToday - quote.prevClose) / quote.prevClose * 100).toFixed(3) : null,
          },
          debounce: {
            confirmPollCount: result.confirmPollCount,
            firstCrossObservedAt: result.firstCrossObservedAt,
            confirmedAt: result.confirmedAt,
            latencyFromFirstCrossMs: new Date(result.confirmedAt) - new Date(result.firstCrossObservedAt),
          },
          setup: {
            confidence: cand.confidence, confidenceBand: cand.confidenceBand,
            setupType: cand.setupType, compositeScore: cand.compositeScore ?? null,
            probabilityScore: cand.probabilityScore, rank: cand.rank,
          },
          marketContext,
          riskFlags: risk,
          pollSequence,
          timestamp: now.toISOString(),
        };
        onFire?.(event);
      }
    }
    return { polled: true, pollSequence };
  }

  return { tick, detector };
}
```

- [ ] **Step 4: Run tests — expect 2 passes**

```bash
node --test tests/live_price_poller.test.js
```

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/live_price_poller.js tests/live_price_poller.test.js
git commit -m "feat(live-feed): live price poller wires detector + risk flags + chain"
```

---

## Task 11: SSE Endpoint in `live_server.js`

**Files:**
- Modify: `scripts/dashboard/live_server.js`

- [ ] **Step 1: Read the existing server and identify the insertion point**

Open `scripts/dashboard/live_server.js`. Note:
- The HTTP handler is `serveHtml(req, res)` at around line 165.
- The `server.listen(PORT, ...)` block is around line 190.

The plan: add an SSE client registry + a new `/events` route handled before the HTML fallthrough. On each event emission, push to all registered clients.

- [ ] **Step 2: Add SSE client registry and event broadcaster**

At the top of `scripts/dashboard/live_server.js` (right after the existing `let building = false; let buildCount = 0;` lines), insert:

```js
// ─── SSE subscribers ──────────────────────────────────────────────────────
const sseClients = new Set();

function sseBroadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); }
    catch (e) { sseClients.delete(res); }
  }
}
```

- [ ] **Step 3: Modify `serveHtml` to route `/events` to the SSE handler**

Replace the opening of `serveHtml(req, res)` — the current check:

```js
function serveHtml(req, res) {
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
```

With:

```js
function serveHtml(req, res) {
  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }
  if (req.url !== '/' && req.url !== '/index.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
```

- [ ] **Step 4: Export `sseBroadcast` on the module scope via a side-effect**

The server file is invoked directly (not imported). The poller integration in Task 12 will need to call `sseBroadcast`. Declare it as a file-scoped symbol that the poller wiring (also added in Task 12) can use directly.

No code change required here — Task 12 writes both the poller wiring and its broadcast calls in the same file.

- [ ] **Step 5: Manual smoke test**

Start the server:

```bash
node scripts/dashboard/live_server.js
```

In another terminal:

```bash
curl -N http://localhost:3333/events
```

Expected: the response stays open (no terminal prompt returns). You should see `: connected` immediately. Leave it open — Task 12 will fire real events.

Stop the server with Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add scripts/dashboard/live_server.js
git commit -m "feat(live-feed): add SSE /events endpoint to live server"
```

---

## Task 12: Wire Poller Into `live_server.js`

**Files:**
- Modify: `scripts/dashboard/live_server.js`

- [ ] **Step 1: Add imports at the top of `live_server.js`**

After the existing `import { execFile } from 'child_process';` line, add:

```js
import { getMarketMode } from '../../src/lib/market_hours.js';
import { readCandidates } from '../../src/lib/candidate_reader.js';
import { createFireLog } from '../../src/lib/fire_events.js';
import { createStateStore } from '../../src/lib/poller_state.js';
import { fetchQuotes as yahooFetch } from '../../src/lib/quote_sources/yahoo.js';
import { tvCdpFetchQuotes } from '../../src/lib/quote_sources/tv_cdp.js';
import { createQuoteChain } from '../../src/lib/quote_sources/chain.js';
import { createLivePoller } from '../scanner/live_price_poller.js';
```

- [ ] **Step 2: Add poller configuration constants**

Below the existing `const REBUILD_INTERVAL_MS = 60 * 1000;` line, add:

```js
const POLL_INTERVAL_MS = 15 * 1000;
const STATE_SNAPSHOT_INTERVAL_MS = 60 * 1000;
const FIRES_BASE_DIR = path.join(__dirname, '..', '..', 'data');
const POLLER_STATE_PATH = path.join(FIRES_BASE_DIR, 'poller_state.json');

// Shadow mode: when SHADOW_MODE=1, do everything except dispatch the Windows toast.
// Fires still appear in dashboard + audit log.
const SHADOW_MODE = process.env.SHADOW_MODE === '1';
```

- [ ] **Step 3: Build the quote chain, fire log, and poller**

Before the `server.listen(PORT, ...)` call, add:

```js
// ─── Build quote chain ────────────────────────────────────────────────────
const yahooSource = {
  name: 'yahoo',
  async fetch(symbols) {
    // yahooFetch throws on error — chain expects this
    return await yahooFetch(symbols);
  },
};

// TV CDP dataCore shim — loads src/core/data.js lazily so the live server
// doesn't require TradingView to be running just to boot up.
let dataCoreCache = null;
async function getDataCore() {
  if (!dataCoreCache) {
    const mod = await import('../../src/core/data.js').catch(() => null);
    dataCoreCache = mod?.data || { async getQuote() { return null; } };
  }
  return dataCoreCache;
}

const tvCdpSource = {
  name: 'tv_cdp',
  async fetch(symbols) {
    const dc = await getDataCore();
    return await tvCdpFetchQuotes(symbols, { dataCore: dc });
  },
};

const quoteChain = createQuoteChain({ sources: [yahooSource, tvCdpSource], flipAfterFailures: 5 });

// ─── Fire log + state store ───────────────────────────────────────────────
const fireLog = createFireLog({ baseDir: FIRES_BASE_DIR });
const stateStore = createStateStore({ filePath: POLLER_STATE_PATH });

// ─── Build poller ─────────────────────────────────────────────────────────
const livePoller = createLivePoller({
  getCandidates: () => readCandidates(SCANNER_RESULTS),
  chain: quoteChain,
  isMarketOpen: () => {
    const m = getMarketMode();
    return m.mode === 'REGULAR' || m.mode === 'PRE_WARM' || m.mode === 'CLOSE_CAPTURE';
  },
  getMarketContext: () => ({}),  // Phase G may populate from dashboard build
  onFire: (event) => {
    const stored = fireLog.recordFire(event);
    sseBroadcast('fire', stored);
    const mode = getMarketMode().mode;
    const suppressed = SHADOW_MODE || mode === 'PRE_WARM';
    log(`🎯 FIRE ${event.ticker} @ ${event.price.firedPrice} (trigger ${event.trigger.level}) band=${event.riskFlags.overallRiskBand}${suppressed ? ' [suppressed: ' + (SHADOW_MODE ? 'shadow' : 'pre_warm') + ']' : ''}`);
  },
  onTick: (snapshot) => {
    sseBroadcast('tick', snapshot);
  },
  onError: (err) => {
    sseBroadcast('source_status', { status: 'degraded', ...err, activeSource: quoteChain.activeSourceName() });
  },
});

// Restore state on startup
(function restoreOnBoot() {
  if (stateStore.isFresh()) {
    const persisted = stateStore.read();
    livePoller.detector.restoreState(persisted.tickers || {});
    log(`[poller] restored state for ${Object.keys(persisted.tickers || {}).length} tickers`);
  } else {
    log('[poller] no fresh state to restore — starting cold');
  }
})();

setInterval(async () => {
  try {
    const res = await livePoller.tick();
    if (res.polled) sseBroadcast('scan_refreshed', { lastPoll: new Date().toISOString(), activeSource: quoteChain.activeSourceName() });
  } catch (err) {
    log(`[poller] tick error: ${err.message}`);
  }
}, POLL_INTERVAL_MS);

setInterval(() => {
  stateStore.write({
    asOf: new Date().toISOString(),
    tickers: livePoller.detector.snapshot(),
    circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
  });
}, STATE_SNAPSHOT_INTERVAL_MS);

// Reset daily fire counters at 9:30 AM ET each day
setInterval(() => {
  const m = getMarketMode();
  if (m.mode === 'PRE_WARM') livePoller.detector.resetDailyCounters();
}, 60_000);
```

- [ ] **Step 4: Update the startup banner to show live-feed config**

Inside `server.listen(PORT, () => { ... })`, below the existing `console.log` lines, add:

```js
  console.log(`  Poller:   every ${POLL_INTERVAL_MS / 1000}s during market hours`);
  console.log(`  Shadow:   ${SHADOW_MODE ? 'ON (no toasts will be dispatched)' : 'OFF'}`);
  console.log(`  Fires:    ${FIRES_BASE_DIR}`);
```

- [ ] **Step 5: Run the server with the scanner already populated, verify boot**

```bash
node scripts/dashboard/live_server.js
```

Expected in the log (within 15s of start, outside market hours):
```
[poller] no fresh state to restore — starting cold
```
No crash. Ctrl+C.

- [ ] **Step 6: Commit**

```bash
git add scripts/dashboard/live_server.js
git commit -m "feat(live-feed): wire poller + fire log + state store into live_server"
```

---

## Task 13: Dashboard SSE Client + Live Price Column

**Files:**
- Modify: `scripts/dashboard/build_dashboard_html.js`

- [ ] **Step 1: Locate the Coiled Springs card renderer**

Open `scripts/dashboard/build_dashboard_html.js`. Find the function `buildCoiledSpringHtml()` (around line 2026 per prior grep).

- [ ] **Step 2: Add `data-cs-row` attributes so the SSE client can find rows**

Inside `buildCoiledSpringHtml()`, where each candidate card/row HTML is generated, add `data-cs-row="${c.symbol}"` and a `data-cs-trigger="${c.entry_trigger}"` attribute on the outermost element of each row.

Find the existing row template inside the for-loop over `coiledSpringResults.results`. Add these two attributes to the parent `<div>` or `<tr>`. Also include three spans with specific ids or classes for the dynamic fields:

```html
<span class="cs-live-price" data-sym="${c.symbol}">${c.price}</span>
<span class="cs-delta-to-trigger" data-sym="${c.symbol}">—</span>
<span class="cs-fire-badge" data-sym="${c.symbol}" style="display:none;">FIRED TODAY</span>
```

Place them adjacent to the static price display. Keep the static display as a fallback for when SSE is disconnected.

- [ ] **Step 3: Inject the SSE client JavaScript**

Find the existing `<script>...</script>` block near the end of the HTML template (search for the last major script tag before `</body>`). Insert this new block immediately after it:

```html
<script>
(function () {
  if (typeof EventSource === 'undefined') return;
  const es = new EventSource('/events');
  const rowCache = {};

  function updatePrice(sym, price, state) {
    const el = document.querySelector(`.cs-live-price[data-sym="${sym}"]`);
    if (!el) return;
    const prevText = el.textContent;
    el.textContent = '$' + price.toFixed(2);
    // Flash green if higher, red if lower
    const prev = parseFloat(prevText.replace('$',''));
    if (!isNaN(prev)) {
      el.style.transition = 'background-color 0.4s';
      el.style.backgroundColor = price > prev ? 'rgba(46,204,113,0.3)' : price < prev ? 'rgba(231,76,60,0.3)' : '';
      setTimeout(() => { el.style.backgroundColor = ''; }, 400);
    }
  }

  function updateDelta(sym, price, trigger) {
    const el = document.querySelector(`.cs-delta-to-trigger[data-sym="${sym}"]`);
    if (!el || !trigger) return;
    const deltaPct = ((trigger - price) / price) * 100;
    el.textContent = deltaPct > 0 ? `+${deltaPct.toFixed(2)}% to trigger` : `FIRED`;
    el.style.color = deltaPct > 0 ? 'var(--text-dim)' : '#2ecc71';
  }

  function markFired(sym) {
    const badge = document.querySelector(`.cs-fire-badge[data-sym="${sym}"]`);
    if (badge) badge.style.display = 'inline-block';
    const row = document.querySelector(`[data-cs-row="${sym}"]`);
    if (row) row.classList.add('cs-fired-today');
  }

  es.addEventListener('tick', (ev) => {
    const d = JSON.parse(ev.data);
    if (d.price == null) return;
    rowCache[d.symbol] = d;
    updatePrice(d.symbol, d.price, d.state);
    updateDelta(d.symbol, d.price, d.trigger);
  });

  es.addEventListener('fire', (ev) => {
    const f = JSON.parse(ev.data);
    markFired(f.ticker);
    window.__lastFire = f;
    if (typeof window.__onDashboardFire === 'function') {
      window.__onDashboardFire(f);
    }
  });

  es.addEventListener('source_status', (ev) => {
    const s = JSON.parse(ev.data);
    const banner = document.getElementById('cs-source-banner');
    if (banner) {
      banner.textContent = `⚠ Quote source: ${s.activeSource} (${s.status})`;
      banner.style.display = 'block';
    }
  });

  es.onerror = () => {
    const banner = document.getElementById('cs-source-banner');
    if (banner) { banner.textContent = '⚠ SSE disconnected — reconnecting...'; banner.style.display = 'block'; }
  };
  es.onopen = () => {
    const banner = document.getElementById('cs-source-banner');
    if (banner) banner.style.display = 'none';
  };
})();
</script>
```

- [ ] **Step 4: Add the source-status banner and CSS**

Find the top of the Coiled Springs tab content (where `coiledSpringHtml` is inserted). Inside the `section-explosion` or analogous wrapper, add a banner at the top:

```html
<div id="cs-source-banner" style="display:none; background:rgba(241,196,15,0.18); color:#f1c40f; padding:8px 14px; border-radius:6px; margin-bottom:12px; font-size:14px;"></div>
```

Inside the existing stylesheet `<style>` block (search for CSS class definitions like `.exp-filter`), add:

```css
.cs-fired-today { background: rgba(231,76,60,0.10); border-left: 3px solid #e74c3c; }
.cs-fire-badge { display: inline-block; background: #e74c3c; color: white; padding: 2px 8px; border-radius: 4px; font-weight: 600; font-size: 11px; margin-left: 6px; }
.cs-live-price { font-weight: 600; font-family: ui-monospace, monospace; }
.cs-delta-to-trigger { font-size: 11px; color: var(--text-dim); margin-left: 6px; }
```

- [ ] **Step 5: Hydrate sticky badges on page load from today's fire log**

At the end of `build_dashboard_html.js`, before the final `fs.writeFileSync` call that writes `Dashboard.html`, read today's fires and inject them as initial `window.__todaysFires` so the SSE client can mark the badges on load:

```js
// Hydrate today's fires into the page as initial state
import { createFireLog as createFireLogHydrate } from '../../src/lib/fire_events.js';
// (Place this import at the top of the file with the other imports. The rename
//  "createFireLogHydrate" is to avoid a name collision if another area of the
//  file later imports createFireLog.)

const FIRES_BASE_DIR_HYDRATE = path.join(path.dirname(process.argv[1] || '.'), '..', '..', 'data');
let todaysFires = [];
try {
  const hydrationLog = createFireLogHydrate({ baseDir: FIRES_BASE_DIR_HYDRATE });
  todaysFires = hydrationLog.getTodaysFires();
} catch (e) {
  console.warn(`[hydrate] could not load fires: ${e.message}`);
}
```

And in the HTML template, after the main SSE client script, inject this hydration block:

```html
<script>
  window.__todaysFires = ${JSON.stringify(todaysFires)};
  document.addEventListener('DOMContentLoaded', () => {
    for (const f of (window.__todaysFires || [])) {
      const badge = document.querySelector(`.cs-fire-badge[data-sym="${f.ticker}"]`);
      if (badge) badge.style.display = 'inline-block';
      const row = document.querySelector(`[data-cs-row="${f.ticker}"]`);
      if (row) row.classList.add('cs-fired-today');
    }
  });
</script>
```

- [ ] **Step 6: Rebuild and smoke test**

```bash
SKIP_OPTIONS=1 node scripts/dashboard/build_dashboard_html.js
```

Open `Dashboard.html` in a browser, navigate to the Coiled Springs tab. Verify rows render with the new `data-cs-row` attributes visible in DevTools Inspector. SSE will not work when the HTML is opened as a file directly — that's expected; Task 14+ tests this end-to-end via `live_server.js`.

- [ ] **Step 7: Commit**

```bash
git add scripts/dashboard/build_dashboard_html.js
git commit -m "feat(live-feed): dashboard SSE client + live price column + sticky badges"
```

---

## Task 14: Fire Banner + Risk Flag Chips + Toast Dispatcher

**Files:**
- Modify: `scripts/dashboard/build_dashboard_html.js`

- [ ] **Step 1: Add the fire banner HTML**

In `build_dashboard_html.js`, in the main HTML template (near the top-level body, before the tab navigation), add:

```html
<div id="cs-fire-banner" style="display:none; position:fixed; top:10px; left:50%; transform:translateX(-50%); background:#e74c3c; color:white; padding:14px 28px; border-radius:8px; font-weight:600; box-shadow:0 4px 16px rgba(0,0,0,0.4); z-index:9999; cursor:pointer;" onclick="this.style.display='none'">
  <span id="cs-fire-banner-text"></span>
  <span style="font-size:11px; opacity:0.7; margin-left:14px;">click to dismiss</span>
</div>
```

- [ ] **Step 2: Add risk-flag chip renderer**

Inside `buildCoiledSpringHtml()`, where each row is rendered, add a dedicated cell for risk flag chips. The data source is the scanner output (which has the flags we need). Add a helper function above `buildCoiledSpringHtml`:

```js
function riskChipsHtml(candidate) {
  // Use the same evaluation at build time so chips reflect at-scan risk;
  // the SSE client will update these live when fires arrive.
  const chips = [];
  const details = candidate.details || {};
  const daysOut = details.earningsDaysOut;
  if (daysOut != null && daysOut >= 0 && daysOut <= 2) chips.push({ text: `🚨 earnings ${daysOut}d`, color: '#e74c3c' });
  else if (daysOut != null && daysOut >= 3 && daysOut <= 7) chips.push({ text: `⚠ earnings ${daysOut}d`, color: '#f1c40f' });
  const adv = details.averageDailyVolume10Day;
  if (adv != null && adv < 200_000) chips.push({ text: `🚨 low vol`, color: '#e74c3c' });
  else if (adv != null && adv < 500_000) chips.push({ text: `⚠ moderate vol`, color: '#f1c40f' });
  if (/merger[_ ]pending/i.test(candidate.notes || '')) chips.push({ text: '🚩 merger', color: '#e74c3c' });
  if (details.shortFloat != null && details.shortFloat >= 20) chips.push({ text: `⚠ ${details.shortFloat}% short`, color: '#e74c3c' });
  return chips.map(c => `<span class="cs-risk-chip" style="background:${c.color}22;color:${c.color};padding:2px 7px;border-radius:4px;font-size:10px;margin-right:4px;">${c.text}</span>`).join('');
}
```

Inside each row, insert:

```js
<div class="cs-risk-chips" data-sym="${c.symbol}">${riskChipsHtml(c)}</div>
```

- [ ] **Step 3: Wire up the toast dispatcher**

In the SSE client script block (added in Task 13), replace the stub:

```js
if (typeof window.__onDashboardFire === 'function') {
  window.__onDashboardFire(f);
}
```

with this full toast dispatcher:

```js
// Banner
const banner = document.getElementById('cs-fire-banner');
const bannerText = document.getElementById('cs-fire-banner-text');
if (banner && bannerText) {
  const emoji = f.riskFlags.overallRiskBand === 'red' ? '🚨' : f.riskFlags.overallRiskBand === 'yellow' ? '⚠' : '✅';
  const riskReason = f.riskFlags.overallRiskBand !== 'green'
    ? ' — ' + [
        f.riskFlags.earnings.flag !== 'green' && f.riskFlags.earnings.reason,
        f.riskFlags.liquidity.flag !== 'green' && f.riskFlags.liquidity.reason,
        f.riskFlags.spread.flag !== 'green' && f.riskFlags.spread.reason,
        f.riskFlags.newsGap.flag !== 'green' && f.riskFlags.newsGap.reason,
      ].filter(Boolean).join(', ')
    : ' — clean setup';
  bannerText.innerHTML = `${emoji} <b>${f.ticker}</b> fired @ $${f.price.firedPrice.toFixed(2)} (trigger $${f.trigger.level.toFixed(2)})${riskReason}`;
  banner.style.display = 'block';
  setTimeout(() => { banner.style.display = 'none'; }, 60_000);
}

// Windows desktop toast
if (window.Notification && Notification.permission === 'granted') {
  const titleEmoji = f.riskFlags.overallRiskBand === 'red' ? '🚨' : f.riskFlags.overallRiskBand === 'yellow' ? '⚠' : '✅';
  const body = f.riskFlags.overallRiskBand === 'red' ? 'Red-flag fire — read context before acting'
             : f.riskFlags.overallRiskBand === 'yellow' ? 'Yellow-flag fire — check risk before acting'
             : 'Clean setup — review chart';
  try {
    new Notification(`${titleEmoji} ${f.ticker} fired @ $${f.price.firedPrice.toFixed(2)}`, {
      body: `Trigger $${f.trigger.level.toFixed(2)} — ${f.setup.confidence} conf — ${f.setup.setupType}\n${body}`,
      tag: `cs-fire-${f.ticker}-${f.pollSequence}`,
      icon: '/favicon.ico',
    });
  } catch (e) {
    console.warn('Notification dispatch failed:', e.message);
  }
}
```

- [ ] **Step 4: Rebuild and smoke test**

```bash
SKIP_OPTIONS=1 node scripts/dashboard/build_dashboard_html.js
```

Open `Dashboard.html`. In DevTools console:

```js
window.__lastFire = { ticker:'TEST', price:{firedPrice:100}, trigger:{level:99}, setup:{confidence:'HIGH', setupType:'building_base'}, pollSequence:1, riskFlags:{overallRiskBand:'green',earnings:{flag:'green',reason:''},liquidity:{flag:'green',reason:''},spread:{flag:'green',reason:''},newsGap:{flag:'green',reason:''}} };
// Simulate a fire event by dispatching to the SSE listener directly:
const simEv = new MessageEvent('fire', { data: JSON.stringify(window.__lastFire) });
document.dispatchEvent(simEv);
```

(If the EventSource isn't connected because we're on file://, this is expected — Task 15 tests end-to-end via the server.)

- [ ] **Step 5: Commit**

```bash
git add scripts/dashboard/build_dashboard_html.js
git commit -m "feat(live-feed): fire banner + risk chips + toast dispatcher"
```

---

## Task 15: Browser Notification Permission Prompt

**Files:**
- Modify: `scripts/dashboard/build_dashboard_html.js`

- [ ] **Step 1: Add the permission prompt UI**

Near the top of the body in the HTML template (before the tab nav), add:

```html
<div id="cs-notif-prompt" style="display:none; position:fixed; bottom:20px; right:20px; background:#2c3e50; color:white; padding:14px 20px; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.4); z-index:9998; max-width:340px; font-size:14px;">
  <div style="margin-bottom:8px;">🔔 Enable desktop notifications to get alerts when a coiled spring fires — even when this tab is in the background.</div>
  <button id="cs-notif-yes" style="background:#2ecc71;color:white;border:0;padding:8px 14px;border-radius:4px;cursor:pointer;margin-right:8px;">Enable</button>
  <button id="cs-notif-no"  style="background:transparent;color:#bdc3c7;border:1px solid #7f8c8d;padding:8px 14px;border-radius:4px;cursor:pointer;">Not now</button>
</div>
```

- [ ] **Step 2: Add the permission-handling script**

Inside an existing `<script>` block at the bottom of the body, add:

```html
<script>
(function () {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') return;
  if (Notification.permission === 'denied') return;
  if (localStorage.getItem('cs-notif-declined') === '1') return;

  const prompt = document.getElementById('cs-notif-prompt');
  const yes = document.getElementById('cs-notif-yes');
  const no = document.getElementById('cs-notif-no');
  if (!prompt) return;
  prompt.style.display = 'block';

  yes.addEventListener('click', async () => {
    prompt.style.display = 'none';
    try {
      await Notification.requestPermission();
    } catch (e) {
      console.warn('Permission request failed:', e);
    }
  });
  no.addEventListener('click', () => {
    prompt.style.display = 'none';
    localStorage.setItem('cs-notif-declined', '1');
  });
})();
</script>
```

- [ ] **Step 3: Rebuild and manual test**

```bash
SKIP_OPTIONS=1 node scripts/dashboard/build_dashboard_html.js
```

Serve via the live server (file:// won't work for Notifications):

```bash
node scripts/dashboard/live_server.js
```

Open http://localhost:3333/ in Chrome/Edge. The prompt should appear in the bottom-right. Click "Enable" and grant permission. Refresh — prompt should not re-appear.

- [ ] **Step 4: Commit**

```bash
git add scripts/dashboard/build_dashboard_html.js
git commit -m "feat(live-feed): browser notification permission prompt"
```

---

## Task 16: Shadow Mode Config + Documentation

**Files:**
- Modify: `scripts/dashboard/build_dashboard_html.js`
- Create: `docs/live-feed-operations.md`

- [ ] **Step 1: Inject a visible shadow-mode banner in the dashboard**

At the top of the Coiled Springs section (same place as the source-status banner from Task 13), read the env var at build time and inject:

```js
const isShadow = process.env.SHADOW_MODE === '1';
```

And in the template:

```html
${isShadow ? '<div style="background:#f39c12;color:#000;padding:10px 14px;border-radius:6px;margin-bottom:14px;font-weight:600;">🛡 SHADOW MODE — fires log to disk but Windows toasts are suppressed.</div>' : ''}
```

- [ ] **Step 2: Suppress toast dispatch in shadow mode**

The toast dispatcher (Task 14) needs to respect shadow mode. Add to the top of the `addEventListener('fire', ...)` handler in the SSE client script:

```js
// Shadow mode is communicated via the window.__shadowMode flag set at build time
if (window.__shadowMode && typeof window.Notification !== 'undefined') {
  // Do not dispatch a Windows toast, but still update the dashboard
  // (banner + sticky badge still work)
  markFired(f.ticker);
  if (document.getElementById('cs-fire-banner')) {
    // still show banner
    const banner = document.getElementById('cs-fire-banner');
    const text = document.getElementById('cs-fire-banner-text');
    banner.style.background = '#f39c12';
    text.innerHTML = `🛡 SHADOW: <b>${f.ticker}</b> fired @ $${f.price.firedPrice.toFixed(2)} (toast suppressed)`;
    banner.style.display = 'block';
    setTimeout(() => { banner.style.display = 'none'; }, 60_000);
  }
  return;
}
```

And inject the flag into the page at build time:

```html
<script>window.__shadowMode = ${isShadow};</script>
```

- [ ] **Step 3: Write operations documentation**

Create `docs/live-feed-operations.md`:

```markdown
# Coiled Spring Live Feed — Operations Guide

## Starting the live feed

```bash
node scripts/dashboard/live_server.js
```

Open http://localhost:3333 in your browser. Grant notification permission when prompted.

## Shadow mode (recommended for first 2 weeks)

```bash
SHADOW_MODE=1 node scripts/dashboard/live_server.js
```

All fires are logged and surfaced in the dashboard banner. Windows desktop toasts are suppressed.

Use this while tuning debouncing and measuring noise levels before enabling full alerts.

## Files produced

- `data/coiled_spring_fires_YYYY-MM-DD.json` — daily fire audit log, one per trading day
- `data/poller_state.json` — in-memory state snapshot, updated every 60s

## Auto-start on Windows login

See `scripts/setup_autostart.ps1` and Task 17 of the plan.

## Reviewing a day's fires

Open the JSON directly or run (Phase G):

```bash
node scripts/dashboard/fire_metrics.js --date=2026-04-24
```
```

- [ ] **Step 4: Rebuild + commit**

```bash
SKIP_OPTIONS=1 node scripts/dashboard/build_dashboard_html.js
git add scripts/dashboard/build_dashboard_html.js docs/live-feed-operations.md
git commit -m "feat(live-feed): shadow mode banner + toast suppression + ops docs"
```

---

## Task 17: Windows Task Scheduler Autostart

**Files:**
- Create: `scripts/setup_autostart.ps1`

- [ ] **Step 1: Write the PowerShell script**

Create `scripts/setup_autostart.ps1`:

```powershell
<#
.SYNOPSIS
  Register (or unregister) the TradingView Live Dashboard as a Windows scheduled
  task that auto-starts on user logon.

.PARAMETER Remove
  Unregister the task and exit.

.EXAMPLE
  ./scripts/setup_autostart.ps1            # install/update
  ./scripts/setup_autostart.ps1 -Remove    # uninstall
#>

param(
  [switch]$Remove
)

$TaskName = 'TradingView Live Dashboard'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ServerScript = Join-Path $RepoRoot 'scripts\dashboard\live_server.js'
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$LogPath = Join-Path $RepoRoot 'data\live_server.log'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Unregistered task '$TaskName'."
  } else {
    Write-Host "Task '$TaskName' not found."
  }
  exit 0
}

if (-not (Test-Path $ServerScript)) {
  Write-Error "Server script not found: $ServerScript"
  exit 1
}

# Ensure log directory exists
$LogDir = Split-Path $LogPath -Parent
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# Build a minimized-window cmd wrapper so the node process is visible in the
# taskbar but not in the foreground.
$CmdWrapper = "cmd.exe /c start ""TradingView Live Dashboard"" /min ""$NodeExe"" ""$ServerScript"" 1>> ""$LogPath"" 2>&1"

$Action  = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start """"TradingView Live Dashboard"""" /min ""$NodeExe"" ""$ServerScript"" 1>> ""$LogPath"" 2>&1"
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)   # 0 = unlimited

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal | Out-Null

Write-Host "Registered task '$TaskName'."
Write-Host "  Script:  $ServerScript"
Write-Host "  Trigger: At logon of $env:USERNAME"
Write-Host "  Logs:    $LogPath"
Write-Host ""
Write-Host "To test: log out and back in, then open http://localhost:3333"
Write-Host "To remove: ./scripts/setup_autostart.ps1 -Remove"
```

- [ ] **Step 2: Register the task manually to test**

Run in an elevated (Administrator) PowerShell:

```powershell
./scripts/setup_autostart.ps1
```

Expected output: `Registered task 'TradingView Live Dashboard'` followed by the paths.

Verify via:

```powershell
Get-ScheduledTask -TaskName 'TradingView Live Dashboard' | Format-List
```

- [ ] **Step 3: Manual test — log out and back in, verify server runs**

Log out of Windows and log back in. Wait ~10 seconds. Then:

```powershell
Test-NetConnection -ComputerName localhost -Port 3333
```

Should return `TcpTestSucceeded : True`. Open http://localhost:3333 — dashboard should load.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup_autostart.ps1
git commit -m "feat(live-feed): Windows Task Scheduler autostart script"
```

---

## Task 18: Manual End-to-End Test

**Files:** (none created; this is a verification task)

- [ ] **Step 1: Start the live server in foreground during market hours**

```bash
node scripts/dashboard/live_server.js
```

Open http://localhost:3333 in Chrome/Edge. Verify:
- Dashboard loads
- Coiled Springs tab shows candidates with live price spans
- "Enable notifications" prompt appears (if not previously granted)
- Browser DevTools → Network → `/events` is a pending request (SSE connection alive)

- [ ] **Step 2: Verify SSE ticks**

In DevTools Console, watch for `tick` events:

```js
new EventSource('/events').addEventListener('tick', e => console.log('TICK:', JSON.parse(e.data)));
```

You should see a `TICK` log entry for each top-15 candidate every 15 seconds.

- [ ] **Step 3: Trigger a synthetic fire**

Edit `scripts/scanner/coiled_spring_results.json` — pick one candidate that's currently below its trigger and **temporarily** lower its `entry_trigger` string to something just below the current price. For example, if APH is $150.38 with `"entry_trigger": "watchlist — alert at 152.81"`, change it to `"entry_trigger": "watchlist — alert at 150.00"`.

Save. Wait 30 seconds (2 poll cycles × 15s).

Expected:
- Red banner appears at top of dashboard: `✅ APH fired @ $150.XX (trigger $150.00) — clean setup`
- Windows desktop toast notification fires
- APH row in Coiled Springs table gets red-tinted `cs-fired-today` class + "FIRED TODAY" badge
- `data/coiled_spring_fires_YYYY-MM-DD.json` contains a new entry with full audit fields

Verify file:

```bash
cat data/coiled_spring_fires_*.json | tail -50
```

- [ ] **Step 4: Revert the edit**

Set the trigger back to the real value (e.g., 152.81). Save. Wait another 30s.

Expected:
- Row remains `cs-fired-today` (sticky badge stays)
- No duplicate notification
- No new entry in the daily fire log

- [ ] **Step 5: Test fallback — disconnect network briefly**

Turn off network (airplane mode or pull ethernet). Wait ~2 minutes.

Expected:
- Source-status banner appears: `⚠ Quote source: yahoo (degraded)` then either `tv_cdp` (if TV is running) or stays yahoo with repeated errors.
- No false fires from stale data (tickers' `fireSuppressed` blocks promotion).

Turn network back on. Within 5 minutes, the chain probes and returns to `yahoo`. Banner clears.

- [ ] **Step 6: Test shadow mode**

Stop server. Restart with shadow:

```bash
SHADOW_MODE=1 node scripts/dashboard/live_server.js
```

Reload dashboard. Yellow `🛡 SHADOW MODE` banner visible. Re-trigger a synthetic fire. Expected: banner fires but NO Windows toast. The log still records the fire.

- [ ] **Step 7: Commit operations log**

No code changes in this task. Record the completion in the plan by checking the box.

- [ ] **Step 8: Commit the synthesized test notes**

Append a short `docs/live-feed-manual-test-log.md` documenting the test run date and any issues observed:

```bash
cat > docs/live-feed-manual-test-log.md <<'EOF'
# Live Feed Manual Test Log

## 2026-MM-DD run
- [ ] Server started without errors
- [ ] SSE /events connected
- [ ] Live ticks visible every 15s
- [ ] Synthetic fire triggered banner + toast
- [ ] Sticky badge persists after revert
- [ ] Network-down fallback worked
- [ ] Shadow mode suppressed toast
- Notes:
EOF

git add docs/live-feed-manual-test-log.md
git commit -m "docs(live-feed): manual E2E test log template"
```

---

## Task 19 (Phase G — post-ship): Outcome Tagger CLI

**Files:**
- Create: `scripts/dashboard/outcome_tagger.js`

- [ ] **Step 1: Write the CLI**

Create `scripts/dashboard/outcome_tagger.js`:

```js
#!/usr/bin/env node
/**
 * Outcome tagger: interactively label each fire in a given day's audit log
 * with its post-hoc outcome.
 *
 * Usage: node scripts/dashboard/outcome_tagger.js [--date=YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRES_DIR = path.resolve(__dirname, '..', '..', 'data');

const dateArg = process.argv.find(a => a.startsWith('--date='));
const date = dateArg ? dateArg.split('=')[1] : new Date().toISOString().slice(0, 10);
const filePath = path.join(FIRES_DIR, `coiled_spring_fires_${date}.json`);

if (!fs.existsSync(filePath)) {
  console.error(`No fires file for ${date} at ${filePath}`);
  process.exit(1);
}

const log = JSON.parse(fs.readFileSync(filePath, 'utf8'));
if (!log.fires.length) { console.log(`No fires recorded on ${date}.`); process.exit(0); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = q => new Promise(r => rl.question(q, r));

const validOutcomes = ['continued', 'faded', 'whipsaw', 'earnings_gap', 'unknown'];

(async () => {
  let idx = 0;
  for (const fire of log.fires) {
    idx++;
    if (fire.outcome) { console.log(`  [${idx}/${log.fires.length}] ${fire.ticker} — already tagged as "${fire.outcome}", skipping.`); continue; }
    console.log('');
    console.log(`  [${idx}/${log.fires.length}] ${fire.ticker} fired @ $${fire.price.firedPrice} (trigger $${fire.trigger.level})`);
    console.log(`       ${fire.firedAtET} | ${fire.setup.confidence} conf | ${fire.setup.setupType} | risk: ${fire.riskFlags.overallRiskBand}`);
    const ans = (await ask(`       Outcome? (${validOutcomes.join('/')}) [skip]: `)).trim().toLowerCase();
    if (!ans) continue;
    if (!validOutcomes.includes(ans)) { console.log(`       Invalid — skipping.`); continue; }
    fire.outcome = ans;
    fire.outcomeTaggedAt = new Date().toISOString();
  }
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
  rl.close();
  console.log(`\nSaved. ${log.fires.filter(f => f.outcome).length}/${log.fires.length} fires tagged.`);
})();
```

- [ ] **Step 2: Make it executable and smoke test**

```bash
chmod +x scripts/dashboard/outcome_tagger.js
node scripts/dashboard/outcome_tagger.js --date=2026-MM-DD
```

(Use a real date with actual fires. If no fires exist yet, this task's verification is deferred until shadow mode produces some.)

- [ ] **Step 3: Commit**

```bash
git add scripts/dashboard/outcome_tagger.js
git commit -m "feat(live-feed): outcome tagger CLI for shadow mode validation"
```

---

## Task 20 (Phase G — post-ship): Metrics Dashboard

**Files:**
- Create: `scripts/dashboard/fire_metrics.js`

- [ ] **Step 1: Write the metrics script**

Create `scripts/dashboard/fire_metrics.js`:

```js
#!/usr/bin/env node
/**
 * Compute daily + rolling metrics from the fire audit logs.
 *
 * Usage:
 *   node scripts/dashboard/fire_metrics.js                   # all dates
 *   node scripts/dashboard/fire_metrics.js --date=YYYY-MM-DD
 *   node scripts/dashboard/fire_metrics.js --since=YYYY-MM-DD
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRES_DIR = path.resolve(__dirname, '..', '..', 'data');

const args = Object.fromEntries(process.argv.slice(2).map(a => a.split('=')));
const dateFilter = args['--date'];
const sinceFilter = args['--since'];

const files = fs.readdirSync(FIRES_DIR)
  .filter(f => /^coiled_spring_fires_\d{4}-\d{2}-\d{2}\.json$/.test(f))
  .map(f => ({ path: path.join(FIRES_DIR, f), date: f.match(/\d{4}-\d{2}-\d{2}/)[0] }))
  .filter(f => !dateFilter || f.date === dateFilter)
  .filter(f => !sinceFilter || f.date >= sinceFilter)
  .sort((a, b) => a.date.localeCompare(b.date));

const allFires = [];
for (const f of files) {
  const data = JSON.parse(fs.readFileSync(f.path, 'utf8'));
  for (const fire of (data.fires || [])) {
    allFires.push({ ...fire, date: data.date });
  }
}

if (!allFires.length) { console.log('No fires in requested range.'); process.exit(0); }

// Fires per day
const byDay = {};
for (const f of allFires) { byDay[f.date] ??= 0; byDay[f.date]++; }

// Fires by risk band
const byBand = { green: 0, yellow: 0, red: 0 };
for (const f of allFires) byBand[f.riskFlags?.overallRiskBand || 'green']++;

// Fires by confidence
const byConfidence = {};
for (const f of allFires) {
  const c = f.setup?.confidence || 'UNKNOWN';
  byConfidence[c] ??= 0; byConfidence[c]++;
}

// Tagged outcomes
const byOutcome = {};
for (const f of allFires) {
  const o = f.outcome || 'untagged';
  byOutcome[o] ??= 0; byOutcome[o]++;
}

// Continuation rate by confidence + by risk band
function rate(subset) {
  const tagged = subset.filter(f => f.outcome && f.outcome !== 'untagged');
  const cont = tagged.filter(f => f.outcome === 'continued').length;
  return { taggedCount: tagged.length, continued: cont, rate: tagged.length ? +(cont / tagged.length).toFixed(2) : null };
}
const rateByConf = { HIGH: rate(allFires.filter(f => f.setup?.confidence === 'HIGH')), MODERATE: rate(allFires.filter(f => f.setup?.confidence === 'MODERATE')) };
const rateByBand = { green: rate(allFires.filter(f => f.riskFlags?.overallRiskBand === 'green')), yellow: rate(allFires.filter(f => f.riskFlags?.overallRiskBand === 'yellow')), red: rate(allFires.filter(f => f.riskFlags?.overallRiskBand === 'red')) };

// Latency
const latencies = allFires.map(f => f.debounce?.latencyFromFirstCrossMs).filter(Boolean);
const medianLatency = latencies.length ? latencies.sort((a,b) => a-b)[Math.floor(latencies.length/2)] : null;

// Degraded-mode fires
const degraded = allFires.filter(f => f.price?.quoteSource && f.price.quoteSource !== 'yahoo').length;

console.log('');
console.log(`═══ Fire metrics ${dateFilter || sinceFilter || 'all'} ═══`);
console.log(`Total fires:       ${allFires.length}`);
console.log(`Days covered:      ${Object.keys(byDay).length}`);
console.log(`Fires/day avg:     ${(allFires.length / Object.keys(byDay).length).toFixed(1)}`);
console.log('');
console.log('By risk band:      ', byBand);
console.log('By confidence:     ', byConfidence);
console.log('By outcome:        ', byOutcome);
console.log('');
console.log('Continuation rate by confidence:', rateByConf);
console.log('Continuation rate by band:      ', rateByBand);
console.log('');
console.log(`Median fire latency: ${medianLatency != null ? (medianLatency/1000).toFixed(1) + 's' : 'n/a'}`);
console.log(`Degraded-source fires: ${degraded}`);
console.log('');
```

- [ ] **Step 2: Smoke test**

```bash
node scripts/dashboard/fire_metrics.js
```

(Will print "No fires in requested range" until shadow mode has produced some.)

- [ ] **Step 3: Commit**

```bash
git add scripts/dashboard/fire_metrics.js
git commit -m "feat(live-feed): fire metrics CLI for shadow-mode review"
```

---

## Final Checklist

- [ ] All 20 tasks complete and committed
- [ ] All unit tests pass: `node --test tests/market_hours.test.js tests/candidate_reader.test.js tests/fire_events.test.js tests/poller_state.test.js tests/quote_sources_yahoo.test.js tests/quote_sources_tv_cdp.test.js tests/quote_sources_chain.test.js tests/fire_detector.test.js tests/risk_flags.test.js tests/live_price_poller.test.js`
- [ ] Manual E2E test (Task 18) executed and logged in `docs/live-feed-manual-test-log.md`
- [ ] `scripts/setup_autostart.ps1` run once to register the Windows task
- [ ] Shadow mode enabled for first 2 weeks — toggle via `SHADOW_MODE=1` env var
- [ ] After 2 weeks: review metrics via `fire_metrics.js`, tune debouncing if needed, flip shadow off

Spec reference: `docs/superpowers/specs/2026-04-24-coiled-spring-live-feed-design.md`
