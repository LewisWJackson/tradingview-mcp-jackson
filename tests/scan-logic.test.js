/**
 * Unit tests for the pure scanner decision logic (scripts/scan-logic.js).
 * No TradingView / CDP connection needed - every gate runs on scalar context.
 *
 * Run: node --test tests/scan-logic.test.js
 *
 * Focus scenarios (per the FINAL SCANNER LOGIC spec):
 *   1. 15m bearish + 5m bullish pullback + 1m bearish trigger BEFORE 5m
 *      confirmation  -> NO TRADE
 *   2. 15m bearish + 5m resistance rejection + 5m bearish close + 1m bearish
 *      close -> SELL
 *   3. 15m bullish + 5m support rejection + 5m bullish close + 1m bullish
 *      close -> BUY
 *   4. 1m trigger alone without 5m confirmation -> NO TRADE
 *   5. RSI extreme protection
 *   6. R:R < 2 -> NO TRADE
 *   7. 15m invalidation overrides 1m
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  decide, decideBias, decideSetup, decideTrigger,
  supertrend, wilderRSI, wilderATR, evaluate,
} from '../scripts/scan-logic.js';

// ── fixture helpers ──────────────────────────────────────────────
const T0 = 1788838200; // arbitrary unix-seconds bar time
const bar = (o, h, l, c, t = T0) => ({ open: o, high: h, low: l, close: c, time: t });
const flatWin = (n, lo, hi, cl) => Array.from({ length: n }, () => bar(lo, hi, lo, cl ?? hi));

const CFG = { pullbackAtr: 1.5, lookback: 10, minRR: 2, session: { ok: true, why: 'within NSE window (10:30 IST)' } };

// 15m bias contexts
const bull15 = (rsi = 58) => ({ dir: 1, dirPrev: 1, line: 100, price: 120, rsi, barTime: T0, chartDir: 1 });
const bear15 = (rsi = 42) => ({ dir: -1, dirPrev: -1, line: 120, price: 100, rsi, barTime: T0, chartDir: -1 });

// A fully valid 5m BUY structural-confirmation context (support retested + held,
// bullish confirmation candle, 5m Supertrend aligned, VWAP supportive).
const setup5BuyOK = () => ({
  dir: 1, line: 106, atr: 4,
  bar: bar(108.5, 112, 107.5, 110),          // bullish body, wick into support, closed back above
  win: flatWin(12, 108, 113, 112),           // prior pullback bars: swingLow 108, no close < 106
  sr: { support: 108, resistance: 120 },      // target far enough for R/R >= 2
  vwap: 104,                                  // 5m close 110 >= vwap -> supportive
});
// A fully valid 5m SELL structural-confirmation context (mirror).
const setup5SellOK = () => ({
  dir: -1, line: 114, atr: 4,
  bar: bar(111.5, 112.5, 109, 110),          // bearish body, wick into resistance, closed back below
  win: flatWin(12, 108, 112, 108),           // swingHigh 112, no close > 118
  sr: { support: 100, resistance: 112 },
  vwap: 116,                                  // 5m close 110 <= vwap -> supportive
});
const trig1Buy = () => ({ dir: 1, line: 108, close: 111 });
const trig1Sell = () => ({ dir: -1, line: 112, close: 109 });

// ── Scenario 3: clean BUY ───────────────────────────────────────
describe('scenario 3 - 15m bullish + 5m support rejection + 1m bullish close -> BUY', () => {
  it('emits BUY with R/R >= 2 and all four indicators cited', () => {
    const res = decide({ ctx15: bull15(), ctx5: setup5BuyOK(), ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'BUY');
    assert.equal(res.entry, 111);
    assert.ok(res.rr >= 2, `R/R should be >= 2, got ${res.rr}`);
    assert.ok(res.stop < res.entry && res.target > res.entry);
    const reasons = res.reasons.join(' | ');
    assert.match(reasons, /15m bias BULL/);
    assert.match(reasons, /RSI\(14\) 15m/);
    assert.match(reasons, /5m structure - .*retest of S&R support/);
    assert.match(reasons, /1m trigger - 1m Supertrend aligned bullish/);
    assert.match(reasons, /VWAP confirms/);
  });
});

// ── Scenario 2: clean SELL ──────────────────────────────────────
describe('scenario 2 - 15m bearish + 5m resistance rejection + 1m bearish close -> SELL', () => {
  it('emits SELL with R/R >= 2', () => {
    const res = decide({ ctx15: bear15(), ctx5: setup5SellOK(), ctx1: trig1Sell(), cfg: CFG });
    assert.equal(res.side, 'SELL');
    assert.equal(res.entry, 109);
    assert.ok(res.rr >= 2, `R/R should be >= 2, got ${res.rr}`);
    assert.ok(res.stop > res.entry && res.target < res.entry);
    assert.match(res.reasons.join(' | '), /5m structure - .*retest of S&R resistance/);
  });
});

// ── Scenario 1: 1m bearish trigger BEFORE 5m confirmation -> NO TRADE ──
describe('scenario 1 - 15m bearish, 5m still bullish (pullback), 1m bearish trigger ready', () => {
  it('returns WAIT - the 5m has not confirmed, so the 1m trigger is never consulted', () => {
    const ctx5 = {
      dir: 1, line: 113, atr: 4,                 // 5m Supertrend still counter-trend (bullish)
      bar: bar(108, 112.5, 107.5, 111),          // BULLISH 5m candle - not a bearish confirmation
      win: flatWin(12, 108, 113, 112),
      sr: { support: 100, resistance: 112 },
      vwap: 116,
    };
    const res = decide({ ctx15: bear15(), ctx5, ctx1: trig1Sell(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    const reasons = res.reasons.join(' | ');
    assert.match(reasons, /5m has not confirmed|1m trigger stays disarmed/);
    assert.doesNotMatch(reasons, /1m trigger - 1m Supertrend aligned/); // never reached the trigger
  });
});

// ── Scenario 4: 1m trigger alone, no 5m structural confirmation -> NO TRADE ──
describe('scenario 4 - perfect 1m trigger but 5m never retested structure', () => {
  it('decideSetup withholds, and decide() returns that WAIT regardless of the 1m context', () => {
    const ctx5 = {
      dir: 1, line: 128, atr: 4,
      bar: bar(129, 131, 128, 130),              // price extended, never pulled back to support
      win: flatWin(12, 125, 132, 131),
      sr: { support: 108, resistance: 160 },
      vwap: 120,
    };
    const setup = decideSetup({ bias: 'BULL', side: 'BUY', line15: 100, carry: ['15m bias BULL'], bar15Time: T0 }, ctx5, CFG);
    assert.ok(setup.wait, 'Gate 2s should withhold');

    const res = decide({ ctx15: bull15(), ctx5, ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    const reasons = res.reasons.join(' | ');
    assert.match(reasons, /has not reached the support retest area/);
    assert.doesNotMatch(reasons, /1m trigger/); // the 1m stage is never armed
  });
});

// ── Scenario 5: RSI extreme protection ──────────────────────────
describe('scenario 5 - RSI(14) 15m extreme blocks the trade', () => {
  it('BUY blocked when RSI >= 70', () => {
    const res = decide({ ctx15: bull15(72), ctx5: setup5BuyOK(), ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' | '), /overbought \(>=70\)/);
  });
  it('BUY blocked exactly at RSI 70 (boundary)', () => {
    const res = decide({ ctx15: bull15(70), ctx5: setup5BuyOK(), ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
  });
  it('SELL blocked when RSI <= 30', () => {
    const res = decide({ ctx15: bear15(28), ctx5: setup5SellOK(), ctx1: trig1Sell(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' | '), /oversold \(<=30\)/);
  });
  it('BUY allowed when RSI is 69.9 (just inside)', () => {
    const res = decide({ ctx15: bull15(69.9), ctx5: setup5BuyOK(), ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'BUY');
  });
});

// ── Scenario 6: R:R < 2 -> NO TRADE ─────────────────────────────
describe('scenario 6 - reward-to-risk below 2:1', () => {
  it('returns WAIT when the nearest structural target is too close', () => {
    const ctx5 = { ...setup5BuyOK(), sr: { support: 108, resistance: 114 } }; // target only ~3 pts above entry
    const res = decide({ ctx15: bull15(), ctx5, ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' | '), /below the 2:1 minimum/);
  });
});

// ── Scenario 7: 15m invalidation overrides the 1m ───────────────
describe('scenario 7 - 5m has closed through the 15m Supertrend against the bias', () => {
  it('returns WAIT before the 1m stage even with a perfect 1m bullish trigger', () => {
    const ctx5 = {
      dir: 1, line: 106, atr: 4,
      bar: bar(96, 97, 94, 95),                  // 5m close 95 is BELOW the 15m line (100) - bias broken
      win: flatWin(12, 95, 100, 99),
      sr: { support: 90, resistance: 120 },
      vwap: 94,
    };
    const res = decide({ ctx15: bull15(), ctx5, ctx1: trig1Buy(), cfg: CFG });
    assert.equal(res.side, 'WAIT');
    const reasons = res.reasons.join(' | ');
    assert.match(reasons, /15m bias structurally broken/);
    assert.doesNotMatch(reasons, /1m trigger/);
  });
});

// ── ordering guarantee: the 1m can never produce a trade by itself ──
describe('the 1m trigger never sets or flips the side', () => {
  it('a bullish 1m trigger under a 15m BEARISH bias cannot yield a BUY', () => {
    // valid-looking bearish 5m setup, but the 1m context is bullish
    const res = decide({ ctx15: bear15(), ctx5: setup5SellOK(), ctx1: { dir: 1, line: 108, close: 112 }, cfg: CFG });
    assert.notEqual(res.side, 'BUY');
    assert.equal(res.side, 'WAIT'); // 1m not aligned with the fixed SELL bias
    assert.match(res.reasons.join(' | '), /1m Supertrend not yet aligned/);
  });
});

// ── existing Gate 1 protections still hold ──────────────────────
describe('Gate 1 - 15m bias protections', () => {
  it('fresh Supertrend flip on the last closed 15m bar -> WAIT', () => {
    const res = decide({ ctx15: { dir: 1, dirPrev: -1, line: 100, price: 120, rsi: 55, barTime: T0, chartDir: 1 }, ctx5: {}, ctx1: {}, cfg: CFG });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' '), /flipped on the last closed bar/);
  });
  it('computed-vs-chart Supertrend disagreement -> WAIT', () => {
    const res = decide({ ctx15: { dir: 1, dirPrev: 1, line: 100, price: 120, rsi: 55, barTime: T0, chartDir: -1 }, ctx5: {}, ctx1: {}, cfg: CFG });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' '), /Supertrend disagreement/);
  });
  it('outside the session window -> WAIT (before any 5m work)', () => {
    const cfg = { ...CFG, session: { ok: false, why: 'outside NSE new-signal window (08:40 IST)' } };
    const res = decide({ ctx15: bull15(), ctx5: setup5BuyOK(), ctx1: trig1Buy(), cfg });
    assert.equal(res.side, 'WAIT');
    assert.match(res.reasons.join(' '), /Session - outside NSE/);
  });
});

// ── indicator math sanity ──────────────────────────────────────
describe('indicator helpers', () => {
  const up = Array.from({ length: 60 }, (_, k) => bar(100 + k, 101 + k, 99 + k, 100 + k, T0 + k * 900));
  it('supertrend reports an uptrend as dir 1 on a clean rising series', () => {
    const st = supertrend(up, 10, 3);
    assert.equal(st.dir[up.length - 2], 1);
  });
  it('wilderRSI on a monotonic rise is pinned near 100', () => {
    const rsi = wilderRSI(up, 14)[up.length - 2];
    assert.ok(rsi > 95, `expected ~100, got ${rsi}`);
  });
  it('wilderATR is positive and finite after warmup', () => {
    const atr = wilderATR(up, 14)[up.length - 2];
    assert.ok(Number.isFinite(atr) && atr > 0);
  });
});

// ── evaluate() lazy-load short-circuit ─────────────────────────
describe('evaluate() - lazy timeframe loading', () => {
  it('a Gate 1 WAIT (RSI pinned high) never loads the 5m or 1m series', async () => {
    const up = Array.from({ length: 60 }, (_, k) => bar(100 + k, 101 + k, 99 + k, 100 + k, T0 + k * 900));
    const requested = [];
    const load = async (tf) => {
      requested.push(tf);
      return { bars: up, studies: [] };
    };
    const cfg = { biasTf: '15', setupTf: '5', entryTf: '1', minRR: 2, profiles: {} };
    // Fixed Monday 10:30 IST so the session gate passes.
    const now = new Date(Date.UTC(2026, 8, 7, 5, 0, 0));
    const res = await evaluate({ symbol: 'NSE:TEST1!', cfg, opts: {}, now, load });
    assert.equal(res.side, 'WAIT');
    assert.deepEqual(requested, ['15']); // 5m / 1m never requested
  });
});
