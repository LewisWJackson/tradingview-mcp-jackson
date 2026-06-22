/**
 * opportunity_test.mjs — do opportunity_signals beat an EQUAL-WEIGHT TASI basket?
 * Benchmark is the equal-weight average forward return of the whole TASI universe
 * over the SAME window (the fair yardstick — not the Aramco-heavy cap-weighted index).
 * Sliced by signal_type and conviction, net of cost.
 *
 * Run: node scripts/opportunity_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const HORIZON = 5;
const COST_RT = 0.0031 + 0.0030;

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const cache = new Map();
async function bars(ys) {
  if (cache.has(ys)) return cache.get(ys);
  let b = [];
  try { b = (await fetchYahooOHLCV(ys, '1d', 260)).map(x => ({ date: iso(x.time), close: x.close })); } catch {}
  cache.set(ys, b); return b;
}
function fwd(arr, d) {
  const i = arr.findIndex(b => b.date >= d);
  if (i < 0) return null;
  const j = Math.min(i + HORIZON, arr.length - 1);
  if (j <= i) return null;
  return arr[j].close / arr[i].close - 1;
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med  = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd   = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct  = (x) => (x * 100).toFixed(2) + '%';
const win  = (a) => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

async function main() {
  const universe = TASI_STOCKS.map(s => s.sym);
  // pre-fetch universe bars
  for (const s of universe) await bars(toYahooSym(s));

  // equal-weight basket forward return for a given date (cached)
  const ewCache = new Map();
  function ewBasket(date) {
    if (ewCache.has(date)) return ewCache.get(date);
    const rs = [];
    for (const s of universe) { const f = fwd(cache.get(toYahooSym(s)) || [], date); if (f != null) rs.push(f); }
    const v = rs.length ? mean(rs) : null;
    ewCache.set(date, v); return v;
  }

  const today = new Date().toISOString().slice(0, 10);
  const sigs = db.prepare(
    "SELECT sym, signal_type, conviction, substr(detected_at,1,10) d, discovery_price FROM opportunity_signals WHERE discovery_price IS NOT NULL AND substr(detected_at,1,10) < ?"
  ).all(today);

  const exAll = [], byType = {}, byConv = { 'high(>=60)': [], 'low(<60)': [] };
  let skipped = 0;

  for (const s of sigs) {
    const sb = await bars(toYahooSym(s.sym));
    const f = fwd(sb, s.d);
    const ew = ewBasket(s.d);
    if (f == null || ew == null) { skipped++; continue; }
    const ex = f - ew;                       // excess vs equal-weight basket
    exAll.push(ex);
    (byType[s.signal_type] ||= []).push(ex);
    (s.conviction >= 60 ? byConv['high(>=60)'] : byConv['low(<60)']).push(ex);
  }

  const line = (label, a) => console.log(`  ${label.padEnd(26)} n=${String(a.length).padStart(4)}  mean ${pct(mean(a)).padStart(7)}  median ${pct(med(a)).padStart(7)}  beat ${win(a).padStart(4)}  t=${tstat(a)}`);

  console.log(`\n=== opportunity_signals vs EQUAL-WEIGHT TASI basket (horizon ${HORIZON}, cost ${pct(COST_RT)} RT) ===`);
  console.log(`used: ${exAll.length} | skipped (no fwd): ${skipped}\n`);
  console.log('EXCESS vs equal-weight basket (gross). A real edge needs mean > cost AND t > ~2:');
  line('ALL', exAll);
  console.log('\n  by signal_type:');
  for (const [t, a] of Object.entries(byType).sort((x, y) => mean(y[1]) - mean(x[1]))) line(t, a);
  console.log('\n  by conviction:');
  for (const [k, a] of Object.entries(byConv)) line(k, a);
  console.log(`\nNET edge (ALL mean − cost): ${pct(mean(exAll) - COST_RT)}`);
  console.log(`Verdict: ${mean(exAll) - COST_RT > 0 && tstat(exAll) > 2 ? 'beats equal-weight net of cost, statistically.' : 'no edge vs equal-weight net of cost (or not significant).'}`);
  process.exit(0);
}
main();
