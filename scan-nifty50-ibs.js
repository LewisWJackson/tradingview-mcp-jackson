// One-off / repeatable scan: which Nifty 50 stocks currently qualify for the
// ON-EDGE overnight setup (daily IBS >= 0.7 AND close above 200-day SMA).
// Read-only — no orders, just a report. Used for the mid-morning preview and
// the near-close final scan ahead of fyers-paper-overnight.js's official entry.
//
//   node scan-nifty50-ibs.js
import { getHistory } from "./fyers-client.js";

// Standard Nifty 50 constituents (approx, as of recent reconstitution).
const NIFTY50 = [
  "ADANIENT","ADANIPORTS","APOLLOHOSP","ASIANPAINT","AXISBANK","BAJAJ-AUTO",
  "BAJFINANCE","BAJAJFINSV","BEL","BHARTIARTL","CIPLA","COALINDIA","DIVISLAB",
  "DRREDDY","EICHERMOT","GRASIM","HCLTECH","HDFCBANK","HDFCLIFE","HEROMOTOCO",
  "HINDALCO","HINDUNILVR","ICICIBANK","ITC","INDUSINDBK","INFY","JSWSTEEL",
  "KOTAKBANK","LTIM","LT","M&M","MARUTI","NESTLEIND","NTPC","ONGC","POWERGRID",
  "RELIANCE","SBILIFE","SHRIRAMFIN","SBIN","SUNPHARMA","TATACONSUM","TATAMOTORS",
  "TATASTEEL","TCS","TECHM","TITAN","TRENT","ULTRACEMCO","WIPRO",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function qualifies(stock) {
  const b = await getHistory(`NSE:${stock}-EQ`, "D", 360);
  if (b.length < 210) return null;
  const c = b.map((x) => x.close), i = b.length - 1;
  const sma = c.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
  const t = b[i];
  const ibs = (t.close - t.low) / ((t.high - t.low) || 1);
  return { stock, ibs, spot: t.close, sma200: sma, above: t.close > sma, ok: ibs >= 0.7 && t.close > sma };
}

async function main() {
  const results = [];
  for (const s of NIFTY50) {
    try {
      const q = await qualifies(s);
      if (q) results.push(q);
      else console.log(`  ${s.padEnd(12)} no data / insufficient history`);
    } catch (e) {
      console.log(`  ${s.padEnd(12)} err ${e.message.slice(0, 60)}`);
    }
    await sleep(300);
  }
  const qual = results.filter((r) => r.ok).sort((a, b) => b.ibs - a.ibs);
  console.log(`\n=== QUALIFIERS (IBS>=0.7 & above SMA200): ${qual.length} ===`);
  for (const r of qual) {
    console.log(`  ${r.stock.padEnd(12)} IBS ${r.ibs.toFixed(3)}  spot ${r.spot.toFixed(2)}  SMA200 ${r.sma200.toFixed(2)}`);
  }
  console.log(`\n(scanned ${results.length}/${NIFTY50.length} symbols successfully)`);
}

main();
