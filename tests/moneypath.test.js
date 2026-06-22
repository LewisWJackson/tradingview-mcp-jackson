/**
 * Money-path tests — the two functions that actually decide buy/sell and grade edge:
 *   scoreBias   (scripts/tasi_screener.mjs) — pure 9-pt swing / 8-pt breakout scorer
 *   gradePending(dashboard/validation.mjs)  — forward excess vs equal-weight basket
 * Run: node --experimental-sqlite --test tests/moneypath.test.js
 * (--experimental-sqlite needed because validation.mjs → db.js opens SQLite.)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scoreBias, computeSeasonality, volumeCheck, detectDivergence, findSRLevels,
  calcMFI, calcOBVTrend, calcVolumeZScore, calcHurst, calcATRPercentileRank, computeStyleTags } from '../scripts/tasi_screener.mjs';
import { tickerDisplay, resolveSignalLabel, computeVelocity, sectorOf, getCritPasses, computeDelta } from '../dashboard/signal_format.mjs';
import { getUpcomingEvents } from '../dashboard/macro.mjs';
import { logSignal, gradePending } from '../dashboard/validation.mjs';
import { buildStatusWhy } from '../dashboard/strategy_validation.mjs';
import { normalizeHeld } from '../scripts/decision.mjs';
import { schemeDExposure, sizingNote, computeTurnover, sarPerName } from '../dashboard/momentum_screen.mjs';
import { annualizedVol, convictionWeights, drawdownBrake } from '../dashboard/compounding_geometry.mjs';
import { windowReturn, abnormalReturn, sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile, mean as peadMean } from '../dashboard/pead.mjs';
import { classifyCounterparty, isContractHeadline } from '../dashboard/contract_flow.mjs';
import { portfolioGuillotine, tstat as gTstat } from '../dashboard/guillotine.mjs';
import { normalizeWeights, computeRebalance, DEFAULT_WEIGHTS } from '../dashboard/allocation.mjs';
import { computeBook, summarize } from '../dashboard/fills.mjs';
import { compareToSnapshot, buildSnapshot } from '../dashboard/tracking.mjs';
import { db, realFills, positions, decisionSnapshots } from '../dashboard/db.js';

// ── scoreBias (pure) ────────────────────────────────────────────────────────
describe('scoreBias — swing mode (9-pt)', () => {
  const ctxBull = { obv_trend: 'rising', vwap20: 108, isTasi: true, avgVolume: 1e6 };

  it('full bull stack → STRONG BUY at max score 9', () => {
    const r = scoreBias(
      { ema13: 110, ema34: 105, ema89: 100, ema200: 90 },
      65, { hist: 0.5, prevHist: 0.2 }, { ratio: 2.0 }, 115, 'swing', null, ctxBull);
    assert.equal(r.bias, 'STRONG BUY');
    assert.equal(r.maxScore, 9);
    assert.equal(r.score, 9);
    assert.equal(r.bullish_score, 9);
  });

  it('full bear stack → STRONG SELL', () => {
    const r = scoreBias(
      { ema13: 90, ema34: 95, ema89: 100, ema200: 110 },
      30, { hist: -0.5, prevHist: -0.2 }, { ratio: 2.0 }, 85, 'swing', null,
      { obv_trend: 'falling', vwap20: 95, isTasi: true, avgVolume: 1e6 });
    assert.equal(r.bias, 'STRONG SELL');
    assert.equal(r.score, 9);
    assert.equal(r.bearish_score, 9);
  });

  it('neutral, nothing aligned → SKIP at score 0', () => {
    const r = scoreBias(
      { ema13: 100, ema34: 100, ema89: 100, ema200: 100 },
      48, { hist: 0, prevHist: 0 }, { ratio: 1.0 }, 100, 'swing', null,
      { obv_trend: 'flat', isTasi: true, avgVolume: 1e6 });
    assert.equal(r.bias, 'SKIP');
    assert.equal(r.score, 0);
  });

  it('null RSI is handled (no points, no throw)', () => {
    const r = scoreBias(
      { ema13: 110, ema34: 105, ema89: 100, ema200: 90 },
      null, { hist: 0.5, prevHist: 0.2 }, { ratio: 2.0 }, 115, 'swing', null, ctxBull);
    // bull = stack2 + ema200_1 + obv1 + macd1 + vol1 + vwap1 = 7 (RSI's 2 pts withheld)
    assert.equal(r.bullish_score, 7);
    assert.equal(r.bias, 'STRONG BUY');
    assert.equal(r.proximity.rsi, null);
  });

  it('volume ratio counts toward whichever side wins, not double-labels direction', () => {
    // identical-EMA neutral but high volume: +1 bull AND +1 bear → tie → SKIP
    const r = scoreBias(
      { ema13: 100, ema34: 100, ema89: 100, ema200: 100 },
      48, { hist: 0, prevHist: 0 }, { ratio: 3.0 }, 100, 'swing', null,
      { obv_trend: 'flat', isTasi: true, avgVolume: 1e6 });
    assert.equal(r.bullish_score, 1);
    assert.equal(r.bearish_score, 1);
    assert.equal(r.bias, 'SKIP');
  });
});

describe('scoreBias — breakout mode (8-pt)', () => {
  it('volume+RS breakout → STRONG BUY at max score 8', () => {
    const r = scoreBias(
      { ema13: 110, ema34: 105, ema89: 100, ema200: 90 },
      60, { hist: 0.5, prevHist: -0.1 }, { ratio: 2.5 }, 115, 'breakout', 5.0,
      { isTasi: true, avgVolume: 1e6 });
    assert.equal(r.maxScore, 8);
    assert.equal(r.bias, 'STRONG BUY');
    assert.equal(r.score, 8);
  });
});

// ── gradePending (DB round-trip, stubbed bars) ──────────────────────────────
describe('gradePending — forward excess vs equal-weight basket', () => {
  const SIG = '__MP_SIG__', BASK = '__MP_BASK__';
  const wipe = () => db.exec(`DELETE FROM signal_outcomes WHERE sym IN ('${SIG}','${BASK}')`);

  // 25 sequential daily bars from 2026-01-01; close = base + step*i
  const mkBars = (n, step) => {
    const out = []; let d = new Date('2026-01-01T00:00:00Z');
    for (let i = 0; i < n; i++) { out.push({ date: d.toISOString().slice(0, 10), close: 100 + step * i }); d = new Date(d.getTime() + 86400000); }
    return out;
  };
  // signal +1/bar, basket +0.5/bar → at h=5: sig 0.05, basket 0.025, excess 0.025
  const barsBySym = { [SIG]: mkBars(25, 1), [BASK]: mkBars(25, 0.5) };
  const getBars = async (s) => barsBySym[s];   // unknown syms → undefined (left pending, untouched)

  before(wipe);
  after(wipe);

  it('grades a signal by excess net of cost and persists the row', async () => {
    wipe();
    logSignal({ sym: SIG, source: 'test', signal_type: 'STRONG_BUY', entry_date: '2026-01-01', entry_price: 100 });
    const res = await gradePending({ getBars, universe: [BASK], cost: 0.001 });
    assert.ok(res.graded >= 3, `expected ≥3 graded, got ${res.graded}`);

    const row = db.prepare(`SELECT * FROM signal_outcomes WHERE sym=? AND horizon=5`).get(SIG);
    assert.ok(row.graded_at, 'row should be graded');
    const approx = (a, b) => Math.abs(a - b) < 1e-6;
    assert.ok(approx(row.signal_ret, 0.05), `signal_ret ${row.signal_ret}`);
    assert.ok(approx(row.basket_ret, 0.025), `basket_ret ${row.basket_ret}`);
    assert.ok(approx(row.excess, 0.025), `excess ${row.excess}`);
    assert.ok(approx(row.excess_net, 0.024), `excess_net ${row.excess_net}`);
  });

  it('signal with no elapsed horizon stays pending (not graded)', async () => {
    wipe();
    // entry beyond the bar range → fwdAt returns null → stays pending
    logSignal({ sym: SIG, source: 'test', signal_type: 'STRONG_BUY', entry_date: '2027-01-01', entry_price: 100 });
    await gradePending({ getBars, universe: [BASK], cost: 0.001 });
    const row = db.prepare(`SELECT * FROM signal_outcomes WHERE sym=? AND horizon=5`).get(SIG);
    assert.equal(row.graded_at, null);
  });
});

// ── schemeDExposure (pure sizing math) ──────────────────────────────────────
describe('schemeDExposure — vol-target × seasonal × state governor', () => {
  it('low vol caps exposure at 1.0 when promoted & in-season', () => {
    // targetVol/realizedVol = 0.15/0.10 = 1.5 → capped to 1 → ×1
    assert.equal(schemeDExposure({ realizedVol: 0.10, targetVol: 0.15, inSeason: true, stateMult: 1 }), 1);
  });
  it('high vol scales exposure down (0.15/0.30 = 0.5)', () => {
    assert.equal(schemeDExposure({ realizedVol: 0.30, targetVol: 0.15, inSeason: true, stateMult: 1 }), 0.5);
  });
  it('weak month forces 0 regardless of vol/state', () => {
    assert.equal(schemeDExposure({ realizedVol: 0.10, targetVol: 0.15, inSeason: false, stateMult: 1 }), 0);
  });
  it('candidate/retired (stateMult 0) forces 0', () => {
    assert.equal(schemeDExposure({ realizedVol: 0.10, targetVol: 0.15, inSeason: true, stateMult: 0 }), 0);
  });
  it('decaying halves the vol-target exposure (0.5 × 0.5)', () => {
    assert.equal(schemeDExposure({ realizedVol: 0.30, targetVol: 0.15, inSeason: true, stateMult: 0.5 }), 0.25);
  });
  it('null realizedVol defaults the vol term to 1 (then × state)', () => {
    assert.equal(schemeDExposure({ realizedVol: null, targetVol: 0.15, inSeason: true, stateMult: 1 }), 1);
  });
});

// ── computeSeasonality (per-month avg daily return %) ────────────────────────
describe('computeSeasonality — monthly average daily return', () => {
  it('separates a +1%/day January from a -2%/day February', () => {
    // The return at index i is labeled by times[i]'s month, so make every
    // Feb-timestamped step the -2% drop (incl. the Jan→Feb boundary step).
    const day = 86400, closes = [100], times = [Date.UTC(2025, 0, 1) / 1000];
    let t = times[0];
    for (let i = 1; i < 15; i++) { t += day; times.push(t); closes.push(closes[i - 1] * 1.01); }   // Jan +1%/day
    let tf = Date.UTC(2025, 1, 1) / 1000;
    for (let i = 0; i < 15; i++) { times.push(tf); closes.push(closes[closes.length - 1] * 0.98); tf += day; } // Feb -2%/day
    const s = computeSeasonality(closes, times);
    assert.equal(s[1], 1);    // January = +1.00%/day
    assert.equal(s[2], -2);   // February = -2.00%/day
  });
});

// ── buildStatusWhy (review #2 — the decaying/retired branches never rendered live) ──
describe('buildStatusWhy — tracks state machine, not the promotion grader', () => {
  const GW = 'net>0, t=3.6>2, stable both halves, 30 periods';
  it('promoted reflects live + grade rationale', () => {
    assert.equal(buildStatusWhy('promoted', GW, null, null), `Live at full Scheme-D sizing — ${GW}.`);
  });
  it('decaying does NOT show the gate-pass text; shows risk-halved + reason', () => {
    const r = buildStatusWhy('decaying', GW, 'rolling-12 weakening', null);
    assert.match(r, /Risk halved \(decaying\)/);
    assert.match(r, /rolling-12 weakening/);
    assert.doesNotMatch(r, /stable both halves/);   // the bug was leaking grade.why here
  });
  it('retired shows retired/0% + reason, not gate-pass text', () => {
    const r = buildStatusWhy('retired', GW, 'drawdown -31% circuit-breaker', null);
    assert.match(r, /Retired, 0% sizing/);
    assert.match(r, /circuit-breaker/);
    assert.doesNotMatch(r, /stable both halves/);
  });
  it('gate-met candidate reads "promote to deploy"', () => {
    assert.match(buildStatusWhy('candidate', GW, null, 'promote'), /Cleared the gate.*promote to deploy/);
  });
  it('plain candidate falls back to grade.why', () => {
    assert.equal(buildStatusWhy('candidate', 'only 10 periods', null, null), 'only 10 periods');
  });
});

// ── sizingNote (review #5 — the seasonal-weak + candidate combo never rendered live) ──
describe('sizingNote — disambiguates the two zero-exposure causes', () => {
  it('not-live in-season → promote-to-go-live message', () => {
    const r = sizingNote({ exposure: 0, exposurePct: 0, stateMult: 0, inSeason: true });
    assert.match(r, /not live yet/);
    assert.match(r, /Promote it in the Lab/);
  });
  it('not-live AND weak month → states both causes + "stays 0% until the weak month passes"', () => {
    const r = sizingNote({ exposure: 0, exposurePct: 0, stateMult: 0, inSeason: false });
    assert.match(r, /not live yet/);
    assert.match(r, /seasonal weak month/);
    assert.match(r, /stays 0% until the weak month passes/);
  });
  it('live strategy, weak month (stateMult 1) → HOLD CASH, not the not-live text', () => {
    const r = sizingNote({ exposure: 0, exposurePct: 0, stateMult: 1, inSeason: false });
    assert.match(r, /HOLD CASH/);
    assert.doesNotMatch(r, /not live yet/);
  });
  it('deployed promoted → put-to-work, no "HALVED"', () => {
    const r = sizingNote({ exposure: 0.6, exposurePct: 60, stateMult: 1, inSeason: true, nHoldings: 5 });
    assert.match(r, /Put 60% of the account to work/);
    assert.doesNotMatch(r, /HALVED/);
  });
  it('deployed decaying (stateMult 0.5) → notes it is HALVED', () => {
    const r = sizingNote({ exposure: 0.3, exposurePct: 30, stateMult: 0.5, inSeason: true, nHoldings: 5 });
    assert.match(r, /HALVED because the strategy is decaying/);
  });
});

// ── volumeCheck (confirmation threshold; TASI 1.2× vs others 1.5×) ───────────
describe('volumeCheck — surge vs 20-day average', () => {
  const flat = Array(19).fill(100);   // 19 bars of 100 → sma20 over last 20
  it('null when fewer than 20 bars', () => {
    assert.deepEqual(volumeCheck([1, 2, 3]), { ratio: null, ok: false });
  });
  it('ratio = last / 20-day SMA, ok at ≥1.5× (non-TASI default)', () => {
    const r = volumeCheck([...flat, 200]);   // sma20 = (19*100+200)/20 = 105, ratio 1.9
    assert.equal(r.ratio, 1.9);
    assert.equal(r.ok, true);
    assert.equal(r.baseThreshold, 1.5);
  });
  it('1.3× clears the TASI 1.2 threshold but NOT the 1.5 default', () => {
    const vols = [...flat, 130];             // sma 101.5, ratio ≈1.28
    assert.equal(volumeCheck(vols, false).ok, false); // 1.5 threshold
    assert.equal(volumeCheck(vols, true).ok, true);   // TASI 1.2 threshold
    assert.equal(volumeCheck(vols, true).baseThreshold, 1.2);
  });
});

// ── detectDivergence (bullish/bearish RSI vs price) ─────────────────────────
describe('detectDivergence — price vs RSI', () => {
  it('null when not enough bars', () => {
    assert.equal(detectDivergence([1, 2, 3], [40, 41, 42]), null);
  });
  // needs ≥ lookback+5 = 35 bars; only the last 30 are split in half (15/15).
  const pad = (x) => Array(5).fill(x);
  it('bullish: price lower-low while RSI higher-low', () => {
    const closes = [...pad(100), ...Array(15).fill(100), ...Array(15).fill(95)];
    const rsi = [...pad(30), ...Array(15).fill(30), ...Array(15).fill(40)];
    assert.equal(detectDivergence(closes, rsi), 'bullish');
  });
  it('bearish: price higher-high while RSI lower-high', () => {
    const closes = [...pad(100), ...Array(15).fill(100), ...Array(15).fill(105)];
    const rsi = [...pad(70), ...Array(15).fill(70), ...Array(15).fill(60)];
    assert.equal(detectDivergence(closes, rsi), 'bearish');
  });
  it('no divergence when price & RSI agree', () => {
    const closes = [...pad(100), ...Array(15).fill(100), ...Array(15).fill(110)];
    const rsi = [...pad(50), ...Array(15).fill(50), ...Array(15).fill(65)];
    assert.equal(detectDivergence(closes, rsi), null);
  });
});

// ── findSRLevels (swing pivots → support/resistance) ────────────────────────
describe('findSRLevels — swing support/resistance', () => {
  it('finds a resistance pivot above price and support below', () => {
    // build a series with a clear swing-high at idx 10 (120) and swing-low at idx 20 (80),
    // ending below the high and above the low so both classify.
    const highs = [], lows = [], closes = [];
    for (let i = 0; i < 31; i++) {
      let h = 100, l = 98;
      if (i === 10) { h = 120; l = 118; }       // swing high
      if (i === 20) { h = 82;  l = 80;  }        // swing low
      highs.push(h); lows.push(l); closes.push(i === 30 ? 100 : (h + l) / 2);
    }
    const sr = findSRLevels(highs, lows, closes, 5);
    assert.ok(sr.resistance.includes(120), `resistance ${JSON.stringify(sr.resistance)}`);
    assert.ok(sr.support.includes(80), `support ${JSON.stringify(sr.support)}`);
  });
  it('separates levels by side of current price', () => {
    const sr = findSRLevels(
      Array(31).fill(100), Array(31).fill(100), Array(31).fill(100), 5);
    // flat series → no pivots that beat neighbors strictly enough on both sides
    assert.deepEqual(sr.support, []);
    assert.deepEqual(sr.resistance, []);
  });
});

// ── calcMFI (money flow index 0-100) ────────────────────────────────────────
describe('calcMFI — money flow index', () => {
  it('null when fewer than period+1 bars', () => {
    assert.equal(calcMFI([1], [1], [1], [1], 14), null);
  });
  it('all-rising typical price → 100 (no negative flow)', () => {
    const n = 16, h = [], l = [], c = [], v = [];
    for (let i = 0; i < n; i++) { c.push(100 + i); h.push(101 + i); l.push(99 + i); v.push(1000); }
    assert.equal(calcMFI(h, l, c, v, 14), 100);
  });
  it('all-falling typical price → 0 (no positive flow)', () => {
    const n = 16, h = [], l = [], c = [], v = [];
    for (let i = 0; i < n; i++) { c.push(100 - i); h.push(101 - i); l.push(99 - i); v.push(1000); }
    assert.equal(calcMFI(h, l, c, v, 14), 0);
  });
});

// ── calcOBVTrend (rising/falling/flat via OBV slope) ────────────────────────
describe('calcOBVTrend — OBV regression slope sign', () => {
  it('null under period+1 bars', () => {
    assert.equal(calcOBVTrend([1, 2], [10, 10], 20), null);
  });
  it('rising prices on volume → rising OBV', () => {
    const c = [], v = [];
    for (let i = 0; i < 25; i++) { c.push(100 + i); v.push(1000); }
    assert.equal(calcOBVTrend(c, v, 20), 'rising');
  });
  it('falling prices on volume → falling OBV', () => {
    const c = [], v = [];
    for (let i = 0; i < 25; i++) { c.push(100 - i); v.push(1000); }
    assert.equal(calcOBVTrend(c, v, 20), 'falling');
  });
});

// ── calcVolumeZScore (latest bar vs baseline) ───────────────────────────────
describe('calcVolumeZScore — latest volume vs 20-day baseline', () => {
  it('null under period+1 bars', () => {
    assert.equal(calcVolumeZScore([1, 2, 3], 20), null);
  });
  it('0 when baseline has no variance', () => {
    assert.equal(calcVolumeZScore([...Array(20).fill(100), 100], 20), 0);
  });
  it('positive z when latest spikes above a varied baseline', () => {
    const base = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 10 : -10)); // mean 100, std 10
    const z = calcVolumeZScore([...base, 130], 20);
    assert.ok(z > 0, `z=${z}`);
  });
});

// ── calcHurst (0-1 persistence exponent) ────────────────────────────────────
describe('calcHurst — Hurst exponent', () => {
  it('null when fewer than 50 bars', () => {
    assert.equal(calcHurst(Array.from({ length: 40 }, (_, i) => 100 + i)), null);
  });
  it('returns a value in [0,1] for a trending series', () => {
    const c = Array.from({ length: 200 }, (_, i) => 100 * Math.pow(1.001, i)); // steady uptrend
    const h = calcHurst(c);
    assert.ok(h >= 0 && h <= 1, `h=${h}`);
  });
});

// ── calcATRPercentileRank (0-100 where current ATR sits) ────────────────────
describe('calcATRPercentileRank — ATR percentile', () => {
  it('null when fewer than period+1 bars', () => {
    assert.equal(calcATRPercentileRank([1], [1], [1], 14, 252), null);
  });
  it('expanding range → current ATR near the top (high rank)', () => {
    const n = 60, h = [], l = [], c = [];
    for (let i = 0; i < n; i++) { const w = 1 + i * 0.2; c.push(100); h.push(100 + w); l.push(100 - w); }
    const r = calcATRPercentileRank(h, l, c, 14, 252);
    assert.ok(r >= 90, `rank=${r}`);
  });
});

// ── computeStyleTags (Momentum/Trend/Breakout/Recovery/Pullback) ────────────
describe('computeStyleTags — setup classification', () => {
  it('bearish bias yields no bull tags', () => {
    assert.deepEqual(computeStyleTags({ bias: 'STRONG SELL', rsi: 60 }), []);
  });
  it('tags Momentum on RSI/MACD/vol/score', () => {
    const tags = computeStyleTags({ bias: 'BUY', rsi: 60, macd_hist: 0.5, vol_ratio: 1.6, score: 7,
      emas: { ema13: 1, ema34: 1, ema89: 1, ema200: 1 }, price: 1 });
    assert.ok(tags.includes('Momentum'), JSON.stringify(tags));
  });
  it('tags Trend on EMA stack above 200 with trending Hurst', () => {
    const tags = computeStyleTags({ bias: 'BUY', rsi: 50, macd_hist: 0, vol_ratio: 1, score: 5,
      emas: { ema13: 110, ema34: 105, ema89: 100, ema200: 90 }, price: 115, hurst: 0.6 });
    assert.ok(tags.includes('Trend'), JSON.stringify(tags));
  });
  it('caps at 2 tags', () => {
    const tags = computeStyleTags({ bias: 'BUY', rsi: 60, macd_hist: 0.5, vol_ratio: 2.5, score: 8,
      emas: { ema13: 110, ema34: 105, ema89: 100, ema200: 90 }, price: 115, hurst: 0.6, rs_score: 2.0,
      rsi_buildup: { is_building: true } });
    assert.ok(tags.length <= 2, JSON.stringify(tags));
  });
});

// ════════════════ Extracted server helpers (signal_format.mjs, macro.mjs) ════════════════

describe('tickerDisplay — strip exchange prefix', () => {
  it('strips EXCHANGE: prefix', () => assert.equal(tickerDisplay('TADAWUL:1120'), '1120'));
  it('passes through a bare symbol', () => assert.equal(tickerDisplay('AAPL'), 'AAPL'));
});

describe('resolveSignalLabel — context-aware STRONG SELL', () => {
  it('non-STRONG-SELL passes through unchanged', () => {
    assert.equal(resolveSignalLabel('BUY', 'bull', false), 'BUY');
    assert.equal(resolveSignalLabel('STRONG BUY', 'bear', true), 'STRONG BUY');
  });
  it('holding + bear → EXIT NOW', () => assert.equal(resolveSignalLabel('STRONG SELL', 'bear', true), 'EXIT NOW'));
  it('holding + non-bear → EXIT', () => assert.equal(resolveSignalLabel('STRONG SELL', 'bull', true), 'EXIT'));
  it('not holding + bear → AVOID', () => assert.equal(resolveSignalLabel('STRONG SELL', 'bear', false), 'AVOID'));
  it('not holding + non-bear → SKIP', () => assert.equal(resolveSignalLabel('STRONG SELL', 'neutral', false), 'SKIP'));
});

describe('computeVelocity — 3-scan slope', () => {
  it('rising scores → rising', () => {
    const r = computeVelocity([{ s: 1 }, { s: 2 }, { s: 3 }]);
    assert.equal(r.direction, 'rising'); assert.ok(r.slope >= 0.5);
  });
  it('falling scores → falling', () => {
    const r = computeVelocity([{ s: 3 }, { s: 2 }, { s: 1 }]);
    assert.equal(r.direction, 'falling'); assert.ok(r.slope <= -0.5);
  });
  it('flat → stable', () => assert.deepEqual(computeVelocity([{ s: 5 }, { s: 5 }]), { slope: 0, direction: 'stable' }));
  it('<2 points → stable, slope 0', () => assert.deepEqual(computeVelocity([{ s: 4 }]), { slope: 0, direction: 'stable' }));
});

describe('sectorOf — TASI code-range classifier', () => {
  it('banking range', () => assert.equal(sectorOf('1120'), 'Banking'));
  it('energy (Aramco 2222)', () => assert.equal(sectorOf('2222'), 'Energy'));
  it('telecom & tech range', () => assert.equal(sectorOf('7010'), 'Telecom & Tech'));
  it('cement range', () => assert.equal(sectorOf('3010'), 'Cement'));
  it('crypto by name', () => assert.equal(sectorOf('BINANCE:BTCUSDT'), 'Crypto'));
  it('US equity fallback (no digits)', () => assert.equal(sectorOf('AAPL'), 'US Equity'));
});

describe('getCritPasses — bull vs bear criteria', () => {
  const bull = { bias: 'BUY', emas: { ema13: 110, ema34: 105, ema89: 100, ema200: 90 }, price: 115, rsi: 60, macd_hist: 0.5, vol_ratio: 2.0, above_vwap: true };
  const bear = { bias: 'SELL', emas: { ema13: 90, ema34: 95, ema89: 100, ema200: 110 }, price: 85, rsi: 35, macd_hist: -0.5, vol_ratio: 2.0, above_vwap: false };
  it('full bull setup passes every bull criterion', () => {
    const c = getCritPasses(bull);
    assert.deepEqual(c, { emaStack: true, ema200: true, rsi: true, macd: true, vol: true, vwap: true });
  });
  it('full bear setup passes every bear criterion (mirrored)', () => {
    const c = getCritPasses(bear);
    assert.deepEqual(c, { emaStack: true, ema200: true, rsi: true, macd: true, vol: true, vwap: true });
  });
  it('low volume fails the vol gate', () => assert.equal(getCritPasses({ ...bull, vol_ratio: 1.0 }).vol, false));
});

describe('computeDelta — scan-to-scan change detection', () => {
  const emas = { ema13: 110, ema34: 105, ema89: 100, ema200: 90 };
  const base = { emas, price: 115, rsi: 60, macd_hist: 0.5, vol_ratio: 2.0, above_vwap: true };
  it('no previous results → empty', () => { assert.deepEqual(computeDelta([{ sym: 'X', ...base, bias: 'BUY', score: 6 }], [], {}), []); });
  it('unchanged bias+score → excluded', () => {
    const cur = [{ sym: 'X', name: 'X', ...base, bias: 'BUY', score: 6 }];
    const prev = [{ sym: 'X', name: 'X', ...base, bias: 'BUY', score: 6 }];
    assert.deepEqual(computeDelta(cur, prev, {}), []);
  });
  it('improved bias is reported with positive delta + direction improved', () => {
    const cur = [{ sym: 'X', name: 'X', ...base, bias: 'BUY', score: 6 }];
    const prev = [{ sym: 'X', name: 'X', ...base, bias: 'WATCH', score: 4 }];
    const d = computeDelta(cur, prev, {});
    assert.equal(d.length, 1);
    assert.equal(d[0].direction, 'improved');
    assert.equal(d[0].score_delta, 2);
  });
  it('a symbol absent from prev is skipped', () => {
    const cur = [{ sym: 'NEW', name: 'NEW', ...base, bias: 'BUY', score: 6 }];
    const prev = [{ sym: 'OTHER', name: 'OTHER', ...base, bias: 'BUY', score: 6 }];
    assert.deepEqual(computeDelta(cur, prev, {}), []);
  });
  it('results sorted by absolute score delta desc', () => {
    const cur = [
      { sym: 'A', name: 'A', ...base, bias: 'BUY', score: 5 },
      { sym: 'B', name: 'B', ...base, bias: 'STRONG BUY', score: 9 },
    ];
    const prev = [
      { sym: 'A', name: 'A', ...base, bias: 'WATCH', score: 4 },   // delta 1
      { sym: 'B', name: 'B', ...base, bias: 'WATCH', score: 3 },   // delta 6
    ];
    const d = computeDelta(cur, prev, {});
    assert.equal(d[0].sym, 'B');   // bigger abs delta first
    assert.equal(d[1].sym, 'A');
  });
});

describe('getUpcomingEvents — date-window filter', () => {
  it('returns only events within [today, today+days], sorted ascending', () => {
    const days = 400;
    const nowKSA = new Date(Date.now() + 3 * 3600 * 1000);
    const todayStr = nowKSA.toISOString().slice(0, 10);
    const endStr = new Date(nowKSA.getTime() + days * 86400 * 1000).toISOString().slice(0, 10);
    const ev = getUpcomingEvents(days);
    for (const e of ev) { assert.ok(e.date >= todayStr && e.date <= endStr, `out of window: ${e.date}`); }
    const dates = ev.map(e => e.date);
    assert.deepEqual(dates, [...dates].sort((a, b) => a.localeCompare(b)));
  });
  it('a wider window returns at least as many events as a narrow one', () => {
    assert.ok(getUpcomingEvents(400).length >= getUpcomingEvents(7).length);
  });
});

// ── compounding_geometry sizing levers (pure) ─────────────────────────────────
describe('compounding_geometry levers', () => {
  // annualizedVol: stdev of daily returns × sqrt(252)
  it('annualizedVol scales daily stdev by sqrt(252)', () => {
    assert.equal(annualizedVol([0.01, 0.01, 0.01]), 0); // zero stdev → zero vol
    const v = annualizedVol([0.01, -0.01]); // sample-stdev 0.0141421 × sqrt(252) ≈ 0.2245
    assert.ok(Math.abs(v - 0.2245) < 0.01, `got ${v}`);
  });
  it('annualizedVol returns null for <2 points', () => {
    assert.equal(annualizedVol([]), null);
    assert.equal(annualizedVol([0.01]), null);
  });

  it('convictionWeights sum to 1 and favor higher momentum', () => {
    // cap 0.5 is feasible for 3 names (0.5×3=1.5≥1) so rank-linear applies
    const w = convictionWeights([0.30, 0.10, 0.20], { maxWeight: 0.5 }); // best idx0, worst idx1
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
    assert.ok(w[0] > w[2] && w[2] > w[1], `expected w0>w2>w1, got ${w}`);
  });
  it('convictionWeights respects maxWeight cap', () => {
    const w = convictionWeights([10, 1, 1, 1, 1], { maxWeight: 0.25 });
    assert.ok(Math.max(...w) <= 0.25 + 1e-9, `max=${Math.max(...w)}`);
    assert.ok(Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });
  it('convictionWeights falls back to equal weight when cap is infeasible', () => {
    const w = convictionWeights([3, 2, 1], { maxWeight: 0.25 }); // 3×0.25=0.75<1
    assert.ok(w.every(x => Math.abs(x - 1 / 3) < 1e-9), `got ${w}`);
  });
  it('convictionWeights handles 0 and 1 names', () => {
    assert.deepEqual(convictionWeights([]), []);
    assert.deepEqual(convictionWeights([0.5]), [1]);
  });

  it('drawdownBrake trips below -threshold and halves exposure', () => {
    const r = drawdownBrake({ eq: 0.80, peak: 1.0, braked: false, threshold: 0.15 });
    assert.equal(r.braked, true);
    assert.equal(r.mult, 0.5);
  });
  it('drawdownBrake stays off above -threshold', () => {
    const r = drawdownBrake({ eq: 0.90, peak: 1.0, braked: false, threshold: 0.15 });
    assert.equal(r.braked, false);
    assert.equal(r.mult, 1);
  });
  it('drawdownBrake releases only after recovering past -threshold*recoverFrac', () => {
    const a = drawdownBrake({ eq: 0.88, peak: 1.0, braked: true, threshold: 0.15, recoverFrac: 0.5 });
    assert.equal(a.braked, true); // -12% still below -7.5% release line
    const b = drawdownBrake({ eq: 0.95, peak: 1.0, braked: true, threshold: 0.15, recoverFrac: 0.5 });
    assert.equal(b.braked, false); // -5% above release line
    assert.equal(b.mult, 1);
  });
});

// ── index_flow helpers (pure) ─────────────────────────────────────────────────
describe('index_flow helpers', () => {
  it('windowReturn computes simple return over an index window', () => {
    const c = [100, 110, 121];
    assert.ok(Math.abs(windowReturn(c, 0, 2) - 0.21) < 1e-9, `got ${windowReturn(c, 0, 2)}`);
    assert.equal(windowReturn(c, 0, 0), 0);
  });
  it('windowReturn returns null on bad bounds or non-positive prices', () => {
    assert.equal(windowReturn([0, 110, 121], 0, 2), null); // zero endpoint price
    assert.equal(windowReturn([100], 0, 3), null);          // out of range
  });
  it('abnormalReturn = name return minus benchmark return over the same window', () => {
    const name = [100, 130], bench = [100, 110]; // +30% vs +10%
    assert.ok(Math.abs(abnormalReturn(name, bench, 0, 1) - 0.20) < 1e-9, `got ${abnormalReturn(name, bench, 0, 1)}`);
  });
  it('abnormalReturn returns null if either leg is unavailable', () => {
    assert.equal(abnormalReturn([100, 130], [100], 0, 1), null);
  });
  it('sliceByDate finds the index on-or-after a target date', () => {
    const dates = ['2024-01-01', '2024-01-03', '2024-01-05'];
    assert.equal(sliceByDate(dates, '2024-01-03'), 1);   // exact
    assert.equal(sliceByDate(dates, '2024-01-02'), 1);   // next on-or-after
    assert.equal(sliceByDate(dates, '2024-01-06'), -1);  // past end
    assert.equal(sliceByDate(dates, '2023-12-31'), 0);   // before start → first
  });
});

// ── pead helpers (pure) ───────────────────────────────────────────────────────
describe('pead helpers', () => {
  it('quantileBreakpoints returns 4 ascending cut points', () => {
    const bp = quantileBreakpoints([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    assert.equal(bp.length, 4);
    for (let i = 1; i < bp.length; i++) assert.ok(bp[i] >= bp[i - 1], `not ascending: ${bp}`);
  });
  it('assignQuintile buckets by breakpoints', () => {
    const bp = [2, 4, 6, 8]; // 5 buckets: <=2 | <=4 | <=6 | <=8 | >8
    assert.equal(assignQuintile(1, bp), 0);
    assert.equal(assignQuintile(2, bp), 0);   // boundary lands in lower bucket
    assert.equal(assignQuintile(3, bp), 1);
    assert.equal(assignQuintile(7, bp), 3);
    assert.equal(assignQuintile(9, bp), 4);
  });
  it('assignQuintile spans all 5 buckets across a sample', () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const bp = quantileBreakpoints(vals);
    const buckets = new Set(vals.map(v => assignQuintile(v, bp)));
    assert.ok(buckets.size === 5, `expected 5 buckets, got ${[...buckets]}`);
  });
  it('mean averages a numeric array, NaN on empty', () => {
    assert.equal(peadMean([2, 4, 6]), 4);
    assert.ok(Number.isNaN(peadMean([])));
  });
});

// ── contract_flow helpers (pure) ──────────────────────────────────────────────
describe('contract_flow helpers', () => {
  it('classifyCounterparty tags government/SOE/Vision-2030 counterparties', () => {
    assert.equal(classifyCounterparty('Arabian Pipes Co. Announces Contracts Sign Off with Saudi Aramco'), 'govt');
    assert.equal(classifyCounterparty('Itmam Consultancy Co. Announces Project Award with Riyadh Region Municipality'), 'govt');
    assert.equal(classifyCounterparty('SRMG announces the award of a contract by the Ministry of Culture'), 'govt');
    assert.equal(classifyCounterparty('Anmat Technology received a purchase order from Saudi Electricity Company'), 'govt');
    assert.equal(classifyCounterparty('Co. announces a contract with NEOM Company'), 'govt');
  });
  it('classifyCounterparty tags private counterparties as private', () => {
    assert.equal(classifyCounterparty('Group Five Pipe Saudi Co. Announces Contract Sign Off with Esnad Al Turuq Contracting Company'), 'private');
    assert.equal(classifyCounterparty('Saudi Parts Center Co. Announces receipt of a purchase order from Al-Khorayef Industries'), 'private');
  });
  it('isContractHeadline keeps real awards, drops misfiled rows', () => {
    assert.equal(isContractHeadline('Arabian Pipes Co. Announces Contracts Sign Off with Saudi Aramco'), true);
    assert.equal(isContractHeadline('Wajd Life Trading Co. Announces Project Award with Majmaah University'), true);
    assert.equal(isContractHeadline('Atlas Elevators announces its Annual Financial results for the period ending'), false);
    assert.equal(isContractHeadline("Almuneef Company Announces the Board's Recommendation to Increase Capital"), false);
  });
  it('classifyCounterparty defaults to private on empty/null/undefined', () => {
    assert.equal(classifyCounterparty(''), 'private');
    assert.equal(classifyCounterparty(null), 'private');
    assert.equal(classifyCounterparty(undefined), 'private');
  });
  it('classifyCounterparty is case-insensitive', () => {
    assert.equal(classifyCounterparty('CONTRACT WITH SAUDI ARAMCO'), 'govt');
    assert.equal(classifyCounterparty('contract with neom company'), 'govt');
  });
  it('space-padded terms (PIF, SAR) match as standalone words, not substrings', () => {
    // ' pif' / 'sar ' are deliberately space-bounded to avoid false hits inside other words.
    assert.equal(classifyCounterparty('Co. announces an award from the PIF for a project'), 'govt'); // " pif " → matches " pif"
    assert.equal(classifyCounterparty('Award from SAR for a rail link'), 'govt');                     // "sar " (Saudi Arabia Railways)
    assert.equal(classifyCounterparty('Spife Trading Co. wins a private order'), 'private');           // contains "pif" but not " pif"
    assert.equal(classifyCounterparty('Sars Medical Co. signs a deal'), 'private');                    // contains "sar" but not "sar "
  });
  it('isContractHeadline returns false on empty/null and is case-insensitive', () => {
    assert.equal(isContractHeadline(''), false);
    assert.equal(isContractHeadline(null), false);
    assert.equal(isContractHeadline('CO. ANNOUNCES A TENDER WIN'), true);
    assert.equal(isContractHeadline('Co. announces a PURCHASE ORDER receipt'), true);
  });
});

// ── portfolioGuillotine: the shared "validated" gate ──────────────────────────
describe('portfolioGuillotine gate', () => {
  const alt = (a, b, pairs) => Array.from({ length: pairs * 2 }, (_, i) => i % 2 ? b : a);
  it('tstat sign + magnitude on a tight positive series', () => {
    const t = gTstat(alt(0.008, 0.012, 20));   // mean 0.01, small sd
    assert.ok(t > 10, `expected large positive t, got ${t}`);
  });
  it('PASS: positive mean, t>2, enough periods', () => {
    const v = portfolioGuillotine(alt(0.008, 0.012, 20));
    assert.equal(v.pass, true);
    assert.ok(v.t > 2);
    assert.ok(v.excessPerPeriod > 0);
    assert.equal(v.periods, 40);
  });
  it('FAIL: zero-mean noise (t≈0)', () => {
    const v = portfolioGuillotine(alt(0.05, -0.05, 20));
    assert.equal(v.pass, false);
    assert.match(v.reason, /t .*≤ 2|not positive/);
  });
  it('FAIL: positive mean but insignificant (high variance, t<2)', () => {
    const v = portfolioGuillotine(alt(0.1, -0.09, 20));   // mean +0.005, huge sd
    assert.equal(v.pass, false);
    assert.ok(v.excessPerPeriod > 0);
    assert.ok(v.t < 2);
  });
  it('FAIL: negative mean', () => {
    const v = portfolioGuillotine(alt(-0.008, -0.012, 20));
    assert.equal(v.pass, false);
    assert.match(v.reason, /not positive/);
  });
  it('FAIL: too few periods (underpowered)', () => {
    const v = portfolioGuillotine([0.02, 0.02, 0.02]);   // < minPeriods 12
    assert.equal(v.pass, false);
    assert.match(v.reason, /underpowered/);
  });
  it('FAIL: relative-only (excess significant but absolute negative)', () => {
    const v = portfolioGuillotine(alt(0.008, 0.012, 20), { abs: Array(40).fill(-0.005) });
    assert.equal(v.pass, false);
    assert.match(v.reason, /relative-only/);
  });
  it('FAIL: does not beat its control', () => {
    const v = portfolioGuillotine(alt(0.008, 0.012, 20), { controlExcess: Array(40).fill(0.02) });
    assert.equal(v.pass, false);
    assert.equal(v.beatsControl, false);
    assert.match(v.reason, /beat its control/);
  });
});

// ── momentum decision helpers (pure) ──────────────────────────────────────────
describe('momentum decision helpers', () => {
  it('partitions buy/hold/sell against held positions', () => {
    const picks = ['TADAWUL:1120', 'TADAWUL:2222', 'TADAWUL:7203'];
    const held = ['TADAWUL:2222', 'TADAWUL:9999']; // hold 2222, own 9999 (no longer a pick)
    const t = computeTurnover(picks, held);
    assert.deepEqual(t.buy, ['TADAWUL:1120', 'TADAWUL:7203']);
    assert.deepEqual(t.hold, ['TADAWUL:2222']);
    assert.deepEqual(t.sell, ['TADAWUL:9999']);
  });
  it('empty held → everything is a buy, nothing to sell', () => {
    const t = computeTurnover(['TADAWUL:1120', 'TADAWUL:2222'], []);
    assert.deepEqual(t.buy, ['TADAWUL:1120', 'TADAWUL:2222']);
    assert.deepEqual(t.hold, []);
    assert.deepEqual(t.sell, []);
  });
  it('preserves pick order in buy/hold and handles empty picks', () => {
    assert.deepEqual(computeTurnover([], ['TADAWUL:1120']).sell, ['TADAWUL:1120']);
    assert.deepEqual(computeTurnover([], []), { buy: [], hold: [], sell: [] });
  });
  it('sarPerName splits the deployed fraction across holdings', () => {
    const r = sarPerName({ accountSize: 100000, exposurePct: 80, nHoldings: 4 });
    assert.equal(r.perName, 20000);
    assert.equal(r.totalDeployed, 80000);
    assert.equal(r.cash, 20000);
  });
  it('sarPerName handles 0 holdings and 0 exposure', () => {
    assert.deepEqual(sarPerName({ accountSize: 100000, exposurePct: 80, nHoldings: 0 }), { perName: 0, totalDeployed: 0, cash: 100000 });
    assert.deepEqual(sarPerName({ accountSize: 50000, exposurePct: 0, nHoldings: 5 }), { perName: 0, totalDeployed: 0, cash: 50000 });
  });
});

describe('decision --held normalization', () => {
  it('prefixes bare 4-digit codes to TADAWUL:xxxx', () => {
    assert.deepEqual(normalizeHeld('1120,2222'), ['TADAWUL:1120', 'TADAWUL:2222']);
  });
  it('passes through already-prefixed symbols unchanged', () => {
    assert.deepEqual(normalizeHeld('TADAWUL:1120,2222'), ['TADAWUL:1120', 'TADAWUL:2222']);
  });
  it('trims whitespace and drops empty entries', () => {
    assert.deepEqual(normalizeHeld(' 1120 , , 2222 ,'), ['TADAWUL:1120', 'TADAWUL:2222']);
  });
  it('leaves non-4-digit tokens (5-digit, non-numeric) as-is', () => {
    assert.deepEqual(normalizeHeld('12340,AAPL'), ['12340', 'AAPL']);
  });
  it('returns [] for empty / null input', () => {
    assert.deepEqual(normalizeHeld(''), []);
    assert.deepEqual(normalizeHeld(null), []);
  });
  it('feeds computeTurnover end-to-end: bare codes resolve to BUY/HOLD/SELL', () => {
    const picks = ['TADAWUL:2200', 'TADAWUL:2222', 'TADAWUL:1321'];
    const held = normalizeHeld('2222,9999');            // 2222 held & picked → HOLD; 9999 held, not picked → SELL
    const t = computeTurnover(picks, held);
    assert.deepEqual(t.hold, ['TADAWUL:2222']);
    assert.deepEqual(t.sell, ['TADAWUL:9999']);
    assert.deepEqual(t.buy, ['TADAWUL:2200', 'TADAWUL:1321']);
  });
});

describe('allocation policy', () => {
  const pick = (sleeves, k) => sleeves.find(s => s.key === k);

  it('normalizeWeights clamps negatives and renormalizes to 1', () => {
    const w = normalizeWeights({ tasi_momentum: 1, us_sharia: -5, gold: 1 });
    assert.equal(w.us_sharia, 0);                       // negative clamped to 0
    assert.ok(Math.abs(w.tasi_momentum + w.us_sharia + w.gold - 1) < 1e-9);
    assert.ok(Math.abs(w.tasi_momentum - 0.5) < 1e-9);  // 1 of {1,0,1} → 0.5
    assert.ok(Math.abs(w.gold - 0.5) < 1e-9);
  });

  it('normalizeWeights scales arbitrary positive weights to sum 1', () => {
    const w = normalizeWeights({ tasi_momentum: 50, us_sharia: 30, gold: 20 });
    assert.ok(Math.abs(w.tasi_momentum - 0.5) < 1e-9);
    assert.ok(Math.abs(w.us_sharia - 0.3) < 1e-9);
    assert.ok(Math.abs(w.gold - 0.2) < 1e-9);
  });

  it('normalizeWeights falls back to defaults when all weights are <= 0', () => {
    assert.deepEqual(normalizeWeights({ tasi_momentum: 0, us_sharia: 0, gold: 0 }), DEFAULT_WEIGHTS);
    assert.deepEqual(normalizeWeights({}), DEFAULT_WEIGHTS);
  });

  it('computeRebalance: 50/30/20 on a 100k all-in-TASI book → SELL 50k TASI, BUY 30k US, BUY 20k gold', () => {
    const r = computeRebalance({
      values: { tasi_momentum: 100000, us_sharia: 0, gold: 0 },
      weights: DEFAULT_WEIGHTS,
    });
    assert.equal(r.total, 100000);
    const tasi = pick(r.sleeves, 'tasi_momentum');
    const us   = pick(r.sleeves, 'us_sharia');
    const gold = pick(r.sleeves, 'gold');
    assert.equal(tasi.action, 'SELL'); assert.equal(tasi.amount, 50000);
    assert.equal(us.action, 'BUY');    assert.equal(us.amount, 30000);
    assert.equal(gold.action, 'BUY');  assert.equal(gold.amount, 20000);
    assert.equal(tasi.targetValue, 50000);
    assert.ok(Math.abs(tasi.currentPct - 1) < 1e-9);
  });

  it('computeRebalance: HOLD when each sleeve is on-target within 0.5%', () => {
    const r = computeRebalance({
      values: { tasi_momentum: 50000, us_sharia: 30000, gold: 20000 },
      weights: DEFAULT_WEIGHTS,
    });
    assert.equal(r.total, 100000);
    for (const s of r.sleeves) {
      assert.equal(s.action, 'HOLD');
      assert.equal(s.amount, 0);
    }
    assert.ok(r.maxDriftPct < 0.5);
  });

  it('computeRebalance: a drift inside the 0.5% band stays HOLD, just outside flips to action', () => {
    // total 100000, band = 500 SAR. TASI off by 400 → HOLD; off by 600 → BUY.
    const inBand = computeRebalance({
      values: { tasi_momentum: 49600, us_sharia: 30000, gold: 20000 },
      weights: DEFAULT_WEIGHTS,
    });
    // total is 99600 here; recompute uses that total — assert TASI delta < band
    const tasiIn = pick(inBand.sleeves, 'tasi_momentum');
    assert.ok(Math.abs(tasiIn.delta) < inBand.total * 0.005);
    assert.equal(tasiIn.action, 'HOLD');
  });

  it('computeRebalance: total=0 → targets shown, no BUY/SELL actions', () => {
    const r = computeRebalance({
      values: { tasi_momentum: 0, us_sharia: 0, gold: 0 },
      weights: DEFAULT_WEIGHTS,
    });
    assert.equal(r.total, 0);
    for (const s of r.sleeves) {
      assert.equal(s.action, 'HOLD');
      assert.equal(s.amount, 0);
      assert.equal(s.currentPct, 0);
      assert.equal(s.targetValue, 0);
    }
    assert.equal(pick(r.sleeves, 'tasi_momentum').targetPct, 0.5);
  });

  it('computeRebalance: defaults to DEFAULT_WEIGHTS and empty values', () => {
    const r = computeRebalance();
    assert.equal(r.total, 0);
    assert.equal(r.sleeves.length, 3);
    assert.equal(pick(r.sleeves, 'gold').targetPct, 0.2);
  });
});

// ── Fill ledger book math (pure) ────────────────────────────────────────────
describe('computeBook — real fill ledger', () => {
  it('single buy → open position at exact cost (no fees)', () => {
    const b = computeBook([{ sym: 'X', action: 'buy', shares: 100, price: 10 }]);
    assert.equal(b.open.length, 1);
    assert.equal(b.open[0].shares, 100);
    assert.equal(b.open[0].avgCost, 10);
    assert.equal(b.open[0].costBasis, 1000);
    assert.equal(b.realized, 0);
  });

  it('buy fees fold into cost basis → avgCost rises', () => {
    const b = computeBook([{ sym: 'X', action: 'buy', shares: 100, price: 10, fees: 5 }]);
    assert.equal(b.open[0].costBasis, 1005);
    assert.equal(b.open[0].avgCost, 10.05);
  });

  it('two buys → weighted-average cost', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy', shares: 100, price: 10 },
      { sym: 'X', action: 'buy', shares: 100, price: 20 },
    ]);
    assert.equal(b.open[0].shares, 200);
    assert.equal(b.open[0].avgCost, 15);
  });

  it('partial sell → realized P&L on the sold lot, remainder stays open', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy',  shares: 100, price: 10 },
      { sym: 'X', action: 'sell', shares: 40,  price: 15 },
    ]);
    // 40 * (15 - 10) = 200 realized
    assert.equal(b.realized, 200);
    assert.equal(b.open[0].shares, 60);
    assert.equal(b.open[0].avgCost, 10);      // avg cost unchanged by a sell
    assert.equal(b.open[0].costBasis, 600);
  });

  it('sell fees reduce proceeds', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy',  shares: 100, price: 10 },
      { sym: 'X', action: 'sell', shares: 100, price: 15, fees: 10 },
    ]);
    // 100*15 - 10 fee - 100*10 cost = 1500 - 10 - 1000 = 490
    assert.equal(b.realized, 490);
    assert.equal(b.open.length, 0);            // fully closed
  });

  it('full sell closes the position (zeroed, not open)', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy',  shares: 100, price: 10 },
      { sym: 'X', action: 'sell', shares: 100, price: 12 },
    ]);
    assert.equal(b.open.length, 0);
    assert.equal(b.realized, 200);
    assert.equal(b.positions.X.shares, 0);
  });

  it('oversell is clamped to held shares (no negative position)', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy',  shares: 100, price: 10 },
      { sym: 'X', action: 'sell', shares: 999, price: 12 },
    ]);
    assert.equal(b.open.length, 0);
    assert.equal(b.realized, 200);             // only the 100 held are sold
    assert.equal(b.positions.X.shares, 0);
  });

  it('independent syms tracked separately', () => {
    const b = computeBook([
      { sym: 'A', action: 'buy', shares: 10, price: 5 },
      { sym: 'B', action: 'buy', shares: 20, price: 3 },
    ]);
    assert.equal(b.open.length, 2);
    assert.equal(b.realizedBySym.A ?? 0, 0);
  });

  it('empty ledger → flat book', () => {
    const b = computeBook([]);
    assert.equal(b.open.length, 0);
    assert.equal(b.realized, 0);
  });
});

describe('summarize — unrealized P&L', () => {
  it('priced open position → unrealized vs avgCost', () => {
    const b = computeBook([{ sym: 'X', action: 'buy', shares: 100, price: 10 }]);
    const s = summarize(b, { X: 12 });
    assert.equal(s.marketValue, 1200);
    assert.equal(s.unrealized, 200);
    assert.equal(s.totalPnl, 200);
    assert.equal(s.priced, 1);
    assert.equal(s.unpriced, 0);
  });

  it('unpriced names excluded from market value but counted', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy', shares: 100, price: 10 },
      { sym: 'Y', action: 'buy', shares: 50,  price: 8 },
    ]);
    const s = summarize(b, { X: 11 });          // Y unpriced
    assert.equal(s.priced, 1);
    assert.equal(s.unpriced, 1);
    assert.equal(s.marketValue, 1100);
    assert.equal(s.unrealized, 100);            // only X contributes
  });

  it('realized flows through to totalPnl', () => {
    const b = computeBook([
      { sym: 'X', action: 'buy',  shares: 100, price: 10 },
      { sym: 'X', action: 'sell', shares: 50,  price: 14 },
    ]);
    const s = summarize(b, { X: 12 });
    // realized = 50*(14-10)=200 ; unrealized on 50 left = 50*(12-10)=100
    assert.equal(s.realized, 200);
    assert.equal(s.unrealized, 100);
    assert.equal(s.totalPnl, 300);
  });
});

// ── realFills store ↔ positions blob sync (DB round-trip) ───────────────────
describe('realFills — positions projection stays consistent', () => {
  const A = 'TADAWUL:9911', B = 'TADAWUL:9912';
  const clean = () => { realFills.reset(); for (const s of [A, B]) db.prepare('DELETE FROM positions WHERE sym=?').run(s); };
  before(clean);
  after(clean);

  it('a buy projects into the positions blob with avg cost', () => {
    realFills.reset();
    realFills.log({ sym: '9911', action: 'buy', shares: 100, price: 95.4 });
    const p = positions.getAll()[A];
    assert.ok(p, 'position should exist');
    assert.equal(p.shares, 100);
    assert.equal(p.buy_price, 95.4);
    assert.equal(p.source, 'fill');
  });

  it('removing the only fill removes the orphaned position (empty-ledger reconcile)', () => {
    realFills.reset();
    const r = realFills.log({ sym: '9911', action: 'buy', shares: 100, price: 95.4 });
    realFills.remove(r.id);
    assert.equal(realFills.getAll().length, 0);
    assert.equal(positions.getAll()[A], undefined);   // must be gone, not stale
  });

  it('selling to zero removes the position; realized P&L is booked', () => {
    realFills.reset();
    realFills.log({ sym: '9912', action: 'buy',  shares: 50, price: 30 });
    realFills.log({ sym: '9912', action: 'sell', shares: 50, price: 33 });
    assert.equal(positions.getAll()[B], undefined);
    assert.equal(realFills.book().realized, 150);
  });

  it('does not clobber a manually-entered (non-fill) position', () => {
    realFills.reset();
    positions.set(B, { sym: B, name: 'manual', shares: 10, buy_price: 5, source: 'manual' });
    realFills.log({ sym: '9911', action: 'buy', shares: 5, price: 12 });   // triggers a sync
    assert.ok(positions.getAll()[B], 'manual position should survive the fill sync');
    assert.equal(positions.getAll()[B].source, 'manual');
    db.prepare('DELETE FROM positions WHERE sym=?').run(B);
  });
});

// ── Plan-vs-actual tracking (pure) ──────────────────────────────────────────
describe('compareToSnapshot — execution fidelity', () => {
  const snap = {
    period: '2026-07-01', asOf: '2026-06-30',
    picks: [
      { sym: 'A', name: 'Alpha', rank: 1, price: 100, perNameSAR: 10000, targetShares: 100 },
      { sym: 'B', name: 'Beta',  rank: 2, price: 50,  perNameSAR: 10000, targetShares: 200 },
      { sym: 'C', name: 'Gamma', rank: 3, price: 20,  perNameSAR: 10000, targetShares: 500 },
    ],
  };
  const bookOf = fills => computeBook(fills);

  it('null when no snapshot', () => {
    assert.equal(compareToSnapshot(null, bookOf([])), null);
  });

  it('full faithful execution → 100% coverage, status filled', () => {
    const book = bookOf([
      { sym: 'A', action: 'buy', shares: 100, price: 100 },
      { sym: 'B', action: 'buy', shares: 200, price: 50 },
      { sym: 'C', action: 'buy', shares: 500, price: 20 },
    ]);
    const r = compareToSnapshot(snap, book);
    assert.equal(r.summary.coveragePct, 100);
    assert.equal(r.summary.held, 3);
    assert.equal(r.summary.missed, 0);
    assert.equal(r.summary.offPlan, 0);
    assert.equal(r.summary.avgEntrySlippagePct, 0);   // filled exactly at decision price
    assert.ok(r.rows.every(x => x.status === 'filled'));
  });

  it('entry slippage = avg cost vs decision price (positive = paid up)', () => {
    const book = bookOf([{ sym: 'A', action: 'buy', shares: 100, price: 105 }]); // +5% vs 100
    const r = compareToSnapshot(snap, book);
    const rowA = r.rows.find(x => x.sym === 'A');
    assert.equal(rowA.slippagePct, 5);
    assert.equal(r.summary.avgEntrySlippagePct, 5);
  });

  it('missed plan name → status missed, coverage drops', () => {
    const book = bookOf([{ sym: 'A', action: 'buy', shares: 100, price: 100 }]);
    const r = compareToSnapshot(snap, book);
    assert.equal(r.summary.held, 1);
    assert.equal(r.summary.missed, 2);
    assert.equal(r.summary.coveragePct, 33.3);
    assert.equal(r.rows.find(x => x.sym === 'B').status, 'missed');
  });

  it('under-size → partial', () => {
    const book = bookOf([{ sym: 'A', action: 'buy', shares: 50, price: 100 }]); // 50 < 90% of 100
    const r = compareToSnapshot(snap, book);
    assert.equal(r.rows.find(x => x.sym === 'A').status, 'partial');
    assert.equal(r.summary.partial, 1);
  });

  it('holding a name not in the plan → off_plan', () => {
    const book = bookOf([
      { sym: 'A', action: 'buy', shares: 100, price: 100 },
      { sym: 'Z', action: 'buy', shares: 10,  price: 7 },
    ]);
    const r = compareToSnapshot(snap, book);
    assert.equal(r.summary.offPlan, 1);
    const z = r.rows.find(x => x.sym === 'Z');
    assert.equal(z.status, 'off_plan');
    assert.equal(z.rank, null);
  });

  it('intended vs actual basis tracks deployed capital', () => {
    const book = bookOf([{ sym: 'A', action: 'buy', shares: 100, price: 100 }]);
    const r = compareToSnapshot(snap, book);
    assert.equal(r.summary.intendedBasis, 30000);   // 3 picks × 10000
    assert.equal(r.summary.actualBasis, 10000);      // only A filled
  });
});

describe('buildSnapshot — shape from a screen result', () => {
  it('maps holdings to picks with target shares from perNameSAR', () => {
    const screen = {
      success: true, nextRebalance: '2026-07-01', asOf: '2026-06-30',
      state: { status: 'decaying' }, sizing: { breakdown: { finalExposurePct: 48 } },
      holdings: [{ sym: 'A', code: 'A', name: 'Alpha', rank: 1, price: 100 }],
    };
    const snap = buildSnapshot({ screen, account: 100000, perNameSAR: 10000 });
    assert.equal(snap.period, '2026-07-01');
    assert.equal(snap.exposurePct, 48);
    assert.equal(snap.picks[0].targetShares, 100);   // floor(10000/100)
    assert.equal(snap.picks[0].perNameSAR, 10000);
  });
  it('returns null for a failed screen', () => {
    assert.equal(buildSnapshot({ screen: { success: false } }), null);
  });
});

describe('decisionSnapshots store — round-trip', () => {
  const P = '2099-01-01';
  const clean = () => decisionSnapshots.remove(P);
  before(clean);
  after(clean);

  it('saves and reads back by period and as latest', () => {
    const snap = { period: P, asOf: '2098-12-31', picks: [{ sym: 'A', price: 1, rank: 1 }] };
    const r = decisionSnapshots.save(snap);
    assert.equal(r.ok, true);
    assert.equal(decisionSnapshots.getByPeriod(P).picks.length, 1);
    assert.equal(decisionSnapshots.getLatest().period, P);   // 2099 sorts last/newest
  });

  it('upserts on the same period (one plan per period)', () => {
    decisionSnapshots.save({ period: P, picks: [{ sym: 'A' }] });
    decisionSnapshots.save({ period: P, picks: [{ sym: 'A' }, { sym: 'B' }] });
    assert.equal(decisionSnapshots.getByPeriod(P).picks.length, 2);
  });

  it('rejects a snapshot with no period', () => {
    assert.ok(decisionSnapshots.save({ picks: [] }).error);
  });
});
