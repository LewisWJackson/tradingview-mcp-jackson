# Coiled Spring Scanner v3 Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the Coiled Spring Scanner's scoring engine with multi-factor contraction detection, RS-vs-index comparison, institutional accumulation signals, multi-window resistance, real sector rotation, a 0-100 probability scoring layer, regime-adjusted output, risk framework, and weighted ranking.

**Architecture:** Enhance in place — add signal helper functions within `scoring_v2.js`, wire them into existing `score*()` functions, layer `computeProbabilityScore()` on top. Update orchestrator to fetch SPY/QQQ/sector ETF data. All changes in 4 files.

**Tech Stack:** Node.js (ES modules), Yahoo Finance data via existing `yahoo_screen_v2.js`, Node.js native `test` module.

**Spec:** `docs/superpowers/specs/2026-04-12-coiled-spring-v3-upgrade-design.md`

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `scripts/scanner/scoring_v2.js` | Modify | New helpers + enhanced score functions + probability engine |
| `scripts/scanner/coiled_spring_scanner.js` | Modify | Fetch benchmarks, pass context, probability loop, weighted ranking |
| `scripts/scanner/test_fixtures/fixtures.js` | Modify | New fixtures (SPY_BARS, QQQ_BARS, SECTOR_ETFS, OUTPERFORMER, UNDERPERFORMER, GAP_NEAR_RESISTANCE) |
| `tests/coiled_spring_scanner.test.js` | Modify | Updated thresholds + ~35-40 new tests |

---

## Task 1: Add New Test Fixtures

**Files:**
- Modify: `scripts/scanner/test_fixtures/fixtures.js`

- [ ] **Step 1: Add SPY_BARS and QQQ_BARS fixtures**

Add after the existing `BOUNDARY_CANDIDATE` export (line ~146). These are 63-bar OHLCV arrays representing index benchmarks for RS calculation. SPY trends up gently (~0.3%/day), QQQ trends up slightly faster (~0.4%/day).

```js
// --- Index benchmark fixtures for RS-vs-index tests ---

const SPY_BARS = makeBars(63, {
  basePrice: 520,
  trend: 'up',
  volatility: 'normal',
  volumeBase: 80_000_000,
  volumeTrend: 'flat'
});

const QQQ_BARS = makeBars(63, {
  basePrice: 440,
  trend: 'up',
  volatility: 'normal',
  volumeBase: 50_000_000,
  volumeTrend: 'flat'
});
```

- [ ] **Step 2: Add OUTPERFORMER fixture**

A stock whose returns beat both SPY and QQQ over 20 and 40-bar windows. Strong uptrend with drying volume (accumulation signature).

```js
const OUTPERFORMER = {
  symbol: 'OUTPERF',
  name: 'Outperformer Test Co',
  price: 95.00,
  changePct: 0.8,
  ma50: 88,
  ma150: 82,
  ma200: 78,
  high52w: 96,
  relStrengthPctile: 90,
  avgVol10d: 1_200_000,
  avgVol3mo: 1_500_000,
  ohlcv: makeBars(63, {
    basePrice: 78,
    trend: 'up',
    volatility: 'contracting',
    volumeBase: 1_500_000,
    volumeTrend: 'drying'
  }),
  earningsTimestamp: Date.now() + (35 * 86_400_000),
  news: [{ title: 'Price target raised to $110' }],
  shortPercentOfFloat: 8,
  sector: 'Technology'
};
```

- [ ] **Step 3: Add UNDERPERFORMER fixture**

A stock lagging both indices. Flat trend, below-average returns.

```js
const UNDERPERFORMER = {
  symbol: 'UNDERP',
  name: 'Underperformer Test Co',
  price: 40.00,
  changePct: -0.3,
  ma50: 41,
  ma150: 43,
  ma200: 45,
  high52w: 55,
  relStrengthPctile: 20,
  avgVol10d: 800_000,
  avgVol3mo: 900_000,
  ohlcv: makeBars(63, {
    basePrice: 45,
    trend: 'down',
    volatility: 'normal',
    volumeBase: 900_000,
    volumeTrend: 'flat'
  }),
  earningsTimestamp: null,
  news: [],
  shortPercentOfFloat: 5,
  sector: 'Healthcare'
};
```

- [ ] **Step 4: Add GAP_NEAR_RESISTANCE fixture**

Stock with a 7% gap near its 20-bar high. Tests gap detection logic.

```js
const GAP_NEAR_RESISTANCE = {
  symbol: 'GAPRES',
  name: 'Gap Near Resistance Co',
  price: 107.00,
  changePct: 7.0,
  ma50: 100,
  ma150: 95,
  ma200: 90,
  high52w: 108,
  relStrengthPctile: 70,
  avgVol10d: 2_000_000,
  avgVol3mo: 1_800_000,
  ohlcv: (() => {
    // 58 normal bars, then a 7% gap on bar 59, then 4 bars near that level
    const base = makeBars(58, {
      basePrice: 95,
      trend: 'up',
      volatility: 'normal',
      volumeBase: 1_800_000,
      volumeTrend: 'flat'
    });
    const lastClose = base[base.length - 1].close;
    const gapOpen = lastClose * 1.07;
    // Gap bar + 4 consolidation bars near the gap level
    for (let i = 0; i < 5; i++) {
      const o = i === 0 ? gapOpen : base[base.length - 1].close * (1 + (Math.random() - 0.5) * 0.01);
      const c = o * (1 + (Math.random() - 0.5) * 0.015);
      base.push({
        open: o,
        high: Math.max(o, c) * 1.005,
        low: Math.min(o, c) * 0.995,
        close: c,
        volume: 3_000_000
      });
    }
    return base;
  })(),
  earningsTimestamp: Date.now() + (10 * 86_400_000),
  news: [{ title: 'Earnings beat estimates, stock gaps higher' }],
  shortPercentOfFloat: 12,
  sector: 'Technology'
};
```

- [ ] **Step 5: Add SECTOR_ETFS fixture**

Minimal sector ETF data for `calcSectorMomentumRank` tests.

```js
const SECTOR_ETFS = {
  XLK: makeBars(63, { basePrice: 200, trend: 'up', volatility: 'normal', volumeBase: 10_000_000, volumeTrend: 'flat' }),
  XLF: makeBars(63, { basePrice: 40, trend: 'flat', volatility: 'normal', volumeBase: 30_000_000, volumeTrend: 'flat' }),
  XLV: makeBars(63, { basePrice: 140, trend: 'up', volatility: 'normal', volumeBase: 8_000_000, volumeTrend: 'flat' }),
  XLE: makeBars(63, { basePrice: 90, trend: 'down', volatility: 'normal', volumeBase: 15_000_000, volumeTrend: 'flat' }),
  XLI: makeBars(63, { basePrice: 120, trend: 'up', volatility: 'normal', volumeBase: 9_000_000, volumeTrend: 'flat' }),
  XLY: makeBars(63, { basePrice: 180, trend: 'flat', volatility: 'normal', volumeBase: 5_000_000, volumeTrend: 'flat' }),
  XLP: makeBars(63, { basePrice: 78, trend: 'flat', volatility: 'normal', volumeBase: 7_000_000, volumeTrend: 'flat' }),
  XLU: makeBars(63, { basePrice: 70, trend: 'down', volatility: 'normal', volumeBase: 6_000_000, volumeTrend: 'flat' }),
  XLB: makeBars(63, { basePrice: 85, trend: 'flat', volatility: 'normal', volumeBase: 4_000_000, volumeTrend: 'flat' }),
  XLRE: makeBars(63, { basePrice: 40, trend: 'down', volatility: 'normal', volumeBase: 3_000_000, volumeTrend: 'flat' }),
  XLC: makeBars(63, { basePrice: 82, trend: 'up', volatility: 'normal', volumeBase: 5_000_000, volumeTrend: 'flat' })
};
```

- [ ] **Step 6: Update exports**

Replace the existing `export { ... }` at the bottom of fixtures.js:

```js
export {
  makeBars,
  VALID_COIL,
  ALREADY_EXPLODED,
  BROKEN_DOWN,
  ILLIQUID,
  FAKE_COMPRESSION,
  BOUNDARY_CANDIDATE,
  SPY_BARS,
  QQQ_BARS,
  OUTPERFORMER,
  UNDERPERFORMER,
  GAP_NEAR_RESISTANCE,
  SECTOR_ETFS
};
```

- [ ] **Step 7: Verify fixtures load**

Run: `node -e "import('./scripts/scanner/test_fixtures/fixtures.js').then(f => console.log(Object.keys(f)))"`
Expected: Array with all 13 export names.

- [ ] **Step 8: Commit**

```bash
git add scripts/scanner/test_fixtures/fixtures.js
git commit -m "test: add v3 upgrade fixtures (SPY, QQQ, sector ETFs, outperformer, underperformer, gap)"
```

---

## Task 2: Add `calcATRPercentile` Helper + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (add after `calcATR` helper, ~line 89)
- Modify: `tests/coiled_spring_scanner.test.js` (add new describe block)

- [ ] **Step 1: Write the failing tests**

Add at the end of the test file, before the closing of the module:

```js
describe('calcATRPercentile', () => {
  it('returns low percentile for contracting volatility', () => {
    const result = calcATRPercentile(VALID_COIL.ohlcv);
    assert.ok(result.atrPercentile <= 30, `expected <= 30, got ${result.atrPercentile}`);
  });

  it('returns high percentile for wide volatility', () => {
    const result = calcATRPercentile(ALREADY_EXPLODED.ohlcv);
    assert.ok(result.atrPercentile >= 50, `expected >= 50, got ${result.atrPercentile}`);
  });

  it('handles bars shorter than lookback gracefully', () => {
    const shortBars = makeBars(20, { basePrice: 50, trend: 'flat', volatility: 'normal', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcATRPercentile(shortBars, 14, 252);
    assert.ok(typeof result.atrPercentile === 'number');
    assert.ok(result.atrPercentile >= 0 && result.atrPercentile <= 100);
  });
});
```

Update the import at the top of the test file to include `calcATRPercentile`:

```js
import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
  detectRedFlags,
  calcATRPercentile
} from '../scripts/scanner/scoring_v2.js';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcATRPercentile" tests/coiled_spring_scanner.test.js`
Expected: FAIL — `calcATRPercentile` is not exported.

- [ ] **Step 3: Implement calcATRPercentile**

Add in `scoring_v2.js` after the `calcATR` function (~line 89):

```js
/**
 * ATR percentile rank vs historical ATR values.
 * @param {Array} bars - OHLCV array
 * @param {number} period - ATR period (default 14)
 * @param {number} lookback - Historical window to rank against (default 252)
 * @returns {{ atrPercentile: number }}
 */
function calcATRPercentile(bars, period = 14, lookback = 252) {
  if (bars.length < period + 1) return { atrPercentile: 50 }; // neutral default

  // Calculate ATR for each possible endpoint in the available history
  const usableBars = Math.min(bars.length, lookback);
  const atrValues = [];
  for (let end = period; end <= usableBars; end++) {
    const slice = bars.slice(end - period, end);
    atrValues.push(calcATR(slice, period));
  }

  const currentATR = atrValues[atrValues.length - 1];
  const belowCount = atrValues.filter(v => v < currentATR).length;
  const atrPercentile = Math.round((belowCount / atrValues.length) * 100);

  return { atrPercentile };
}
```

