/**
 * ensemble_stack_test.mjs — SYSTEM-LEVEL validation of an equal-weight signal STACK.
 *
 * The methodology upgrade: stop judging signals in isolation. A signal can clear its own
 * gate yet add nothing to a PORTFOLIO that already runs momentum. The honest unit is the
 * STACK walked-forward: a FIXED equal-weight blend (NO fitted weights) of the per-period
 * monthly EXCESS series of the candidate sleeves, masked to cash in the 2 seasonally-weak
 * months, measured on system Calmar + the guillotine + ABLATION (drop-one).
 *
 * Sleeves (each is the per-period MONTHLY EXCESS vs the SAME equal-weight TASI basket):
 *   - momentum  : top-quintile (6-1mo × 52wk-high rank combo), liquid-half ∩ ≥2y, monthly
 *                 rebalance — replicates dashboard/strategy_validation.mjs (the CORE).
 *   - pead      : conditioned PEAD (Q5 reaction ∩ momentum-aligned ∩ vol-confirmed) drift,
 *                 net excess by month — replicates scripts/pead_conditioned_test.mjs.
 *   - volcont   : volume-shock spike-UP CONTINUATION cohort, non-overlapping H=10 net excess
 *                 by month — replicates the UP leg of scripts/volume_shock_test.mjs.
 *   - seasonality: NOT an additive sleeve. A cash MASK — force the whole book to 0 in the
 *                 2 weakest calendar months (walk-forward, leak-free; same rule as
 *                 scripts/momentum_confirm.mjs weakMonthsBefore).
 *
 * Recomputes each sleeve's series here from the shared primitives (bars_cache, tasi_screener,
 * sharia, pead, index_flow, guillotine) so the existing harnesses are NOT modified. The logic
 * mirrors each harness line-for-line; this script imports no IIFE and breaks nothing.
 *
 * PRE-REGISTERED SYSTEM PASS BAR (committed before looking):
 *   1. combined per-period excess portfolioGuillotine t > 2, AND
 *   2. both halves each t > 1.5, AND
 *   3. system Calmar > buy-and-hold equal-weight basket Calmar in BOTH halves, AND
 *   4. the stack beats MOMENTUM-ALONE on Calmar (else ship momentum solo), AND
 *   5. ABLATION: a non-core sleeve EARNS its place only if removing it LOWERS system OOS Calmar.
 *
 * Reports at 0.11% AND 0.30% RT cost. Fixed round weights only:
 *   primary  = momentum 70% / pead 15% / volcont 15%
 *   robust   = 1/N (33/33/33) — BOTH must look good or it's fragile.
 *
 * Run: node --experimental-sqlite scripts/ensemble_stack_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile } from '../dashboard/pead.mjs';
import { portfolioGuillotine, mean, sd, tstat } from '../dashboard/guillotine.mjs';

// ── shared constants (match the source harnesses) ───────────────────────────
const H = 20, MIN_HISTORY = 210;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const SLIP_SIDE = 0.0015;
const COSTS = [
  { rt: 0.0011, label: '0.11%' },   // Derayah round-trip (primary)
  { rt: 0.0030, label: '0.30%' },   // cost-fragility buffer
];
// PEAD/volcont charge cost+slip per held name; momentum charges RT only (matches each harness).
const pct = x => (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(2) + '%';
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const pos = (s.length - 1) * q; const lo = Math.floor(pos), hi = Math.ceil(pos); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo); };
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12;

// ── Pearson correlation of two aligned arrays ───────────────────────────────
function corr(xs, ys) {
  if (xs.length < 6) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); dx += (xs[k] - mx) ** 2; dy += (ys[k] - my) ** 2; }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : null;
}
// align two month→value maps on common keys
function alignMaps(a, b) {
  const keys = Object.keys(a).filter(k => k in b).sort();
  return { keys, xs: keys.map(k => a[k]), ys: keys.map(k => b[k]) };
}

// CAGR / maxDD / Calmar from a per-period (monthly-ish) ABS return series, compounded.
function equityStats(rets, periodsPerYear) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length / periodsPerYear;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : (cagr > 0 ? Infinity : 0);
  return { cagr, mdd, calmar, totalReturn: eq - 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLEEVE 1 — MOMENTUM (replicates dashboard/strategy_validation.mjs)
// Returns { ex: {month→excess}, abs: {month→absPortfolio}, basket: {month→basketRet} }
// keyed by the calendar month of each 20-session rebalance date. cost = RT only.
// ═══════════════════════════════════════════════════════════════════════════
async function momentumSeries(data, cal, costRt) {
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const ex = {}, abs = {}, basket = {};
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;
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
    const port = mean(rs) - costRt;
    const mk = date.slice(0, 7);
    // one rebalance per ~20 sessions; if two land in same month (rare), keep the latter (overwrite)
    ex[mk] = port - bench; abs[mk] = port; basket[mk] = bench;
  }
  return { ex, abs, basket };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLEEVE 2 — CONDITIONED PEAD (replicates scripts/pead_conditioned_test.mjs)
// Returns { ex: {month→netExcessDrift} }. cost = costRt + 2*slip per held name.
// ═══════════════════════════════════════════════════════════════════════════
async function peadSeries(costRt) {
  const DRIFT_DAYS = 20, LIQUID_FRAC = 0.5, MIN_LISTING = 504;
  const NET = d => d - costRt - 2 * SLIP_SIDE;
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff);
  if (!events.length) return { ex: {}, n: 0 };

  const compliant = TASI_STOCKS.filter(s => getShariaStatus(s.sym).status === 'compliant');
  const compSyms = new Set(compliant.map(s => s.sym));

  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  function abnAligned(nC, bC, iN, jN, iB, jB) {
    if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= bC.length) return null;
    const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
    const rb = (bC[iB] > 0 && bC[jB] > 0) ? bC[jB] / bC[iB] - 1 : null;
    if (rn == null || rb == null) return null;
    return rn - rb;
  }

  const uniBars = {};
  for (const s of compliant) { const b = await getBars(toYahooSym(s.sym), '10y'); if (b && b.length >= 60) uniBars[s.sym] = b; }

  const recs = [];
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) continue;
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) continue;
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    const drift = abnAligned(nC, benchC, aN + 2, aN + 2 + DRIFT_DAYS, aB + 2, aB + 2 + DRIFT_DAYS);
    if (reaction == null || drift == null) continue;
    const trail = []; for (let k = aN - 60; k < aN; k++) if (k >= 0 && nV[k] > 0) trail.push(nV[k]);
    const trailMed = trail.length >= 20 ? median(trail) : NaN;
    const volConfirmed = isFinite(trailMed) && trailMed > 0 ? (nV[aN] || 0) > trailMed : false;
    recs.push({ sym: ev.sym, date: ev.event_date, reaction, drift, volConfirmed, compliant: compSyms.has(ev.sym), monthKey: ev.event_date.slice(0, 7) });
  }

  const rankCache = new Map();
  function comboRanksAt(dateISO) {
    if (rankCache.has(dateISO)) return rankCache.get(dateISO);
    const rows = [];
    for (const s of compliant) {
      const b = uniBars[s.sym]; if (!b) continue;
      const c = b.map(x => x.c), v = b.map(x => x.v || 0), dts = b.map(x => iso(x.t));
      const i = sliceByDate(dts, dateISO);
      const idx = i < 0 ? c.length - 1 : (dts[i] === dateISO ? i : i - 1);
      if (idx < 126 || idx + 1 < MIN_LISTING) continue;
      const mom6 = c[idx - 21] / c[idx - 126] - 1; if (!isFinite(mom6)) continue;
      const hi52 = Math.max(...c.slice(Math.max(0, idx - 251), idx + 1));
      const wk52 = hi52 > 0 ? c[idx] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, idx - 59); k <= idx; k++) { liq += c[k] * (v[k] || 0); n++; }
      rows.push({ sym: s.sym, mom6, wk52, liq: liq / n });
    }
    const m = new Map();
    if (rows.length) {
      const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * LIQUID_FRAC));
      const both = liquid.filter(r => r.wk52 != null);
      const pool = both.length >= 10 ? both : liquid;
      const pctRank = (arr, key) => { const s = [...arr].sort((a, b) => a[key] - b[key]); s.forEach((r, i) => r['_r_' + key] = arr.length > 1 ? i / (arr.length - 1) : 0.5); };
      pctRank(pool, 'mom6');
      if (pool === both) pctRank(pool, 'wk52');
      pool.forEach(r => { const combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6; m.set(r.sym, combo); });
    }
    rankCache.set(dateISO, m);
    return m;
  }

  const tradeable = recs.filter(r => r.compliant);
  const bp = quantileBreakpoints(tradeable.map(r => r.reaction));
  const q5 = tradeable.filter(r => assignQuintile(r.reaction, bp) === 4);
  const conditioned = [];
  for (const r of q5) {
    const ranks = comboRanksAt(r.date);
    const combo = ranks.get(r.sym);
    if (combo != null && combo >= 0.5 && r.volConfirmed) conditioned.push(r);
  }

  const byMonth = {};
  for (const r of conditioned) (byMonth[r.monthKey] ||= []).push(r);
  const ex = {};
  for (const k of Object.keys(byMonth)) ex[k] = mean(byMonth[k].map(r => NET(r.drift)));
  return { ex, n: conditioned.length };
}

// ═══════════════════════════════════════════════════════════════════════════
// SLEEVE 3 — VOLUME-SHOCK spike-UP CONTINUATION (replicates volume_shock_test.mjs UP leg)
// Returns { ex: {month→netExcess} } at primary H=10, non-overlapping per name.
// cost = costRt + 2*slip per held name.
// ═══════════════════════════════════════════════════════════════════════════
async function volContSeries(costRt) {
  const MEDIAN_LB = 60, MIN_HIST = 504, PRIMARY_H = 10;
  const VOL_MULT = 3, RET_Q = 0.90;   // primary spec
  const COST_TOTAL = costRt + 2 * SLIP_SIDE;

  const screener = TASI_STOCKS.map(s => s.sym.replace('TADAWUL:', ''));
  let catalyst = [];
  try { catalyst = db.prepare("SELECT DISTINCT sym FROM catalyst_events").all().map(r => r.sym.replace('TADAWUL:', '')).filter(s => /^[1-9]\d{3}$/.test(s)); } catch {}
  const allCodes = [...new Set([...screener, ...catalyst])];
  const compliant = allCodes.filter(c => getShariaStatus(`TADAWUL:${c}`).status === 'compliant');
  const ysyms = compliant.map(c => c + '.SR');

  const benchBars = await getBars('^TASI.SR', '10y');
  const benchClose = {}; for (const b of benchBars) benchClose[iso(b.t)] = b.c;
  const benchDates = benchBars.map(b => iso(b.t));
  const benchIdx = Object.fromEntries(benchDates.map((d, i) => [d, i]));

  const data = {};
  for (const ys of ysyms) {
    const b = await getBars(ys, '10y');
    if (b.length < MIN_HIST + 100) continue;
    data[ys] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v || 0) };
  }
  const names = Object.keys(data);
  const liqOf = {};
  for (const s of names) { const a = data[s]; const dv = a.c.map((c, i) => c * a.v[i]).filter(x => x > 0); liqOf[s] = median(dv); }
  const liqSorted = [...names].sort((x, y) => liqOf[y] - liqOf[x]);
  const liquidHalf = new Set(liqSorted.slice(0, Math.ceil(liqSorted.length / 2)));
  const universe = names.filter(s => liquidHalf.has(s));

  function fwdAbnormal(s, i, h) {
    const a = data[s]; const j = i + h; if (j >= a.c.length) return null;
    const nameRet = a.c[j] / a.c[i] - 1;
    const di = a.dates[i], dj = a.dates[j];
    if (benchIdx[di] == null || benchIdx[dj] == null) return null;
    const benchRet = benchClose[dj] / benchClose[di] - 1;
    return nameRet - benchRet;
  }

  const up = [];
  for (const s of universe) {
    const a = data[s];
    const rets = a.c.map((c, i) => i === 0 ? 0 : c / a.c[i - 1] - 1);
    for (let i = MIN_HIST; i < a.c.length - 5; i++) {
      const volWin = a.v.slice(i - MEDIAN_LB, i).filter(v => v > 0);
      if (volWin.length < MEDIAN_LB * 0.7) continue;
      const medVol = median(volWin);
      if (!(medVol > 0) || !(a.v[i] > VOL_MULT * medVol)) continue;
      const priorAbs = rets.slice(1, i).map(Math.abs).filter(x => x > 0);
      if (priorAbs.length < 100) continue;
      const cut = quantile(priorAbs, RET_Q);
      const r = rets[i];
      if (!(Math.abs(r) >= cut)) continue;
      const v = fwdAbnormal(s, i, PRIMARY_H);
      if (v == null) continue;
      if (r > 0) up.push({ s, i, date: a.dates[i], abn: v });   // spike-UP = CONTINUATION cohort
    }
  }

  // non-overlapping per name (greedy by date, skip within H), monthly net-excess buckets
  const byName = {};
  for (const e of up) (byName[e.s] ||= []).push(e);
  const taken = [];
  for (const s of Object.keys(byName)) {
    const arr = byName[s].sort((a, b) => a.i - b.i);
    let lastI = -Infinity;
    for (const e of arr) { if (e.i - lastI >= PRIMARY_H) { taken.push(e); lastI = e.i; } }
  }
  const buckets = {};
  for (const e of taken) { const mk = e.date.slice(0, 7); (buckets[mk] ||= []).push(e.abn - COST_TOTAL); }
  const ex = {};
  for (const mk of Object.keys(buckets)) ex[mk] = mean(buckets[mk]);
  return { ex, n: taken.length };
}

// walk-forward 2-weakest calendar months by basket monthly return (leak-free).
// returns a function isWeak(monthKey 'YYYY-MM') using only data from PRIOR years.
function weakMonthMaskBuilder(basketByMonth) {
  const years = [...new Set(Object.keys(basketByMonth).map(k => +k.slice(0, 4)))].sort();
  const year0 = years[0];
  function weakMonthsBefore(Y) {
    const byM = {};
    for (const [k, v] of Object.entries(basketByMonth)) { const yr = +k.slice(0, 4), mo = +k.slice(5, 7); if (yr < Y) (byM[mo] ||= []).push(v); }
    const ms = Object.entries(byM).map(([m, a]) => [+m, mean(a)]).sort((a, b) => a[1] - b[1]);
    return new Set(ms.slice(0, 2).map(e => e[0]));
  }
  const cache = new Map();
  return function isWeak(monthKey) {
    const yr = +monthKey.slice(0, 4), mo = +monthKey.slice(5, 7);
    if (yr <= year0) return false;                       // year0 = no overlay (no prior history)
    if (!cache.has(yr)) cache.set(yr, weakMonthsBefore(yr));
    return cache.get(yr).has(mo);
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM BUILDER — blend aligned sleeve series with fixed weights + seasonal mask.
// monthsAll = sorted union of momentum's months (the rebalance calendar). Sleeves
// contribute 0 in months they have no signal. The seasonal mask zeroes the whole
// month (cash). Returns { excSeries, absSeries, months } for guillotine + Calmar.
// periodsPerYear derived from momentum cadence (≈12.6 rebalances/yr at H=20).
// ═══════════════════════════════════════════════════════════════════════════
function buildSystem({ momEx, momBasket, peadEx, volEx, weights, isWeak }) {
  const months = Object.keys(momEx).sort();             // momentum defines the rebalance calendar
  const excSeries = [], absSeries = [];
  for (const mk of months) {
    if (isWeak(mk)) { excSeries.push(0); absSeries.push(0); continue; }   // cash this month
    const m = momEx[mk] ?? 0;
    const p = (mk in peadEx) ? peadEx[mk] : 0;
    const v = (mk in volEx) ? volEx[mk] : 0;
    const sysEx = weights.mom * m + weights.pead * p + weights.vol * v;
    const basket = momBasket[mk] ?? 0;
    excSeries.push(sysEx);
    absSeries.push(sysEx + basket);                     // absolute = system excess + basket return
  }
  return { months, excSeries, absSeries };
}

function halves(series) {
  const mid = Math.floor(series.length / 2);
  return { h1: series.slice(0, mid), h2: series.slice(mid) };
}

function tableRow(name, excSeries, absSeries, ppy) {
  const g = portfolioGuillotine(excSeries, { abs: absSeries, minT: 2 });
  const { h1, h2 } = halves(excSeries);
  const eq = equityStats(absSeries, ppy);
  return {
    name,
    cagr: eq.cagr, maxDD: eq.mdd, calmar: eq.calmar,
    excPd: mean(excSeries), t: g.t, h1t: tstat(h1), h2t: tstat(h2),
    pass: g.pass, n: excSeries.length,
  };
}

function printTable(rows, basketCalmarBy) {
  const hdr = ['variant', 'CAGR', 'maxDD', 'Calmar', 'exc/pd', 't', 'h1_t', 'h2_t', 'gate'];
  const w = [34, 8, 8, 8, 8, 7, 7, 7, 6];
  console.log(hdr.map((h, i) => h.padEnd(w[i])).join(''));
  for (const r of rows) {
    console.log(
      r.name.padEnd(w[0]) +
      pct(r.cagr).padEnd(w[1]) + pct(r.maxDD).padEnd(w[2]) +
      (isFinite(r.calmar) ? r.calmar.toFixed(2) : '∞').padEnd(w[3]) +
      pct(r.excPd).padEnd(w[4]) +
      (isNaN(r.t) ? '—' : r.t.toFixed(2)).padEnd(w[5]) +
      (isNaN(r.h1t) ? '—' : r.h1t.toFixed(2)).padEnd(w[6]) +
      (isNaN(r.h2t) ? '—' : r.h2t.toFixed(2)).padEnd(w[7]) +
      (r.pass ? 'PASS' : 'fail').padEnd(w[8])
    );
  }
}

async function main() {
  console.error('loading TASI universe from cache ...');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  // shared momentum data structure (also used for the basket + seasonal mask)
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));

  // ── STEP 1: correlation matrix (cost-independent → use 0.11% sleeves) ──
  const mom011 = await momentumSeries(data, cal, 0.0011);
  const pead011 = await peadSeries(0.0011);
  const vol011 = await volContSeries(0.0011);

  console.log(`\n#########################################################################`);
  console.log(`# ENSEMBLE STACK — system-level validation (Sharia TASI)`);
  console.log(`#########################################################################`);
  console.log(`\nsleeve sample sizes:`);
  console.log(`  momentum  : ${Object.keys(mom011.ex).length} monthly rebalances`);
  console.log(`  pead      : ${Object.keys(pead011.ex).length} active months (${pead011.n} conditioned events)`);
  console.log(`  volcont   : ${Object.keys(vol011.ex).length} active months (${vol011.n} non-overlap trades)`);

  // pairwise correlation aligned by calendar month (intersection)
  const pairs = [
    ['momentum', 'pead', mom011.ex, pead011.ex],
    ['momentum', 'volcont', mom011.ex, vol011.ex],
    ['pead', 'volcont', pead011.ex, vol011.ex],
  ];
  console.log(`\n── STEP 1: CORRELATION MATRIX (monthly excess, aligned by calendar month) ──`);
  const cmat = {};
  for (const [a, b, ma, mb] of pairs) {
    const { keys, xs, ys } = alignMaps(ma, mb);
    const c = corr(xs, ys);
    cmat[`${a}~${b}`] = { rho: c, n: keys.length };
    console.log(`  ${a.padEnd(9)} ~ ${b.padEnd(9)}  rho = ${c == null ? '— (n<6)' : c.toFixed(3)}   (n=${keys.length} common months)`);
  }
  // diversification ratio for the 3-sleeve system: Sharpe_sys/Sharpe_single ≈ √(N/(1+(N-1)ρ̄))
  const rhos = Object.values(cmat).map(c => c.rho).filter(c => c != null);
  const rhoBar = rhos.length ? mean(rhos) : null;
  const N = 3;
  const divRatio = rhoBar != null ? Math.sqrt(N / (1 + (N - 1) * rhoBar)) : null;
  console.log(`\n  mean pairwise rho ρ̄ = ${rhoBar == null ? '—' : rhoBar.toFixed(3)}`);
  console.log(`  diversification ratio √(N/(1+(N-1)ρ̄)), N=3 = ${divRatio == null ? '—' : divRatio.toFixed(3)}×`);
  console.log(`  interpretation: ρ̄<0.3 strong ensemble case | 0.3-0.5 modest | >0.5 weak`);

  // periods/year for the system equity curve (momentum cadence: ~20 sessions ≈ 252/20)
  const PPY = 252 / H;

  // ── basket buy&hold (the Calmar comparator) — abs = basket monthly return ──
  const basketAbsByMonth = mom011.basket;
  const basketMonths = Object.keys(basketAbsByMonth).sort();
  const basketAbs = basketMonths.map(k => basketAbsByMonth[k]);
  const basketZeroExc = basketMonths.map(() => 0);   // basket excess vs itself = 0 (for table shape)

  // seasonal weak-month mask (walk-forward) from basket monthly returns
  const isWeak = weakMonthMaskBuilder(basketAbsByMonth);
  const weakKeys = basketMonths.filter(isWeak);
  console.log(`\n  seasonal mask (walk-forward 2-weakest months): ${weakKeys.length} masked months e.g. ${weakKeys.slice(0, 4).join(',') || '—'}`);

  // ── STEP 2: build + grade systems at each cost, primary + 1/N weights ──
  const WEIGHTS = {
    'primary (70/15/15)': { mom: 0.70, pead: 0.15, vol: 0.15 },
    '1/N (33/33/33)': { mom: 1 / 3, pead: 1 / 3, vol: 1 / 3 },
  };

  // ablation drop-sets: each removes one sleeve, renormalizing remaining weights to sum 1.
  function ablate(weights, drop) {
    const w = { ...weights };
    if (drop) w[drop] = 0;
    const s = w.mom + w.pead + w.vol;
    return s > 0 ? { mom: w.mom / s, pead: w.pead / s, vol: w.vol / s } : w;
  }

  for (const cost of COSTS) {
    console.log(`\n=========================================================================`);
    console.log(`#  COST ${cost.label} RT  (+ ${(SLIP_SIDE * 100).toFixed(2)}%/side slip on pead/volcont)`);
    console.log(`=========================================================================`);

    // recompute sleeves at this cost (momentum basket is cost-shifted but identical shape)
    const momEx = cost.rt === 0.0011 ? mom011 : await momentumSeries(data, cal, cost.rt);
    const peadEx = cost.rt === 0.0011 ? pead011 : await peadSeries(cost.rt);
    const volEx = cost.rt === 0.0011 ? vol011 : await volContSeries(cost.rt);

    // basket comparator (cost-free buy&hold of the equal-weight basket)
    const bRow = tableRow('basket buy&hold (equal-weight)', basketZeroExc, basketAbs, PPY);
    const bH = halves(basketAbs);
    const bCalmarH1 = equityStats(bH.h1, PPY).calmar, bCalmarH2 = equityStats(bH.h2, PPY).calmar;

    // momentum-alone (masked) — the thing the stack must beat
    const momAlone = buildSystem({ momEx: momEx.ex, momBasket: momEx.basket, peadEx: {}, volEx: {}, weights: { mom: 1, pead: 0, vol: 0 }, isWeak });
    const momRow = tableRow('momentum-alone (masked)', momAlone.excSeries, momAlone.absSeries, PPY);

    for (const [wname, weights] of Object.entries(WEIGHTS)) {
      console.log(`\n── weights: ${wname} ──`);
      const full = buildSystem({ momEx: momEx.ex, momBasket: momEx.basket, peadEx: peadEx.ex, volEx: volEx.ex, weights, isWeak });
      const fullRow = tableRow('full-stack', full.excSeries, full.absSeries, PPY);

      // ablations (drop-one), renormalized
      const abPead = buildSystem({ momEx: momEx.ex, momBasket: momEx.basket, peadEx: {}, volEx: volEx.ex, weights: ablate(weights, 'pead'), isWeak });
      const abVol = buildSystem({ momEx: momEx.ex, momBasket: momEx.basket, peadEx: peadEx.ex, volEx: {}, weights: ablate(weights, 'vol'), isWeak });
      const abPeadRow = tableRow('ablate −pead (mom+vol)', abPead.excSeries, abPead.absSeries, PPY);
      const abVolRow = tableRow('ablate −vol (mom+pead)', abVol.excSeries, abVol.absSeries, PPY);

      printTable([bRow, momRow, fullRow, abPeadRow, abVolRow], {});

      // OOS Calmar (both halves) for the ablation verdict
      const fH = halves(full.absSeries);
      const fullCalmarH1 = equityStats(fH.h1, PPY).calmar, fullCalmarH2 = equityStats(fH.h2, PPY).calmar;
      const apH = halves(abPead.absSeries), avH = halves(abVol.absSeries);
      const abPeadCalmarH2 = equityStats(apH.h2, PPY).calmar;
      const abVolCalmarH2 = equityStats(avH.h2, PPY).calmar;
      const fullCalmarH2v = fullCalmarH2;

      // ── PRE-REGISTERED BAR ──
      const c1 = fullRow.t > 2;
      const c2 = fullRow.h1t > 1.5 && fullRow.h2t > 1.5;
      const c3 = fullCalmarH1 > bCalmarH1 && fullCalmarH2 > bCalmarH2;
      const c4 = fullRow.calmar > momRow.calmar;
      // ablation: a sleeve EARNS its place iff removing it LOWERS full OOS(H2) Calmar
      const peadEarns = abPeadCalmarH2 < fullCalmarH2v;
      const volEarns = abVolCalmarH2 < fullCalmarH2v;

      console.log(`\n  PRE-REGISTERED BAR [${wname}, ${cost.label}]:`);
      console.log(`    [${c1 ? 'PASS' : 'FAIL'}] full-stack guillotine t > 2 ......... t=${fullRow.t.toFixed(2)}`);
      console.log(`    [${c2 ? 'PASS' : 'FAIL'}] both halves t > 1.5 ................ h1=${fullRow.h1t.toFixed(2)} h2=${fullRow.h2t.toFixed(2)}`);
      console.log(`    [${c3 ? 'PASS' : 'FAIL'}] system Calmar > basket BOTH halves .. sys ${fullCalmarH1.toFixed(2)}/${fullCalmarH2.toFixed(2)} vs basket ${bCalmarH1.toFixed(2)}/${bCalmarH2.toFixed(2)}`);
      console.log(`    [${c4 ? 'PASS' : 'FAIL'}] stack Calmar > momentum-alone ...... ${fullRow.calmar.toFixed(2)} vs ${momRow.calmar.toFixed(2)}`);
      console.log(`    ABLATION (OOS H2 Calmar, drop-one):`);
      console.log(`      full H2 Calmar ${fullCalmarH2v.toFixed(2)}`);
      console.log(`      [${peadEarns ? 'EARNS' : 'cut '}] pead: −pead H2 Calmar ${abPeadCalmarH2.toFixed(2)} ${peadEarns ? '<' : '≥'} ${fullCalmarH2v.toFixed(2)} ${peadEarns ? '(removal hurts → keep)' : '(removal doesn\'t hurt → cut)'}`);
      console.log(`      [${volEarns ? 'EARNS' : 'cut '}] vol : −vol  H2 Calmar ${abVolCalmarH2.toFixed(2)} ${volEarns ? '<' : '≥'} ${fullCalmarH2v.toFixed(2)} ${volEarns ? '(removal hurts → keep)' : '(removal doesn\'t hurt → cut)'}`);

      const barPass = c1 && c2 && c3 && c4;
      const anyEarns = peadEarns || volEarns;
      console.log(`    => bar ${barPass ? 'CLEARED' : 'NOT cleared'}; non-core sleeves surviving ablation: ${[peadEarns && 'pead', volEarns && 'vol'].filter(Boolean).join('+') || 'NONE'}`);
      console.log(`    => VERDICT: ${barPass && anyEarns ? 'SYSTEM > momentum-alone — ship the stack' : 'run MOMENTUM-SOLO — sleeves do not add up'}`);
    }
  }

  console.log(`\n#########################################################################`);
  console.log(`# See docs/research/2026-06-22-ensemble-stack.md for the written verdict.`);
  console.log(`#########################################################################`);
  process.exit(0);
}
main();
