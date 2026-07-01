// Research harness — hunt for a positive-expectancy intraday long edge.
// Adds the four things a real strategy needs over the demo:
//   1. Regime filter  (only trade with the higher trend)
//   2. ATR bracket    (real risk/reward: stop = k·ATR, target = R·stop)
//   3. Cost model      (brokerage+STT+slippage per round trip)
//   4. Out-of-sample   (train window vs held-out test window)
// Validated across a universe of liquid NSE names, aggregated + per-symbol.
//
//   node fyers-research.js <strategy> <resolution> <days>
//   strategy: baseline | trendbracket | pullback
import { getHistory } from "./fyers-client.js";

const STRAT = process.argv[2] || "trendbracket";
const RES   = process.argv[3] || "5";
const DAYS  = parseInt(process.argv[4] || "90", 10);

// Round-trip cost as % of notional: brokerage+STT+exch+GST (~0.06%) + slippage (~0.06%).
const COST_RT = parseFloat(process.env.COST_RT || "0.12") / 100;

const UNIVERSE = (process.env.UNIVERSE || [
  "NSE:RELIANCE-EQ","NSE:TCS-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:INFY-EQ",
  "NSE:SBIN-EQ","NSE:AXISBANK-EQ","NSE:ITC-EQ","NSE:LT-EQ","NSE:KOTAKBANK-EQ",
  "NSE:BHARTIARTL-EQ","NSE:HINDUNILVR-EQ",
].join(",")).split(",");