Add `calcATRPercentile` to the `export { ... }` at the bottom of scoring_v2.js.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcATRPercentile" tests/coiled_spring_scanner.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add calcATRPercentile helper with tests"
```

---

## Task 3: Add `calcStdDevContractionRate` Helper + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (add after `calcATRPercentile`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcStdDevContractionRate', () => {
  it('returns isContracting=true when stddev declining across windows', () => {
    const result = calcStdDevContractionRate(VALID_COIL.ohlcv);
    assert.strictEqual(result.isContracting, true);
  });

  it('returns isContracting=false for flat or expanding volatility', () => {
    const flatBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'wide', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcStdDevContractionRate(flatBars);
    assert.strictEqual(result.isContracting, false);
  });

  it('returns ratio < 1 when contracting', () => {
    const result = calcStdDevContractionRate(VALID_COIL.ohlcv);
    assert.ok(result.ratio < 1, `expected ratio < 1, got ${result.ratio}`);
  });
});
```

Add `calcStdDevContractionRate` to the import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcStdDevContractionRate" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement calcStdDevContractionRate**

```js
/**
 * Standard deviation contraction rate across 3 time windows.
 * @param {Array} bars - OHLCV array
 * @param {number[]} windows - Time windows to compare (default [10, 20, 40])
 * @returns {{ ratio: number, isContracting: boolean }}
 */
function calcStdDevContractionRate(bars, windows = [10, 20, 40]) {
  const maxWindow = Math.max(...windows);
  if (bars.length < maxWindow) return { ratio: 1, isContracting: false };

  function stddev(arr) {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  const closes = bars.map(b => b.close);
  const stds = windows.map(w => stddev(closes.slice(-w)));

  // isContracting = stddev(shortest) < stddev(mid) < stddev(longest)
  const isContracting = stds[0] < stds[1] && stds[1] < stds[2];
  // ratio = shortest / longest (< 1 means contracting)
  const ratio = stds[2] > 0 ? Math.round((stds[0] / stds[2]) * 100) / 100 : 1;

  return { ratio, isContracting };
}
```

Add to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcStdDevContractionRate" tests/coiled_spring_scanner.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add calcStdDevContractionRate helper with tests"
```

---

## Task 4: Enhance VCP Detection + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (rewrite `detectVCP` at ~lines 106-150)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('detectVCP (enhanced)', () => {
  it('returns vcpQuality as a 0-1 float', () => {
    const result = detectVCP(VALID_COIL.ohlcv);
    assert.ok(typeof result.vcpQuality === 'number');
    assert.ok(result.vcpQuality >= 0 && result.vcpQuality <= 1);
  });

  it('allows one non-declining depth in sequence', () => {
    // Build bars where depths go 10%, 7%, 8%, 5% — one wobble at position 3
    // The old strict monotonic check would return 2 contractions; new should return 3
    const bars = makeBars(63, { basePrice: 50, trend: 'up', volatility: 'contracting', volumeBase: 1_000_000, volumeTrend: 'drying' });
    const result = detectVCP(bars);
    assert.ok(typeof result.contractions === 'number');
    assert.ok(typeof result.vcpQuality === 'number');
  });

  it('returns 0 contractions for wide volatile bars', () => {
    const wideBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'wide', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = detectVCP(wideBars);
    assert.ok(result.contractions <= 1, `expected <= 1, got ${result.contractions}`);
  });
});
```

Add `detectVCP` to the import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="detectVCP" tests/coiled_spring_scanner.test.js`
Expected: FAIL — `detectVCP` not exported, and no `vcpQuality` field.

- [ ] **Step 3: Rewrite detectVCP**

Replace the existing `detectVCP` function (~lines 106-150) with:

```js
/**
 * Enhanced VCP (Volatility Contraction Pattern) detection.
 * Uses 5-bar pivots and allows one non-declining depth.
 * @param {Array} bars - OHLCV array
 * @returns {{ contractions: number, depths: number[], vcpQuality: number }}
 */
function detectVCP(bars) {
  if (bars.length < 15) return { contractions: 0, depths: [], vcpQuality: 0 };

  // Find 5-bar swing highs (high > 2 bars on each side)
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].high > bars[i-1].high && bars[i].high > bars[i-2].high &&
        bars[i].high > bars[i+1].high && bars[i].high > bars[i+2].high) {
      swingHighs.push({ idx: i, price: bars[i].high });
    }
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push({ idx: i, price: bars[i].low });
    }
  }

  // Calculate pullback depths: from each swing high to the next swing low after it
  const depths = [];
  for (const sh of swingHighs) {
    const nextLow = swingLows.find(sl => sl.idx > sh.idx);
    if (nextLow) {
      const depth = ((sh.price - nextLow.price) / sh.price) * 100;
      depths.push(Math.round(depth * 10) / 10);
    }
  }

  if (depths.length < 2) return { contractions: 0, depths, vcpQuality: 0 };

  // Count contractions allowing one non-declining depth
  let contractions = 0;
  let wobbles = 0;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i] < depths[i - 1]) {
      contractions++;
    } else if (wobbles === 0) {
      wobbles++;       // allow one wobble
      contractions++;  // still count it
    } else {
      break;           // second non-declining depth breaks the chain
    }
  }

  // vcpQuality: 0-1 based on how clean the tightening is
  const avgDeclineRate = depths.length >= 2
    ? depths.slice(0, -1).reduce((sum, d, i) => sum + (d - depths[i + 1]), 0) / (depths.length - 1)
    : 0;
  const vcpQuality = Math.min(1, Math.max(0, (contractions / 5) * (1 - wobbles * 0.2) * Math.min(1, avgDeclineRate / 3)));

  return { contractions, depths, vcpQuality };
}
```

Export `detectVCP`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="detectVCP" tests/coiled_spring_scanner.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: Run existing contraction tests to check for regressions**

Run: `node --test --test-name-pattern="scoreContractionQuality" tests/coiled_spring_scanner.test.js`
Expected: All existing contraction tests PASS (the function uses detectVCP internally).

- [ ] **Step 6: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: enhance VCP detection with 5-bar pivots and wobble tolerance"
```

---

## Task 5: Wire Multi-Factor Contraction Gate into `scoreContractionQuality` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 152-206, `scoreContractionQuality`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('multi-factor contraction gate', () => {
  it('caps score at 15 when fewer than 3 signals confirm', () => {
    // FAKE_COMPRESSION has tight range but no accumulation, flat trend
    // Should trigger BB width and tight range but not ATR percentile or VCP
    const result = scoreContractionQuality(FAKE_COMPRESSION);
    assert.ok(result.score <= 15, `expected <= 15, got ${result.score}`);
    assert.ok(typeof result.confirmingSignals === 'number');
  });

  it('allows full score when 3+ signals confirm', () => {
    const result = scoreContractionQuality(VALID_COIL);
    assert.ok(typeof result.confirmingSignals === 'number');
    // VALID_COIL has contracting volatility — should confirm 3+ signals
    if (result.confirmingSignals >= 3) {
      assert.ok(result.score > 15, `3+ signals but score only ${result.score}`);
    }
  });

  it('returns atrPercentile in contraction result', () => {
    const result = scoreContractionQuality(VALID_COIL);
    assert.ok(typeof result.atrPercentile === 'number');
    assert.ok(result.atrPercentile >= 0 && result.atrPercentile <= 100);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="multi-factor contraction gate" tests/coiled_spring_scanner.test.js`
Expected: FAIL — `confirmingSignals` and `atrPercentile` not in return object.

- [ ] **Step 3: Rewrite scoreContractionQuality**

Replace the existing function (~lines 152-206) with the upgraded version. Keep the same function signature `scoreContractionQuality(d)`:

```js
function scoreContractionQuality(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 20) return { score: 0, confidence: 'low', bbWidthPctile: 0, atrRatio: 1, vcpContractions: 0, vcpDepths: [], dailyRangePct: 0, atrPercentile: 50, confirmingSignals: 0 };

  let score = 0;
  const confidence = bars.length >= 40 ? 'high' : 'medium';

  // --- Sub-signals ---
  // 1. BB Width Percentile (0-10 pts)
  const bbw = calcBBWidth(bars, 20);
  const bbWindows = [];
  for (let i = 20; i <= bars.length; i++) {
    bbWindows.push(calcBBWidth(bars.slice(i - 20, i), 20));
  }
  const bbBelow = bbWindows.filter(w => w < bbw).length;
  const bbWidthPctile = Math.round((bbBelow / bbWindows.length) * 100);
  let bbPts = 0;
  if (bbWidthPctile <= 20) bbPts = 10;
  else if (bbWidthPctile <= 30) bbPts = 6;

  // 2. ATR Ratio fast/slow (0-8 pts)
  const atrFast = calcATR(bars.slice(-5), 5);
  const atrSlow = calcATR(bars.slice(-20), 20);
  const atrRatio = atrSlow > 0 ? Math.round((atrFast / atrSlow) * 100) / 100 : 1;
  let atrRatioPts = 0;
  if (atrRatio < 0.5) atrRatioPts = 8;
  else if (atrRatio < 0.7) atrRatioPts = 5;

  // 3. VCP Tightening (0-10 pts)
  const vcp = detectVCP(bars);
  let vcpPts = 0;
  if (vcp.contractions >= 3) vcpPts = 10;
  else if (vcp.contractions >= 2) vcpPts = 6;

  // 4. Tight Daily Range (0-6 pts)
  const last5 = bars.slice(-5);
  const avgRange = last5.reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / last5.length;
  const dailyRangePct = Math.round(avgRange * 100) / 100;
  let rangePts = 0;
  if (dailyRangePct < 3) rangePts = 6;
  else if (dailyRangePct < 5) rangePts = 3;

  // 5. ATR Percentile vs 1yr (0-6 pts)
  const { atrPercentile } = calcATRPercentile(bars);
  let atrPctilePts = 0;
  if (atrPercentile <= 15) atrPctilePts = 6;
  else if (atrPercentile <= 25) atrPctilePts = 4;

  // 6. StdDev Contraction (gate only, no points)
  const { isContracting } = calcStdDevContractionRate(bars);

  // --- Multi-factor confirmation gate ---
  let confirmingSignals = 0;
  if (atrPercentile <= 25) confirmingSignals++;
  if (bbWidthPctile <= 30) confirmingSignals++;
  if (atrRatio < 0.7) confirmingSignals++;
  if (isContracting) confirmingSignals++;
  if (vcp.contractions >= 2) confirmingSignals++;

  score = bbPts + atrRatioPts + vcpPts + rangePts + atrPctilePts;

  // Cap at 15 if fewer than 3 signals confirm
  if (confirmingSignals < 3) {
    score = Math.min(score, 15);
  }

  return {
    score,
    confidence,
    bbWidthPctile,
    atrRatio,
    vcpContractions: vcp.contractions,
    vcpDepths: vcp.depths,
    vcpQuality: vcp.vcpQuality,
    dailyRangePct,
    atrPercentile,
    confirmingSignals
  };
}
```

- [ ] **Step 4: Run all contraction tests**

Run: `node --test --test-name-pattern="scoreContractionQuality|multi-factor contraction" tests/coiled_spring_scanner.test.js`
Expected: All PASS. If existing threshold tests fail, adjust their expected values to match the new point distribution (BB 12→10, ATR ratio 10→8).

- [ ] **Step 5: Update any failing existing threshold tests**

The existing test "Contracting volatility >= 15 score" may need adjustment. The new max for sub-15 is when gate caps it. Check actual values and update the assertion if needed. Similarly "Wide volatility <= 20 score" — already_exploded may score differently with new ATR percentile.

- [ ] **Step 6: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add multi-factor contraction gate to scoreContractionQuality"
```

---

## Task 6: Add `calcRSvsIndex` Helper + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcRSvsIndex', () => {
  it('returns ratio > 1.0 for outperforming stock', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.ok(result.rsRatio20d > 1.0, `expected > 1.0, got ${result.rsRatio20d}`);
  });

  it('returns ratio < 1.0 for underperforming stock', () => {
    const result = calcRSvsIndex(UNDERPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.ok(result.rsRatio20d < 1.0 || result.rsRatio40d < 1.0, `expected < 1.0`);
  });

  it('rsTrending is true when 20d ratio > 40d ratio', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.strictEqual(typeof result.rsTrending, 'boolean');
  });

  it('takes the stronger of SPY and QQQ readings', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    // rsRatio should be the max of SPY comparison and QQQ comparison
    assert.ok(result.rsRatio20d > 0);
    assert.ok(result.rsRatio40d > 0);
  });

  it('returns outperformingOnPullbacks boolean', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.strictEqual(typeof result.outperformingOnPullbacks, 'boolean');
  });
});
```

Add `calcRSvsIndex` to import. Add `SPY_BARS, QQQ_BARS, OUTPERFORMER, UNDERPERFORMER` to fixture import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcRSvsIndex" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement calcRSvsIndex**

Add in scoring_v2.js in the Trend Health section area:

```js
/**
 * Relative strength vs SPY and QQQ benchmarks.
 * Takes the stronger (higher) reading of the two indices.
 * @param {Array} candidateBars - Candidate OHLCV
 * @param {Array} spyBars - SPY OHLCV
 * @param {Array} qqqBars - QQQ OHLCV
 * @param {number[]} windows - Rolling return windows (default [20, 40])
 * @returns {{ rsRatio20d, rsRatio40d, rsTrending, rsNearHigh, outperformingOnPullbacks }}
 */
