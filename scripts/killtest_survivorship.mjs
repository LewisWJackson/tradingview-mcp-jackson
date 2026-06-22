/**
 * killtest_survivorship.mjs — the make-or-break audit of the ONE validated edge
 * (Sharia-TASI momentum combo) under two attacks:
 *
 *   ATTACK A — survivorship: Yahoo serves listed-only names. Reproduce the leak-free
 *     in-sample guillotine on the LIVE combo (mirrors strategy_validation.mjs), confirm the
 *     baseline t, then (a) try to PRICE the hand-assembled known-removed tickers via the same
 *     bars_cache/Yahoo path the backtest uses — merged tickers should 404; (b) report which
 *     can be priced so we know whether a daily splice is feasible or we must bound analytically.
 *
 *   ATTACK B — multiple testing: handled in the markdown (spec count + Harvey-Liu deflation);
 *     this script only emits the numbers (t, periods) the deflation needs.
 *
 * Run: node --experimental-sqlite scripts/killtest_survivorship.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from './tasi_screener.mjs';
import { mean, sd, tstat, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;

// Hand-assembled TASI main-market removals 2016-2026 (documented record + memory notes).
// mode FAILURE = value-destroying (the ONLY survivorship-inflating kind);
// mode MERGER  = value-preserving exit at deal price (≈ neutral terminal return).
const REMOVALS = [
  { sym: '1090', name: 'Samba Financial Group', date: '2021-04', mode: 'MERGER', note: 'absorbed into SNB (1180) at deal ratio' },
  { sym: '1040', name: 'Alawwal Bank',          date: '2019-06', mode: 'MERGER', note: 'merged into SABB (1060)' },
  { sym: '8060', name: 'SABB Takaful',          date: '2022',    mode: 'MERGER', note: 'merged into Walaa (8060/8011 family)' },
  { sym: '8300', name: 'Wafa Insurance',        date: '2021',    mode: 'FAILURE',note: 'accumulated losses / liquidation-track delist' },
  // Lower-confidence main-market names flagged in delisting-scrape notes (status/date unconfirmed):
  { sym: '1201', name: 'Takween',               date: '~2023',   mode: 'FAILURE?',note: 'distress flag, unconfirmed; likely illiquid' },
  { sym: '1834', name: 'SIECO / Saudi Eng.',    date: '~2023',   mode: 'FAILURE?',note: 'flagged, unconfirmed' },
  { sym: '1212', name: 'Astra/HADAF (1212)',    date: '~2023',   mode: 'FAILURE?',note: 'flagged, unconfirmed' },
];

// ---- ATTACK A: reproduce the leak-free in-sample guillotine on the LIVE combo ----
async function inSampleCombo() {
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const periods = [];
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
    const picks = [...pool].sort((a, b) => b.combo - a.combo).slice(0, Math.max(5, Math.floor(pool.length * 0.2))).map(r => r.s);
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null); if (!rs.length) continue;
    const port = mean(rs) - COST_RT;
    periods.push({ date, excess: port - bench, abs: port });
  }
  const ex = periods.map(p => p.excess);
  const v = portfolioGuillotine(ex, { abs: periods.map(p => p.abs) });
  return { periods, ex, v };
}

// ---- ATTACK A step 2: can we PRICE the removed names? ----
async function priceRemovals() {
  const out = [];
  for (const r of REMOVALS) {
    let bars = [];
    try { bars = await getBars(toYahooSym(r.sym), '10y'); } catch { bars = []; }
    out.push({ ...r, priced: bars && bars.length > 0, nbars: bars ? bars.length : 0,
      last: bars && bars.length ? iso(bars.at(-1).t) : null });
  }
  return out;
}

async function main() {
  console.log('=== KILL-TEST: Sharia-TASI momentum combo ===\n');

  const { ex, v } = await inSampleCombo();
  console.log('ATTACK A — baseline (leak-free in-sample combo guillotine):');
  console.log(`  periods=${v.periods}  excess/pd=${(v.excessPerPeriod * 100).toFixed(3)}%  abs/pd=${(v.absPerPeriod * 100).toFixed(3)}%`);
  console.log(`  in-sample t = ${v.t.toFixed(3)}   ${v.pass ? 'PASS' : 'FAIL'}`);

  console.log('\nATTACK A step2 — can we price the hand-assembled removals?');
  const pr = await priceRemovals();
  for (const r of pr) {
    console.log(`  ${r.sym} ${r.name.padEnd(26)} ${r.mode.padEnd(9)} ${r.date.padEnd(8)} ` +
      `${r.priced ? `PRICED (${r.nbars} bars, last ${r.last})` : '404 / no Yahoo series'}  — ${r.note}`);
  }
  const failures = pr.filter(r => r.mode.startsWith('FAILURE'));
  const failuresPriced = failures.filter(r => r.priced);
  console.log(`\n  FAILURE-mode names (the inflating kind): ${failures.length}; of which priceable: ${failuresPriced.length}`);
  console.log(`  → ${failuresPriced.length === 0 ? 'CANNOT splice any failure series into the daily backtest — must bound ANALYTICALLY.'
    : 'partial splice feasible for ' + failuresPriced.map(r => r.sym).join(',') }`);

  // numbers Attack B (markdown) needs
  console.log('\nATTACK B inputs: in-sample t =', v.t.toFixed(3), ' periods =', v.periods);
  process.exit(0);
}
main();
