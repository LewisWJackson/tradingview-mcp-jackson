# MSCI Index-Flow Harvest + Edge Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harvest MSCI Saudi index-review adds/deletes (2019→now), store them point-in-time, and run an event study testing whether front-running the forced index flow is a tradeable edge.

**Architecture:** Mirrors the existing catalyst pipeline (`dashboard/catalysts.mjs` → `scripts/import_catalysts.mjs` → `scripts/catalyst_edge_test.mjs`). New `index_events` SQLite table + ingest module, an import script, pure abnormal-return helpers (unit-tested), the agent-harvested events JSON, and an event-study research script. Build the pipeline against a tiny fixture first, then feed the real harvest.

**Tech Stack:** Node 22 ESM, `node:sqlite` via `dashboard/db.js` (needs `--experimental-sqlite`), `scripts/bars_cache.mjs` (Yahoo daily OHLCV), `scripts/tasi_screener.mjs` (`TASI_STOCKS` name→code map, `toYahooSym`), `node --test`.

**Spec:** `docs/superpowers/specs/2026-06-21-msci-index-flow-design.md`.

**Key reused conventions (from `catalysts.mjs`):**
- Symbols stored as `TADAWUL:${code}` where `code` is the 4-digit main-market number.
- `import.meta`-relative paths; ingest via `INSERT OR IGNORE` (idempotent); `db` imported from `./db.js`.
- Benchmark for abnormal return = `^TASI.SR` via `getBars` (the fair-benchmark rule).
- Research scripts (`*_test.mjs`) are run by hand, NOT in `npm test`.

**DB boot note:** any script importing `db.js` must run with `node --experimental-sqlite`. The test scripts `test:strategy`/`test:money` already pass this flag.

---

## Task 1: `index_events` table + ingest module

**Files:**
- Create: `dashboard/index_events.mjs`
- Create: `dashboard/seed/index_events_fixture.json` (tiny, for tests)
- Test: `tests/strategy_state.test.js` (append a describe block — it already runs with `--experimental-sqlite`)

- [ ] **Step 1: Write the failing test**

Append to `tests/strategy_state.test.js` (match its existing `describe`/`it` + `node:assert/strict` style; add the import near the other imports at the top):

```javascript
import { ingestIndexEvents, getIndexEvents, indexEventsSummary } from '../dashboard/index_events.mjs';

describe('index_events ingest', () => {
  it('ingests valid add/delete events, rejects bad rows, dedups re-runs', () => {
    const rows = [
      { code: '1120', action: 'add',    review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' },
      { code: '2222', action: 'delete', review: '2024-11', announce_date: '2024-11-06', effective_date: '2024-11-25', index: 'MSCI Saudi', source: 'test' },
      { code: 'XX',   action: 'add',    review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' }, // bad code
      { code: '1120', action: 'sideways', review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' }, // bad action
      { code: '1120', action: 'add',    review: '2019-05', announce_date: '2019/05/14', effective_date: 'nope',       index: 'MSCI Saudi', source: 'test' }, // bad date
    ];
    const r1 = ingestIndexEvents(rows);
    assert.equal(r1.inserted, 2, `expected 2 inserted, got ${r1.inserted}`);
    assert.equal(r1.skipped, 3, `expected 3 skipped, got ${r1.skipped}`);
    // re-run is idempotent
    const r2 = ingestIndexEvents(rows);
    assert.equal(r2.inserted, 0, 'second ingest should insert nothing (UNIQUE dedup)');

    const adds = getIndexEvents({ action: 'add' });
    assert.ok(adds.some(e => e.sym === 'TADAWUL:1120' && e.effective_date === '2019-05-28'));
    const sum = indexEventsSummary();
    assert.ok(sum.total >= 2 && sum.adds >= 1 && sum.deletes >= 1, JSON.stringify(sum));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test:strategy 2>&1 | grep -iE "fail|cannot find module|index_events"`
Expected: FAIL — `Cannot find module '../dashboard/index_events.mjs'`.

- [ ] **Step 3: Implement the module**

Create `dashboard/index_events.mjs`:

