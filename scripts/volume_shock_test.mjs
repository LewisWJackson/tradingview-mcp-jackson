/**
 * volume_shock_test.mjs — PRE-REGISTERED single edge test: VOLUME-SHOCK / ATTENTION REVERSAL.
 *
 * Kill-by-default. Decide PASS/FAIL strictly by the pre-committed gate; no goalpost-moving.
 *
 * HYPOTHESIS (committed before results): Retail-dominated TASI over-reacts to attention spikes;
 * names with an extreme volume+price spike mean-revert over the next 5-20 sessions. Trade the
 * REVERSAL of a spike-DOWN (buy the washout), long-only.
 *
 * EVENT = a day where daily volume > MULT × trailing-60-session MEDIAN volume (prior bars only)
 *         AND |daily return| in the top RETDECILE of that name's returns (point-in-time: the
 *         return-distribution cutoff uses only returns strictly PRIOR to the event day).
 *   - spike-DOWN cohort = event days with NEGATIVE return → expect positive forward drift.
 *   - spike-UP cohort   = event days with POSITIVE return → expect none/negative (untradeable).
 *
 * Universe = Sharia-compliant, liquid-half, ≥2y listed (match the live screen).
 * Cost 0.11% RT (env COST_RT default 0.0011) + slippage 0.15%/side. Buffer 0.30% RT also shown.
 * Horizons: 5, 10, 20 sessions forward. Primary horizon a priori = 10.
 * Abnormal = name forward return − ^TASI.SR forward return over the SAME calendar window.
 *
 * Point-in-time: trailing median uses only prior bars; return-decile cutoff uses only prior
 * returns; forward drift uses only future bars. No look-ahead.
 *
 * Run: node --experimental-sqlite scripts/volume_shock_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';
import { db } from '../dashboard/db.js';
import { mean, sd, tstat, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const pct = x => (x == null || isNaN(x)) ? '—' : (x * 100).toFixed(2) + '%';
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const quantile = (a, q) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const pos = (s.length - 1) * q; const lo = Math.floor(pos), hi = Math.ceil(pos); return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo); };

// ── Pre-registered parameters ────────────────────────────────────────────────
const COST_RT = parseFloat(process.env.COST_RT || '0.0011');   // 0.11% round-trip
const SLIP_SIDE = 0.0015;                                       // 0.15% per side
const COST_TOTAL_PRIMARY = COST_RT + 2 * SLIP_SIDE;            // RT cost + entry+exit slippage
const COST_TOTAL_BUFFER = 0.0030 + 2 * SLIP_SIDE;             // 0.30% RT robustness check
const HORIZONS = [5, 10, 20];
const PRIMARY_H = 10;
const MEDIAN_LB = 60;     // trailing median volume lookback
const MIN_HIST = 504;     // ≥2y listed
const SPLIT_DATE = '2024-01-01';  // OOS split by EVENT date (2021-23 / 2024-26)

// Specs: primary first (the verdict), then the single allowed robustness variant.
const SPECS = [
  { label: '3x/top-decile (PRIMARY)', volMult: 3, retQ: 0.90, primary: true },
  { label: '4x/top-5% (robustness) ', volMult: 4, retQ: 0.95, primary: false },
];

async function main() {
  // Universe: same construction as momentum_sharia (screener ∪ catalyst syms, compliant only).
  const screener = TASI_STOCKS.map(s => s.sym.replace('TADAWUL:', ''));
  let catalyst = [];
  try { catalyst = db.prepare("SELECT DISTINCT sym FROM catalyst_events").all().map(r => r.sym.replace('TADAWUL:', '')).filter(s => /^[1-9]\d{3}$/.test(s)); } catch {}
  const allCodes = [...new Set([...screener, ...catalyst])];
  const compliant = allCodes.filter(c => getShariaStatus(`TADAWUL:${c}`).status === 'compliant');
  const ysyms = compliant.map(c => c + '.SR');
  console.error(`compliant universe: ${compliant.length} of ${allCodes.length} codes; warming...`);
  await warm([...ysyms, '^TASI.SR'], '10y');

  // Benchmark: ^TASI.SR close series keyed by ISO date.
  const benchBars = await getBars('^TASI.SR', '10y');
  if (benchBars.length < 200) { console.error('FATAL: no benchmark data for ^TASI.SR'); process.exit(1); }
  const benchClose = {}; for (const b of benchBars) benchClose[iso(b.t)] = b.c;
  const benchDates = benchBars.map(b => iso(b.t));
  const benchIdx = Object.fromEntries(benchDates.map((d, i) => [d, i]));

  // Load per-name price/volume series.
  const data = {};
  for (const ys of ysyms) {
    const b = await getBars(ys, '10y');
    if (b.length < MIN_HIST + 100) continue;
    data[ys] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v || 0) };
  }
  const names = Object.keys(data);
  console.error(`compliant w/ ≥${(MIN_HIST / 252).toFixed(0)}y price history: ${names.length}`);

  // liquid-half filter: rank names by median(close*volume) over full history, keep top 50%.
  const liqOf = {};
  for (const s of names) { const a = data[s]; const dv = a.c.map((c, i) => c * a.v[i]).filter(x => x > 0); liqOf[s] = median(dv); }
  const liqSorted = [...names].sort((x, y) => liqOf[y] - liqOf[x]);
  const liquidHalf = new Set(liqSorted.slice(0, Math.ceil(liqSorted.length / 2)));
  const universe = names.filter(s => liquidHalf.has(s));
  console.error(`liquid-half universe: ${universe.length} names`);

  // ── Momentum top-quintile membership per month (for correlation/overlap check) ──
  // mom6 = c[i-21]/c[i-126]-1, monthly rebalance, liquid-half, top-quintile of mom — the live combo
  // proxy (using mom6 alone is sufficient for an overlap/correlation flag).
  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort();
  const idxOf = {}; for (const s of names) { idxOf[s] = Object.fromEntries(data[s].dates.map((d, i) => [d, i])); }
  const momTopByMonth = {};  // 'YYYY-MM' -> Set of names in mom top-quintile that month
  const monthEnds = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) monthEnds.push(allDates[i]);
  for (const d0 of monthEnds) {
    const rows = [];
    for (const s of universe) { const i = idxOf[s][d0]; if (i == null || i < 126) continue; const m = data[s].c[i - 21] / data[s].c[i - 126] - 1; if (isFinite(m)) rows.push({ s, m }); }
    if (rows.length < 10) continue;
    rows.sort((a, b) => b.m - a.m);
    momTopByMonth[d0.slice(0, 7)] = new Set(rows.slice(0, Math.max(3, Math.floor(rows.length / 5))).map(r => r.s));
  }
  // momentum monthly excess series (for correlation): top-quintile fwd-1mo vs equal-weight basket.
  const momMonthlyEx = {};  // 'YYYY-MM' -> excess
  for (let mi = 0; mi < monthEnds.length - 1; mi++) {
    const d0 = monthEnds[mi], d1 = monthEnds[mi + 1];
    const rows = [];
    for (const s of universe) { const i = idxOf[s][d0], j = idxOf[s][d1]; if (i == null || j == null || i < 126) continue; const m = data[s].c[i - 21] / data[s].c[i - 126] - 1; if (!isFinite(m)) continue; rows.push({ s, m, fwd: data[s].c[j] / data[s].c[i] - 1 }); }
    if (rows.length < 10) continue;
    rows.sort((a, b) => b.m - a.m);
    const top = rows.slice(0, Math.max(3, Math.floor(rows.length / 5)));
    const basket = mean(rows.map(r => r.fwd));
    momMonthlyEx[d0.slice(0, 7)] = mean(top.map(r => r.fwd)) - basket;
  }

  // ── Event detection + forward abnormal returns, point-in-time ──
  function fwdAbnormal(s, i, h) {
    const a = data[s];
    const j = i + h;
    if (j >= a.c.length) return null;
    const nameRet = a.c[j] / a.c[i] - 1;
    // Benchmark over the SAME calendar window [date(i), date(j)].
    const di = a.dates[i], dj = a.dates[j];
    const bi = benchIdx[di], bj = benchIdx[dj];
    if (bi == null || bj == null) return null;
    const benchRet = benchClose[dj] / benchClose[di] - 1;
    return nameRet - benchRet;
  }

  function detectEvents(spec) {
    // Returns { down: [...events], up: [...events] }; each event = {s, i, date, ret, abn:{5,10,20}}
    const down = [], up = [];
    for (const s of universe) {
      const a = data[s];
      const rets = a.c.map((c, i) => i === 0 ? 0 : c / a.c[i - 1] - 1);
      for (let i = MIN_HIST; i < a.c.length - 5; i++) {
        // trailing-60 median volume, prior bars only [i-60, i-1]
        const volWin = a.v.slice(i - MEDIAN_LB, i).filter(v => v > 0);
        if (volWin.length < MEDIAN_LB * 0.7) continue;
        const medVol = median(volWin);
        if (!(medVol > 0) || !(a.v[i] > spec.volMult * medVol)) continue;
        // return decile cutoff: |return| in top (1-retQ) of PRIOR returns of this name.
        const priorAbs = rets.slice(1, i).map(Math.abs).filter(x => x > 0);
        if (priorAbs.length < 100) continue;
        const cutoff = quantile(priorAbs, spec.retQ);
        const r = rets[i];
        if (!(Math.abs(r) >= cutoff)) continue;
        const abn = {}; let ok = true;
        for (const h of HORIZONS) { const v = fwdAbnormal(s, i, h); if (v == null) { ok = false; break; } abn[h] = v; }
        if (!ok) continue;
        const ev = { s, i, date: a.dates[i], ret: r, abn };
        (r < 0 ? down : up).push(ev);
      }
    }
    return { down, up };
  }

  // Per-period non-overlapping series: collapse events into NON-OVERLAPPING windows of length
  // PRIMARY_H per name (greedy by date), one obs per window = the cross-clustering-robust unit.
  // We pool across names but enforce non-overlap WITHIN a name so a single spike isn't counted
  // multiple times. Then group into monthly buckets for the per-period series.
  function nonOverlapMonthly(events, h, cost) {
    // sort per name by date, greedily skip events within h sessions of the last taken.
    const byName = {};
    for (const e of events) (byName[e.s] ||= []).push(e);
    const taken = [];
    for (const s of Object.keys(byName)) {
      const arr = byName[s].sort((a, b) => a.i - b.i);
      let lastI = -Infinity;
      for (const e of arr) { if (e.i - lastI >= h) { taken.push(e); lastI = e.i; } }
    }
    // monthly buckets by event date → mean NET abnormal of trades opened that month.
    const buckets = {};
    for (const e of taken) { const mk = e.date.slice(0, 7); (buckets[mk] ||= []).push(e.abn[h] - cost); }
    const months = Object.keys(buckets).sort();
    const series = months.map(mk => mean(buckets[mk]));
    return { months, series, nTrades: taken.length };
  }

  function summarize(label, ev) {
    console.log(`\n=== ${label} ===`);
    for (const cohort of ['down', 'up']) {
      const evs = ev[cohort];
      console.log(`\n  cohort=${cohort.toUpperCase()}  raw events n=${evs.length}`);
      for (const h of HORIZONS) {
        const gross = mean(evs.map(e => e.abn[h]));
        const netP = mean(evs.map(e => e.abn[h] - COST_TOTAL_PRIMARY));
        const tg = tstat(evs.map(e => e.abn[h]));
        console.log(`    H=${String(h).padStart(2)}  gross abn ${pct(gross).padStart(8)}  net(0.11%) ${pct(netP).padStart(8)}  event-t ${isNaN(tg) ? '—' : tg.toFixed(2)}`);
      }
    }
    return ev;
  }

  function gateReport(label, downEvents) {
    // Primary horizon, primary cost. Non-overlapping monthly per-period excess series.
    const { months, series, nTrades } = nonOverlapMonthly(downEvents, PRIMARY_H, COST_TOTAL_PRIMARY);
    const gate = portfolioGuillotine(series, {});
    // OOS by event date.
    const h1 = [], h2 = [];
    for (let k = 0; k < months.length; k++) (months[k] < SPLIT_DATE.slice(0, 7) ? h1 : h2).push(series[k]);
    const oosH1 = mean(h1), oosH2 = mean(h2);
    const oosPass = oosH1 > 0 && oosH2 > 0;
    // cost-robust @0.30%
    const { series: serBuf } = nonOverlapMonthly(downEvents, PRIMARY_H, COST_TOTAL_BUFFER);
    const gateBuf = portfolioGuillotine(serBuf, {});
    const costRobust = mean(serBuf) > 0;
    // correlation with momentum monthly excess (aligned by month key).
    const xs = [], ys = [];
    for (let k = 0; k < months.length; k++) { const mk = months[k]; if (momMonthlyEx[mk] != null) { xs.push(series[k]); ys.push(momMonthlyEx[mk]); } }
    const corr = (() => { if (xs.length < 6) return null; const mx = mean(xs), my = mean(ys); let num = 0, dx = 0, dy = 0; for (let k = 0; k < xs.length; k++) { num += (xs[k] - mx) * (ys[k] - my); dx += (xs[k] - mx) ** 2; dy += (ys[k] - my) ** 2; } return num / Math.sqrt(dx * dy); })();
    // overlap: fraction of spike-down event names that were in mom top-quintile that month.
    let inMom = 0, tot = 0;
    for (const e of downEvents) { const mk = e.date.slice(0, 7); const set = momTopByMonth[mk]; if (set) { tot++; if (set.has(e.s)) inMom++; } }
    const overlap = tot ? inMom / tot : null;

    console.log(`\n  ── GATE [${label}] spike-DOWN, H=${PRIMARY_H}, cost ${(COST_TOTAL_PRIMARY * 100).toFixed(2)}% ──`);
    console.log(`    non-overlap trades: ${nTrades}, per-period months: ${months.length}`);
    console.log(`    per-period excess: ${pct(gate.excessPerPeriod)}/mo   guillotine t: ${isNaN(gate.t) ? '—' : gate.t.toFixed(2)}   GATE: ${gate.pass ? 'PASS' : 'fail'}`);
    console.log(`    OOS  H1(<2024) ${pct(oosH1)} (${h1.length}mo)  H2(≥2024) ${pct(oosH2)} (${h2.length}mo)  → ${oosPass ? 'both+ PASS' : 'fail'}`);
    console.log(`    cost-robust @0.30%RT(+slip): mean ${pct(mean(serBuf))}  guillotine t ${isNaN(gateBuf.t) ? '—' : gateBuf.t.toFixed(2)}  → ${costRobust ? 'PASS' : 'fail'}`);
    console.log(`    momentum corr (monthly excess): ${corr == null ? '—' : corr.toFixed(2)}  (gate <0.40)   spike-name overlap w/ mom top-Q: ${overlap == null ? '—' : (overlap * 100).toFixed(1) + '%'}`);

    return { gate, oosPass, oosH1, oosH2, costRobust, gateBuf, corr, overlap, nTrades, months: months.length, series };
  }

  console.log(`\n#########################################################################`);
  console.log(`# VOLUME-SHOCK / ATTENTION-REVERSAL — pre-registered single test`);
  console.log(`# universe: ${universe.length} Sharia-compliant liquid-half ≥2y names | bench ^TASI.SR`);
  console.log(`# cost: RT ${(COST_RT * 100).toFixed(2)}% + slip ${(SLIP_SIDE * 100).toFixed(2)}%/side = ${(COST_TOTAL_PRIMARY * 100).toFixed(2)}% total/trade`);
  console.log(`#########################################################################`);

  const results = {};
  for (const spec of SPECS) {
    const ev = detectEvents(spec);
    summarize(spec.label, ev);
    results[spec.label] = gateReport(spec.label, ev.down);
    results[spec.label].upN = ev.up.length;
    results[spec.label].downN = ev.down.length;
    results[spec.label].primary = spec.primary;
  }

  // ── VERDICT on the PRIMARY spec ──
  const prim = SPECS.find(s => s.primary).label;
  const R = results[prim];
  const netPrimaryPos = R.gate.excessPerPeriod > 0;  // net excess at H=10 (primary)
  const allPass = R.gate.pass && netPrimaryPos && R.oosPass && R.costRobust && (R.corr == null || R.corr < 0.40);
  console.log(`\n#########################################################################`);
  console.log(`# PRE-REGISTERED GATE — PRIMARY spec (${prim})`);
  console.log(`#   net excess @H10 > 0 ............ ${netPrimaryPos ? 'PASS' : 'FAIL'}`);
  console.log(`#   guillotine per-period t > 2 .... ${R.gate.t > 2 ? 'PASS' : 'FAIL'} (t=${isNaN(R.gate.t) ? 'NaN' : R.gate.t.toFixed(2)})`);
  console.log(`#   OOS positive both halves ....... ${R.oosPass ? 'PASS' : 'FAIL'}`);
  console.log(`#   cost-robust @0.30% ............. ${R.costRobust ? 'PASS' : 'FAIL'}`);
  console.log(`#   momentum corr < 0.40 .......... ${R.corr == null ? 'N/A (overlap reported)' : (R.corr < 0.40 ? 'PASS' : 'FAIL')} (corr=${R.corr == null ? '—' : R.corr.toFixed(2)}, overlap=${R.overlap == null ? '—' : (R.overlap * 100).toFixed(1) + '%'})`);
  console.log(`#`);
  console.log(`#   VERDICT: ${allPass ? 'PASS — new edge candidate' : 'FAIL — volume-shock reversal is DEAD'}`);
  console.log(`#########################################################################`);

  process.exit(0);
}
main();
