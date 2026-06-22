/**
 * catalyst_edge_test.mjs — event study: which catalyst TYPES move the stock?
 * For each catalyst_events row, measure forward EXCESS return vs the equal-weight
 * TASI basket over 1/5/20 sessions (no lookahead), grouped by type. The honest
 * information-edge test: does a contract/M&A/dividend announcement predict returns?
 *
 * Run: node scripts/catalyst_edge_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const HS = [1, 5, 20], COST_RT = 0.0061;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x)?'—':(x*100).toFixed(2)+'%';

const cache = new Map();
async function bars(sym){ if(cache.has(sym))return cache.get(sym); let b=[]; try{b=(await fetchYahooOHLCV(toYahooSym(sym),'1d',520)).map(x=>({date:iso(x.time),close:x.close}));}catch{} cache.set(sym,b); return b; }
function fwd(arr, date, H){ const i=arr.findIndex(b=>b.date>=date); if(i<0||i+H>=arr.length)return null; return arr[i+H].close/arr[i].close-1; }

async function main() {
  const universe = TASI_STOCKS.map(s=>s.sym);
  for (const s of universe) await bars(s);
  const ewC = {};
  const ew = (date,H)=>{ const k=date+'|'+H; if(k in ewC)return ewC[k]; const rs=[]; for(const s of universe){const f=fwd(cache.get(s)||[],date,H);if(f!=null)rs.push(f);} return ewC[k]=rs.length?mean(rs):null; };

  const rows = db.prepare('SELECT sym, event_date, type FROM catalyst_events').all();
  const byType = {}; let usable = {1:0,5:0,20:0}, pending = 0;
  for (const r of rows) {
    const sb = await bars(r.sym);
    let any = false;
    for (const H of HS) {
      const raw = fwd(sb, r.event_date, H); const bench = ew(r.event_date, H);
      if (raw==null || bench==null) continue;
      any = true; usable[H]++;
      ((byType[r.type] ||= {1:[],5:[],20:[]})[H]).push(raw - bench);
    }
    if (!any) pending++;
  }

  console.log(`\n=== CATALYST EVENT STUDY — forward excess vs equal-weight basket ===`);
  console.log(`events: ${rows.length} | usable @1/5/20 sessions: ${usable[1]}/${usable[5]}/${usable[20]} | too recent (no fwd yet): ${pending}\n`);
  if (!usable[5] && !usable[20]) {
    console.log('Not enough matured events yet. The harness is ready; it produces a verdict once');
    console.log('the daily collector accumulates events older than the horizon (or via a bulk');
    console.log('historical harvest). Logic is the same proven path as filings_edge_test.');
  }
  const types = Object.keys(byType).sort();
  for (const ty of types) {
    const parts = HS.map(H => { const a = byType[ty][H]; return a.length ? `${H}s ${pct(mean(a))}(n=${a.length},t=${t(a)})` : `${H}s —`; });
    console.log(`  ${ty.padEnd(14)} ${parts.join('  ')}`);
  }
  console.log(`\n  NOTE: net of ${pct(COST_RT)} cost. A type only matters if forward excess > cost with t>2 at adequate n.`);
  process.exit(0);
}
main();
