// scripts/scan-logic.js
// Pure decision logic for the 15m-BIAS / 5m-STRUCTURE / 1m-TRIGGER scanner.
// No CDP, no chart I/O - deterministic and unit-testable. scan-run.js feeds it
// OHLCV bars via a lazy load(tf) callback; tests feed synthetic fixtures.
//
// Exactly 4 indicators, no fifth:
//   1. Supertrend (10, close, 3)
//   2. Session VWAP (hlc3, IST-session anchor, from CLOSED 5m bars)
//   3. Wilder RSI(14) on 15m CLOSED bars
//   4. Support and Resistance Levels with Breaks [LuxAlgo]  (structural level)
//
// Every gate reads the last CLOSED bar on its timeframe (index length-2), never
// the still-forming bar, so decisions do not repaint.
//
// Pipeline - a stage can only CONFIRM or WITHHOLD, never set or flip the side:
//   Gate 1   15m BIAS        Supertrend on the last closed 15m bar sets & FIXES
//                            the direction. A fresh flip, or a computed-vs-chart
//                            disagreement, = WAIT (before 5m / 1m load).
//   Gate 2c  RSI(14) 15m     block BUY if >= 70, block SELL if <= 30.
//   Session                  inside the symbol's IST new-signal window.
//   Gate 2   5m SETUP        (a) 15m structure still intact on the 5m  <-- HARD
//                                15m protection: the 1m stage can NEVER override
//                                an invalidated 15m structure.
//                            (b) price is in a pullback zone vs the 5m Supertrend
//   Gate 2s  5m STRUCTURE    NEW. A meaningful S/R level (break + retest preferred;
//                            5m swing as fallback) was pulled into AND HELD, and
//                            the last CLOSED 5m candle confirms the bias direction
//                            with the 5m Supertrend aligned on that bar. The 5m
//                            Supertrend may be counter-trend EARLIER in the
//                            pullback - it just has to be aligned on the
//                            confirmation bar. Until Gate 2 AND Gate 2s both pass
//                            the 1m trigger stays DISARMED.
//   Gate 2b  VWAP            session VWAP supportive of the trade direction
//                            (checked on the 5m close and again on the 1m entry).
//   Gate 2t  1m TRIGGER      only armed after Gate 1 + 2 + 2s. Last CLOSED 1m
//                            Supertrend aligned with the bias AND the last closed
//                            1m candle closed on the trend side of the 1m line.
//                            Produces the entry price only - it can never set or
//                            flip the side, and never fires on its own.
//   Gate 3   RISK            5m-swing stop (0.1*ATR5 buffer, clamped to
//                            [0.8, 2.5]*ATR5 else 1.5*ATR5), target = nearest
//                            S&R level in the trade direction, require R/R >= 2.
//
// Only when every gate passes and agrees on one direction is BUY / SELL emitted.

export const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')));
export const f2 = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── indicator math (dependency-free) ───────────────────────────────
export function wilderATR(bars, period) {
  const n = bars.length;
  const atr = new Array(n).fill(null);
  if (n < period + 1) return atr;
  const tr = new Array(n).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < n; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

// TradingView ta.supertrend equivalent. src = close (matches the chart's input).
export function supertrend(bars, period = 10, factor = 3) {
  const n = bars.length;
  const atr = wilderATR(bars, period);
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(null); // 1 = up/bull, -1 = down/bear
  let upPrev = null, dnPrev = null, dirPrev = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const src = bars[i].close;
    let up = src - factor * atr[i];
    let dn = src + factor * atr[i];
    if (upPrev != null) up = bars[i - 1].close > upPrev ? Math.max(up, upPrev) : up;
    if (dnPrev != null) dn = bars[i - 1].close < dnPrev ? Math.min(dn, dnPrev) : dn;
    let d;
    if (dirPrev == null) d = 1;
    else if (dirPrev === -1 && bars[i].close > dnPrev) d = 1;
    else if (dirPrev === 1 && bars[i].close < upPrev) d = -1;
    else d = dirPrev;
    line[i] = d === 1 ? up : dn;
    dir[i] = d;
    upPrev = up; dnPrev = dn; dirPrev = d;
  }
  return { line, dir, atr };
}

