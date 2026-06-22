/**
 * pead_hardening_test.mjs — PRE-REGISTERED cost-robustness hardening for CONDITIONED PEAD.
 *
 * Context: scripts/pead_conditioned_test.mjs PASSED the gate at 0.11% RT (n=118, guillotine
 * per-period t 2.14, both seasons positive, orthogonal to momentum) BUT FAILS at 0.30% RT
 * (t→1.96) and is front-loaded. This is the SINGLE allowed hardening pass. Kill-by-default.
 *
 * PRE-REGISTERED HYPOTHESIS (committed before looking at results):
 *   The conditioned-PEAD edge is real but cost-fragile. A tighter entry/liquidity/hold
 *   refinement can make it survive realistic cost. Test exactly THREE refinements:
 *     R1 LIQUIDITY  — restrict the conditioned cohort to its LIQUID HALF (by trailing-60d traded
 *                     value at the event). Fewer, cheaper-to-trade names.
 *     R2 TOP-DECILE — require reaction in the top-DECILE (not just Q5/top-quintile) on the
 *                     compliant universe. Concentrate on the highest-surprise names.
 *     R3 LONGER-HOLD— [+2,+42] instead of [+2,+22]: let the drift run to dilute per-trade cost
 *                     (report the [+22,+42] tail too so we can see it isn't given back, like
 *                     block-deals were past 20d).
 *
 * PRE-REGISTERED GATE — PASS requires ALL of, AT 0.30% RT COST:
 *   - conditioned cohort net excess > 0 AND portfolioGuillotine per-period t > 2.
 *   - positive in BOTH season halves.
 *   - n >= 80 (power floor — do NOT lower; if a refinement cuts n below 80 it FAILS on power).
 *
 * KILL: if NONE of the 3 refinements clears the gate at 0.30% RT with n>=80 in both halves →
 *   conditioned-PEAD cost-hardening FAILS → keep it as the tiny ~10% sleeve at 0.11% only, do
 *   NOT promote, CLOSE the thread. A marginal pass is a pass; a fail is a fail.
 *
 * Reuses event/reaction/combo/vol machinery copied verbatim from pead_conditioned_test.mjs.
 * Modifies NO existing module. Point-in-time throughout.
 * Run: node --experimental-sqlite scripts/pead_hardening_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile, mean } from '../dashboard/pead.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const COST_LO = 0.0011;          // Derayah round-trip (the level it currently passes at)
const COST_HI = 0.0030;          // realistic RT (the bar — the level it currently fails at)
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = 20;           // base hold [+2,+22] = 20 sessions
const LONG_DRIFT_DAYS = 40;      // R3 hold [+2,+42]
const MIN_EVENTS = 80;           // power floor — do NOT lower
const LIQUID_FRAC = 0.5;
const MIN_LISTING = 504;         // ≥2y listed (matches live screen)

const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// abnormal return aligned on separate name/bench index windows (from pead_conditioned_test.mjs)
function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}

/**
 * Run a cohort through the per-month guillotine at a given RT cost, plus both-season split.
 * `driftKey` selects which drift field on the record to use. Returns the full result bundle.
 */
function evalCohort(cohort, costRT, driftKey = 'drift') {
  const NET = d => d - costRT - 2 * SLIP;
  const byMonth = {};
  for (const r of cohort) (byMonth[r.monthKey] ||= []).push(r);
  const monthKeys = Object.keys(byMonth).sort();
  const excessSeries = monthKeys.map(k => mean(byMonth[k].map(r => NET(r[driftKey]))));
  const grossSeries = monthKeys.map(k => mean(byMonth[k].map(r => r[driftKey])));
  const gate = portfolioGuillotine(excessSeries, { minT: 2, minPeriods: 12 });

  const grossMean = mean(cohort.map(r => r[driftKey]));
  const netMean = isFinite(grossMean) ? NET(grossMean) : NaN;

  const sorted = [...cohort].sort((a, b) => a.date < b.date ? -1 : 1);
  const half = Math.floor(sorted.length / 2);
  const seasonA = sorted.slice(0, half), seasonB = sorted.slice(half);
  const aGross = seasonA.length ? mean(seasonA.map(r => r[driftKey])) : NaN;
  const bGross = seasonB.length ? mean(seasonB.map(r => r[driftKey])) : NaN;
  const aNet = seasonA.length ? NET(aGross) : NaN;
  const bNet = seasonB.length ? NET(bGross) : NaN;
  const bothSeasonsPositive = aGross > 0 && bGross > 0;   // gross-positive both halves (matches original)

  const n = cohort.length;
  const powerOK = n >= MIN_EVENTS;
  const excessOK = netMean > 0;
  const tOK = gate.t > 2;
  const pass = powerOK && excessOK && tOK && bothSeasonsPositive;

  return { n, gate, grossMean, netMean, aGross, bGross, aNet, bNet, bothSeasonsPositive,
           powerOK, excessOK, tOK, pass, periods: gate.periods,
           splitDate: sorted.length ? `${sorted[half - 1]?.date} | ${sorted[half]?.date}` : '—' };
}

