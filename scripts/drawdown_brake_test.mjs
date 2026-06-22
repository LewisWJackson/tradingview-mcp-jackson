/**
 * drawdown_brake_test.mjs — walk-forward / OOS robustness for the REGIME drawdown-brake.
 *
 * Context: vol-target and Kelly/conviction sizing were KILLED (no OOS uplift). A prior
 * EQUITY-PEAK brake (cut when own equity is >15% below its running peak) was also walk-
 * forwarded and downgraded to "insurance, not edge" (docs/research/2026-06-21-compounding-
 * geometry-results.md). This script tests a DIFFERENT, simpler, pre-registered rule:
 *
 *   REGIME STATE = the equal-weight momentum basket is BELOW its own 200-day moving average
 *   (point-in-time: the MA uses only past closes). When risk-OFF (below the 200d MA) cut gross
 *   exposure to 50%; restore to 100% when risk-ON (at/above). The de-risked half goes to cash
 *   (earns 0, Sharia-clean). ONE fixed knob (200 days) — no threshold-hunting.
 *
 * Universe / signal: identical to breadth_test.mjs and the live grade — liquid-half ∩ ≥2y-listed
 * TASI, ranked by the validated combo (mom6 percentile-rank + 52-week-high-proximity rank avg),
 * top-quintile, equal-weight, 20-session rebalance, Derayah 0.11% RT, COVID carved out.
 *
 * The basket "price index" the 200d MA is computed on = the compounded equity of the FULL
 * usable equal-weight basket (the broad market proxy / benchmark), tracked DAILY on the index
 * calendar so a true 200-DAY MA is point-in-time available at every rebalance.
 *
 * Walk-forward: ONE knob, fixed → this is an OOS robustness check, not tuning.
 *   (A) First-half / second-half OOS split: baseline vs braked × {CAGR, maxDD, Calmar}.
 *   (B) Rolling 24-period windows stepped 4: how often does the brake cut maxDD / hold CAGR?
 *
 * KEEP-criterion (pre-registered): SHIP only if the brake cuts maxDD by >=5pp OOS without
 * giving back more than ~2%/yr of return (Calmar improves OOS). Else SHELVE.
 *
 * Run: node --experimental-sqlite scripts/drawdown_brake_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = process.env.START || '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const MA_DAYS = +process.env.MA_DAYS || 200;            // FIXED regime knob — no hunting
const BRAKE_MULT = +process.env.BRAKE_MULT || 0.5;      // de-risk to 50% when risk-off
const W = +process.env.WF_WIN || 24, S = +process.env.WF_STEP || 4;
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(1) + '%';
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// CAGR, maxDD, Calmar from a per-period (20-session) ABS return series, compounded.
function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : (cagr > 0 ? Infinity : NaN);
  return { cagr, mdd, calmar, eq };
}
const yearReturn = arr => arr.reduce((acc, r) => acc * (1 + r), 1) - 1;

async function main() {
  console.error('Warming bars cache (all TASI stocks + index, 10y)…');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  console.error(`usable names: ${usable.length}`);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };

  // ── DAILY equal-weight basket "price index" (broad-market proxy) for the 200-day MA ──────
  // For each index calendar day, the cross-sectional mean of one-day stock returns over all
  // usable names that have a bar that day; compound into a price level. Point-in-time: day i's
  // 200d MA uses levels[i-MA_DAYS .. i-1] only. This is the regime state, NOT own-equity DD.
  const lvl = new Array(cal.length);
  let plevel = 1; lvl[0] = 1;
  for (let i = 1; i < cal.length; i++) {
    const dPrev = cal[i - 1], dCur = cal[i];
    const rs = [];
    for (const s of usable) {
      const d = data[s]; const ip = d.idx[dPrev], ic = d.idx[dCur];
      if (ip == null || ic == null || ic !== ip + 1) continue;     // consecutive bars only
      const r = d.c[ic] / d.c[ip] - 1; if (isFinite(r)) rs.push(r);
    }
    plevel *= 1 + (rs.length ? mean(rs) : 0);
    lvl[i] = plevel;
  }
  // risk-off state at index-calendar position ci: basket level < its trailing MA_DAYS-day mean
  function riskOffAt(ci) {
    if (ci < MA_DAYS) return false;                                // not enough history → risk-on
    let s = 0; for (let k = ci - MA_DAYS; k < ci; k++) s += lvl[k]; // strictly past days
    const ma = s / MA_DAYS;
    return lvl[ci] < ma;
  }

  // ── Build per-period picks + the regime flag (point-in-time at rebalance date) ───────────
  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;            // ≥2y listed, point-in-time
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let hi52 = -Infinity; for (let k = Math.max(0, i - 251); k <= i; k++) hi52 = Math.max(hi52, d.c[k]);
      const wk52 = hi52 > 0 ? d.c[i] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); n++; }
      rows.push({ s, mom6, wk52, liq: liq / n });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    // LIVE combo: rank-average of mom6 pctile + wk52 pctile, point-in-time.
    const both = liquid.filter(r => r.wk52 != null);
    const pool = both.length >= 10 ? both : liquid;
    const pctRank = (arr, key) => { const a = [...arr].sort((x, y) => x[key] - y[key]); a.forEach((r, j) => r['_r_' + key] = arr.length > 1 ? j / (arr.length - 1) : 0.5); };
    pctRank(pool, 'mom6');
    if (pool === both) pctRank(pool, 'wk52');
    pool.forEach(r => r.combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6);
    const ranked = [...pool].sort((a, b) => b.combo - a.combo);
    const kQuint = Math.max(5, Math.floor(pool.length * 0.2));
    const picks = ranked.slice(0, kQuint).map(r => ({ s: r.s, fwd: fwd(r.s, date) })).filter(p => p.fwd != null);
    if (!picks.length) continue;
    periods.push({ date, year: +date.slice(0, 4), picks, riskOff: riskOffAt(ci) });
  }

  // Equal-weight momentum book, optional regime brake. Exposure sized at the rebalance date
  // from the point-in-time regime flag (no look-ahead). cash earns 0.
  function run(periodsArr, useBrake) {
    const rets = [];
    for (const p of periodsArr) {
      const basketRet = mean(p.picks.map(x => x.fwd));
      const e = (useBrake && p.riskOff) ? BRAKE_MULT : 1;
      rets.push(e * basketRet - COST_RT * e);     // cost scales with deployed capital
    }
    return rets;
  }

  const offCount = periods.filter(p => p.riskOff).length;
  console.log(`\n=== REGIME DRAWDOWN-BRAKE — walk-forward / OOS on the validated momentum quintile ===`);
  console.log(`Periods: ${periods.length} (${periods[0]?.date} → ${periods.at(-1)?.date}), all-stocks proxy, COVID carved out`);
  console.log(`Rule: basket < ${MA_DAYS}-day MA (point-in-time) → cut gross exposure to ${(BRAKE_MULT * 100).toFixed(0)}%, cash earns 0. Derayah ${pct(COST_RT)} RT.`);
  console.log(`Risk-OFF rebalances: ${offCount}/${periods.length} (${(offCount / periods.length * 100).toFixed(0)}%). Judge on maxDD / Calmar, not CAGR.\n`);

  // ── (A) FIRST-HALF / SECOND-HALF OOS SPLIT ───────────────────────────────────────────────
  const mid = Math.floor(periods.length / 2);
  const halves = [['IN-SAMPLE (1st half)', periods.slice(0, mid)], ['OUT-OF-SAMPLE (2nd half)', periods.slice(mid)]];
  console.log('(A) HALF-SAMPLE OOS — baseline (equal-weight) vs braked');
  console.log('  ' + 'segment'.padEnd(26) + 'stack'.padEnd(10) + 'CAGR'.padStart(8) + 'maxDD'.padStart(9) + 'Calmar'.padStart(9));
  console.log('  ' + '-'.repeat(62));
  const seg = {};
  for (const [label, ps] of halves) {
    const b = equityStats(run(ps, false));
    const k = equityStats(run(ps, true));
    seg[label] = { b, k, n: ps.length, off: ps.filter(p => p.riskOff).length };
    console.log('  ' + label.padEnd(26) + 'baseline'.padEnd(10) + pct(b.cagr).padStart(8) + pct(b.mdd).padStart(9) + (isFinite(b.calmar) ? b.calmar.toFixed(2) : '—').padStart(9));
    console.log('  ' + ''.padEnd(26) + 'braked'.padEnd(10) + pct(k.cagr).padStart(8) + pct(k.mdd).padStart(9) + (isFinite(k.calmar) ? k.calmar.toFixed(2) : '—').padStart(9));
  }

  // full-sample for reference
  const fb = equityStats(run(periods, false)), fk = equityStats(run(periods, true));
  console.log('  ' + '-'.repeat(62));
  console.log('  ' + 'FULL SAMPLE'.padEnd(26) + 'baseline'.padEnd(10) + pct(fb.cagr).padStart(8) + pct(fb.mdd).padStart(9) + (isFinite(fb.calmar) ? fb.calmar.toFixed(2) : '—').padStart(9));
  console.log('  ' + ''.padEnd(26) + 'braked'.padEnd(10) + pct(fk.cagr).padStart(8) + pct(fk.mdd).padStart(9) + (isFinite(fk.calmar) ? fk.calmar.toFixed(2) : '—').padStart(9));

  // ── OOS KEEP-CRITERION ──────────────────────────────────────────────────────────────────
  const oos = seg['OUT-OF-SAMPLE (2nd half)'];
  const ddCut = (oos.b.mdd - oos.k.mdd);                 // >0 = braked shallower (mdd are negative)
  const ddCutPP = ddCut * 100;                           // percentage points of maxDD cut
  const cagrGiveback = oos.b.cagr - oos.k.cagr;          // >0 = brake gave back return
  const cagrGivebackPP = cagrGiveback * 100;
  const calmarImproved = oos.k.calmar > oos.b.calmar;
  const ship = ddCutPP >= 5 && cagrGivebackPP <= 2 && calmarImproved;

  console.log(`\n  OOS criterion (pre-registered): SHIP if maxDD cut >=5pp AND CAGR giveback <=2%/yr AND Calmar improves.`);
  console.log(`    OOS maxDD cut:     ${ddCutPP >= 0 ? '+' : ''}${ddCutPP.toFixed(1)}pp  (need >=5.0pp)        → ${ddCutPP >= 5 ? 'PASS' : 'FAIL'}`);
  console.log(`    OOS CAGR giveback: ${cagrGivebackPP.toFixed(1)}pp  (need <=2.0pp)        → ${cagrGivebackPP <= 2 ? 'PASS' : 'FAIL'}`);
  console.log(`    OOS Calmar:        ${isFinite(oos.b.calmar) ? oos.b.calmar.toFixed(2) : '—'} → ${isFinite(oos.k.calmar) ? oos.k.calmar.toFixed(2) : '—'}   → ${calmarImproved ? 'PASS (improved)' : 'FAIL'}`);
  console.log(`    VERDICT: ${ship ? 'SHIP' : 'SHELVE'}`);

  // ── (B) ROLLING-WINDOW WALK-FORWARD ──────────────────────────────────────────────────────
  console.log('\n(B) ROLLING WINDOWS — brake vs baseline (fresh path each window, ' + W + ' periods, step ' + S + ')');
  console.log('  ' + 'window'.padEnd(26) + '| baseCAGR brakeCAGR  Δ   | baseDD  brakeDD   Δ');
  console.log('  ' + '-'.repeat(72));
  const dC = [], dDD = []; let cagrHold = 0, ddWins = 0, ddNotWorse = 0;
  for (let st = 0; st + W <= periods.length; st += S) {
    const win = periods.slice(st, st + W);
    const b = equityStats(run(win, false)), k = equityStats(run(win, true));
    const dc = k.cagr - b.cagr, dd = k.mdd - b.mdd;       // dd>0 = shallower = better
    dC.push(dc); dDD.push(dd);
    if (dc > -0.02) cagrHold++;                            // held CAGR within 2pp
    if (dd > 0.001) ddWins++;
    if (dd >= -0.001) ddNotWorse++;
    const tag = `${win[0].date}→${win.at(-1).date}`;
    console.log('  ' + tag.padEnd(26) + '| ' + pct(b.cagr).padStart(7) + ' ' + pct(k.cagr).padStart(8) + ' ' + pct(dc).padStart(6) + '  | ' + pct(b.mdd).padStart(6) + ' ' + pct(k.mdd).padStart(7) + ' ' + pct(dd).padStart(6));
  }
  const N = dC.length;
  console.log('  ' + '-'.repeat(72));
  console.log(`  Windows: ${N}`);
  console.log(`  CAGR:  brake held (Δ>-2pp) ${cagrHold}/${N} (${(cagrHold / N * 100).toFixed(0)}%), median Δ ${pct(median(dC))}`);
  console.log(`  maxDD: brake shallower ${ddWins}/${N} (${(ddWins / N * 100).toFixed(0)}%), not-worse ${ddNotWorse}/${N}, median Δ ${pct(median(dDD))}`);

  // ── (C) PER-YEAR ATTRIBUTION (regime story) ──────────────────────────────────────────────
  console.log('\n(C) PER-YEAR (continuous path) — baseline vs brake, return that year');
  const baseRets = run(periods, false), brakeRets = run(periods, true);
  const yrs = {};
  periods.forEach((p, i) => { (yrs[p.year] ||= { b: [], k: [], off: 0, n: 0 }); yrs[p.year].b.push(baseRets[i]); yrs[p.year].k.push(brakeRets[i]); yrs[p.year].off += p.riskOff ? 1 : 0; yrs[p.year].n++; });
  console.log('  YEAR  | baseRet  brakeRet   Δ     | risk-off pds | brake helped?');
  console.log('  ' + '-'.repeat(66));
  for (const y of Object.keys(yrs).sort()) {
    const o = yrs[y]; const br = yearReturn(o.b), kr = yearReturn(o.k); const d = kr - br;
    const verdict = d > 0.005 ? 'YES (defended)' : d < -0.005 ? 'no (gave back)' : '~flat';
    console.log('  ' + `${y}  | ${pct(br).padStart(7)} ${pct(kr).padStart(8)} ${pct(d).padStart(6)}    | ${(o.off + '/' + o.n).padStart(7)}      | ${verdict}`);
  }

  // ── machine-readable ─────────────────────────────────────────────────────────────────────
  const j = (s) => ({ cagr: +(s.cagr * 100).toFixed(1), maxDD: +(s.mdd * 100).toFixed(1), calmar: isFinite(s.calmar) ? +s.calmar.toFixed(2) : null });
  console.log(`\nJSON ${JSON.stringify({
    periods: periods.length, riskOffPct: +(offCount / periods.length * 100).toFixed(0), maDays: MA_DAYS, brakeMult: BRAKE_MULT,
    inSample: { baseline: j(seg['IN-SAMPLE (1st half)'].b), braked: j(seg['IN-SAMPLE (1st half)'].k) },
    oos: { baseline: j(oos.b), braked: j(oos.k), maxDDcutPP: +ddCutPP.toFixed(1), cagrGivebackPP: +cagrGivebackPP.toFixed(1), calmarImproved },
    full: { baseline: j(fb), braked: j(fk) },
    rolling: { windows: N, cagrHeldPct: +(cagrHold / N * 100).toFixed(0), ddShallowerPct: +(ddWins / N * 100).toFixed(0), ddNotWorse: ddNotWorse, medianCagrDeltaPP: +(median(dC) * 100).toFixed(1), medianDDdeltaPP: +(median(dDD) * 100).toFixed(1) },
    verdict: ship ? 'SHIP' : 'SHELVE',
  })}`);
  process.exit(0);
}
main();
