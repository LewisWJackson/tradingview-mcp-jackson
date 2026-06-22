/**
 * momentum_sharia.mjs — AVENUE 4 final form for the ACCOUNT'S REAL constraints:
 *   • Sharia-COMPLIANT universe only (status=='compliant' in dashboard/sharia.mjs; 'unknown'
 *     and 'review' EXCLUDED — conservative, binding-before). Real compliant set is ≥ this.
 *   • Derayah cost = 0.11% round-trip (regulatory only; 0 brokerage). Buffer 0.30% also shown.
 *   • Established names only (≥2y listed — exclude fresh-IPO momentum noise).
 *   • liquid-half filter (tradeable names), mom6 top-quintile, monthly rebalance.
 *
 * Reports ABS return + excess vs equal-weight (compliant) basket, Newey-West t, OOS halves.
 * Run: node --experimental-sqlite scripts/momentum_sharia.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { db } from '../dashboard/db.js';
import { mean, sd, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const cum = a => a.reduce((v, r) => v * (1 + r), 1) - 1;
const cagrM = a => Math.pow(1 + cum(a), 12 / a.length) - 1;
const sharpe = a => +(mean(a) / sd(a) * Math.sqrt(12)).toFixed(2);
function maxDD(rets) { let v = 1, p = 1, dd = 0; for (const r of rets) { v *= 1 + r; if (v > p) p = v; const d = v / p - 1; if (d < dd) dd = d; } return dd; }
function nwT(a, lag = 3) { const N = a.length; if (N < lag + 2) return NaN; const m = mean(a), e = a.map(x => x - m); let v = e.reduce((s, x) => s + x * x, 0) / N; for (let k = 1; k <= lag; k++) { let g = 0; for (let i = k; i < N; i++) g += e[i] * e[i - k]; g /= N; v += 2 * (1 - k / (lag + 1)) * g; } return +(m / Math.sqrt(v / N)).toFixed(2); }
const mom6 = (c, i) => (i >= 126 ? c[i - 21] / c[i - 126] - 1 : null);

async function main() {
  const screener = TASI_STOCKS.map(s => s.sym.replace('TADAWUL:', ''));
  const catalyst = db.prepare("SELECT DISTINCT sym FROM catalyst_events").all().map(r => r.sym.replace('TADAWUL:', '')).filter(s => /^[1-9]\d{3}$/.test(s));
  const allCodes = [...new Set([...screener, ...catalyst])];
  const compliant = allCodes.filter(c => getShariaStatus(`TADAWUL:${c}`).status === 'compliant');
  const ysyms = compliant.map(c => c + '.SR');
  console.error(`compliant universe: ${compliant.length} of ${allCodes.length} codes; warming...`);
  await warm(ysyms, '10y');

  const data = {};
  for (const ys of ysyms) { const b = await getBars(ys, '10y'); if (b.length < 200) continue; data[ys] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v), idx: null }; data[ys].idx = Object.fromEntries(data[ys].dates.map((d, i) => [d, i])); }
  const names = Object.keys(data);
  console.error(`compliant w/ price history: ${names.length}`);

  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort();
  const rebal = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) rebal.push(allDates[i]);
  rebal.push(allDates.at(-1));

  function buildIntervals(minHist) {
    const ivs = [];
    for (let ri = 0; ri < rebal.length - 1; ri++) {
      const d0 = rebal[ri], d1 = rebal[ri + 1]; const rows = [];
      for (const s of names) { const a = data[s]; const i = a.idx[d0], j = a.idx[d1]; if (i == null || j == null || i < minHist) continue; const m = mom6(a.c, i); if (m == null || !isFinite(m)) continue; let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += a.c[k] * (a.v[k] || 0); n++; } rows.push({ s, fwd: a.c[j] / a.c[i] - 1, mom: m, liq: liq / n }); }
      if (rows.length < 20) continue;
      ivs.push({ basket: mean(rows.map(r => r.fwd)), names: rows, breadth: rows.length });
    }
    return ivs;
  }
  let intervals, basketM;
  function quintile(keepFrac) {
    const abs = [], turn = []; let prev = new Set();
    for (const iv of intervals) {
      let pool = iv.names;
      if (keepFrac < 1) { const sorted = [...iv.names].sort((a, b) => b.liq - a.liq); const keep = new Set(sorted.slice(0, Math.ceil(sorted.length * keepFrac)).map(r => r.s)); pool = iv.names.filter(r => keep.has(r.s)); }
      if (pool.length < 10) { abs.push(iv.basket); turn.push(0); continue; }
      const sorted = [...pool].sort((a, b) => b.mom - a.mom); const top = sorted.slice(0, Math.max(3, Math.floor(sorted.length / 5)));
      const set = new Set(top.map(r => r.s)); let ch = 0; for (const s of set) if (!prev.has(s)) ch++; turn.push(set.size ? ch / set.size : 0); prev = set; abs.push(mean(top.map(r => r.fwd)));
    }
    return { abs, turn };
  }
  function report(label, abs, turn) {
    for (const RT of [0.0011, 0.0030]) {
      const cm = mean(turn) * RT, net = abs.map(x => x - cm), ex = net.map((x, i) => x - basketM[i]);
      const mid = Math.floor(ex.length / 2); const oos = mean(ex.slice(0, mid)) > 0 && mean(ex.slice(mid)) > 0;
      // ex = per-month (non-overlapping) excess series → the cross-clustering-robust unit the gate wants.
      const gate = portfolioGuillotine(ex, { abs: net });
      console.log(`  ${label.padEnd(13)} cost ${RT === 0.0011 ? '0.11%(Derayah)' : '0.30%(buffer) '}: ABS CAGR ${pct(cagrM(net)).padStart(8)}  maxDD ${pct(maxDD(net)).padStart(8)}  Sharpe ${String(sharpe(net)).padStart(4)}  excess ${pct(mean(ex) * 12).padStart(8)}/yr  NWt ${String(nwT(ex)).padStart(5)}  OOS ${oos ? 'Y' : 'n'}  GATE ${gate.pass ? 'PASS' : 'fail'}(t ${gate.t.toFixed(2)})`);
    }
  }

  console.log(`\n=== AVENUE 4 — SHARIA-COMPLIANT universe, Derayah cost — ${names.length} names ===`);
  for (const minHist of [504, 756]) {
    intervals = buildIntervals(minHist); basketM = intervals.map(iv => iv.basket);
    console.log(`\n── ≥${(minHist / 252).toFixed(0)}y listed: ${intervals.length} months, avg breadth ${mean(intervals.map(iv => iv.breadth)).toFixed(0)}/mo | compliant basket CAGR ${pct(cagrM(basketM))} maxDD ${pct(maxDD(basketM))} ──`);
    const lh = quintile(0.5);
    report('all-compliant', quintile(1).abs, quintile(1).turn);
    report('liquid-half', lh.abs, lh.turn);
  }
  process.exit(0);
}
main();
