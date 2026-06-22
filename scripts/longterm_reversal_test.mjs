/**
 * longterm_reversal_test.mjs — VALUE via price (DeBondt–Thaler long-term reversal). The academic
 * price-only proxy for "cheapness": 3–5-year LOSERS tend to outperform (mean-reversion of
 * over-extrapolated bad news), skipping the last 12 months so it doesn't just short momentum.
 *
 * Why this and not P/B: rigorous value needs POINT-IN-TIME book value, and the free fundamentals
 * history is too thin to gate (recon 2026-06-22). Long-term reversal is fully backtestable with
 * the 10y bars in hand and is LOW-CORRELATED with momentum (winners 6-12mo vs losers 3-5yr) — so
 * if it clears the gate it's a genuine INDEPENDENT 2nd factor to pair with the momentum combo.
 *
 * Formation = return from t-LOOKBACK to t-12mo. LONG the bottom quintile (biggest losers). Same
 * harness as momentum: compliant ∩ liquid-half, top-quintile size, monthly, excess vs EW basket,
 * Derayah cost, verdict via portfolioGuillotine. Run:
 *   node --experimental-sqlite scripts/longterm_reversal_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { db } from '../dashboard/db.js';
import { mean, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SKIP = 252;   // skip last 12 months (don't contaminate with momentum)
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const cum = a => a.reduce((v, r) => v * (1 + r), 1) - 1;
const cagrM = a => Math.pow(1 + cum(a), 12 / a.length) - 1;

async function main() {
  const screener = TASI_STOCKS.map(s => s.sym.replace('TADAWUL:', ''));
  const catalyst = db.prepare("SELECT DISTINCT sym FROM catalyst_events").all().map(r => r.sym.replace('TADAWUL:', '')).filter(s => /^[1-9]\d{3}$/.test(s));
  const compliant = [...new Set([...screener, ...catalyst])].filter(c => getShariaStatus(`TADAWUL:${c}`).status === 'compliant');
  console.error(`compliant universe: ${compliant.length}; warming...`);
  await warm(compliant.map(c => c + '.SR'), '10y');

  const data = {};
  for (const c of compliant) {
    const b = await getBars(c + '.SR', '10y'); if (b.length < 400) continue;
    const px = b.map(x => x.c), v = b.map(x => x.v || 0), dates = b.map(x => iso(x.t));
    data[c] = { px, v, dates, idx: Object.fromEntries(dates.map((d, i) => [d, i])) };
  }
  const names = Object.keys(data);
  console.error(`with history: ${names.length}`);
  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort();
  const rebal = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) rebal.push(allDates[i]);

  const corr = (a, b) => { const n = Math.min(a.length, b.length); if (n < 3) return NaN; const x = a.slice(0, n), y = b.slice(0, n); const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy || 1e-9); };
  function run(LOOKBACK, label) {
    const losers = [], winners = [], momS = []; const byYrL = {};
    let nPer = 0, span0 = '9999', span1 = '0';
    for (let ri = 0; ri < rebal.length - 1; ri++) {
      const d0 = rebal[ri], d1 = rebal[ri + 1]; const rows = [];
      for (const s of names) {
        const a = data[s]; const i = a.idx[d0], j = a.idx[d1];
        if (i == null || j == null || i < LOOKBACK) continue;
        const ltr = a.px[i - SKIP] / a.px[i - LOOKBACK] - 1;   // long-term past return, skip last 12mo
        const mom6 = a.px[i - 21] / a.px[i - 126] - 1;          // for independence check vs momentum
        if (!isFinite(ltr) || !isFinite(mom6)) continue;
        let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += a.px[k] * a.v[k]; n++; }
        rows.push({ s, fwd: a.px[j] / a.px[i] - 1, ltr, mom6, liq: liq / n });
      }
      if (rows.length < 20) continue;
      const basket = mean(rows.map(r => r.fwd));
      const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
      const k = Math.max(3, Math.floor(liquid.length / 5));
      const sorted = [...liquid].sort((a, b) => a.ltr - b.ltr);   // ascending: losers first
      const lo = sorted.slice(0, k), hi = sorted.slice(-k);
      const momTop = [...liquid].sort((a, b) => b.mom6 - a.mom6).slice(0, k);
      losers.push((mean(lo.map(r => r.fwd)) - COST_RT) - basket);
      winners.push((mean(hi.map(r => r.fwd)) - COST_RT) - basket);
      momS.push((mean(momTop.map(r => r.fwd)) - COST_RT) - basket);
      (byYrL[+d0.slice(0, 4)] ||= []).push(losers.at(-1));
      nPer++; if (d0 < span0) span0 = d0; if (d0 > span1) span1 = d0;
    }
    const vL = portfolioGuillotine(losers), vW = portfolioGuillotine(winners);
    const mid = Math.floor(losers.length / 2);
    const h1 = portfolioGuillotine(losers.slice(0, mid), { minPeriods: 12 }), h2 = portfolioGuillotine(losers.slice(mid), { minPeriods: 12 });
    const yrs = Object.keys(byYrL).sort(), posN = yrs.filter(y => mean(byYrL[y]) > 0).length;
    console.log(`\n── ${label}: ${nPer} periods (${span0}→${span1}, ~${(nPer / 12).toFixed(1)}y) ──`);
    console.log(`  LOSERS (the value bet) excess/pd ${pct(mean(losers)).padStart(8)}  CAGR ${pct(cagrM(losers)).padStart(8)}  ${vL.pass ? 'PASS' : 'fail'} (t ${vL.t.toFixed(2)})  OOS halves ${h1.t.toFixed(2)}/${h2.t.toFixed(2)} ${h1.t > 1.5 && h2.t > 1.5 ? '✓' : '⚠'}  pos yrs ${posN}/${yrs.length}`);
    console.log(`  winners (contrast)     excess/pd ${pct(mean(winners)).padStart(8)}  t ${vW.t.toFixed(2)}`);
    console.log(`  corr(losers, momentum) = ${corr(losers, momS).toFixed(2)}  ${Math.abs(corr(losers, momS)) < 0.3 ? '→ INDEPENDENT of momentum (good diversifier)' : '→ correlated with momentum (limited diversification)'}`);
    return losers;
  }

  console.log(`\n=== LONG-TERM REVERSAL (value-via-price) — compliant ∩ liquid-half, bottom-quintile losers, monthly ===`);
  console.log(`Formation = return [t-LOOKBACK → t-12mo], skip last 12mo. EXCESS vs EW basket, cost ${pct(COST_RT)} RT. Gate = portfolioGuillotine.`);
  run(756, '3-year formation (t-36mo→t-12mo)');
  run(1260, '5-year formation (t-60mo→t-12mo)');
  console.log(`\nRead: a real value factor = LOSERS clear the gate (t>2) AND beat winners. If losers fail, value-via-price doesn't work on TASI.`);
  process.exit(0);
}
main();
