/**
 * extension_test.mjs — is the loss concentrated in ALREADY-EXTENDED Strong Buys?
 * Among STRONG BUY signals, split by how stretched the entry is (RSI, and % above
 * the 200-EMA) and measure ABSOLUTE return + excess vs the equal-weight basket at
 * 20 sessions, no lookahead. If the not-extended bucket is flat/positive while the
 * extended bucket carries the loss, penalizing extension is the fix.
 *
 * Run: node scripts/extension_test.mjs
 */
import {
  fetchYahooOHLCV, toYahooSym, TASI_STOCKS,
  emaArray, calcRsi, macdHist, volumeCheck, calcVWAP, calcOBVTrend, findSRLevels, scoreBias,
} from './tasi_screener.mjs';

const H = 20, COST_RT = 0.0061, MIN_HISTORY = 210;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// returns {isSB, rsi, extPct} using only bars[0..idx]
function evalAt(b, idx, idxChg63) {
  const s = (a) => a.slice(0, idx + 1);
  const closes = s(b.closes), highs = s(b.highs), lows = s(b.lows), volumes = s(b.volumes);
  if (closes.length < 50) return { isSB: false };
  const price = closes.at(-1);
  const e200 = emaArray(closes, 200).at(-1);
  const rsi = calcRsi(closes, 14);
  const emas = { ema13: emaArray(closes,13).at(-1), ema34: emaArray(closes,34).at(-1), ema89: emaArray(closes,89).at(-1), ema200: e200 };
  const rsScore = (idxChg63 != null && closes.length >= 64) ? ((price-closes.at(-64))/closes.at(-64)*100 - idxChg63) : null;
  const sc = scoreBias(emas, rsi, macdHist(closes), volumeCheck(volumes,true), price, 'swing', rsScore,
    { srLevels: findSRLevels(highs,lows,closes,5), avgVolume: volumes.slice(-20).reduce((a,c)=>a+(c||0),0)/20,
      rsScore60d: rsScore, isExtended:false, vwap20: calcVWAP(highs,lows,closes,volumes,20), obv_trend: calcOBVTrend(closes,volumes,20), isTasi:true });
  return { isSB: sc.bias === 'STRONG BUY' && sc.score >= 7, rsi, extPct: e200 ? (price - e200) / e200 * 100 : 0 };
}

const mean = a => a.length ? a.reduce((x,y)=>x+y,0)/a.length : NaN;
const sd = a => { if (a.length<2) return NaN; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const t = a => a.length>1 ? +(mean(a)/(sd(a)/Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => (x*100).toFixed(2)+'%';
const win = a => a.length ? (a.filter(x=>x>0).length/a.length*100).toFixed(0)+'%' : '–';

async function main() {
  const syms = TASI_STOCKS.map(s=>s.sym);
  const data = {};
  for (const sym of syms) { try { const bb = await fetchYahooOHLCV(toYahooSym(sym),'1d',520); if (bb.length<MIN_HISTORY) continue;
    const dates = bb.map(x=>iso(x.time));
    data[sym] = { dates, closes:bb.map(x=>x.close), highs:bb.map(x=>x.high), lows:bb.map(x=>x.low), volumes:bb.map(x=>x.volume), di:Object.fromEntries(dates.map((d,i)=>[d,i])) };
  } catch {} }
  const ib = await fetchYahooOHLCV('^TASI.SR','1d',520);
  const idxDates = ib.map(x=>iso(x.time)), idxClose = ib.map(x=>x.close);
  const usable = Object.keys(data);
  const ewCache = {};
  const ew = (date) => { if (date in ewCache) return ewCache[date]; const rs=[]; for (const s of usable){const d=data[s];const i=d.di[date];if(i==null||i+H>=d.closes.length)continue;rs.push(d.closes[i+H]/d.closes[i]-1);} return ewCache[date]=rs.length?mean(rs):null; };

  const last = idxDates.length-1-H, first = Math.max(MIN_HISTORY, idxDates.length-252-H);
  // buckets: collect {raw, excess}
  const B = { all:[], notExt:[], ext:[], rsiLo:[], rsiMid:[], rsiHi:[], ext0:[], ext5:[], ext10:[] };
  for (let di=first; di<=last; di++) {
    const date = idxDates[di]; const bench = ew(date); if (bench==null) continue;
    const idxChg63 = di>=63 ? (idxClose[di]-idxClose[di-63])/idxClose[di-63]*100 : null;
    for (const sym of usable) { const d=data[sym]; const i=d.di[date]; if (i==null||i<MIN_HISTORY||i+H>=d.closes.length) continue;
      const e = evalAt(d,i,idxChg63); if (!e.isSB) continue;
      const raw = d.closes[i+H]/d.closes[i]-1; const rec = { raw, ex: raw-bench };
      B.all.push(rec);
      const extended = e.rsi > 70 || e.extPct > 8;
      (extended ? B.ext : B.notExt).push(rec);
      (e.rsi<60?B.rsiLo:e.rsi<70?B.rsiMid:B.rsiHi).push(rec);
      (e.extPct<5?B.ext0:e.extPct<10?B.ext5:B.ext10).push(rec);
    }
  }

  const row = (name,a)=>{ const raws=a.map(r=>r.raw), exs=a.map(r=>r.ex);
    console.log(`  ${name.padEnd(26)} n=${String(a.length).padStart(5)}  ABS ${pct(mean(raws)).padStart(7)} (profit ${win(raws)}, t=${t(raws)})   excess ${pct(mean(exs)).padStart(7)}  net ${pct(mean(exs)-COST_RT).padStart(7)}`); };
  console.log(`\n=== EXTENSION TEST — STRONG BUY absolute return by entry stretch (H=${H}) ===\n`);
  row('ALL Strong Buy', B.all);
  console.log('\n  by extension flag (RSI>70 OR >8% above 200-EMA):');
  row('NOT extended', B.notExt); row('EXTENDED', B.ext);
  console.log('\n  by RSI at entry:');
  row('RSI < 60', B.rsiLo); row('RSI 60-70', B.rsiMid); row('RSI > 70 (overbought)', B.rsiHi);
  console.log('\n  by % above 200-EMA at entry:');
  row('<5% above', B.ext0); row('5-10% above', B.ext5); row('>10% above (stretched)', B.ext10);
  const flip = mean(B.notExt.map(r=>r.raw)) > 0 && mean(B.ext.map(r=>r.raw)) < 0;
  console.log(`\nVERDICT: ${flip ? 'YES — not-extended is positive ABS while extended carries the loss. Penalize extension (fix C1).' : 'No clean flip — extension alone does not turn absolute return positive.'}`);
  process.exit(0);
}
main();
