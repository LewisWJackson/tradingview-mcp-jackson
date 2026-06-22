/**
 * contract_flow_test.mjs — do GOVT/Vision-2030 contract awards to LIQUID TASI companies drift up
 * over 20 trading days? Reaction to forced/under-reacted megaproject flow (alt-data layer #4).
 *
 * ⚠️ SUPERSEDED — DO NOT TRUST THIS SCRIPT'S "SIGNAL" VERDICT. It measures drift vs ^TASI (the
 * condemned cap-weighted benchmark) and runs NW-t on the POOLED list of overlapping, calendar-
 * clustered events. Newey-West removes serial — NOT cross-sectional — correlation, the exact trap
 * that made the dead 9-pt score's pooled t=3.89 look real (honest per-period t=0.74). When re-run
 * through the proper per-period guillotine (equal-weight basket, one obs / non-overlapping window),
 * the govt∩liquid t collapses 2.94→0.90 and the govt−private spread vanishes to +0.09% (t 0.09).
 * Contract-flow is NOT a validated edge. The authoritative test is contract_flow_guillotine_test.mjs.
 * Kept only as the documented record of how the pooled-NW result was wrong.
 *
 * For each matured 'contract' catalyst (anti-leakage gated): classify counterparty (govt|private),
 * compute trailing-60d liquidity, keep the top-half-liquid set, measure 20d forward abnormal drift
 * [+1,+21] vs ^TASI. Compare govt vs private. Net 0.11% RT + slippage. NW-t, trim-one.
 * Run: node --experimental-sqlite scripts/contract_flow_test.mjs
 * Spec: docs/superpowers/specs/2026-06-21-contract-flow-design.md
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { mean } from '../dashboard/pead.mjs';
import { classifyCounterparty, isContractHeadline } from '../dashboard/contract_flow.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = +process.env.DRIFT_DAYS || 20;
const MIN_N = +process.env.MIN_N || 30;
function nwT(x, L = 5) {
  const n = x.length; if (n < 3) return NaN;
  const m = mean(x), e = x.map(v => v - m);
  let v = e.reduce((s, q) => s + q * q, 0) / n;
  for (let l = 1; l <= L; l++) { let g = 0; for (let t = l; t < n; t++) g += e[t] * e[t - l]; g /= n; v += 2 * (1 - l / (L + 1)) * g; }
  const se = Math.sqrt(v / n); return se > 0 ? m / se : NaN;
}
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;

function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}
function report(label, arr) {
  const d = arr.map(r => r.drift);
  const net = d.length ? mean(d) - COST_RT - 2 * SLIP : NaN;
  console.log(`  ${label.padEnd(16)} n=${String(arr.length).padStart(3)}  drift ${pct(mean(d)).padStart(7)}  net ${pct(net).padStart(7)}  NW-t ${(nwT(d) || 0).toFixed(2)}`);
  return { netMean: net, raw: d };
}

(async () => {
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date, headline FROM catalyst_events WHERE type='contract'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff && isContractHeadline(r.headline));
  if (!events.length) { console.log('No matured contract-award events found.'); process.exit(0); }

  const syms = [...new Set(events.map(e => e.sym))];
  await warm(syms.map(toYahooSym).concat('^TASI.SR'), '10y');
  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  const recs = []; let skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 90) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0 || aN < 60) { skipped++; continue; }
    const drift = abnAligned(nC, benchC, aN + 1, aN + 1 + DRIFT_DAYS, aB + 1, aB + 1 + DRIFT_DAYS);
    if (drift == null) { skipped++; continue; }
    let liq = 0, m = 0; for (let k = aN - 59; k <= aN; k++) { liq += nC[k] * nV[k]; m++; }
    recs.push({ sym: ev.sym, date: ev.event_date, drift, liq: liq / m, cp: classifyCounterparty(ev.headline) });
  }

  console.log(`\nContract-flow study — contract events ${events.length}, used ${recs.length}, skipped ${skipped}`);
  console.log(`drift [+1,+${1 + DRIFT_DAYS}] vs ^TASI; cost ${(COST_RT * 100).toFixed(2)}% RT + slip ${(SLIP * 100).toFixed(2)}%/side\n`);

  // liquidity filter: keep top half by trailing liquidity
  const sorted = [...recs].sort((a, b) => b.liq - a.liq);
  const liquid = sorted.slice(0, Math.ceil(sorted.length / 2));
  const govt = liquid.filter(r => r.cp === 'govt'), priv = liquid.filter(r => r.cp === 'private');

  console.log('ALL CONTRACTS (matured, award-gated):');
  report('all', recs);
  console.log('\nLIQUID HALF, by counterparty:');
  const g = report('govt/Vision-2030', govt);
  const p = report('private', priv);
  const spread = (g.raw.length && p.raw.length) ? mean(g.raw) - mean(p.raw) : NaN;
  console.log(`  govt − private spread: ${pct(spread)}`);

  // trim-one on govt
  if (govt.length > 3) {
    const trims = govt.map((_, i) => mean(govt.filter((__, j) => j !== i).map(r => r.drift)));
    console.log(`  govt trim-one drift range: ${pct(Math.min(...trims))} … ${pct(Math.max(...trims))}`);
  }

  console.log('\nVERDICT (govt/Vision-2030, liquid):');
  if (govt.length < MIN_N) {
    console.log(`  UNDERPOWERED — only ${govt.length} liquid govt awards (<${MIN_N}); not reliable. Harvest more contract history.`);
  } else {
    const tstat = nwT(govt.map(r => r.drift));
    console.log(`  pooled-NW: net drift ${pct(g.netMean)}, NW-t ${(tstat || 0).toFixed(2)}, beats private ${spread > 0}.`);
    console.log(`  ⚠️ This pooled-NW number is INFLATED by cross-sectional clustering + the ^TASI benchmark.`);
    console.log(`  Authoritative verdict = contract_flow_guillotine_test.mjs: per-period t 0.90, spread t 0.09 → NOT an edge.`);
  }
})();
