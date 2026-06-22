/**
 * compounding_geometry_test.mjs — Test Plan #1: does smarter SIZING of the SAME
 * momentum picks compound better (higher CAGR, lower max drawdown), out-of-sample?
 *
 * ALL-STOCKS concept proof — Sharia compliance is NOT filtered here (applied later as a
 * toggle on live picks); survivorship accepted. See
 * docs/research/2026-06-21-test-plan-1-compounding-geometry.md and the data_hygiene_audit.
 *
 * Baseline = equal-weight top-quintile 6-1mo momentum, monthly rebalance, Derayah 0.11% RT.
 * Levers stacked incrementally on the SAME picks:
 *   +L1 vol-target  — schemeDExposure scales gross so realized vol ≈ targetVol (≤1, no leverage)
 *   +L2 conviction  — rank-weight within the picks, capped at maxWeight
 *   +L3 brake       — cut exposure 50% when down > brakeThresh from the equity peak
 * Prints CAGR + maxDD for each stack, IN-SAMPLE (first half) vs OUT-OF-SAMPLE (second half),
 * an OOS PASS/FAIL vs baseline, and a ±20% parameter-jitter robustness pass.
 * Run: node scripts/compounding_geometry_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { schemeDExposure } from '../dashboard/momentum_screen.mjs';
import { annualizedVol, convictionWeights, drawdownBrake } from '../dashboard/compounding_geometry.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = process.env.START || '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const VOLWIN = 60; // trailing sessions used to estimate realized vol (point-in-time)
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(1) + '%';

// Compound a chronological per-period return series → CAGR + max drawdown.
function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  return { cagr: yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN, mdd, eq };
}

// Estimate the equal-weight basket's annualized vol from the last VOLWIN daily returns
// ending at each pick's index i (position-wise mean across picks; same-exchange day grid).
function basketRealizedVol(picksData) {
  const series = [];
  for (let off = VOLWIN; off >= 1; off--) {
    const rs = [];
    for (const p of picksData) {
      const a = p.c[p.i - off], b = p.c[p.i - off + 1];
      if (a > 0 && b > 0) rs.push(b / a - 1);
    }
    if (rs.length) series.push(mean(rs));
  }
  return annualizedVol(series);
}

// Run one lever configuration over the period series → per-period return array.
function runStrategy(periods, cfg) {
  const { voltarget = false, conviction = false, brake = false,
          targetVol = 0.15, maxWeight = 0.25, brakeThresh = 0.15 } = cfg;
  let eq = 1, pk = 1, braked = false;
  const rets = [];
  for (const p of periods) {
    const n = p.picks.length;
    const w = conviction ? convictionWeights(p.picks.map(x => x.mom6), { maxWeight })
                         : p.picks.map(() => 1 / n);
    const basketRet = p.picks.reduce((s, x, idx) => s + w[idx] * x.fwd, 0);
    let E = 1;
    if (voltarget) E = schemeDExposure({ realizedVol: p.realizedVol, targetVol, inSeason: true, stateMult: 1 });
    let bmult = 1;
    if (brake) { const r = drawdownBrake({ eq, peak: pk, braked, threshold: brakeThresh }); bmult = r.mult; braked = r.braked; }
    const Ef = E * bmult;
    const ret = Ef * basketRet - COST_RT * Ef; // cost charged on the deployed fraction only
    rets.push(ret);
    eq *= 1 + ret; pk = Math.max(pk, eq);
  }
  return rets;
}

function summarize(periods, cfg) {
  const mid = Math.floor(periods.length / 2);
  const all = equityStats(runStrategy(periods, cfg));
  const is = equityStats(runStrategy(periods.slice(0, mid), cfg));
  const oos = equityStats(runStrategy(periods.slice(mid), cfg));
  return { all, is, oos };
}

(async () => {
  console.log('Warming bars cache (all TASI stocks, 10y)…');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  // Load price series for every name (NO Sharia filter — all stocks).
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y');
    if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };

  // Build the period series: same picks logic as strategy_validation.mjs, all-stocks.
  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let liq = 0, nn = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); nn++; }
      rows.push({ s, mom6, liq: liq / nn, i });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    const pickRows = [...liquid].sort((a, b) => b.mom6 - a.mom6).slice(0, Math.max(5, Math.floor(liquid.length * 0.2)));
    const picks = pickRows
      .map(r => ({ s: r.s, mom6: r.mom6, fwd: fwd(r.s, date), c: data[r.s].c, i: r.i }))
      .filter(p => p.fwd != null);
    if (!picks.length) continue;
    const realizedVol = basketRealizedVol(picks);
    periods.push({ date, picks: picks.map(p => ({ s: p.s, mom6: p.mom6, fwd: p.fwd })), realizedVol });
  }

  console.log(`\nPeriods: ${periods.length}  (${periods[0]?.date} → ${periods.at(-1)?.date}), all-stocks, COVID carved out\n`);

  const stacks = [
    ['Baseline (equal-weight)', {}],
    ['+L1 vol-target',          { voltarget: true }],
    ['+L1 vol-target @0.18',    { voltarget: true, targetVol: 0.18 }], // recal: 0.15 throttled high-vol names
    ['+L1+L2 conviction',       { voltarget: true, conviction: true }],
    ['L3 brake ONLY (eq-wt)',   { brake: true }],                      // isolate the brake's contribution
    ['+L1+L2+L3 brake (FULL)',  { voltarget: true, conviction: true, brake: true }],
  ];

  // Table: CAGR + maxDD, in-sample vs out-of-sample.
  const fmt = s => `CAGR ${pct(s.cagr).padStart(6)}  maxDD ${pct(s.mdd).padStart(6)}`;
  console.log('STACK'.padEnd(26), '| IN-SAMPLE'.padEnd(30), '| OUT-OF-SAMPLE');
  console.log('-'.repeat(86));
  let base;
  for (const [name, cfg] of stacks) {
    const r = summarize(periods, cfg);
    if (!base) base = r;
    console.log(name.padEnd(26), '|', fmt(r.is).padEnd(28), '|', fmt(r.oos));
  }

  // OOS gate vs baseline (SPEC rule): WIN if it raises CAGR OR cuts drawdown MEANINGFULLY,
  // without MEANINGFULLY worsening the other. "Meaningful" = CAGR Δ beyond ±1.0pt, maxDD Δ
  // beyond ±2.0pt (noise floor on a ~32-period OOS half).
  const CAGR_EPS = 0.010, DD_EPS = 0.020;
  console.log('\nOOS GATE (vs baseline, out-of-sample half — spec OR rule):');
  for (const [name, cfg] of stacks.slice(1)) {
    const r = summarize(periods, cfg);
    const dCagr = r.oos.cagr - base.oos.cagr;        // + = better
    const dDD = r.oos.mdd - base.oos.mdd;            // + = shallower (better); mdd is negative
    const cagrUp = dCagr > CAGR_EPS, cagrWorse = dCagr < -CAGR_EPS;
    const ddUp = dDD > DD_EPS, ddWorse = dDD < -DD_EPS;
    const pass = (cagrUp || ddUp) && !cagrWorse && !ddWorse;
    console.log(`  ${name.padEnd(24)} ${pass ? 'PASS' : 'FAIL'}  (CAGR Δ ${pct(dCagr)}${cagrWorse ? ' WORSE' : cagrUp ? ' up' : ' flat'}, maxDD Δ ${pct(dDD)}${ddWorse ? ' WORSE' : ddUp ? ' better' : ' flat'})`);
  }

  // Robustness: ±20% jitter on the full-stack params → OOS CAGR range.
  console.log('\nROBUSTNESS — full stack, ±20% param jitter (OOS CAGR should stay > baseline):');
  const baseOosCagr = base.oos.cagr;
  for (const f of [0.8, 1.0, 1.2]) {
    const r = summarize(periods, { voltarget: true, conviction: true, brake: true,
      targetVol: 0.15 * f, maxWeight: 0.25 * f, brakeThresh: 0.15 * f });
    console.log(`  jitter ×${f}: OOS CAGR ${pct(r.oos.cagr)}  (vs baseline ${pct(baseOosCagr)}, Δ ${pct(r.oos.cagr - baseOosCagr)})`);
  }
})();
