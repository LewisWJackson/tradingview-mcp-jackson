/**
 * seasonality_guillotine_test.mjs — audit the seasonal overlay under the shared gate, for
 * consistency with momentum / block-deals / contract-flow.
 *
 * IMPORTANT: seasonality is a DIFFERENT CLASS — a portfolio-TIMING overlay (sit out the 2
 * historically-weakest calendar months, hold the equal-weight basket otherwise), not a
 * cross-sectional stock-pick. So the gate here tests its RETURN claim: does avoiding the weak
 * months add a SIGNIFICANT monthly return vs always-invested? Its actual validated claim is
 * DRAWDOWN reduction (OOS walk-forward, seasonality_test.mjs) — the gate does NOT measure that,
 * so a return-gate FAIL is EXPECTED and not a refutation; it just confirms seasonality is a
 * drawdown tool, not a return engine. We report both: the return gate AND the DD comparison.
 *
 * Per-month unit (non-overlapping) = the cross-clustering-robust series. Weak-2-months chosen
 * in-sample (generous — gives the return claim its best shot). Run:
 *   node --experimental-sqlite scripts/seasonality_guillotine_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { mean, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function maxDD(rets) { let v = 1, p = 1, dd = 0; for (const r of rets) { v *= 1 + r; if (v > p) p = v; const d = v / p - 1; if (d < dd) dd = d; } return dd; }
const cagrM = a => Math.pow(a.reduce((v, r) => v * (1 + r), 1), 12 / a.length) - 1;

async function main() {
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)), '10y');
  // daily equal-weight basket return
  const acc = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (b.length < 30) continue;
    for (let i = 1; i < b.length; i++) { const r = b[i].c / b[i - 1].c - 1; if (!isFinite(r)) continue; const d = iso(b[i].t); (acc[d] ||= { s: 0, n: 0 }); acc[d].s += r; acc[d].n++; }
  }
  const days = Object.keys(acc).filter(d => acc[d].n >= 10).sort();
  // compound daily → monthly basket returns
  const mAcc = new Map();
  for (const d of days) { const k = d.slice(0, 7); mAcc.set(k, (mAcc.get(k) ?? 1) * (1 + acc[d].s / acc[d].n)); }
  const months = [...mAcc.keys()].sort();
  const bRet = months.map(k => mAcc.get(k) - 1);          // basket monthly returns
  const calMon = months.map(k => +k.slice(5, 7));

  // weak-2 calendar months (in-sample, generous)
  const byCal = {}; for (let m = 1; m <= 12; m++) byCal[m] = [];
  bRet.forEach((r, i) => byCal[calMon[i]].push(r));
  const calMean = Object.entries(byCal).map(([m, a]) => [+m, mean(a)]).sort((x, y) => x[1] - y[1]);
  const weak = new Set(calMean.slice(0, 2).map(e => e[0]));

  // seasonal strategy monthly returns: cash (0) in weak months, basket otherwise; cost on each transition
  let invested = true; const sRet = [];
  for (let i = 0; i < bRet.length; i++) {
    const inWeak = weak.has(calMon[i]);
    const wantInvested = !inWeak;
    let r = wantInvested ? bRet[i] : 0;
    if (wantInvested !== invested) { r -= COST_RT; invested = wantInvested; }   // transition cost
    sRet.push(r);
  }
  const excess = sRet.map((r, i) => r - bRet[i]);        // per-month excess vs always-invested basket

  console.log(`\n=== SEASONALITY under the gate (monthly, ${months[0]}→${months.at(-1)}, ${months.length} months) ===`);
  console.log(`Weak-2 months sat out (in-sample): ${[...weak].map(m => MONTHS[m]).join(', ')}. Benchmark = always-invested equal-weight basket. Cost ${pct(COST_RT)}/transition.\n`);
  console.log(`  basket:    CAGR ${pct(cagrM(bRet)).padStart(8)}  maxDD ${pct(maxDD(bRet)).padStart(8)}`);
  console.log(`  seasonal:  CAGR ${pct(cagrM(sRet)).padStart(8)}  maxDD ${pct(maxDD(sRet)).padStart(8)}`);
  console.log(`  Δ:         CAGR ${pct(cagrM(sRet) - cagrM(bRet)).padStart(8)}  maxDD ${pct(maxDD(sRet) - maxDD(bRet)).padStart(8)} (less-negative = drawdown REDUCED)\n`);

  const vIS = portfolioGuillotine(excess, { minPeriods: 24 });
  console.log(`RETURN gate — IN-SAMPLE (weak months chosen from the FULL history → data-mined, optimistic):`);
  console.log(`  ${vIS.reason}\n`);

  // ── OOS: choose the weak-2 months each month using ONLY prior data (expanding window) ──
  const WARM = 36;   // need ~3y before the first honest decision
  let invO = true; const sRetO = [];
  for (let i = 0; i < bRet.length; i++) {
    if (i < WARM) { sRetO.push(bRet[i]); continue; }
    const by = {}; for (let m = 1; m <= 12; m++) by[m] = [];
    for (let j = 0; j < i; j++) by[calMon[j]].push(bRet[j]);
    const wk = new Set(Object.entries(by).map(([m, a]) => [+m, mean(a)]).sort((x, y) => x[1] - y[1]).slice(0, 2).map(e => e[0]));
    const want = !wk.has(calMon[i]);
    let r = want ? bRet[i] : 0; if (want !== invO) { r -= COST_RT; invO = want; }
    sRetO.push(r);
  }
  const exO = sRetO.map((r, i) => r - bRet[i]).slice(WARM);
  const bO = bRet.slice(WARM), sO = sRetO.slice(WARM);
  console.log(`OOS (weak-2 fit on prior years only, ${exO.length} test months):`);
  console.log(`  basket   CAGR ${pct(cagrM(bO)).padStart(8)}  maxDD ${pct(maxDD(bO)).padStart(8)}`);
  console.log(`  seasonal CAGR ${pct(cagrM(sO)).padStart(8)}  maxDD ${pct(maxDD(sO)).padStart(8)}  (Δ CAGR ${pct(cagrM(sO) - cagrM(bO))}, Δ maxDD ${pct(maxDD(sO) - maxDD(bO))})`);
  const vOOS = portfolioGuillotine(exO, { minPeriods: 24 });
  console.log(`  RETURN gate (OOS, honest): ${vOOS.reason}`);

  console.log(`\nVERDICT: in-sample the overlay clears the return gate (t ${vIS.t.toFixed(2)}) but that's data-mined. OOS-honest: ${vOOS.pass ? 'STILL passes the return gate' : 'does NOT clear the return gate'} (t ${vOOS.t.toFixed(2)}). Either way its robust, OOS-validated value is DRAWDOWN reduction (Δ maxDD above). Scope it as a drawdown overlay${vOOS.pass ? ' with a real OOS return kicker' : ' — not a standalone return edge'}.`);
  process.exit(0);
}
main();
