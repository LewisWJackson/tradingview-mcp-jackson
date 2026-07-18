// Intraday momentum tests on NSE 15m bars — all positions closed same day.
// Based on Gao/Han/Li/Zhou "Market Intraday Momentum" (JFE 2018): the first
// 30-min return predicts the last 30-min return. Long-only variants:
//   m1  first30 > 0            → buy 14:45 (close of 14:30 bar), exit 15:15 open
//   m2  day-so-far (o→14:45)>0 → buy 14:45, exit 15:15 open
//   m3  m1 AND m2              → buy 14:45, exit 15:15 open
//   m4  first30 > +0.3%        → buy 09:45 (close of 09:30 bar), exit 15:15 open (trend-day)
//   m5  m3 AND above VWAP      → buy 14:45, exit 15:15 open
//
//   UNIVERSE=... COST_RT=... node backtest-intraday-mom.js [years]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "2");
const COST_RT = parseFloat(process.env.COST_RT || "0.1") / 100;
const UNIVERSE = (process.env.UNIVERSE || [
  "NSE:RELIANCE-EQ","NSE:HDFCBANK-EQ","NSE:ICICIBANK-EQ","NSE:SBIN-EQ",
  "NSE:AXISBANK-EQ","NSE:LT-EQ","NSE:KOTAKBANK-EQ","NSE:BHARTIARTL-EQ",
  "NSE:MARUTI-EQ","NSE:TITAN-EQ","NSE:BAJFINANCE-EQ","NSE:ASIANPAINT-EQ",
  "NSE:NTPC-EQ","NSE:TATASTEEL-EQ","NSE:SUNPHARMA-EQ","NSE:M&M-EQ",
].join(","))
  .split(",");
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
    await sleep(200);
  }
  const m = new Map(); out.forEach((b) => m.set(b.ts, b));
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

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
    .filter((d) => d.bars[0].hhmm === 915 && d.bars.some((b) => b.hhmm === 1515) && d.bars.some((b) => b.hhmm === 1430));
}

function runDay(day, mode) {
  const bs = day.bars;
  const at = (hhmm) => bs.find((b) => b.hhmm === hhmm);
  const b915 = at(915), b930 = at(930), b1430 = at(1430), b1515 = at(1515);
  if (!b930) return null;
  const first30 = (b930.close - b915.open) / b915.open;
  const daySoFar = (b1430.close - b915.open) / b915.open;
  let vwapOK = true;
  if (mode === "m5") {
    let tpv = 0, vol = 0;
    for (const b of bs) { if (b.hhmm > 1430) break; const tp = (b.high + b.low + b.close) / 3; tpv += tp * b.vol; vol += b.vol; }
    vwapOK = vol > 0 ? b1430.close > tpv / vol : false;
  }
  let enter = false, entryPx = b1430.close;
  if (mode === "m1") enter = first30 > 0;
  else if (mode === "m2") enter = daySoFar > 0;
  else if (mode === "m3") enter = first30 > 0 && daySoFar > 0;
  else if (mode === "m4") { enter = first30 > 0.003; entryPx = b930.close; }
  else if (mode === "m5") enter = first30 > 0 && daySoFar > 0 && vwapOK;
  if (!enter) return null;
  return { date: day.date, ret: (b1515.open - entryPx) / entryPx - COST_RT };
}

function stats(tr) {
  const n = tr.length;
  if (!n) return { n: 0 };
  const r = tr.map((t) => t.ret);
  const w = r.filter((x) => x > 0).length;
  const gp = r.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -r.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return { n, winRate: w / n, avg: r.reduce((a, b) => a + b, 0) / n,
    pf: gl ? gp / gl : Infinity, worst: Math.min(...r) };
}
const fmt = (s) => s.n
  ? `n ${String(s.n).padStart(5)}  win ${(s.winRate * 100).toFixed(1)}%  avg ${s.avg >= 0 ? "+" : ""}${(s.avg * 100).toFixed(3)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}  worst ${(s.worst * 100).toFixed(1)}%`
  : "no trades";

async function main() {
  console.log(`\n🔬 Intraday momentum (same-day only) — ${YEARS}y 15m | cost ${(COST_RT * 100).toFixed(2)}%/RT | ${UNIVERSE.length} symbols\n`);
  const data = [];
  for (const sym of UNIVERSE) {
    try { data.push({ sym, days: toDays(await bars15m(sym, YEARS)) }); }
    catch (e) { console.log(`  ${sym} err ${e.message.slice(0, 50)}`); }
  }
  console.log(`Fetched ${data.length} symbols\n`);
  for (const mode of ["m1", "m2", "m3", "m4", "m5"]) {
    const all = [];
    for (const { days } of data) for (const d of days) { const t = runDay(d, mode); if (t) all.push(t); }
    all.sort((a, b) => a.date.localeCompare(b.date));
    const cut = Math.floor(all.length * 0.7);
    console.log(`${mode}  ALL ${fmt(stats(all))}`);
    console.log(`    OOS ${fmt(stats(all.slice(cut)))}\n`);
  }
}

main();
