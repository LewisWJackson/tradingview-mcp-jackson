/**
 * strongbuy_portfolio_test.mjs — the decisive test for the STRONG BUY finding.
 *
 * Pooled stock-level obs (1749) are NOT independent: many names flip STRONG BUY on the
 * same date, so cross-sectional correlation inflates t. The honest unit is the REBALANCE
 * DATE: on each non-overlapping date (step 20 sessions), buy an equal-weight basket of
 * every STRONG BUY name, hold 20 sessions, net cost. Compare to the equal-weight basket
 * of the whole universe. One observation per period → ~65 obs over 5 years. t on that.
 *
 * Window 2020-01-01→today, COVID [2020-02-20..2021-03-31] carved out.
 * Run: node scripts/strongbuy_portfolio_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import {
  toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
} from './tasi_screener.mjs';

const H = 20, MIN_HISTORY = 210;
const COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';

function biasAt(d, i, indexChange63d) {
  const closes = d.closes.slice(0, i + 1), highs = d.highs.slice(0, i + 1), lows = d.lows.slice(0, i + 1), volumes = d.volumes.slice(0, i + 1);
  if (closes.length < 64) return null;
  const price = closes.at(-1);
  const emas = { ema13: emaArray(closes, 13).at(-1), ema34: emaArray(closes, 34).at(-1), ema89: emaArray(closes, 89).at(-1), ema200: emaArray(closes, 200).at(-1) };
  const rsiVal = calcRsi(closes, 14), macdData = macdHist(closes), volData = volumeCheck(volumes, true);
  const rsScore = closes.length >= 64 ? Math.round(((price - closes.at(-64)) / closes.at(-64) * 100 - indexChange63d) * 100) / 100 : null;
  const srLevels = findSRLevels(highs, lows, closes, 5);
  const avgVolume20 = volumes.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20;
  const low20d = closes.length >= 21 ? Math.min(...closes.slice(-21)) : price;
  const extension = low20d > 0 ? (price - low20d) / low20d * 100 : 0;
  return scoreBias(emas, rsiVal, macdData, volData, price, 'swing', rsScore,
    { srLevels, avgVolume: avgVolume20, rsScore60d: rsScore, isExtended: extension > 25, vwap20: calcVWAP(highs, lows, closes, volumes, 20), obv_trend: calcOBVTrend(closes, volumes, 20), isTasi: true }).bias;
}

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  await warm([...syms.map(toYahooSym), '^TASI.SR'], '10y');
  const data = {};
  for (const sym of syms) {
    const b = await getBars(toYahooSym(sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[sym] = { dates, closes: b.map(x => x.c), highs: b.map(x => x.h), lows: b.map(x => x.l), volumes: b.map(x => x.v), dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const idxClose = ib.map(x => x.c), idxIdx = Object.fromEntries(ib.map((x, i) => [iso(x.t), i]));
  const usable = Object.keys(data);

  // master trading-day calendar = index dates
  const cal = ib.map(x => iso(x.t));
  const calIdx = Object.fromEntries(cal.map((d, i) => [d, i]));

  // forward H-return for a sym entering at calendar date (uses that sym's own bars)
  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const ewBasket = (date) => { const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return rs.length ? mean(rs) : null; };

  const sbExc = [], sbAbs = [], sizes = [];   // per-period
  let nPeriods = 0;
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {       // non-overlapping rebalance dates
    const date = cal[ci];
    if (date < START || inCovid(date)) continue;
    if (calIdx[date] < 63) continue;
    const ic = (idxClose[calIdx[date]] - idxClose[calIdx[date] - 63]) / idxClose[calIdx[date] - 63] * 100;
    const picks = [];
    for (const s of usable) { const i = data[s].dateIdx[date]; if (i == null || i < MIN_HISTORY || i + H >= data[s].closes.length) continue; if (biasAt(data[s], i, ic) === 'STRONG BUY') picks.push(s); }
    if (!picks.length) continue;
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null);
    if (!rs.length) continue;
    const bench = ewBasket(date); if (bench == null) continue;
    const port = mean(rs) - COST_RT;
    sbAbs.push(port); sbExc.push(port - bench); sizes.push(picks.length); nPeriods++;
  }

  const yrs = nPeriods * H / 252;
  const cagrAbs = Math.pow(1 + mean(sbAbs), 252 / H) - 1;
  const cagrBench = sbExc.length ? Math.pow(1 + mean(sbAbs.map((a, i) => a - sbExc[i])), 252 / H) - 1 : NaN;
  console.log(`\n=== STRONG BUY as a PORTFOLIO — one obs per non-overlapping ${H}-session rebalance ===`);
  console.log(`Span 2020→today, COVID carved out. Periods: ${nPeriods} (~${yrs.toFixed(1)}y). Avg names/period: ${mean(sizes).toFixed(1)}. Cost ${(COST_RT * 100).toFixed(2)}% RT.`);
  console.log(`  ABSOLUTE  per-period ${pct(mean(sbAbs))}  t=${tstat(sbAbs).toFixed(2)}   annualized ≈ ${pct(cagrAbs)}`);
  console.log(`  EXCESS    per-period ${pct(mean(sbExc))}  t=${tstat(sbExc).toFixed(2)}   (basket ≈ ${pct(cagrBench)}/yr)`);
  const winAbs = sbAbs.filter(x => x > 0).length / sbAbs.length, winExc = sbExc.filter(x => x > 0).length / sbExc.length;
  console.log(`  win-rate  abs ${(winAbs * 100).toFixed(0)}%   excess-beats-basket ${(winExc * 100).toFixed(0)}%`);
  // worst drawdown of compounded abs
  let eq = 1, peak = 1, mdd = 0; for (const r of sbAbs) { eq *= 1 + r; peak = Math.max(peak, eq); mdd = Math.min(mdd, eq / peak - 1); }
  console.log(`  worst peak-to-trough (compounded, period granularity): ${pct(mdd)}`);
  console.log(`\n  Verdict: ${tstat(sbExc) > 2 && mean(sbAbs) > 0 ? 'SURVIVES date-clustering — STRONG BUY has real selection power.' : 'FAILS once cross-sectional correlation removed — pooled t was inflated.'}`);
  process.exit(0);
}
main();
