/**
 * backtest_logic.mjs — honest 1-year replay of the REAL scoreBias STRONG BUY logic.
 *
 * No lookahead: for each historical day t, indicators are computed from bars[0..t]
 * ONLY, the signal is taken at close[t], and the forward return is measured t→t+H.
 * Benchmark = equal-weight TASI basket over the SAME window (the fair yardstick).
 * Reports raw return (the "looks fine" trap) AND excess vs basket, net of cost,
 * by horizon and by market regime.
 *
 * Caveats: survivorship (Yahoo = currently-listed names only); ~85-name universe;
 * thresholds were hand-set, not fit — so this is a clean first out-of-sample-style test.
 *
 * Run: node scripts/backtest_logic.mjs
 */
import {
  fetchYahooOHLCV, toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, rsiSeries, macdHist, volumeCheck, atrCalc,
  calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
} from './tasi_screener.mjs';

const HORIZONS = [5, 10, 20];
const COST_RT  = +process.env.COST_RT || 0.0011;  // Derayah 0.11% RT (env override)
const MODE     = 'swing';
const MIN_HISTORY = 210;       // need EMA200 + buffer before a day is testable

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// Build scoreBias inputs from bars[0..idx] (inclusive) — causal, no lookahead.
function signalAt(bars, idx, indexChange63d) {
  const slc = (arr) => arr.slice(0, idx + 1);
  const closes  = slc(bars.closes);
  const highs   = slc(bars.highs);
  const lows    = slc(bars.lows);
  const volumes = slc(bars.volumes);
  if (closes.length < 50) return null;
  const price = closes[closes.length - 1];

  const e13 = emaArray(closes, 13), e34 = emaArray(closes, 34), e89 = emaArray(closes, 89), e200 = emaArray(closes, 200);
  const emas = { ema13: e13.at(-1), ema34: e34.at(-1), ema89: e89.at(-1), ema200: e200.at(-1) };

  const rsiVal   = calcRsi(closes, 14);
  const macdData = macdHist(closes);
  const volData  = volumeCheck(volumes, true);
  const rsScore  = (indexChange63d !== null && closes.length >= 64)
    ? Math.round(((price - closes[closes.length - 64]) / closes[closes.length - 64] * 100 - indexChange63d) * 100) / 100
    : null;
  const srLevels    = findSRLevels(highs, lows, closes, 5);
  const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
  const low20d      = closes.length >= 21 ? Math.min(...closes.slice(-21)) : price;
  const extension   = low20d > 0 ? (price - low20d) / low20d * 100 : 0;
  const vwap20      = calcVWAP(highs, lows, closes, volumes, 20);
  const obv_trend   = calcOBVTrend(closes, volumes, 20);

  const scored = scoreBias(emas, rsiVal, macdData, volData, price, MODE, rsScore,
    { srLevels, avgVolume: avgVolume20, rsScore60d: rsScore, isExtended: extension > 25, vwap20, obv_trend, isTasi: true });
  return scored; // { bias, score, ... }
}

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med  = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd   = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct  = (x) => (x * 100).toFixed(2) + '%';
const win  = (a) => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  console.error(`fetching ${syms.length} symbols + index ...`);

  // fetch all bars
  const data = {}; // sym -> {dates, closes, highs, lows, volumes, dateIdx}
  for (const sym of syms) {
    try {
      const b = await fetchYahooOHLCV(toYahooSym(sym), '1d', 520);
      if (b.length < MIN_HISTORY) continue;
      const dates = b.map(x => iso(x.time));
      data[sym] = {
        dates, closes: b.map(x => x.close), highs: b.map(x => x.high),
        lows: b.map(x => x.low), volumes: b.map(x => x.volume),
        dateIdx: Object.fromEntries(dates.map((d, i) => [d, i])),
      };
    } catch {}
  }
  // index for RS + regime
  const ib = await fetchYahooOHLCV('^TASI.SR', '1d', 520);
  const idxDates = ib.map(x => iso(x.time));
  const idxClose = ib.map(x => x.close);
  const idxAt = Object.fromEntries(idxDates.map((d, i) => [d, i]));
  const sma = (arr, i, n) => i + 1 < n ? null : mean(arr.slice(i - n + 1, i + 1));

  const usable = Object.keys(data);
  console.error(`usable symbols: ${usable.length}`);

  // master trading-day list = index dates, restricted to a ~1y testable window
  const lastTestable = idxDates.length - 1 - Math.max(...HORIZONS);
  const firstTestable = Math.max(MIN_HISTORY, idxDates.length - 252 - Math.max(...HORIZONS));

  // accumulators
  const ex = {}, raw = {}, exRegime = { up: {}, down: {} };
  for (const H of HORIZONS) { ex[H] = []; raw[H] = []; exRegime.up[H] = []; exRegime.down[H] = []; }
  // equal-weight basket forward cache: `${date}|${H}` -> ret
  const ewCache = {};
  function ew(date, H) {
    const k = date + '|' + H;
    if (k in ewCache) return ewCache[k];
    const rs = [];
    for (const s of usable) {
      const d = data[s]; const i = d.dateIdx[date];
      if (i == null || i + H >= d.closes.length) continue;
      rs.push(d.closes[i + H] / d.closes[i] - 1);
    }
    return ewCache[k] = rs.length ? mean(rs) : null;
  }

  // overlap-corrected accumulator (H=20): one signal per sym per 20 sessions -> near independent
  const indep20 = [];
  const lastUsed = {};
  // #1 score gradient (overlapping H=20, bucketed by raw score 7/8/9)
  const exScore20 = { 7: [], 8: [], 9: [] };
  // #2 walk-forward: independent H=20 split into first/second half of the window by date
  const midDate = idxDates[Math.floor((firstTestable + lastTestable) / 2)];
  const indepWF = { h1: [], h2: [] };

  let signals = 0;
  for (let di = firstTestable; di <= lastTestable; di++) {
    const date = idxDates[di];
    const idxC = idxClose[di];
    const idx50 = sma(idxClose, di, 50);
    const regime = idx50 == null ? null : (idxC > idx50 ? 'up' : 'down');
    const indexChange63d = di >= 63 ? (idxC - idxClose[di - 63]) / idxClose[di - 63] * 100 : null;

    for (const sym of usable) {
      const d = data[sym];
      const i = d.dateIdx[date];
      if (i == null || i < MIN_HISTORY) continue;
      const scored = signalAt(d, i, indexChange63d);
      if (!scored || scored.bias !== 'STRONG BUY' || scored.score < 7) continue;
      signals++;
      for (const H of HORIZONS) {
        if (i + H >= d.closes.length) continue;
        const r = d.closes[i + H] / d.closes[i] - 1;
        const bench = ew(date, H);
        if (bench == null) continue;
        raw[H].push(r);
        ex[H].push(r - bench);
        if (regime) exRegime[regime][H].push(r - bench);
        // #1 score gradient at H=20
        if (H === 20) { const b = Math.min(9, Math.max(7, scored.score)); exScore20[b].push(r - bench); }
      }
      // overlap-corrected H=20: accept only if >=20 sessions since this sym last accepted
      if (i + 20 < d.closes.length && (lastUsed[sym] == null || i - lastUsed[sym] >= 20)) {
        const bench20 = ew(date, 20);
        if (bench20 != null) {
          const exv = (d.closes[i + 20] / d.closes[i] - 1) - bench20;
          indep20.push(exv); lastUsed[sym] = i;
          (date < midDate ? indepWF.h1 : indepWF.h2).push(exv);   // #2 walk-forward split
        }
      }
    }
  }

  console.log(`\n=== 1-YEAR BACKTEST: real scoreBias STRONG BUY logic (no lookahead) ===`);
  console.log(`window: ${idxDates[firstTestable]} → ${idxDates[lastTestable]} | symbols: ${usable.length} | STRONG BUY signals: ${signals}`);
  console.log(`benchmark: equal-weight TASI basket, same window | cost: ${pct(COST_RT)} round-trip\n`);

  for (const H of HORIZONS) {
    console.log(`── horizon ${H} sessions  (n=${ex[H].length}) ──`);
    console.log(`   RAW return        : mean ${pct(mean(raw[H]))}  (the "looks fine" number — ignore it)`);
    console.log(`   EXCESS vs basket  : mean ${pct(mean(ex[H]))}  median ${pct(med(ex[H]))}  beat ${win(ex[H])}  t=${tstat(ex[H])}`);
    console.log(`   NET (excess−cost) : mean ${pct(mean(ex[H]) - COST_RT)}`);
    console.log(`   by regime (excess): UP-trend ${pct(mean(exRegime.up[H]))} (n=${exRegime.up[H].length})  |  DOWN/chop ${pct(mean(exRegime.down[H]))} (n=${exRegime.down[H].length})`);
    console.log('');
  }
  console.log(`── OVERLAP-CORRECTED H=20 (one signal per stock per 20 sessions, near-independent) ──`);
  console.log(`   n=${indep20.length}  excess mean ${pct(mean(indep20))}  median ${pct(med(indep20))}  beat ${win(indep20)}  t=${tstat(indep20)}  NET ${pct(mean(indep20) - COST_RT)}\n`);

  console.log(`── #1 SCORE GRADIENT @ H=20 (does higher score concentrate the edge?) ──`);
  for (const s of [7, 8, 9]) {
    const a = exScore20[s];
    console.log(`   score ${s}: n=${String(a.length).padStart(4)}  excess mean ${pct(mean(a)).padStart(7)}  median ${pct(med(a)).padStart(7)}  beat ${win(a)}  t=${tstat(a)}`);
  }
  const g = [7, 8, 9].map(s => mean(exScore20[s]));
  console.log(`   monotonic (7<8<9)? ${g[0] < g[1] && g[1] < g[2] ? 'YES — higher score = bigger edge' : 'NO — score does not cleanly sort the edge'}\n`);

  console.log(`── #2 WALK-FORWARD (independent H=20, split at ${midDate}) ──`);
  for (const [k, a] of Object.entries(indepWF)) {
    console.log(`   ${k === 'h1' ? 'FIRST half ' : 'SECOND half'}: n=${String(a.length).padStart(3)}  excess mean ${pct(mean(a)).padStart(7)}  beat ${win(a)}  t=${tstat(a)}  NET ${pct(mean(a) - COST_RT)}`);
  }
  const persists = (mean(indepWF.h1) - COST_RT) > 0 && (mean(indepWF.h2) - COST_RT) > 0;
  console.log(`   edge persists in BOTH halves net of cost? ${persists ? 'YES' : 'NO — does not hold out-of-sample'}\n`);

  const best = HORIZONS.map(H => mean(ex[H]) - COST_RT).filter(x => !isNaN(x));
  const anyEdge = (mean(indep20) - COST_RT) > 0 && tstat(indep20) > 2;
  console.log(anyEdge
    ? 'VERDICT: at least one horizon beats equal-weight net of cost with t>2 — worth a closer look.'
    : 'VERDICT: no horizon beats the equal-weight basket net of cost with statistical significance.');
  process.exit(0);
}
main();
