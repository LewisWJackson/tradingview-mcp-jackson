// Paper-trade logger for the ON-EDGE overnight stock strategy.
// Records REAL option quotes so spread/cost is captured — no live orders.
//
//   Near close (~15:25):  node fyers-paper-overnight.js entry
//     → scans watchlist, finds qualifiers (IBS>=0.7 & above SMA200),
//       picks a moderately-deep-ITM call, logs the ASK (realistic buy).
//   Next open (~9:16):    node fyers-paper-overnight.js exit
//     → for each open position, logs the BID (realistic sell), computes P&L.
//   Anytime:              node fyers-paper-overnight.js report
//
// Buy@ask + sell@bid = you pay the full spread on both legs = honest fills.
import { existsSync, readFileSync, writeFileSync } from "fs";
import { getHistory, getQuotes } from "./fyers-client.js";

const MODE = process.argv[2] || "report";
const LOG  = new URL("./paper-overnight-log.json", import.meta.url);
const WATCH = (process.env.WATCH || "SBIN,GRASIM,ASIANPAINT,LT,NTPC,AXISBANK,SUNPHARMA,INDUSINDBK,BAJFINANCE").split(",");
const ITM_FRAC = 0.93;                 // target strike ~7% ITM (delta ~0.85-0.9)
const MAX_SPREAD_PCT = 0.15;           // skip if option spread > 0.15% of spot (untradeable)

