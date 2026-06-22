/**
 * pead_conditioned_test.mjs — CONDITIONED PEAD, the ONE pre-registered re-test.
 *
 * Raw PEAD already FAILED the gate (quintile spread t 1.33, Q5 net +0.22% t 1.92<2, fails
 * season split — scripts/pead_test.mjs / docs/research/2026-06-21-pead-results.md). This is the
 * single allowed re-test with a HARD pre-committed kill. NO condition-iteration after this run.
 *
 * PRE-REGISTERED HYPOTHESIS (committed before looking at results):
 *   Raw earnings-reaction drift is too noisy. Drift survives only in the top-reaction cohort
 *   (Q5 by earnings-day abnormal reaction) when the name is ALSO:
 *     (1) momentum-aligned — in the TOP HALF of the live combo momentum rank (6-1mo + 52wk-high
 *         percentile average) computed POINT-IN-TIME at the event date, AND
 *     (2) volume-confirmed — reaction-day volume ABOVE the trailing-60d median (prior to event).
 *   Hold [+2,+22] sessions, abnormal vs equal-weight ^TASI basket, Derayah 0.11% RT.
 *
 * PRE-REGISTERED KILL-CRITERION (decide pass/fail by THIS — no goalpost-moving):
 *   PASS requires ALL of:
 *     - conditioned-cohort long-only net excess > 0
 *     - portfolioGuillotine (per-period, one obs per non-overlapping month) t > 2
 *     - positive in BOTH season cohorts (sample split in two by date)
 *     - >= ~80-100 usable conditioned events (else underpowered = FAIL by default).
 *   Fail ANY → PEAD/information-edge thesis CLOSED permanently for this account.
 *
 * Reuses event data + drift machinery from pead_test.mjs; momentum combo logic mirrors
 * dashboard/momentum_screen.mjs (computed point-in-time here). Modifies no existing module.
 * Run: node --experimental-sqlite scripts/pead_conditioned_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile, mean } from '../dashboard/pead.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;     // Derayah round-trip
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = +process.env.DRIFT_DAYS || 20;    // [+2,+22] = 20 sessions after reaction day
const MIN_EVENTS = +process.env.MIN_EVENTS || 80;    // power floor — do NOT lower
const LIQUID_FRAC = 0.5;
const MIN_LISTING = 504;                             // ≥2y listed (matches live screen)

const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// abnormal return aligned on separate name/bench index windows (from pead_test.mjs)
function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}

(async () => {
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff);
  if (!events.length) { console.log('No matured earnings events found.'); process.exit(0); }

  // Universe = compliant TASI names (the live tradeable universe). Warm them all + bench once.
  const compliant = TASI_STOCKS.filter(s => getShariaStatus(s.sym).status === 'compliant');
  const compSyms = new Set(compliant.map(s => s.sym));
  const allSyms = [...new Set(events.map(e => e.sym))];
  await warm(allSyms.map(toYahooSym).concat(compliant.map(s => toYahooSym(s.sym))).concat('^TASI.SR'), '10y');

  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  // Preload compliant-universe bars once (point-in-time cross-section uses these).
  const uniBars = {};
  for (const s of compliant) { const b = await getBars(toYahooSym(s.sym), '10y'); if (b && b.length >= 60) uniBars[s.sym] = b; }

  // ── Stage 1: build raw event records (reaction, drift, vol-confirm) for ALL events.
  const recs = []; let skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) { skipped++; continue; }
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    const drift = abnAligned(nC, benchC, aN + 2, aN + 2 + DRIFT_DAYS, aB + 2, aB + 2 + DRIFT_DAYS);
    if (reaction == null || drift == null) { skipped++; continue; }

    // volume-confirmed: reaction-day volume vs trailing 60-session median PRIOR to the event (point-in-time)
    const trail = []; for (let k = aN - 60; k < aN; k++) if (k >= 0 && nV[k] > 0) trail.push(nV[k]);
    const trailMed = trail.length >= 20 ? median(trail) : NaN;
    const volConfirmed = isFinite(trailMed) && trailMed > 0 ? (nV[aN] || 0) > trailMed : false;

    recs.push({ sym: ev.sym, date: ev.event_date, reaction, drift, volConfirmed, eventIdx: aN, compliant: compSyms.has(ev.sym), monthKey: ev.event_date.slice(0, 7) });
  }

  // ── Stage 2: point-in-time combo momentum rank at each event date (cache per unique date).
  // Mirrors momentum_screen.mjs: liquid half of compliant universe, percentile-rank mom6 + wk52,
  // average → combo; "momentum-aligned" = combo rank in the TOP HALF (>= 0.5). Only data up to date.
  const rankCache = new Map();   // date → Map(sym → comboRank in [0,1])
  function comboRanksAt(dateISO) {
    if (rankCache.has(dateISO)) return rankCache.get(dateISO);
    const rows = [];
    for (const s of compliant) {
      const b = uniBars[s.sym]; if (!b) continue;
      const c = b.map(x => x.c), v = b.map(x => x.v || 0), dts = b.map(x => iso(x.t));
      const i = sliceByDate(dts, dateISO);            // first bar on-or-after the event date
      const idx = i < 0 ? c.length - 1 : (dts[i] === dateISO ? i : i - 1);  // last bar AT/BEFORE date
      if (idx < 126) continue;
      if (idx + 1 < MIN_LISTING) continue;            // ≥2y listed as of the date
      const mom6 = c[idx - 21] / c[idx - 126] - 1;    // 6-1mo momentum (skip last month)
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

  // ── Stage 3: Q5 (top earnings-reaction quintile) on the compliant tradeable universe.
  const tradeable = recs.filter(r => r.compliant);
  const bp = quantileBreakpoints(tradeable.map(r => r.reaction));
  const q5 = tradeable.filter(r => assignQuintile(r.reaction, bp) === 4);

  // ── Stage 4: apply BOTH conditions to Q5.
  const conditioned = [];
  for (const r of q5) {
    const ranks = comboRanksAt(r.date);
    const combo = ranks.get(r.sym);
    const momAligned = combo != null && combo >= 0.5;     // top half of combo momentum rank
    if (momAligned && r.volConfirmed) conditioned.push({ ...r, combo });
  }

  console.log(`\nCONDITIONED PEAD — pre-registered single shot`);
  console.log(`earnings events ${events.length}, usable ${recs.length}, compliant-universe ${tradeable.length}, Q5 (top-reaction) ${q5.length}`);
  console.log(`conditioned (Q5 ∩ momentum-aligned ∩ volume-confirmed): ${conditioned.length} events`);
  console.log(`reaction [0,+1] vs ^TASI; drift [+2,+${2 + DRIFT_DAYS}]; cost ${(COST_RT * 100).toFixed(2)}% RT + slip ${(SLIP * 100).toFixed(2)}%/side\n`);

  const NET = d => d - COST_RT - 2 * SLIP;            // long-only net of cost+slip
  const drifts = conditioned.map(r => r.drift);
  const grossMean = mean(drifts);
  const netMean = isFinite(grossMean) ? NET(grossMean) : NaN;

  // ── Guillotine: one non-overlapping observation per calendar month, equal-weight the
  // conditioned events' drift within that month. drift is ALREADY abnormal vs ^TASI → it IS
  // the per-period excess. Net per month (cost+slip charged once per held name, equal-weight).
  const byMonth = {};
  for (const r of conditioned) (byMonth[r.monthKey] ||= []).push(r);
  const monthKeys = Object.keys(byMonth).sort();
  const excessSeries = monthKeys.map(k => mean(byMonth[k].map(r => NET(r.drift))));   // net excess/period
  const grossSeries = monthKeys.map(k => mean(byMonth[k].map(r => r.drift)));         // gross excess/period
  const gate = portfolioGuillotine(excessSeries, { minT: 2, minPeriods: 12 });

  console.log('GUILLOTINE (per-month non-overlapping, net excess vs equal-weight ^TASI basket):');
  console.log(`  periods (months)   : ${gate.periods}`);
  console.log(`  excess/period (net): ${pct(gate.excessPerPeriod)}`);
  console.log(`  per-period t       : ${isNaN(gate.t) ? 'NaN' : gate.t.toFixed(2)}`);
  console.log(`  gross excess/period: ${pct(mean(grossSeries))}`);
  console.log(`  verdict            : ${gate.reason}\n`);

  console.log(`Conditioned long-only drift: gross ${pct(grossMean)}, NET ${pct(netMean)} (n=${conditioned.length})`);

  // ── Both-season split: divide conditioned events into two halves BY DATE (median date).
  const sorted = [...conditioned].sort((a, b) => a.date < b.date ? -1 : 1);
  const half = Math.floor(sorted.length / 2);
  const seasonA = sorted.slice(0, half), seasonB = sorted.slice(half);
  const aNet = seasonA.length ? NET(mean(seasonA.map(r => r.drift))) : NaN;
  const bNet = seasonB.length ? NET(mean(seasonB.map(r => r.drift))) : NaN;
  const aGross = seasonA.length ? mean(seasonA.map(r => r.drift)) : NaN;
  const bGross = seasonB.length ? mean(seasonB.map(r => r.drift)) : NaN;
  const splitDate = sorted.length ? sorted[half - 1]?.date + ' | ' + sorted[half]?.date : '—';
  console.log('\nBOTH-SEASON SPLIT (by date, two halves):');
  console.log(`  split at: ${splitDate}`);
  console.log(`  early  half: n=${seasonA.length}  gross ${pct(aGross)}  net ${pct(aNet)}`);
  console.log(`  late   half: n=${seasonB.length}  gross ${pct(bGross)}  net ${pct(bNet)}`);
  const bothSeasonsPositive = aGross > 0 && bGross > 0;

  // ── PRE-REGISTERED gate.
  const powerOK = conditioned.length >= MIN_EVENTS;
  const excessOK = netMean > 0;
  const tOK = gate.t > 2;
  const pass = powerOK && excessOK && tOK && bothSeasonsPositive;

  console.log('\nPRE-REGISTERED GATE (ALL must hold):');
  console.log(`  [${powerOK ? 'PASS' : 'FAIL'}] n ≥ ${MIN_EVENTS}                : ${conditioned.length}`);
  console.log(`  [${excessOK ? 'PASS' : 'FAIL'}] long-only net excess > 0  : ${pct(netMean)}`);
  console.log(`  [${tOK ? 'PASS' : 'FAIL'}] guillotine per-period t > 2: ${isNaN(gate.t) ? 'NaN' : gate.t.toFixed(2)}`);
  console.log(`  [${bothSeasonsPositive ? 'PASS' : 'FAIL'}] positive in BOTH seasons   : early ${pct(aGross)}, late ${pct(bGross)}`);

  console.log(`\nVERDICT: ${pass ? 'PASS — conditioned PEAD clears the pre-registered gate. Genuine low-correlation 2nd edge candidate; recommend adding it.' : 'FAIL — conditioned PEAD does NOT clear the pre-registered gate. PEAD / information-edge thesis is CLOSED permanently for this account. Do NOT iterate conditions.'}`);
})();
