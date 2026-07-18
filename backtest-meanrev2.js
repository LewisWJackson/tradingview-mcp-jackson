// Round 2: the two exit styles that produce the literature's high win rates.
//   A) "first-up" exit: buy weakness at close (RSI2/IBS), exit at the first
//      CLOSE above the PRIOR day's high, max 5 days (Connors-style).
//   B) overnight-only: buy weakness at close, sell next OPEN (1-night hold).
// Regime filter close > SMA200 everywhere. Costs via COST_RT env.
//
//   UNIVERSE=... COST_RT=0.05 node backtest-meanrev2.js [years]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "6");
const COST_RT = parseFloat(process.env.COST_RT || "0.25") / 100;
const UNIVERSE = (process.env.UNIVERSE || "NSE:NIFTY50-INDEX,NSE:NIFTYBANK-INDEX").split(",");
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

const ENTRIES = {
  rsi2lt10:  (i, c) => c.rsi2[i] < 10,
  rsi2lt5:   (i, c) => c.rsi2[i] < 5,
  ibslt015:  (i, c) => c.ibs[i] < 0.15,
  dbl7low:   (i, c) => c.close[i] === Math.min(...c.close.slice(i - 6, i + 1)),
};

function run(bars, entryName, mode) {
  const close = bars.map((b) => b.close);
  const ctx = { close, rsi2: wilderRSI(close, 2),
    ibs: bars.map((b) => (b.close - b.low) / ((b.high - b.low) || 1)),
    sma200: smaArr(close, 200) };
  const entry = ENTRIES[entryName];
  const trades = [];
  let inPos = false, entryPx = 0, entryIdx = 0;
  for (let i = 205; i < bars.length - 1; i++) {
    if (!inPos) {
      if (close[i] > ctx.sma200[i] && entry(i, ctx)) {
        if (mode === "overnight") {
          trades.push({ date: new Date(bars[i].ts * 1000).toISOString().slice(0, 10),
            ret: (bars[i + 1].open - close[i]) / close[i] - COST_RT, hold: 1 });
        } else { inPos = true; entryPx = close[i]; entryIdx = i; }
      }
    } else {
      const held = i - entryIdx;
      const firstUp = close[i] > bars[i - 1].high;
      if (firstUp || held >= 5 || i === bars.length - 2) {
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
  return { n, winRate: w / n, avg: r.reduce((a, b) => a + b, 0) / n,
    pf: gl ? gp / gl : Infinity, worst: Math.min(...r), avgHold: tr.reduce((a, t) => a + t.hold, 0) / n };
}
const fmt = (s) => s.n
  ? `n ${String(s.n).padStart(4)}  win ${(s.winRate * 100).toFixed(1)}%  avg ${s.avg >= 0 ? "+" : ""}${(s.avg * 100).toFixed(3)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}  worst ${(s.worst * 100).toFixed(1)}%`
  : "no trades";

async function main() {
  console.log(`\n🔬 Mean-reversion round 2 — ${YEARS}y | regime>SMA200 | cost ${(COST_RT * 100).toFixed(2)}%/RT | ${UNIVERSE.join(", ")}\n`);
  const data = [];
  for (const sym of UNIVERSE) {
    try { data.push({ sym, bars: await dailyBars(sym, YEARS) }); }
    catch (e) { console.log(`  ${sym} err ${e.message.slice(0, 50)}`); }
  }
  for (const mode of ["firstup", "overnight"]) {
    console.log(`── exit: ${mode === "firstup" ? "first close > prior high (max 5d)" : "next open (1 night)"} ──`);
    for (const en of Object.keys(ENTRIES)) {
      const all = [];
      for (const { bars } of data) all.push(...run(bars, en, mode));
      all.sort((a, b) => a.date.localeCompare(b.date));
      const cut = Math.floor(all.length * 0.7);
      console.log(`  ${en.padEnd(9)} ALL ${fmt(stats(all))}`);
      console.log(`            OOS ${fmt(stats(all.slice(cut)))}`);
    }
    console.log("");
  }
}

main();
