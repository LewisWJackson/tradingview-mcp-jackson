/**
 * momentum_lowvol_test.mjs — CONTAINED refinement of the validated Sharia TASI momentum edge:
 * within the momentum top-quintile, does a LOW-VOLATILITY filter improve risk-adjusted return?
 *
 * The validated edge (dashboard/strategy_validation.mjs + scripts/breadth_test.mjs) is an
 * EQUAL-WEIGHT top-quintile of the liquid-half ∩ ≥2y-listed TASI universe, ranked by the live
 * combo (mom6 percentile-rank + 52-week-high-proximity percentile-rank), rebalanced every
 * ~20 sessions. This script copies that loop line-for-line (same universe / combo / cost /
 * COVID carve-out / point-in-time guards), then at each rebalance, WITHIN the top-quintile,
 * computes each name's trailing realized volatility (std of daily returns over the last 60
 * sessions, bars up to the rebalance index only — point-in-time) and tests two variants vs the
 * plain quintile baseline:
 *
 *   (baseline)      full top-quintile, equal-weight                      [== live grade]
 *   (low-vol-half)  keep the lower-vol 50% of the quintile, equal-weight
 *   (inverse-vol)   full quintile, weight ∝ 1/vol (normalized)
 *
 * For each: ABS CAGR, excess/period, guillotine t, maxDD, Sharpe-ish (mean/std of period
 * excess), %positive. Hypothesis: lower-vol quintile names deliver similar return with smaller
 * drawdown → better geometric compounding (drawdown was the only sizing lever that survived).
 *
 * Pre-registered KEEP-criterion: keep a variant only if it retains ≥80% of the quintile's
 * excess return AND cuts maxDD by ≥3-4pp (and t stays > 2). Shaving return without cutting DD
 * meaningfully → REJECT.
 *
 * Mirrors breadth_test.mjs on universe/combo/cost so the quintile baseline here == the live
 * grade. Derayah 0.11% RT. COVID carved out. Run:
 *   node --experimental-sqlite scripts/momentum_lowvol_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const H = 20, MIN_HISTORY = 210, VOL_WIN = 60, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
// CAGR + maxDD from a per-period (20-session) ABS return series, compounded.
function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  return { cagr, mdd, totalReturn: eq - 1 };
}
// trailing realized vol: std of the last VOL_WIN daily simple returns, bars up to index i only.
function trailingVol(c, i, win = VOL_WIN) {
  const lo = i - win;
  if (lo < 1) return null;
  const rets = [];
  for (let k = lo + 1; k <= i; k++) { const r = c[k] / c[k - 1] - 1; if (isFinite(r)) rets.push(r); }
  if (rets.length < win * 0.8) return null;
  const v = sd(rets);
  return isFinite(v) && v > 0 ? v : null;
}

async function main() {
  console.error(`loading TASI universe from cache ...`);
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
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const VARIANTS = ['baseline', 'lowvol-half', 'inverse-vol'];
  const ABS = Object.fromEntries(VARIANTS.map(v => [v, []]));
  const EXC = Object.fromEntries(VARIANTS.map(v => [v, []]));
  const POS = Object.fromEntries(VARIANTS.map(v => [v, 0]));
  const NHELD = Object.fromEntries(VARIANTS.map(v => [v, []]));
  let nPeriods = 0;

  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;              // ≥2y listed, point-in-time
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let hi52 = -Infinity; for (let k = Math.max(0, i - 251); k <= i; k++) hi52 = Math.max(hi52, d.c[k]);   // 52wk high, bars up to i only
      const wk52 = hi52 > 0 ? d.c[i] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); n++; }
      rows.push({ s, mom6, wk52, liq: liq / n });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));   // liquid half
    // LIVE combo: rank-average of mom6 pctile + wk52 pctile, within the liquid pool, point-in-time.
    const both = liquid.filter(r => r.wk52 != null);
    const pool = both.length >= 10 ? both : liquid;
    const pctRank = (arr, key) => { const a = [...arr].sort((x, y) => x[key] - y[key]); a.forEach((r, j) => r['_r_' + key] = arr.length > 1 ? j / (arr.length - 1) : 0.5); };
    pctRank(pool, 'mom6');
    if (pool === both) pctRank(pool, 'wk52');
    pool.forEach(r => r.combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6);
    const ranked = [...pool].sort((a, b) => b.combo - a.combo);
    const kQuint = Math.max(5, Math.floor(pool.length * 0.2));               // same quintile cut as live grade
    const quintile = ranked.slice(0, kQuint).map(r => r.s);                   // top-quintile, highest-combo first

    // build per-name {fwd, vol} for the quintile; drop names missing either (point-in-time vol)
    const recs = [];
    for (const s of quintile) {
      const r = fwd(s, date); if (r == null) continue;
      const vol = trailingVol(data[s].c, data[s].idx[date]); if (vol == null) continue;
      recs.push({ s, r, vol });
    }
    if (recs.length < 4) continue;   // need enough names to split a half meaningfully

    // (baseline) full quintile, equal-weight
    {
      const port = mean(recs.map(x => x.r)) - COST_RT;
      ABS.baseline.push(port); EXC.baseline.push(port - bench); if (port - bench > 0) POS.baseline++;
      NHELD.baseline.push(recs.length);
    }
    // (low-vol-half) keep the lower-vol 50% by trailing vol, equal-weight
    {
      const sorted = [...recs].sort((a, b) => a.vol - b.vol);
      const keep = sorted.slice(0, Math.max(2, Math.ceil(sorted.length * 0.5)));
      const port = mean(keep.map(x => x.r)) - COST_RT;
      ABS['lowvol-half'].push(port); EXC['lowvol-half'].push(port - bench); if (port - bench > 0) POS['lowvol-half']++;
      NHELD['lowvol-half'].push(keep.length);
    }
    // (inverse-vol) full quintile, weight ∝ 1/vol (turnover/cost identical to baseline: full set held)
    {
      const w = recs.map(x => 1 / x.vol);
      const wsum = w.reduce((a, b) => a + b, 0);
      const gross = recs.reduce((acc, x, j) => acc + (w[j] / wsum) * x.r, 0);
      const port = gross - COST_RT;
      ABS['inverse-vol'].push(port); EXC['inverse-vol'].push(port - bench); if (port - bench > 0) POS['inverse-vol']++;
      NHELD['inverse-vol'].push(recs.length);
    }
    nPeriods++;
  }

  // ── TABLE ────────────────────────────────────────────────────────────────
  console.log(`\n=== MOMENTUM QUINTILE × LOW-VOL FILTER — Sharia TASI momentum combo ===`);
  console.log(`periods: ${nPeriods} non-overlapping 20-session rebalances | universe: ${usable.length} names`);
  console.log(`combo: mom6-rank + 52wk-high-rank avg, liquid-half ∩ ≥2y | vol: std of last ${VOL_WIN} daily rets (point-in-time)`);
  console.log(`cost ${pct(COST_RT)} RT (Derayah) | COVID carved out | benchmark: equal-weight basket (all usable names)\n`);

  const labelOf = { 'baseline': 'quintile (EW)', 'lowvol-half': 'low-vol half', 'inverse-vol': 'inverse-vol' };
  const rowsOut = [];
  const hdr = ['variant', 'avgN', 'ABS CAGR', 'excess/pd', 'guillotine t', 'maxDD', 'Sharpe~', '%pos', 'gate(t>2)'];
  console.log(hdr.map((h, i) => h.padEnd([15, 7, 10, 11, 14, 9, 9, 7, 9][i])).join(''));
  for (const v of VARIANTS) {
    const abs = ABS[v], exc = EXC[v];
    const { cagr, mdd } = equityStats(abs);
    const g = portfolioGuillotine(exc, { abs, minT: 2 });
    const sharpe = sd(exc) > 0 ? mean(exc) / sd(exc) : NaN;   // per-period mean/std of excess
    const posPct = exc.length ? POS[v] / exc.length * 100 : 0;
    const avgN = Math.round(mean(NHELD[v]));
    rowsOut.push({ v, label: labelOf[v], avgN, cagr, exPd: mean(exc), t: g.t, mdd, sharpe, posPct, pass: g.pass });
    console.log(
      labelOf[v].padEnd(15) + String(avgN).padEnd(7) +
      pct(cagr).padEnd(10) + pct(mean(exc)).padEnd(11) +
      (isNaN(g.t) ? 'NaN' : g.t.toFixed(2)).padEnd(14) +
      pct(mdd).padEnd(9) + (isNaN(sharpe) ? '—' : sharpe.toFixed(3)).padEnd(9) +
      (posPct.toFixed(0) + '%').padEnd(7) + (g.pass ? 'PASS' : 'FAIL')
    );
  }

  // ── KEEP-CRITERION verdicts vs baseline ───────────────────────────────────
  const base = rowsOut.find(r => r.v === 'baseline');
  console.log(`\n── PRE-REGISTERED KEEP-CRITERION (vs quintile baseline) ──`);
  console.log(`KEEP iff: excess/pd ≥ 80% of baseline  AND  maxDD cut by ≥ 3pp  AND  t > 2.  Else REJECT.`);
  const verdicts = {};
  for (const r of rowsOut.filter(x => x.v !== 'baseline')) {
    const exRatio = base.exPd !== 0 ? r.exPd / base.exPd : NaN;
    const ddCutPP = (Math.abs(base.mdd) - Math.abs(r.mdd)) * 100;   // positive = drawdown reduced, in pp
    const cond1 = exRatio >= 0.80;
    const cond2 = ddCutPP >= 3;
    const cond3 = r.t > 2;
    const keep = cond1 && cond2 && cond3;
    verdicts[r.v] = { keep, exRatio, ddCutPP };
    console.log(
      `${r.label.padEnd(15)} retains ${(exRatio * 100).toFixed(0)}% of excess (${cond1 ? '✓' : '✗'} ≥80%)` +
      ` | maxDD cut ${ddCutPP >= 0 ? '+' : ''}${ddCutPP.toFixed(1)}pp (${cond2 ? '✓' : '✗'} ≥3pp)` +
      ` | t ${isNaN(r.t) ? 'NaN' : r.t.toFixed(2)} (${cond3 ? '✓' : '✗'} >2)` +
      `  →  ${keep ? 'KEEP' : 'REJECT'}`
    );
  }

  // ── machine-readable for the report ───────────────────────────────────────
  console.log(`\nJSON ${JSON.stringify({
    periods: nPeriods, universe: usable.length, volWin: VOL_WIN, costRT: COST_RT,
    table: rowsOut.map(r => ({ variant: r.label, avgN: r.avgN, absCagr: +(r.cagr * 100).toFixed(1), excessPerPd: +(r.exPd * 100).toFixed(3), t: +r.t.toFixed(2), maxDD: +(r.mdd * 100).toFixed(1), sharpe: +r.sharpe.toFixed(3), pctPos: +r.posPct.toFixed(0), gatePass: r.pass })),
    verdicts: Object.fromEntries(Object.entries(verdicts).map(([k, x]) => [k, { keep: x.keep, excessRetainedPct: +(x.exRatio * 100).toFixed(0), maxDDcutPP: +x.ddCutPP.toFixed(1) }])),
  })}`);
  process.exit(0);
}
main();
