// High-win-rate mean-reversion candidates on NSE daily bars — head-to-head.
// All long-only, regime-filtered (close > SMA200), buy at signal-day close,
// exit at exit-signal-day close, max-hold cap. Delivery costs (CNC) applied.
//
// Strategies (from Connors/Alvarez/QuantifiedStrategies literature):
//   rsi2      RSI(2) < 10  → exit RSI(2) > 70          (classic Connors)
//   rsi2x     RSI(2) < 5   → exit RSI(2) > 50          (stricter entry, faster exit)
//   cumrsi    RSI(2)+RSI(2)[1] < 35 → exit RSI(2) > 65 (cumulative RSI)
//   ibslow    IBS < 0.15   → exit IBS > 0.8            (IBS mean reversion)
//   dbl7      7-day closing low → exit 7-day closing high (Double 7s)
//   rsi2ibs   RSI(2) < 10 AND IBS < 0.3 → exit RSI(2) > 65 (combo)
//
//   node backtest-meanrev.js [years] [maxHold]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "6");
const MAX_HOLD = parseInt(process.argv[3] || "10", 10);
const COST_RT = parseFloat(process.env.COST_RT || "0.25") / 100; // CNC delivery round trip

const UNIVERSE = (process.env.UNIVERSE ? process.env.UNIVERSE.split(",") : [
  "NSE:RELIANCE-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:SBIN-EQ",
  "NSE:AXISBANK-EQ","NSE:LT-EQ","NSE:ITC-EQ","NSE:KOTAKBANK-EQ",
  "NSE:BHARTIARTL-EQ","NSE:MARUTI-EQ","NSE:TITAN-EQ","NSE:BAJFINANCE-EQ",
  "NSE:ASIANPAINT-EQ","NSE:SUNPHARMA-EQ","NSE:NTPC-EQ","NSE:TATASTEEL-EQ",
  "NSE:HINDUNILVR-EQ","NSE:M&M-EQ","NSE:POWERGRID-EQ","NSE:COALINDIA-EQ",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dailyBars(sym, years) {
  const out = []; const now = new Date(); const totalDays = Math.ceil(years * 365);
  for (let off = totalDays; off > 0; off -= 360) {
    const to = new Date(now.getTime() - (off - 360 > 0 ? off - 360 : 0) * 86400000);
    const from = new Date(now.getTime() - off * 86400000);
    const q = new URLSearchParams({ symbol: sym, resolution: "D", date_format: "1",
      range_from: from.toISOString().slice(0, 10), range_to: to.toISOString().slice(0, 10), cont_flag: "1" });
    const res = await fetch(`https://api-t1.fyers.in/data/history?${q}`, { headers: {
      Authorization: `${process.env.FYERS_APP_ID}:${process.env.FYERS_ACCESS_TOKEN}` } });
    const d = await res.json();
    (d.candles || []).forEach((c) => out.push({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], vol: c[5] }));
    await sleep(200);
  }
  const m = new Map(); out.forEach((b) => m.set(b.ts, b));
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

function wilderRSI(c, len) {
  const out = Array(c.length).fill(NaN);
  let ag = 0, al = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], g = Math.max(d, 0), l = Math.max(-d, 0);
    if (i <= len) { ag += g; al += l; if (i === len) { ag /= len; al /= len; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } }
    else { ag = (ag * (len - 1) + g) / len; al = (al * (len - 1) + l) / len; out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
  }
  return out;
}
const smaArr = (a, len) => a.map((_, i) => i < len - 1 ? NaN : a.slice(i - len + 1, i + 1).reduce((x, y) => x + y, 0) / len);

// Strategy defs: entry(i, ctx) / exit(i, ctx) evaluated on bar i's close.
const STRATS = {
  rsi2:    { entry: (i, c) => c.rsi2[i] < 10, exit: (i, c) => c.rsi2[i] > 70 },
  rsi2x:   { entry: (i, c) => c.rsi2[i] < 5,  exit: (i, c) => c.rsi2[i] > 50 },
  cumrsi:  { entry: (i, c) => c.rsi2[i] + c.rsi2[i - 1] < 35, exit: (i, c) => c.rsi2[i] > 65 },
  ibslow:  { entry: (i, c) => c.ibs[i] < 0.15, exit: (i, c) => c.ibs[i] > 0.8 },
  dbl7:    { entry: (i, c) => c.close[i] === Math.min(...c.close.slice(i - 6, i + 1)),
             exit:  (i, c) => c.close[i] === Math.max(...c.close.slice(i - 6, i + 1)) },
  rsi2ibs: { entry: (i, c) => c.rsi2[i] < 10 && c.ibs[i] < 0.3, exit: (i, c) => c.rsi2[i] > 65 },
};

function runSymbol(bars, stratName) {
  const close = bars.map((b) => b.close);
  const ctx = {
    close,
    rsi2: wilderRSI(close, 2),
    ibs: bars.map((b) => (b.close - b.low) / ((b.high - b.low) || 1)),
    sma200: smaArr(close, 200),
  };
  const st = STRATS[stratName];
  const trades = [];
  let inPos = false, entryPx = 0, entryIdx = 0;
  for (let i = 205; i < bars.length; i++) {
    if (!inPos) {
      if (close[i] > ctx.sma200[i] && st.entry(i, ctx)) { inPos = true; entryPx = close[i]; entryIdx = i; }
    } else {
      const held = i - entryIdx;
      if (st.exit(i, ctx) || held >= MAX_HOLD || i === bars.length - 1) {
        trades.push({ date: new Date(bars[i].ts * 1000).toISOString().slice(0, 10),
          ret: (close[i] - entryPx) / entryPx - COST_RT, hold: held });
        inPos = false;
      }
    }
  }
  return trades;
}

function stats(tr) {
  const n = tr.length;
  if (!n) return { n: 0 };
  const r = tr.map((t) => t.ret);
  const w = r.filter((x) => x > 0).length;
  const gp = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const worst = Math.min(...r);
  return { n, winRate: w / n, avg: r.reduce((a, b) => a + b, 0) / n, tot: r.reduce((a, b) => a + b, 0),
    pf: gl ? gp / gl : Infinity, avgHold: tr.reduce((a, t) => a + t.hold, 0) / n, worst };
}

const fmt = (s) => s.n
  ? `n ${String(s.n).padStart(4)}  win ${(s.winRate * 100).toFixed(1)}%  avg ${s.avg >= 0 ? "+" : ""}${(s.avg * 100).toFixed(3)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}  hold ${s.avgHold.toFixed(1)}d  worst ${(s.worst * 100).toFixed(1)}%`
  : "no trades";

async function main() {
  console.log(`\n🔬 Mean-reversion shootout — ${YEARS}y daily | regime close>SMA200 | maxHold ${MAX_HOLD}d | cost ${(COST_RT * 100).toFixed(2)}%/RT | ${UNIVERSE.length} symbols\n`);
  const data = [];
  for (const sym of UNIVERSE) {
    try { data.push({ sym, bars: await dailyBars(sym, YEARS) }); }
    catch (e) { console.log(`  ${sym} err ${e.message.slice(0, 50)}`); }
  }
  console.log(`Fetched ${data.length} symbols (${data[0]?.bars.length ?? 0} bars each approx)\n`);
  for (const name of Object.keys(STRATS)) {
    const all = [];
    for (const { sym, bars } of data) {
      const tr = runSymbol(bars, name);
      tr.forEach((t) => (t.sym = sym));
      all.push(...tr);
    }
    all.sort((a, b) => a.date.localeCompare(b.date));
    const cut = Math.floor(all.length * 0.7);
    console.log(`${name.padEnd(8)} ALL  ${fmt(stats(all))}`);
    console.log(`         IS   ${fmt(stats(all.slice(0, cut)))}`);
    console.log(`         OOS  ${fmt(stats(all.slice(cut)))}\n`);
  }
}

main();
