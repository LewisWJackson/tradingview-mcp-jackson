/**
 * filings_edge_test.mjs — does an ownership-change disclosure predict forward return?
 * The whole reason to collect insider/CMA data: when an institution INCREASES its
 * stake, does the name beat the equal-weight TASI basket over the next 20 sessions?
 * Compare increase vs decrease, absolute + excess, no lookahead.
 *
 * Run: node scripts/filings_edge_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const H = 20, COST_RT = 0.0061;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x)?'—':(x*100).toFixed(2)+'%';
const win = a => a.length ? (a.filter(x=>x>0).length/a.length*100).toFixed(0)+'%' : '–';

const cache = new Map();
async function bars(sym) { if (cache.has(sym)) return cache.get(sym); let b=[]; try { b=(await fetchYahooOHLCV(toYahooSym(sym),'1d',520)).map(x=>({date:iso(x.time),close:x.close})); } catch {} cache.set(sym,b); return b; }
function fwd(arr, date) { const i = arr.findIndex(b => b.date >= date); if (i<0||i+H>=arr.length) return null; return arr[i+H].close/arr[i].close-1; }

async function main() {
  const universe = TASI_STOCKS.map(s=>s.sym);
  for (const s of universe) await bars(s);
  const ewCache = {};
  const ew = (date) => { if (date in ewCache) return ewCache[date]; const rs=[]; for (const s of universe){const f=fwd(cache.get(s)||[],date);if(f!=null)rs.push(f);} return ewCache[date]=rs.length?mean(rs):null; };

  const rows = db.prepare("SELECT sym, filing_date, direction FROM cma_filings WHERE direction IN ('increase','decrease')").all();
  const B = { increase:[], decrease:[] };
  let used = 0, noData = 0;
  for (const r of rows) {
    const sb = await bars(r.sym);
    const raw = fwd(sb, r.filing_date); const bench = ew(r.filing_date);
    if (raw == null || bench == null) { noData++; continue; }
    used++;
    B[r.direction].push({ raw, ex: raw - bench });
  }

  const row = (name,a)=>{ const raws=a.map(r=>r.raw), exs=a.map(r=>r.ex);
    console.log(`  ${name.padEnd(20)} n=${String(a.length).padStart(4)}  ABS ${pct(mean(raws)).padStart(7)} (profit ${win(raws)})   excess ${pct(mean(exs)).padStart(7)}  net ${pct(mean(exs)-COST_RT).padStart(7)}  t=${t(exs)}`); };
  console.log(`\n=== FILINGS EDGE TEST — ownership disclosures, ${H}-session forward (no lookahead) ===`);
  console.log(`  filings used: ${used} | skipped (outside Yahoo window / no fwd): ${noData}\n`);
  row('Stake INCREASE', B.increase);
  row('Stake DECREASE', B.decrease);
  const spread = mean(B.increase.map(r=>r.ex)) - mean(B.decrease.map(r=>r.ex));
  console.log(`\n  INCREASE − DECREASE excess spread: ${pct(spread)}`);
  console.log(`  ${spread > 0.005 ? 'Signal direction is right (accumulation > distribution). Worth collecting more + proper validation.' : 'No usable spread yet — too few events, or no edge. Need more data before trusting.'}`);
  console.log(`\n  NOTE: n is small and resolution was 45% (selection bias), dates span survivorship-prone history. Directional probe only, NOT a verdict.`);
  process.exit(0);
}
main();