function printEval(label, costRT, e) {
  console.log(`  [${label} @ ${(costRT * 100).toFixed(2)}% RT]  n=${e.n}  periods=${e.periods}`);
  console.log(`    gross/event ${pct(e.grossMean)}  net/event ${pct(e.netMean)}  | guillotine excess/pd ${pct(e.gate.excessPerPeriod)}  t ${isNaN(e.gate.t) ? 'NaN' : e.gate.t.toFixed(2)}`);
  console.log(`    seasons gross: early ${pct(e.aGross)}  late ${pct(e.bGross)}  (both+ ${e.bothSeasonsPositive ? 'Y' : 'N'})  | GATE ${e.pass ? 'PASS' : 'FAIL'} [n>=80 ${e.powerOK ? 'Y' : 'N'}, net>0 ${e.excessOK ? 'Y' : 'N'}, t>2 ${e.tOK ? 'Y' : 'N'}]`);
}

(async () => {
  const cutoff = new Date(Date.now() - (LONG_DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff);
  if (!events.length) { console.log('No matured earnings events found.'); process.exit(0); }

  const compliant = TASI_STOCKS.filter(s => getShariaStatus(s.sym).status === 'compliant');
  const compSyms = new Set(compliant.map(s => s.sym));
  const allSyms = [...new Set(events.map(e => e.sym))];
  await warm(allSyms.map(toYahooSym).concat(compliant.map(s => toYahooSym(s.sym))).concat('^TASI.SR'), '10y');

  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  const uniBars = {};
  for (const s of compliant) { const b = await getBars(toYahooSym(s.sym), '10y'); if (b && b.length >= 60) uniBars[s.sym] = b; }

  // ── Stage 1: raw event records — reaction, drift[+2,+22], driftLong[+2,+42], tail[+22,+42],
  //             vol-confirm, trailing-60d traded value (for the liquidity refinement).
  const recs = []; let skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) { skipped++; continue; }
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    const drift = abnAligned(nC, benchC, aN + 2, aN + 2 + DRIFT_DAYS, aB + 2, aB + 2 + DRIFT_DAYS);
    const driftLong = abnAligned(nC, benchC, aN + 2, aN + 2 + LONG_DRIFT_DAYS, aB + 2, aB + 2 + LONG_DRIFT_DAYS);
    const tail = abnAligned(nC, benchC, aN + 2 + DRIFT_DAYS, aN + 2 + LONG_DRIFT_DAYS, aB + 2 + DRIFT_DAYS, aB + 2 + LONG_DRIFT_DAYS);
    if (reaction == null || drift == null) { skipped++; continue; }

    // volume-confirmed: reaction-day volume vs trailing-60d median PRIOR to event (point-in-time)
    const trail = []; for (let k = aN - 60; k < aN; k++) if (k >= 0 && nV[k] > 0) trail.push(nV[k]);
    const trailMed = trail.length >= 20 ? median(trail) : NaN;
    const volConfirmed = isFinite(trailMed) && trailMed > 0 ? (nV[aN] || 0) > trailMed : false;

    // trailing-60d traded value (price*vol) at the event — for the liquidity refinement (point-in-time)
    let tv = 0, tvn = 0; for (let k = Math.max(0, aN - 59); k <= aN; k++) { if (nC[k] > 0 && nV[k] > 0) { tv += nC[k] * nV[k]; tvn++; } }
    const tradedValue = tvn ? tv / tvn : 0;

    recs.push({ sym: ev.sym, date: ev.event_date, reaction, drift, driftLong, tail,
                volConfirmed, tradedValue, compliant: compSyms.has(ev.sym), monthKey: ev.event_date.slice(0, 7) });
  }

  // ── Stage 2: point-in-time combo momentum rank (copied verbatim from pead_conditioned_test.mjs).
  const rankCache = new Map();
  function comboRanksAt(dateISO) {
    if (rankCache.has(dateISO)) return rankCache.get(dateISO);
    const rows = [];
    for (const s of compliant) {
      const b = uniBars[s.sym]; if (!b) continue;
      const c = b.map(x => x.c), v = b.map(x => x.v || 0), dts = b.map(x => iso(x.t));
      const i = sliceByDate(dts, dateISO);
      const idx = i < 0 ? c.length - 1 : (dts[i] === dateISO ? i : i - 1);
      if (idx < 126) continue;
      if (idx + 1 < MIN_LISTING) continue;
      const mom6 = c[idx - 21] / c[idx - 126] - 1;
      if (!isFinite(mom6)) continue;
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

  // ── Stage 3: build the BASE conditioned cohort exactly as the original (Q5 ∩ momAligned ∩ volConfirmed).
  const tradeable = recs.filter(r => r.compliant);
  const bpQ = quantileBreakpoints(tradeable.map(r => r.reaction));         // quintile breakpoints
  const q5 = tradeable.filter(r => assignQuintile(r.reaction, bpQ) === 4);

  function conditionFrom(reactionCohort) {
    const out = [];
    for (const r of reactionCohort) {
      const ranks = comboRanksAt(r.date);
      const combo = ranks.get(r.sym);
      const momAligned = combo != null && combo >= 0.5;
      if (momAligned && r.volConfirmed) out.push({ ...r, combo });
    }
    return out;
  }

  const base = conditionFrom(q5);

  console.log(`\nPEAD HARDENING — pre-registered, kill-by-default. 3 refinements × {0.11%, 0.30%} RT.`);
  console.log(`earnings events ${events.length}, usable ${recs.length} (skipped ${skipped}), compliant ${tradeable.length}, Q5 ${q5.length}`);
  console.log(`BASE conditioned (Q5 ∩ momAligned ∩ volConfirmed): n=${base.length}  | hold [+2,+${2 + DRIFT_DAYS}]  | slip ${(SLIP * 100).toFixed(2)}%/side\n`);

  // Baseline sanity: reproduce the original at both cost levels.
  console.log('── BASELINE (unrefined conditioned cohort, [+2,+22]):');
  printEval('baseline', COST_LO, evalCohort(base, COST_LO, 'drift'));
  printEval('baseline', COST_HI, evalCohort(base, COST_HI, 'drift'));

  const results = [];

  // ── R1 LIQUIDITY: liquid HALF of the conditioned cohort by trailing-60d traded value.
  {
    const sortedTV = [...base].sort((a, b) => b.tradedValue - a.tradedValue);
    const keep = Math.ceil(sortedTV.length * 0.5);
    const cohort = sortedTV.slice(0, keep);
    const lo = evalCohort(cohort, COST_LO, 'drift');
    const hi = evalCohort(cohort, COST_HI, 'drift');
    console.log('\n── R1 LIQUIDITY (liquid half of conditioned cohort, [+2,+22]):');
    printEval('R1', COST_LO, lo); printEval('R1', COST_HI, hi);
    results.push({ name: 'R1 liquidity-half', lo, hi });
  }

  // ── R2 TOP-DECILE reaction: top 10% reaction on the compliant universe, then condition.
  {
    const sortedR = [...tradeable].sort((a, b) => b.reaction - a.reaction);
    const keepN = Math.ceil(sortedR.length * 0.10);
    const decile = sortedR.slice(0, keepN);
    const cohort = conditionFrom(decile);
    const lo = evalCohort(cohort, COST_LO, 'drift');
    const hi = evalCohort(cohort, COST_HI, 'drift');
    console.log('\n── R2 TOP-DECILE reaction (top 10% reaction ∩ momAligned ∩ volConfirmed, [+2,+22]):');
    printEval('R2', COST_LO, lo); printEval('R2', COST_HI, hi);
    results.push({ name: 'R2 top-decile', lo, hi });
  }

  // ── R3 LONGER HOLD: same base cohort, drift [+2,+42]. Check the [+22,+42] tail isn't given back.
  {
    const cohort = base;
    const lo = evalCohort(cohort, COST_LO, 'driftLong');
    const hi = evalCohort(cohort, COST_HI, 'driftLong');
    const tailMean = mean(cohort.map(r => r.tail));
    console.log('\n── R3 LONGER HOLD ([+2,+42], same base cohort):');
    console.log(`    monotonicity check — [+22,+42] tail gross mean: ${pct(tailMean)} (negative = drift given back; positive = drift continues)`);
    printEval('R3', COST_LO, lo); printEval('R3', COST_HI, hi);
    results.push({ name: 'R3 longer-hold [+2,+42]', lo, hi, tailMean });
  }

  // ── VERDICT — PASS requires the 0.30% RT (hi) column to clear the gate with n>=80 both halves.
  console.log('\n\n════════ PRE-REGISTERED VERDICT (gate is the 0.30% RT column) ════════');
  let anyPass = false;
  for (const r of results) {
    const e = r.hi;
    const seasonNok = e.bothSeasonsPositive ? 'Y' : 'N';
    console.log(`  ${r.name.padEnd(26)} @0.30%: n=${String(e.n).padStart(3)}  net ${pct(e.netMean).padStart(7)}  t ${(isNaN(e.gate.t) ? 'NaN' : e.gate.t.toFixed(2)).padStart(5)}  both-halves ${seasonNok}  → ${e.pass ? 'PASS' : 'FAIL'}`);
    if (e.pass) anyPass = true;
  }
  console.log(`\nVERDICT: ${anyPass
    ? 'HARDENED PASS — at least one refinement clears the gate at 0.30% RT with n>=80 both halves. Conditioned PEAD survives realistic cost → candidate to promote to a real 2nd sleeve.'
    : 'FAIL — NO refinement clears the gate at 0.30% RT with n>=80 in both halves. Conditioned-PEAD cost-hardening FAILS. Keep it ONLY as the tiny ~10% sleeve at 0.11%; do NOT promote; PEAD hardening thread CLOSED — no further iteration.'}`);
})();
