/**
 * score_whale_5y_test.mjs — re-test the 9-pt score AND the whale_score over ~5 clean years.
 *
 * Window: 2020-01-01 → today, with the COVID crash+recovery [2020-02-20 .. 2021-03-31]
 * carved out. That leaves ~5.2 years of "normal regime" data — the point of excluding
 * COVID is to see if the signals work when the market isn't in a once-in-a-decade panic.
 *
 * Discipline (unchanged): no lookahead (signal from bars[0..t], measure t→t+20).
 * ABSOLUTE return AND EXCESS vs an EQUAL-WEIGHT basket. Overlap-corrected (one observation
 * per stock per 20 sessions). Newey-West t-stat (lag=20) so overlapping windows don't
 * inflate significance. Cost = Derayah 0.11% round-trip.
 *
 * Run: node scripts/score_whale_5y_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import {
  toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
  calcMFI, calcVolumeZScore,
} from './tasi_screener.mjs';

const H = 20, MIN_HISTORY = 210;
const COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01';
const COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = (d) => d >= COVID0 && d <= COVID1;

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const simpleT = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const f2 = x => isNaN(x) ? '—' : x.toFixed(2);

// Newey-West t-stat for the mean (HAC), Bartlett kernel, lag L.
function neweyWestT(x, L = H) {
  const n = x.length; if (n < 3) return NaN;
  const m = mean(x), e = x.map(v => v - m);
  let g0 = 0; for (const v of e) g0 += v * v; g0 /= n;
  let lrv = g0;
  for (let l = 1; l <= L; l++) {
    let g = 0; for (let i = l; i < n; i++) g += e[i] * e[i - l]; g /= n;
    lrv += 2 * (1 - l / (L + 1)) * g;
  }
  const seMean = Math.sqrt(lrv / n);
  return m / seMean;
}

// replicated from tasi_screener (not exported)
function calcWhaleScore(mfi, obvTrend, volRatio, zScore, bias) {
  const bear = ['STRONG SELL', 'SELL', 'AVOID'].includes(bias);
  let score = 0;
  if (mfi != null) {
    if (!bear && mfi > 80) score += 3; else if (!bear && mfi > 65) score += 2; else if (!bear && mfi > 55) score += 1;
    if (bear && mfi < 20) score += 3; else if (bear && mfi < 35) score += 2; else if (bear && mfi < 45) score += 1;
  }
  if ((!bear && obvTrend === 'rising') || (bear && obvTrend === 'falling')) score += 2;
  if (zScore != null) { if (zScore > 3) score += 3; else if (zScore > 2) score += 2; else if (zScore > 1.5) score += 1; }
  if (volRatio >= 5) score += 2; else if (volRatio >= 3) score += 1;
  return score;
}

function signalAt(d, i, indexChange63d) {
  const closes = d.closes.slice(0, i + 1), highs = d.highs.slice(0, i + 1),
    lows = d.lows.slice(0, i + 1), volumes = d.volumes.slice(0, i + 1);
  if (closes.length < 64) return null;
  const price = closes.at(-1);
  const e13 = emaArray(closes, 13), e34 = emaArray(closes, 34), e89 = emaArray(closes, 89), e200 = emaArray(closes, 200);
  const emas = { ema13: e13.at(-1), ema34: e34.at(-1), ema89: e89.at(-1), ema200: e200.at(-1) };
  const rsiVal = calcRsi(closes, 14), macdData = macdHist(closes), volData = volumeCheck(volumes, true);
  const rsScore = (indexChange63d !== null && closes.length >= 64)
    ? Math.round(((price - closes[closes.length - 64]) / closes[closes.length - 64] * 100 - indexChange63d) * 100) / 100 : null;
  const srLevels = findSRLevels(highs, lows, closes, 5);
  const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
  const low20d = closes.length >= 21 ? Math.min(...closes.slice(-21)) : price;
  const extension = low20d > 0 ? (price - low20d) / low20d * 100 : 0;
  const vwap20 = calcVWAP(highs, lows, closes, volumes, 20), obv_trend = calcOBVTrend(closes, volumes, 20);
  const scored = scoreBias(emas, rsiVal, macdData, volData, price, 'swing', rsScore,
    { srLevels, avgVolume: avgVolume20, rsScore60d: rsScore, isExtended: extension > 25, vwap20, obv_trend, isTasi: true });
  // whale inputs
  const mfi = calcMFI(highs, lows, closes, volumes, 14);
  const zScore = calcVolumeZScore(volumes, 20);
  const whale = calcWhaleScore(mfi, obv_trend, volData.ratio, zScore, scored.bias);
  return { bias: scored.bias, whale };
}

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  const ysyms = syms.map(toYahooSym);
  console.error(`warming ${ysyms.length} symbols (10y cache) ...`);
  await warm([...ysyms, '^TASI.SR'], '10y');

  const data = {};
  for (const sym of syms) {
    const b = await getBars(toYahooSym(sym), '10y');
    if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[sym] = {
      dates, closes: b.map(x => x.c), highs: b.map(x => x.h), lows: b.map(x => x.l), volumes: b.map(x => x.v),
      dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])),
    };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const idxDates = ib.map(x => iso(x.t)), idxClose = ib.map(x => x.c);
  const idxIdx = Object.fromEntries(idxDates.map((d, i) => [d, i]));
  const usable = Object.keys(data);
  console.error(`usable symbols: ${usable.length}`);

  // equal-weight basket forward H-return for any date
  const ewCache = {};
  const ew = (date) => {
    if (date in ewCache) return ewCache[date];
    const rs = [];
    for (const s of usable) { const d = data[s]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) continue; rs.push(d.closes[i + H] / d.closes[i] - 1); }
    return ewCache[date] = rs.length ? mean(rs) : null;
  };

  const ladder = {};       // bias -> { abs:[], exc:[] }
  const whaleB = {};       // bucket label -> { abs:[], exc:[] }
  const lastUsed = {};
  let span0 = '9999', span1 = '0', nObs = 0, nDropped = 0;

  for (const sym of usable) {
    const d = data[sym];
    for (let i = MIN_HISTORY; i + H < d.closes.length; i++) {
      const date = d.dates[i];
      if (date < START) continue;
      if (inCovid(date)) { nDropped++; continue; }
      if (lastUsed[sym] != null && i - lastUsed[sym] < H) continue;   // overlap-corrected
      const ii = idxIdx[date]; if (ii == null || ii < 63) continue;
      const indexChange63d = (idxClose[ii] - idxClose[ii - 63]) / idxClose[ii - 63] * 100;
      const sg = signalAt(d, i, indexChange63d);
      if (!sg) continue;
      const bench = ew(date); if (bench == null) continue;
      const r = d.closes[i + H] / d.closes[i] - 1 - COST_RT;          // net of round-trip cost
      const exc = r - bench;
      (ladder[sg.bias] ||= { abs: [], exc: [] });
      ladder[sg.bias].abs.push(r); ladder[sg.bias].exc.push(exc);
      const wb = sg.whale >= 6 ? '≥6 (strong)' : sg.whale >= 4 ? '4–5 (elevated)' : sg.whale >= 1 ? '1–3 (mild)' : '0 (none)';
      (whaleB[wb] ||= { abs: [], exc: [] });
      whaleB[wb].abs.push(r); whaleB[wb].exc.push(exc);
      lastUsed[sym] = i;
      nObs++; if (date < span0) span0 = date; if (date > span1) span1 = date;
    }
  }

  const row = (label, bk) => {
    if (!bk || !bk.abs.length) { console.log(`  ${label.padEnd(14)} ${'0'.padStart(6)}  (none)`); return null; }
    console.log(`  ${label.padEnd(14)} ${String(bk.abs.length).padStart(6)}  ${pct(mean(bk.abs)).padStart(9)} ${f2(neweyWestT(bk.abs)).padStart(6)}   ${pct(mean(bk.exc)).padStart(9)} ${f2(neweyWestT(bk.exc)).padStart(6)}`);
    return mean(bk.abs);
  };

  console.log(`\nClean span used: ${span0} → ${span1}   observations: ${nObs}   COVID dropped: ${nDropped}   cost ${(COST_RT * 100).toFixed(2)}% RT`);
  console.log(`\n=== 9-PT SCORE LADDER — forward ${H}-session return, NET, NW-t (lag ${H}) ===`);
  console.log(`  ${'bias'.padEnd(14)} ${'n'.padStart(6)}  ${'ABS'.padStart(9)} ${'t'.padStart(6)}   ${'EXCESS'.padStart(9)} ${'t'.padStart(6)}`);
  const order = ['STRONG BUY', 'BUY', 'WATCH', 'SKIP', 'AVOID', 'SELL', 'STRONG SELL'];
  const absMeans = [];
  for (const b of order) { const m = row(b, ladder[b]); if (m != null) absMeans.push([b, m]); }
  let mono = true; for (let i = 1; i < absMeans.length; i++) if (absMeans[i][1] > absMeans[i - 1][1] + 1e-4) mono = false;
  const sb = absMeans.find(x => x[0] === 'STRONG BUY'), ss = absMeans.find(x => x[0] === 'STRONG SELL');
  console.log(`  → ladder sorts in order? ${mono ? 'YES (ranking power)' : 'NO (does not cleanly rank)'}`);
  if (sb && ss) console.log(`  → STRONG BUY ${pct(sb[1])} vs STRONG SELL ${pct(ss[1])}, spread ${pct(sb[1] - ss[1])} ${sb[1] > ss[1] ? '(right dir)' : '(WRONG dir)'}`);

  console.log(`\n=== WHALE_SCORE — forward ${H}-session return, NET, NW-t (lag ${H}) ===`);
  console.log(`  ${'whale bucket'.padEnd(14)} ${'n'.padStart(6)}  ${'ABS'.padStart(9)} ${'t'.padStart(6)}   ${'EXCESS'.padStart(9)} ${'t'.padStart(6)}`);
  const wOrder = ['≥6 (strong)', '4–5 (elevated)', '1–3 (mild)', '0 (none)'];
  const wMeans = [];
  for (const w of wOrder) { const m = row(w, whaleB[w]); if (m != null) wMeans.push([w, m]); }
  if (wMeans.length >= 2) {
    const hi = wMeans[0], lo = wMeans.at(-1);
    console.log(`  → strong-whale ${pct(hi[1])} vs none ${pct(lo[1])}, spread ${pct(hi[1] - lo[1])} ${hi[1] > lo[1] ? '(right dir)' : '(WRONG dir)'}`);
  }
  process.exit(0);
}
main();
