/**
 * momentum_refinements_test.mjs — can we SHARPEN the one validated edge (6-1mo momentum)?
 * Tests two prices-only momentum cousins head-to-head vs the baseline, all through the gate:
 *
 *   baseline  mom6   = cumulative return t-126→t-21 (the validated edge)
 *   idio      = IDIOSYNCRATIC momentum — strip the equal-weight-basket move (CAPM residual over
 *               the formation window) and rank on what's LEFT. Globally cleaner / less crash-prone.
 *   wk52      = 52-WEEK-HIGH proximity — price ÷ 252-day high (closer to 1 = nearer its high).
 *
 * Same harness as momentum_sharia: Sharia-compliant ∩ liquid-half ∩ ≥2y-listed, top-quintile,
 * monthly rebalance, Derayah 0.11% cost, EXCESS vs equal-weight compliant basket. Verdict via the
 * shared portfolioGuillotine (per-period t, the cross-clustering-robust bar momentum cleared).
 * Run: node --experimental-sqlite scripts/momentum_refinements_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { db } from '../dashboard/db.js';
import { mean, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const cum = a => a.reduce((v, r) => v * (1 + r), 1) - 1;
const cagrM = a => Math.pow(1 + cum(a), 12 / a.length) - 1;

async function main() {
  const screener = TASI_STOCKS.map(s => s.sym.replace('TADAWUL:', ''));
  const catalyst = db.prepare("SELECT DISTINCT sym FROM catalyst_events").all().map(r => r.sym.replace('TADAWUL:', '')).filter(s => /^[1-9]\d{3}$/.test(s));
  const compliant = [...new Set([...screener, ...catalyst])].filter(c => getShariaStatus(`TADAWUL:${c}`).status === 'compliant');
  const ysyms = compliant.map(c => c + '.SR');
  console.error(`compliant universe: ${compliant.length}; warming...`);
  await warm(ysyms, '10y');

  const data = {};
  for (const ys of ysyms) {
    const b = await getBars(ys, '10y'); if (b.length < 300) continue;
    const dates = b.map(x => iso(x.t)), c = b.map(x => x.c), v = b.map(x => x.v || 0);
    const dret = c.map((x, i) => i ? x / c[i - 1] - 1 : 0);
    data[ys] = { dates, c, v, dret, idx: Object.fromEntries(dates.map((d, i) => [d, i])) };
  }
  const names = Object.keys(data);
  console.error(`with history: ${names.length}`);

  // daily equal-weight basket return by date (the "market" for idiosyncratic residuals + the benchmark)
  const bAcc = {};
  for (const s of names) { const d = data[s]; for (let i = 1; i < d.dates.length; i++) { const k = d.dates[i]; (bAcc[k] ||= { s: 0, n: 0 }); bAcc[k].s += d.dret[i]; bAcc[k].n++; } }
  const bRetByDate = {}; for (const k in bAcc) if (bAcc[k].n >= 10) bRetByDate[k] = bAcc[k].s / bAcc[k].n;

  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort().filter(d => d in bRetByDate);
  const rebal = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) rebal.push(allDates[i]);

  // idiosyncratic momentum: CAPM residual cumulative over [i-126, i-21] vs the EW basket
  function idioScore(d, i) {
    let sxy = 0, sxx = 0, sx = 0, sy = 0, n = 0;
    for (let k = i - 126; k <= i - 21; k++) { const rb = bRetByDate[d.dates[k]]; if (rb == null) continue; const rs = d.dret[k]; sxy += rs * rb; sxx += rb * rb; sx += rb; sy += rs; n++; }
    if (n < 40) return null;
    const beta = (sxy - sx * sy / n) / (sxx - sx * sx / n || 1e-9);
    let resid = 0; for (let k = i - 126; k <= i - 21; k++) { const rb = bRetByDate[d.dates[k]]; if (rb == null) continue; resid += d.dret[k] - beta * rb; }
    return resid;
  }

  const MINHIST = 504;   // ≥2y
  const series = { mom6: [], idio: [], wk52: [], combo: [] };
  const byYr = { mom6: {}, wk52: {}, combo: {} };
  let nPer = 0, span0 = '9999', span1 = '0';

  for (let ri = 0; ri < rebal.length - 1; ri++) {
    const d0 = rebal[ri], d1 = rebal[ri + 1];
    const rows = [];
    for (const s of names) {
      const d = data[s]; const i = d.idx[d0], j = d.idx[d1];
      if (i == null || j == null || i < MINHIST) continue;
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      const hi = Math.max(...d.c.slice(Math.max(0, i - 251), i + 1));
      const wk52 = hi > 0 ? d.c[i] / hi : null;
      const idio = idioScore(d, i);
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * d.v[k]; n++; }
      rows.push({ s, fwd: d.c[j] / d.c[i] - 1, mom6, wk52, idio, liq: liq / n });
    }
    if (rows.length < 20) continue;
    const basket = mean(rows.map(r => r.fwd));
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    // combo = average percentile-rank of mom6 and wk52 (rank-combine: different scales)
    const withBoth = liquid.filter(r => r.mom6 != null && r.wk52 != null);
    const pctRank = (arr, key) => { const s = [...arr].sort((a, b) => a[key] - b[key]); s.forEach((r, i) => r['_r_' + key] = arr.length > 1 ? i / (arr.length - 1) : 0.5); };
    pctRank(withBoth, 'mom6'); pctRank(withBoth, 'wk52');
    withBoth.forEach(r => r.combo = (r._r_mom6 + r._r_wk52) / 2);
    const qExcess = (key, pool = liquid) => {
      const p = pool.filter(r => r[key] != null); if (p.length < 10) return null;
      const top = [...p].sort((a, b) => b[key] - a[key]).slice(0, Math.max(3, Math.floor(p.length / 5)));
      return (mean(top.map(r => r.fwd)) - COST_RT) - basket;   // net excess vs basket
    };
    const e6 = qExcess('mom6'), ei = qExcess('idio'), ew = qExcess('wk52'), ec = qExcess('combo', withBoth);
    const yr = +d0.slice(0, 4);
    if (e6 != null) { series.mom6.push(e6); (byYr.mom6[yr] ||= []).push(e6); }
    if (ei != null) series.idio.push(ei);
    if (ew != null) { series.wk52.push(ew); (byYr.wk52[yr] ||= []).push(ew); }
    if (ec != null) { series.combo.push(ec); (byYr.combo[yr] ||= []).push(ec); }
    nPer++; if (d0 < span0) span0 = d0; if (d0 > span1) span1 = d0;
  }

  console.log(`\n=== MOMENTUM REFINEMENTS — compliant ∩ liquid-half ∩ ≥2y, top-quintile, monthly ===`);
  console.log(`Span ${span0}→${span1}, ${nPer} periods (~${(nPer / 12).toFixed(1)}y). EXCESS vs equal-weight compliant basket, cost ${pct(COST_RT)} RT.`);
  console.log(`Verdict via shared portfolioGuillotine (per-period t).\n`);
  const order = [['mom6', '6-1mo momentum (baseline)'], ['idio', 'idiosyncratic momentum'], ['wk52', '52-week-high proximity'], ['combo', 'mom6 × wk52 (rank combo)']];
  for (const [k, label] of order) {
    const x = series[k]; const v = portfolioGuillotine(x);
    const mid = Math.floor(x.length / 2);
    const h1 = portfolioGuillotine(x.slice(0, mid), { minPeriods: 12 }), h2 = portfolioGuillotine(x.slice(mid), { minPeriods: 12 });
    console.log(`  ${label.padEnd(28)} excess/pd ${pct(mean(x)).padStart(8)}  CAGR ${pct(cagrM(x)).padStart(8)}  ${v.pass ? 'PASS' : 'fail'} (t ${v.t.toFixed(2)})  | OOS halves t ${h1.t.toFixed(2)} / ${h2.t.toFixed(2)} ${h1.t > 1.5 && h2.t > 1.5 ? '✓' : '⚠'}`);
  }
  console.log(`\n  per-year EXCESS (positive years / total):`);
  for (const [k, label] of [['mom6', '6-1mo'], ['wk52', '52wk-high'], ['combo', 'combo']]) {
    const yrs = Object.keys(byYr[k]).sort();
    const cells = yrs.map(y => `${y.slice(2)}:${pct(mean(byYr[k][y])).replace('%', '')}`);
    const posN = yrs.filter(y => mean(byYr[k][y]) > 0).length;
    console.log(`    ${label.padEnd(10)} ${posN}/${yrs.length} pos  | ${cells.join('  ')}`);
  }
  console.log(`\nRead: a refinement WINS only if it clears the gate AND beats the baseline's t/excess AND is OOS-stable (both halves t>1.5).`);
  process.exit(0);
}
main();