// Wilder RSI over closes - matches TradingView ta.rsi(close, period).
export function wilderRSI(bars, period = 14) {
  const n = bars.length;
  const rsi = new Array(n).fill(null);
  if (n < period + 1) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

export function istDateKey(unixSec) {
  const d = new Date(unixSec * 1000 + 5.5 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Session VWAP through bars[lastIdx] inclusive: hlc3 weighted by volume over every
// bar sharing lastIdx's IST session date. Falls back to an unweighted hlc3 mean
// when the symbol carries no volume (e.g. a cash index).
export function sessionVWAP(bars, lastIdx) {
  const dayKey = istDateKey(bars[lastIdx].time);
  let pv = 0, vol = 0, tpSum = 0, count = 0;
  for (let i = lastIdx; i >= 0; i--) {
    if (istDateKey(bars[i].time) !== dayKey) break;
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    pv += tp * v; vol += v; tpSum += tp; count += 1;
  }
  if (vol > 0) return pv / vol;
  return count > 0 ? tpSum / count : null;
}

// ── chart-study readers ───────────────────────────────────────────
export function findStudy(list, re) { return (list || []).find((s) => re.test(s.name || '')); }

export function readSupertrendChart(studies) {
  const s = findStudy(studies, /supertrend/i);
  if (!s) return null;
  const v = s.values || {};
  if (v['Up Trend'] != null) return { dir: 1, line: num(v['Up Trend']) };
  if (v['Down Trend'] != null) return { dir: -1, line: num(v['Down Trend']) };
  return null;
}

export function readSR(studies) {
  const s = findStudy(studies, /support and resistance levels with breaks/i);
  if (!s) return null;
  const v = s.values || {};
  const r = num(v.Resistance), sup = num(v.Support);
  return { resistance: Number.isFinite(r) ? r : null, support: Number.isFinite(sup) ? sup : null };
}

// ── session windows (IST, from scan_logic.session_profiles) ────────
export function sessionCheck(symbol, profiles, now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay(); // 0 Sun .. 6 Sat
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')} IST`;
  const isGold = /GOLD/i.test(symbol);
  const p = isGold ? (profiles?.MCX_GOLD || {}) : (profiles?.NSE || {});
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const before = toMin(p.no_new_signals_before) ?? (isGold ? 555 : 570);
  const after = toMin(p.no_new_signals_after) ?? (isGold ? 1380 : 900);
  if (dow === 0) return { ok: false, why: `market closed (Sunday) - ${hhmm}` };
  if (!isGold && dow === 6) return { ok: false, why: `NSE closed (Saturday) - ${hhmm}` };
  if (mins < before || mins > after) {
    return { ok: false, why: `outside ${isGold ? 'MCX GOLD' : 'NSE'} new-signal window (${hhmm})` };
  }
  return { ok: true, why: `within ${isGold ? 'MCX GOLD' : 'NSE'} window (${hhmm})`, hhmm };
}

// ── gate decision functions (pure - operate on scalar context) ─────
// Each returns either { wait: <WAIT signal> } to stop the pipeline, or a context
// object the next gate consumes. `carry` is the accumulating reasons prefix.

// Gate 1 - 15m bias. ctx15: { dir, dirPrev, line, price, rsi, barTime, chartDir }
export function decideBias(ctx15) {
  const { dir, dirPrev, line, price, rsi, barTime, chartDir } = ctx15 || {};
  const W = (reason, extra = {}) => ({ wait: { side: 'WAIT', reasons: [reason], bar_time: barTime, ...extra } });
  if (dir == null || line == null) return W('15m Supertrend not computable yet');
  if (chartDir != null && chartDir !== dir) {
    return W(`15m Supertrend disagreement: computed ${dir === 1 ? 'BULL' : 'BEAR'} vs chart ${chartDir === 1 ? 'BULL' : 'BEAR'} - standing aside`);
  }
  if (dir !== dirPrev) {
    return W('15m Supertrend flipped on the last closed bar - waiting one bar to confirm', { trend_15m: dir === 1 ? 'BULL' : 'BEAR' });
  }
  const bias = dir === 1 ? 'BULL' : 'BEAR';
  const side = dir === 1 ? 'BUY' : 'SELL';
  const carry = [`15m bias ${bias}`];

  if (rsi == null || !Number.isFinite(rsi)) {
    return { wait: { side: 'WAIT', reasons: [...carry, 'RSI(14) 15m unavailable - cannot confirm momentum, standing aside'], bar_time: barTime } };
  }
  if (side === 'BUY' && rsi >= 70) {
    return { wait: { side: 'WAIT', reasons: [...carry, `RSI(14) 15m ${rsi.toFixed(2)} is overbought (>=70) - momentum exhausted, no BUY`], bar_time: barTime } };
  }
  if (side === 'SELL' && rsi <= 30) {
    return { wait: { side: 'WAIT', reasons: [...carry, `RSI(14) 15m ${rsi.toFixed(2)} is oversold (<=30) - momentum exhausted, no SELL`], bar_time: barTime } };
  }
  return { bias, side, line15: line, price15: price, rsi15: rsi, bar15Time: barTime, carry };
}

// Gate 2 + Gate 2s - 5m setup and structural confirmation.
// ctx5: { dir, line, atr, bar:{open,high,low,close,time}, win:[{open,high,low,close}...],
//         sr:{support,resistance}, vwap }
export function decideSetup(prev, ctx5, cfg = {}) {
  const P = cfg.pullbackAtr ?? 1.5;
  const { bias, side, line15, carry } = prev;
  const { dir: dir5, line: line5, atr: atr5, bar: bar5, win = [], sr = {}, vwap } = ctx5 || {};
  const bar_time = bar5?.time ?? prev.bar15Time;
  const W = (reason) => ({ wait: { side: 'WAIT', reasons: [...carry, reason], bar_time } });

  if (dir5 == null || line5 == null || bar5 == null) return W('5m Supertrend not computable yet');
  if (!Number.isFinite(atr5) || atr5 <= 0) return W('5m setup - ATR(14) 5m not available');

  // (a) HARD 15m protection - 5m close must still be on the bias side of the 15m
  //     Supertrend line. If it has crossed against the bias the 15m structure is
  //     invalidated: stand aside BEFORE the 1m stage. The 1m trigger can never
  //     override this.
  const structureIntact = bias === 'BULL' ? bar5.close > line15 : bar5.close < line15;
  if (!structureIntact) {
    return W(`5m setup - 15m bias structurally broken: last closed 5m ${f2(bar5.close)} has crossed the 15m Supertrend line ${f2(line15)} against the bias; standing aside`);
  }

  // (b) pullback zone vs the 5m Supertrend line
  const distToLine5 = Math.abs(bar5.close - line5);
  const st5Aligned = (bias === 'BULL' && dir5 === 1) || (bias === 'BEAR' && dir5 === -1);
  if (distToLine5 > P * atr5) {
    return W(`5m setup - not in a pullback zone: price ${f2(bar5.close)} is ${(distToLine5 / atr5).toFixed(2)}x ATR5 from the 5m Supertrend line ${f2(line5)} (need <= ${P}x); ${st5Aligned ? 'trend extended' : 'pullback too deep'}, watch`);
  }

  // ---- Gate 2s: 5m STRUCTURAL CONFIRMATION (new) ----
  const tol = 0.5 * atr5;
  const priorBars = win.filter((b) => b && b !== bar5);

  // structural level: prefer the S&R level on the bias side; else a recent 5m swing
  let level = null, levelSrc = '';
  if (bias === 'BULL' && Number.isFinite(sr.support)) { level = sr.support; levelSrc = 'S&R support'; }
  else if (bias === 'BEAR' && Number.isFinite(sr.resistance)) { level = sr.resistance; levelSrc = 'S&R resistance'; }
  else if (priorBars.length >= 2) {
    level = bias === 'BULL' ? Math.min(...priorBars.map((b) => b.low)) : Math.max(...priorBars.map((b) => b.high));
    levelSrc = bias === 'BULL' ? '5m swing low' : '5m swing high';
  }
  if (!Number.isFinite(level)) {
    return W('5m setup OK; no structural S/R or 5m swing level to retest - standing aside');
  }

  // the pullback must have reached INTO the level area
  const lows = [...priorBars.map((b) => b.low), bar5.low];
  const highs = [...priorBars.map((b) => b.high), bar5.high];
  const ext = bias === 'BULL' ? Math.min(...lows) : Math.max(...highs);
  const reached = bias === 'BULL' ? ext <= level + tol : ext >= level - tol;
  if (!reached) {
    return W(`5m setup OK; pullback has not reached the ${bias === 'BULL' ? 'support' : 'resistance'} retest area (${levelSrc} ${f2(level)}, pullback extreme ${f2(ext)}, tol +/-${f2(tol)})`);
  }

  // the level must NOT have been broken by a CLOSED 5m bar against the bias
  const broken = [...priorBars, bar5].find((b) => (bias === 'BULL' ? b.close < level - tol : b.close > level + tol));
  if (broken) {
    return W(`5m setup OK; ${levelSrc} ${f2(level)} broken - a closed 5m bar at ${f2(broken.close)} is through the level, not a valid retest`);
  }

  // the last CLOSED 5m candle must HOLD the level, print a confirming body, and
  // have the 5m Supertrend aligned with the 15m bias on THAT bar
  const held = bias === 'BULL' ? bar5.close >= level : bar5.close <= level;
  const body = bias === 'BULL' ? bar5.close > bar5.open : bar5.close < bar5.open;
  if (!held) {
    return W(`5m setup OK; ${levelSrc} ${f2(level)} not held - last closed 5m closed ${bias === 'BULL' ? 'below' : 'above'} it`);
  }
  if (!body) {
    return W(`5m setup OK; last closed 5m candle is not ${bias === 'BULL' ? 'bullish' : 'bearish'} - 5m has not confirmed direction, 1m trigger stays disarmed`);
  }
  if (!st5Aligned) {
    return W('5m setup OK; 5m Supertrend not yet aligned with the 15m bias on the last closed bar - 5m has not confirmed, 1m trigger stays disarmed');
  }

  // VWAP must be available and supportive of the trade direction on the 5m close
  if (vwap == null || !Number.isFinite(vwap)) {
    return W('VWAP unavailable - cannot confirm direction, standing aside');
  }
  const vwapOk5 = bias === 'BULL' ? bar5.close >= vwap : bar5.close <= vwap;
  if (!vwapOk5) {
    return W(`VWAP not supportive - last closed 5m ${f2(bar5.close)} is on the wrong side of session VWAP ${f2(vwap)} for a ${side}`);
  }

  // break + retest is the preferred structural read; a plain pullback retest also
  // qualifies once it has held.
  const brokeThenBack = bias === 'BULL'
    ? Number.isFinite(sr.resistance) && priorBars.some((b) => b.close > sr.resistance)
    : Number.isFinite(sr.support) && priorBars.some((b) => b.close < sr.support);
  const retestKind = brokeThenBack ? 'break + retest' : 'pullback retest';
  const struct5Reason = `5m structure - ${retestKind} of ${levelSrc} ${f2(level)} held; last closed 5m ${f2(bar5.close)} is a ${bias === 'BULL' ? 'bullish' : 'bearish'} confirmation candle, 5m Supertrend aligned (${(distToLine5 / atr5).toFixed(2)}x ATR5 from the 5m line ${f2(line5)})`;

  return {
    ...prev,
    carry: [...carry, struct5Reason],
    bar_time, atr5, line5, dir5, bar5, win, sr, vwap,
    level, levelSrc, retestKind, distToLine5,
  };
}

// Gate 2t - 1m entry trigger. ctx1: { dir, line, close }
// Only ever reached after Gate 1 + Gate 2 + Gate 2s have all passed.
export function decideTrigger(setup, ctx1, _cfg = {}) {
  const { bias, side, carry, bar_time, vwap } = setup;
  const { dir: dir1, line: line1, close: close1 } = ctx1 || {};
  const W = (reason) => ({ wait: { side: 'WAIT', reasons: [...carry, reason], bar_time } });

  if (dir1 == null || line1 == null || close1 == null) return W('1m Supertrend not computable yet');
  const trigAligned = (bias === 'BULL' && dir1 === 1) || (bias === 'BEAR' && dir1 === -1);
  if (!trigAligned) return W('1m trigger - 1m Supertrend not yet aligned with the 15m bias (watch, not a trade)');
  const trigClosedOnSide = bias === 'BULL' ? close1 > line1 : close1 < line1;
  if (!trigClosedOnSide) return W('1m trigger - last closed 1m candle has not closed on the trend side of the 1m Supertrend line (watch, not a trade)');

  const entry = close1;
  if (side === 'BUY' && entry <= vwap) return W(`VWAP conflict - entry ${f2(entry)} is not above session VWAP ${f2(vwap)}, no BUY`);
  if (side === 'SELL' && entry >= vwap) return W(`VWAP conflict - entry ${f2(entry)} is not below session VWAP ${f2(vwap)}, no SELL`);

  const trig1Reason = `1m trigger - 1m Supertrend aligned ${bias === 'BULL' ? 'bullish' : 'bearish'}; last closed 1m candle closed ${bias === 'BULL' ? 'above' : 'below'} the 1m Supertrend line ${f2(line1)}`;
  return { ...setup, entry, line1, trig1Reason };
}

// Gate 3 - risk. Uses the 5m swing + 5m ATR; entered at the 1m close.
export function decideRisk(trig, cfg = {}) {
  const minRR = cfg.minRR ?? 2;
  const L = cfg.lookback ?? 10;
  const { side, entry, atr5, win, sr, carry, bar_time } = trig;
  const W = (reason) => ({ wait: { side: 'WAIT', reasons: [...carry, trig.trig1Reason, reason], bar_time } });

  const wl = win.slice(-L);
  let stop;
  if (side === 'BUY') {
    const swingLow = Math.min(...wl.map((b) => b.low));
    const raw = swingLow - 0.1 * atr5;
    const d = entry - raw;
    stop = d < 0.8 * atr5 || d > 2.5 * atr5 ? entry - 1.5 * atr5 : raw;
  } else {
    const swingHigh = Math.max(...wl.map((b) => b.high));
    const raw = swingHigh + 0.1 * atr5;
    const d = raw - entry;
    stop = d < 0.8 * atr5 || d > 2.5 * atr5 ? entry + 1.5 * atr5 : raw;
  }
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return W('Risk - could not derive a valid stop');

  let target = null;
  if (side === 'BUY') target = Number.isFinite(sr.resistance) && sr.resistance > entry ? sr.resistance : null;
  else target = Number.isFinite(sr.support) && sr.support < entry ? sr.support : null;
  if (target == null) {
    const lvl = side === 'BUY' ? sr.resistance : sr.support;
    return W(`Risk - no structural ${side === 'BUY' ? 'resistance above' : 'support below'} entry ${f2(entry)} (nearest S&R level ${Number.isFinite(lvl) ? f2(lvl) : 'n/a'} is on the wrong side); do not invent a target`);
  }
  const reward = Math.abs(target - entry);
  const rr = reward / risk;
  if (rr < minRR) {
    return W(`Risk - nearest structural target ${f2(target)} gives R/R 1:${rr.toFixed(2)}, below the ${minRR}:1 minimum`);
  }
  return { stop, target, rr, risk };
}

// Assemble the final BUY / SELL signal once every gate has passed.
function assemble(bias15, setup, trig, risk) {
  const { bias, side, line15, price15, rsi15 } = bias15;
  const { atr5, line5, bar5, vwap, distToLine5, level, levelSrc, retestKind } = setup;
  const { entry, line1 } = trig;
  const { stop, target, rr } = risk;
  return {
    side,
    entry: Number(entry.toFixed(4)),
    stop: Number(stop.toFixed(4)),
    target: Number(target.toFixed(4)),
    rr: Number(rr.toFixed(2)),
    rr_text: `1:${rr.toFixed(1)}`,
    bar_time: setup.bar_time,
    trend_15m: bias,
    reasons: [
      `15m bias ${bias} - price ${f2(price15)} ${bias === 'BULL' ? 'above' : 'below'} the 15m Supertrend line ${f2(line15)} on the last closed bar; no fresh flip`,
      `RSI(14) 15m ${rsi15.toFixed(2)} confirms momentum (not ${side === 'BUY' ? 'overbought' : 'oversold'})`,
      `5m structure - ${retestKind} of ${levelSrc} ${f2(level)} held; last closed 5m ${f2(bar5.close)} is a ${bias === 'BULL' ? 'bullish' : 'bearish'} confirmation candle, 5m Supertrend aligned (${(distToLine5 / atr5).toFixed(2)}x ATR5 from the 5m line ${f2(line5)})`,
      `1m trigger - 1m Supertrend aligned ${bias === 'BULL' ? 'bullish' : 'bearish'}; last closed 1m candle closed ${bias === 'BULL' ? 'above' : 'below'} the 1m Supertrend line ${f2(line1)}`,
      `VWAP confirms - entry ${f2(entry)} is ${side === 'BUY' ? 'above' : 'below'} session VWAP ${f2(vwap)}`,
      `Risk - stop ${f2(stop)} (${side === 'BUY' ? 'swing low' : 'swing high'} +/- 0.1*ATR5, ATR14(5m) ${f2(atr5)}), target ${f2(target)} (nearest S&R ${side === 'BUY' ? 'resistance' : 'support'}), risk ${f2(Math.abs(entry - stop))}, R/R 1:${rr.toFixed(2)}`,
    ],
  };
}

// Chain the gates in order with pre-built scalar context (used by the unit tests
// and by evaluate() below). `cfg` carries { pullbackAtr, lookback, minRR, session }.
export function decide({ ctx15, ctx5, ctx1, cfg = {} }) {
  const b = decideBias(ctx15);
  if (b.wait) return b.wait;
  if (cfg.session && cfg.session.ok === false) {
    return { side: 'WAIT', reasons: [...b.carry, `Session - ${cfg.session.why}`], bar_time: b.bar15Time };
  }
  const s = decideSetup(b, ctx5, cfg);
  if (s.wait) return s.wait;
  const t = decideTrigger(s, ctx1, cfg);
  if (t.wait) return t.wait;
  const r = decideRisk(t, cfg);
  if (r.wait) return r.wait;
  return assemble(b, s, t, r);
}

// ── bars -> context adapters ──────────────────────────────────────
export function ctx15From(bars15, studies15) {
  const st = supertrend(bars15, 10, 3);
  const i = bars15.length - 2; // last CLOSED 15m bar
  return {
    dir: st.dir[i], dirPrev: st.dir[i - 1], line: st.line[i],
    price: bars15[i].close, rsi: wilderRSI(bars15, 14)[i], barTime: bars15[i].time,
    chartDir: readSupertrendChart(studies15)?.dir ?? null,
  };
}

export function ctx5From(bars5, studies5, sr15, lookback = 10) {
  const st = supertrend(bars5, 10, 3);
  const atr = wilderATR(bars5, 14);
  const i = bars5.length - 2; // last CLOSED 5m bar
  const closed = bars5.slice(0, i + 1);           // all CLOSED bars, incl. bar5
  const win = closed.slice(-Math.max(lookback, 12));
  return {
    dir: st.dir[i], line: st.line[i], atr: atr[i],
    bar: bars5[i], win,
    sr: sr15 || readSR(studies5) || {},
    vwap: sessionVWAP(bars5, i),
  };
}

export function ctx1From(bars1) {
  const st = supertrend(bars1, 10, 3);
  const j = bars1.length - 2; // last CLOSED 1m bar
  return { dir: st.dir[j], line: st.line[j], close: bars1[j].close };
}

// Full evaluation from live-style bars, with lazy timeframe loading so the 5m /
// 1m series are only fetched when the pipeline actually reaches them.
// load(tf) -> { bars: [...], studies: [...] }
export async function evaluate({ symbol, cfg, opts = {}, now = new Date(), load }) {
  const gateCfg = {
    pullbackAtr: opts.pullbackAtr ?? 1.5,
    lookback: opts.lookback ?? 10,
    minRR: opts.minRR ?? 2,
  };
  const mkWait = (reasons, extra = {}) => ({ side: 'WAIT', reasons: [].concat(reasons), ...extra });

  const s15 = await load(cfg.biasTf);
  const bars15 = s15?.bars || [];
  if (bars15.length < 40) return mkWait(`insufficient 15m history (${bars15.length} bars)`);
  const b = decideBias(ctx15From(bars15, s15?.studies));
  if (b.wait) return b.wait;

  const sess = sessionCheck(symbol, cfg.profiles, now);
  if (!sess.ok) return { side: 'WAIT', reasons: [...b.carry, `Session - ${sess.why}`], bar_time: b.bar15Time };
  b.session = sess;

  const s5 = await load(cfg.setupTf);
  const bars5 = s5?.bars || [];
  if (bars5.length < 50) return { side: 'WAIT', reasons: [...b.carry, `insufficient 5m history (${bars5.length} bars)`], bar_time: b.bar15Time };
  const sr15 = readSR(s15?.studies);
  const s = decideSetup(b, ctx5From(bars5, s5?.studies, sr15, gateCfg.lookback), gateCfg);
  if (s.wait) return s.wait;

  const s1 = await load(cfg.entryTf);
  const bars1 = s1?.bars || [];
  if (bars1.length < 50) return { side: 'WAIT', reasons: [...s.carry, `insufficient 1m history (${bars1.length} bars)`], bar_time: s.bar_time };
  const t = decideTrigger(s, ctx1From(bars1), gateCfg);
  if (t.wait) return t.wait;

  const r = decideRisk(t, gateCfg);
  if (r.wait) return r.wait;

  const sig = assemble(b, s, t, r);
  sig.reasons.push(`Session - ${sess.why}`);
  return sig;
}
