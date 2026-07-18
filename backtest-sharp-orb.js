// Backtest of "SHARP-ORB v2 — Stocks-in-Play [NSE]" (Pine indicator) on real
// Fyers 15-min bars. Rules replicated exactly from the Pine source:
//   OR      = first 15m bar of the day (09:15–09:30 IST)
//   In play = OR volume / avg(prior 14 days' OR volume) >= 2.0, OR bar green
//   Entry   = first 15m bar CLOSING above OR high, bar must OPEN before 13:00
//   Stop    = OR low (whole position, never moved)
//   T1      = entry + 0.5 × OR range → book half
//   Runner  = exit at the 15:15 bar open (Pine's eodExit >= 15:10)
//   Same-bar SL+T1 → conservative: SL first (full stop) unless T1 already hit
//
//   node backtest-sharp-orb.js [years] [relVolMin]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "2");
const RELVOL_MIN = parseFloat(process.argv[3] || "2.0");
const RELVOL_LEN = 14;
const TP1_ORF = 0.5;
const ENTRY_CUT = 1300;
const COST_RT = parseFloat(process.env.COST_RT || "0.1") / 100; // intraday MIS round trip + slippage
const GAP_MIN = parseFloat(process.env.GAP_MIN || "0") / 100;   // min |open gap| vs prior close

const UNIVERSE = (process.env.UNIVERSE || [
  "NSE:RELIANCE-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:SBIN-EQ",
  "NSE:AXISBANK-EQ","NSE:LT-EQ","NSE:ITC-EQ","NSE:KOTAKBANK-EQ",
  "NSE:BHARTIARTL-EQ","NSE:MARUTI-EQ","NSE:TITAN-EQ","NSE:BAJFINANCE-EQ",
  "NSE:ASIANPAINT-EQ","NSE:SUNPHARMA-EQ","NSE:NTPC-EQ","NSE:TATASTEEL-EQ",
].join(",")).split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bars15m(sym, years) {
  const out = []; const now = new Date(); const totalDays = Math.ceil(years * 365);
  for (let off = totalDays; off > 0; off -= 90) {
    const to = new Date(now.getTime() - (off - 90 > 0 ? off - 90 : 0) * 86400000);
    const from = new Date(now.getTime() - off * 86400000);
    const q = new URLSearchParams({ symbol: sym, resolution: "15", date_format: "1",
      range_from: from.toISOString().slice(0, 10), range_to: to.toISOString().slice(0, 10), cont_flag: "1" });
    const res = await fetch(`https://api-t1.fyers.in/data/history?${q}`, { headers: {
      Authorization: `${process.env.FYERS_APP_ID}:${process.env.FYERS_ACCESS_TOKEN}` } });
    const d = await res.json();
    (d.candles || []).forEach((c) => out.push({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], vol: c[5] }));
    await sleep(250);
  }
  const m = new Map(); out.forEach((b) => m.set(b.ts, b));
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

// Group into IST trading days; keep only days whose first bar is 09:15.
function toDays(bars) {
  const days = new Map();
  for (const b of bars) {
    const ist = new Date((b.ts + 330 * 60) * 1000);
    const d = ist.toISOString().slice(0, 10);
    const hhmm = ist.getUTCHours() * 100 + ist.getUTCMinutes();
    if (!days.has(d)) days.set(d, []);
    days.get(d).push({ ...b, hhmm });
  }
  return [...days.entries()]
    .map(([date, bs]) => ({ date, bars: bs.sort((a, b) => a.ts - b.ts) }))
    .filter((d) => d.bars[0].hhmm === 915);
}

