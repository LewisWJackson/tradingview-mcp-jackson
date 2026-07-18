// VIX-spike filter test for the REVANCHE intraday model — honest, split-sample.
// Hypothesis (formed from macro attribution, mechanism-based): event-shock
// days produce gap-and-reverse chop that kills momentum entries. Proxy:
// India VIX rising. Filter uses ONLY information available before entry:
//   F1: skip day if YESTERDAY'S VIX close rose >5% over the day before
//   F2: skip day if yesterday's VIX close > 20 (panic regime)
//   F3: F1 or F2
// Reported in-sample (first half) and out-of-sample (second half) separately.
//   node backtest-vix-filter.js [years]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "4");
const COST_RT = 0.0002;

async function fetchBars(sym, res, years, chunk) {
  const out = []; const now = new Date(); const totalDays = Math.ceil(years * 365);
  for (let off = totalDays; off > 0; off -= chunk) {
    const to = new Date(now.getTime() - (off - chunk > 0 ? off - chunk : 0) * 86400000);
    const from = new Date(now.getTime() - off * 86400000);
    const q = new URLSearchParams({ symbol: sym, resolution: res, date_format: "1",
      range_from: from.toISOString().slice(0, 10), range_to: to.toISOString().slice(0, 10), cont_flag: "1" });
    const r = await fetch(`https://api-t1.fyers.in/data/history?${q}`, { headers: {
      Authorization: `${process.env.FYERS_APP_ID}:${process.env.FYERS_ACCESS_TOKEN}` } });
    const d = await r.json();
    (d.candles || []).forEach((c) => out.push({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
    await new Promise((rs) => setTimeout(rs, 200));
  }
  const m = new Map(); out.forEach((b) => m.set(b.ts, b));
  return [...m.values()].sort((a, b) => a.ts - b.ts).map((b) => {
    const ist = new Date((b.ts + 330 * 60) * 1000);
    return { ...b, d: ist.toISOString().slice(0, 10), hhmm: ist.getUTCHours() * 100 + ist.getUTCMinutes() };
  });
}

const ema = (a, len) => { const k = 2 / (len + 1); let e = a[0]; return a.map((v) => (e = v * k + e * (1 - k))); };
function adxArr(bars, len) {
  const n = bars.length, tr = [0], pdm = [0], ndm = [0];
  for (let i = 1; i < n; i++) {
    const up = bars[i].high - bars[i - 1].high, dn = bars[i - 1].low - bars[i].low;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  const rma = (a) => { const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push((o[i - 1] * (len - 1) + a[i]) / len); return o; };
  const trS = rma(tr), pS = rma(pdm), nS = rma(ndm);
  const dx = trS.map((t, i) => { const p = t ? 100 * pS[i] / t : 0, q = t ? 100 * nS[i] / t : 0; const s = p + q; return s ? 100 * Math.abs(p - q) / s : 0; });
  return rma(dx);
}

async function main() {
  console.log(`\n🔬 VIX-spike filter test — REVANCHE intraday on NIFTY 15m, ${YEARS}y\n`);
  const bars = await fetchBars("NSE:NIFTY50-INDEX", "15", YEARS, 90);
  const vixD = await fetchBars("NSE:INDIAVIX-INDEX", "D", YEARS + 0.2, 360);
  // per-day: yesterday's VIX close + its day-over-day change (known pre-open)
  const vixInfo = new Map();
  for (let i = 2; i < vixD.length; i++) {
    const chg = (vixD[i - 1].close - vixD[i - 2].close) / vixD[i - 2].close * 100;
    vixInfo.set(vixD[i].d, { prevClose: vixD[i - 1].close, prevChg: chg });
  }

  const c = bars.map((b) => b.close);
  const e9 = ema(c, 9), e21 = ema(c, 21), e200 = ema(c, 200);
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  const atr = ema(tr, 14);
  const adx = adxArr(bars, 14);
  const vwap = Array(bars.length); let cum = 0, cnt = 0, day = "";
  bars.forEach((b, i) => { if (b.d !== day) { day = b.d; cum = 0; cnt = 0; } cum += (b.high + b.low + b.close) / 3; cnt += 1; vwap[i] = cum / cnt; });
  const orb = new Map();
  for (const b of bars) {
    if (!orb.has(b.d)) orb.set(b.d, { h: -Infinity, l: Infinity });
    if (b.hhmm >= 915 && b.hhmm < 945) { const o = orb.get(b.d); o.h = Math.max(o.h, b.high); o.l = Math.min(o.l, b.low); }
  }

  const trades = [];
  let pos = 0, entry = 0, sl = 0, tp = 0, entryD = "";
  for (let i = 300; i < bars.length; i++) {
    const b = bars[i];
    const inKZ = (b.hhmm >= 945 && b.hhmm <= 1130) || (b.hhmm >= 1330 && b.hhmm <= 1500);
    const o = orb.get(b.d);
    const orbUp = b.hhmm >= 945 && o && b.close > o.h && bars[i - 1].close <= o.h;
    const orbDn = b.hhmm >= 945 && o && b.close < o.l && bars[i - 1].close >= o.l;
    const xUp = e9[i] > e21[i] && e9[i - 1] <= e21[i - 1];
    const xDn = e9[i] < e21[i] && e9[i - 1] >= e21[i - 1];
    const vd = Math.abs(b.close - vwap[i]) / vwap[i] * 100;
    if (pos !== 0) {
      let ret = null;
      if (pos > 0 && b.low <= sl) ret = (sl - entry) / entry;
      else if (pos < 0 && b.high >= sl) ret = (entry - sl) / entry;
      else if (pos > 0 && b.high >= tp) ret = (tp - entry) / entry;
      else if (pos < 0 && b.low <= tp) ret = (entry - tp) / entry;
      else if (pos > 0 && xDn) ret = (b.close - entry) / entry;
      else if (pos < 0 && xUp) ret = (entry - b.close) / entry;
      else if (b.hhmm >= 1500) ret = pos * (b.close - entry) / entry;
      if (ret !== null) { trades.push({ d: entryD, side: pos > 0 ? "CE" : "PE", ret: ret - COST_RT }); pos = 0; }
      continue;
    }
    if (!inKZ || b.hhmm >= 1445 || adx[i] < 25) continue;
    const longSig = (xUp || orbUp) && b.close > e200[i] && b.close > vwap[i] && vd <= 0.5;
    const shortSig = (xDn || orbDn) && b.close < e200[i] && b.close < vwap[i] && vd <= 0.5;
    if (longSig) { pos = 1; entry = b.close; sl = entry - 1.8 * atr[i]; tp = entry + 3.6 * atr[i]; entryD = b.d; }
    else if (shortSig) { pos = -1; entry = b.close; sl = entry + 1.8 * atr[i]; tp = entry - 3.6 * atr[i]; entryD = b.d; }
  }

  const st = (rr) => {
    const n = rr.length; if (!n) return { n: 0, win: 0, tot: 0, pf: 0 };
    const w = rr.filter((x) => x.ret > 0).length;
    const gp = rr.filter((x) => x.ret > 0).reduce((a, b) => a + b.ret, 0);
    const gl = -rr.filter((x) => x.ret < 0).reduce((a, b) => a + b.ret, 0);
    return { n, win: w / n, tot: rr.reduce((a, b) => a + b.ret, 0), pf: gl ? gp / gl : Infinity };
  };
  const fmt = (s) => s.n ? `n ${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0)}%  total ${(s.tot * 100).toFixed(2)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}` : "no trades";

  const pass = (t, f) => {
    const v = vixInfo.get(t.d);
    if (!v) return true;                       // no VIX data → keep trade
    if (f === "F1") return v.prevChg <= 5;
    if (f === "F2") return v.prevClose <= 20;
    return v.prevChg <= 5 && v.prevClose <= 20; // F3
  };

  const half = Math.floor(trades.length / 2);
  const IS = trades.slice(0, half), OOS = trades.slice(half);
  console.log("Filter                          IN-SAMPLE (older half)                 OUT-OF-SAMPLE (recent half)");
  for (const [name, f] of [["baseline (no filter)", null], ["F1: skip prevVIX +5%dd", "F1"], ["F2: skip prevVIX > 20", "F2"], ["F3: both", "F3"]]) {
    const a = f ? IS.filter((t) => pass(t, f)) : IS;
    const b = f ? OOS.filter((t) => pass(t, f)) : OOS;
    console.log(`${name.padEnd(28)}  ${fmt(st(a))}   |   ${fmt(st(b))}`);
  }
  // what did the filters remove?
  for (const f of ["F1", "F2", "F3"]) {
    const removed = trades.filter((t) => !pass(t, f));
    const s = st(removed);
    console.log(`\n${f} removed: ${fmt(s)}  ← trades excluded by the filter`);
  }
}

main();
