/**
 * contrarian_test.mjs — does TASI reward buying WEAKNESS instead of strength?
 * Momentum (STRONG BUY) buys tops and loses on absolute return. Test the inverse:
 * buy oversold / pulled-back names and measure ABSOLUTE return + excess vs the
 * equal-weight basket at 20 sessions, no lookahead. Several contrarian definitions.
 *
 * Run: node scripts/contrarian_test.mjs
 */
import { fetchYahooOHLCV, toYahooSym, TASI_STOCKS, emaArray, calcRsi, calcVWAP } from './tasi_screener.mjs';

const H = 20, COST_RT = 0.0061, MIN_HISTORY = 210;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x)?'—':(x*100).toFixed(2)+'%';
const win = a => a.length ? (a.filter(x=>x>0).length/a.length*100).toFixed(0)+'%' : '–';

async function main() {
  const syms = TASI_STOCKS.map(s=>s.sym);
  const data = {};
  for (const sym of syms) { try { const bb = await fetchYahooOHLCV(toYahooSym(sym),'1d',520); if (bb.length<MIN_HISTORY) continue;
    data[sym] = { closes:bb.map(x=>x.close), highs:bb.map(x=>x.high), lows:bb.map(x=>x.low), volumes:bb.map(x=>x.volume), di:Object.fromEntries(bb.map((x,i)=>[iso(x.time),i])) };
  } catch {} }
  const ib = await fetchYahooOHLCV('^TASI.SR','1d',520);
  const idxDates = ib.map(x=>iso(x.time)), idxClose = ib.map(x=>x.close);
  const usable = Object.keys(data);
  const ewCache = {};
  const ew = (date) => { if (date in ewCache) return ewCache[date]; const rs=[]; for (const s of usable){const d=data[s];const i=d.di[date];if(i==null||i+H>=d.closes.length)continue;rs.push(d.closes[i+H]/d.closes[i]-1);} return ewCache[date]=rs.length?mean(rs):null; };

  const last = idxDates.length-1-H, first = Math.max(MIN_HISTORY, idxDates.length-252-H);
  const B = { oversold:[], deep:[], dipUptrend:[], belowVwap:[], fallingKnife:[] };
  for (let di=first; di<=last; di++) {
    const date = idxDates[di]; const bench = ew(date); if (bench==null) continue;
    for (const sym of usable) { const d=data[sym]; const i=d.di[date]; if (i==null||i<MIN_HISTORY||i+H>=d.closes.length) continue;
      const c = d.closes.slice(0,i+1); if (c.length<200) continue;
      const price = c.at(-1), rsi = calcRsi(c,14), e200 = emaArray(c,200).at(-1);
      const vwap = calcVWAP(d.highs.slice(0,i+1), d.lows.slice(0,i+1), c, d.volumes.slice(0,i+1), 20);
      const raw = d.closes[i+H]/d.closes[i]-1; const rec = { raw, ex: raw-bench };
      if (rsi < 40) B.oversold.push(rec);
      if (rsi < 30) B.deep.push(rec);
      if (rsi < 45 && price > e200) B.dipUptrend.push(rec);          // buy the dip in an uptrend
      if (rsi < 45 && vwap && price < vwap) B.belowVwap.push(rec);
      if (rsi < 30 && price < e200) B.fallingKnife.push(rec);        // oversold in a downtrend
    }
  }

  const row = (name,a)=>{ const raws=a.map(r=>r.raw), exs=a.map(r=>r.ex);
    console.log(`  ${name.padEnd(28)} n=${String(a.length).padStart(5)}  ABS ${pct(mean(raws)).padStart(7)} (profit ${win(raws)}, t=${t(raws)})   excess ${pct(mean(exs)).padStart(7)}  net ${pct(mean(exs)-COST_RT).padStart(7)}`); };
  console.log(`\n=== CONTRARIAN TEST — buy WEAKNESS, absolute return (H=${H}) ===`);
  console.log(`  (for reference, momentum STRONG BUY was ABS -1.25%, profit 38%)\n`);
  row('Oversold (RSI<40)', B.oversold);
  row('Deep oversold (RSI<30)', B.deep);
  row('Dip in uptrend (RSI<45 & >200EMA)', B.dipUptrend);
  row('Oversold below VWAP (RSI<45)', B.belowVwap);
  row('Falling knife (RSI<30 & <200EMA)', B.fallingKnife);
  const best = Object.entries(B).map(([k,a])=>[k,mean(a.map(r=>r.raw))]).filter(([,m])=>!isNaN(m)).sort((a,b)=>b[1]-a[1])[0];
  console.log(`\nVERDICT: best absolute bucket = ${best[0]} at ${pct(best[1])}. ${best[1]>0?'POSITIVE absolute — contrarian beats momentum, worth pursuing.':'still negative — no price-action signal makes absolute money this period; the lever is information, not TA.'}`);
  process.exit(0);
}
main();
