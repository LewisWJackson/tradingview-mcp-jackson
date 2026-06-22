/**
 * exposure_arms_test.mjs — does the LIVE Scheme-D exposure formula leak return?
 *
 * Pre-registered 3-arm comparison. The validated momentum combo (liquid-half ∩ ≥2y,
 * top-quintile, mom6-rank + 52wk-high-rank avg, monthly, Derayah 0.11% RT, COVID carved
 * out, same 65-period sample as breadth_test/strategy_validation) picks the SAME basket
 * every rebalance. We then apply three exposure overlays to that identical basket and
 * measure what each costs/earns:
 *
 *   A. PLAIN       e = 1 (full, the research-endorsed engine).
 *   B. LIVE        e = min(1, targetVol(.15)/realizedVol) × (inSeason?1:0) × stateMult
 *                  — faithfully replicating dashboard/momentum_screen.mjs schemeDExposure.
 *                  realizedVol = annualized vol of the held basket's trailing ~60d daily
 *                  returns (mirrors momentum_screen's portDaily, point-in-time). inSeason
 *                  from the seasonality overlay (sit out the 2 weakest calendar months,
 *                  weakest computed point-in-time on bars up to the rebalance). stateMult=1
 *                  isolates vol-target+seasonal from the governor (also report ×0.5).
 *   C. STATE-ONLY  e = stateMult (drop vol-target + seasonal-zero, keep only the governor).
 *                  stateMult=1 → C should ≈ A if the governor is neutral (also note ×0.5).
 *
 * The de-invested fraction (1−e) sits in cash (0 return). Cost scales with the deployed
 * fraction (you only pay turnover on what you actually trade): arm_ret = e×(grossPort − cost).
 *
 * Per arm: compounded CAGR, maxDD, Calmar, per-period guillotine t of the EXCESS series
 * (vs the equal-weight basket). Full sample + both halves. Plus the A−B recoverable leak.
 *
 * BONUS: rebalance frequency — monthly (H=20) vs quarterly (H=60) on arm A. CAGR / turnover
 * / annual cost drag for each.
 *
 * Research only — NO money-path edit. Reuses cache + guillotine. Point-in-time.
 *   node --experimental-sqlite scripts/exposure_arms_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const TARGET_VOL = 0.15;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';

// CAGR + maxDD + Calmar from a per-period ABS return series, compounded.
function equityStats(rets, h = H) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * h / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const calmar = mdd < 0 ? cagr / Math.abs(mdd) : (cagr > 0 ? Infinity : NaN);
  return { cagr, mdd, calmar, totalReturn: eq - 1 };
}

// Faithful schemeDExposure (copied from dashboard/momentum_screen.mjs, NOT imported — this
// script must not touch the money path, and we want the formula pinned in-file for the record).
function schemeDExposure({ realizedVol, targetVol = TARGET_VOL, inSeason, stateMult }) {
  let e = realizedVol && realizedVol > 0 ? Math.min(1, targetVol / realizedVol) : 1;
  if (!inSeason) e = 0;
  return e * stateMult;
}

// Build the rebalance-period record set for a given holding horizon h.
// Returns { periods:[{date, year, picks:[sym], grossPort, bench, realizedVol, monthNum}], usable }
function buildPeriods(data, cal, usable, h) {
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + h >= d.c.length) return null; return d.c[i + h] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  // Expanding-window seasonality: at each rebalance, the 2 weakest calendar months computed
  // from the universe's daily returns observed UP TO the rebalance index (point-in-time, the
  // honest analogue of momentum_screen building weakest from "full history" at screen time).
  // We accumulate month → daily-return list as we walk forward.
  const periods = [];
  for (let ci = MIN_HISTORY; ci + h < cal.length; ci += h) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + h >= d.c.length) continue;            // ≥2y listed, point-in-time
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
    const picks = ranked.slice(0, Math.max(5, Math.floor(pool.length * 0.2))).map(r => r.s);
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null); if (!rs.length) continue;
    const livePicks = picks.filter(s => fwd(s, date) != null);
    const grossPort = mean(rs);                                              // before cost

    // realizedVol — mirror momentum_screen.portDaily: per held name, trailing ~60d daily
    // returns up to index i; average cross-sectionally per day → basket daily series →
    // annualize. Point-in-time (only bars ≤ i).
    const VOL_LOOKBACK = +process.env.VOL_LOOKBACK || 60;   // sensitivity-sweepable; live uses ~90 (we test 20/40/60)
    const dayRet = {};   // dateIdxOffset → [held daily returns]
    for (const s of livePicks) {
      const d = data[s]; const i = d.idx[date];
      for (let k = i - VOL_LOOKBACK + 1; k <= i; k++) { if (k < 1) continue; const r = d.c[k] / d.c[k - 1] - 1; if (isFinite(r)) (dayRet[k - (i - VOL_LOOKBACK)] ||= []).push(r); }
    }
    const portDaily = Object.keys(dayRet).map(k => mean(dayRet[k])).filter(isFinite);
    const realizedVol = portDaily.length >= 20 ? sd(portDaily) * Math.sqrt(252) : null;

    const monthNum = +date.slice(5, 7);
    periods.push({ date, year: +date.slice(0, 4), picks: livePicks, grossPort, bench, realizedVol, monthNum });
  }
  return periods;
}

// Compute the 2 weakest calendar months from the universe daily returns, EXPANDING up to
// each rebalance date. Returns a function date → Set(weakMonths). To keep it point-in-time
// but cheap, we precompute a cumulative month-mean as of each rebalance date.
function makeSeasonalGate(data, usable) {
  // Build a flat list of {date, month, ret} across all names, then for a query date return the
  // 2 weakest months using only returns strictly before that date.
  const all = [];
  for (const s of usable) {
    const d = data[s];
    for (let k = 1; k < d.c.length; k++) {
      const r = d.c[k] / d.c[k - 1] - 1;
      if (isFinite(r)) all.push({ date: d.dates[k], month: +d.dates[k].slice(5, 7), r });
    }
  }
  all.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  return (asOf) => {
    const sum = {}, cnt = {};
    for (const x of all) {
      if (x.date >= asOf) break;
      sum[x.month] = (sum[x.month] || 0) + x.r; cnt[x.month] = (cnt[x.month] || 0) + 1;
    }
    const m = {};
    for (let mo = 1; mo <= 12; mo++) m[mo] = cnt[mo] ? sum[mo] / cnt[mo] : 0;
    const weakest = Object.entries(m).sort((a, b) => a[1] - b[1]).slice(0, 2).map(e => +e[0]);
    return new Set(weakest);
  };
}

// Run the three arms over a period list. stateMult applied to arms B and C.
function runArms(periods, seasonalGate, stateMult) {
  // per-arm per-period ABS + EXCESS series
  const ABS = { A: [], B: [], C: [] }, EXC = { A: [], B: [], C: [] };
  let sumE_B = 0, nE_B = 0, nInSeason = 0, nThrottled = 0;
  for (const p of periods) {
    const inSeason = !seasonalGate(p.date).has(p.monthNum);
    if (inSeason) nInSeason++;
    // ARM A — plain, e=1
    const eA = 1;
    const rA = eA * (p.grossPort - COST_RT);
    ABS.A.push(rA); EXC.A.push(rA - p.bench);
    // ARM B — live formula
    const eB = schemeDExposure({ realizedVol: p.realizedVol, targetVol: TARGET_VOL, inSeason, stateMult });
    const rB = eB * (p.grossPort - COST_RT);   // deployed fraction trades+returns; (1−eB) in cash @0
    ABS.B.push(rB); EXC.B.push(rB - p.bench);
    if (eB < 1) nThrottled++;
    sumE_B += eB; nE_B++;
    // ARM C — state-only, e = stateMult
    const eC = stateMult;
    const rC = eC * (p.grossPort - COST_RT);
    ABS.C.push(rC); EXC.C.push(rC - p.bench);
  }
  return { ABS, EXC, avgE_B: nE_B ? sumE_B / nE_B : NaN, inSeasonFrac: periods.length ? nInSeason / periods.length : NaN, throttledFrac: periods.length ? nThrottled / periods.length : NaN };
}

function summarize(ABS, EXC, h = H) {
  const out = {};
  for (const arm of ['A', 'B', 'C']) {
    const abs = ABS[arm], exc = EXC[arm];
    const mid = Math.floor(abs.length / 2);
    const { cagr, mdd, calmar } = equityStats(abs, h);
    const g = portfolioGuillotine(exc, { abs, minT: 2 });
    const h1 = exc.slice(0, mid), h2 = exc.slice(mid);
    out[arm] = {
      cagr, mdd, calmar, t: g.t, exPd: mean(exc),
      h1t: tstat(h1), h2t: tstat(h2),
      h1cagr: equityStats(abs.slice(0, mid), h).cagr, h2cagr: equityStats(abs.slice(mid), h).cagr,
      pass: g.pass, n: abs.length,
    };
  }
  return out;
}

async function main() {
  console.error(`loading TASI universe from cache ...`);
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  console.error(`usable names: ${usable.length}`);

  const seasonalGate = makeSeasonalGate(data, usable);

  // ── MONTHLY (H=20) — the live cadence ─────────────────────────────────────
  const periods = buildPeriods(data, cal, usable, H);
  const nP = periods.length;

  const fmtRow = (label, s) =>
    label.padEnd(14) +
    pct(s.cagr).padEnd(11) +
    pct(s.mdd).padEnd(10) +
    (isNaN(s.calmar) ? '—' : (s.calmar === Infinity ? '∞' : s.calmar.toFixed(2))).padEnd(8) +
    (isNaN(s.t) ? 'NaN' : s.t.toFixed(2)).padEnd(8) +
    pct(s.exPd).padEnd(11) +
    (isNaN(s.h1t) ? '—' : s.h1t.toFixed(2)).padEnd(8) +
    (isNaN(s.h2t) ? '—' : s.h2t.toFixed(2)).padEnd(8) +
    (s.pass ? 'PASS' : 'FAIL');

  const ARMLABEL = { A: 'A PLAIN', B: 'B LIVE', C: 'C STATE-ONLY' };
  const blocks = {};
  for (const sm of [1.0, 0.5]) {
    const r = runArms(periods, seasonalGate, sm);
    const s = summarize(r.ABS, r.EXC, H);
    blocks[sm] = { ...r, s };
  }

  console.log(`\n=== EXPOSURE ARMS — Sharia TASI momentum combo, does the live overlay leak? ===`);
  console.log(`periods: ${nP} non-overlapping 20-session rebalances | universe: ${usable.length} names`);
  console.log(`combo: mom6-rank + 52wk-high-rank avg, liquid-half ∩ ≥2y, top-quintile, equal-weight | cost ${pct(COST_RT)} RT | COVID carved out`);
  console.log(`benchmark: equal-weight basket | excess = arm return − basket, one obs/period | targetVol ${TARGET_VOL}`);
  console.log(`live diagnostics: in-season ${(blocks[1.0].inSeasonFrac * 100).toFixed(0)}% of periods | vol-throttled (eB<1) ${(blocks[1.0].throttledFrac * 100).toFixed(0)}% | avg live exposure (sm=1) ${(blocks[1.0].avgE_B * 100).toFixed(0)}%\n`);

  const hdr = ['arm', 'CAGR', 'maxDD', 'Calmar', 't', 'excess/pd', 'h1 t', 'h2 t', 'gate'];
  for (const sm of [1.0, 0.5]) {
    console.log(`── stateMult = ${sm.toFixed(1)} ──`);
    console.log(hdr.map((x, i) => x.padEnd([14, 11, 10, 8, 8, 11, 8, 8][i] || 8)).join(''));
    for (const arm of ['A', 'B', 'C']) console.log(fmtRow(ARMLABEL[arm], blocks[sm].s[arm]));
    console.log('');
  }

  // ── A − B recoverable leak (the headline number) ──────────────────────────
  const A = blocks[1.0].s.A, B = blocks[1.0].s.B, C = blocks[1.0].s.C;
  const leakCagr = A.cagr - B.cagr;          // CAGR gap A − B at sm=1
  const decision = (A.cagr >= C.cagr - 1e-9 && C.cagr > B.cagr) || (A.cagr > B.cagr);
  console.log(`── A − B RECOVERABLE LEAK (stateMult = 1, apples-to-apples) ──`);
  console.log(`  A (plain) CAGR       ${pct(A.cagr)}   maxDD ${pct(A.mdd)}   Calmar ${A.calmar === Infinity ? '∞' : A.calmar.toFixed(2)}   t ${A.t.toFixed(2)}`);
  console.log(`  C (state-only) CAGR  ${pct(C.cagr)}   maxDD ${pct(C.mdd)}   Calmar ${C.calmar === Infinity ? '∞' : C.calmar.toFixed(2)}   t ${C.t.toFixed(2)}`);
  console.log(`  B (live) CAGR        ${pct(B.cagr)}   maxDD ${pct(B.mdd)}   Calmar ${B.calmar === Infinity ? '∞' : B.calmar.toFixed(2)}   t ${B.t.toFixed(2)}`);
  console.log(`  A − B leak           ${pct(leakCagr)}  /yr   (recoverable by stripping vol-target + seasonal-zero)`);
  console.log(`  ordering A ≥ C > B?  ${A.cagr >= C.cagr - 1e-9 && C.cagr > B.cagr ? 'YES' : 'NO'}  (A=${pct(A.cagr)} C=${pct(C.cagr)} B=${pct(B.cagr)})`);
  console.log(`  DECISION strip vol-target+seasonal: ${decision ? 'YES' : 'NO'}\n`);

  // ── BONUS: rebalance FREQUENCY on arm A (plain) ───────────────────────────
  function freqStats(h) {
    const ps = buildPeriods(data, cal, usable, h);
    const abs = ps.map(p => p.grossPort - COST_RT);    // arm A
    const { cagr, mdd, calmar } = equityStats(abs, h);
    // turnover: fraction of names replaced vs previous period's picks (avg per rebalance)
    let turnSum = 0, turnN = 0;
    for (let k = 1; k < ps.length; k++) {
      const prev = new Set(ps[k - 1].picks), cur = ps[k].picks;
      const replaced = cur.filter(s => !prev.has(s)).length;
      turnSum += cur.length ? replaced / cur.length : 0; turnN++;
    }
    const avgTurn = turnN ? turnSum / turnN : NaN;
    const rebPerYr = 252 / h;
    // annual cost drag ≈ rebalances/yr × avgTurnover × COST_RT  (one-way ~ half RT, but RT
    // already round-trips a name in/out; we report the live convention: cost per rebalance × freq)
    const annCostDrag = rebPerYr * avgTurn * COST_RT;
    return { h, n: ps.length, cagr, mdd, calmar, avgTurn, rebPerYr, annCostDrag };
  }
  const fM = freqStats(20), fQ = freqStats(60);
  console.log(`── BONUS: REBALANCE FREQUENCY on arm A (plain, e=1) ──`);
  console.log(`freq        periods  CAGR     maxDD    Calmar  avgTurnover  reb/yr  annCostDrag`);
  for (const f of [fM, fQ]) {
    const lbl = f.h === 20 ? 'monthly(20)' : 'quarterly(60)';
    console.log(
      lbl.padEnd(12) + String(f.n).padEnd(9) + pct(f.cagr).padEnd(9) + pct(f.mdd).padEnd(9) +
      (f.calmar === Infinity ? '∞' : f.calmar.toFixed(2)).padEnd(8) +
      (f.avgTurn * 100).toFixed(0).padEnd(1) + '%'.padEnd(12) +
      f.rebPerYr.toFixed(1).padEnd(8) + pct(f.annCostDrag));
  }
  console.log(`  quarterly retains ~the return at lower turnover? CAGR ${pct(fQ.cagr)} vs ${pct(fM.cagr)} (Δ ${pct(fQ.cagr - fM.cagr)}), cost drag ${pct(fQ.annCostDrag)} vs ${pct(fM.annCostDrag)}\n`);

  // ── machine-readable ──────────────────────────────────────────────────────
  const dump = (s) => ({ cagr: +(s.cagr * 100).toFixed(2), maxDD: +(s.mdd * 100).toFixed(1), calmar: s.calmar === Infinity ? null : +s.calmar.toFixed(2), t: +s.t.toFixed(2), exPd: +(s.exPd * 100).toFixed(3), h1t: +(s.h1t || 0).toFixed(2), h2t: +(s.h2t || 0).toFixed(2), pass: s.pass });
  console.log(`JSON ${JSON.stringify({
    periods: nP,
    inSeasonFrac: +(blocks[1.0].inSeasonFrac * 100).toFixed(0),
    throttledFrac: +(blocks[1.0].throttledFrac * 100).toFixed(0),
    avgLiveExposurePct: +(blocks[1.0].avgE_B * 100).toFixed(0),
    sm1: { A: dump(A), B: dump(B), C: dump(C) },
    sm05: { A: dump(blocks[0.5].s.A), B: dump(blocks[0.5].s.B), C: dump(blocks[0.5].s.C) },
    leakCagrPct: +(leakCagr * 100).toFixed(2),
    orderingAgeCgtB: A.cagr >= C.cagr - 1e-9 && C.cagr > B.cagr,
    decisionStrip: decision,
    freq: { monthly: { cagr: +(fM.cagr * 100).toFixed(2), turnover: +(fM.avgTurn * 100).toFixed(0), annCostDrag: +(fM.annCostDrag * 100).toFixed(2) }, quarterly: { cagr: +(fQ.cagr * 100).toFixed(2), turnover: +(fQ.avgTurn * 100).toFixed(0), annCostDrag: +(fQ.annCostDrag * 100).toFixed(2) } },
  })}`);
  process.exit(0);
}
main();
