/**
 * defensive_overlay_test.mjs — AVENUE 1: does AVOIDING names with an active negative
 * catalyst improve a long-only portfolio's ABSOLUTE return AND cut drawdown vs the
 * equal-weight TASI basket? Implementable without shorting (you just don't hold them).
 *
 * Cheapest falsifiable test: a daily-rebalanced equal-weight portfolio.
 *   FULL      = hold every usable name, earn next-day return (this IS the basket benchmark)
 *   DEFENSIVE = hold every usable name EXCEPT those under an active risk flag at close[t]
 * Risk flags (validated, t<-2.5 short-term weakness): capital_ops 10d, earnings 7d,
 * management 5d. Flag computed ONLY from events with event_date <= t (no lookahead).
 *
 * Reports: cumulative + annualized return both, EXCESS (defensive-full), max drawdown
 * both, t-stat on the daily excess series (non-overlapping next-day rets ≈ independent),
 * turnover/cost of the overlay, and a first-half/second-half out-of-sample split.
 *
 * Survivorship: Yahoo = currently-listed names only — drawdowns/returns are optimistic
 * (dead names excluded). This biases the BENCHMARK up too, so the FULL-vs-DEFENSIVE
 * spread is the cleaner read than either level.
 *
 * Run: node --experimental-sqlite scripts/defensive_overlay_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const RISK = { capital_ops: 10, earnings: 7, management: 5 };  // type -> active window (days)
const COST_SIDE = (+process.env.COST_RT || 0.0011) / 2;  // Derayah 0.11% RT
const TODAY = new Date().toISOString().slice(0, 10);
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
// Newey-West serial-correlation-robust t (HAC). Daily excess autocorrelates because a
// name stays flagged for its whole window — plain t is inflated. lag ~ max window.
function nwT(a, lag = 10) {
  const N = a.length; if (N < lag + 2) return NaN;
  const m = mean(a); const e = a.map(x => x - m);
  let g0 = e.reduce((s, x) => s + x * x, 0) / N, v = g0;
  for (let k = 1; k <= lag; k++) {
    let gk = 0; for (let i = k; i < N; i++) gk += e[i] * e[i - k];
    gk /= N; v += 2 * (1 - k / (lag + 1)) * gk;             // Bartlett kernel
  }
  const seHAC = Math.sqrt(v / N);
  return +(m / seHAC).toFixed(2);
}
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';

function maxDD(equity) {                 // equity = array of portfolio values, returns worst peak-to-trough
  let peak = -Infinity, dd = 0;
  for (const v of equity) { if (v > peak) peak = v; const d = v / peak - 1; if (d < dd) dd = d; }
  return dd;
}
const cum = rets => rets.reduce((acc, r) => acc * (1 + r), 1) - 1;
function equityCurve(rets) { let v = 1; const e = [1]; for (const r of rets) { v *= (1 + r); e.push(v); } return e; }
const annualize = (cumRet, ndays) => Math.pow(1 + cumRet, 252 / ndays) - 1;

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym);
  console.error(`fetching ${syms.length} symbols ...`);
  const data = {};  // sym -> { closes:[], dateIdx:{date->i}, dates:[] }
  for (const sym of syms) {
    try {
      const b = await fetchYahooOHLCV(toYahooSym(sym), '1d', 520);
      if (b.length < 60) continue;
      const dates = b.map(x => iso(x.time));
      data[sym] = { dates, closes: b.map(x => x.close), dateIdx: Object.fromEntries(dates.map((d, i) => [d, i])) };
    } catch {}
  }
  const usable = Object.keys(data);
  console.error(`usable symbols: ${usable.length}`);

  // master trading-day calendar = union of all symbols' dates, sorted
  const allDates = [...new Set(usable.flatMap(s => data[s].dates))].sort();

  // Load risk events (validated types only), valid + non-future dates. Build per-sym sorted list.
  const validDate = d => /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(d) && d <= TODAY;
  const riskEvents = {};  // sym -> [{date, win}]
  let evCount = 0;
  for (const type of Object.keys(RISK)) {
    const rows = db.prepare('SELECT sym, event_date FROM catalyst_events WHERE type=?').all(type);
    for (const r of rows) {
      if (!validDate(r.event_date)) continue;
      (riskEvents[r.sym] ||= []).push({ date: r.event_date, win: RISK[type] });
      evCount++;
    }
  }
  console.error(`risk events loaded: ${evCount} across ${Object.keys(riskEvents).length} symbols`);

  // is sym flagged at close[date]?  exists event with date-win <= event_date <= date
  const dayMs = 86400000;
  function flagged(sym, date) {
    const evs = riskEvents[sym]; if (!evs) return false;
    const dT = new Date(date).getTime();
    for (const e of evs) {
      const eT = new Date(e.date).getTime();
      if (eT <= dT && dT - eT < e.win * dayMs) return true;
    }
    return false;
  }

  // test window: need next-day return, and confine to where risk events actually exist
  const evDates = [].concat(...Object.values(riskEvents).map(a => a.map(e => e.date)));
  const firstEv = evDates.length ? evDates.sort()[0] : allDates[0];
  const start = allDates.findIndex(d => d >= firstEv);
  const end = allDates.length - 2;  // need t+1
  const testDates = allDates.slice(Math.max(start, 0), end + 1);

  const fullR = [], defR = [], excessR = [], flaggedCount = [];
  let prevFlagSet = new Set(), nameTrades = 0, defNamesAvg = [];

  for (const date of testDates) {
    const held = [], heldDef = [];
    const curFlag = new Set();
    for (const sym of usable) {
      const d = data[sym]; const i = d.dateIdx[date];
      if (i == null || i + 1 >= d.closes.length) continue;       // need next-day close
      const r = d.closes[i + 1] / d.closes[i] - 1;
      held.push(r);
      if (flagged(sym, date)) { curFlag.add(sym); } else { heldDef.push(r); }
    }
    if (!held.length || !heldDef.length) continue;
    const f = mean(held), g = mean(heldDef);
    fullR.push(f); defR.push(g); excessR.push(g - f);
    flaggedCount.push(curFlag.size); defNamesAvg.push(heldDef.length);
    // turnover: names entering/leaving the EXCLUDED set since yesterday (each = one trade leg)
    for (const s of curFlag) if (!prevFlagSet.has(s)) nameTrades++;   // newly excluded -> sell
    for (const s of prevFlagSet) if (!curFlag.has(s)) nameTrades++;   // re-included -> buy
    prevFlagSet = curFlag;
  }

  const n = fullR.length;
  const fullCum = cum(fullR), defCum = cum(defR);
  const fullDD = maxDD(equityCurve(fullR)), defDD = maxDD(equityCurve(defR));
  // cost of overlay: each name-trade moves weight ~1/Nport at COST_SIDE. Approx avg port size.
  const avgPort = mean(defNamesAvg);
  const overlayCost = nameTrades * COST_SIDE / avgPort;          // total drag over window
  const defCumNet = defCum - overlayCost;

  console.log(`\n=== AVENUE 1: DEFENSIVE OVERLAY — avoid names under an active negative catalyst ===`);
  console.log(`window: ${testDates[0]} → ${testDates[testDates.length - 1]}  | trading days: ${n} | universe: ${usable.length} names`);
  console.log(`risk flags: capital_ops(10d) earnings(7d) management(5d) | avg names excluded/day: ${mean(flaggedCount).toFixed(1)} of ${mean(defNamesAvg).toFixed(0)}+\n`);

  console.log(`               cumulative   annualized   maxDrawdown`);
  console.log(`  FULL basket  ${pct(fullCum).padStart(9)}   ${pct(annualize(fullCum, n)).padStart(9)}   ${pct(fullDD).padStart(9)}`);
  console.log(`  DEFENSIVE    ${pct(defCum).padStart(9)}   ${pct(annualize(defCum, n)).padStart(9)}   ${pct(defDD).padStart(9)}`);
  console.log(`  DEFENSIVE-net${pct(defCumNet).padStart(9)}   ${pct(annualize(defCumNet, n)).padStart(9)}   (after overlay cost)\n`);

  // per-day cost of the overlay, charged to the defensive leg, → cost-netted daily excess
  const perDayCost = (nameTrades * COST_SIDE / avgPort) / n;
  const excessNet = excessR.map(x => x - perDayCost);
  console.log(`  EXCESS (defensive − full):  cumulative ${pct(defCum - fullCum)}  | daily mean ${pct(mean(excessR))}`);
  console.log(`     plain t=${tstat(excessR)}   Newey-West(lag10) t=${nwT(excessR)}   ← HAC is the honest one`);
  console.log(`  EXCESS net of overlay cost: daily mean ${pct(mean(excessNet))}   NW t=${nwT(excessNet)}`);
  console.log(`  drawdown change: ${pct(defDD - fullDD)}  (negative = deeper, positive = shallower)`);
  console.log(`  overlay turnover: ${nameTrades} name-trades  → est cost drag ${pct(overlayCost)} over window\n`);

  // out-of-sample split
  const mid = Math.floor(n / 2);
  const h1 = excessR.slice(0, mid), h2 = excessR.slice(mid);
  console.log(`── OUT-OF-SAMPLE SPLIT (daily excess) ──`);
  console.log(`  FIRST half : cum ${pct(cum(h1)).padStart(7)}  daily mean ${pct(mean(h1)).padStart(7)}  t=${tstat(h1)}`);
  console.log(`  SECOND half: cum ${pct(cum(h2)).padStart(7)}  daily mean ${pct(mean(h2)).padStart(7)}  t=${tstat(h2)}`);
  const persists = mean(h1) > 0 && mean(h2) > 0;
  console.log(`  excess positive in BOTH halves? ${persists ? 'YES' : 'NO'}\n`);

  const real = mean(excessNet) > 0 && nwT(excessNet) > 2 && persists && defDD >= fullDD;
  console.log(`VERDICT: ${real
    ? 'DEFENSIVE OVERLAY clears the honest bar (net excess>0, HAC t>2, OOS-persistent, DD not worse) — REAL LEAD.'
    : 'overlay does NOT clear the honest bar (need: net excess>0 AND Newey-West t>2 AND OOS-persistent AND DD not worse).'}`);
  process.exit(0);
}
main();
