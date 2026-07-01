// Backtest the scalper/indicator logic on real Fyers historical bars.
// Long-only: BUY to enter, SELL or 0.5% stop to exit, force square-off at day end.
// Faithful to the Pine indicator: continuous EMA(8) & Wilder RSI(3), session VWAP.
//
//   node fyers-backtest.js [SYMBOL] [RESOLUTION] [DAYS]
//   e.g.  node fyers-backtest.js NSE:ICICIBANK-EQ 15 30
import { getHistory } from "./fyers-client.js";

const SYMBOL = process.argv[2] || "NSE:ICICIBANK-EQ";
const RES    = process.argv[3] || "15";
const DAYS   = parseInt(process.argv[4] || "30", 10);
const SL_PCT = parseFloat(process.env.FYERS_SL_PCT || "0.5") / 100;
const RSI_OB = 70, RSI_OS = 30;

// ── Indicators (match Pine ta.*) ────────────────────────────────────
const ema = (arr, len) => { const k = 2/(len+1); let e = arr[0]; const out=[e];
  for (let i=1;i<arr.length;i++){ e = arr[i]*k + e*(1-k); out.push(e);} return out; };

// Wilder's RSI (matches Pine ta.rsi)
function wilderRSI(closes, len){
  const out = Array(closes.length).fill(50);
  let ag=0, al=0;
  for (let i=1;i<closes.length;i++){
    const ch = closes[i]-closes[i-1];
    const g = Math.max(ch,0), l = Math.max(-ch,0);
    if (i<=len){ ag+=g; al+=l; if(i===len){ ag/=len; al/=len; out[i]= al===0?100:100-100/(1+ag/al);} }
    else { ag=(ag*(len-1)+g)/len; al=(al*(len-1)+l)/len; out[i]= al===0?100:100-100/(1+ag/al); }
  }
  return out;
}

const dayKey = (ts) => new Date(ts*1000).toISOString().slice(0,10);

async function main(){
  const bars = await getHistory(SYMBOL, RES, DAYS);
  if (bars.length < 20){ console.log(`Not enough bars (${bars.length}).`); return; }

  const closes = bars.map(b=>b.close);
  const ema8 = ema(closes, 8);
  const rsi3 = wilderRSI(closes, 3);

  // session VWAP (reset each day)
  const vwap = []; let cTPV=0, cVol=0, curDay=null;
  for (const b of bars){ const d=dayKey(b.ts); if(d!==curDay){curDay=d;cTPV=0;cVol=0;}
    const tp=(b.high+b.low+b.close)/3; cTPV+=tp*b.vol; cVol+=b.vol; vwap.push(cVol?cTPV/cVol:b.close); }

  // ── Walk bars, simulate long-only ─────────────────────────────────
  let pos=false, entry=0, entryTime=0;
  const trades=[]; let prevBuy=false, prevSell=false;

  for (let i=1;i<bars.length;i++){
    const c=closes[i], bull=c>vwap[i]&&c>ema8[i], bear=c<vwap[i]&&c<ema8[i];
    const buySig=bull&&rsi3[i]<RSI_OB, sellSig=bear&&rsi3[i]>RSI_OS;
    const buyTrig=buySig&&!prevBuy, sellTrig=sellSig&&!prevSell;
    prevBuy=buySig; prevSell=sellSig;

    const newDay = dayKey(bars[i].ts)!==dayKey(bars[i-1].ts);
    // force square-off if a new day started while holding (MIS)
    if (pos && newDay){ trades.push({entry,exit:closes[i-1],reason:"eod",t:entryTime}); pos=false; }

    if (pos){
      if (c <= entry*(1-SL_PCT)){ trades.push({entry,exit:c,reason:"stop",t:entryTime}); pos=false; }
      else if (sellTrig){ trades.push({entry,exit:c,reason:"signal",t:entryTime}); pos=false; }
    } else if (buyTrig){ pos=true; entry=c; entryTime=bars[i].ts; }
  }
  if (pos) trades.push({entry,exit:closes.at(-1),reason:"open-end",t:entryTime});

  // ── Stats ─────────────────────────────────────────────────────────
  const pnl = trades.map(t=>t.exit-t.entry);
  const pct = trades.map(t=>((t.exit-t.entry)/t.entry)*100);
  const wins = pnl.filter(p=>p>0).length;
  const totalPct = pct.reduce((a,b)=>a+b,0);
  const gross = pnl.reduce((a,b)=>a+b,0);
  let peak=0, cum=0, maxDD=0;
  for (const p of pct){ cum+=p; peak=Math.max(peak,cum); maxDD=Math.min(maxDD,cum-peak); }

  console.log(`\n📊 Backtest — ${SYMBOL}  ${RES}m  (${bars.length} bars, ~${DAYS}d, ${dayKey(bars[0].ts)}→${dayKey(bars.at(-1).ts)})`);
  console.log(`Logic: VWAP+RSI(3)+EMA(8), long-only, ${(SL_PCT*100).toFixed(1)}% stop, EOD square-off\n`);
  console.log(`Trades:        ${trades.length}`);
  console.log(`Win rate:      ${trades.length?(wins/trades.length*100).toFixed(1):0}%  (${wins}W / ${trades.length-wins}L)`);
  console.log(`Total return:  ${totalPct>=0?"+":""}${totalPct.toFixed(2)}%  (sum of per-trade %, 1 share)`);
  console.log(`Gross points:  ${gross>=0?"+":""}${gross.toFixed(2)}`);
  console.log(`Avg trade:     ${trades.length?(totalPct/trades.length).toFixed(3):0}%`);
  console.log(`Best / worst:  +${Math.max(...pct).toFixed(2)}% / ${Math.min(...pct).toFixed(2)}%`);
  console.log(`Max drawdown:  ${maxDD.toFixed(2)}%`);
  const exits = trades.reduce((m,t)=>{m[t.reason]=(m[t.reason]||0)+1;return m;},{});
  console.log(`Exit reasons:  ${JSON.stringify(exits)}`);
  console.log(`\n⚠️  Gross of costs — brokerage, STT, slippage & MPP bands not included.\n`);
}
main().catch(e=>{ console.error("Fatal:", e.message); process.exit(1); });
