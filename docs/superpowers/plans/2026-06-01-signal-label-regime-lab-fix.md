# Signal Label Redesign + Regime-Aware Lab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flawed STRONG SELL label with context-aware labels (EXIT/EXIT NOW/SKIP/AVOID), add per-market regime tracking to the accuracy lab, delete the 9-day mislabeled dataset, and fix US/Crypto signals never reaching the lab.

**Architecture:** The screener already computes per-market regime from `INDEX_FOR_MARKET` — no structural change needed there. The fix lives in three places: (1) db schema migration + column additions, (2) `accuracyLab.log()` accepting `regime` + `market_index`, (3) `autoLogAccuracySignals()` in server computing the context-aware label before logging.

**Tech Stack:** Node.js ESM, `node:sqlite` (DatabaseSync), `scripts/tasi_screener.mjs`, `dashboard/server.mjs`, `dashboard/db.js`

---

## Pre-Implementation: Key Code Facts

Before touching anything, internalize these:

- **Regime is already per-market** in `runScreener()` (`tasi_screener.mjs:1228`): uses `YAHOO_INDEX[market]` to fetch the right index. No change needed in the screener.
- **`INDEX_FOR_MARKET`** is exported from `tasi_screener.mjs:394`. Maps `tasi → TADAWUL:TASI`, `us → NASDAQ:QQQ`, `crypto → BITSTAMP:BTCUSD`.
- **`autoLogAccuracySignals(results)`** in `server.mjs:550` is the only place that writes to `accuracy_signals`. This is where the label resolution and regime writing happen.
- **`accuracyLab.log()`** in `db.js:804` does not currently accept `regime` or `market_index` — needs extending.
- **`positions` table** has `sym TEXT PRIMARY KEY` — check holding with `db.prepare('SELECT sym FROM positions WHERE sym=?').get(sym)`.
- **Bias label** used for logging is `r.bias` (raw from screener, i.e. `STRONG SELL`). The display label resolution happens at log time in server.
- **US/Crypto signals don't reach lab**: `autoLogAccuracySignals(results)` is called after each scan. The question is whether US/Crypto scans are ever triggered. See Task 5.
- **Score 8 EV = +0.15R** (marginal). Score 9 = +0.96R. The bearish RSI zone (15–48) is too wide — catches normal pullbacks. Narrowing it is Task 7.

---

## Files Modified

| File | What Changes |
|------|-------------|
| `dashboard/db.js` | Add `regime`, `market_index` columns to schema; extend `accuracyLab.log()` signature; add `accuracyLab.clearAll()` |
| `dashboard/server.mjs` | Add `resolveSignalLabel()` helper; update `autoLogAccuracySignals()` to pass regime + label; add index score to score_history after scan |
| `scripts/tasi_screener.mjs` | Narrow bearish RSI zone from `15–48` → `15–43` |

---

## Task 1: DB Migration — Delete Stale Data + Add Columns

**Files:**
- Modify: `dashboard/db.js`
- Run: terminal command against `dashboard/mawjah.db`

- [ ] **Step 1: Delete the 638 stale records**

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
const before = db.prepare('SELECT COUNT(*) as n FROM accuracy_signals').get().n;
db.exec('DELETE FROM accuracy_signals');
const after = db.prepare('SELECT COUNT(*) as n FROM accuracy_signals').get().n;
console.log('Deleted:', before - after, 'records. Remaining:', after);
"
```

Expected output: `Deleted: 638 records. Remaining: 0`

- [ ] **Step 2: Add `regime` and `market_index` columns**

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
try { db.exec('ALTER TABLE accuracy_signals ADD COLUMN regime TEXT'); console.log('Added regime'); }
catch(e) { console.log('regime already exists:', e.message); }
try { db.exec('ALTER TABLE accuracy_signals ADD COLUMN market_index TEXT'); console.log('Added market_index'); }
catch(e) { console.log('market_index already exists:', e.message); }
const cols = db.prepare('PRAGMA table_info(accuracy_signals)').all().map(c=>c.name);
console.log('Columns now:', cols.join(', '));
"
```

