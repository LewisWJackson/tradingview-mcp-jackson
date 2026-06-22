/**
 * block_deal_test.mjs — does a TASI block deal predict forward excess return?
 * Block deals have no buy/sell direction, so test the unsigned hypothesis:
 * after a block-deal day, does the name beat ^TASI.SR over the next N sessions,
 * net of cost, vs a random-TASI baseline? Also split by deal size.
 *
 * Run: node scripts/block_deal_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const HORIZON = 5;
const COST_RT = 0.0031 + 0.0030;
const RAND_PER_EVENT = 5;

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
  return { ret: arr[j].close / arr[i].close - 1, days: j - i };
}

async function main() {
  // dedupe to unique (sym, date) events, keep the largest deal value that day
  const raw = db.prepare('SELECT sym, date, deals FROM block_deal_log').all();
  const ev = new Map(); // key sym|date -> {sym,date,value}
  for (const r of raw) {
    let val = 0; try { val = JSON.parse(r.deals)?.value || 0; } catch {}
    const k = r.sym + '|' + r.date;
    if (!ev.has(k) || val > ev.get(k).value) ev.set(k, { sym: r.sym, date: r.date, value: val });
  }
  const events = [...ev.values()];
  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;

  const idx = await bars('^TASI.SR');
  const universe = TASI_STOCKS.map(s => s.sym);

  const exAll = [], exBig = [], exSmall = [], randEx = [];
  let skipped = 0;

  for (const e of events) {
    const sb = await bars(toYahooSym(e.sym));
    const f = fwd(sb, e.date), fi = fwd(idx, e.date);
    if (!f || !fi) { skipped++; continue; }
    const ex = f.ret - fi.ret;
    exAll.push(ex);
    (e.value >= medVal ? exBig : exSmall).push(ex);
    for (let k = 0; k < RAND_PER_EVENT; k++) {
      const rb = await bars(toYahooSym(universe[Math.floor(Math.random() * universe.length)]));
      const rf = fwd(rb, e.date);
      if (rf) randEx.push(rf.ret - fi.ret);
    }
  }

  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
  const med  = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const sd   = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
  const tstat = (a) => +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2);
  const pct  = (x) => (x * 100).toFixed(2) + '%';
  const win  = (a) => (a.filter(x => x > 0).length / a.length * 100).toFixed(1) + '%';

  console.log(`\n=== TASI block-deal forward test (horizon ${HORIZON} sessions, cost ${pct(COST_RT)} RT) ===`);
  console.log(`unique events: ${events.length} | used: ${exAll.length} | skipped: ${skipped} | median deal value: ${(medVal/1e6).toFixed(1)}M SAR\n`);
  console.log('EXCESS RETURN vs ^TASI.SR (gross):');
  console.log(`  ALL block deals : n=${exAll.length}  mean ${pct(mean(exAll))}  median ${pct(med(exAll))}  beat ${win(exAll)}  t=${tstat(exAll)}`);
  console.log(`  BIG (>=median)  : n=${exBig.length}  mean ${pct(mean(exBig))}  median ${pct(med(exBig))}  beat ${win(exBig)}  t=${tstat(exBig)}`);
  console.log(`  SMALL (<median) : n=${exSmall.length}  mean ${pct(mean(exSmall))}  median ${pct(med(exSmall))}  beat ${win(exSmall)}  t=${tstat(exSmall)}`);
  console.log(`  RANDOM baseline : n=${randEx.length}  mean ${pct(mean(randEx))}  median ${pct(med(randEx))}  beat ${win(randEx)}`);
  console.log(`\nNET edge (ALL − cost − random): ${pct(mean(exAll) - COST_RT - mean(randEx))}`);
  console.log('Note: no buy/sell direction in data; this is an unsigned "institutional footprint" test.');
  process.exit(0);
}
main();