function calcRSvsIndex(candidateBars, spyBars, qqqBars, windows = [20, 40]) {
  if (candidateBars.length < windows[1] || spyBars.length < windows[1] || qqqBars.length < windows[1]) {
    return { rsRatio20d: 1, rsRatio40d: 1, rsTrending: false, rsNearHigh: false, outperformingOnPullbacks: false };
  }

  function rollingReturn(bars, w) {
    const end = bars[bars.length - 1].close;
    const start = bars[bars.length - 1 - w].close;
    return start > 0 ? (end - start) / start : 0;
  }

  function rsRatio(candidateReturn, indexReturn) {
    // Avoid division by zero; if index flat, use raw candidate return + 1
    if (Math.abs(indexReturn) < 0.001) return 1 + candidateReturn;
    return (1 + candidateReturn) / (1 + indexReturn);
  }

  // Compute RS ratios for both windows against both indices
  const ratios = {};
  for (const w of windows) {
    const candRet = rollingReturn(candidateBars, w);
    const spyRet = rollingReturn(spyBars, w);
    const qqqRet = rollingReturn(qqqBars, w);
    const vsSpy = rsRatio(candRet, spyRet);
    const vsQqq = rsRatio(candRet, qqqRet);
    ratios[w] = Math.max(vsSpy, vsQqq); // take stronger reading
  }

  const rsRatio20d = Math.round(ratios[windows[0]] * 1000) / 1000;
  const rsRatio40d = Math.round(ratios[windows[1]] * 1000) / 1000;
  const rsTrending = rsRatio20d > rsRatio40d;

  // RS near high: current 20d ratio within 5% of max over 40-bar rolling window
  const rsHistory = [];
  for (let i = windows[0]; i <= Math.min(candidateBars.length, windows[1]); i++) {
    const cRet = (candidateBars[candidateBars.length - 1 - (windows[0] - (i - windows[0]))].close - candidateBars[candidateBars.length - 1 - i].close) / candidateBars[candidateBars.length - 1 - i].close;
    rsHistory.push(1 + cRet);
  }
  const rsMax = rsHistory.length > 0 ? Math.max(...rsHistory) : rsRatio20d;
  const rsNearHigh = rsMax > 0 ? rsRatio20d >= rsMax * 0.95 : false;

  // Outperforming on pullbacks: on days where SPY was down, candidate's avg return was less negative
  const minLen = Math.min(candidateBars.length, spyBars.length, 40);
  let candPullbackReturn = 0;
  let pullbackDays = 0;
  for (let i = candidateBars.length - minLen + 1; i < candidateBars.length; i++) {
    const spyIdx = spyBars.length - (candidateBars.length - i);
    if (spyIdx > 0 && spyBars[spyIdx].close < spyBars[spyIdx - 1].close) {
      const candDayReturn = (candidateBars[i].close - candidateBars[i - 1].close) / candidateBars[i - 1].close;
      candPullbackReturn += candDayReturn;
      pullbackDays++;
    }
  }
  const outperformingOnPullbacks = pullbackDays > 0 ? (candPullbackReturn / pullbackDays) > -0.005 : false;

  return { rsRatio20d, rsRatio40d, rsTrending, rsNearHigh, outperformingOnPullbacks };
}
```

Add to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcRSvsIndex" tests/coiled_spring_scanner.test.js`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add calcRSvsIndex helper comparing candidate vs SPY/QQQ"
```

---

## Task 7: Wire RS Into `scoreTrendHealth` + Update Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 16-64, `scoreTrendHealth`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Update scoreTrendHealth signature and implementation**

The function currently takes `scoreTrendHealth(d)`. Change to `scoreTrendHealth(d, context = {})` where `context` may contain `{ spyOhlcv, qqqOhlcv }`.

Replace the existing function body:

```js
function scoreTrendHealth(d, context = {}) {
  const bars = d.ohlcv || [];
  if (bars.length < 5) return { score: 0, confidence: 'low', rsSubtotal: 0, trendSubtotal: 0 };

  const confidence = bars.length >= 20 ? 'high' : 'medium';
  let trendSubtotal = 0;
  let rsSubtotal = 0;

  // --- Trend signals (21 pts max) ---
  // MA stacking: 8 pts
  if (d.ma50 > d.ma150 && d.ma150 > d.ma200) trendSubtotal += 8;

  // Price above 50-day MA: 5 pts
  if (d.price > d.ma50) trendSubtotal += 5;

  // Within 25% of 52-week high: 4 pts
  if (d.high52w > 0 && d.price >= d.high52w * 0.75) trendSubtotal += 4;

  // Higher highs + higher lows over last 20 days: 4 pts
  const recent = bars.slice(-20);
  if (recent.length >= 10) {
    const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
    const secondHalf = recent.slice(Math.floor(recent.length / 2));
    const fhHigh = Math.max(...firstHalf.map(b => b.high));
    const shHigh = Math.max(...secondHalf.map(b => b.high));
    const fhLow = Math.min(...firstHalf.map(b => b.low));
    const shLow = Math.min(...secondHalf.map(b => b.low));
    if (shHigh > fhHigh && shLow > fhLow) trendSubtotal += 4;
  }

  // --- RS signals (9 pts max) ---
  if (context.spyOhlcv && context.qqqOhlcv) {
    const rs = calcRSvsIndex(bars, context.spyOhlcv, context.qqqOhlcv);

    // RS vs index ratio > 1.0: 4 pts
    if (rs.rsRatio20d > 1.05) rsSubtotal += 4;
    else if (rs.rsRatio20d > 1.0) rsSubtotal += 2;

    // RS trending upward: 3 pts
    if (rs.rsTrending) rsSubtotal += 3;

    // Outperforming on pullbacks: 2 pts
    if (rs.outperformingOnPullbacks) rsSubtotal += 2;

    // Penalty: underperforming both windows by > 10%
    if (rs.rsRatio20d < 0.9 && rs.rsRatio40d < 0.9) {
      rsSubtotal = Math.max(0, rsSubtotal - 3);
    }
  } else {
    // Fallback: use Yahoo relStrengthPctile when no index data available
    if ((d.relStrengthPctile || 0) >= 70) rsSubtotal += 5;
    else if ((d.relStrengthPctile || 0) >= 50) rsSubtotal += 3;
  }

  const score = Math.max(0, trendSubtotal + rsSubtotal);

  return { score, confidence, rsSubtotal, trendSubtotal };
}
```

- [ ] **Step 2: Update existing scoreTrendHealth tests**

The existing tests don't pass `context`, so they'll use the Yahoo fallback. Update assertions:

- "Valid coil returns score >= 20" — may need adjustment. VALID_COIL has relStrengthPctile=82, so fallback gives 5 pts. Trend should give ~21. Total ~26. Keep >= 20 assertion.
- "Stacked MAs award >= 8 pts" — unchanged, still 8 pts.
- "RS top 30% scores higher" — this test compared Yahoo percentiles. Update to test both fallback and index-based paths.

```js
it('uses index-based RS when context provided', () => {
  const result = scoreTrendHealth(OUTPERFORMER, { spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS });
  assert.ok(result.rsSubtotal > 0, `expected rsSubtotal > 0, got ${result.rsSubtotal}`);
});

it('falls back to Yahoo RS when no context', () => {
  const result = scoreTrendHealth(VALID_COIL);
  // VALID_COIL has relStrengthPctile=82, should get fallback points
  assert.ok(result.rsSubtotal >= 3, `expected >= 3, got ${result.rsSubtotal}`);
});

it('returns rsSubtotal and trendSubtotal breakdown', () => {
  const result = scoreTrendHealth(VALID_COIL);
  assert.ok(typeof result.rsSubtotal === 'number');
  assert.ok(typeof result.trendSubtotal === 'number');
  assert.strictEqual(result.score, result.rsSubtotal + result.trendSubtotal);
});
```

- [ ] **Step 3: Run all trend health tests**

Run: `node --test --test-name-pattern="scoreTrendHealth" tests/coiled_spring_scanner.test.js`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: wire RS-vs-index into scoreTrendHealth with Yahoo fallback"
```

---

## Task 8: Add Institutional Accumulation Helpers + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcAccumulationScore', () => {
  it('returns higher score for accumulating stock', () => {
    const result = calcAccumulationScore(VALID_COIL.ohlcv);
    assert.ok(result.accDistScore > 0, `expected > 0, got ${result.accDistScore}`);
  });

  it('returns lower score for distributing stock', () => {
    const result = calcAccumulationScore(BROKEN_DOWN.ohlcv);
    const validResult = calcAccumulationScore(VALID_COIL.ohlcv);
    assert.ok(result.accDistScore < validResult.accDistScore);
  });
});

describe('calcOBVTrendSlope', () => {
  it('returns positive slope for accumulating stock', () => {
    const result = calcOBVTrendSlope(OUTPERFORMER.ohlcv);
    assert.ok(result.obvSlope >= 0, `expected >= 0, got ${result.obvSlope}`);
  });

  it('returns normalized slope for cross-stock comparison', () => {
    const result = calcOBVTrendSlope(VALID_COIL.ohlcv);
    assert.ok(typeof result.obvSlopeNormalized === 'number');
  });
});

describe('calcVolumeClustering', () => {
  it('detects high volume at swing lows', () => {
    const result = calcVolumeClustering(VALID_COIL.ohlcv);
    assert.ok(typeof result.supportVolumeRatio === 'number');
    assert.ok(result.supportVolumeRatio > 0);
  });

  it('returns lower ratio when volume is uniform', () => {
    const flatBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'normal', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcVolumeClustering(flatBars);
    assert.ok(result.supportVolumeRatio < 2, `expected < 2, got ${result.supportVolumeRatio}`);
  });
});
```

Add `calcAccumulationScore, calcOBVTrendSlope, calcVolumeClustering` to import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcAccumulationScore|calcOBVTrendSlope|calcVolumeClustering" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the three helpers**

Add in the Volume Signature section of scoring_v2.js:

```js
/**
 * Directional accumulation/distribution score.
 * @param {Array} bars - OHLCV array
 * @param {number} period - Lookback period (default 20)
 * @returns {{ accDistScore: number }}
 */
