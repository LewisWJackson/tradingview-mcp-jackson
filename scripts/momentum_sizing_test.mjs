/**
 * momentum_sizing_test.mjs — pick a position-sizing/risk model for the momentum edge.
 *
 * Validation is done (excess t=3.60, persistent both halves). The open problem is the
 * lumpy ABSOLUTE return: 2025 was −20%. Sizing can't add edge, but it can cut the
 * drawdown you have to survive. We backtest schemes on the SAME momentum portfolio and
 * judge them on drawdown-adjusted return + worst year, not headline CAGR.
 *
 * Schemes:
 *   A equal-weight (baseline)
 *   B inverse-vol weights (calmer names get more — diversifies risk, not direction)
 *   C vol-target 15% (scale gross exposure to a vol budget; shrink in turbulent tape)
 *   D vol-target + seasonal sit-out (cash in the 2 weakest calendar months)
 *   E vol-target + regime filter (cash when TASI < its 200-day average)
 *   F invvol + vol-target + seasonal (combined "recommended")
 *
 * One obs / non-overlap 20-session rebalance, ex-COVID, 0.11% RT, cash earns 0 (conservative).
 * Run: node scripts/momentum_sizing_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const TARGET_VOL = +process.env.TVOL || 0.15;            // annual vol budget
const VOL_LOOKBACK = 6;                                   // periods of trailing strat vol
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(1) + '%';

async function main() {
  await warm([...TASI_STOCKS.map(s => toYahooSym(s.sym)), '^TASI.SR'], '10y');
  const data = {}, compliant = new Set();
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { closes: b.map(x => x.c), volumes: b.map(x => x.v), dateIdx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])), dates: b.map(x => iso(x.t)) };
    if (getShariaStatus(s.sym).status === 'compliant') compliant.add(s.sym);
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t)), idxClose = ib.map(x => x.c);
  const idxIdx = Object.fromEntries(cal.map((d, i) => [d, i]));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const volAt = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i < 60) return null; const r = []; for (let k = i - 59; k <= i; k++) if (k > 0) r.push(d.closes[k] / d.closes[k - 1] - 1); return sd(r); };

  // weakest 2 calendar months from compliant-basket daily history (seasonal overlay)
  const monthRet = {};
  for (const s of compliant) { const d = data[s]; for (let k = 1; k < d.closes.length; k++) { const r = d.closes[k] / d.closes[k - 1] - 1; if (isFinite(r)) (monthRet[+d.dates[k].slice(5, 7)] ||= []).push(r); } }
  const weakest = Object.entries(monthRet).map(([m, a]) => [+m, mean(a)]).sort((a, b) => a[1] - b[1]).slice(0, 2).map(e => e[0]);

  // build per-period: picks + their fwd returns + per-name vols
  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const momRows = [];
    for (const s of usable) {
      if (!compliant.has(s)) continue; const d = data[s]; const i = d.dateIdx[date];
      if (i == null || i < 504 || i + H >= d.closes.length) continue;
      const mom6 = d.closes[i - 21] / d.closes[i - 126] - 1; if (!isFinite(mom6)) continue;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.closes[k] * (d.volumes[k] || 0); n++; }
      momRows.push({ s, mom6, liq: liq / n });
    }
    if (momRows.length < 10) continue;
    const liquid = [...momRows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(momRows.length * 0.5));
    const ranked = [...liquid].sort((a, b) => b.mom6 - a.mom6).slice(0, Math.max(5, Math.floor(liquid.length * 0.2)));
    const picks = [];
    for (const r of ranked) { const ret = fwd(r.s, date); const v = volAt(r.s, date); if (ret != null && v != null && v > 0) picks.push({ ret, v }); }
    if (!picks.length) continue;
    const month = +date.slice(5, 7);
    const ii = idxIdx[date];
    const idx200 = ii != null && ii >= 200 ? mean(idxClose.slice(ii - 199, ii + 1)) : null;
    const regimeOn = idx200 == null ? true : idxClose[ii] >= idx200;
    periods.push({ date, year: +date.slice(0, 4), picks, month, regimeOn });
  }

  // period return under a weighting scheme (gross, before exposure scalar)
  const grossEW = p => mean(p.picks.map(x => x.ret)) - COST_RT;
  const grossInvVol = p => { const w = p.picks.map(x => 1 / x.v); const sw = w.reduce((a, b) => a + b, 0); return p.picks.reduce((acc, x, k) => acc + w[k] / sw * x.ret, 0) - COST_RT; };

  // run a scheme → equity curve of period returns
  function run({ weight = 'ew', volTarget = false, seasonal = false, regime = false }) {
    const gross = [], rets = [], exps = [];
    for (const p of periods) gross.push(weight === 'invvol' ? grossInvVol(p) : grossEW(p));
    const tgtPeriodVol = TARGET_VOL * Math.sqrt(H / 252);
    for (let t = 0; t < periods.length; t++) {
      let e = 1;
      if (volTarget) { const hist = gross.slice(Math.max(0, t - VOL_LOOKBACK), t); const rv = sd(hist); e = (rv && rv > 0) ? Math.min(1, tgtPeriodVol / rv) : 1; }
      if (seasonal && weakest.includes(periods[t].month)) e = 0;
      if (regime && !periods[t].regimeOn) e = 0;
      rets.push(e * gross[t]); exps.push(e);
    }
    // metrics
    let eq = 1, pk = 1, mdd = 0; const yr = {};
    for (let t = 0; t < rets.length; t++) { eq *= 1 + rets[t]; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); (yr[periods[t].year] ||= 1); yr[periods[t].year] *= 1 + rets[t]; }
    const years = rets.length * H / 252;
    const cagr = Math.pow(eq, 1 / years) - 1;
    const annVol = sd(rets) * Math.sqrt(252 / H);
    const sharpe = annVol > 0 ? cagr / annVol : NaN;
    const worstYr = Math.min(...Object.values(yr).map(v => v - 1));
    return { cagr, annVol, sharpe, mdd, worstYr, exp: mean(exps) };
  }

  const schemes = [
    ['A equal-weight', { weight: 'ew' }],
    ['B inverse-vol', { weight: 'invvol' }],
    ['C voltarget15', { weight: 'ew', volTarget: true }],
    ['D voltgt+season', { weight: 'ew', volTarget: true, seasonal: true }],
    ['E voltgt+regime', { weight: 'ew', volTarget: true, regime: true }],
    ['F invvol+vt+seas', { weight: 'invvol', volTarget: true, seasonal: true }],
  ];
  console.log(`\n=== MOMENTUM POSITION-SIZING — ${periods.length} periods, ex-COVID, vol budget ${pct(TARGET_VOL)}, cash=0% ===`);
  console.log(`Weakest months (seasonal sit-out): ${weakest.join(', ')}. Judge on maxDD + worst-year, not just CAGR.`);
  console.log(`\n  ${'scheme'.padEnd(18)} ${'CAGR'.padStart(7)} ${'annVol'.padStart(7)} ${'Sharpe'.padStart(7)} ${'maxDD'.padStart(7)} ${'worstYr'.padStart(8)} ${'avgExp'.padStart(7)}`);
  for (const [label, cfg] of schemes) {
    const m = run(cfg);
    console.log(`  ${label.padEnd(18)} ${pct(m.cagr).padStart(7)} ${pct(m.annVol).padStart(7)} ${m.sharpe.toFixed(2).padStart(7)} ${pct(m.mdd).padStart(7)} ${pct(m.worstYr).padStart(8)} ${pct(m.exp).padStart(7)}`);
  }
  console.log(`\n  Best = highest Sharpe with shallowest maxDD/worstYr. Vol-target shrinks exposure when the tape gets wild (the 2025 fix).`);
  process.exit(0);
}
main();