Expected: columns list includes `regime` and `market_index`.

- [ ] **Step 3: Update `db.js` CREATE TABLE statement to include the new columns** (so fresh installs get them automatically)

In `dashboard/db.js`, find the `CREATE TABLE IF NOT EXISTS accuracy_signals` block (lines 137–164). Add two columns before the closing `)`:

```sql
    regime           TEXT,
    market_index     TEXT
```

The full block ending becomes:
```javascript
    outcome          TEXT,
    price_outcome    REAL,
    outcome_at       TEXT,
    days_to_outcome  INTEGER,
    r_multiple       REAL,
    notes            TEXT,
    regime           TEXT,
    market_index     TEXT
  );
```

- [ ] **Step 4: Add `clearAll()` method to `accuracyLab` in `db.js`** (for future resets without touching the terminal)

In `dashboard/db.js`, inside the `accuracyLab` object (after the `delete(id)` method around line 936):

```javascript
  clearAll() {
    const n = db.prepare('SELECT COUNT(*) as n FROM accuracy_signals').get().n;
    db.exec('DELETE FROM accuracy_signals');
    return n;
  },
```

- [ ] **Step 5: Commit**

```bash
git add dashboard/db.js
git commit -m "feat(lab): migrate accuracy_signals — delete stale data, add regime + market_index columns"
```

---

## Task 2: Extend `accuracyLab.log()` to Accept `regime` and `market_index`

**Files:**
- Modify: `dashboard/db.js` lines 804–819

- [ ] **Step 1: Update `log()` function signature and INSERT**

Replace the existing `log()` method (lines 804–819 in `db.js`):

```javascript
  log({ sym, name, price_entry, price_stop, price_t1, price_t2, bias, score, max_score,
        composite, scan_mode, style_tags, market, sector, hurst, atr_rank, rsi_entry,
        vol_ratio_entry, regime, market_index }) {
    const logged_at = new Date().toISOString().split('T')[0];
    // Prevent duplicate for same sym on same day with same bias direction
    const exists = db.prepare('SELECT id FROM accuracy_signals WHERE sym=? AND logged_at=? AND outcome IS NULL').get(sym, logged_at);
    if (exists) return exists.id;
    const result = db.prepare(`
      INSERT INTO accuracy_signals
      (sym,name,logged_at,price_entry,price_stop,price_t1,price_t2,bias,score,max_score,
       composite,scan_mode,style_tags,market,sector,hurst,atr_rank,rsi_entry,vol_ratio_entry,
       regime,market_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sym, name||sym, logged_at, price_entry, price_stop, price_t1, price_t2, bias, score,
           max_score, composite, scan_mode, JSON.stringify(style_tags||[]), market||null, sector||null,
           hurst||null, atr_rank||null, rsi_entry||null, vol_ratio_entry||null,
           regime||null, market_index||null);
    return result.lastInsertRowid;
  },
