/**
 * compounding_geometry_walkforward.mjs — decisive test for the drawdown brake.
 *
 * The brake is a fixed-rule circuit breaker (no parameters fit to data), so the honest
 * walk-forward question is robustness, not tuning: does the brake's "+return / shallower
 * drawdown" benefit hold across MANY rolling out-of-sample windows, or did it ride one
 * lucky 50/50 split? Two views:
 *   (A) Rolling windows — 24-period (~2y) windows stepped every 4 periods (~4mo), each with
 *       a fresh brake state. Tally how often the brake beats equal-weight on CAGR and on maxDD.
 *   (B) Continuous per-year attribution — run baseline and brake over the full path once,
 *       group per-period returns by calendar year, show which years the brake won/lost
 *       (reveals the regime story: defensive tools help in bad years, drag in trending ones).
 *
 * Brake-ONLY on the equal-weight momentum book (the configuration that won in the main test).
 * ALL-STOCKS concept proof; Sharia not filtered; survivorship accepted → trust the DELTA.
 * Run: START=2020-01-01 node --experimental-sqlite scripts/compounding_geometry_walkforward.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { drawdownBrake } from '../dashboard/compounding_geometry.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = process.env.START || '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const BRAKE_THRESH = +process.env.BRAKE_THRESH || 0.15;
const W = +process.env.WF_WIN || 24, S = +process.env.WF_STEP || 4;
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(1) + '%';
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

function equityStats(rets) {
  let eq = 1, pk = 1, mdd = 0;
  for (const r of rets) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = rets.length * H / 252;
  return { cagr: yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN, mdd, eq };
}

// Equal-weight momentum book, optional drawdown brake (path-dependent: eq/peak run across
// the whole period array passed in). Returns per-period return series.
function runBrake(periods, useBrake) {
  let eq = 1, pk = 1, braked = false;
  const rets = [];
  for (const p of periods) {
    const basketRet = mean(p.picks.map(x => x.fwd)); // equal weight
    let bmult = 1;
    if (useBrake) { const r = drawdownBrake({ eq, peak: pk, braked, threshold: BRAKE_THRESH }); bmult = r.mult; braked = r.braked; }
    const ret = bmult * basketRet - COST_RT * bmult;
    rets.push(ret); eq *= 1 + ret; pk = Math.max(pk, eq);
  }
  return rets;
}
const yearReturn = arr => arr.reduce((acc, r) => acc * (1 + r), 1) - 1;

(async () => {
  console.log('Warming bars cache (all TASI stocks, 10y)…');
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

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

  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const rows = [];
    for (const s of usable) {
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      let liq = 0, nn = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); nn++; }
      rows.push({ s, mom6, liq: liq / nn });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    const pickRows = [...liquid].sort((a, b) => b.mom6 - a.mom6).slice(0, Math.max(5, Math.floor(liquid.length * 0.2)));
    const picks = pickRows.map(r => ({ s: r.s, fwd: fwd(r.s, date) })).filter(p => p.fwd != null);
    if (!picks.length) continue;
    periods.push({ date, year: +date.slice(0, 4), picks });
  }

  console.log(`\nPeriods: ${periods.length}  (${periods[0]?.date} → ${periods.at(-1)?.date}), all-stocks, COVID carved out`);
  console.log(`Brake: cut exposure 50% when down >${(BRAKE_THRESH * 100).toFixed(0)}% from peak. Window ${W} periods, step ${S}.\n`);

  // ── (A) Rolling-window walk-forward ────────────────────────────────────────
  console.log('(A) ROLLING WINDOWS — brake vs equal-weight (fresh brake state each window)');
  console.log('WINDOW'.padEnd(26), '| baseCAGR brakeCAGR  Δ', '   | baseDD  brakeDD   Δ');
  console.log('-'.repeat(78));
  const dC = [], dDD = []; let cagrWins = 0, ddWins = 0, ddNotWorse = 0;
  for (let st = 0; st + W <= periods.length; st += S) {
    const win = periods.slice(st, st + W);
    const b = equityStats(runBrake(win, false));
    const k = equityStats(runBrake(win, true));
    const dc = k.cagr - b.cagr, dd = k.mdd - b.mdd; // dd>0 = shallower = better
    dC.push(dc); dDD.push(dd);
    if (dc > 0) cagrWins++;
    if (dd > 0.001) ddWins++;
    if (dd >= -0.001) ddNotWorse++;
    const tag = `${win[0].date}→${win.at(-1).date}`;
    console.log(tag.padEnd(26), '|', `${pct(b.cagr).padStart(7)} ${pct(k.cagr).padStart(8)} ${pct(dc).padStart(6)}`, '  |', `${pct(b.mdd).padStart(6)} ${pct(k.mdd).padStart(7)} ${pct(dd).padStart(6)}`);
  }
  const N = dC.length;
  console.log('-'.repeat(78));
  console.log(`Windows: ${N}`);
  console.log(`  CAGR:  brake wins ${cagrWins}/${N} (${(cagrWins / N * 100).toFixed(0)}%), median Δ ${pct(median(dC))}`);
  console.log(`  maxDD: brake shallower ${ddWins}/${N} (${(ddWins / N * 100).toFixed(0)}%), not-worse ${ddNotWorse}/${N}, median Δ ${pct(median(dDD))}`);

  // ── (B) Continuous per-year attribution ────────────────────────────────────
  console.log('\n(B) PER-YEAR (continuous path) — equal-weight vs brake, return that year');
  const baseRets = runBrake(periods, false), brakeRets = runBrake(periods, true);
  const yrs = {};
  periods.forEach((p, i) => { (yrs[p.year] ||= { b: [], k: [] }); yrs[p.year].b.push(baseRets[i]); yrs[p.year].k.push(brakeRets[i]); });
  console.log('YEAR  | baseRet  brakeRet   Δ    | brake helped?');
  console.log('-'.repeat(58));
  for (const y of Object.keys(yrs).sort()) {
    const o = yrs[y]; const br = yearReturn(o.b), kr = yearReturn(o.k); const d = kr - br;
    const verdict = d > 0.005 ? 'YES (defended)' : d < -0.005 ? 'no (whipsaw cost)' : '~flat';
    console.log(`${y}  | ${pct(br).padStart(7)} ${pct(kr).padStart(8)} ${pct(d).padStart(6)}   | ${verdict}`);
  }
  const full = equityStats(baseRets), fullK = equityStats(brakeRets);
  console.log('-'.repeat(58));
  console.log(`FULL  | CAGR base ${pct(full.cagr)} brake ${pct(fullK.cagr)} (Δ ${pct(fullK.cagr - full.cagr)}); maxDD base ${pct(full.mdd)} brake ${pct(fullK.mdd)} (Δ ${pct(fullK.mdd - full.mdd)})`);
})();
