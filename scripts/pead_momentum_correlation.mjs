/**
 * pead_momentum_correlation.mjs — is conditioned-PEAD a genuinely UNCORRELATED 2nd edge,
 * or just momentum in disguise?
 *
 * A 2nd sleeve only diversifies if its per-period excess return stream is low-correlation to
 * the momentum combo's. This rebuilds BOTH per-period net-excess series with the SAME machinery
 * the gates used, aligns them by CALENDAR MONTH, and reports the Pearson correlation.
 *
 *   A) conditioned-PEAD monthly net-excess  — exactly the `excessSeries` the guillotine consumed
 *      in scripts/pead_conditioned_test.mjs (one obs / calendar month, equal-weight conditioned
 *      events' net drift vs ^TASI). Keyed by event-month "YYYY-MM".
 *   B) momentum combo quintile monthly net-excess — the full top-quintile baseline from
 *      scripts/breadth_test.mjs (== the live grade). Its native period is a non-overlapping
 *      20-session rebalance; we map each rebalance's START date to its calendar month and
 *      average within-month so it is comparable to A's monthly granularity.
 *
 * Aligns on the intersection of months present in BOTH, computes Pearson r + n overlapping months.
 *
 * NOTE on period definitions (reported honestly in the output): A is event-driven (a month exists
 * only when a conditioned earnings event occurred) and its "return" is a [+2,+22]-session drift
 * starting mid-month; B is a fixed 20-session rebalance whose window starts on the rebalance date.
 * They are NOT identical holding windows — both are abnormal-vs-basket monthly excess streams, which
 * is the right object to correlate for diversification, but the alignment is approximate-by-month,
 * not trade-for-trade. This is the cleanest alignment available; the caveat is in the report.
 *
 * Modifies no existing module. Run: node --experimental-sqlite scripts/pead_momentum_correlation.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { sliceByDate } from '../dashboard/index_flow.mjs';
import { quantileBreakpoints, assignQuintile, mean } from '../dashboard/pead.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;
const DRIFT_DAYS = +process.env.DRIFT_DAYS || 20;
const LIQUID_FRAC = 0.5;
const MIN_LISTING = 504;

// momentum (breadth_test.mjs) constants
const H = 20, MIN_HISTORY = 210, START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;

const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function pearson(x, y) {
  const n = x.length; if (n < 2) return NaN;
  const mx = mean(x), my = mean(y);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx > 0 && dy > 0) ? num / Math.sqrt(dx * dy) : NaN;
}

function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}

(async () => {
  // ════════════════════════════════════════════════════════════════════════
  // SERIES A — conditioned-PEAD monthly net-excess (mirrors pead_conditioned_test.mjs)
  // ════════════════════════════════════════════════════════════════════════
  const cutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date) && r.event_date <= cutoff);

  const compliant = TASI_STOCKS.filter(s => getShariaStatus(s.sym).status === 'compliant');
  const compSyms = new Set(compliant.map(s => s.sym));
  const allSyms = [...new Set(events.map(e => e.sym))];
  console.error('warming bars ...');
  await warm(allSyms.map(toYahooSym).concat(compliant.map(s => toYahooSym(s.sym))).concat('^TASI.SR'), '10y');

  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

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

  const tradeable = recs.filter(r => r.compliant);
  const bp = quantileBreakpoints(tradeable.map(r => r.reaction));
  const q5 = tradeable.filter(r => assignQuintile(r.reaction, bp) === 4);
  const conditioned = [];
  for (const r of q5) {
    const ranks = comboRanksAt(r.date);
    const combo = ranks.get(r.sym);
    if (combo != null && combo >= 0.5 && r.volConfirmed) conditioned.push({ ...r, combo });
  }

  const NET = d => d - COST_RT - 2 * SLIP;
  const peadByMonth = {};
  for (const r of conditioned) (peadByMonth[r.monthKey] ||= []).push(r);
  const peadMonths = Object.keys(peadByMonth).sort();
  const peadMonthly = new Map(peadMonths.map(k => [k, mean(peadByMonth[k].map(r => NET(r.drift)))]));

  console.error(`PEAD: ${conditioned.length} conditioned events across ${peadMonths.length} months (${peadMonths[0]} … ${peadMonths.at(-1)})`);

  // ════════════════════════════════════════════════════════════════════════
  // SERIES B — momentum combo quintile monthly net-excess (mirrors breadth_test.mjs quintile)
  // ════════════════════════════════════════════════════════════════════════
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)), '10y');
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  // momentum quintile excess per rebalance, tagged with the rebalance start month
  const momByMonth = {};   // "YYYY-MM" → [excess per rebalance starting that month]
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
    const ranked = [...pool].sort((a, b) => b.combo - a.combo);
    const kQuint = Math.max(5, Math.floor(pool.length * 0.2));
    const rankedSyms = ranked.slice(0, kQuint).map(r => r.s);
    const liveSyms = rankedSyms.filter(s => fwd(s, date) != null);
    if (!liveSyms.length) continue;
    const port = mean(liveSyms.map(s => fwd(s, date))) - COST_RT;   // net (cost-charged), matches breadth quintile
    const excess = port - bench;
    const mk = date.slice(0, 7);
    (momByMonth[mk] ||= []).push(excess);
  }
  const momMonths = Object.keys(momByMonth).sort();
  const momMonthly = new Map(momMonths.map(k => [k, mean(momByMonth[k])]));
  console.error(`MOMENTUM: ${momMonths.length} months with a rebalance (${momMonths[0]} … ${momMonths.at(-1)})`);

  // ════════════════════════════════════════════════════════════════════════
  // ALIGN by calendar month + Pearson
  // ════════════════════════════════════════════════════════════════════════
  const overlap = peadMonths.filter(m => momMonthly.has(m)).sort();
  const px = overlap.map(m => peadMonthly.get(m));
  const py = overlap.map(m => momMonthly.get(m));
  const r = pearson(px, py);
  const n = overlap.length;

  console.log(`\n=== CONDITIONED-PEAD vs MOMENTUM-COMBO QUINTILE — monthly net-excess correlation ===`);
  console.log(`PEAD months: ${peadMonths.length} | momentum months: ${momMonths.length} | OVERLAPPING months: ${n}`);
  console.log(`overlap span: ${n ? overlap[0] + ' … ' + overlap.at(-1) : '—'}`);
  console.log(`PEAD overlap mean excess:     ${pct(mean(px))} (sd ${pct(sd(px))})`);
  console.log(`momentum overlap mean excess: ${pct(mean(py))} (sd ${pct(sd(py))})`);
  console.log(`\nPearson r = ${isNaN(r) ? 'NaN' : r.toFixed(3)}   (n = ${n} overlapping months)`);

  let interp, sizing;
  if (n < 12) {
    interp = `INCONCLUSIVE — only ${n} overlapping months; too few to trust the correlation.`;
    sizing = `Do NOT add as a separate sleeve on this evidence — correlation is unproven (underpowered).`;
  } else if (Math.abs(r) < 0.3) {
    interp = `GENUINELY DIVERSIFYING — |r|=${Math.abs(r).toFixed(3)} < 0.3; the PEAD excess stream is low-correlation to momentum.`;
    sizing = `A small, monitored 2nd sleeve (≈10–20% of risk budget) is justified — it adds real diversification, not just more momentum.`;
  } else if (r > 0.5) {
    interp = `REDUNDANT — r=${r.toFixed(3)} > 0.5; PEAD's return stream tracks momentum. It is largely momentum in disguise.`;
    sizing = `Do NOT add it as a separate sleeve — it diversifies little; the risk budget is better spent on the momentum combo.`;
  } else {
    interp = `PARTIAL / WEAK overlap — r=${r.toFixed(3)} sits between 0.3 and 0.5; some shared variance, not clean diversification.`;
    sizing = `At most a very small monitored sleeve (≤10%), and only because the gate passed; treat the diversification benefit as modest.`;
  }
  console.log(`\nINTERPRETATION: ${interp}`);
  console.log(`SIZING REC:     ${sizing}`);

  console.log(`\nJSON ${JSON.stringify({
    peadMonths: peadMonths.length, momentumMonths: momMonths.length, overlapMonths: n,
    overlapSpan: n ? [overlap[0], overlap.at(-1)] : null,
    pearson: isNaN(r) ? null : +r.toFixed(3),
    peadMeanExcess: +(mean(px) * 100).toFixed(2), momMeanExcess: +(mean(py) * 100).toFixed(2),
  })}`);
  process.exit(0);
})();
