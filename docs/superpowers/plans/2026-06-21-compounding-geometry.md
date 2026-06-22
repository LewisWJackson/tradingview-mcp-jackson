# Compounding Geometry Backtest — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (or kill) the claim that smarter *sizing* of the SAME momentum picks — volatility targeting + conviction weighting + a drawdown brake — compounds to a higher ending balance with lower drawdown, out-of-sample, net of cost.

**Architecture:** Two new files. (1) `dashboard/compounding_geometry.mjs` — small PURE helper functions for each sizing lever (unit-tested, reuses the existing `schemeDExposure` for vol-targeting). (2) `scripts/compounding_geometry_test.mjs` — a standalone research harness (same pattern as `scripts/signal_showdown.mjs`) that replays the existing monthly momentum backtest on ALL stocks (no Sharia filter — applied later as a toggle), runs baseline vs incrementally-stacked levers, splits in-sample / out-of-sample, and prints a CAGR + max-drawdown table plus a parameter-jitter robustness pass.

**Tech Stack:** Node 22 ESM, existing `scripts/bars_cache.mjs` (Yahoo daily OHLCV, on-disk cached), `scripts/tasi_screener.mjs` (`TASI_STOCKS`, `toYahooSym`), `dashboard/momentum_screen.mjs` (`schemeDExposure`), `node --test` for the pure-helper unit tests.

**Spec:** `docs/research/2026-06-21-test-plan-1-compounding-geometry.md`. Data-hygiene basis: `data_hygiene_audit` memory — Sharia leak removed by not filtering; survivorship accepted for concept-proof; liquidity/listing-age/momentum confirmed point-in-time.

**Plain-English glossary (for the report reader):**
- *CAGR* (compound annual growth rate) = the steady yearly % that turns the start balance into the end balance.
- *Max drawdown* = the worst peak-to-trough fall the account ever suffered (smaller is better).
- *Volatility* = how much the price swings around; *vol-targeting* = hold less when swings are big, more when calm.
- *In-sample / out-of-sample* = tune on the first half of history, judge honestly on the unseen second half.
- *Exposure* = what fraction of the account is actually invested (the rest sits in cash earning 0).

---

## Task 1: Pure sizing-lever helpers + unit tests

**Files:**
- Create: `dashboard/compounding_geometry.mjs`
- Modify: `tests/moneypath.test.js` (append a describe block)

The three lever helpers are pure (no I/O, no bars) so they unit-test fast. Vol-targeting reuses the
existing `schemeDExposure` (do NOT reimplement it) — this file adds only what does not exist yet:
annualized-volatility, conviction weights, and the drawdown-brake state machine.

- [ ] **Step 1: Write the failing tests**

