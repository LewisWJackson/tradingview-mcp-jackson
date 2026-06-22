/**
 * rebalance_frequency_test.mjs — PRE-REGISTERED: does QUARTERLY rebalancing beat MONTHLY
 * for the validated Sharia TASI momentum combo? Kill-by-default.
 *
 * A prior bonus arm (exposure_arms_test.mjs) hinted quarterly +3.25%/yr at ~⅓ the cost.
 * That bonus, however, (a) re-ranked the WHOLE book each cadence and charged FULL round-trip
 * cost on the entire basket every rebalance, and (b) never put quarterly through the
 * guillotine or both-halves. This script does it properly.
 *
 * HYPOTHESIS: 6-month momentum decays slowly, so rebalancing QUARTERLY (~63 sessions) instead
 * of MONTHLY (~21) retains ~the same gross excess at ~⅓ the turnover/cost → higher NET CAGR
 * and better Calmar — without giving up the edge (per-period guillotine t still > 2) and in
 * BOTH halves.
 *
 * CONSTRUCTION (stated for the record):
 *   - Each cadence gets its OWN non-overlapping period grid: monthly steps every H=21 sessions,
 *     quarterly every 63, semi-annual every 126. One excess observation per non-overlapping
 *     rebalance period → directly guillotine-able (the gate needs non-overlapping periods to
 *     absorb cross-sectional clustering; overlapping holds would violate that). The per-period
 *     return is the forward H-session return of the basket held over that period.
 *   - HOLD-THE-REST: at each rebalance we re-rank, KEEP names still in the top set, and only
 *     SWAP names that left. Cost is charged ONLY on the turnover fraction (names swapped in/out),
 *     not the full book — this is the whole point of rebalancing less often. First period pays
 *     full cost (initial deployment). turnoverFrac = |swapped names| / |held names|.
 *   - net period return = grossPort_basket − COST_RT × turnoverFrac.
 *   - SAME everything else as breadth_test / exposure_arms: combo = mom6-rank + 52wk-high-rank
 *     avg, liquid-half ∩ ≥2y listed, top-quintile equal-weight, Derayah 0.11% RT, COVID carved
 *     out, point-in-time, ^TASI calendar.
 *   - excess = net basket return − equal-weight universe return (one obs/period). Guillotine on it.
 *
 * PRE-REGISTERED PASS BAR — quarterly "wins" requires ALL:
 *   1. Quarterly NET CAGR ≥ monthly NET CAGR
 *   2. Quarterly Calmar ≥ monthly Calmar
 *   3. Quarterly per-period excess clears guillotine t > 2
 *   4. Holds in BOTH halves (h1 & h2 excess t both > 0; gross/net CAGR positive both halves)
 *   Trap watch: lower turnover can flatter CAGR in a rising sample while raising concentration
 *   risk — we check maxDD does not worsen and t stays > 2.
 *
 * Research only — NO money-path edit. Reuses cache + guillotine. Point-in-time.
 *   node --experimental-sqlite scripts/rebalance_frequency_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';
const calmarStr = c => isNaN(c) ? '—' : (c === Infinity ? '∞' : c.toFixed(2));

// CAGR + maxDD + Calmar from a per-period ABS return series, compounded over h-session periods.
function equityStats(rets, h) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * h / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : (cagr > 0 ? Infinity : NaN);
  return { cagr, mdd, calmar, totalReturn: eq - 1 };
}

// Rank the universe at rebalance index for date and return the top-quintile picks (the held set),
// using the EXACT combo of breadth_test/exposure_arms. Point-in-time (only bars ≤ i).
function rankPicks(data, usable, date) {
  const rows = [];
  for (const s of usable) {
    const d = data[s]; const i = d.idx[date];
    if (i == null || i < 504) continue;                                   // ≥2y listed
    const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
    let hi52 = -Infinity; for (let k = Math.max(0, i - 251); k <= i; k++) hi52 = Math.max(hi52, d.c[k]);
    const wk52 = hi52 > 0 ? d.c[i] / hi52 : null;
    let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); n++; }
    rows.push({ s, mom6, wk52, liq: liq / n });
  }
  if (rows.length < 10) return null;
  const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
  const both = liquid.filter(r => r.wk52 != null);
  const pool = both.length >= 10 ? both : liquid;
  const pctRank = (arr, key) => { const a = [...arr].sort((x, y) => x[key] - y[key]); a.forEach((r, j) => r['_r_' + key] = arr.length > 1 ? j / (arr.length - 1) : 0.5); };
  pctRank(pool, 'mom6');
  if (pool === both) pctRank(pool, 'wk52');
  pool.forEach(r => r.combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6);
  const ranked = [...pool].sort((a, b) => b.combo - a.combo);
  return ranked.slice(0, Math.max(5, Math.floor(pool.length * 0.2))).map(r => r.s);
}

// Build the non-overlapping rebalance series for holding horizon h, with HOLD-THE-REST turnover.
// Returns { net:[], gross:[], exc:[], turnover:[] } one value per period.
function runCadence(data, cal, usable, h) {
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + h >= d.c.length) return null; return d.c[i + h] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const net = [], gross = [], exc = [], turnover = [];
  let held = null;   // previous period's held set (Set of syms) for hold-the-rest turnover
  for (let ci = MIN_HISTORY; ci + h < cal.length; ci += h) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const picks = rankPicks(data, usable, date); if (!picks) continue;
    const livePicks = picks.filter(s => fwd(s, date) != null); if (!livePicks.length) continue;
    const grossPort = mean(livePicks.map(s => fwd(s, date)));

    // HOLD-THE-REST turnover: names in livePicks not in `held` are bought; names in `held`
    // not in livePicks are sold. Round-trip cost applies to the swapped fraction. We express
    // turnover as (names swapped IN) / (current basket size) — symmetric for equal-weight,
    // each swap is one name out + one name in, charged one RT. First period = full deploy (1.0).
    let turnFrac;
    if (held == null) {
      turnFrac = 1.0;                                  // initial deployment pays full cost
    } else {
      const cur = new Set(livePicks);
      const boughtIn = livePicks.filter(s => !held.has(s)).length;
      turnFrac = livePicks.length ? boughtIn / livePicks.length : 0;
    }
    const netRet = grossPort - COST_RT * turnFrac;
    net.push(netRet); gross.push(grossPort); exc.push(netRet - bench); turnover.push(turnFrac);
    held = new Set(livePicks);
  }
  return { net, gross, exc, turnover };
}

function summarize(c, h) {
  const mid = Math.floor(c.net.length / 2);
  const eq = equityStats(c.net, h);
  const eqG = equityStats(c.gross, h);
  const g = portfolioGuillotine(c.exc, { abs: c.net, minT: 2 });
  const h1exc = c.exc.slice(0, mid), h2exc = c.exc.slice(mid);
  const h1net = c.net.slice(0, mid), h2net = c.net.slice(mid);
  const avgTurn = c.turnover.length > 1 ? mean(c.turnover.slice(1)) : NaN;  // exclude initial deploy
  const rebPerYr = 252 / h;
  const annCostDrag = rebPerYr * avgTurn * COST_RT;
  const annTurnover = rebPerYr * avgTurn;
  return {
    n: c.net.length, h,
    cagr: eq.cagr, grossCagr: eqG.cagr, mdd: eq.mdd, calmar: eq.calmar,
    t: g.t, exPd: mean(c.exc), pass: g.pass,
    h1t: tstat(h1exc), h2t: tstat(h2exc),
    h1cagr: equityStats(h1net, h).cagr, h2cagr: equityStats(h2net, h).cagr,
    avgTurn, annTurnover, rebPerYr, annCostDrag,
  };
}

async function main() {
  console.error(`loading TASI universe from cache ...`);
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + 126) continue;
    data[s.sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  console.error(`usable names: ${usable.length}`);

  const CADENCES = [{ label: 'MONTHLY', key: 'monthly', h: 21 }, { label: 'QUARTERLY', key: 'quarterly', h: 63 }, { label: 'SEMI-ANN', key: 'semiann', h: 126 }];
  const S = {};
  for (const c of CADENCES) S[c.key] = summarize(runCadence(data, cal, usable, c.h), c.h);

  console.log(`\n=== REBALANCE FREQUENCY — Sharia TASI momentum combo (pre-registered, kill-by-default) ===`);
  console.log(`combo: mom6-rank + 52wk-high-rank avg, liquid-half ∩ ≥2y, top-quintile, equal-weight | cost ${pct(COST_RT)} RT | COVID carved out`);
  console.log(`construction: own non-overlapping grid per cadence (21/63/126 sessions); HOLD-THE-REST turnover; cost charged only on swapped fraction`);
  console.log(`benchmark: equal-weight universe | excess = net basket − benchmark, one obs/non-overlapping period | guillotine minT=2\n`);

  const hdr = ['cadence', 'periods', 'grossCAGR', 'netCAGR', 'maxDD', 'Calmar', 'turn/yr', 'costDrag', 't', 'h1 t', 'h2 t', 'gate'];
  const w = [12, 9, 11, 11, 9, 8, 9, 10, 7, 7, 7, 6];
  console.log(hdr.map((x, i) => x.padEnd(w[i])).join(''));
  for (const c of CADENCES) {
    const s = S[c.key];
    console.log([
      c.label, String(s.n), pct(s.grossCagr), pct(s.cagr), pct(s.mdd), calmarStr(s.calmar),
      (s.annTurnover * 100).toFixed(0) + '%', pct(s.annCostDrag),
      isNaN(s.t) ? 'NaN' : s.t.toFixed(2),
      isNaN(s.h1t) ? '—' : s.h1t.toFixed(2), isNaN(s.h2t) ? '—' : s.h2t.toFixed(2),
      s.pass ? 'PASS' : 'FAIL',
    ].map((x, i) => x.padEnd(w[i])).join(''));
  }

  // both-halves net CAGR detail
  console.log(`\nboth-halves net CAGR:`);
  for (const c of CADENCES) {
    const s = S[c.key];
    console.log(`  ${c.label.padEnd(10)} h1 ${pct(s.h1cagr).padEnd(10)} h2 ${pct(s.h2cagr).padEnd(10)} (h1 t ${isNaN(s.h1t) ? '—' : s.h1t.toFixed(2)}, h2 t ${isNaN(s.h2t) ? '—' : s.h2t.toFixed(2)})`);
  }

  // ── PRE-REGISTERED PASS BAR for QUARTERLY ─────────────────────────────────
  const M = S.monthly, Q = S.quarterly;
  const c1 = Q.cagr >= M.cagr - 1e-9;
  const c2 = Q.calmar >= M.calmar - 1e-9;
  const c3 = Q.t > 2;
  const c4 = Q.h1t > 0 && Q.h2t > 0 && Q.h1cagr > 0 && Q.h2cagr > 0;
  const ddNotWorse = Q.mdd >= M.mdd - 1e-9;     // less negative (or equal) = not worse; trap watch
  const winAll = c1 && c2 && c3 && c4;
  const ck = (b) => b ? 'PASS' : 'FAIL';

  console.log(`\n── PRE-REGISTERED PASS BAR (quarterly wins requires ALL) ──`);
  console.log(`  1. Q netCAGR ≥ M netCAGR        ${ck(c1)}  (Q ${pct(Q.cagr)} vs M ${pct(M.cagr)}, Δ ${pct(Q.cagr - M.cagr)})`);
  console.log(`  2. Q Calmar  ≥ M Calmar         ${ck(c2)}  (Q ${calmarStr(Q.calmar)} vs M ${calmarStr(M.calmar)})`);
  console.log(`  3. Q guillotine t > 2           ${ck(c3)}  (Q t ${isNaN(Q.t) ? 'NaN' : Q.t.toFixed(2)}, gate ${Q.pass ? 'PASS' : 'FAIL'})`);
  console.log(`  4. Q holds in BOTH halves       ${ck(c4)}  (h1 t ${Q.h1t.toFixed(2)} cagr ${pct(Q.h1cagr)} | h2 t ${Q.h2t.toFixed(2)} cagr ${pct(Q.h2cagr)})`);
  console.log(`  trap watch: Q maxDD not worse   ${ck(ddNotWorse)}  (Q ${pct(Q.mdd)} vs M ${pct(M.mdd)})`);
  console.log(`\n  QUARTERLY VERDICT: ${winAll ? 'WINS — switch live cadence to quarterly' : 'FAILS — KEEP MONTHLY'}`);
  console.log(`  deltas (Q − M): netCAGR ${pct(Q.cagr - M.cagr)} | Calmar ${calmarStr(Q.calmar - M.calmar)} | turnover/yr ${((Q.annTurnover - M.annTurnover) * 100).toFixed(0)}pp | costDrag ${pct(Q.annCostDrag - M.annCostDrag)}/yr | maxDD ${pct(Q.mdd - M.mdd)}\n`);

  // ── machine-readable ──────────────────────────────────────────────────────
  const dump = s => ({
    periods: s.n, grossCagr: +(s.grossCagr * 100).toFixed(2), netCagr: +(s.cagr * 100).toFixed(2),
    maxDD: +(s.mdd * 100).toFixed(1), calmar: s.calmar === Infinity ? null : +s.calmar.toFixed(2),
    annTurnoverPct: +(s.annTurnover * 100).toFixed(0), annCostDragPct: +(s.annCostDrag * 100).toFixed(2),
    t: +(s.t || 0).toFixed(2), exPdPct: +(s.exPd * 100).toFixed(3), h1t: +(s.h1t || 0).toFixed(2), h2t: +(s.h2t || 0).toFixed(2),
    h1cagr: +(s.h1cagr * 100).toFixed(2), h2cagr: +(s.h2cagr * 100).toFixed(2), gate: s.pass,
  });
  console.log(`JSON ${JSON.stringify({
    monthly: dump(M), quarterly: dump(Q), semiann: dump(S.semiann),
    prereg: { c1_cagr: c1, c2_calmar: c2, c3_t: c3, c4_bothHalves: c4, ddNotWorse, quarterlyWins: winAll },
    verdict: winAll ? 'SWITCH_TO_QUARTERLY' : 'KEEP_MONTHLY',
  })}`);
  process.exit(0);
}
main();
