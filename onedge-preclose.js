// Pre-close prep for the ON-EDGE overnight entry — solves the 15:25 scramble.
// Run ~15:15 IST (and again ~15:24 for the final check): scans the watchlist
// with PROVISIONAL IBS, and for every likely qualifier pre-picks the exact
// deep-ITM call (same strike/spread logic as fyers-paper-overnight.js) with
// live bid/ask — so placing the manual order is copy, paste, confirm.
//
//   node onedge-preclose.js            (uses WATCH env or default list)
//
// Read-only: prints a prep card. NO orders are placed (live API orders are
// blocked; entries are always manual in the Fyers app).
import { getHistory, getQuotes } from "./fyers-client.js";

const WATCH = (process.env.WATCH || "SBIN,GRASIM,ASIANPAINT,LT,NTPC,AXISBANK,SUNPHARMA,INDUSINDBK,BAJFINANCE,DIVISLAB,ADANIENT,DIXON").split(",");
const ITM_FRAC = 0.93;              // ~7% ITM, delta ~0.85-0.9 (matches paper logger)
const MAX_SPREAD_PCT = 0.15;        // untradeable above this (% of spot)
const SHOW_FROM = 0.60;             // show near-misses from this IBS (can still climb by close)

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function expiryCode(d = new Date()){
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() > 24){ m++; if (m > 11){ m = 0; y++; } }
  return String(y % 100) + MONTHS[m];
}
const grid = (p) => p < 250 ? 5 : p < 1000 ? 10 : p < 2500 ? 20 : p < 5000 ? 50 : 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function pickCall(stock, spot){
  const g = grid(spot), exp = expiryCode();
  const base = Math.round(spot * ITM_FRAC / g) * g;
  let best = null;
  for (const k of [base, base + g, base - g, base + 2*g]){
    const sym = `NSE:${stock}${exp}${k}CE`;
    try{
      const q = await getQuotes(sym); const v = q.d?.[0]?.v;
      if (v && v.lp && v.bid && v.ask){
        const spr = v.ask - v.bid, sprPct = spr / spot * 100;
        if (!best || sprPct < best.sprPct) best = { sym, k, bid:v.bid, ask:v.ask, spr, sprPct };
      }
    }catch{}
    await sleep(150);
  }
  return best;
}

async function stockState(stock){
  const b = await getHistory(`NSE:${stock}-EQ`, "D", 360);
  if (b.length < 210) return null;
  const c = b.map(x => x.close), i = b.length - 1;
  const sma = c.slice(i-199, i+1).reduce((a,x)=>a+x,0) / 200;
  const t = b[i];
  const ibs = (t.close - t.low) / ((t.high - t.low) || 1);
  return { stock, ibs, spot: t.close, green: t.close > t.open, above: t.close > sma,
           needUp: Math.max(0, (t.low + 0.7*(t.high-t.low)) - t.close) };  // pts needed to reach IBS 0.7
}

async function main(){
  const nowIST = new Date(Date.now() + 330*60_000).toISOString().slice(11,16);
  console.log(`\n== ON-EDGE PRE-CLOSE PREP (${nowIST} IST) ==`);
  console.log(`rule: IBS>=0.7 & >SMA200 (paper) | tight v3 adds green + IBS>=0.8`);
  console.log(`IBS is PROVISIONAL until 15:30 — re-run at ~15:24 for the final read.\n`);

  const states = [];
  for (const s of WATCH){
    try{ const st = await stockState(s); if (st) states.push(st); }
    catch(e){ console.log(`  ${s.padEnd(11)} err ${e.message.slice(0,40)}`); }
  }
  states.sort((a,b) => b.ibs - a.ibs);

  const candidates = states.filter(s => s.above && s.ibs >= SHOW_FROM);
  const skipped    = states.filter(s => !s.above || s.ibs < SHOW_FROM);

  if (!candidates.length) console.log("  No candidates near the bar tonight.");
  for (const s of candidates){
    const firm  = s.ibs >= 0.7;
    const tight = s.ibs >= 0.8 && s.green;
    const label = tight ? "QUALIFIES (v3 tight)" : firm ? "QUALIFIES (paper rule)" : `near-miss — needs +${s.needUp.toFixed(1)} pts for 0.7`;
    console.log(`  ${s.stock.padEnd(11)} IBS ${s.ibs.toFixed(2)} ${s.green?"grn":"red"}  spot ${s.spot}  ${label}`);
    if (firm){
      const opt = await pickCall(s.stock, s.spot);
      if (!opt){ console.log(`     no liquid option found`); continue; }
      const flag = opt.sprPct > MAX_SPREAD_PCT ? "  << SPREAD TOO WIDE — SKIP" : "";
      console.log(`     ORDER CARD: BUY ${opt.sym}`);
      console.log(`     ask ${opt.ask} / bid ${opt.bid}  spread ${opt.spr.toFixed(2)}pt = ${opt.sprPct.toFixed(3)}% of spot${flag}`);
    }
  }
  if (skipped.length)
    console.log(`\n  out tonight: ${skipped.map(s=>`${s.stock}(${s.ibs.toFixed(2)}${s.above?"":",<200"})`).join(" ")}`);
  console.log("");
}

main();