Append to `tests/moneypath.test.js` (top of file already has `import { test, describe } from 'node:test'; import assert from 'node:assert/strict';` — reuse them; if the import style differs, match the file's existing style):

```javascript
import {
  annualizedVol, convictionWeights, drawdownBrake,
} from '../dashboard/compounding_geometry.mjs';

describe('compounding_geometry levers', () => {
  // annualizedVol: stdev of daily returns × sqrt(252)
  test('annualizedVol scales daily stdev by sqrt(252)', () => {
    // constant returns → zero stdev → zero vol
    assert.equal(annualizedVol([0.01, 0.01, 0.01]), 0);
    // known stdev: [0.01,-0.01] sample-stdev = 0.0141421..., ×sqrt(252)=0.2245...
    const v = annualizedVol([0.01, -0.01]);
    assert.ok(Math.abs(v - 0.2245) < 0.01, `got ${v}`);
  });
  test('annualizedVol returns null for <2 points', () => {
    assert.equal(annualizedVol([]), null);
    assert.equal(annualizedVol([0.01]), null);
  });

  // convictionWeights: higher momentum → higher weight, sums to 1, capped
  test('convictionWeights sum to 1 and favor higher momentum', () => {
    const w = convictionWeights([0.30, 0.10, 0.20]); // best is index 0, worst index 1
    const sum = w.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum=${sum}`);
    assert.ok(w[0] > w[2] && w[2] > w[1], `expected w0>w2>w1, got ${w}`);
  });
  test('convictionWeights respects maxWeight cap', () => {
    const w = convictionWeights([10, 1, 1, 1, 1], { maxWeight: 0.25 });
    assert.ok(Math.max(...w) <= 0.25 + 1e-9, `max=${Math.max(...w)}`);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });
  test('convictionWeights falls back to equal weight when cap is infeasible', () => {
    // 3 names, cap 0.25 → max achievable sum 0.75 < 1 → equal weight 1/3
    const w = convictionWeights([3, 2, 1], { maxWeight: 0.25 });
    assert.ok(w.every(x => Math.abs(x - 1 / 3) < 1e-9), `got ${w}`);
  });
  test('convictionWeights handles 0 and 1 names', () => {
    assert.deepEqual(convictionWeights([]), []);
    assert.deepEqual(convictionWeights([0.5]), [1]);
  });

  // drawdownBrake: trip when down past threshold, release after recovery
  test('drawdownBrake trips below -threshold and halves exposure', () => {
    const r = drawdownBrake({ eq: 0.80, peak: 1.0, braked: false, threshold: 0.15 });
    assert.equal(r.braked, true);
    assert.equal(r.mult, 0.5);
  });
  test('drawdownBrake stays off above -threshold', () => {
    const r = drawdownBrake({ eq: 0.90, peak: 1.0, braked: false, threshold: 0.15 });
    assert.equal(r.braked, false);
    assert.equal(r.mult, 1);
  });
  test('drawdownBrake releases only after recovering past -threshold*recoverFrac', () => {
    // braked, still deep (-12% vs release line -7.5%) → stay braked
    const a = drawdownBrake({ eq: 0.88, peak: 1.0, braked: true, threshold: 0.15, recoverFrac: 0.5 });
    assert.equal(a.braked, true);
    // braked, recovered to -5% (above -7.5% release line) → release
    const b = drawdownBrake({ eq: 0.95, peak: 1.0, braked: true, threshold: 0.15, recoverFrac: 0.5 });
    assert.equal(b.braked, false);
    assert.equal(b.mult, 1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:money 2>&1 | grep -E "fail|Cannot find module|compounding"`
Expected: FAIL — `Cannot find module '../dashboard/compounding_geometry.mjs'`.

- [ ] **Step 3: Implement the helpers**

Create `dashboard/compounding_geometry.mjs`:

```javascript
/**
 * compounding_geometry.mjs — pure sizing-lever helpers for Test Plan #1.
 *
 * These turn the SAME momentum picks into a smarter-sized portfolio without any new
 * prediction. No I/O, no bars — pure functions, unit-tested in tests/moneypath.test.js.
 * Vol-targeting is NOT here: reuse schemeDExposure from momentum_screen.mjs (it already
 * caps gross exposure at 1, i.e. never leverages — correct for a no-leverage account).
 * Spec: docs/research/2026-06-21-test-plan-1-compounding-geometry.md
 */

/** Annualized volatility (price-swing size) of a daily-return series. null if <2 points. */
export function annualizedVol(dailyReturns, periodsPerYear = 252) {
  if (!dailyReturns || dailyReturns.length < 2) return null;
  const m = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const v = dailyReturns.reduce((a, b) => a + (b - m) ** 2, 0) / (dailyReturns.length - 1);
  return Math.sqrt(v) * Math.sqrt(periodsPerYear);
}

/**
 * Conviction weights across picks: higher momentum → higher weight (rank-linear:
 * best name gets weight ∝ N, worst ∝ 1), normalized to sum 1, then capped at maxWeight
 * with the excess redistributed to uncapped names. Falls back to equal weight when the
 * cap is mathematically infeasible (maxWeight × N < 1).
 */
export function convictionWeights(momScores, { maxWeight = 0.25 } = {}) {
  const n = momScores.length;
  if (n === 0) return [];
  if (n === 1) return [1];
  if (maxWeight * n < 1 + 1e-12) return momScores.map(() => 1 / n); // cap infeasible

  // rank-linear weights: best momentum → rank n, worst → rank 1
  const order = momScores.map((m, i) => [m, i]).sort((a, b) => b[0] - a[0]);
  const rankW = new Array(n);
  for (let r = 0; r < n; r++) rankW[order[r][1]] = n - r;
  const sum = rankW.reduce((a, b) => a + b, 0);
  let w = rankW.map(x => x / sum);

  // iteratively cap + redistribute excess to uncapped names (proportional)
  for (let iter = 0; iter < 100; iter++) {
    const over = [];
    for (let i = 0; i < n; i++) if (w[i] > maxWeight + 1e-12) over.push(i);
    if (!over.length) break;
    let excess = 0;
    for (const i of over) { excess += w[i] - maxWeight; w[i] = maxWeight; }
    const under = [];
    for (let i = 0; i < n; i++) if (w[i] < maxWeight - 1e-12) under.push(i);
    const underSum = under.reduce((a, i) => a + w[i], 0);
    if (underSum <= 0) break;
    for (const i of under) w[i] += excess * (w[i] / underSum);
  }
  return w;
}

/**
 * Drawdown brake: a circuit breaker (no prediction). Trips when equity is more than
 * `threshold` below its running peak, cutting exposure to `brakeMult`. Releases only once
 * equity recovers to within `threshold*recoverFrac` of the peak (hysteresis stops flicker).
 * Pure state transition — caller passes current eq/peak and the prior braked flag, sized
 * BEFORE the period's return is known (no look-ahead).
 */
export function drawdownBrake({ eq, peak, braked, threshold = 0.15, recoverFrac = 0.5, brakeMult = 0.5 } = {}) {
  const dd = peak > 0 ? eq / peak - 1 : 0;
  let nowBraked = braked;
  if (!braked && dd <= -threshold) nowBraked = true;
  else if (braked && dd >= -threshold * recoverFrac) nowBraked = false;
  return { mult: nowBraked ? brakeMult : 1, braked: nowBraked };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:money 2>&1 | grep -E "^# (tests|pass|fail)|compounding"`
Expected: all pass, `# fail 0`. The new `compounding_geometry levers` block contributes 9 tests.

- [ ] **Step 5: Commit**

```bash
git add dashboard/compounding_geometry.mjs tests/moneypath.test.js
git commit -m "feat(geometry): pure sizing-lever helpers (vol/conviction/drawdown-brake) + tests"
```

---

## Task 2: Backtest harness — baseline vs stacked levers, IS/OOS, jitter

**Files:**
- Create: `scripts/compounding_geometry_test.mjs`

This replays the existing monthly-momentum backtest (loop copied from `dashboard/strategy_validation.mjs:56–94`) but on ALL stocks (drop the `compliant` filter), captures per-pick forward returns + a trailing realized-vol, then runs the same period series through baseline and three lever stacks, splitting the periods in half for in-sample vs out-of-sample.

- [ ] **Step 1: Create the harness**

Create `scripts/compounding_geometry_test.mjs`:

```javascript
/**
 * compounding_geometry_test.mjs — Test Plan #1: does smarter SIZING of the SAME
 * momentum picks compound better (higher CAGR, lower max drawdown), out-of-sample?
 *
 * ALL-STOCKS concept proof — Sharia compliance is NOT filtered here (applied later as a
 * toggle on live picks); survivorship accepted. See
 * docs/research/2026-06-21-test-plan-1-compounding-geometry.md and the data_hygiene_audit.
 *
 * Baseline = equal-weight top-quintile 6-1mo momentum, monthly rebalance, Derayah 0.11% RT.
 * Levers stacked incrementally on the SAME picks:
 *   +L1 vol-target  — schemeDExposure scales gross so realized vol ≈ targetVol (≤1, no leverage)
 *   +L2 conviction  — rank-weight within the picks, capped at maxWeight
 *   +L3 brake       — cut exposure 50% when down > brakeThresh from the equity peak
 * Prints CAGR + maxDD for each stack, IN-SAMPLE (first half) vs OUT-OF-SAMPLE (second half),
 * an OOS PASS/FAIL vs baseline, and a ±20% parameter-jitter robustness pass.
 * Run: node scripts/compounding_geometry_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { schemeDExposure } from '../dashboard/momentum_screen.mjs';
import { annualizedVol, convictionWeights, drawdownBrake } from '../dashboard/compounding_geometry.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const VOLWIN = 60; // trailing sessions used to estimate realized vol (point-in-time)
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(1) + '%';

// Compound a chronological per-period return series → CAGR + max drawdown.
function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  return { cagr: yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN, mdd, eq };
}

// Estimate the equal-weight basket's annualized vol from the last VOLWIN daily returns
// ending at each pick's index i (position-wise mean across picks; same-exchange day grid).
function basketRealizedVol(picksData) {
  const series = [];
  for (let off = VOLWIN; off >= 1; off--) {
    const rs = [];
    for (const p of picksData) {
      const a = p.c[p.i - off], b = p.c[p.i - off + 1];
      if (a > 0 && b > 0) rs.push(b / a - 1);
    }
    if (rs.length) series.push(mean(rs));
  }
  return annualizedVol(series);
}

// Run one lever configuration over the period series → per-period return array.
function runStrategy(periods, cfg) {
  const { voltarget = false, conviction = false, brake = false,
          targetVol = 0.15, maxWeight = 0.25, brakeThresh = 0.15 } = cfg;
  let eq = 1, pk = 1, braked = false;
  const rets = [];
  for (const p of periods) {
    const n = p.picks.length;
    const w = conviction ? convictionWeights(p.picks.map(x => x.mom6), { maxWeight })
                         : p.picks.map(() => 1 / n);
    const basketRet = p.picks.reduce((s, x, idx) => s + w[idx] * x.fwd, 0);
    let E = 1;
    if (voltarget) E = schemeDExposure({ realizedVol: p.realizedVol, targetVol, inSeason: true, stateMult: 1 });
    let bmult = 1;
    if (brake) { const r = drawdownBrake({ eq, peak: pk, braked, threshold: brakeThresh }); bmult = r.mult; braked = r.braked; }
    const Ef = E * bmult;
    const ret = Ef * basketRet - COST_RT * Ef; // cost charged on the deployed fraction only
    rets.push(ret);
    eq *= 1 + ret; pk = Math.max(pk, eq);
  }
  return rets;
}

function summarize(periods, cfg) {
  const mid = Math.floor(periods.length / 2);
  const all = equityStats(runStrategy(periods, cfg));
  const is = equityStats(runStrategy(periods.slice(0, mid), cfg));
  const oos = equityStats(runStrategy(periods.slice(mid), cfg));
  return { all, is, oos };
}

(async () => {
  console.log('Warming bars cache (all TASI stocks, 10y)…');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  // Load price series for every name (NO Sharia filter — all stocks).
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y');
    if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };

  // Build the period series: same picks logic as strategy_validation.mjs, all-stocks.
  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let liq = 0, nn = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); nn++; }
      rows.push({ s, mom6, liq: liq / nn, i });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    const pickRows = [...liquid].sort((a, b) => b.mom6 - a.mom6).slice(0, Math.max(5, Math.floor(liquid.length * 0.2)));
    const picks = pickRows
      .map(r => ({ s: r.s, mom6: r.mom6, fwd: fwd(r.s, date), c: data[r.s].c, i: r.i }))
      .filter(p => p.fwd != null);
    if (!picks.length) continue;
    const realizedVol = basketRealizedVol(picks);
    periods.push({ date, picks: picks.map(p => ({ s: p.s, mom6: p.mom6, fwd: p.fwd })), realizedVol });
  }

  console.log(`\nPeriods: ${periods.length}  (${periods[0]?.date} → ${periods.at(-1)?.date}), all-stocks, COVID carved out\n`);

  const stacks = [
    ['Baseline (equal-weight)', {}],
    ['+L1 vol-target',          { voltarget: true }],
    ['+L1+L2 conviction',       { voltarget: true, conviction: true }],
    ['+L1+L2+L3 brake (FULL)',  { voltarget: true, conviction: true, brake: true }],
  ];

  // Table: CAGR + maxDD, in-sample vs out-of-sample.
  const fmt = s => `CAGR ${pct(s.cagr).padStart(6)}  maxDD ${pct(s.mdd).padStart(6)}`;
  console.log('STACK'.padEnd(26), '| IN-SAMPLE'.padEnd(30), '| OUT-OF-SAMPLE');
  console.log('-'.repeat(86));
  let base;
  for (const [name, cfg] of stacks) {
    const r = summarize(periods, cfg);
    if (!base) base = r;
    console.log(name.padEnd(26), '|', fmt(r.is).padEnd(28), '|', fmt(r.oos));
  }

  // OOS gate vs baseline: higher CAGR AND not-worse maxDD on the unseen half.
  console.log('\nOOS GATE (vs baseline, out-of-sample half):');
  for (const [name, cfg] of stacks.slice(1)) {
    const r = summarize(periods, cfg);
    const cagrUp = r.oos.cagr > base.oos.cagr;
    const ddOk = r.oos.mdd >= base.oos.mdd - 1e-9; // mdd is negative; >= means not worse
    const pass = cagrUp && ddOk;
    console.log(`  ${name.padEnd(24)} ${pass ? 'PASS' : 'FAIL'}  (CAGR ${cagrUp ? 'up' : 'down'} ${pct(r.oos.cagr - base.oos.cagr)}, maxDD ${ddOk ? 'ok' : 'worse'} ${pct(r.oos.mdd - base.oos.mdd)})`);
  }

  // Robustness: ±20% jitter on the full-stack params → OOS CAGR range.
  console.log('\nROBUSTNESS — full stack, ±20% param jitter (OOS CAGR should stay > baseline):');
  const baseOosCagr = base.oos.cagr;
  for (const f of [0.8, 1.0, 1.2]) {
    const r = summarize(periods, { voltarget: true, conviction: true, brake: true,
      targetVol: 0.15 * f, maxWeight: 0.25 * f, brakeThresh: 0.15 * f });
    console.log(`  jitter ×${f}: OOS CAGR ${pct(r.oos.cagr)}  (vs baseline ${pct(baseOosCagr)}, Δ ${pct(r.oos.cagr - baseOosCagr)})`);
  }
})();
```

- [ ] **Step 2: Run the harness (this is the validation — it produces the answer)**

Run: `node scripts/compounding_geometry_test.mjs`
Expected: prints a period count (>50), a table with finite CAGR/maxDD for all four stacks (no `NaN`/`—` in the numeric cells), an OOS GATE block with PASS/FAIL per lever, and a 3-row robustness block. The Baseline row is the apples-to-apples reference (same picks, equal weight). Sanity: Baseline maxDD should be a meaningful negative number (e.g. −15% to −45%); vol-target should make maxDD *less* negative (shallower) at some CAGR cost or gain.

If every cell is `—`/`NaN`: the bars cache is empty or symbols failed — re-run once (warm populates `data/bars_cache.json`); confirm with `node -e "console.log(Object.keys(require('./data/bars_cache.json')).length)"` → should be ~150+.

- [ ] **Step 3: Commit the harness**

```bash
git add scripts/compounding_geometry_test.mjs
git commit -m "feat(geometry): all-stocks backtest harness — baseline vs stacked sizing levers (IS/OOS + jitter)"
```

---

## Task 3: Record findings + verdict per lever

**Files:**
- Create: `docs/research/2026-06-21-compounding-geometry-results.md`

Turn the harness output into a plain-English verdict the user can read, applying the kill criteria and OOS gate from the spec.

- [ ] **Step 1: Capture the run output**

Run: `node scripts/compounding_geometry_test.mjs | tee /tmp/cg-results.txt`
Expected: same table as Task 2; `/tmp/cg-results.txt` now holds it.

- [ ] **Step 2: Write the results doc**

Create `docs/research/2026-06-21-compounding-geometry-results.md` with: (a) the raw table pasted from `/tmp/cg-results.txt`; (b) for EACH lever, a one-line verdict — KEEP (passed OOS gate: higher CAGR, not-worse maxDD, survives jitter), KILL (failed: name which kill criterion fired — in-sample-only / knife-edge jitter / brake lowered net CAGR / etc.), or MARGINAL; (c) a plain-English paragraph: did smarter sizing of the same picks actually compound better out-of-sample, yes or no, and which lever(s) to carry into Scheme-D; (d) the caveat line: "absolute CAGR inflated by survivorship; the *delta* between stacks is the trustworthy signal."

Use this exact skeleton (fill the bracketed parts from the real run — do NOT invent numbers):

```markdown
# Compounding Geometry — Results (2026-06-21)

All-stocks concept proof. Sharia not filtered (later toggle). Survivorship accepted →
absolute CAGR is inflated; the **delta between stacks** is the trustworthy signal.

## Raw output
```
[paste /tmp/cg-results.txt verbatim]
```

## Verdict per lever
- **L1 vol-target:** [KEEP / KILL / MARGINAL] — [which gate line / kill criterion decided it]
- **L2 conviction:** [KEEP / KILL / MARGINAL] — [...]
- **L3 drawdown brake:** [KEEP / KILL / MARGINAL] — [...]

## Plain-English conclusion
[Did smarter sizing of the same picks compound better out-of-sample? Which levers to carry
into Scheme-D? What, if anything, to test next?]
```

- [ ] **Step 3: Commit the findings**

```bash
git add docs/research/2026-06-21-compounding-geometry-results.md
git commit -m "docs(geometry): compounding-geometry backtest results + per-lever verdict"
```

---

## Notes for the executor

- **Do NOT reimplement vol-targeting** — `schemeDExposure` from `dashboard/momentum_screen.mjs` is the lever; it already caps exposure at 1 (no leverage). Pass `inSeason: true, stateMult: 1` to isolate pure vol-targeting.
- **The picks logic must stay byte-identical to `strategy_validation.mjs:72–82`** except the dropped `compliant.has(s)` filter — that is the whole point (same picks, different sizing). If you change the picks, the baseline is no longer the live edge.
- **No look-ahead in sizing:** vol uses only bars up to index `i`; the brake sizes off equity through the *prior* period. Never size off a return you have not realized yet.
- **The harness is a research script** (like the other `scripts/*_test.mjs`) — it is run by hand, NOT added to `npm test`. Only the Task 1 pure helpers are in the test suite.
- **Network:** first run fetches ~150 symbols from Yahoo into `data/bars_cache.json` (cached 18h). Subsequent runs are fast. If offline, it falls back to stale cache.
- Do the tasks IN ORDER; each commit is independent and bisectable.

## Self-review notes (author)

- **Spec coverage:** vol-target ✓ (L1), conviction ✓ (L2), drawdown brake ✓ (L3), net-of-cost ✓ (COST_RT on deployed fraction), IS/OOS split ✓, jitter robustness ✓, OOS gate (CAGR up + maxDD not worse) ✓, kill criteria ✓ (Task 3 verdict applies them), plain-English deliverable ✓. Walk-forward (spec "method" step 2 variant) intentionally deferred — YAGNI for concept-proof; IS/OOS halves + jitter are sufficient to pass/kill. Sharpe/Sortino tie-breaks deferred (CAGR+maxDD decide; add only if a lever is MARGINAL).
- **Cost model simplification:** charges `COST_RT × deployed fraction` rather than modelling exact turnover from weight changes — stated in code comment + executor notes. Acceptable for concept-proof; refine only if a lever's edge is within a cost-width of zero.
- **Realized-vol proxy:** position-wise mean of picks' daily returns assumes a shared same-exchange trading-day grid (true for TASI). Documented in `basketRealizedVol`.