// ── Indicator helpers ───────────────────────────────────────────────
const emaArr = (a,len)=>{const k=2/(len+1);let e=a[0];const o=[e];for(let i=1;i<a.length;i++){e=a[i]*k+e*(1-k);o.push(e);}return o;};
function wilderRSI(c,len){const o=Array(c.length).fill(50);let ag=0,al=0;for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0);if(i<=len){ag+=g;al+=l;if(i===len){ag/=len;al/=len;o[i]=al===0?100:100-100/(1+ag/al);}}else{ag=(ag*(len-1)+g)/len;al=(al*(len-1)+l)/len;o[i]=al===0?100:100-100/(1+ag/al);}}return o;}
function atrArr(bars,len){const tr=[0];for(let i=1;i<bars.length;i++){const h=bars[i].high,l=bars[i].low,pc=bars[i-1].close;tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return emaArr(tr,len);}// RMA≈EMA
const dayKey=(ts)=>new Date(ts*1000).toISOString().slice(0,10);

// ── Simulate one symbol; returns array of trades {ret} net of costs ──
function runSymbol(bars){
  const c=bars.map(b=>b.close);
  const emaFast=emaArr(c,9), emaTrend=emaArr(c,50), rsi=wilderRSI(c,3), atr=atrArr(bars,14);
  // session VWAP
  const vwap=[];let tpv=0,vol=0,cd=null;
  for(const b of bars){const d=dayKey(b.ts);if(d!==cd){cd=d;tpv=0;vol=0;}const tp=(b.high+b.low+b.close)/3;tpv+=tp*b.vol;vol+=b.vol;vwap.push(vol?tpv/vol:b.close);}

  const trades=[];let pos=false,entry=0,stop=0,target=0,pb=false,ps=false;
  for(let i=51;i<bars.length;i++){
    const price=c[i], up=c[i]>emaTrend[i];                 // regime: uptrend
    const newDay=dayKey(bars[i].ts)!==dayKey(bars[i-1].ts);
    if(pos && newDay){ trades.push({ret:(c[i-1]-entry)/entry - COST_RT, reason:"eod"}); pos=false; }

    if(pos){
      if(bars[i].low<=stop){ trades.push({ret:(stop-entry)/entry - COST_RT, reason:"stop"}); pos=false; }
      else if(bars[i].high>=target){ trades.push({ret:(target-entry)/entry - COST_RT, reason:"target"}); pos=false; }
      continue;
    }
    // ── Entry signals per strategy ──
    let enter=false;
    if(STRAT==="baseline"){
      const bull=price>vwap[i]&&price>emaFast[i], sig=bull&&rsi[i]<70, trig=sig&&!pb; pb=sig; enter=trig;
    } else if(STRAT==="trendbracket"){
      // momentum in uptrend: cross above fast EMA while above VWAP and trend
      const cross=c[i]>emaFast[i]&&c[i-1]<=emaFast[i-1];
      enter=up && price>vwap[i] && cross;
    } else if(STRAT==="pullback"){
      // buy the dip in an uptrend: RSI(3) was oversold and turns up
      const turn=rsi[i]>rsi[i-1]&&rsi[i-1]<25;
      enter=up && price>vwap[i] && turn;
    }
    if(enter){ pos=true; entry=price; const a=atr[i]||price*0.003; stop=price-1.2*a; target=price+2.0*(price-stop); }
  }
  return trades;
}

// ── Stats ───────────────────────────────────────────────────────────
function stats(trades){
  const n=trades.length; if(!n) return {n:0};
  const r=trades.map(t=>t.ret*100), wins=r.filter(x=>x>0).length;
  const tot=r.reduce((a,b)=>a+b,0), avg=tot/n;
  const gp=r.filter(x=>x>0).reduce((a,b)=>a+b,0), gl=-r.filter(x=>x<0).reduce((a,b)=>a+b,0);
  let cum=0,peak=0,dd=0; for(const x of r){cum+=x;peak=Math.max(peak,cum);dd=Math.min(dd,cum-peak);}
  return {n, win:wins/n*100, tot, avg, pf: gl?gp/gl:Infinity, dd};
}
const fmt=(s)=>s.n?`n=${s.n} win=${s.win.toFixed(0)}% ret=${s.tot>=0?"+":""}${s.tot.toFixed(2)}% avg=${s.avg.toFixed(3)}% PF=${s.pf.toFixed(2)} DD=${s.dd.toFixed(1)}%`:"n=0";

async function main(){
  console.log(`\n🔬 Strategy: ${STRAT} | ${RES}m | ${DAYS}d | cost/RT=${(COST_RT*100).toFixed(2)}% | ${UNIVERSE.length} symbols\n`);
  const all=[], trainAll=[], testAll=[];
  for(const sym of UNIVERSE){
    let bars; try{ bars=await getHistory(sym,RES,DAYS);}catch(e){ console.log(`${sym.padEnd(20)} ERR ${e.message}`); continue; }
    if(bars.length<120){ console.log(`${sym.padEnd(20)} thin (${bars.length})`); continue; }
    // out-of-sample split: first 70% train, last 30% test (by bar index within continuous series)
    const cut=Math.floor(bars.length*0.7);
    const tr=runSymbol(bars.slice(0,cut+51<bars.length?cut:bars.length));
    const te=runSymbol(bars.slice(Math.max(0,cut-51)));
    const full=runSymbol(bars);
    all.push(...full); trainAll.push(...tr); testAll.push(...te);
    console.log(`${sym.replace("NSE:","").replace("-EQ","").padEnd(12)} ${fmt(stats(full))}`);
  }
  console.log(`\n── Aggregate (all bars) ──\n${fmt(stats(all))}`);
  console.log(`── In-sample  (train 70%) ──\n${fmt(stats(trainAll))}`);
  console.log(`── OUT-OF-SAMPLE (test 30%) ──\n${fmt(stats(testAll))}`);
  console.log(`\nEdge test: is OUT-OF-SAMPLE avg/trade > 0 and PF > 1.1?  ${(()=>{const s=stats(testAll);return s.n&&s.avg>0&&s.pf>1.1?"✅ possible edge":"❌ no edge";})()}\n`);
}
main().catch(e=>{console.error("Fatal:",e.message);process.exit(1);});
