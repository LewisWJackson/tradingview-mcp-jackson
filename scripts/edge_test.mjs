/**
 * edge_test.mjs — cheapest TASI edge test.
 * Q: do STRONG BUY entries beat (a) the TASI index and (b) random TASI entries,
 *    measured over the SAME forward window, net of costs?
 * Data: daily Yahoo bars (same source the screener uses). Index = ^TASI.SR.
 *
 * Run: node scripts/edge_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const HORIZON = 5;                 // forward trading sessions (capped to available bars)
const COST_RT = 0.0031 + 0.0030;  // 0.31% commission + ~0.30% spread/slippage, round-trip
const RAND_PER_SIGNAL = 5;         // random TASI picks per signal date

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// bar cache: yahooSym -> [{date, close}]
const cache = new Map();
async function bars(yahooSym) {
  if (cache.has(yahooSym)) return cache.get(yahooSym);
  let b = [];
  try { b = (await fetchYahooOHLCV(yahooSym, '1d', 260)).map(x => ({ date: iso(x.time), close: x.close })); }
  catch { b = []; }
  cache.set(yahooSym, b);
  return b;
}

// forward return from entry date over up to HORIZON sessions; returns {ret, days, end} or null
function fwd(barsArr, entryDate) {
  const i = barsArr.findIndex(b => b.date >= entryDate);
  if (i < 0) return null;
  const entry = barsArr[i];
  const j = Math.min(i + HORIZON, barsArr.length - 1);
  if (j <= i) return null;                 // no forward bar yet
  return { ret: barsArr[j].close / entry.close - 1, days: j - i, end: barsArr[j].date };
}

async function main() {
  // STRONG BUY signals that have forward data (exclude today's batch)
  const today = new Date().toISOString().slice(0, 10);
  const sigs = db.prepare(
    "SELECT sym, substr(logged_at,1,10) d FROM accuracy_signals WHERE bias='STRONG BUY' AND substr(logged_at,1,10) < ?"
  ).all(today);

  const idx = await bars('^TASI.SR');
  const idxFwd = (d) => fwd(idx, d);

  const universe = TASI_STOCKS.map(s => s.sym);

  const sigEx = [];   // signal excess vs index (gross)
  const sigNet = [];  // signal excess vs index (net of cost on signal leg)
  const randEx = [];  // random excess vs index (gross)
  let skipped = 0;

  for (const s of sigs) {
    const ys = toYahooSym(s.sym);
    const sb = await bars(ys);
    const f = fwd(sb, s.d);
    const fi = idxFwd(s.d);
    if (!f || !fi) { skipped++; continue; }
    sigEx.push(f.ret - fi.ret);
    sigNet.push((f.ret - COST_RT) - fi.ret);

    // random baseline: same date, same window logic
    for (let k = 0; k < RAND_PER_SIGNAL; k++) {
      const rsym = universe[Math.floor(Math.random() * universe.length)];
      const rb = await bars(toYahooSym(rsym));
      const rf = fwd(rb, s.d);
      if (rf && fi) randEx.push(rf.ret - fi.ret);
    }
  }

  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const med  = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const pct  = (x) => (x * 100).toFixed(2) + '%';
  const winRate = (a) => (a.filter(x => x > 0).length / a.length * 100).toFixed(1) + '%';

  console.log(`\n=== TASI STRONG BUY edge test (horizon ${HORIZON} sessions, cost ${pct(COST_RT)} round-trip) ===`);
  console.log(`signals used: ${sigEx.length} | skipped (no fwd data): ${skipped} | random samples: ${randEx.length}\n`);
  console.log('EXCESS RETURN vs ^TASI.SR (same window per signal):');
  console.log(`  STRONG BUY  gross : mean ${pct(mean(sigEx))}  median ${pct(med(sigEx))}  beat-index ${winRate(sigEx)}`);
  console.log(`  STRONG BUY  net   : mean ${pct(mean(sigNet))}  median ${pct(med(sigNet))}  beat-index ${winRate(sigNet)}`);
  console.log(`  RANDOM TASI gross : mean ${pct(mean(randEx))}  median ${pct(med(randEx))}  beat-index ${winRate(randEx)}`);
  console.log(`\nEDGE = STRONG BUY net − RANDOM gross = ${pct(mean(sigNet) - mean(randEx))}`);
  console.log(mean(sigNet) > mean(randEx) ? '→ signal beats random net of costs (over this window).' : '→ signal does NOT beat random net of costs. No demonstrated edge.');
  process.exit(0);
}
main();