```

- [ ] **Step 2: Verify the INSERT compiles (no syntax error)**

```bash
node --experimental-sqlite -e "
import('./dashboard/db.js').then(m => {
  const id = m.accuracyLab.log({
    sym: 'TADAWUL:TEST', name: 'Test', price_entry: 100,
    price_stop: 95, price_t1: 107, price_t2: 114,
    bias: 'STRONG BUY', score: 9, max_score: 9, composite: 100,
    scan_mode: 'swing', style_tags: ['Momentum'], market: 'tasi',
    regime: 'bull', market_index: 'TADAWUL:TASI'
  });
  console.log('Inserted id:', id);
  const row = m.db.prepare('SELECT * FROM accuracy_signals WHERE id=?').get(id);
  console.log('regime:', row.regime, '| market_index:', row.market_index);
  m.accuracyLab.delete(id);
  console.log('Cleaned up. OK.');
}).catch(e => console.error(e.message));
" 2>/dev/null
```

Expected: `regime: bull | market_index: TADAWUL:TASI`

- [ ] **Step 3: Commit**

```bash
git add dashboard/db.js
git commit -m "feat(lab): extend accuracyLab.log() to persist regime and market_index"
```

---

## Task 3: Add `resolveSignalLabel()` Helper in `server.mjs`

This function maps the raw screener bias (`STRONG SELL`) to a context-aware label based on regime and whether the user holds the stock.

**Files:**
- Modify: `dashboard/server.mjs` — add after the `BEAR_BIASES` line (~line 362)

- [ ] **Step 1: Add the helper function**

In `dashboard/server.mjs`, after line 362 (`const BEAR_BIASES = new Set(...)`), insert:

```javascript
// ── Signal Label Resolution ───────────────────────────────────────────────────
// Maps raw STRONG SELL bias to a context-aware label.
// STRONG BUY is unchanged — it is unambiguous in all markets.
// regime: 'bull' | 'neutral' | 'bear'
// isHolding: boolean — whether the user has an active position in this sym
function resolveSignalLabel(bias, regime, isHolding) {
  if (bias !== 'STRONG SELL') return bias;
  if (isHolding) {
    return regime === 'bear' ? 'EXIT NOW' : 'EXIT';
  }
  return regime === 'bear' ? 'AVOID' : 'SKIP';
}
```

- [ ] **Step 2: Verify no syntax error by importing the file**

```bash
node --experimental-sqlite --input-type=module <<'EOF'
import './dashboard/server.mjs';
EOF
```

> If the server starts (even partially), the syntax is valid. Ctrl+C to stop. If you see `SyntaxError`, fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add dashboard/server.mjs
git commit -m "feat(lab): add resolveSignalLabel() — context-aware SELL label based on regime + holding"
```

---

## Task 4: Update `autoLogAccuracySignals()` to Use Regime + New Labels

**Files:**
- Modify: `dashboard/server.mjs` lines 550–579

- [ ] **Step 1: Rewrite `autoLogAccuracySignals()`**

Replace the entire function (lines 550–580 in `server.mjs`) with:

```javascript
function autoLogAccuracySignals(results, marketKey) {
  // After each scan, log STRONG BUY/SELL signals (score ≥7) for accuracy tracking.
  // regime and market_index are sourced from the scan result (per-market, already computed).
  // Label is resolved to EXIT/EXIT NOW/SKIP/AVOID based on regime + position holding.
  try {
    accuracyLab.checkPriceOutcomes(results);
    accuracyLab.checkAndExpire();

    const strongSignals = results.filter(r =>
      (r.bias === 'STRONG BUY' || r.bias === 'STRONG SELL') && r.score >= 7 && r.atr
    );

    for (const r of strongSignals) {
      const isBear = r.bias === 'STRONG SELL';
      const stop = isBear ? r.price + 1.5 * r.atr : r.price - 1.5 * r.atr;
      const t1   = isBear ? r.price - 1.5 * r.atr : r.price + 1.5 * r.atr;
      const t2   = isBear ? r.price - 3 * r.atr   : r.price + 3 * r.atr;

      const market = r.sym.startsWith('TADAWUL:') ? 'tasi'
                   : r.sym.match(/XRP|BTC|ETH|SOL|BNB/) ? 'crypto'
                   : ['TVC:','NYMEX:','COMEX:'].some(p => r.sym.startsWith(p)) ? 'commodity' : 'us';

      const regime      = r.market_regime || 'neutral';
      const marketIndex = INDEX_FOR_MARKET[market] || INDEX_FOR_MARKET.tasi;

      // Check if user holds this position
      const isHolding = !!dbPositions.get(r.sym);

      // Resolve display label
      const resolvedBias = resolveSignalLabel(r.bias, regime, isHolding);

      accuracyLab.log({
        sym: r.sym, name: r.name,
        price_entry: r.price, price_stop: stop, price_t1: t1, price_t2: t2,
        bias: resolvedBias,
        score: r.score, max_score: r.maxScore || 9,
        composite: r.composite || Math.round(r.score / (r.maxScore || 9) * 100),
        scan_mode: state.scan.mode || 'swing',
        style_tags: r.style_tags || [],
        market, sector: null,
        hurst: r.hurst, atr_rank: r.atr_pct_rank,
        rsi_entry: r.rsi, vol_ratio_entry: r.vol_ratio,
        regime,
        market_index: marketIndex,
      });
    }
  } catch (e) { console.warn('[lab] auto-log error:', e.message); }
}
```

