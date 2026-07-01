// Swing / positional trend-following test on DAILY bars.
// Thesis: over multi-day holds, a small trend edge isn't eaten by per-trade
// costs (unlike intraday). Classic ingredients — long-term regime filter +
// Donchian breakout entry + ATR trailing (chandelier) exit. Long-only, CNC.
//
//   node fyers-swing.js <strategy> <years>
//   strategy: donchian | sma_momentum
import { getHistory } from "./fyers-client.js";

const STRAT = process.argv[2] || "donchian";
const YEARS = parseFloat(process.argv[3] || "3");

// Delivery round-trip cost: STT 0.1%×2 + exch+GST+stamp ≈ 0.25% of turnover.
const COST_RT = parseFloat(process.env.COST_RT || "0.25") / 100;

const UNIVERSE = (process.env.UNIVERSE || [
  "NSE:RELIANCE-EQ","NSE:TCS-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:INFY-EQ",
  "NSE:SBIN-EQ","NSE:AXISBANK-EQ","NSE:ITC-EQ","NSE:LT-EQ","NSE:KOTAKBANK-EQ",
  "NSE:BHARTIARTL-EQ","NSE:HINDUNILVR-EQ","NSE:MARUTI-EQ","NSE:TITAN-EQ",
  "NSE:BAJFINANCE-EQ","NSE:ASIANPAINT-EQ","NSE:SUNPHARMA-EQ","NSE:TATAMOTORS-EQ",
].join(",")).split(",");

// ── Chunked daily fetch (Fyers caps ~366d/request) ──────────────────
async function dailyBars(sym, years){
  const out=[]; const now=new Date(); const totalDays=Math.ceil(years*365);
  for(let off=totalDays; off>0; off-=360){
    const to=new Date(now.getTime()-(off-360>0?off-360:0)*86400000);
    const from=new Date(now.getTime()-off*86400000);
    const q=new URLSearchParams({symbol:sym,resolution:"D",date_format:"1",
      range_from:from.toISOString().slice(0,10),range_to:to.toISOString().slice(0,10),cont_flag:"1"});
    // reuse client's request via getHistory-style call isn't range-flexible, so inline fetch:
    const res=await fetch(`https://api-t1.fyers.in/data/history?${q}`,{headers:{
      Authorization:`${process.env.FYERS_APP_ID}:${process.env.FYERS_ACCESS_TOKEN}`}});
    const d=await res.json();
    (d.candles||[]).forEach(c=>out.push({ts:c[0],open:c[1],high:c[2],low:c[3],close:c[4],vol:c[5]}));
  }
  // dedupe by ts, sort
  const m=new Map(); out.forEach(b=>m.set(b.ts,b));
  return [...m.values()].sort((a,b)=>a.ts-b.ts);
}

const smaArr=(a,len)=>a.map((_,i)=>i<len-1?NaN:a.slice(i-len+1,i+1).reduce((x,y)=>x+y,0)/len);
function atrArr(bars,len){const tr=[0];for(let i=1;i<bars.length;i++){const h=bars[i].high,l=bars[i].low,pc=bars[i-1].close;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}const k=2/(len+1);let e=tr[0];const o=[e];for(let i=1;i<tr.length;i++){e=tr[i]*k+e*(1-k);o.push(e);}return o;}

function runSymbol(bars){
  const c=bars.map(b=>b.close);
  const sma200=smaArr(c,200), sma50=smaArr(c,50), atr=atrArr(bars,14);
  const donHi=bars.map((_,i)=>i<20?NaN:Math.max(...bars.slice(i-20,i).map(b=>b.high)));
  const ret12=c.map((v,i)=>i<12?NaN:(v-c[i-12])/c[i-12]);
  const trades=[]; let pos=false,entry=0,peakHigh=0,entryIdx=0;
  for(let i=200;i<bars.length;i++){
    const up=c[i]>sma200[i];
    if(pos){
      peakHigh=Math.max(peakHigh,bars[i].high);
      const chand=peakHigh-3*atr[i];
      const exitTrail=bars[i].low<=chand;
      const exitTrend=c[i]<sma50[i];
      if(exitTrail||exitTrend||i===bars.length-1){
        const px=exitTrail?chand:c[i];
        trades.push({ret:(px-entry)/entry-COST_RT, bars:i-entryIdx});
        pos=false;
      }
      continue;
    }
    let enter=false;
    if(STRAT==="donchian")      enter=up && bars[i].close>donHi[i];              // 20-day breakout in uptrend
    else if(STRAT==="sma_momentum") enter=up && c[i]>sma50[i] && ret12[i]>0.03; // above 50 & +3% 12d momentum
    if(enter){pos=true;entry=c[i];peakHigh=bars[i].high;entryIdx=i;}
  }
  return trades;
}

function stats(t){if(!t.length)return{n:0};const r=t.map(x=>x.ret*100),w=r.filter(x=>x>0).length;
  const tot=r.reduce((a,b)=>a+b,0),avg=tot/t.length;
  const gp=r.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=-r.filter(x=>x<0).reduce((a,b)=>a+b,0);
  let cum=0,pk=0,dd=0;for(const x of r){cum+=x;pk=Math.max(pk,cum);dd=Math.min(dd,cum-pk);}
  const hold=t.reduce((a,b)=>a+b.bars,0)/t.length;
  return{n:t.length,win:w/t.length*100,tot,avg,pf:gl?gp/gl:Infinity,dd,hold};}
const fmt=(s)=>s.n?`n=${s.n} win=${s.win.toFixed(0)}% ret=${s.tot>=0?"+":""}${s.tot.toFixed(1)}% avg=${s.avg>=0?"+":""}${s.avg.toFixed(2)}% PF=${s.pf.toFixed(2)} DD=${s.dd.toFixed(1)}% hold=${s.hold.toFixed(0)}d`:"n=0";

async function main(){
  console.log(`\n🔬 SWING ${STRAT} | daily | ~${YEARS}y | cost/RT=${(COST_RT*100).toFixed(2)}% | ${UNIVERSE.length} symbols\n`);
  const trainAll=[],testAll=[],all=[];
  for(const sym of UNIVERSE){
    let bars;try{bars=await dailyBars(sym,YEARS);}catch(e){console.log(`${sym} ERR ${e.message}`);continue;}
    if(bars.length<260){console.log(`${sym.padEnd(20)} thin(${bars.length})`);continue;}
    const cut=Math.floor(bars.length*0.7);
    const full=runSymbol(bars), tr=runSymbol(bars.slice(0,cut)), te=runSymbol(bars.slice(cut-200>0?cut-200:0));
    all.push(...full);trainAll.push(...tr);testAll.push(...te);
    console.log(`${sym.replace("NSE:","").replace("-EQ","").padEnd(12)} ${fmt(stats(full))}`);
  }
  console.log(`\n── Aggregate (all) ──\n${fmt(stats(all))}`);
  console.log(`── In-sample (train 70%) ──\n${fmt(stats(trainAll))}`);
  console.log(`── OUT-OF-SAMPLE (test 30%) ──\n${fmt(stats(testAll))}`);
  const s=stats(testAll);
  console.log(`\nEdge test: OOS avg/trade > 0 AND PF > 1.2?  ${s.n&&s.avg>0&&s.pf>1.2?"✅ POSSIBLE EDGE":"❌ no edge"}\n`);
  console.log(`⚠️  Long-only; benchmark vs buy&hold before trusting. Gross of taxes on gains.\n`);
}
main().catch(e=>{console.error("Fatal:",e.message);process.exit(1);});