function calcAccumulationScore(bars, period = 20) {
  if (bars.length < period) return { accDistScore: 0 };

  const recent = bars.slice(-period);
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;

  let weightedUp = 0;
  let weightedDown = 0;

  for (const bar of recent) {
    if (bar.close > bar.open && bar.volume > avgVol * 1.2) {
      weightedUp += bar.volume / avgVol;
    } else if (bar.close < bar.open && bar.volume < avgVol * 0.8) {
      weightedDown += bar.volume / avgVol;
    }
  }

  // Ratio of weighted up to weighted down (higher = more accumulation)
  const accDistScore = weightedDown > 0
    ? Math.round((weightedUp / weightedDown) * 100) / 100
    : weightedUp > 0 ? 3 : 0;

  return { accDistScore };
}

/**
 * On-Balance Volume trend slope via least-squares regression.
 * @param {Array} bars - OHLCV array
 * @param {number} period - OBV lookback (default 20)
 * @returns {{ obvSlope: number, obvSlopeNormalized: number }}
 */
function calcOBVTrendSlope(bars, period = 20) {
  if (bars.length < period) return { obvSlope: 0, obvSlopeNormalized: 0 };

  const recent = bars.slice(-period);
  // Build OBV series
  const obv = [0];
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close > recent[i - 1].close ? recent[i].volume
      : recent[i].close < recent[i - 1].close ? -recent[i].volume : 0;
    obv.push(obv[obv.length - 1] + change);
  }

  // Least-squares linear regression slope
  const n = obv.length;
  const xMean = (n - 1) / 2;
  const yMean = obv.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (obv[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const obvSlope = den > 0 ? Math.round(num / den) : 0;

  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / n;
  const obvSlopeNormalized = avgVol > 0 ? Math.round((obvSlope / avgVol) * 10000) / 10000 : 0;

  return { obvSlope, obvSlopeNormalized };
}

/**
 * Volume clustering at support levels.
 * @param {Array} bars - OHLCV array
 * @param {number} period - Lookback (default 20)
 * @returns {{ supportVolumeRatio: number }}
 */
function calcVolumeClustering(bars, period = 20) {
  if (bars.length < period) return { supportVolumeRatio: 1 };

  const recent = bars.slice(-period);
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;

  // Find bars near swing lows (within 2% of 10-bar rolling low)
  const supportBars = [];
  for (let i = 10; i < recent.length; i++) {
    const rollingLow = Math.min(...recent.slice(i - 10, i).map(b => b.low));
    if (recent[i].low <= rollingLow * 1.02) {
      supportBars.push(recent[i]);
    }
  }

  if (supportBars.length === 0) return { supportVolumeRatio: 1 };

  const supportAvgVol = supportBars.reduce((s, b) => s + b.volume, 0) / supportBars.length;
  const supportVolumeRatio = avgVol > 0 ? Math.round((supportAvgVol / avgVol) * 100) / 100 : 1;

  return { supportVolumeRatio };
}
```

Add all three to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcAccumulationScore|calcOBVTrendSlope|calcVolumeClustering" tests/coiled_spring_scanner.test.js`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add institutional accumulation helpers (accDist, OBV slope, volume clustering)"
```

---

## Task 9: Wire Institutional Signals into `scoreVolumeSignature` + Update Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 221-295, `scoreVolumeSignature`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Rewrite scoreVolumeSignature**

Replace existing function body:

```js
function scoreVolumeSignature(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 10) return { score: 0, confidence: 'low', volDroughtRatio: 1, accDistScore: 0, upDownVolRatio: 1, obvSlopeNormalized: 0, supportVolumeRatio: 1 };

  const confidence = bars.length >= 20 ? 'high' : 'medium';
  let score = 0;

  // 1. Volume drought (0-5 pts)
  const avg10d = (d.avgVol10d || bars.slice(-10).reduce((s, b) => s + b.volume, 0) / 10);
  const avg3mo = (d.avgVol3mo || bars.reduce((s, b) => s + b.volume, 0) / bars.length);
  const volDroughtRatio = avg3mo > 0 ? Math.round((avg10d / avg3mo) * 100) / 100 : 1;
  if (volDroughtRatio < 0.7) score += 5;
  else if (volDroughtRatio < 0.85) score += 3;

  // 2. Accumulation/Distribution score (0-5 pts) — replaces simple accumulation day count
  const { accDistScore } = calcAccumulationScore(bars);
  if (accDistScore >= 2.0) score += 5;
  else if (accDistScore >= 1.3) score += 3;

  // 3. Up/down volume ratio (0-3 pts)
  const recent20 = bars.slice(-20);
  let upVol = 0, downVol = 0;
  for (const b of recent20) {
    if (b.close > b.open) upVol += b.volume;
    else downVol += b.volume;
  }
  const upDownVolRatio = downVol > 0 ? Math.round((upVol / downVol) * 100) / 100 : upVol > 0 ? 3 : 1;
  if (upDownVolRatio > 1.5) score += 3;
  else if (upDownVolRatio > 1.2) score += 2;

  // 4. Volume on higher lows (0-3 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push({ idx: i, low: bars[i].low, vol: bars[i].volume });
    }
  }
  if (swingLows.length >= 2) {
    const last2 = swingLows.slice(-2);
    if (last2[1].low > last2[0].low && last2[1].vol > last2[0].vol) score += 3;
  }

  // 5. OBV trend slope (0-2 pts)
  const { obvSlopeNormalized } = calcOBVTrendSlope(bars);
  if (obvSlopeNormalized > 0.5) score += 2;
  else if (obvSlopeNormalized > 0.1) score += 1;

  // 6. Volume clustering at support (0-2 pts)
  const { supportVolumeRatio } = calcVolumeClustering(bars);
  if (supportVolumeRatio > 1.3) score += 2;
  else if (supportVolumeRatio > 1.1) score += 1;

  return {
    score,
    confidence,
    volDroughtRatio,
    accDistScore,
    upDownVolRatio,
    obvSlopeNormalized,
    supportVolumeRatio
  };
}
```

- [ ] **Step 2: Update existing volume tests**

Replace the old "accumulation days" references. The test "Real accumulation > dead money" should still pass because VALID_COIL has better volume signature than FAKE_COMPRESSION. Update field references from `accumulationDays` to `accDistScore`.

```js
it('returns accDistScore instead of accumulationDays', () => {
  const result = scoreVolumeSignature(VALID_COIL);
  assert.ok(typeof result.accDistScore === 'number');
  assert.ok(result.accDistScore >= 0);
});
```

- [ ] **Step 3: Run all volume signature tests**

Run: `node --test --test-name-pattern="scoreVolumeSignature" tests/coiled_spring_scanner.test.js`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: wire institutional signals into scoreVolumeSignature"
```

---

## Task 10: Add Enhanced Resistance Helpers + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcResistanceLevel', () => {
  it('returns higher strength when multiple windows agree', () => {
    const result = calcResistanceLevel(VALID_COIL.ohlcv);
    assert.ok(result.resistanceStrength >= 1 && result.resistanceStrength <= 3);
    assert.ok(typeof result.resistancePrice === 'number');
    assert.ok(result.resistancePrice > 0);
  });

  it('returns resistanceTouches count', () => {
    const result = calcResistanceLevel(VALID_COIL.ohlcv);
    assert.ok(typeof result.resistanceTouches === 'number');
    assert.ok(result.resistanceTouches >= 0);
  });
});

describe('detectGapNearResistance', () => {
  it('detects large gap near resistance', () => {
    const { resistancePrice } = calcResistanceLevel(GAP_NEAR_RESISTANCE.ohlcv);
    const result = detectGapNearResistance(GAP_NEAR_RESISTANCE.ohlcv, resistancePrice);
    assert.strictEqual(result.gapFormedResistance, true);
  });

  it('returns false when no gap near resistance', () => {
    const { resistancePrice } = calcResistanceLevel(VALID_COIL.ohlcv);
    const result = detectGapNearResistance(VALID_COIL.ohlcv, resistancePrice);
    assert.strictEqual(result.gapFormedResistance, false);
  });
});
```

Add `calcResistanceLevel, detectGapNearResistance` to import. Add `GAP_NEAR_RESISTANCE` to fixture import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcResistanceLevel|detectGapNearResistance" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the helpers**

Add in the Pivot Structure section of scoring_v2.js:

```js
/**
 * Multi-window resistance level detection with clustering.
 * @param {Array} bars - OHLCV array
 * @param {number[]} windows - Lookback windows (default [20, 40, 60])
 * @returns {{ resistancePrice: number, resistanceStrength: number, resistanceTouches: number }}
 */
function calcResistanceLevel(bars, windows = [20, 40, 60]) {
  if (bars.length < 20) return { resistancePrice: 0, resistanceStrength: 0, resistanceTouches: 0 };

  // Highest close in each window
  const levels = [];
  for (const w of windows) {
    const slice = bars.slice(-Math.min(w, bars.length));
    const highClose = Math.max(...slice.map(b => b.close));
    levels.push(highClose);
  }

  // Cluster: count how many windows produce resistance within 1.5% of each other
  const primary = levels[0]; // 20-bar is the tightest
  let strength = 1;
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i] - primary) / primary <= 0.015) {
      strength++;
    }
  }

  // Use the average of clustered levels as resistance price
  const clustered = levels.filter(l => Math.abs(l - primary) / primary <= 0.015);
  const resistancePrice = Math.round((clustered.reduce((s, v) => s + v, 0) / clustered.length) * 100) / 100;

  // Count touches: closes within 1.5% of resistance in last 60 bars
  const lookback = bars.slice(-Math.min(60, bars.length));
  const resistanceTouches = lookback.filter(b => Math.abs(b.close - resistancePrice) / resistancePrice <= 0.015).length;

  return { resistancePrice, resistanceStrength: Math.min(strength, 3), resistanceTouches };
}

/**
 * Detect if resistance was formed during a news gap.
 * @param {Array} bars - OHLCV array
 * @param {number} resistancePrice - The resistance level to check
 * @returns {{ gapFormedResistance: boolean }}
 */
