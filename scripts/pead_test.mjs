/**
 * pead_test.mjs — Post-Earnings-Announcement Drift, cross-sectional, reaction-as-surprise.
 *
 * For each matured earnings event in catalyst_events: REACTION = abnormal return (vs ^TASI.SR)
 * over the earnings day [0,+1] (surprise proxy, no estimates), DRIFT = abnormal return over the
 * next 20 trading days [+2,+22] (reaction day excluded). Sort events into reaction quintiles;
 * PEAD edge = drift rising Q1→Q5, the Q5−Q1 spread (benchmark cancels), and Q5 long-only net cost.
 * Single 6-month window — pseudo-OOS = March-annual cohort vs May-Q1 cohort.
 * Run: node --experimental-sqlite scripts/pead_test.mjs
 * Spec: docs/superpowers/specs/2026-06-21-pead-design.md
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { abnormalReturn, sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile, mean } from '../dashboard/pead.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = +process.env.DRIFT_DAYS || 20;
const MIN_N = +process.env.MIN_N || 100;
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

// quintile-sort recs by reaction, print per-quintile drift, return groups + spread + its NW-t
function quintileReport(recs) {
  if (!recs.length) { console.log('no usable events'); return { q: [[], [], [], [], []], spread: NaN, spreadT: NaN }; }
  const bp = quantileBreakpoints(recs.map(r => r.reaction));
  const q = [[], [], [], [], []];
  for (const r of recs) q[assignQuintile(r.reaction, bp)].push(r);
  console.log('QUINTILE (by earnings-day reaction)  reactionMean  driftMean   n');
  for (let i = 0; i < 5; i++) {
    const g = q[i];
    console.log(`  Q${i + 1}  ${pct(mean(g.map(r => r.reaction))).padStart(8)}      ${pct(mean(g.map(r => r.drift))).padStart(8)}   ${g.length}`);
  }
  const q5 = q[4].map(r => r.drift), q1 = q[0].map(r => r.drift);
  const spread = (q5.length && q1.length) ? mean(q5) - mean(q1) : NaN;
  const signed = q5.concat(q1.map(d => -d)); // signed Q5∪(−Q1) ≈ spread t
  return { q, spread, spreadT: nwT(signed) };
}

(async () => {
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10); // ~maturity by calendar days
  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff);
  if (!events.length) { console.log('No matured earnings events found.'); process.exit(0); }

  const syms = [...new Set(events.map(e => e.sym))];
  await warm(syms.map(toYahooSym).concat('^TASI.SR'), '10y');
  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  const recs = []; let skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) { skipped++; continue; }
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    const drift = abnAligned(nC, benchC, aN + 2, aN + 2 + DRIFT_DAYS, aB + 2, aB + 2 + DRIFT_DAYS);
    if (reaction == null || drift == null) { skipped++; continue; }
    recs.push({ sym: ev.sym, date: ev.event_date, reaction, drift, season: ev.event_date.slice(0, 7) <= '2026-03' ? 'annual' : 'q1' });
  }

  console.log(`\nPEAD cross-sectional study — earnings events ${events.length}, used ${recs.length}, skipped ${skipped}`);
  console.log(`reaction [0,+1] vs ^TASI; drift [+2,+${2 + DRIFT_DAYS}]; cost ${(COST_RT * 100).toFixed(2)}% RT + slip ${(SLIP * 100).toFixed(2)}%/side\n`);

  if (recs.length < MIN_N) {
    quintileReport(recs);
    console.log(`\nVERDICT: UNDERPOWERED — only ${recs.length} usable events (<${MIN_N}); not reliable. Harvest more earnings history.`);
    process.exit(0);
  }

  const { q, spread, spreadT } = quintileReport(recs);
  const q5 = q[4] || [];
  const q5net = q5.length ? mean(q5.map(r => r.drift)) - COST_RT - 2 * SLIP : NaN;
  console.log(`\nQ5 long-only drift net of cost+slip: ${pct(q5net)} (n=${q5.length})  NW-t ${(nwT(q5.map(r => r.drift)) || 0).toFixed(2)}`);

  const qmeans = q.map(g => g.length ? mean(g.map(r => r.drift)) : NaN);
  let mono = true; for (let i = 1; i < 5; i++) if (!(qmeans[i] >= qmeans[i - 1])) mono = false;

  console.log('\nPSEUDO-OOS by season (Q5−Q1 spread):');
  for (const s of ['annual', 'q1']) {
    const sub = recs.filter(r => r.season === s);
    if (sub.length < 25) { console.log(`  ${s}: n=${sub.length} too thin`); continue; }
    const bp = quantileBreakpoints(sub.map(r => r.reaction));
    const g = [[], [], [], [], []]; for (const r of sub) g[assignQuintile(r.reaction, bp)].push(r);
    const sp = (g[4].length && g[0].length) ? mean(g[4].map(r => r.drift)) - mean(g[0].map(r => r.drift)) : NaN;
    console.log(`  ${s}: n=${sub.length}  Q5−Q1 spread ${pct(sp)}`);
  }

  console.log('\nVERDICT (PEAD):');
  const pass = spread > 0 && spreadT > 2 && mono && q5net > 0;
  console.log(`  ${pass ? 'SIGNAL' : 'NO SIGNAL'} — spread ${pct(spread)} NW-t ${(spreadT || 0).toFixed(2)}, monotonic ${mono}, Q5 long-only net ${pct(q5net)}`);
  console.log('  (need spread>0 AND t>2 AND monotonic AND Q5 long-only net>0; then confirm both seasons above.)');
})();
