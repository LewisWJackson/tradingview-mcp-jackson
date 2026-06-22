/**
 * seasonality_test.mjs — AVENUE 2: does being invested ONLY in historically-strong
 * TASI calendar windows beat equal-weight buy-and-hold, OUT-OF-SAMPLE?
 *
 * Benchmark = equal-weight TASI basket, always invested (daily-rebalanced mean of all
 * available constituents' daily returns). Timing = hold basket only inside a window,
 * cash otherwise. Edge needs higher CAGR net cost OR materially lower drawdown, and
 * must survive walk-forward (fit windows on years<Y, test on Y).
 *
 * Cost: 0.61% round-trip every time you ENTER and EXIT a window — frequent timing
 * (e.g. turn-of-month, 12x/yr) pays ~7%/yr drag. That alone kills most calendar timing.
 *
 * Survivorship: Yahoo = currently-listed names; basket is thinner + optimistic pre-2024.
 *
 * Run: node scripts/seasonality_test.mjs
 */
import { getBars, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
function maxDD(eq) { let p = -Infinity, dd = 0; for (const v of eq) { if (v > p) p = v; const d = v / p - 1; if (d < dd) dd = d; } return dd; }
function eqCurve(rets) { let v = 1; const e = [1]; for (const r of rets) { v *= 1 + r; e.push(v); } return e; }
const cagr = (rets) => Math.pow(eqCurve(rets).at(-1), 252 / rets.length) - 1;

// Ramadan Gregorian start dates (≈, end = start+29d)
const RAMADAN = ['2016-06-06', '2017-05-27', '2018-05-16', '2019-05-06', '2020-04-24', '2021-04-13', '2022-04-02', '2023-03-23', '2024-03-11', '2025-03-01', '2026-02-18']
  .map(s => { const a = new Date(s).getTime(); return { start: a, end: a + 29 * 864e5 }; });
const inRamadan = d => { const t = new Date(d).getTime(); return RAMADAN.some(r => t >= r.start && t <= r.end); };
const preRamadan = d => { const t = new Date(d).getTime(); return RAMADAN.some(r => t >= r.start - 15 * 864e5 && t < r.start); };
const postRamadan = d => { const t = new Date(d).getTime(); return RAMADAN.some(r => t > r.end && t <= r.end + 10 * 864e5); };

async function main() {
  const syms = TASI_STOCKS.map(s => toYahooSym(s.sym));
  console.error(`warming cache for ${syms.length} symbols (10y) ...`);
  // build equal-weight basket daily-return series
  const acc = {};   // date -> {sum, n}
  let withData = 0;
  for (const ys of syms) {
    const bars = await getBars(ys, '10y');
    if (bars.length < 30) continue;
    withData++;
    for (let i = 1; i < bars.length; i++) {
      const r = bars[i].c / bars[i - 1].c - 1;
      if (!isFinite(r)) continue;
      const d = iso(bars[i].t);
      (acc[d] ||= { sum: 0, n: 0 }); acc[d].sum += r; acc[d].n++;
    }
  }
  // persist cache once
  const { warm } = await import('./bars_cache.mjs'); await warm([], '10y');  // triggers save of accumulated getBars
  console.error(`symbols with data: ${withData}`);

  const dates = Object.keys(acc).filter(d => acc[d].n >= 10).sort();
  const ret = dates.map(d => acc[d].sum / acc[d].n);
  const N = dates.length;
  console.log(`\n=== AVENUE 2: SEASONALITY — equal-weight TASI basket, ${dates[0]} → ${dates[N - 1]} (${N} days) ===`);
  console.log(`basket CAGR (buy&hold): ${pct(cagr(ret))}  maxDD ${pct(maxDD(eqCurve(ret)))}  (survivorship-optimistic)\n`);

  // ── calendar feature tags per day ──
  const month = dates.map(d => +d.slice(5, 7));
  const year = dates.map(d => +d.slice(0, 4));
  const dow = dates.map(d => new Date(d).getUTCDay());     // 0=Sun .. 6=Sat (TASI trades Sun-Thu)
  // turn-of-month: first 3 trading days of a month + last trading day of prev month
  const firstRank = new Array(N).fill(99);
  for (let i = 0, r = 0; i < N; i++) { if (i === 0 || month[i] !== month[i - 1]) r = 0; firstRank[i] = r++; }
  const isLastOfMonth = i => i < N - 1 && month[i + 1] !== month[i];
  const isTOM = i => firstRank[i] < 3 || isLastOfMonth(i);

  // ── descriptive scan: mean daily return by window (raw t, not OOS) ──
  const grp = (pred) => { const a = []; for (let i = 0; i < N; i++) if (pred(i)) a.push(ret[i]); return a; };
  console.log(`── DESCRIPTIVE: mean DAILY basket return by window (raw t — in-sample, not a verdict) ──`);
  const rows = [
    ['turn-of-month', i => isTOM(i)], ['rest-of-month', i => !isTOM(i)],
    ['in-Ramadan', i => inRamadan(dates[i])], ['pre-Ramadan(15d)', i => preRamadan(dates[i])], ['post-Ramadan(10d)', i => postRamadan(dates[i])],
    ['Sun (week open)', i => dow[i] === 0], ['Thu (week close)', i => dow[i] === 4],
  ];
  for (const [name, pred] of rows) { const a = grp(pred); console.log(`  ${name.padEnd(18)} n=${String(a.length).padStart(4)}  mean ${pct(mean(a)).padStart(7)}  t=${tstat(a)}`); }
  console.log(`  ── by month ──`);
  for (let m = 1; m <= 12; m++) { const a = grp(i => month[i] === m); console.log(`  month ${String(m).padStart(2)}          n=${String(a.length).padStart(4)}  mean ${pct(mean(a)).padStart(7)}  t=${tstat(a)}`); }

  // ── OOS WALK-FORWARD: "positive months" rule ──
  // For each test year Y, strong = months with positive mean daily ret in years<Y. In Y,
  // invest only on strong-month days, else cash. Count transitions for cost.
  const years = [...new Set(year)].sort();
  function strategyReturns(picker) {
    const out = []; let invested = false, trans = 0;
    for (let i = 0; i < N; i++) {
      const wantIn = picker(i);
      if (wantIn !== invested) { trans++; invested = wantIn; }
      out.push(wantIn ? ret[i] : 0);
    }
    return { out, trans };
  }
  function netReturns(out, trans) { const r = [...out]; const drag = trans * (COST_RT / 2); // each transition = one leg
    // apply total cost drag spread: subtract at transitions — approximate as flat haircut on cumulative
    const cum = eqCurve(r).at(-1) * (1 - trans * (COST_RT / 2)); return cum; }

  // build OOS picker: month in strong set learned from prior years
  const monthMeanUpTo = (Y) => { const mm = {}; for (let m = 1; m <= 12; m++) { const a = []; for (let i = 0; i < N; i++) if (year[i] < Y && month[i] === m) a.push(ret[i]); mm[m] = mean(a); } return mm; };
  let oosIdx = [];
  const oosStrongDays = new Array(N).fill(false);
  const testYears = years.filter(Y => Y > years[0]);   // need >=1 training year
  for (const Y of testYears) { const mm = monthMeanUpTo(Y); for (let i = 0; i < N; i++) if (year[i] === Y) { oosIdx.push(i); oosStrongDays[i] = mm[month[i]] > 0; } }
  // OOS series over test years only
  const oosBH = oosIdx.map(i => ret[i]);
  let trans = 0, prev = false; const oosTimed = oosIdx.map(i => { const w = oosStrongDays[i]; if (w !== prev) { trans++; prev = w; } return w ? ret[i] : 0; });
  const timedNetCum = eqCurve(oosTimed).at(-1) * (1 - trans * (COST_RT / 2)) - 1;
  const bhCum = eqCurve(oosBH).at(-1) - 1;
  const pctIn = oosStrongDays.filter((v, i) => oosIdx.includes(i) && v).length / oosIdx.length;

  const sharpe = a => +(mean(a) / sd(a) * Math.sqrt(252)).toFixed(2);
  const netCagr = (gross, ndays, tr) => Math.pow((1 + gross) * (1 - tr * COST_RT / 2), 252 / ndays) - 1;
  console.log(`\n── OOS WALK-FORWARD: "invest only in months positive in prior years" ──`);
  console.log(`  test years: ${testYears[0]}–${testYears.at(-1)} | OOS days: ${oosIdx.length} | time invested: ${(pctIn * 100).toFixed(0)}% | transitions: ${trans}`);
  console.log(`  buy&hold   : CAGR ${pct(cagr(oosBH))}  maxDD ${pct(maxDD(eqCurve(oosBH)))}  Sharpe ${sharpe(oosBH)}`);
  console.log(`  TIMED gross: CAGR ${pct(cagr(oosTimed))}  maxDD ${pct(maxDD(eqCurve(oosTimed)))}  Sharpe ${sharpe(oosTimed)}`);
  console.log(`  TIMED net  : CAGR ${pct(netCagr(eqCurve(oosTimed).at(-1) - 1, oosTimed.length, trans))}  (cost drag ${pct(trans * COST_RT / 2)})`);
  console.log(`  → return edge net cost ≈ ${pct(timedNetCum - bhCum)} over ${(oosIdx.length / 252).toFixed(1)}y; DD cut ${pct(maxDD(eqCurve(oosTimed)) - maxDD(eqCurve(oosBH)))} (the real prize)`);

  // low-transition robustness: avoid only the 2 weakest months learned from prior years
  let lt = false, ltTrans = 0; const ltStrong = new Array(N).fill(true);
  for (const Y of testYears) { const mm = monthMeanUpTo(Y); const worst = Object.entries(mm).sort((a, b) => a[1] - b[1]).slice(0, 2).map(e => +e[0]); for (let i = 0; i < N; i++) if (year[i] === Y) ltStrong[i] = !worst.includes(month[i]); }
  const ltTimed = oosIdx.map(i => { const w = ltStrong[i]; if (w !== lt) { ltTrans++; lt = w; } return w ? ret[i] : 0; });
  console.log(`  ─ low-transition variant (avoid 2 weakest prior-year months): transitions ${ltTrans}, time-in ${(oosIdx.filter(i => ltStrong[i]).length / oosIdx.length * 100).toFixed(0)}%`);
  console.log(`    CAGR net ${pct(netCagr(eqCurve(ltTimed).at(-1) - 1, ltTimed.length, ltTrans))}  maxDD ${pct(maxDD(eqCurve(ltTimed)))}  Sharpe ${sharpe(ltTimed)}`);

  // ── CRASH-DEPENDENCE: is the DD cut consistent or just dodging one crash? ──
  // low-transition rule (avoid 2 weakest prior-year months), evaluated over a year subset.
  function ltEval(excludeYears = []) {
    const ex = new Set(excludeYears);
    const idx = oosIdx.filter(i => !ex.has(year[i]));
    const bh = idx.map(i => ret[i]);
    let tp2 = false, tr = 0; const tm = idx.map(i => { const w = ltStrong[i]; if (w !== tp2) { tr++; tp2 = w; } return w ? ret[i] : 0; });
    return { bhCAGR: cagr(bh), bhDD: maxDD(eqCurve(bh)), tmCAGRnet: netCagr(eqCurve(tm).at(-1) - 1, tm.length, tr), tmDD: maxDD(eqCurve(tm)), tmSh: +(mean(tm) / sd(tm) * Math.sqrt(252)).toFixed(2), tr, days: idx.length };
  }
  console.log(`\n── CRASH-DEPENDENCE of low-transition rule (avoid 2 weakest prior-year months) ──`);
  console.log(`  per-year drawdown (buy&hold vs timed):`);
  for (const Y of testYears) {
    const idx = oosIdx.filter(i => year[i] === Y); if (!idx.length) continue;
    const bhDD = maxDD(eqCurve(idx.map(i => ret[i]))); const tmDD = maxDD(eqCurve(idx.map(i => ltStrong[i] ? ret[i] : 0)));
    const bhR = eqCurve(idx.map(i => ret[i])).at(-1) - 1, tmR = eqCurve(idx.map(i => ltStrong[i] ? ret[i] : 0)).at(-1) - 1;
    console.log(`    ${Y}  B&H ret ${pct(bhR).padStart(7)} DD ${pct(bhDD).padStart(7)}  |  TIMED ret ${pct(tmR).padStart(7)} DD ${pct(tmDD).padStart(7)}  ${tmDD > bhDD ? '✓DD-better' : ''}`);
  }
  for (const [label, ex] of [['all years', []], ['excl 2020 (COVID)', [2020]], ['excl 2020+2015', [2020, 2015]]]) {
    const e = ltEval(ex);
    console.log(`  ${label.padEnd(18)} B&H CAGR ${pct(e.bhCAGR).padStart(7)} DD ${pct(e.bhDD).padStart(7)}  |  TIMED net CAGR ${pct(e.tmCAGRnet).padStart(7)} DD ${pct(e.tmDD).padStart(7)} Sharpe ${e.tmSh}  → DDcut ${pct(e.tmDD - e.bhDD)}, ret edge ${pct(e.tmCAGRnet - e.bhCAGR)}`);
  }

  // ── TOM as a fixed hypothesis, full-sample + per-year sign stability ──
  console.log(`\n── TURN-OF-MONTH timing (fixed hypothesis) ──`);
  const tomDays = []; for (let i = 0; i < N; i++) if (isTOM(i)) tomDays.push(i);
  let tTrans = 0, tp = false; const tomTimed = ret.map((r, i) => { const w = isTOM(i); if (w !== tp) { tTrans++; tp = w; } return w ? r : 0; });
  const tomNetCum = eqCurve(tomTimed).at(-1) * (1 - tTrans * (COST_RT / 2)) - 1;
  console.log(`  time invested: ${(tomDays.length / N * 100).toFixed(0)}% | transitions: ${tTrans} (~${(tTrans / years.length).toFixed(0)}/yr)`);
  console.log(`  buy&hold full : CAGR ${pct(cagr(ret))}  maxDD ${pct(maxDD(eqCurve(ret)))}`);
  console.log(`  TOM(gross)    : CAGR ${pct(cagr(tomTimed))}  maxDD ${pct(maxDD(eqCurve(tomTimed)))}`);
  console.log(`  TOM(net cost) : cum ${pct(tomNetCum)}  → ${pct(tTrans * COST_RT / 2)} cost drag eats it`);
  // per-year TOM-minus-rest sign
  let yrPos = 0; for (const Y of years) { const t = [], r = []; for (let i = 0; i < N; i++) if (year[i] === Y) (isTOM(i) ? t : r).push(ret[i]); if (mean(t) > mean(r)) yrPos++; }
  console.log(`  TOM beats rest in ${yrPos}/${years.length} years (sign stability)`);

  console.log(`\nVERDICT: ${timedNetCum > bhCum ? 'OOS month-timing beats buy&hold net cost — investigate.' : 'OOS calendar timing does NOT beat buy&hold net of cost (transition cost + lower exposure). KILL unless a low-transition window shows a real, sign-stable, net-positive edge above.'}`);
  process.exit(0);
}
main();