```javascript
/**
 * index_events.mjs — store MSCI Saudi index-review adds/deletes point-in-time and
 * expose them for an event study (scripts/index_flow_test.mjs). Mirrors catalysts.mjs.
 *
 * Symbols stored as `TADAWUL:${code}` (4-digit main-market code). announce_date is the
 * public-info timestamp (entry); effective_date is the flow execution date (exit).
 * Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS index_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sym            TEXT NOT NULL,
    action         TEXT NOT NULL,          -- 'add' | 'delete'
    review         TEXT NOT NULL,          -- e.g. '2024-11'
    announce_date  TEXT NOT NULL,          -- YYYY-MM-DD
    effective_date TEXT NOT NULL,          -- YYYY-MM-DD
    index_name     TEXT NOT NULL DEFAULT 'MSCI Saudi',
    source         TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(sym, effective_date, action, index_name)
  );
  CREATE INDEX IF NOT EXISTS idx_idxev_eff ON index_events(effective_date);
`);

const isISO = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const _ins = db.prepare(
  `INSERT OR IGNORE INTO index_events (sym, action, review, announce_date, effective_date, index_name, source)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

/** Ingest harvested events [{code,action,review,announce_date,effective_date,index,source}]. */
export function ingestIndexEvents(events) {
  let inserted = 0, skipped = 0;
  for (const e of events || []) {
    const code = String(e.code || '').match(/^\d{4}$/)?.[0];
    const action = (e.action === 'add' || e.action === 'delete') ? e.action : null;
    if (!code || !action || !isISO(e.announce_date) || !isISO(e.effective_date) || !e.review) { skipped++; continue; }
    inserted += _ins.run(
      `TADAWUL:${code}`, action, e.review, e.announce_date, e.effective_date,
      e.index || 'MSCI Saudi', e.source || null
    ).changes;
  }
  return { events: (events || []).length, inserted, skipped };
}

/** Read events, optionally filtered by action and/or index_name, ascending by effective_date. */
export function getIndexEvents({ action = null, index_name = null } = {}) {
  let q = 'SELECT sym, action, review, announce_date, effective_date, index_name, source FROM index_events';
  const where = [], args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (index_name) { where.push('index_name = ?'); args.push(index_name); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY effective_date ASC';
  return db.prepare(q).all(...args);
}

export function indexEventsSummary() {
  const total = db.prepare('SELECT COUNT(*) n FROM index_events').get().n;
  const adds = db.prepare("SELECT COUNT(*) n FROM index_events WHERE action='add'").get().n;
  const deletes = db.prepare("SELECT COUNT(*) n FROM index_events WHERE action='delete'").get().n;
  const range = db.prepare('SELECT MIN(effective_date) min, MAX(effective_date) max, COUNT(DISTINCT sym) syms FROM index_events').get();
  return { total, adds, deletes, ...range };
}
```

- [ ] **Step 4: Create the fixture** (used by the import script + study smoke test)

Create `dashboard/seed/index_events_fixture.json` — two real, verifiable early events (Al Rajhi was a Saudi MSCI-EM constituent from the 2019 inclusion; dates here are illustrative fixture values, clearly tagged `source:"fixture"`):

```json
[
  { "code": "1120", "name": "Al Rajhi Bank", "action": "add", "review": "2019-05",
    "announce_date": "2019-05-14", "effective_date": "2019-05-28", "index": "MSCI Saudi", "source": "fixture" },
  { "code": "2010", "name": "SABIC", "action": "add", "review": "2019-05",
    "announce_date": "2019-05-14", "effective_date": "2019-05-28", "index": "MSCI Saudi", "source": "fixture" }
]
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:strategy 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass, `fail 0`. (`test:strategy` count rises by 1.)

- [ ] **Step 6: Commit**

```bash
git add dashboard/index_events.mjs dashboard/seed/index_events_fixture.json tests/strategy_state.test.js
git commit -m "feat(flow): index_events table + ingest module (mirrors catalysts)"
```

---

## Task 2: Pure abnormal-return helpers + unit tests

**Files:**
- Create: `dashboard/index_flow.mjs`
- Modify: `tests/moneypath.test.js` (append a describe block + import)

These are pure (no bars, no DB) so the study's math is tested deterministically.

- [ ] **Step 1: Write the failing tests**

Add the import near the other imports at the top of `tests/moneypath.test.js`:

```javascript
import { windowReturn, abnormalReturn, sliceByDate } from '../dashboard/index_flow.mjs';
```

Append this block:

```javascript
describe('index_flow helpers', () => {
  // closes indexed by position; windowReturn = last/first - 1 over [i, j]
  it('windowReturn computes simple return over an index window', () => {
    const c = [100, 110, 121];
    assert.ok(Math.abs(windowReturn(c, 0, 2) - 0.21) < 1e-9, `got ${windowReturn(c, 0, 2)}`);
    assert.equal(windowReturn(c, 0, 0), 0);
  });
  it('windowReturn returns null on bad bounds or non-positive prices', () => {
    assert.equal(windowReturn([100, 0, 121], 0, 2), null); // zero price in path-endpoints check
    assert.equal(windowReturn([100], 0, 3), null);          // out of range
  });
  it('abnormalReturn = name return minus benchmark return over the same window', () => {
    const name = [100, 130];   // +30%
    const bench = [100, 110];  // +10%
    assert.ok(Math.abs(abnormalReturn(name, bench, 0, 1) - 0.20) < 1e-9, `got ${abnormalReturn(name, bench, 0, 1)}`);
  });
  it('abnormalReturn returns null if either leg is unavailable', () => {
    assert.equal(abnormalReturn([100, 130], [100], 0, 1), null);
  });
  // sliceByDate maps a date to its index in an ascending ISO date array (exact or next-on-or-after)
  it('sliceByDate finds the index on-or-after a target date', () => {
    const dates = ['2024-01-01', '2024-01-03', '2024-01-05'];
    assert.equal(sliceByDate(dates, '2024-01-03'), 1);   // exact
    assert.equal(sliceByDate(dates, '2024-01-02'), 1);   // next on-or-after
    assert.equal(sliceByDate(dates, '2024-01-06'), -1);  // past end
    assert.equal(sliceByDate(dates, '2023-12-31'), 0);   // before start → first
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:money 2>&1 | grep -iE "fail|cannot find module|index_flow"`
Expected: FAIL — `Cannot find module '../dashboard/index_flow.mjs'`.

- [ ] **Step 3: Implement the helpers**

Create `dashboard/index_flow.mjs`:

```javascript
/**
 * index_flow.mjs — pure helpers for the MSCI index-flow event study. No I/O, no bars.
 * Unit-tested in tests/moneypath.test.js. Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */

/** Simple return of a close-price array over inclusive index window [i, j]. null if invalid. */
export function windowReturn(closes, i, j) {
  if (!Array.isArray(closes) || i < 0 || j < 0 || i >= closes.length || j >= closes.length) return null;
  const a = closes[i], b = closes[j];
  if (!(a > 0) || !(b > 0)) return null;
  return b / a - 1;
}

/** Abnormal return = name window return minus benchmark window return (same index window). */
export function abnormalReturn(nameCloses, benchCloses, i, j) {
  const rn = windowReturn(nameCloses, i, j);
  const rb = windowReturn(benchCloses, i, j);
  if (rn == null || rb == null) return null;
  return rn - rb;
}

/** Index in an ascending ISO-date array of the first date on-or-after target. -1 if past the end. */
export function sliceByDate(dates, target) {
  if (!Array.isArray(dates) || !dates.length) return -1;
  for (let k = 0; k < dates.length; k++) if (dates[k] >= target) return k;
  return -1;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:money 2>&1 | grep -E "^ℹ (tests|pass|fail)"`
Expected: all pass, `fail 0` (4 new tests).

- [ ] **Step 5: Commit**

```bash
git add dashboard/index_flow.mjs tests/moneypath.test.js
git commit -m "feat(flow): pure abnormal-return + window helpers + tests"
```

---

## Task 3: Import script (JSON → table) with name→code resolution

**Files:**
- Create: `scripts/import_index_events.mjs`

- [ ] **Step 1: Implement the import script**

Create `scripts/import_index_events.mjs`:

```javascript
/**
 * import_index_events.mjs — ingest harvested MSCI index-review events into index_events.
 * Harvest is agent-assisted (firecrawl over MSCI/Argaam); this loads the saved JSON.
 *
 * Each record needs a 4-digit `code`. If a record has only a `name`, this resolves it
 * via TASI_STOCKS (English name or Arabic). Unresolved names are reported and skipped.
 *
 * Run: node --experimental-sqlite scripts/import_index_events.mjs [path]
 *   default path: data/index_events_harvest.json
 */
import { readFileSync } from 'node:fs';
import { ingestIndexEvents, indexEventsSummary } from '../dashboard/index_events.mjs';
import { TASI_STOCKS } from './tasi_screener.mjs';

// name (lowercased) -> 4-digit code, from the canonical universe map
const NAME2CODE = new Map();
for (const s of TASI_STOCKS) {
  const code = String(s.sym).match(/(\d{4})/)?.[1];
  if (!code) continue;
  NAME2CODE.set(s.name.toLowerCase(), code);
  if (s.ar) NAME2CODE.set(s.ar, code);
}
function resolveCode(rec) {
  if (String(rec.code || '').match(/^\d{4}$/)) return rec.code;
  const n = String(rec.name || '').toLowerCase().trim();
  return NAME2CODE.get(n) || null;
}

const path = process.argv[2] || new URL('../data/index_events_harvest.json', import.meta.url).pathname;
const raw = JSON.parse(readFileSync(path, 'utf8'));

const resolved = [], unresolved = [];
for (const rec of raw) {
  const code = resolveCode(rec);
  if (code) resolved.push({ ...rec, code });
  else unresolved.push(rec.name || rec.code || '(unknown)');
}

const r = ingestIndexEvents(resolved);
console.log('ingest:', JSON.stringify(r));
if (unresolved.length) {
  console.log(`\nUNRESOLVED name→code (${unresolved.length}) — add a 4-digit code manually in the JSON:`);
  for (const u of unresolved) console.log('  -', u);
}
console.log('\ndb summary:', JSON.stringify(indexEventsSummary(), null, 0));
process.exit(0);
```

- [ ] **Step 2: Smoke-test the import against the fixture**

Run:
```bash
node --experimental-sqlite scripts/import_index_events.mjs dashboard/seed/index_events_fixture.json
```
Expected: prints `ingest: {"events":2,"inserted":...,"skipped":0}` (inserted is 2 on a fresh DB, 0 if already present from the Task 1 test run — both fine), no UNRESOLVED list (codes are present in the fixture), and a `db summary` with `total >= 2`.

- [ ] **Step 3: Commit**

```bash
git add scripts/import_index_events.mjs
git commit -m "feat(flow): import script with name→code resolution"
```

---

## Task 4: Event-study script

**Files:**
- Create: `scripts/index_flow_test.mjs`

Runs on whatever is in `index_events` (fixture now, real data after Task 5). Produces the abnormal-return verdict.

- [ ] **Step 1: Implement the study**

Create `scripts/index_flow_test.mjs`:

```javascript
/**
 * index_flow_test.mjs — event study: do MSCI Saudi index ADDS earn a positive abnormal
 * return between announcement and effective date (front-running the forced inclusion flow),
 * and reverse after? Deletes mirror (negative; untradeable long-only, reported for shape).
 *
 * Abnormal return = name return − ^TASI.SR return over the same window (fair-benchmark rule).
 * Windows: pre (announce-5→announce), trade (announce+1→effective-1), reversal (effective→+20).
 * Net of 0.11% RT cost + a slippage haircut. Newey-West t. Time-split OOS. Trim-one robustness.
 * Run: node --experimental-sqlite scripts/index_flow_test.mjs
 * Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym } from './tasi_screener.mjs';
import { getIndexEvents } from '../dashboard/index_events.mjs';
import { sliceByDate } from '../dashboard/index_flow.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;            // per-side slippage haircut (disclosed)
const MIN_N = +process.env.MIN_N || 20;              // underpowered threshold
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
// Newey-West t with Bartlett weights, lag L (handles overlapping event windows).
function nwT(x, L = 5) {
  const n = x.length; if (n < 3) return NaN;
  const m = mean(x), e = x.map(v => v - m);
  let g0 = e.reduce((s, v) => s + v * v, 0) / n, v = g0;
  for (let l = 1; l <= L; l++) {
    let g = 0; for (let t = l; t < n; t++) g += e[t] * e[t - l];
    g /= n; v += 2 * (1 - l / (L + 1)) * g;
  }
  const se = Math.sqrt(v / n);
  return se > 0 ? m / se : NaN;
}
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';

(async () => {
  const events = getIndexEvents({ index_name: 'MSCI Saudi' });
  if (!events.length) { console.log('No events in index_events. Run import_index_events.mjs first.'); process.exit(0); }

  // Warm bars for every event symbol + the benchmark.
  const syms = [...new Set(events.map(e => e.sym))];
  await warm(syms.map(toYahooSym).concat('^TASI.SR'), '10y');
  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  // For each event compute the three abnormal returns, keyed on the BENCHMARK calendar
  // (shared trading days). Entry timestamp = announce_date (no look-ahead).
  const rows = { add: { pre: [], trade: [], reversal: [] }, delete: { pre: [], trade: [], reversal: [] } };
  let used = 0, skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c);
    // align: use benchmark calendar positions, map each date into the name array too
    const aIdxB = sliceByDate(benchDates, ev.announce_date);
    const eIdxB = sliceByDate(benchDates, ev.effective_date);
    if (aIdxB < 0 || eIdxB < 0 || eIdxB <= aIdxB) { skipped++; continue; }
    // name indices for the same calendar dates
    const aIdxN = sliceByDate(nDates, ev.announce_date);
    const eIdxN = sliceByDate(nDates, ev.effective_date);
    if (aIdxN < 0 || eIdxN < 0 || eIdxN <= aIdxN) { skipped++; continue; }

    // pre: announce-5 → announce ; trade: announce+1 → effective-1 ; reversal: effective → +20
    const preB = Math.max(0, aIdxB - 5), preN = Math.max(0, aIdxN - 5);
    const revEndB = Math.min(benchC.length - 1, eIdxB + 20), revEndN = Math.min(nC.length - 1, eIdxN + 20);

    const arPre   = abnAligned(nC, benchC, preN, aIdxN, preB, aIdxB);
    const arTrade = abnAligned(nC, benchC, aIdxN + 1, eIdxN - 1, aIdxB + 1, eIdxB - 1);
    const arRev   = abnAligned(nC, benchC, eIdxN, revEndN, eIdxB, revEndB);
    if (arTrade == null) { skipped++; continue; }
    used++;
    const net = arTrade - COST_RT - 2 * SLIP; // round-trip cost + slippage both sides
    rows[ev.action].pre.push(arPre);
    rows[ev.action].trade.push(net);
    rows[ev.action].reversal.push(arRev);
  }

  console.log(`\nMSCI Saudi index-flow event study — events ${events.length}, used ${used}, skipped ${skipped}`);
  console.log(`cost ${(COST_RT*100).toFixed(2)}% RT + slippage ${(SLIP*100).toFixed(2)}%/side\n`);
  for (const action of ['add', 'delete']) {
    const tr = rows[action].trade.filter(x => x != null);
    if (!tr.length) { console.log(`${action.toUpperCase()}: no usable events`); continue; }
    const pre = rows[action].pre.filter(x => x != null), rev = rows[action].reversal.filter(x => x != null);
    console.log(`${action.toUpperCase()} (n=${tr.length})`);
    console.log(`  pre      mean ${pct(mean(pre))}`);
    console.log(`  trade    mean ${pct(mean(tr))} net  NW-t ${(nwT(tr) || 0).toFixed(2)}  win ${(tr.filter(x=>x>0).length/tr.length*100).toFixed(0)}%`);
    console.log(`  reversal mean ${pct(mean(rev))}`);
    // trim-one robustness on the trade window
    if (tr.length > 3) {
      const trims = tr.map((_, i) => mean(tr.filter((__, j) => j !== i)));
      console.log(`  trim-one trade mean range ${pct(Math.min(...trims))} … ${pct(Math.max(...trims))}`);
    }
  }

  // OOS time split on ADDS (the tradeable side), by effective_date order (events already asc).
  const addEv = events.filter(e => e.action === 'add');
  if (rows.add.trade.length >= 4) {
    const t = rows.add.trade; const mid = Math.floor(t.length / 2);
    console.log(`\nADD OOS split — early(${mid}) mean ${pct(mean(t.slice(0, mid)))}  late(${t.length - mid}) mean ${pct(mean(t.slice(mid)))}`);
  }

  // Verdict gate (adds)
  const t = rows.add.trade.filter(x => x != null);
  console.log('\nVERDICT (adds):');
  if (t.length < MIN_N) {
    console.log(`  UNDERPOWERED — only ${t.length} usable add events (<${MIN_N}); verdict NOT reliable. Harvest more / add reweights.`);
  } else {
    const m = mean(t), tstat = nwT(t);
    const pass = m > 0 && tstat > 2;
    console.log(`  ${pass ? 'SIGNAL' : 'NO SIGNAL'} — trade mean ${pct(m)} net, NW-t ${tstat.toFixed(2)} (need mean>0 AND t>2; then check OOS + trim-one above).`);
  }
})();

// helper: abnormal return over name window [iN,jN] and matching bench window [iB,jB]
function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}
```

> Note: `abnAligned` is local to the script because it aligns two *different* index ranges (name vs benchmark calendars). The pure `abnormalReturn`/`windowReturn` helpers cover the single-shared-window case and stay unit-tested (Task 2); the script only needs `sliceByDate` from the helper module. `abnAligned` is the two-range generalization — keep it script-local.

- [ ] **Step 2: Smoke-test on the fixture data**

Run: `node --experimental-sqlite scripts/index_flow_test.mjs`
Expected: prints the study header, an `ADD` block with finite numbers (fixture has 2 adds → small n), and `VERDICT (adds): UNDERPOWERED — only 2 usable add events (<20)…`. No crash, no `NaN` in the structure (means may be small). This proves the pipeline runs end-to-end before the real harvest.

- [ ] **Step 3: Commit**

```bash
git add scripts/index_flow_test.mjs
git commit -m "feat(flow): MSCI index-flow event-study script (abnormal return, NW-t, OOS, underpowered guard)"
```

---

## Task 5: Real harvest → import → verdict → results doc

**Files:**
- Create: `data/index_events_harvest.json`
- Create: `docs/research/2026-06-21-msci-index-flow-results.md`

This task is the agent-assisted data harvest (firecrawl), then running the real study.

- [ ] **Step 1: Harvest the MSCI Saudi add/delete history (2019→now)**

Use firecrawl to extract MSCI Saudi index-review **additions and deletions** with **announcement** and **effective** dates, quarterly Feb/May/Aug/Nov 2019→2026. Primary sources, cross-checked:
- MSCI index-review pages: `https://www.msci.com/indexes/index-resources/index-review` and the "MSCI Saudi Arabia Indexes List of Additions/Deletions" linked there.
- Argaam MSCI quarterly-review summaries (public S3 PDFs, e.g. the Feb-2025 review PDF found in search) — search `firecrawl_search "Argaam MSCI Saudi quarterly review <YEAR> additions deletions effective date"` per year, then `firecrawl_scrape`/`firecrawl_extract` the PDF.

For each add/delete write one record to `data/index_events_harvest.json`:
```json
{ "code": "<4-digit if known, else omit>", "name": "<as published>", "action": "add|delete",
  "review": "<YYYY-MM>", "announce_date": "<YYYY-MM-DD>", "effective_date": "<YYYY-MM-DD>",
  "index": "MSCI Saudi", "source": "<url>" }
```
Rules: capture BOTH dates from the same source; if only the effective date is given, set `announce_date` to the MSCI-standard ~2 weeks prior ONLY if the review's announcement date is separately confirmed, else leave the record out and note it. Prefer `code` from the source; otherwise rely on Task 3's name resolver. Record the actual count harvested.

- [ ] **Step 2: Import the real data**

Run: `node --experimental-sqlite scripts/import_index_events.mjs`
Expected: `ingest` shows the inserted count; resolve any `UNRESOLVED name→code` by adding the 4-digit `code` to those JSON records and re-running (idempotent). Aim for 0 unresolved. Confirm `db summary` total ≈ the harvested count.

- [ ] **Step 3: Run the study on real data**

Run: `node --experimental-sqlite scripts/index_flow_test.mjs | tee /tmp/flow-results.txt`
Expected: real `ADD`/`DELETE` blocks, OOS split, and a verdict that is either a real SIGNAL/NO-SIGNAL (if usable adds ≥ 20) or the UNDERPOWERED banner (if the reachable history is thin — an honest, valid outcome).

- [ ] **Step 4: Write the results doc**

Create `docs/research/2026-06-21-msci-index-flow-results.md`: paste `/tmp/flow-results.txt`; state the harvested event count + date span + how many resolved; give the plain-English verdict applying the Test Plan #2 gates (SIGNAL only if trade abnormal return >0 net, NW-t>2, holds OOS late half, survives trim-one); if UNDERPOWERED, say so plainly and name the unlock (widen to reweights/FTSE/IPO per the spec non-goals). Note survivorship ≈ nil for this edge (index large-caps).

- [ ] **Step 5: Commit**

```bash
git add data/index_events_harvest.json docs/research/2026-06-21-msci-index-flow-results.md
git commit -m "feat(flow): MSCI Saudi add/delete harvest + event-study results + verdict"
```

---

## Notes for the executor

- **Run DB scripts with `--experimental-sqlite`** (db.js uses `node:sqlite`). The study + import scripts need it; forgetting it gives `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite`.
- **`node --check` does NOT catch undefined refs** — the smoke-test runs (Task 3 Step 2, Task 4 Step 2) are the real net; always run them.
- **Symbols are `TADAWUL:${code}`** everywhere (matches `catalysts.mjs` + `TASI_STOCKS`); `toYahooSym` maps to the Yahoo ticker for `getBars`.
- **Research scripts are run by hand**, not added to `npm test`. Only the Task 1 + Task 2 pure/DB helpers are in the suite (`test:strategy`, `test:money`).
- **Do Tasks 1–4 before the harvest (Task 5)** so the pipeline is proven on the fixture before sinking time into manual extraction.
- **Honesty is the product:** an UNDERPOWERED or NO-SIGNAL verdict is a valid, valuable outcome — do not tune to manufacture a signal.

## Self-review notes (author)

- **Spec coverage:** table (T1) ✓, ingest pattern (T1) ✓, pure helpers + tests (T2) ✓, import + name→code resolution (T3) ✓, event study with abnormal-return/NW-t/cost+slippage/OOS/trim-one/underpowered (T4) ✓, harvest + point-in-time announce_date entry (T5) ✓, results+verdict (T5) ✓, survivorship-nil note (T5) ✓, testing split unit-vs-by-hand ✓. All spec sections mapped.
- **Deferred per spec non-goals:** FTSE / IPO / reweights / live surface — correctly out of scope; named as the unlock if underpowered.
- **Consistency:** `ingestIndexEvents`/`getIndexEvents`/`indexEventsSummary`, `windowReturn`/`abnormalReturn`/`sliceByDate`, `TADAWUL:${code}`, `--experimental-sqlite` used identically across tasks.
- **Known wrinkle (called out in-code):** the study needs two-range alignment (name vs benchmark calendars), so it uses a local `abnAligned`; the single-window `abnormalReturn`/`windowReturn` stay the unit-tested pure helpers (Task 2), and the study imports only `sliceByDate`. Intentional.