function runSymbol(days) {
  const trades = [];
  for (let di = RELVOL_LEN; di < days.length; di++) {
    const { date, bars } = days[di];
    const or = bars[0];
    if (or.close < or.open) continue;                       // OR bar must be green
    if (GAP_MIN > 0) {
      const prevBars = days[di - 1].bars;
      const prevClose = prevBars[prevBars.length - 1].close;
      if (Math.abs(or.open - prevClose) / prevClose < GAP_MIN) continue;
    }
    let s = 0;
    for (let k = di - RELVOL_LEN; k < di; k++) s += days[k].bars[0].vol;
    const avg = s / RELVOL_LEN;
    const relVol = avg > 0 ? or.vol / avg : 0;
    if (relVol < RELVOL_MIN) continue;                      // not in play
    const orHigh = or.high, orLow = or.low, orRange = orHigh - orLow;
    if (orRange <= 0) continue;

    // find entry: first bar after OR closing above OR high, opening before cutoff
    let ei = -1;
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].hhmm >= ENTRY_CUT) break;
      if (bars[i].close > orHigh) { ei = i; break; }
      if (bars[i].low <= orLow) { /* OR low broken first — still allowed by Pine (no invalidation), keep scanning */ }
    }
    if (ei < 0) continue;

    const entry = bars[ei].close;
    const sl = orLow, t1 = entry + orRange * TP1_ORF;
    const rps = entry - sl;                                 // risk per share
    let t1Done = false, ret = null, outcome = "";
    for (let i = ei + 1; i < bars.length; i++) {
      const b = bars[i];
      if (b.hhmm >= 1510) {                                 // EOD runner exit at bar open
        const rem = t1Done ? 0.5 : 1.0;
        ret = (t1Done ? 0.5 * (t1 - entry) : 0) + rem * (b.open - entry);
        outcome = t1Done ? "T1+EOD" : "EOD";
        break;
      }
      const hitSL = b.low <= sl, hitT1 = !t1Done && b.high >= t1;
      if (hitSL) {                                          // conservative: SL before T1 in same bar
        const rem = t1Done ? 0.5 : 1.0;
        ret = (t1Done ? 0.5 * (t1 - entry) : 0) + rem * (sl - entry);
        outcome = t1Done ? "T1+SL" : "SL";
        break;
      }
      if (hitT1) t1Done = true;
    }
    if (ret === null) {                                     // no 15:15 bar (short day) — exit last close
      const rem = t1Done ? 0.5 : 1.0;
      ret = (t1Done ? 0.5 * (t1 - entry) : 0) + rem * (bars[bars.length - 1].close - entry);
      outcome = "LASTBAR";
    }
    const retPct = ret / entry - COST_RT;
    trades.push({ date, entry, sl, t1, relVol: +relVol.toFixed(2), outcome,
      retPct, rMult: ret / rps });
  }
  return trades;
}

function stats(trades) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const r = trades.map((t) => t.retPct);
  const w = r.filter((x) => x > 0).length;
  const gp = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const avgR = trades.reduce((a, t) => a + t.rMult, 0) / n;
  return { n, winRate: w / n, avg: r.reduce((a, b) => a + b, 0) / n,
    tot: r.reduce((a, b) => a + b, 0), pf: gl ? gp / gl : Infinity, avgR };
}

async function main() {
  console.log(`\n🔬 SHARP-ORB v2 backtest — ${YEARS}y | relVol>=${RELVOL_MIN} | 15m OR | CC entry <13:00 | SL=OR low | T1=0.5×OR book ½ | EOD 15:10 | cost ${(COST_RT*100).toFixed(2)}%/RT\n`);
  const all = [];
  const perSym = [];
  for (const sym of UNIVERSE) {
    try {
      const bars = await bars15m(sym, YEARS);
      const days = toDays(bars);
      const trades = runSymbol(days);
      trades.forEach((t) => (t.sym = sym));
      all.push(...trades);
      const s = stats(trades);
      perSym.push({ sym, ...s });
      console.log(`  ${sym.replace("NSE:", "").replace("-EQ", "").padEnd(12)} days ${String(days.length).padStart(4)}  trades ${String(s.n ?? 0).padStart(3)}${s.n ? `  win ${(s.winRate * 100).toFixed(0)}%  avg ${(s.avg * 100).toFixed(3)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}` : ""}`);
    } catch (e) {
      console.log(`  ${sym.padEnd(18)} err ${e.message.slice(0, 60)}`);
    }
  }
  const s = stats(all);
  console.log(`\n=== PORTFOLIO (net of ${(COST_RT*100).toFixed(2)}% cost/RT) ===`);
  console.log(`Trades:        ${s.n}`);
  console.log(`Win rate:      ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`Avg/trade:     ${s.avg >= 0 ? "+" : ""}${(s.avg * 100).toFixed(3)}%   (avg ${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}R)`);
  console.log(`Total:         ${s.tot >= 0 ? "+" : ""}${(s.tot * 100).toFixed(1)}%`);
  console.log(`Profit factor: ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}`);
  // outcome mix + IS/OOS split
  const mix = {};
  all.forEach((t) => (mix[t.outcome] = (mix[t.outcome] || 0) + 1));
  console.log(`Outcomes:      ${Object.entries(mix).map(([k, v]) => `${k} ${v}`).join("  ")}`);
  const sorted = all.sort((a, b) => a.date.localeCompare(b.date));
  const half = Math.floor(sorted.length / 2);
  const s1 = stats(sorted.slice(0, half)), s2 = stats(sorted.slice(half));
  console.log(`First half:    ${s1.n} trades  win ${(s1.winRate * 100).toFixed(0)}%  avg ${(s1.avg * 100).toFixed(3)}%  PF ${s1.pf === Infinity ? "∞" : s1.pf.toFixed(2)}`);
  console.log(`Second half:   ${s2.n} trades  win ${(s2.winRate * 100).toFixed(0)}%  avg ${(s2.avg * 100).toFixed(3)}%  PF ${s2.pf === Infinity ? "∞" : s2.pf.toFixed(2)}`);
}

main();