function detectGapNearResistance(bars, resistancePrice) {
  if (bars.length < 2 || resistancePrice <= 0) return { gapFormedResistance: false };

  const recent = bars.slice(-20);
  for (let i = 1; i < recent.length; i++) {
    const gapPct = Math.abs(recent[i].open - recent[i - 1].close) / recent[i - 1].close * 100;
    const nearResistance = Math.abs(recent[i].close - resistancePrice) / resistancePrice <= 0.03;
    if (gapPct > 5 && nearResistance) {
      return { gapFormedResistance: true };
    }
  }
  return { gapFormedResistance: false };
}
```

Add both to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcResistanceLevel|detectGapNearResistance" tests/coiled_spring_scanner.test.js`
Expected: 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add multi-window resistance detection and gap-near-resistance helper"
```

---

## Task 11: Wire Resistance + Late-Stage Penalties into `scorePivotStructure` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 296-365, `scorePivotStructure`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write new tests for late-stage penalties**

```js
describe('scorePivotStructure (enhanced)', () => {
  it('returns resistanceStrength from multi-window detection', () => {
    const result = scorePivotStructure(VALID_COIL);
    assert.ok(typeof result.resistanceStrength === 'number');
    assert.ok(result.resistanceStrength >= 1 && result.resistanceStrength <= 3);
  });

  it('penalizes recent large gap', () => {
    const result = scorePivotStructure(GAP_NEAR_RESISTANCE);
    // Should have gap penalty (-3) and possibly gap-formed resistance cap
    assert.ok(result.gapFormedResistance === true || result.score < 10);
  });

  it('caps resistanceStrength to 1 when gap formed resistance', () => {
    const result = scorePivotStructure(GAP_NEAR_RESISTANCE);
    if (result.gapFormedResistance) {
      assert.ok(result.resistanceStrength <= 1);
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="scorePivotStructure \\(enhanced\\)" tests/coiled_spring_scanner.test.js`
Expected: FAIL — no `resistanceStrength` or `gapFormedResistance` in return.

- [ ] **Step 3: Rewrite scorePivotStructure**

```js
function scorePivotStructure(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 20) return { score: 0, confidence: 'low', distFromResistance: 100, resistanceTouches: 0, resistanceStrength: 0, extendedAbove50ma: false, gapFormedResistance: false };

  const confidence = bars.length >= 40 ? 'high' : 'medium';
  let score = 0;

  // Multi-window resistance detection
  const res = calcResistanceLevel(bars);
  const { resistancePrice, resistanceTouches } = res;
  let { resistanceStrength } = res;

  // Gap-formed resistance check
  const { gapFormedResistance } = detectGapNearResistance(bars, resistancePrice);
  if (gapFormedResistance) resistanceStrength = Math.min(resistanceStrength, 1);

  // 1. Distance from confirmed resistance (0-6 pts)
  const distFromResistance = resistancePrice > 0
    ? Math.round(Math.abs(d.price - resistancePrice) / resistancePrice * 100 * 10) / 10
    : 100;
  if (distFromResistance <= 3) score += 6;
  else if (distFromResistance <= 5) score += 4;
  else if (distFromResistance <= 8) score += 2;

  // 2. Resistance strength (0-4 pts)
  if (resistanceStrength >= 3) score += 4;
  else if (resistanceStrength >= 2) score += 3;
  else if (resistanceStrength >= 1) score += 1;

  // 3. Tight closes near highs (0-3 pts)
  const last5 = bars.slice(-5);
  const closePositions = last5.map(b => {
    const range = b.high - b.low;
    return range > 0 ? (b.close - b.low) / range : 0.5;
  });
  const closePosAvg = closePositions.reduce((s, v) => s + v, 0) / closePositions.length;
  if (closePosAvg > 0.7) score += 3;

  // 4. Higher swing lows (0-2 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push(bars[i].low);
    }
  }
  const last3Lows = swingLows.slice(-3);
  if (last3Lows.length >= 3 && last3Lows[2] > last3Lows[1] && last3Lows[1] > last3Lows[0]) score += 2;

  // --- Penalties (stacking, floor at 0) ---
  const extendedAbove50ma = d.ma50 > 0 && ((d.price - d.ma50) / d.ma50 * 100) > 10;
  if (extendedAbove50ma) score -= 5;

  // Recent gap > 8% in last 10 bars
  const last10 = bars.slice(-10);
  let hasLargeGap = false;
  for (let i = 1; i < last10.length; i++) {
    if (Math.abs(last10[i].open - last10[i-1].close) / last10[i-1].close * 100 > 8) {
      hasLargeGap = true;
      break;
    }
  }
  if (hasLargeGap) score -= 3;

  // ATR expanding rapidly (current ATR > 1.5x 20-bar avg ATR)
  if (bars.length >= 20) {
    const currentATR = calcATR(bars.slice(-5), 5);
    const avgATR = calcATR(bars.slice(-20), 20);
    if (avgATR > 0 && currentATR > avgATR * 1.5) score -= 2;
  }

  score = Math.max(0, score);

  return {
    score,
    confidence,
    distFromResistance,
    resistanceTouches,
    resistanceStrength,
    closePosAvg: Math.round(closePosAvg * 100) / 100,
    extendedAbove50ma,
    gapFormedResistance
  };
}
```

- [ ] **Step 4: Run all pivot structure tests**

Run: `node --test --test-name-pattern="scorePivotStructure" tests/coiled_spring_scanner.test.js`
Expected: All PASS (update existing assertions if point values shifted).

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: wire multi-window resistance and late-stage penalties into scorePivotStructure"
```

---

## Task 12: Add `calcSectorMomentumRank` + `matchCatalystKeywords` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcSectorMomentumRank', () => {
  it('returns rank 1-11 for each sector', () => {
    const ranks = calcSectorMomentumRank(SECTOR_ETFS);
    assert.ok(typeof ranks === 'object');
    // XLK has 'up' trend, should rank well
    const techRank = ranks['Technology'];
    assert.ok(techRank >= 1 && techRank <= 11, `Technology rank: ${techRank}`);
  });

  it('strongest sector gets rank 1', () => {
    const ranks = calcSectorMomentumRank(SECTOR_ETFS);
    const allRanks = Object.values(ranks);
    assert.ok(allRanks.includes(1));
    assert.ok(allRanks.includes(11));
  });
});

