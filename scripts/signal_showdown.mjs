/**
 * signal_showdown.mjs — head-to-head, SAME honest test for all four signals.
 *
 * Every signal is traded as a PORTFOLIO with ONE observation per non-overlapping
 * 20-session rebalance (kills cross-sectional correlation — the inflation that made the
 * 9-pt score look real). Same equal-weight all-universe basket benchmark, same Derayah
 * 0.11% RT cost, window 2020-01-01→today with COVID [2020-02-20..2021-03-31] carved out.
 *
 * Signals:
 *   1. 9-pt STRONG BUY   — all names flagged STRONG BUY that date
 *   2. Momentum (Sharia) — compliant ∩ liquid-top-50% ∩ ≥2y-listed, top-quintile 6-1mo mom
 *   3. Whale watch        — whale_score ≥ 6 that date
 *   4. Block deals        — names with a BIG premium/at-market deal in the prior 20 sessions
 *   + Basket (all)        — the benchmark itself, for reference
 *
 * Honest unit = the rebalance period. t-stat on the per-period series (this is the t that
 * matters — it already absorbs cross-name clustering). Run: node scripts/signal_showdown.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import {
  toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
  calcMFI, calcVolumeZScore,
} from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { mean, sd, tstat, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';

function calcWhaleScore(mfi, obvTrend, volRatio, zScore, bias) {
  const bear = ['STRONG SELL', 'SELL', 'AVOID'].includes(bias); let s = 0;
  if (mfi != null) { if (!bear && mfi > 80) s += 3; else if (!bear && mfi > 65) s += 2; else if (!bear && mfi > 55) s += 1; if (bear && mfi < 20) s += 3; else if (bear && mfi < 35) s += 2; else if (bear && mfi < 45) s += 1; }
  if ((!bear && obvTrend === 'rising') || (bear && obvTrend === 'falling')) s += 2;
  if (zScore != null) { if (zScore > 3) s += 3; else if (zScore > 2) s += 2; else if (zScore > 1.5) s += 1; }
  if (volRatio >= 5) s += 2; else if (volRatio >= 3) s += 1;
  return s;
}
function biasWhaleAt(d, i, ic) {
  const c = d.closes.slice(0, i + 1), h = d.highs.slice(0, i + 1), l = d.lows.slice(0, i + 1), v = d.volumes.slice(0, i + 1);
  if (c.length < 64) return null;
  const price = c.at(-1);
  const emas = { ema13: emaArray(c, 13).at(-1), ema34: emaArray(c, 34).at(-1), ema89: emaArray(c, 89).at(-1), ema200: emaArray(c, 200).at(-1) };
  const volData = volumeCheck(v, true);
  const rsScore = c.length >= 64 ? Math.round(((price - c.at(-64)) / c.at(-64) * 100 - ic) * 100) / 100 : null;
  const obv = calcOBVTrend(c, v, 20);
  const bias = scoreBias(emas, calcRsi(c, 14), macdHist(c), volData, price, 'swing', rsScore,
    { srLevels: findSRLevels(h, l, c, 5), avgVolume: v.slice(-20).reduce((a, b) => a + (b || 0), 0) / 20, rsScore60d: rsScore, isExtended: ((price - Math.min(...c.slice(-21))) / Math.min(...c.slice(-21)) * 100) > 25, vwap20: calcVWAP(h, l, c, v, 20), obv_trend: obv, isTasi: true }).bias;
  const whale = calcWhaleScore(calcMFI(h, l, c, v, 14), obv, volData.ratio, calcVolumeZScore(v, 20), bias);
  return { bias, whale };
}

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  await warm([...syms.map(toYahooSym), '^TASI.SR'], '10y');
  const data = {}, compliant = new Set();
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[s.sym] = { dates, closes: b.map(x => x.c), highs: b.map(x => x.h), lows: b.map(x => x.l), volumes: b.map(x => x.v), dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])) };
    if (getShariaStatus(s.sym).status === 'compliant') compliant.add(s.sym);
  }
  const ib = await getBars('^TASI.SR', '10y');
  const idxClose = ib.map(x => x.c), idxIdx = Object.fromEntries(ib.map((x, i) => [iso(x.t), i]));
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);

  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const ewC = {};
  const ew = (date) => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  // block-deal events (BIG, premium/at-market)
  const { events } = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'block_deals_signed.json'), 'utf8'));
  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const bigDeals = [];
  for (const e of events) {
    if (e.value < medVal || !e.price) continue; const d = data[e.sym]; if (!d) continue;
    const i = d.dates.findIndex(x => x >= e.date); if (i < 0) continue;
    const prem = e.price / d.closes[i] - 1; if (prem < -0.001 || Math.abs(prem) > 0.10) continue;
    bigDeals.push({ sym: e.sym, date: e.date });
  }

  // per-period collectors
  const S = { score: [], mom: [], whale: [], block: [], basket: [] };
  const Sx = { score: [], mom: [], whale: [], block: [], basket: [] };
  const sizes = { score: [], mom: [], whale: [], block: [] };
  let nPer = 0, span0 = '9999', span1 = '0';

  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci];
    if (date < START || inCovid(date)) continue;
    if (idxIdx[date] == null || idxIdx[date] < 63) continue;
    const ic = (idxClose[idxIdx[date]] - idxClose[idxIdx[date] - 63]) / idxClose[idxIdx[date] - 63] * 100;
    const bench = ew(date); if (bench == null) continue;

    // compute bias/whale once per name; momentum inputs too
    const scorePick = [], whalePick = [], momRows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.dateIdx[date]; if (i == null || i < MIN_HISTORY || i + H >= d.closes.length) continue;
      const bw = biasWhaleAt(d, i, ic);
      if (bw) { if (bw.bias === 'STRONG BUY') scorePick.push(s); if (bw.whale >= 6) whalePick.push(s); }
      // momentum eligibility: compliant, ≥504d listed, i≥126
      if (compliant.has(s) && i >= 504 && i >= 126) {
        const mom6 = d.closes[i - 21] / d.closes[i - 126] - 1;
        if (isFinite(mom6)) { let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.closes[k] * (d.volumes[k] || 0); n++; } momRows.push({ s, mom6, liq: liq / n }); }
      }
    }
    // momentum: liquid top 50% then top quintile by mom
    const liquid = [...momRows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(momRows.length * 0.5));
    const ranked = [...liquid].sort((a, b) => b.mom6 - a.mom6);
    const momPick = ranked.slice(0, Math.max(5, Math.floor(ranked.length * 0.2))).map(r => r.s);
    // block deals active in trailing 20 sessions (≈ deal date within prior H trading days)
    const lo = cal[Math.max(0, ci - H)] || START;
    const blockPick = [...new Set(bigDeals.filter(b => b.date > lo && b.date <= date).map(b => b.sym))].filter(s => data[s]);

    const port = (picks) => { const rs = picks.map(s => fwd(s, date)).filter(r => r != null); return rs.length ? mean(rs) - COST_RT : null; };
    const add = (key, picks) => { const p = port(picks); if (p != null) { S[key].push(p); Sx[key].push(p - bench); sizes[key].push(picks.length); } };
    add('score', scorePick); add('mom', momPick); add('whale', whalePick); if (blockPick.length) add('block', blockPick);
    S.basket.push(bench - COST_RT); Sx.basket.push(0);
    nPer++; if (date < span0) span0 = date; if (date > span1) span1 = date;
  }

  const ddOf = a => { let eq = 1, pk = 1, mdd = 0; for (const r of a) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); } return mdd; };
  const cagr = a => a.length ? Math.pow(1 + mean(a), 252 / H) - 1 : NaN;
  const winx = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

  console.log(`\n=== SIGNAL SHOWDOWN — same test, all signals as portfolios (one obs / ${H}-session rebalance) ===`);
  console.log(`Span ${span0}→${span1}, COVID carved out, ${nPer} periods (~${(nPer * H / 252).toFixed(1)}y). Benchmark = equal-weight all-universe basket. Cost ${pct(COST_RT)} RT.`);
  console.log(`\n  ${'signal'.padEnd(16)} ${'per'.padStart(4)} ${'avgN'.padStart(5)}  ${'ABS/pd'.padStart(7)} ${'~CAGR'.padStart(7)}  ${'EXCESS/pd'.padStart(9)} ${'t-exc'.padStart(6)} ${'win'.padStart(5)} ${'maxDD'.padStart(7)}`);
  const order = [['mom', 'Momentum-Sharia'], ['score', '9-pt STRONG BUY'], ['whale', 'Whale ≥6'], ['block', 'Block deals'], ['basket', 'Basket (all)']];
  for (const [k, label] of order) {
    const a = S[k], x = Sx[k]; if (!a.length) { console.log(`  ${label.padEnd(16)} (no data)`); continue; }
    const an = sizes[k] ? mean(sizes[k]).toFixed(0) : '—';
    console.log(`  ${label.padEnd(16)} ${String(a.length).padStart(4)} ${String(an).padStart(5)}  ${pct(mean(a)).padStart(7)} ${pct(cagr(a)).padStart(7)}  ${pct(mean(x)).padStart(9)} ${(k === 'basket' ? '—' : tstat(x).toFixed(2)).padStart(6)} ${winx(x).padStart(5)} ${pct(ddOf(a)).padStart(7)}`);
  }
  console.log(`\n  PASS bar: EXCESS t > 2 AND positive ABS. This t already absorbs cross-name clustering (the 9-pt killer).`);

  // Authoritative verdict via the SHARED gate (dashboard/guillotine.mjs) — the one bar for all signals.
  console.log(`\n  === portfolioGuillotine verdicts ===`);
  for (const [k, label] of order) {
    if (k === 'basket' || !S[k].length) continue;
    const v = portfolioGuillotine(Sx[k], { abs: S[k] });
    console.log(`  ${label.padEnd(16)} ${v.reason}`);
  }
  process.exit(0);
}
main();
