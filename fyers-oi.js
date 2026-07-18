// NIFTY option-chain OI snapshot — spot, nearest expiry, max pain, OI walls, PCR.
//
// Output feeds the "NIFTY REVANCHE v2.9" TradingView indicator:
//   in_40 = PCR, in_42 = Max Pain, in_43 = Call Wall, in_44 = Put Floor
// Run standalone to print (npm run fyers:oi), or `npm run fyers:oi:push` to
// write the values straight into the indicator on the open TradingView chart.
//
// Needs a fresh token — `npm run fyers:auth`.

import { getOptionChain } from "./fyers-client.js";

export async function computeOiSnapshot(symbol = "NSE:NIFTY50-INDEX", strikecount = 25) {
  const res = await getOptionChain(symbol, strikecount);
  if (res.s !== "ok" || !res.data?.optionsChain?.length)
    throw new Error(`Fyers error: ${JSON.stringify(res).slice(0, 200)}`);

  const { optionsChain, expiryData } = res.data;
  const spot = optionsChain.find((o) => o.option_type === "")?.ltp;
  const rawExpiry =
    expiryData?.[0]?.date ?? expiryData?.expiryData?.[0]?.date ?? "?";
  const expiry = Number.isFinite(Number(rawExpiry))
    ? new Date(Number(rawExpiry) * 1000).toISOString().slice(0, 10)
    : String(rawExpiry);

  // Group OI by strike
  const strikes = new Map();
  for (const o of optionsChain) {
    if (!o.option_type) continue;
    const s = strikes.get(o.strike_price) ?? { ce: 0, pe: 0 };
    if (o.option_type === "CE") s.ce = o.oi ?? 0;
    else if (o.option_type === "PE") s.pe = o.oi ?? 0;
    strikes.set(o.strike_price, s);
  }
  const sorted = [...strikes.entries()].sort((a, b) => a[0] - b[0]);

  // Max pain: the expiry strike that minimizes total payout to option buyers.
  // At settlement price k, each CE at strike s pays max(k-s,0)*OI, each PE max(s-k,0)*OI.
  let maxPain = null;
  let minPay = Infinity;
  for (const [k] of sorted) {
    let pay = 0;
    for (const [s, { ce, pe }] of sorted) {
      pay += Math.max(k - s, 0) * ce + Math.max(s - k, 0) * pe;
    }
    if (pay < minPay) {
      minPay = pay;
      maxPain = k;
    }
  }

  const byCall = [...sorted].sort((a, b) => b[1].ce - a[1].ce);
  const byPut = [...sorted].sort((a, b) => b[1].pe - a[1].pe);
  const totCE = sorted.reduce((t, [, v]) => t + v.ce, 0);
  const totPE = sorted.reduce((t, [, v]) => t + v.pe, 0);

  return {
    spot,
    expiry,
    maxPain,
    pcr: +(totPE / totCE).toFixed(2),
    callWall: byCall[0]?.[0],
    putFloor: byPut[0]?.[0],
    topCalls: byCall.slice(0, 3).map(([s, v]) => ({ strike: s, oi: v.ce })),
    topPuts: byPut.slice(0, 3).map(([s, v]) => ({ strike: s, oi: v.pe })),
  };
}

// Resolve the front-month MCX contract (e.g. MCX:NATURALGAS26JULFUT) by probing
// the option chain for this month, then the next two.
const MMM = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
export async function resolveMcxFront(base) {
  const now = new Date();
  for (let k = 0; k < 3; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() + k, 1);
    const sym = `MCX:${base}${String(d.getFullYear()).slice(2)}${MMM[d.getMonth()]}FUT`;
    try {
      const r = await getOptionChain(sym, 5);
      if (r.s === "ok" && r.data?.optionsChain?.length) return sym;
    } catch {}
  }
  throw new Error(`Could not resolve front ${base} contract on MCX`);
}

if (process.argv[1] && process.argv[1].endsWith("fyers-oi.js")) {
  // Usage: node fyers-oi.js [symbol]   (alias: NG → front-month MCX natural gas)
  const arg = process.argv[2];
  let symbol = arg || "NSE:NIFTY50-INDEX";
  if (arg && /^(NG|NATGAS|NATURALGAS)$/i.test(arg)) symbol = await resolveMcxFront("NATURALGAS");
  const s = await computeOiSnapshot(symbol);
  const fmt = (n) => n.toLocaleString("en-IN");
  console.log(`${symbol.replace(/^.*:/, "").replace(/-EQ$/, "")} OI Snapshot — expiry ${s.expiry}`);
  console.log(`  Spot:      ${s.spot}`);
  console.log(`  Max Pain:  ${s.maxPain}`);
  console.log(`  PCR:       ${s.pcr}`);
  console.log(`  Top Call OI (resistance):`);
  for (const c of s.topCalls) console.log(`    ${c.strike}  ${fmt(c.oi)}`);
  console.log(`  Top Put OI (support):`);
  for (const p of s.topPuts) console.log(`    ${p.strike}  ${fmt(p.oi)}`);
  if (symbol.includes("NIFTY50")) {
    console.log(``);
    console.log(`REVANCHE v2.9 inputs:`);
    console.log(`  in_40 (PCR)       = ${s.pcr}`);
    console.log(`  in_42 (Max Pain)  = ${s.maxPain}`);
    console.log(`  in_43 (Call Wall) = ${s.callWall}`);
    console.log(`  in_44 (Put Floor) = ${s.putFloor}`);
  }
}