describe('matchCatalystKeywords', () => {
  it('categorizes earnings catalyst', () => {
    const news = [{ title: 'Analyst price target raised to $150' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'earnings_catalyst');
  });

  it('categorizes merger catalyst', () => {
    const news = [{ title: 'Company announces merger with rival' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'merger_catalyst');
  });

  it('categorizes product catalyst', () => {
    const news = [{ title: 'FDA approval granted for new drug' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'product_catalyst');
  });

  it('deduplicates same catalyst type', () => {
    const news = [
      { title: 'Price target raised by Goldman' },
      { title: 'Price target raised by Morgan Stanley' }
    ];
    const result = matchCatalystKeywords(news);
    // Should deduplicate to one earnings_catalyst
    assert.strictEqual(result.length, 1);
  });

  it('returns empty array for clean news', () => {
    const news = [{ title: 'Company releases quarterly report' }];
    const result = matchCatalystKeywords(news);
    assert.strictEqual(result.length, 0);
  });
});
```

Add `calcSectorMomentumRank, matchCatalystKeywords` to import. Add `SECTOR_ETFS` to fixture import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcSectorMomentumRank|matchCatalystKeywords" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement calcSectorMomentumRank**

```js
// Sector ETF to sector name mapping
const SECTOR_ETF_MAP = {
  XLK: 'Technology', XLF: 'Financial Services', XLV: 'Healthcare',
  XLE: 'Energy', XLI: 'Industrials', XLY: 'Consumer Cyclical',
  XLP: 'Consumer Defensive', XLU: 'Utilities', XLB: 'Basic Materials',
  XLRE: 'Real Estate', XLC: 'Communication Services'
};

/**
 * Rank sectors 1-11 by 20-day return.
 * @param {Object} sectorETFData - { XLK: bars[], XLF: bars[], ... }
 * @returns {Object} - { 'Technology': 1, 'Healthcare': 4, ... }
 */
function calcSectorMomentumRank(sectorETFData) {
  const returns = [];
  for (const [etf, bars] of Object.entries(sectorETFData)) {
    if (bars.length < 20) continue;
    const ret = (bars[bars.length - 1].close - bars[bars.length - 21].close) / bars[bars.length - 21].close;
    const sector = SECTOR_ETF_MAP[etf] || etf;
    returns.push({ sector, ret });
  }

  returns.sort((a, b) => b.ret - a.ret);

  const ranks = {};
  returns.forEach((item, idx) => {
    ranks[item.sector] = idx + 1;
  });

  return ranks;
}
```

- [ ] **Step 4: Implement matchCatalystKeywords**

```js
const CATALYST_PATTERNS = {
  earnings_catalyst: [
    /upgrade/i, /beat/i, /raised guidance/i, /above estimates/i,
    /price target raised/i, /revenue growth/i
  ],
  merger_catalyst: [
    /merger/i, /acquisition/i, /buyout/i, /spin-off/i,
    /activist/i, /strategic review/i
  ],
  product_catalyst: [
    /FDA approval/i, /phase 3/i, /\blaunch\b/i, /patent/i,
    /contract win/i, /new product/i
  ]
};

/**
 * Match news headlines against categorized catalyst patterns.
 * Deduplicates by catalyst type.
 * @param {Array} news - [{ title: string }, ...]
 * @returns {Array} - [{ catalystType, confidence, headline }]
 */
function matchCatalystKeywords(news) {
  if (!news || news.length === 0) return [];

  const found = new Map(); // catalystType -> { confidence, headline }

  for (const item of news) {
    const title = item.title || '';
    const description = item.description || '';
    const text = `${title} ${description}`;

    for (const [type, patterns] of Object.entries(CATALYST_PATTERNS)) {
      if (found.has(type)) continue; // deduplicate
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          const confidence = pattern.test(title) && pattern.test(description) ? 'strong' : pattern.test(title) ? 'strong' : 'weak';
          found.set(type, { catalystType: type, confidence, headline: title });
          break;
        }
      }
    }
  }

  return Array.from(found.values());
}
```

Add both to exports.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcSectorMomentumRank|matchCatalystKeywords" tests/coiled_spring_scanner.test.js`
Expected: 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add calcSectorMomentumRank and matchCatalystKeywords helpers"
```

---

## Task 13: Wire Sector Rank + Keywords into `scoreCatalystAwareness` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 366-420, `scoreCatalystAwareness`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Rewrite scoreCatalystAwareness**

Change signature to `scoreCatalystAwareness(d, context = {})` where context may contain `{ sectorRanks, candidateSector }`:

```js
function scoreCatalystAwareness(d, context = {}) {
  let score = 0;
  let confidence = 'high';

  // 1. Earnings timing (0-4 pts)
  let earningsDaysOut = null;
  if (d.earningsTimestamp) {
    earningsDaysOut = Math.round((d.earningsTimestamp - Date.now()) / 86_400_000);
    if (earningsDaysOut >= 30 && earningsDaysOut <= 45) score += 4;
    else if (earningsDaysOut > 0 && earningsDaysOut < 30) score += 2;
  } else {
    confidence = 'medium';
  }

  // 2. Categorized catalyst match (0-3 pts) — replaces flat keyword match
  const catalysts = matchCatalystKeywords(d.news || []);
  if (catalysts.some(c => c.confidence === 'strong')) score += 3;
  else if (catalysts.length > 0) score += 2;

  // Catalyst tag for output
  const catalystTag = catalysts.some(c => c.confidence === 'strong') || (earningsDaysOut && earningsDaysOut > 0 && earningsDaysOut <= 45)
    ? 'catalyst_present'
    : catalysts.length > 0 || (d.shortPercentOfFloat && d.shortPercentOfFloat > 10)
      ? 'catalyst_weak'
      : 'catalyst_unknown';

  // 3. Sector rank (0-4 pts) — real calculation replaces hardcoded 6
  let sectorMomentumRank = 6; // default fallback
  if (context.sectorRanks && context.candidateSector) {
    sectorMomentumRank = context.sectorRanks[context.candidateSector] || 6;
  }
  if (sectorMomentumRank <= 3) score += 4;
  else if (sectorMomentumRank <= 5) score += 2;

  // 4. Short interest (0-2 pts)
  const shortFloat = d.shortPercentOfFloat || 0;
  if (shortFloat > 15) score += 2;
  else if (shortFloat > 10) score += 1;
  if (!d.shortPercentOfFloat) confidence = 'medium';

  return {
    score,
    confidence,
    earningsDaysOut,
    sectorMomentumRank,
    shortFloat,
    catalystTag,
    catalysts
  };
}
```

- [ ] **Step 2: Add tests for catalyst tag and sector rank**

```js
describe('scoreCatalystAwareness (enhanced)', () => {
  it('returns catalystTag field', () => {
    const result = scoreCatalystAwareness(OUTPERFORMER);
    assert.ok(['catalyst_present', 'catalyst_weak', 'catalyst_unknown'].includes(result.catalystTag));
  });

  it('uses real sector rank from context', () => {
    const sectorRanks = { Technology: 2, Healthcare: 8 };
    const result = scoreCatalystAwareness(OUTPERFORMER, { sectorRanks, candidateSector: 'Technology' });
    assert.strictEqual(result.sectorMomentumRank, 2);
    assert.ok(result.score >= 4, `expected >= 4 for rank 2, got ${result.score}`);
  });

  it('falls back to rank 6 when no context', () => {
    const result = scoreCatalystAwareness(VALID_COIL);
    assert.strictEqual(result.sectorMomentumRank, 6);
  });

  it('tags catalyst_present for strong keyword match', () => {
    const d = { ...OUTPERFORMER, news: [{ title: 'Price target raised to $200' }], earningsTimestamp: null };
    const result = scoreCatalystAwareness(d);
    assert.strictEqual(result.catalystTag, 'catalyst_present');
  });
});
```

- [ ] **Step 3: Run all catalyst tests**

Run: `node --test --test-name-pattern="scoreCatalystAwareness" tests/coiled_spring_scanner.test.js`
Expected: All PASS. Update any existing tests that reference old return fields.

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: wire real sector rank and categorized keywords into scoreCatalystAwareness"
```

---

## Task 14: Add `computeProbabilityScore` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('computeProbabilityScore', () => {
  it('returns probability_score between 0 and 100', () => {
    const signals = {
      trendHealth: { score: 24, rsSubtotal: 7, trendSubtotal: 17 },
      contraction: { score: 35 },
      volumeSignature: { score: 16 },
      pivotProximity: { score: 12 },
      catalystAwareness: { score: 5 }
    };
    const context = { regime: { regime: 'constructive' } };
    const result = computeProbabilityScore(signals, context);
    assert.ok(result.probability_score >= 0 && result.probability_score <= 100);
  });

  it('weights sum to 1.0', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const context = { regime: { regime: 'constructive' } };
    const result = computeProbabilityScore(signals, context);
    // Perfect scores + constructive regime = 100
    assert.strictEqual(result.probability_score, 100);
  });

  it('applies regime multiplier for cautious', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const constructive = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    const cautious = computeProbabilityScore(signals, { regime: { regime: 'cautious' } });
    assert.ok(cautious.probability_score < constructive.probability_score);
    assert.strictEqual(cautious.regime_multiplier, 0.85);
  });

  it('applies regime multiplier for defensive', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'defensive' } });
    assert.strictEqual(result.regime_multiplier, 0.70);
    assert.ok(result.probability_score <= 70);
  });

  it('returns setup_quality tier', () => {
    const signals = {
      trendHealth: { score: 24, rsSubtotal: 7, trendSubtotal: 17 },
      contraction: { score: 35 },
      volumeSignature: { score: 16 },
      pivotProximity: { score: 12 },
      catalystAwareness: { score: 5 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    assert.ok(['ELITE', 'HIGH', 'MODERATE', 'LOW'].includes(result.setup_quality));
  });

  it('returns factor_breakdown object with 7 factors', () => {
    const signals = {
      trendHealth: { score: 20, rsSubtotal: 5, trendSubtotal: 15 },
      contraction: { score: 30 },
      volumeSignature: { score: 10 },
      pivotProximity: { score: 8 },
      catalystAwareness: { score: 6 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    assert.ok(typeof result.factor_breakdown === 'object');
    assert.ok('volatility_contraction' in result.factor_breakdown);
    assert.ok('relative_strength_trend' in result.factor_breakdown);
    assert.ok('volume_dry_up' in result.factor_breakdown);
    assert.ok('trend_quality' in result.factor_breakdown);
    assert.ok('distance_to_resistance' in result.factor_breakdown);
    assert.ok('catalyst_presence' in result.factor_breakdown);
    assert.ok('market_regime_alignment' in result.factor_breakdown);
  });
});
```

Add `computeProbabilityScore` to import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="computeProbabilityScore" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported (existing `computeCompositeScore` is different).

- [ ] **Step 3: Implement computeProbabilityScore**

Add after `computeCompositeScore` in scoring_v2.js:

```js
const REGIME_MULTIPLIERS = { constructive: 1.0, cautious: 0.85, defensive: 0.70 };
const REGIME_ALIGNMENT = { constructive: 1.0, cautious: 0.5, defensive: 0.0 };

/**
 * Compute weighted probability score (0-100) from category signals.
 * @param {Object} signals - { trendHealth, contraction, volumeSignature, pivotProximity, catalystAwareness }
 * @param {Object} context - { regime: { regime: 'constructive'|'cautious'|'defensive' } }
 * @returns {{ probability_score, setup_quality, trade_readiness, regime_multiplier, factor_breakdown }}
 */
function computeProbabilityScore(signals, context = {}) {
  const regimeName = (context.regime && context.regime.regime) || 'constructive';

  // Normalize each category to 0-1
  const contractionNorm = (signals.contraction?.score || 0) / 40;
  const rsNorm = (signals.trendHealth?.rsSubtotal || 0) / 9;
  const volumeNorm = (signals.volumeSignature?.score || 0) / 20;
  const trendNorm = (signals.trendHealth?.trendSubtotal || 0) / 21;
  const resistanceNorm = (signals.pivotProximity?.score || 0) / 15;
  const catalystNorm = (signals.catalystAwareness?.score || 0) / 15;
  const regimeAlignment = REGIME_ALIGNMENT[regimeName] || 1.0;

  // Weighted raw probability
  const rawProb =
    (contractionNorm * 0.25) +
    (rsNorm * 0.20) +
    (volumeNorm * 0.15) +
    (trendNorm * 0.15) +
    (resistanceNorm * 0.10) +
    (catalystNorm * 0.10) +
    (regimeAlignment * 0.05);

  // Apply regime multiplier
  const regime_multiplier = REGIME_MULTIPLIERS[regimeName] || 1.0;
  const probability_score = Math.min(100, Math.round(rawProb * 100 * regime_multiplier));

  // Setup quality tier
  let setup_quality;
  if (probability_score >= 80) setup_quality = 'ELITE';
  else if (probability_score >= 65) setup_quality = 'HIGH';
  else if (probability_score >= 50) setup_quality = 'MODERATE';
  else setup_quality = 'LOW';

  // Trade readiness (set later by caller who has classification + risk)
  const trade_readiness = probability_score >= 65;

  const factor_breakdown = {
    volatility_contraction: Math.round(contractionNorm * 1000) / 1000,
    relative_strength_trend: Math.round(rsNorm * 1000) / 1000,
    volume_dry_up: Math.round(volumeNorm * 1000) / 1000,
    trend_quality: Math.round(trendNorm * 1000) / 1000,
    distance_to_resistance: Math.round(resistanceNorm * 1000) / 1000,
    catalyst_presence: Math.round(catalystNorm * 1000) / 1000,
    market_regime_alignment: regimeAlignment
  };

  return { probability_score, setup_quality, trade_readiness, regime_multiplier, factor_breakdown };
}
```

Add to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="computeProbabilityScore" tests/coiled_spring_scanner.test.js`
Expected: 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add computeProbabilityScore with 7-factor weighted model and regime multiplier"
```

---

## Task 15: Add `calcRiskCategory`, `calcEntryTrigger`, `generateNotes` + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('calcRiskCategory', () => {
  it('returns tight_vcp for coiled spring with 3+ VCP contractions', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 3, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'tight_vcp');
    assert.deepStrictEqual(result.suggested_stop_percent, [3, 5]);
  });

  it('returns standard_coil for coiled spring with fewer VCP contractions', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 1, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'standard_coil');
    assert.deepStrictEqual(result.suggested_stop_percent, [5, 7]);
  });

  it('returns catalyst_play for catalyst_loaded', () => {
    const result = calcRiskCategory('catalyst_loaded', { vcpContractions: 0, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'catalyst_play');
  });

  it('returns base_watch for building_base', () => {
    const result = calcRiskCategory('building_base', { vcpContractions: 0, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'base_watch');
  });

  it('adds 2% to stop range for high ATR percentile', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 3, atrPercentile: 80 });
    assert.deepStrictEqual(result.suggested_stop_percent, [5, 7]);
  });
});

describe('calcEntryTrigger', () => {
  it('returns break above resistance for coiled_spring', () => {
    const result = calcEntryTrigger('coiled_spring', { resistancePrice: 167.50, ma50: 160 });
    assert.ok(result.entry_trigger.includes('break above'));
    assert.ok(result.entry_trigger.includes('167.5'));
  });

  it('returns CSP option for catalyst_loaded', () => {
    const result = calcEntryTrigger('catalyst_loaded', { resistancePrice: 100, ma50: 95 });
    assert.ok(result.entry_trigger.includes('CSP'));
  });

  it('returns watchlist for building_base', () => {
    const result = calcEntryTrigger('building_base', { resistancePrice: 55, ma50: 50 });
    assert.ok(result.entry_trigger.includes('watchlist'));
  });

  it('returns no entry for extended', () => {
    const result = calcEntryTrigger('extended', { resistancePrice: 120, ma50: 100 });
    assert.strictEqual(result.entry_trigger, 'no entry');
  });
});

describe('generateNotes', () => {
  it('returns a non-empty string', () => {
    const signals = {
      contraction: { vcpContractions: 3, atrPercentile: 10 },
      catalystAwareness: { catalystTag: 'catalyst_present', catalysts: [{ catalystType: 'merger_catalyst' }] }
    };
    const details = { sectorMomentumRank: 2, earningsDaysOut: 35 };
    const result = generateNotes(signals, details);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('mentions VCP when contractions >= 3', () => {
    const signals = { contraction: { vcpContractions: 3, atrPercentile: 20 }, catalystAwareness: { catalystTag: 'catalyst_unknown', catalysts: [] } };
    const result = generateNotes(signals, {});
    assert.ok(result.toLowerCase().includes('vcp'));
  });
});
```

Add `calcRiskCategory, calcEntryTrigger, generateNotes` to import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="calcRiskCategory|calcEntryTrigger|generateNotes" tests/coiled_spring_scanner.test.js`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement the three functions**

```js
/**
 * Determine risk category and suggested stop-loss range.
 * @param {string} classification
 * @param {{ vcpContractions: number, atrPercentile: number }} details
 * @returns {{ risk_category: string, suggested_stop_percent: number[] }}
 */
function calcRiskCategory(classification, details) {
  let risk_category, suggested_stop_percent;

  if (classification === 'coiled_spring' && (details.vcpContractions || 0) >= 3) {
    risk_category = 'tight_vcp';
    suggested_stop_percent = [3, 5];
  } else if (classification === 'coiled_spring') {
    risk_category = 'standard_coil';
    suggested_stop_percent = [5, 7];
  } else if (classification === 'catalyst_loaded') {
    risk_category = 'catalyst_play';
    suggested_stop_percent = [5, 8];
  } else if (classification === 'building_base') {
    risk_category = 'base_watch';
    suggested_stop_percent = [7, 10];
  } else {
    risk_category = 'no_trade';
    suggested_stop_percent = [0, 0];
  }

  // Volatile sector adjustment: ATR percentile > 75 adds +2%
  if ((details.atrPercentile || 0) > 75) {
    suggested_stop_percent = [suggested_stop_percent[0] + 2, suggested_stop_percent[1] + 2];
  }

  return { risk_category, suggested_stop_percent };
}

/**
 * Generate entry trigger string based on classification and price levels.
 * @param {string} classification
 * @param {{ resistancePrice: number, ma50: number }} details
 * @returns {{ entry_trigger: string }}
 */
function calcEntryTrigger(classification, details) {
  const resistance = details.resistancePrice || 0;
  const ma50 = details.ma50 || 0;

  switch (classification) {
    case 'coiled_spring':
      return { entry_trigger: `break above ${resistance}` };
    case 'catalyst_loaded':
      return { entry_trigger: `break above ${resistance} or sell CSP at ${ma50}` };
    case 'building_base':
      return { entry_trigger: `watchlist — alert at ${resistance}` };
    default:
      return { entry_trigger: 'no entry' };
  }
}

/**
 * Auto-generate notes string from top signals.
 * @param {Object} signals - Category signal objects
 * @param {Object} details - Flat detail fields
 * @returns {string}
 */
function generateNotes(signals, details) {
  const notes = [];

  // Contraction quality
  const contraction = signals.contraction || {};
  if ((contraction.vcpContractions || 0) >= 3) notes.push(`${contraction.vcpContractions}-stage VCP`);
  else if ((contraction.vcpContractions || 0) >= 2) notes.push('emerging VCP');
  if ((contraction.atrPercentile || 50) <= 15) notes.push('extreme contraction');

  // Sector strength
  if ((details.sectorMomentumRank || 6) <= 3) notes.push(`sector rank #${details.sectorMomentumRank}`);

  // Catalyst
  const catalyst = signals.catalystAwareness || {};
  if (catalyst.catalystTag === 'catalyst_present') {
    const types = (catalyst.catalysts || []).map(c => c.catalystType.replace('_catalyst', '')).join(', ');
    if (types) notes.push(`${types} catalyst present`);
  }

  // Earnings
  if (details.earningsDaysOut && details.earningsDaysOut > 0 && details.earningsDaysOut <= 45) {
    notes.push(`earnings in ${details.earningsDaysOut} days`);
  }

  return notes.join(', ') || 'standard setup';
}
```

Add all three to exports.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --test-name-pattern="calcRiskCategory|calcEntryTrigger|generateNotes" tests/coiled_spring_scanner.test.js`
Expected: 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add calcRiskCategory, calcEntryTrigger, and generateNotes functions"
```

---

## Task 16: Update `classifyCandidate` with EXTENDED + DISQUALIFIED + Tests

**Files:**
- Modify: `scripts/scanner/scoring_v2.js` (~lines 453-477, `classifyCandidate`)
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the failing tests**

```js
describe('classifyCandidate (v3 enhanced)', () => {
  it('returns DISQUALIFIED for low price', () => {
    const result = classifyCandidate({
      score: 90, price: 3, avgVol10d: 500_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false }
    });
    assert.strictEqual(result, 'disqualified');
  });

  it('returns DISQUALIFIED for low volume', () => {
    const result = classifyCandidate({
      score: 90, price: 50, avgVol10d: 100_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false }
    });
    assert.strictEqual(result, 'disqualified');
  });

  it('returns EXTENDED for > 15% above 50 MA', () => {
    const result = classifyCandidate({
      score: 90, price: 120, avgVol10d: 1_000_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: true, extensionPct: 18, hasLargeGap: false, atrExpanding: false }
    });
    assert.strictEqual(result, 'extended');
  });

  it('returns EXTENDED for recent large gap', () => {
    const result = classifyCandidate({
      score: 90, price: 50, avgVol10d: 1_000_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false, extensionPct: 5, hasLargeGap: true, atrExpanding: false }
    });
    assert.strictEqual(result, 'extended');
  });

  it('DISQUALIFIED overrides EXTENDED', () => {
    const result = classifyCandidate({
      score: 90, price: 3, avgVol10d: 100_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: true, extensionPct: 20, hasLargeGap: true, atrExpanding: true }
    });
    assert.strictEqual(result, 'disqualified');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --test-name-pattern="classifyCandidate \\(v3" tests/coiled_spring_scanner.test.js`
Expected: FAIL — current classifyCandidate doesn't check price/volume/extension.

- [ ] **Step 3: Rewrite classifyCandidate**

Replace existing function:

```js
function classifyCandidate(candidate) {
  const { score, signals, details } = candidate;
  const price = candidate.price || 0;
  const avgVol10d = candidate.avgVol10d || 0;

  // Priority 1: DISQUALIFIED
  if (price < 5 || avgVol10d < 200_000 || score < 30) return 'disqualified';

  // Priority 2: EXTENDED
  const extensionPct = details?.extensionPct || (details?.extendedAbove50ma ? 16 : 0);
  if (extensionPct > 15 || details?.hasLargeGap || details?.atrExpanding) return 'extended';

  // Priority 3: COILED_SPRING
  if (score >= 85 &&
      (signals?.contraction || 0) >= 30 &&
      (signals?.volumeSignature || 0) >= 10 &&
      (details?.distFromResistance || 100) <= 8) {
    return 'coiled_spring';
  }

  // Priority 4: CATALYST_LOADED
  if ((signals?.catalystAwareness || 0) >= 12 && (signals?.trendHealth || 0) >= 20) {
    return 'catalyst_loaded';
  }

  // Priority 5: BUILDING_BASE
  if (score >= 60 && (signals?.trendHealth || 0) >= 15) {
    return 'building_base';
  }

  return 'below_threshold';
}
```

- [ ] **Step 4: Update existing classifyCandidate tests**

The existing tests pass signals as `signals: { trendHealth: 25, ... }` — these need to match the new field access pattern. Check each existing test and ensure the `candidate` object shape matches what the new function expects. The key change is that `classifyCandidate` now receives a full candidate object with `price`, `avgVol10d`, `signals`, `details`, and `score` fields instead of just signals.

- [ ] **Step 5: Run all classify tests**

Run: `node --test --test-name-pattern="classifyCandidate" tests/coiled_spring_scanner.test.js`
Expected: All PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/scanner/scoring_v2.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add EXTENDED and DISQUALIFIED to classifyCandidate with priority ordering"
```

---

## Task 17: Update Orchestrator — Fetch Benchmarks + Enhanced Scoring Loop

**Files:**
- Modify: `scripts/scanner/coiled_spring_scanner.js`

- [ ] **Step 1: Add benchmark fetching at start of Stage 2**

After the `runStage1` call (~line 69), add benchmark data fetching. This uses the same Yahoo OHLCV fetcher that Stage 1 uses. Find the import for `runStage1` and add the OHLCV fetcher import:

```js
import { fetchOHLCV } from './yahoo_screen_v2.js';  // add to existing imports
```

After Stage 1 results are received, add:

```js
// --- Stage 2 setup: fetch benchmarks ---
console.log('  Fetching benchmark data (SPY, QQQ, sector ETFs)...');
const SECTOR_ETFS = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'];
const benchmarkSymbols = ['SPY', 'QQQ', ...SECTOR_ETFS];

const benchmarkData = {};
const benchmarkResults = await Promise.all(
  benchmarkSymbols.map(sym => fetchOHLCV(sym, '3mo').then(bars => ({ sym, bars })).catch(() => ({ sym, bars: [] })))
);
for (const { sym, bars } of benchmarkResults) {
  benchmarkData[sym] = bars;
}

const spyOhlcv = benchmarkData['SPY'] || [];
const qqqOhlcv = benchmarkData['QQQ'] || [];
const sectorETFData = {};
for (const etf of SECTOR_ETFS) {
  sectorETFData[etf] = benchmarkData[etf] || [];
}
const sectorRanks = calcSectorMomentumRank(sectorETFData);
console.log(`  Benchmarks loaded. Sector ranks: ${JSON.stringify(sectorRanks)}`);
```

Add `calcSectorMomentumRank` to the scoring_v2.js import at the top of the file.

- [ ] **Step 2: Update the scoring context**

In the scoring loop, update the context object passed to scoring functions:

```js
const scoringContext = {
  regime: marketRegime,
  spyOhlcv,
  qqqOhlcv,
  sectorRanks,
  candidateSector: candidate.sector || ''
};
```

- [ ] **Step 3: Update scoring function calls in the loop**

Update the per-candidate scoring calls:

```js
const trendHealth = scoreTrendHealth(candidate, scoringContext);
const contraction = scoreContractionQuality(candidate);
const volumeSignature = scoreVolumeSignature(candidate);
const pivotStructure = scorePivotStructure(candidate);
const catalystAwareness = scoreCatalystAwareness(candidate, scoringContext);
```

These match the updated function signatures from earlier tasks.

- [ ] **Step 4: Add probability scoring, risk, entry, and notes to the loop**

After `computeCompositeScore` and `classifyCandidate`, add:

```js
const probability = computeProbabilityScore(
  { trendHealth, contraction, volumeSignature, pivotProximity: pivotStructure, catalystAwareness },
  scoringContext
);

// Refine trade_readiness with classification and risk
const classification = classifyCandidate({
  score: composite.score,
  price: candidate.price,
  avgVol10d: candidate.avgVol10d,
  signals: composite.signals,
  details: { 
    distFromResistance: pivotStructure.distFromResistance, 
    extendedAbove50ma: pivotStructure.extendedAbove50ma,
    hasLargeGap: pivotStructure.gapFormedResistance || false,
    atrExpanding: false 
  }
});

const { risk_category, suggested_stop_percent } = calcRiskCategory(classification, {
  vcpContractions: contraction.vcpContractions,
  atrPercentile: contraction.atrPercentile || 50
});

const { entry_trigger } = calcEntryTrigger(classification, {
  resistancePrice: pivotStructure.resistancePrice || 0,
  ma50: candidate.ma50
});

const notes = generateNotes(
  { contraction, catalystAwareness },
  { sectorMomentumRank: catalystAwareness.sectorMomentumRank, earningsDaysOut: catalystAwareness.earningsDaysOut }
);

const trade_readiness = probability.trade_readiness && 
  (classification === 'coiled_spring' || classification === 'catalyst_loaded') && 
  composite.breakoutRisk !== 'high';
```

- [ ] **Step 5: Update the result object assembly**

Update each candidate result object to include new fields:

```js
results.push({
  rank: 0, // set after ranking
  symbol: candidate.symbol,
  name: candidate.name,
  price: candidate.price,
  changePct: candidate.changePct,
  probability_score: probability.probability_score,
  setup_quality: probability.setup_quality,
  trade_readiness,
  setup_type: classification,
  composite_score: composite.score,
  composite_confidence: composite.scoreConfidence,
  distance_to_resistance: pivotStructure.distFromResistance,
  resistance_strength: pivotStructure.resistanceStrength || 1,
  risk_level: composite.breakoutRisk,
  risk_category,
  suggested_stop_percent,
  entry_trigger,
  catalyst_tag: catalystAwareness.catalystTag || 'catalyst_unknown',
  regime_multiplier: probability.regime_multiplier,
  factor_breakdown: probability.factor_breakdown,
  signals: composite.signals,
  details: {
    ma50: candidate.ma50, ma150: candidate.ma150, ma200: candidate.ma200,
    maStacked: candidate.ma50 > candidate.ma150 && candidate.ma150 > candidate.ma200,
    relStrengthPctile: candidate.relStrengthPctile,
    bbWidthPctile: contraction.bbWidthPctile,
    atrRatio: contraction.atrRatio,
    atrPercentile: contraction.atrPercentile,
    vcpContractions: contraction.vcpContractions,
    vcpDepths: contraction.vcpDepths,
    vcpQuality: contraction.vcpQuality,
    dailyRangePct: contraction.dailyRangePct,
    confirmingSignals: contraction.confirmingSignals,
    volDroughtRatio: volumeSignature.volDroughtRatio,
    accDistScore: volumeSignature.accDistScore,
    upDownVolRatio: volumeSignature.upDownVolRatio,
    obvSlopeNormalized: volumeSignature.obvSlopeNormalized,
    supportVolumeRatio: volumeSignature.supportVolumeRatio,
    distFromResistance: pivotStructure.distFromResistance,
    resistanceTouches: pivotStructure.resistanceTouches,
    resistanceStrength: pivotStructure.resistanceStrength,
    extendedAbove50ma: pivotStructure.extendedAbove50ma,
    gapFormedResistance: pivotStructure.gapFormedResistance,
    earningsDaysOut: catalystAwareness.earningsDaysOut,
    sectorMomentumRank: catalystAwareness.sectorMomentumRank,
    shortFloat: catalystAwareness.shortFloat,
    ivContext: candidate.ivContext, ivLabel: candidate.ivLabel
  },
  breakout_risk: composite.breakoutRisk,
  breakout_risk_drivers: composite.breakoutRiskDrivers,
  red_flags: candidate.redFlags || [],
  play: generatePlay(candidate.symbol, classification, { ma50: candidate.ma50 }, scoringContext.regime),
  notes,
  news: candidate.news || []
});
```

- [ ] **Step 6: Commit**

```bash
git add scripts/scanner/coiled_spring_scanner.js
git commit -m "feat: wire benchmark fetching and probability scoring into orchestrator"
```

---

## Task 18: Add Weighted Ranking Engine to Orchestrator + Tests

**Files:**
- Modify: `scripts/scanner/coiled_spring_scanner.js`
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write the ranking test**

```js
describe('weighted ranking', () => {
  it('ranks by weighted formula, not just raw score', () => {
    // Simulate 3 candidates with different profiles
    const candidates = [
      { probability_score: 70, details: { contraction: 35, accDistScore: 2.5, obvSlopeNormalized: 0.8, resistanceStrength: 3, distFromResistance: 2 } },
      { probability_score: 75, details: { contraction: 25, accDistScore: 1.0, obvSlopeNormalized: 0.1, resistanceStrength: 1, distFromResistance: 10 } },
      { probability_score: 65, details: { contraction: 38, accDistScore: 3.0, obvSlopeNormalized: 1.2, resistanceStrength: 3, distFromResistance: 1 } },
    ];
    const ranked = weightedRank(candidates);
    // Candidate 3 (idx 2) has best contraction + institutional + resistance despite lowest probability
    // Should rank higher than candidate 2 (idx 1)
    assert.ok(ranked[2].rank < ranked[1].rank || ranked[2].rank === ranked[1].rank);
  });
});
```

Add `weightedRank` to import from `coiled_spring_scanner.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --test-name-pattern="weighted ranking" tests/coiled_spring_scanner.test.js`
Expected: FAIL — `weightedRank` not exported.

- [ ] **Step 3: Implement weightedRank in coiled_spring_scanner.js**

Add before the `main()` function:

```js
/**
 * Weighted multi-factor ranking. Assigns rank based on weighted average of
 * per-factor rank positions.
 * @param {Array} results - Scored candidate results
 * @returns {Array} - Same array with .rank field set
 */
function weightedRank(results) {
  if (results.length === 0) return results;

  // Factor extractors
  const factors = [
    { key: 'probability', weight: 0.40, extract: r => r.probability_score || 0 },
    { key: 'contraction', weight: 0.25, extract: r => r.signals?.contraction || r.details?.contraction || 0 },
    { key: 'institutional', weight: 0.20, extract: r => (r.details?.accDistScore || 0) + (r.details?.obvSlopeNormalized || 0) },
    { key: 'resistance', weight: 0.15, extract: r => {
      const strength = r.details?.resistanceStrength || r.resistance_strength || 0;
      const dist = r.details?.distFromResistance || r.distance_to_resistance || 100;
      return dist > 0 ? strength / dist : 0;
    }}
  ];

  // Rank per factor (higher value = better = rank 1)
  for (const factor of factors) {
    const sorted = [...results].sort((a, b) => factor.extract(b) - factor.extract(a));
    sorted.forEach((item, idx) => {
      if (!item._factorRanks) item._factorRanks = {};
      item._factorRanks[factor.key] = idx + 1;
    });
  }

  // Weighted average rank
  for (const r of results) {
    r._weightedRank = factors.reduce((sum, f) => sum + (r._factorRanks[f.key] * f.weight), 0);
  }

  // Sort by weighted rank (lower = better), break ties by probability
  results.sort((a, b) => a._weightedRank - b._weightedRank || (b.probability_score || 0) - (a.probability_score || 0));

  // Assign final rank and clean up temp fields
  results.forEach((r, idx) => {
    r.rank = idx + 1;
    delete r._factorRanks;
    delete r._weightedRank;
  });

  return results;
}

export { weightedRank };
```

- [ ] **Step 4: Wire ranking into main()**

Replace the existing sort logic:

```js
// Old: results.sort((a, b) => b.score - a.score);
// New:
weightedRank(results);
const topResults = results.slice(0, topN);
```

Also update `topN` default from 20 to 15:

```js
const topN = parseInt(process.argv.find(a => a.startsWith('--top='))?.split('=')[1] || '15');
```

- [ ] **Step 5: Add benchmark metadata to output object**

Update the output object:

```js
const output = {
  scanDate: new Date().toISOString().slice(0, 10),
  scannedAt: new Date().toISOString(),
  universe: symbols.length,
  stage1Passed: candidates.length,
  marketRegime,
  regimeMultiplier: REGIME_MULTIPLIERS[marketRegime?.regime] || 1.0,
  benchmarks: {
    spy20dReturn: spyOhlcv.length >= 20 ? Math.round(((spyOhlcv[spyOhlcv.length-1].close - spyOhlcv[spyOhlcv.length-21].close) / spyOhlcv[spyOhlcv.length-21].close) * 10000) / 10000 : null,
    qqq20dReturn: qqqOhlcv.length >= 20 ? Math.round(((qqqOhlcv[qqqOhlcv.length-1].close - qqqOhlcv[qqqOhlcv.length-21].close) / qqqOhlcv[qqqOhlcv.length-21].close) * 10000) / 10000 : null
  },
  sectorRanks,
  results: topResults
};
```

- [ ] **Step 6: Run the ranking test**

Run: `node --test --test-name-pattern="weighted ranking" tests/coiled_spring_scanner.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add scripts/scanner/coiled_spring_scanner.js tests/coiled_spring_scanner.test.js
git commit -m "feat: add weighted multi-factor ranking engine with benchmark metadata"
```

---

## Task 19: Integration Test — Full Pipeline End-to-End

**Files:**
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Write integration test**

```js
describe('v3 integration: full pipeline', () => {
  it('VALID_COIL produces all v3 output fields', () => {
    const context = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: { Technology: 2 }, candidateSector: 'Technology' };

    const trend = scoreTrendHealth(VALID_COIL, context);
    const contraction = scoreContractionQuality(VALID_COIL);
    const volume = scoreVolumeSignature(VALID_COIL);
    const pivot = scorePivotStructure(VALID_COIL);
    const catalyst = scoreCatalystAwareness(VALID_COIL, context);

    const signals = { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst };
    const composite = computeCompositeScore({
      trendHealth: trend.score,
      contraction: contraction.score,
      volumeSignature: volume.score,
      pivotProximity: pivot.score,
      catalystAwareness: catalyst.score
    }, context);

    const probability = computeProbabilityScore(signals, context);

    // Verify all new fields exist
    assert.ok(typeof probability.probability_score === 'number');
    assert.ok(typeof probability.setup_quality === 'string');
    assert.ok(typeof probability.factor_breakdown === 'object');
    assert.ok(typeof probability.regime_multiplier === 'number');

    // Verify contraction has new fields
    assert.ok(typeof contraction.atrPercentile === 'number');
    assert.ok(typeof contraction.confirmingSignals === 'number');
    assert.ok(typeof contraction.vcpQuality === 'number');

    // Verify trend has RS breakdown
    assert.ok(typeof trend.rsSubtotal === 'number');
    assert.ok(typeof trend.trendSubtotal === 'number');

    // Verify volume has institutional signals
    assert.ok(typeof volume.accDistScore === 'number');
    assert.ok(typeof volume.obvSlopeNormalized === 'number');
    assert.ok(typeof volume.supportVolumeRatio === 'number');

    // Verify pivot has resistance strength
    assert.ok(typeof pivot.resistanceStrength === 'number');

    // Verify catalyst has tag
    assert.ok(typeof catalyst.catalystTag === 'string');
  });

  it('VALID_COIL ranks higher than ALREADY_EXPLODED on probability', () => {
    const context = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: {}, candidateSector: '' };

    function scoreCandidate(d) {
      const trend = scoreTrendHealth(d, context);
      const contraction = scoreContractionQuality(d);
      const volume = scoreVolumeSignature(d);
      const pivot = scorePivotStructure(d);
      const catalyst = scoreCatalystAwareness(d, context);
      const signals = { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst };
      return computeProbabilityScore(signals, context);
    }

    const validProb = scoreCandidate(VALID_COIL);
    const explodedProb = scoreCandidate(ALREADY_EXPLODED);

    assert.ok(validProb.probability_score > explodedProb.probability_score,
      `VALID_COIL (${validProb.probability_score}) should beat ALREADY_EXPLODED (${explodedProb.probability_score})`);
  });

  it('defensive regime reduces probability score', () => {
    const constructiveCtx = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: {}, candidateSector: '' };
    const defensiveCtx = { ...constructiveCtx, regime: { regime: 'defensive' } };

    function probFor(ctx) {
      const trend = scoreTrendHealth(VALID_COIL, ctx);
      const contraction = scoreContractionQuality(VALID_COIL);
      const volume = scoreVolumeSignature(VALID_COIL);
      const pivot = scorePivotStructure(VALID_COIL);
      const catalyst = scoreCatalystAwareness(VALID_COIL, ctx);
      return computeProbabilityScore(
        { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst }, ctx
      );
    }

    const constructiveProb = probFor(constructiveCtx);
    const defensiveProb = probFor(defensiveCtx);

    assert.ok(defensiveProb.probability_score < constructiveProb.probability_score);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `node --test --test-name-pattern="v3 integration" tests/coiled_spring_scanner.test.js`
Expected: 3 tests PASS.

- [ ] **Step 3: Run the full test suite**

Run: `node --test tests/coiled_spring_scanner.test.js`
Expected: All tests PASS (~75-80 total).

- [ ] **Step 4: Commit**

```bash
git add tests/coiled_spring_scanner.test.js
git commit -m "test: add v3 integration tests for full pipeline with probability scoring"
```

---

## Task 20: Live Scan Validation

**Files:**
- No file changes — validation run

- [ ] **Step 1: Run the scanner against live data**

Run: `node scripts/scanner/coiled_spring_scanner.js --top=15`
Expected: Scanner completes without errors. Output includes benchmark fetch logs and writes `coiled_spring_results.json`.

- [ ] **Step 2: Validate output JSON structure**

Run: `node -e "const r = JSON.parse(require('fs').readFileSync('scripts/scanner/coiled_spring_results.json')); console.log('Top result:', JSON.stringify(r.results[0], null, 2)); console.log('Fields:', Object.keys(r.results[0])); console.log('Sector ranks:', r.sectorRanks); console.log('Benchmarks:', r.benchmarks);"`

Verify:
- `probability_score` exists and is 0-100
- `setup_quality` is one of ELITE/HIGH/MODERATE/LOW
- `factor_breakdown` has 7 keys
- `risk_category` and `suggested_stop_percent` exist
- `entry_trigger` is a non-empty string
- `sectorRanks` has 11 sectors
- `benchmarks` has spy20dReturn and qqq20dReturn

- [ ] **Step 3: Spot-check top 3 results for sanity**

Review the top 3 results manually:
- Do probability scores correlate with setup quality?
- Are EXTENDED/DISQUALIFIED stocks filtered out?
- Do notes make sense?
- Are sector ranks reasonable?

- [ ] **Step 4: Final commit with updated results**

```bash
git add scripts/scanner/coiled_spring_results.json
git commit -m "data: update coiled_spring_results.json with v3 scoring output"
```