- [ ] **Step 2: Verify `dbPositions.get()` exists — check db.js exports**

```bash
grep -n "positions\|get(sym\|get(key" dashboard/db.js | head -20
```

If `dbPositions` doesn't have a `.get(sym)` method, add it to the `positions` object in `db.js`:
```javascript
  get(sym) { return db.prepare('SELECT data FROM positions WHERE sym=?').get(sym) || null; },
```

- [ ] **Step 3: Verify `INDEX_FOR_MARKET` is imported in server.mjs**

```bash
grep "INDEX_FOR_MARKET" dashboard/server.mjs
```

It should already be imported on line 18. If not, add `INDEX_FOR_MARKET` to the import line:
```javascript
import { runScreener, getUniverseByMarket, ..., INDEX_FOR_MARKET, ... } from "../scripts/tasi_screener.mjs";
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/server.mjs dashboard/db.js
git commit -m "feat(lab): write regime+market_index to lab; resolve SELL labels by context"
```

---

## Task 5: Fix US/Crypto Signals Never Reaching the Lab

The lab has zero US/Crypto rows because `autoLogAccuracySignals()` only runs when a scan is triggered — and the scan may only ever run on TASI manually. This task verifies and fixes the trigger.

**Files:**
- Read: `dashboard/server.mjs` — find every call to `autoLogAccuracySignals()`

- [ ] **Step 1: Find all scan trigger points**

```bash
grep -n "autoLogAccuracy\|runScreener\|scan\.results\|scanResults" dashboard/server.mjs | head -30
```

Identify: (a) where `runScreener()` is called, (b) what `market` value is passed, (c) whether `autoLogAccuracySignals()` is called after each market scan.

- [ ] **Step 2: Verify US/Crypto scan is reachable via API**

```bash
# Start server in background
node --experimental-sqlite dashboard/server.mjs &
sleep 3

# Trigger a US scan (small universe to be fast)
curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $(grep DASHBOARD_API_KEY .env | cut -d= -f2)" \
  -d '{"market":"us","symbols":["NASDAQ:AAPL","NASDAQ:NVDA","NASDAQ:MSFT"]}' | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); console.log('Results:', j.results?.length, '| Sample bias:', j.results?.[0]?.bias)"

# Kill server
kill %1
```

Expected: results array with bias values (STRONG BUY / BUY / etc.)

- [ ] **Step 3: Check if US results flow into autoLogAccuracySignals**

After the test scan above:
```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
const rows = db.prepare('SELECT sym, market, bias, regime FROM accuracy_signals ORDER BY id DESC LIMIT 5').all();
console.log(rows);
" 2>/dev/null
```

If `market = 'us'` rows appear → US flow works. If not → `autoLogAccuracySignals()` is not being called after non-TASI scans.

- [ ] **Step 4: If US signals don't appear, find where to call `autoLogAccuracySignals` for non-TASI markets**

Look for the pattern where scan results are assembled and find the call site. Ensure every call to `runScreener()` is followed by `autoLogAccuracySignals(results, market)`.

The typical pattern in server.mjs looks like:
```javascript
const results = await runScreener({ market, mode, onProgress });
// ... state update ...
autoLogAccuracySignals(results, market);  // ensure this exists for every market
```

- [ ] **Step 5: Run a crypto scan and verify**

```bash
node --experimental-sqlite -e "
import('../scripts/tasi_screener.mjs').then(async m => {
  const results = await m.runScreener({ market: 'crypto' });
  const strong = results.filter(r => r.bias === 'STRONG BUY' || r.bias === 'STRONG SELL');
  console.log('Crypto results:', results.length, '| Strong signals:', strong.length);
  console.log('Sample:', JSON.stringify(results[0]?.bias, null, 2));
}).catch(e => console.error(e.message));
" 2>/dev/null
```

- [ ] **Step 6: Commit**

