/**
 * dividend_absolute_test.mjs — is the dividend catalyst ABSOLUTE money, or just
 * relative (beats a falling basket)? Reports raw forward return AND excess vs the
 * equal-weight basket for dividend events, by horizon. The decisive check.
 *
 * Run: node scripts/dividend_absolute_test.mjs
 */
import { db } from '../dashboard/db.js';
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const HS = [1, 5, 20], COST_RT = 0.0061;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x)?'—':(x*100).toFixed(2)+'%';
const win = a => a.length ? (a.filter(x=>x>0).length/a.length*100).toFixed(0)+'%' : '–';

const cache = new Map();
async function bars(sym){ if(cache.has(sym))return cache.get(sym); let b=[]; try{b=(await fetchYahooOHLCV(toYahooSym(sym),'1d',520)).map(x=>({date:iso(x.time),close:x.close}));}catch{} cache.set(sym,b); return b; }
function fwd(arr, date, H){ const i=arr.findIndex(b=>b.date>=date); if(i<0||i+H>=arr.length)return null; return arr[i+H].close/arr[i].close-1; }

async function main() {
  const universe = TASI_STOCKS.map(s=>s.sym);
  for (const s of universe) await bars(s);
  const ewC = {};
  const ew = (date,H)=>{ const k=date+'|'+H; if(k in ewC)return ewC[k]; const rs=[]; for(const s of universe){const f=fwd(cache.get(s)||[],date,H);if(f!=null)rs.push(f);} return ewC[k]=rs.length?mean(rs):null; };

  const rows = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='dividend'").all();
  console.log(`\n=== DIVIDEND absolute vs relative (n=${rows.length} events) ===\n`);
  for (const H of HS) {
    const raw = [], exc = [], bench = [];
    for (const r of rows) {
      const f = fwd(await bars(r.sym), r.event_date, H); const b = ew(r.event_date, H);
      if (f==null || b==null) continue;
      raw.push(f); exc.push(f-b); bench.push(b);
    }
    console.log(`  H=${String(H).padStart(2)}s  n=${raw.length}  ABSOLUTE ${pct(mean(raw)).padStart(7)} (profit ${win(raw)}, t=${t(raw)})  |  basket ${pct(mean(bench)).padStart(7)}  |  excess ${pct(mean(exc)).padStart(7)}  net-abs ${pct(mean(raw)-COST_RT).padStart(7)}`);
  }
  console.log(`\n  Verdict needs ABSOLUTE > cost (${pct(COST_RT)}) AND positive — not just excess > 0.`);
  process.exit(0);
}
main();
