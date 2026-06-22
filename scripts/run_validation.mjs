/**
 * run_validation.mjs — backfill the validation spine from already-logged signals,
 * grade everything past its horizon, and print the honest edge stats.
 *
 * Safe to re-run: logging is idempotent (UNIQUE), grading skips already-graded rows.
 * Run: node scripts/run_validation.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { backfillFromTables, gradePending, getValidationStats, HORIZONS } from '../dashboard/validation.mjs';

const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const barsCache = new Map();
async function getBars(sym) {
  if (barsCache.has(sym)) return barsCache.get(sym);
  let b = [];
  try { b = (await fetchYahooOHLCV(toYahooSym(sym), '1d', 520)).map(x => ({ date: iso(x.time), close: x.close })); } catch {}
  barsCache.set(sym, b); return b;
}
const universe = TASI_STOCKS.map(s => s.sym);
const pct = (x) => (x * 100).toFixed(2) + '%';

async function main() {
  const inserted = backfillFromTables();
  console.log(`backfilled ${inserted} pending outcome rows (idempotent).`);
  console.log('grading (fetching bars)...');
  const res = await gradePending({ getBars, universe });
  console.log(`graded ${res.graded} | still pending (horizon not elapsed): ${res.stillPending}\n`);

  for (const H of HORIZONS) {
    const s = getValidationStats({ horizon: H });
    if (!s.all) { console.log(`horizon ${H}: ${s.note}`); continue; }
    const star = H === s.headline_horizon ? ' ★ headline' : '';
    console.log(`── horizon ${H}${star} ──  graded=${s.all.n} pending=${s.pending}`);
    console.log(`   ALL          : excess ${pct(s.all.excess_mean)}  net ${pct(s.all.net_mean)}  beat ${(s.all.beat_rate*100).toFixed(0)}%  t_raw ${s.all.t_raw}`);
    console.log(`   OVERLAP-CORR : n=${s.overlap_corrected.n}  excess ${pct(s.overlap_corrected.excess_mean)}  net ${pct(s.overlap_corrected.net_mean)}  t ${s.overlap_corrected.t_raw}  ← honest`);
    console.log(`   by regime    : ` + Object.entries(s.by_regime).map(([k,v])=>`${k}=${pct(v.excess_mean)}(${v.n})`).join('  '));
    const top = Object.entries(s.by_type).sort((a,b)=>b[1].excess_mean-a[1].excess_mean).slice(0,6);
    console.log('   by type      : ' + top.map(([k,v])=>`${k}=${pct(v.excess_mean)}(${v.n})`).join('  '));
    console.log('');
  }
  process.exit(0);
}
main();