```bash
git add dashboard/server.mjs
git commit -m "fix(lab): ensure US and crypto scan results flow into accuracy lab auto-logger"
```

---

## Task 6: Add TADAWUL:TASI to `score_history` After Each Scan

The TASI index is never logged to `score_history`, so there is no per-day regime record to query. This task writes the index score after every TASI scan.

**Files:**
- Modify: `dashboard/server.mjs` — in or after the scan completion block

- [ ] **Step 1: Find where TASI scan results are written to score_history**

```bash
grep -n "score_history\|dbScoreHistory\|scoreHistory" dashboard/server.mjs | head -20
```

Locate the block that iterates `results` and calls `dbScoreHistory.upsert()` or pushes to `state.score_history`.

- [ ] **Step 2: After the per-stock score_history write loop, add the index entry**

After the existing loop that writes each result to `state.score_history` (around line 543–546), add:

```javascript
// Log index regime to score_history for daily market context
if (results.length > 0) {
  const sampleRegime = results[0]?.market_regime;
  const marketKey    = results[0]?.sym?.startsWith('TADAWUL:') ? 'tasi'
                     : results[0]?.sym?.match(/XRP|BTC|ETH/) ? 'crypto' : 'us';
  const idxSym       = INDEX_FOR_MARKET[marketKey] || INDEX_FOR_MARKET.tasi;
  const date         = new Date().toISOString().split('T')[0];
  const regimeScore  = sampleRegime === 'bull' ? 8 : sampleRegime === 'bear' ? 2 : 5;

  dbScoreHistory.upsert({
    sym: idxSym, date, score: regimeScore, max_score: 9,
    bias: sampleRegime === 'bull' ? 'BUY' : sampleRegime === 'bear' ? 'SELL' : 'SKIP',
    price: null, mode: 'index', vc: 0, rb: 0, wh: 0,
  });
  if (!state.score_history[idxSym]) state.score_history[idxSym] = [];
  state.score_history[idxSym] = state.score_history[idxSym].filter(h => h.d !== date);
  state.score_history[idxSym].push({ d: date, s: regimeScore, b: sampleRegime === 'bull' ? 'BUY' : sampleRegime === 'bear' ? 'SELL' : 'SKIP' });
}
```

