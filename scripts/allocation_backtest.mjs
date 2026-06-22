/**
 * allocation_backtest.mjs — validate a multi-asset Sharia allocation BEFORE building a UI
 * policy around it. Structural risk/return question, NOT an alpha hunt (no pass/fail gate).
 *
 * POLICY UNDER TEST — a fixed-weight portfolio rebalanced QUARTERLY back to:
 *     50% TASI momentum sleeve · 30% SPUS (US-Sharia equity) · 20% GLD (gold).
 *
 * THE LEGS
 *  - TASI leg = the VALIDATED momentum strategy's own equity curve (the book the user holds),
 *    NOT the ^TASI index. We replay the live combo line-for-line from strategy_validation.mjs /
 *    breadth_test.mjs / exposure_arms_test.mjs (liquid-half ∩ ≥2y, top-quintile of the
 *    mom6-rank + 52wk-high-rank average, equal-weight, monthly/20-session rebalance, Derayah
 *    0.11% RT, COVID carved out) to get a per-period ABS return series. This is approach (a),
 *    the PREFERRED leg.
 *    We ALSO report approach (b): ^TASI index total-return over the same windows — the
 *    conservative floor (the user does NOT hold the index, but it bounds the leg from below).
 *  - US leg  = SPUS daily total return, compounded over each window.
 *  - Gold leg = GLD daily return, compounded over each window.
 *
 * WINDOW — bounded by SPUS inception (2019-12) → 2026-06, ~6.5y. SHORT. Stated as the honest
 * limitation. Everything is point-in-time: the momentum picks use only bars up to the
 * rebalance index; leg returns are realized forward windows.
 *
 * GRID — the momentum engine's natural unit is a non-overlapping 20-session ("monthly")
 * rebalance period on the TASI trading calendar. We align ALL legs to that same monthly grid
 * (each leg's return = compounded daily return between the two calendar dates, mapped into
 * that symbol's own bar index). The multi-asset portfolio rebalances to target weights every
 * 3rd monthly step (~60 sessions ≈ quarterly); weights DRIFT between rebalances; we charge
 * 0.11% on the |traded delta| at each rebalance.
 *
 * METRICS per variant: CAGR, annualized vol, Sharpe (rf=0), maxDrawdown, Calmar.
 * PLUS: rebalancing premium (50/30/20 quarterly-rebalanced return − same-weights buy&hold,
 * no rebalance) and the pairwise correlations of the three legs' per-period returns.
 *
 *   node --experimental-sqlite scripts/allocation_backtest.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';

const H = 20;                         // monthly rebalance grid (sessions)
const REBAL_EVERY = 3;               // every 3rd monthly step = quarterly (~60 sessions)
const MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const REBAL_COST = COST_RT;          // charge on traded delta at each portfolio rebalance
const START = '2019-12-18';          // SPUS inception bounds the common window
const COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const PER_YEAR = 252 / H;            // monthly periods per year

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = (x, d = 2) => (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(d) + '%';
const corr = (a, b) => {
  const n = Math.min(a.length, b.length); if (n < 3) return NaN;
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n));
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; cov += da * db; va += da * da; vb += db * db; }
  return (va && vb) ? cov / Math.sqrt(va * vb) : NaN;
};

// Full risk/return profile from a per-period (H-session) ABS return series.
function profile(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const volA = sd(rets) * Math.sqrt(PER_YEAR);                 // annualized vol
  const sharpe = volA > 0 ? (mean(rets) * PER_YEAR) / volA : NaN;  // rf=0, arithmetic ann. mean / ann. vol
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : (cagr > 0 ? Infinity : NaN);
  return { cagr, volA, sharpe, mdd, calmar, totalReturn: eq - 1, n: rets.length };
}

// ── Momentum leg: replay the live combo, return a Map(rebalanceDate → ABS period return) ──
// Mirrors strategy_validation.mjs / exposure_arms_test.mjs line-for-line on universe/combo/cost.
function buildMomentumLeg(data, cal, usable) {
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };
  const byDate = new Map();
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;            // ≥2y listed, point-in-time
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let hi52 = -Infinity; for (let k = Math.max(0, i - 251); k <= i; k++) hi52 = Math.max(hi52, d.c[k]);
      const wk52 = hi52 > 0 ? d.c[i] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); n++; }
      rows.push({ s, mom6, wk52, liq: liq / n });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    const both = liquid.filter(r => r.wk52 != null);
    const pool = both.length >= 10 ? both : liquid;
    const pctRank = (arr, key) => { const a = [...arr].sort((x, y) => x[key] - y[key]); a.forEach((r, j) => r['_r_' + key] = arr.length > 1 ? j / (arr.length - 1) : 0.5); };
    pctRank(pool, 'mom6');
    if (pool === both) pctRank(pool, 'wk52');
    pool.forEach(r => r.combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6);
    const picks = [...pool].sort((a, b) => b.combo - a.combo).slice(0, Math.max(5, Math.floor(pool.length * 0.2))).map(r => r.s);
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null); if (!rs.length) continue;
    byDate.set(date, mean(rs) - COST_RT);                                    // ABS period return, net of momentum trading cost
  }
  return byDate;
}

// Compounded return of a single symbol's daily closes between two calendar dates [d0, d1].
// Maps the TASI calendar dates into THIS symbol's own bar index (point-in-time, no leak).
function legReturnBetween(sym, idxByDate, closes, d0, d1) {
  let i0 = idxByDate[d0], i1 = idxByDate[d1];
  // If the exact TASI date isn't a trading day for this symbol, snap to the nearest prior bar.
  if (i0 == null) i0 = snapPrior(idxByDate, d0);
  if (i1 == null) i1 = snapPrior(idxByDate, d1);
  if (i0 == null || i1 == null || i1 <= i0) return null;
  return closes[i1] / closes[i0] - 1;
}
// nearest trading bar at or before `date` (uses the sorted date list captured on the symbol)
function snapPrior(idxByDate, date) {
  // idxByDate carries a hidden sorted-dates array for snapping
  const ds = idxByDate.__dates; if (!ds) return null;
  let lo = 0, hi = ds.length - 1, ans = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ds[m] <= date) { ans = idxByDate[ds[m]]; lo = m + 1; } else hi = m - 1; }
  return ans;
}

function loadSym(bars) {
  const dates = bars.map(b => iso(b.t));
  const idx = Object.fromEntries(dates.map((d, i) => [d, i]));
  Object.defineProperty(idx, '__dates', { value: dates, enumerable: false });
  return { dates, c: bars.map(b => b.c), idx };
}

// Portfolio simulation over an aligned per-period leg-return matrix.
// legs: array of { ret:[r per period] } in fixed order; weights: target weights (sum 1).
// rebalanceEvery: rebalance to target every Nth period; cost charged on |traded delta|.
// Returns the per-period portfolio ABS return series.
function simulatePortfolio(legRets, weights, rebalanceEvery, rebalCost) {
  const nLeg = weights.length;
  const nP = Math.min(...legRets.map(l => l.length));
  let w = weights.slice();                  // current drifting weights (start at target)
  const port = [];
  for (let p = 0; p < nP; p++) {
    // grow each sleeve by its period return → portfolio period return + post-drift weights
    let gross = 0; const grown = new Array(nLeg);
    for (let k = 0; k < nLeg; k++) { grown[k] = w[k] * (1 + legRets[k][p]); gross += grown[k]; }
    const portRet = gross - 1;
    // normalize drifted weights
    for (let k = 0; k < nLeg; k++) w[k] = grown[k] / gross;
    // rebalance at the END of every Nth period back to target (charge cost on traded delta)
    let cost = 0;
    if ((p + 1) % rebalanceEvery === 0) {
      let traded = 0; for (let k = 0; k < nLeg; k++) traded += Math.abs(weights[k] - w[k]);
      cost = (traded / 2) * rebalCost;       // turnover = half the L1 delta (buys==sells)
      w = weights.slice();
    }
    port.push(portRet - cost);
  }
  return port;
}

// Buy & hold the same weights, NO rebalance (weights drift forever). For the rebalance premium.
function simulateBuyHold(legRets, weights) {
  const nLeg = weights.length;
  const nP = Math.min(...legRets.map(l => l.length));
  let w = weights.slice();
  const port = [];
  for (let p = 0; p < nP; p++) {
    let gross = 0; const grown = new Array(nLeg);
    for (let k = 0; k < nLeg; k++) { grown[k] = w[k] * (1 + legRets[k][p]); gross += grown[k]; }
    port.push(gross - 1);
    for (let k = 0; k < nLeg; k++) w[k] = grown[k] / gross;
  }
  return port;
}

async function main() {
  console.error('loading universe from cache ...');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR', 'SPUS', 'GLD'), '10y');

  // TASI universe (for the momentum leg) + the index calendar
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  console.error(`usable TASI names: ${usable.length}`);

  const spus = loadSym(await getBars('SPUS', '10y'));
  const gld = loadSym(await getBars('GLD', '10y'));
  const tasiIdx = loadSym(ib);

  // 1) momentum leg → Map(date → period return)
  const momByDate = buildMomentumLeg(data, cal, usable);
  const momDates = [...momByDate.keys()].sort();
  if (momDates.length < 8) { console.error('not enough momentum periods'); process.exit(1); }

  // 2) align ALL legs to the momentum rebalance grid. A "period" runs from momDates[i] to
  //    momDates[i]+H sessions on the TASI calendar — which is exactly the next grid date the
  //    momentum engine steps to. We rebuild the window end as the calendar date H sessions on.
  //    For non-momentum legs we compound that symbol's own daily returns across the window.
  const calIdx = Object.fromEntries(cal.map((d, i) => [d, i]));
  const aligned = [];   // { date, dEnd, mom, spus, gld, tasi }
  for (const d0 of momDates) {
    const i0 = calIdx[d0]; if (i0 == null || i0 + H >= cal.length) continue;
    const d1 = cal[i0 + H];
    const mom = momByDate.get(d0);
    const rS = legReturnBetween('SPUS', spus.idx, spus.c, d0, d1);
    const rG = legReturnBetween('GLD', gld.idx, gld.c, d0, d1);
    const rT = legReturnBetween('^TASI.SR', tasiIdx.idx, tasiIdx.c, d0, d1);
    if (mom == null || rS == null || rG == null || rT == null) continue;
    aligned.push({ date: d0, dEnd: d1, mom, spus: rS, gld: rG, tasi: rT });
  }
  const nP = aligned.length;
  if (nP < 8) { console.error(`only ${nP} aligned periods — too few`); process.exit(1); }

  const momR = aligned.map(a => a.mom);
  const spusR = aligned.map(a => a.spus);
  const gldR = aligned.map(a => a.gld);
  const tasiR = aligned.map(a => a.tasi);

  // ── leg correlations (preferred legs: momentum, SPUS, GLD) ──
  const corMS = corr(momR, spusR), corMG = corr(momR, gldR), corSG = corr(spusR, gldR);
  // also TASI-index vs the equity/gold legs for context
  const corTS = corr(tasiR, spusR), corTG = corr(tasiR, gldR), corMT = corr(momR, tasiR);

  // ── variants ──
  // weights order: [momentum, SPUS, GLD]
  const SPLITS = {
    '50/30/20': [0.50, 0.30, 0.20],
    '70/20/10': [0.70, 0.20, 0.10],
    '35/35/30': [0.35, 0.35, 0.30],
  };
  const legsPreferred = [momR, spusR, gldR];      // momentum leg (a)
  const legsFloor     = [tasiR, spusR, gldR];     // ^TASI index leg (b), conservative floor

  const variants = [];
  // multi-asset splits — preferred (momentum) legs, quarterly rebalanced
  for (const [name, w] of Object.entries(SPLITS)) {
    const port = simulatePortfolio(legsPreferred, w, REBAL_EVERY, REBAL_COST);
    variants.push({ name: `${name} qtr (mom leg)`, ...profile(port), series: port });
  }
  // single-leg / standalone references
  variants.push({ name: 'TASI-momentum ALONE', ...profile(momR), series: momR });
  variants.push({ name: 'SPUS alone', ...profile(spusR), series: spusR });
  variants.push({ name: 'GLD alone', ...profile(gldR), series: gldR });
  variants.push({ name: '^TASI index alone', ...profile(tasiR), series: tasiR });
  // 50/30/20 with the conservative ^TASI-index floor leg (context)
  {
    const port = simulatePortfolio(legsFloor, SPLITS['50/30/20'], REBAL_EVERY, REBAL_COST);
    variants.push({ name: '50/30/20 qtr (TASI-idx floor)', ...profile(port), series: port });
  }

  // ── rebalancing premium: 50/30/20 quarterly-rebalanced vs same-weights buy&hold ──
  const p5030q = simulatePortfolio(legsPreferred, SPLITS['50/30/20'], REBAL_EVERY, REBAL_COST);
  const p5030bh = simulateBuyHold(legsPreferred, SPLITS['50/30/20']);
  const profQ = profile(p5030q), profBH = profile(p5030bh);
  const rebalPremCagr = profQ.cagr - profBH.cagr;
  const rebalPremTotal = profQ.totalReturn - profBH.totalReturn;

  // ── OUTPUT ──
  const span = `${aligned[0].date} → ${aligned.at(-1).dEnd}`;
  const yrs = (nP * H / 252);
  console.log(`\n=== MULTI-ASSET SHARIA ALLOCATION — 50/30/20 TASI-momentum / SPUS / GLD, quarterly ===`);
  console.log(`window: ${span} (~${yrs.toFixed(1)}y, SPUS-bounded — SHORT, the honest limit) | ${nP} monthly periods, rebalance every ${REBAL_EVERY} (~quarterly)`);
  console.log(`legs: momentum = validated combo equity curve (net ${pct(COST_RT)} RT) · SPUS = US-Sharia ETF tot-ret · GLD = gold | rebal cost ${pct(REBAL_COST)} on traded delta | COVID carved out`);
  console.log(`Sharpe rf=0, vol/Sharpe annualized from monthly periods (×√${PER_YEAR.toFixed(1)})\n`);

  const hdr = ['variant', 'CAGR', 'volA', 'Sharpe', 'maxDD', 'Calmar'];
  const widths = [30, 9, 9, 9, 9, 8];
  console.log(hdr.map((h, i) => h.padEnd(widths[i])).join(''));
  for (const v of variants) {
    console.log(
      v.name.padEnd(widths[0]) +
      pct(v.cagr).padEnd(widths[1]) +
      pct(v.volA).padEnd(widths[2]) +
      (isNaN(v.sharpe) ? '—' : v.sharpe.toFixed(2)).padEnd(widths[3]) +
      pct(v.mdd).padEnd(widths[4]) +
      (v.calmar === Infinity ? '∞' : isNaN(v.calmar) ? '—' : v.calmar.toFixed(2)).padEnd(widths[5])
    );
  }

  console.log(`\n── LEG CORRELATIONS (per-period returns) ──`);
  console.log(`  momentum ↔ SPUS   ${corMS.toFixed(2)}`);
  console.log(`  momentum ↔ GLD    ${corMG.toFixed(2)}`);
  console.log(`  SPUS ↔ GLD        ${corSG.toFixed(2)}`);
  console.log(`  (context) ^TASI-idx ↔ SPUS ${corTS.toFixed(2)} | ^TASI-idx ↔ GLD ${corTG.toFixed(2)} | momentum ↔ ^TASI-idx ${corMT.toFixed(2)}`);

  console.log(`\n── REBALANCING PREMIUM (50/30/20, momentum leg) ──`);
  console.log(`  quarterly-rebalanced  CAGR ${pct(profQ.cagr)}  total ${pct(profQ.totalReturn)}  maxDD ${pct(profQ.mdd)}  Sharpe ${profQ.sharpe.toFixed(2)}`);
  console.log(`  buy&hold (no rebal)   CAGR ${pct(profBH.cagr)}  total ${pct(profBH.totalReturn)}  maxDD ${pct(profBH.mdd)}  Sharpe ${profBH.sharpe.toFixed(2)}`);
  console.log(`  rebalancing premium   CAGR ${pct(rebalPremCagr)}/yr  (total ${pct(rebalPremTotal)} over window)`);

  // ── verdict math: 50/30/20 (mom) vs TASI-momentum ALONE ──
  const v5030 = variants.find(v => v.name.startsWith('50/30/20 qtr (mom'));
  const vAlone = variants.find(v => v.name === 'TASI-momentum ALONE');
  console.log(`\n── TRADE: 50/30/20 (mom) vs TASI-momentum ALONE ──`);
  console.log(`  CAGR    ${pct(v5030.cagr)} vs ${pct(vAlone.cagr)}   (Δ ${pct(v5030.cagr - vAlone.cagr)} — raw return given up if negative)`);
  console.log(`  volA    ${pct(v5030.volA)} vs ${pct(vAlone.volA)}   (Δ ${pct(v5030.volA - vAlone.volA)})`);
  console.log(`  maxDD   ${pct(v5030.mdd)} vs ${pct(vAlone.mdd)}   (Δ ${pct(v5030.mdd - vAlone.mdd)} — DD relief if positive)`);
  console.log(`  Sharpe  ${v5030.sharpe.toFixed(2)} vs ${vAlone.sharpe.toFixed(2)}   (Δ ${(v5030.sharpe - vAlone.sharpe).toFixed(2)})`);
  console.log(`  Calmar  ${(v5030.calmar === Infinity ? '∞' : v5030.calmar.toFixed(2))} vs ${(vAlone.calmar === Infinity ? '∞' : vAlone.calmar.toFixed(2))}`);
  // best split by Sharpe / Calmar
  const splitVars = variants.filter(v => v.name.includes('qtr (mom'));
  const bestSharpe = [...splitVars].sort((a, b) => b.sharpe - a.sharpe)[0];
  const bestCalmar = [...splitVars].sort((a, b) => (b.calmar === Infinity ? 1e9 : b.calmar) - (a.calmar === Infinity ? 1e9 : a.calmar))[0];
  console.log(`  best split by Sharpe: ${bestSharpe.name} (${bestSharpe.sharpe.toFixed(2)}) | best by Calmar: ${bestCalmar.name} (${bestCalmar.calmar === Infinity ? '∞' : bestCalmar.calmar.toFixed(2)})`);

  // ── machine-readable ──
  const dump = v => ({ cagr: +(v.cagr * 100).toFixed(2), volA: +(v.volA * 100).toFixed(2), sharpe: +v.sharpe.toFixed(2), maxDD: +(v.mdd * 100).toFixed(1), calmar: v.calmar === Infinity ? null : +v.calmar.toFixed(2) });
  console.log(`\nJSON ${JSON.stringify({
    window: span, years: +yrs.toFixed(2), periods: nP, rebalEvery: REBAL_EVERY, costRt: COST_RT,
    variants: Object.fromEntries(variants.map(v => [v.name, dump(v)])),
    correlations: { mom_spus: +corMS.toFixed(2), mom_gld: +corMG.toFixed(2), spus_gld: +corSG.toFixed(2), tasiIdx_spus: +corTS.toFixed(2), tasiIdx_gld: +corTG.toFixed(2), mom_tasiIdx: +corMT.toFixed(2) },
    rebalancingPremium: { quarterlyCagr: +(profQ.cagr * 100).toFixed(2), buyHoldCagr: +(profBH.cagr * 100).toFixed(2), premiumCagrPct: +(rebalPremCagr * 100).toFixed(2), premiumTotalPct: +(rebalPremTotal * 100).toFixed(2) },
    bestBySharpe: bestSharpe.name, bestByCalmar: bestCalmar.name,
  })}`);
  process.exit(0);
}
main();
