/**
 * score_ladder_test.mjs — does the FULL score ladder sort forward returns in order?
 * If the 9-pt score is real, STRONG BUY > BUY > WATCH > … > SELL > STRONG SELL in
 * forward 20-session return. Tests ranking power even if STRONG BUY alone loses money.
 *
 * No lookahead (score from bars[0..t], measure t→t+20). ABSOLUTE and EXCESS-vs-equal-
 * weight-basket. Overlap-corrected: one observation per stock per 20 sessions.
 *
 * Run: node scripts/score_ladder_test.mjs
 */
import {
  fetchYahooOHLCV, toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
} from './tasi_screener.mjs';

const H = 20, MIN_HISTORY = 210;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const t = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';

function signalAt(bars, idx, indexChange63d) {
  const slc = (arr) => arr.slice(0, idx + 1);
  const closes = slc(bars.closes), highs = slc(bars.highs), lows = slc(bars.lows), volumes = slc(bars.volumes);
  if (closes.length < 50) return null;
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
  return scoreBias(emas, rsiVal, macdData, volData, price, 'swing', rsScore,
    { srLevels, avgVolume: avgVolume20, rsScore60d: rsScore, isExtended: extension > 25, vwap20, obv_trend, isTasi: true });
}

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  console.error(`fetching ${syms.length} symbols ...`);
  const data = {};
  for (const sym of syms) {
    try { const b = await fetchYahooOHLCV(toYahooSym(sym), '1d', 520); if (b.length < MIN_HISTORY) continue;
      const dates = b.map(x => iso(x.time));
      data[sym] = { dates, closes: b.map(x => x.close), highs: b.map(x => x.high), lows: b.map(x => x.low), volumes: b.map(x => x.volume), dateIdx: Object.fromEntries(dates.map((d, i) => [d, i])) };
    } catch {}
  }
  const ib = await fetchYahooOHLCV('^TASI.SR', '1d', 520);
  const idxDates = ib.map(x => iso(x.time)), idxClose = ib.map(x => x.close);
  const usable = Object.keys(data);
  console.error(`usable: ${usable.length}`);

  const ewCache = {};
  const ew = (date) => { if (date in ewCache) return ewCache[date]; const rs = []; for (const s of usable) { const d = data[s]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) continue; rs.push(d.closes[i + H] / d.closes[i] - 1); } return ewCache[date] = rs.length ? mean(rs) : null; };

  const lastTestable = idxDates.length - 1 - H;
  const firstTestable = Math.max(MIN_HISTORY, idxDates.length - 252 - H);
  const buckets = {};  // bias -> { abs:[], exc:[] }
  const lastUsed = {};
  for (let di = firstTestable; di <= lastTestable; di++) {
    const date = idxDates[di];
    const indexChange63d = di >= 63 ? (idxClose[di] - idxClose[di - 63]) / idxClose[di - 63] * 100 : null;
    for (const sym of usable) {
      const d = data[sym]; const i = d.dateIdx[date];
      if (i == null || i < MIN_HISTORY || i + H >= d.closes.length) continue;
      if (lastUsed[sym] != null && i - lastUsed[sym] < H) continue;     // overlap-corrected
      const scored = signalAt(d, i, indexChange63d);
      if (!scored) continue;
      const bench = ew(date); if (bench == null) continue;
      const r = d.closes[i + H] / d.closes[i] - 1;
      (buckets[scored.bias] ||= { abs: [], exc: [] });
      buckets[scored.bias].abs.push(r); buckets[scored.bias].exc.push(r - bench);
      lastUsed[sym] = i;
    }
  }

  const order = ['STRONG BUY', 'BUY', 'WATCH', 'SKIP', 'AVOID', 'SELL', 'STRONG SELL'];
  console.log(`\n=== SCORE LADDER — forward ${H}-session return by bias (overlap-corrected, no lookahead) ===`);
  console.log(`  ${'bias'.padEnd(12)} ${'n'.padStart(5)}  ${'ABSOLUTE'.padStart(9)} ${'t'.padStart(6)}   ${'EXCESS'.padStart(8)} ${'t'.padStart(6)}`);
  const absMeans = [];
  for (const b of order) {
    const bk = buckets[b]; if (!bk || !bk.abs.length) { console.log(`  ${b.padEnd(12)} ${'0'.padStart(5)}  (none)`); continue; }
    absMeans.push([b, mean(bk.abs)]);
    console.log(`  ${b.padEnd(12)} ${String(bk.abs.length).padStart(5)}  ${pct(mean(bk.abs)).padStart(9)} ${String(t(bk.abs)).padStart(6)}   ${pct(mean(bk.exc)).padStart(8)} ${String(t(bk.exc)).padStart(6)}`);
  }
  // monotonicity: does ABSOLUTE decrease down the ladder?
  let mono = true; for (let i = 1; i < absMeans.length; i++) if (absMeans[i][1] > absMeans[i - 1][1] + 0.0001) mono = false;
  const sbi = absMeans.find(x => x[0] === 'STRONG BUY'), ssi = absMeans.find(x => x[0] === 'STRONG SELL');
  console.log(`\n  Ladder sorts in order (STRONG BUY highest → STRONG SELL lowest)? ${mono ? 'YES — score has ranking power' : 'NO — score does not cleanly rank outcomes'}`);
  if (sbi && ssi) console.log(`  STRONG BUY ${pct(sbi[1])} vs STRONG SELL ${pct(ssi[1])} — spread ${pct(sbi[1] - ssi[1])} ${sbi[1] > ssi[1] ? '(right direction)' : '(WRONG direction)'}`);
  process.exit(0);
}
main();
