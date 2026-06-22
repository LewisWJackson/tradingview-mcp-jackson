/**
 * breadth_test.mjs — quantify the #1 money leak: holding too FEW names.
 *
 * The validated edge (dashboard/strategy_validation.mjs + momentum_screen.mjs) is an
 * 11–34-name EQUAL-WEIGHT top-quintile of the liquid-half ∩ ≥2y-listed TASI universe,
 * ranked by the live combo (mom6 percentile-rank + 52-week-high-proximity percentile-rank),
 * rebalanced every ~20 sessions. The user actually trades ~4 concurrent names.
 *
 * This backtest replays the EXACT same universe/combo/rebalance (leak-free, point-in-time:
 * only bars up to the rebalance index), then measures realized EXCESS vs the equal-weight
 * basket and the guillotine per-period t-stat at different holding counts:
 *   full top-quintile (baseline) · top 10 · top 8 · top 6 · top 4 (highest-combo each rebalance).
 * For each: ABS CAGR, excess/period, guillotine t, maxDD, % positive periods.
 *
 * PLUS a concentration-variance (luck-of-the-draw) measure for the 4-name case: instead of
 * always taking the top-4, BOOTSTRAP — randomly draw 4 names from the top-quintile each
 * rebalance, repeat ~500 times, report the DISTRIBUTION of annualized total excess.
 *
 * Mirrors strategy_validation.mjs line-for-line on universe/combo/cost so the quintile
 * baseline here == the live grade. Derayah 0.11% RT. COVID carved out. Run:
 *   node --experimental-sqlite scripts/breadth_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { portfolioGuillotine } from '../dashboard/guillotine.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
// CAGR + maxDD from a per-period (20-session) ABS return series, compounded.
function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  return { cagr, mdd, totalReturn: eq - 1 };
}
const cumExcess = a => a.reduce((v, r) => v * (1 + r), 1) - 1;   // compounded total excess proxy
// deterministic PRNG (mulberry32) so the bootstrap is reproducible
function rng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

async function main() {
  console.error(`loading TASI universe from cache ...`);
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  // Build the same data structure as strategy_validation.mjs.
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

  // Holding-count buckets. 'quintile' = the full top-20% (baseline). The rest are the top-K
  // by combo rank each rebalance.
  const BUCKETS = ['quintile', 10, 8, 6, 4];
  // per-bucket per-period series
  const ABS = Object.fromEntries(BUCKETS.map(b => [b, []]));
  const EXC = Object.fromEntries(BUCKETS.map(b => [b, []]));
  const POS = Object.fromEntries(BUCKETS.map(b => [b, 0]));
  // for the 4-name bootstrap: store the ranked top-quintile pick list + per-name fwd at each period
  const periodsForBoot = [];   // { rankedSyms:[...], fwdBySym:{sym:ret}, bench }
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
    const rankedSyms = ranked.slice(0, kQuint).map(r => r.s);                // top-quintile, highest-combo first

    // forward returns for every quintile name (used by all buckets + bootstrap)
    const fwdBySym = {};
    for (const s of rankedSyms) { const r = fwd(s, date); if (r != null) fwdBySym[s] = r; }
    const liveSyms = rankedSyms.filter(s => s in fwdBySym);
    if (!liveSyms.length) continue;

    for (const bk of BUCKETS) {
      const take = bk === 'quintile' ? liveSyms : liveSyms.slice(0, bk);      // top-K by combo rank
      if (!take.length) continue;
      const port = mean(take.map(s => fwdBySym[s])) - COST_RT;
      ABS[bk].push(port);
      EXC[bk].push(port - bench);
      if (port - bench > 0) POS[bk]++;
    }
    periodsForBoot.push({ liveSyms, fwdBySym, bench });
    nPeriods++;
  }

  // ── TABLE ────────────────────────────────────────────────────────────────
  console.log(`\n=== EDGE DEGRADATION BY HOLDING COUNT — Sharia TASI momentum combo ===`);
  console.log(`periods: ${nPeriods} non-overlapping 20-session rebalances | universe: ${usable.length} names`);
  console.log(`combo: mom6-rank + 52wk-high-rank avg, liquid-half ∩ ≥2y, equal-weight | cost ${pct(COST_RT)} RT (Derayah) | COVID carved out`);
  console.log(`benchmark: equal-weight basket (all usable names) | excess = portfolio − basket, one obs / period\n`);

  const rowsOut = [];
  const hdr = ['holdings', 'avgN', 'ABS CAGR', 'excess/pd', 'guillotine t', 'maxDD', '%pos', 'gate(t>2)'];
  console.log(hdr.map((h, i) => h.padEnd([10, 7, 10, 11, 14, 9, 7, 9][i])).join(''));
  for (const bk of BUCKETS) {
    const abs = ABS[bk], exc = EXC[bk];
    const { cagr, mdd } = equityStats(abs);
    const g = portfolioGuillotine(exc, { abs, minT: 2 });
    const posPct = exc.length ? POS[bk] / exc.length * 100 : 0;
    // avg names actually held (quintile varies; fixed buckets are min(K, available))
    const avgN = bk === 'quintile'
      ? Math.round(mean(periodsForBoot.map(p => p.liveSyms.length)))
      : Math.round(mean(periodsForBoot.map(p => Math.min(bk, p.liveSyms.length))));
    const label = bk === 'quintile' ? 'quintile' : `top ${bk}`;
    rowsOut.push({ bk, label, avgN, cagr, exPd: mean(exc), t: g.t, mdd, posPct, pass: g.pass });
    console.log(
      label.padEnd(10) + String(avgN).padEnd(7) +
      pct(cagr).padEnd(10) + pct(mean(exc)).padEnd(11) +
      (isNaN(g.t) ? 'NaN' : g.t.toFixed(2)).padEnd(14) +
      pct(mdd).padEnd(9) + (posPct.toFixed(0) + '%').padEnd(7) +
      (g.pass ? 'PASS' : 'FAIL')
    );
  }

  // ── 4-NAME BOOTSTRAP (concentration variance) ─────────────────────────────
  const NBOOT = 500, rand = rng(20260622);
  const annExcesses = [];     // annualized total excess per bootstrap draw
  const negCount = { v: 0 };
  for (let b = 0; b < NBOOT; b++) {
    const absSeries = [];
    for (const p of periodsForBoot) {
      const names = p.liveSyms;
      // draw 4 distinct names uniformly (or all, if quintile has <4 live names this period)
      const k = Math.min(4, names.length);
      const pick = [];
      const usedIdx = new Set();
      while (pick.length < k) { const idx = Math.floor(rand() * names.length); if (!usedIdx.has(idx)) { usedIdx.add(idx); pick.push(names[idx]); } }
      const port = mean(pick.map(s => p.fwdBySym[s])) - COST_RT;
      absSeries.push(port - p.bench);   // per-period excess
    }
    // annualize total compounded excess
    const totalEx = cumExcess(absSeries);
    const yrs = absSeries.length * H / 252;
    const annEx = yrs > 0 ? Math.pow(1 + totalEx, 1 / yrs) - 1 : NaN;
    annExcesses.push(annEx);
    if (totalEx < 0) negCount.v++;
  }
  annExcesses.sort((a, b) => a - b);
  const p10 = annExcesses[Math.floor(0.10 * NBOOT)];
  const p50 = annExcesses[Math.floor(0.50 * NBOOT)];
  const p90 = annExcesses[Math.floor(0.90 * NBOOT)];
  const bmean = mean(annExcesses), bstd = sd(annExcesses);

  console.log(`\n── 4-NAME BOOTSTRAP — random 4 of the top-quintile each rebalance, ${NBOOT} draws ──`);
  console.log(`distribution of ANNUALIZED total excess vs basket:`);
  console.log(`  mean   ${pct(bmean)}`);
  console.log(`  std    ${pct(bstd)}`);
  console.log(`  10th   ${pct(p10)}`);
  console.log(`  50th   ${pct(p50)}`);
  console.log(`  90th   ${pct(p90)}`);
  console.log(`  draws with NEGATIVE total excess: ${(negCount.v / NBOOT * 100).toFixed(1)}%`);

  // ── machine-readable for the report ───────────────────────────────────────
  console.log(`\nJSON ${JSON.stringify({
    periods: nPeriods,
    table: rowsOut.map(r => ({ holdings: r.label, avgN: r.avgN, absCagr: +(r.cagr * 100).toFixed(1), excessPerPd: +(r.exPd * 100).toFixed(3), t: +r.t.toFixed(2), maxDD: +(r.mdd * 100).toFixed(1), pctPos: +r.posPct.toFixed(0), gatePass: r.pass })),
    bootstrap4: { mean: +(bmean * 100).toFixed(2), std: +(bstd * 100).toFixed(2), p10: +(p10 * 100).toFixed(2), p50: +(p50 * 100).toFixed(2), p90: +(p90 * 100).toFixed(2), pctNegative: +(negCount.v / NBOOT * 100).toFixed(1) },
  })}`);
  process.exit(0);
}
main();