- [ ] **Step 3: Verify by running a TASI scan and querying score_history**

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
const rows = db.prepare('SELECT * FROM score_history WHERE sym=? ORDER BY date DESC LIMIT 3').all('TADAWUL:TASI');
console.log(rows.length ? rows : 'No TASI index rows yet — trigger a scan first');
" 2>/dev/null
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/server.mjs
git commit -m "feat(lab): write market index regime to score_history after each scan"
```

---

## Task 7: Narrow Bearish RSI Zone to Reduce False SELL Signals

Root cause: bearish RSI zone is `15–48`, catching normal pullbacks in bull markets (RSI 43–48 is typical intraweek dip, not bearish). Narrowing to `15–43` reduces false STRONG SELL signals.

**Context:** Score 9 STRONG BUY EV = +0.96R. Score 8 = +0.15R. STRONG SELL 91% failure in a bull run. The bearish RSI zone is the primary driver of over-signaling.

**Files:**
- Modify: `scripts/tasi_screener.mjs` lines 980–985

- [ ] **Step 1: Locate and update the bearish RSI condition**

In `scripts/tasi_screener.mjs`, find (around line 980–984):
```javascript
  if (rsiVal !== null) {
    if (rsiVal >= 15 && rsiVal <= 48) {
      bearish += 2; bearFlags.push(`RSI ${rsiVal.toFixed(1)} weak ✓`);
    } else if (rsiVal < 15) {
```

Change to:
```javascript
  if (rsiVal !== null) {
    if (rsiVal >= 15 && rsiVal <= 43) {
      bearish += 2; bearFlags.push(`RSI ${rsiVal.toFixed(1)} weak ✓`);
    } else if (rsiVal < 15) {
```

This creates a neutral RSI band of 43–52 where neither bull nor bear gets the 2-point RSI bonus.

- [ ] **Step 2: Run a quick TASI scan and compare SELL/BUY ratio**

```bash
node --experimental-sqlite -e "
import('../scripts/tasi_screener.mjs').then(async m => {
  const results = await m.runScreener({ market: 'tasi' });
  const buys  = results.filter(r => r.bias === 'STRONG BUY').length;
  const sells = results.filter(r => r.bias === 'STRONG SELL').length;
  const total = results.length;
  console.log(\`STRONG BUY: \${buys} | STRONG SELL: \${sells} | Total: \${total}\`);
  console.log(\`SELL/BUY ratio: \${(sells/Math.max(1,buys)).toFixed(1)}x (was 3-4x before fix)\`);
}).catch(e => console.error(e.message));
" 2>/dev/null
```

Expected: SELL/BUY ratio should drop from 3–4x to 1–2x.

- [ ] **Step 3: Commit**

```bash
git add scripts/tasi_screener.mjs
git commit -m "fix(screener): narrow bearish RSI zone 48→43 to reduce false SELL signals on pullbacks"
```

---

## Task 8: Smoke Test — Full Integration Verification

- [ ] **Step 1: Start server and verify it boots without errors**

```bash
node --experimental-sqlite dashboard/server.mjs &
sleep 4
curl -s http://localhost:3000/api/health | node -e "process.stdin.resume(); let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>console.log(d))"
```

- [ ] **Step 2: Trigger a TASI scan and verify new columns appear in lab**

```bash
# Trigger scan via API
AUTH=$(grep DASHBOARD_API_KEY .env | cut -d= -f2)
curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH" \
  -d '{"market":"tasi"}' > /dev/null

# Wait for scan to finish, then check lab
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
const rows = db.prepare('SELECT sym, bias, regime, market_index, market FROM accuracy_signals ORDER BY id DESC LIMIT 5').all();
console.log(JSON.stringify(rows, null, 2));
" 2>/dev/null
```

Expected:
- `regime` = `'bull'` / `'neutral'` / `'bear'` (not null)
- `market_index` = `'TADAWUL:TASI'`
- `bias` = `'SKIP'` / `'AVOID'` / `'EXIT'` / `'EXIT NOW'` / `'STRONG BUY'` (never `'STRONG SELL'`)

- [ ] **Step 3: Verify SELL/BUY ratio in lab matches screener output**

```bash
node --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('dashboard/mawjah.db');
const stats = db.prepare(\`
  SELECT bias, COUNT(*) as n FROM accuracy_signals GROUP BY bias ORDER BY n DESC
\`).all();
console.log('Lab signal distribution:');
stats.forEach(r => console.log(' ', r.bias, ':', r.n));
" 2>/dev/null
```

- [ ] **Step 4: Kill server**

```bash
kill %1
```

- [ ] **Step 5: Final commit (if any last fixes)**

```bash
git add -p  # review and stage only relevant changes
git commit -m "feat: signal label redesign + regime-aware lab — full integration verified"
```

---

## Post-Implementation Checklist

- [ ] `accuracy_signals` has zero rows with `bias = 'STRONG SELL'`
- [ ] All new rows have non-null `regime` and `market_index`
- [ ] SELL/BUY ratio in scanner is ≤2x (was 3–4x before)
- [ ] TASI index appears in `score_history` after each scan
- [ ] Running a US scan produces rows with `market = 'us'` in `accuracy_signals`
- [ ] Running a crypto scan produces rows with `market = 'crypto'` in `accuracy_signals`
- [ ] Server starts clean with no import errors

---

## Known Limitations (Out of Scope)

- **Score 8 EV (+0.15R) remains marginal** — the RSI zone narrowing (Task 7) will help, but a full re-evaluation of score tier thresholds requires 30+ new resolved signals post-fix.
- **`isHolding` check only works** once the `positions` table has data. Until real positions are tracked, all STRONG SELL signals will resolve as SKIP/AVOID (not EXIT).
- **The `checkPriceOutcomes()` bearish R-multiple encoding** is inconsistent (sometimes +1, sometimes -1 for stops). Not fixed here — fixing it requires a separate audit of `db.js:856`.
