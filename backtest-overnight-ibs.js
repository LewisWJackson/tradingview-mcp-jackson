// Backtest for the ON-EDGE overnight strategy on the underlying stock:
// entry signal = daily IBS >= 0.7 AND close > 200-day SMA, "hold" = buy at
// today's close, sell at tomorrow's open. This is the same signal
// fyers-paper-overnight.js trades via options — this script checks whether
// the underlying stock itself has historically shown a directional edge on
// that signal (no option costs/spread modeled — that's a separate,
// stricter check done live in the paper log).
//
//   node backtest-overnight-ibs.js <STOCK> <years>
const STOCK = (process.argv[2] || "DIVISLAB").toUpperCase();
const YEARS = parseFloat(process.argv[3] || "5");

// .env is loaded automatically by importing fyers-client.js for its side effect.
import "./fyers-client.js";

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
  }
  const m = new Map(); out.forEach((b) => m.set(b.ts, b));
  return [...m.values()].sort((a, b) => a.ts - b.ts);
}

function stats(rets) {
  const n = rets.length;
  const w = rets.filter((x) => x > 0).length;
  const gp = rets.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const gl = -rets.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const tot = rets.reduce((a, b) => a + b, 0);
  return { n, winRate: n ? w / n : 0, avg: n ? tot / n : 0, tot, pf: gl ? gp / gl : Infinity };
}

async function main() {
  const sym = `NSE:${STOCK}-EQ`;
  console.log(`\n🔬 Overnight IBS backtest — ${sym} | ${YEARS}y | signal: IBS>=0.7 & close>SMA200 | hold: close→next open\n`);
  const bars = await dailyBars(sym, YEARS);
  if (bars.length < 210) { console.log(`Not enough history (${bars.length} bars).`); return; }
  const c = bars.map((b) => b.close);
  const rets = [];
  const trades = [];
  for (let i = 200; i < bars.length - 1; i++) {
    const sma = c.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
    const t = bars[i];
    const ibs = (t.close - t.low) / ((t.high - t.low) || 1);
    if (ibs >= 0.7 && t.close > sma) {
      const next = bars[i + 1];
      const ret = (next.open - t.close) / t.close;
      rets.push(ret);
      trades.push({ date: new Date(t.ts * 1000).toISOString().slice(0, 10), ibs: +ibs.toFixed(3), close: t.close, nextOpen: next.open, ret: +(ret * 100).toFixed(3) });
    }
  }
  const s = stats(rets);
  console.log(`Trades: ${s.n}`);
  if (s.n) {
    console.log(`Win rate:   ${(s.winRate * 100).toFixed(0)}%`);
    console.log(`Avg/trade:  ${s.avg >= 0 ? "+" : ""}${(s.avg * 100).toFixed(3)}%`);
    console.log(`Total:      ${s.tot >= 0 ? "+" : ""}${(s.tot * 100).toFixed(2)}%`);
    console.log(`Profit factor: ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}`);
    console.log(`\nLast 10 trades:`);
    trades.slice(-10).forEach((t) => console.log(`  ${t.date}  IBS ${t.ibs}  close ${t.close} → open ${t.nextOpen}  ${t.ret >= 0 ? "+" : ""}${t.ret}%`));
  }
}

main();