const MONTHS = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
function expiryCode(d = new Date()){
  let y = d.getFullYear(), m = d.getMonth();
  if (d.getDate() > 24){ m++; if (m > 11){ m = 0; y++; } }   // roll near month-end
  return String(y % 100) + MONTHS[m];
}
const grid = (p) => p < 250 ? 5 : p < 1000 ? 10 : p < 2500 ? 20 : p < 5000 ? 50 : 100;
const load = () => existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
const save = (x) => writeFileSync(LOG, JSON.stringify(x, null, 2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Find a valid, liquid deep-ITM call: probe strikes near target, keep tightest.
async function pickCall(stock, spot){
  const g = grid(spot), exp = expiryCode();
  const base = Math.round(spot * ITM_FRAC / g) * g;
  const cands = [base, base + g, base - g, base + 2*g];
  let best = null;
  for (const k of cands){
    const sym = `NSE:${stock}${exp}${k}CE`;
    try{
      const q = await getQuotes(sym); const v = q.d?.[0]?.v;
      if (v && v.lp && v.bid && v.ask){
        const spr = v.ask - v.bid, sprPct = spr / spot * 100;
        if (!best || sprPct < best.sprPct) best = { sym, k, lp:v.lp, bid:v.bid, ask:v.ask, spr, sprPct };
      }
    }catch{}
    await sleep(150);
  }
  return best;
}

async function qualifies(stock){
  const b = await getHistory(`NSE:${stock}-EQ`, "D", 360);
  if (b.length < 210) return null;
  const c = b.map(x => x.close), i = b.length - 1;
  const sma = c.slice(i-199, i+1).reduce((a,x)=>a+x,0) / 200;
  const t = b[i], ibs = (t.close - t.low) / ((t.high - t.low) || 1);
  return { ibs, spot: t.close, above: t.close > sma, ok: ibs >= 0.7 && t.close > sma };
}

async function entry(){
  // Self-heal: if a prior night's exit was missed (e.g. expired token at 9:16),
  // close those positions via candle reconstruction before logging new entries.
  {
    const pre = load(); const today = new Date().toISOString().slice(0,10);
    if (pre.some(t => t.status === "open" && t.entryDate < today)){
      console.log("Overdue positions found — closing them first…");
      await exit();
    }
  }
  const log = load(); const today = new Date().toISOString().slice(0,10);
  if (log.some(t => t.entryDate === today)){ console.log("Entries already logged for", today); return report(); }
  console.log(`\n📝 ENTRY scan ${today} (expiry ${expiryCode()})\n`);
  for (const s of WATCH){
    try{
      const q = await qualifies(s);
      if (!q){ console.log(`  ${s.padEnd(11)} no data`); continue; }
      if (!q.ok){ console.log(`  ${s.padEnd(11)} skip — IBS ${q.ibs.toFixed(2)}${q.above?"":" / below SMA200"}`); continue; }
      const opt = await pickCall(s, q.spot);
      if (!opt){ console.log(`  ${s.padEnd(11)} qualifies but no liquid option found`); continue; }
      if (opt.sprPct > MAX_SPREAD_PCT){ console.log(`  ${s.padEnd(11)} ⛔ spread too wide (${opt.sprPct.toFixed(3)}% > ${MAX_SPREAD_PCT}%) — untradeable, skip`); continue; }
      log.push({ id:`${s}-${today}`, entryDate:today, stock:s, spot:q.spot, ibs:+q.ibs.toFixed(2),
        optSymbol:opt.sym, entryPrice:opt.ask, entrySpreadPts:+opt.spr.toFixed(2), status:"open" });
      console.log(`  ${s.padEnd(11)} 🎫 BUY ${opt.sym} @ask ${opt.ask} (spread ${opt.spr.toFixed(2)}pt = ${opt.sprPct.toFixed(3)}% of spot)`);
    }catch(e){ console.log(`  ${s.padEnd(11)} err ${e.message.slice(0,30)}`); }
  }
  save(log); console.log(""); report();
}

// Is "now" inside the intended exit window (just after the 9:15 open, IST)?
function inOpenWindow(){
  const ist = new Date(Date.now() + 330 * 60_000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Exit-time study (2026-07-10, 119 nights): holding to ~9:45 beats the open
  // exit (avg +0.226% vs +0.141%, PF 1.79 vs 1.45); edge decays after 9:45.
  return mins >= 580 && mins <= 605;                 // 09:40–10:05 IST
}

// Reconstruct a missed exit: the option's 1-min candle close at ~09:16 IST on
// the first trading day after entry. Slightly optimistic vs the true bid
// (candles are traded prices), so the trade is flagged `reconstructed`.
async function reconstructExit(t){
  const bars = await getHistory(t.optSymbol, "1", 5);
  const targets = bars.filter(b => {
    const ist = new Date((b.ts + 330 * 60) * 1000);
    const d = ist.toISOString().slice(0, 10);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    return d > t.entryDate && mins >= 585 && mins <= 615;   // 09:45–10:15 IST (matches new exit rule)
  });
  if (!targets.length) return null;
  // Prefer the first bar with real volume (thin options often print late).
  const bar = targets.find(b => b.vol > 0) || targets[0];
  const ist = new Date((bar.ts + 330 * 60) * 1000);
  const late = ist.getUTCHours() * 60 + ist.getUTCMinutes() > 560;
  return { px: bar.close, date: ist.toISOString().slice(0, 10), late };
}

async function exit(){
  const log = load(); const today = new Date().toISOString().slice(0,10);
  const open = log.filter(t => t.status === "open" && t.entryDate < today);
  const held = log.filter(t => t.status === "open" && t.entryDate === today).length;
  if (held) console.log(`(${held} position(s) entered today stay open until tomorrow's open)`);
  if (!open.length){ console.log("No positions due for exit."); return report(); }
  console.log(`\n📝 EXIT ${today}\n`);
  const live = inOpenWindow();
  for (const t of open){
    try{
      if (live){
        // Normal path: real bid right after the open.
        const q = await getQuotes(t.optSymbol); const v = q.d?.[0]?.v;
        if (!v || !v.bid){ console.log(`  ${t.stock.padEnd(11)} no quote for ${t.optSymbol}`); continue; }
        t.exitDate = today; t.exitPrice = v.bid; t.exitSpreadPts = +((v.ask - v.bid)).toFixed(2);
      } else {
        // Missed the open window (e.g. token expired at 9:16) — reconstruct
        // from the 09:15-ish candle instead of contaminating with a late price.
        const r = await reconstructExit(t);
        if (!r){ console.log(`  ${t.stock.padEnd(11)} ⚠️ cannot reconstruct 9:16 price — left open`); continue; }
        t.exitDate = r.date; t.exitPrice = r.px; t.reconstructed = true;
        if (r.late) t.lateFirstTrade = true;   // option had no prints in 9:15-20 — liquidity flag
      }
      t.pnlPts = +(t.exitPrice - t.entryPrice).toFixed(2);
      t.pnlPctPrem = +((t.pnlPts / t.entryPrice) * 100).toFixed(2);
      t.pnlPctUnderlying = +((t.pnlPts / t.spot) * 100).toFixed(3);
      t.status = "closed";
      console.log(`  ${t.stock.padEnd(11)} SELL ${t.reconstructed ? "@9:16 candle (reconstructed)" : "@bid"} ${t.exitPrice}  P&L ${t.pnlPts>=0?"+":""}${t.pnlPts}pt = ${t.pnlPctUnderlying>=0?"+":""}${t.pnlPctUnderlying}% of underlying`);
    }catch(e){ console.log(`  ${t.stock.padEnd(11)} err ${e.message.slice(0,30)}`); }
  }
  save(log); console.log(""); report();
}

function report(){
  const log = load(); const closed = log.filter(t => t.status === "closed");
  const open = log.filter(t => t.status === "open");
  console.log(`\n📊 PAPER LOG — ${closed.length} closed, ${open.length} open`);
  if (open.length) open.forEach(t => console.log(`  OPEN  ${t.entryDate} ${t.stock} ${t.optSymbol} @${t.entryPrice}`));
  if (closed.length){
    const r = closed.map(t => t.pnlPctUnderlying);
    const w = r.filter(x => x > 0).length, tot = r.reduce((a,b)=>a+b,0);
    const gp = r.filter(x=>x>0).reduce((a,b)=>a+b,0), gl = -r.filter(x=>x<0).reduce((a,b)=>a+b,0);
    console.log(`  Win rate:   ${(w/closed.length*100).toFixed(0)}%  (${w}/${closed.length})`);
    console.log(`  Avg/night:  ${tot/closed.length>=0?"+":""}${(tot/closed.length).toFixed(3)}% of underlying (net of REAL spread)`);
    console.log(`  Total:      ${tot>=0?"+":""}${tot.toFixed(2)}%   PF ${gl?(gp/gl).toFixed(2):"∞"}`);
    console.log(`  Verdict:    ${closed.length<15?"⏳ need ~15-20 trades":(tot/closed.length>0.02?"✅ clears costs so far":"❌ not clearing costs")}`);
  }
  console.log("");
}

const fns = { entry, exit, report };
(fns[MODE] || report)();
