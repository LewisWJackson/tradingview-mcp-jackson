// Gate-removal sensitivity study — which REVANCHE hard gates earn their place?
// Reruns the intraday model on NIFTY 15m dropping ONE gate at a time.
// Decision rule (pre-specified): a gate is removed in v2.9 only if dropping it
// improves BOTH halves (or improves OOS without wrecking IS). Also reports
// whether each variant captures the missed 2026-07-03 afternoon PE trade.
//   node backtest-gate-sensitivity.js [years]
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "4");
const COST_RT = 0.0002;

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
    (d.candles || []).forEach((c) => out.push({ ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4] }));
    await new Promise((r) => setTimeout(r, 200));
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

function run(bars, ind, gates) {
  const { e9, e21, e200, atr, adx, vwap, orb, bias } = ind;
  const trades = [];
  let pos = 0, entry = 0, sl = 0, tp = 0, entryD = "";
  for (let i = 300; i < bars.length; i++) {
    const b = bars[i];
    if (pos !== 0) {
      let ret = null;
      const xUp = e9[i] > e21[i] && e9[i - 1] <= e21[i - 1];
      const xDn = e9[i] < e21[i] && e9[i - 1] >= e21[i - 1];
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
    const inWindow = gates.kz
      ? ((b.hhmm >= 945 && b.hhmm <= 1130) || (b.hhmm >= 1330 && b.hhmm <= 1500)) && b.hhmm < 1445
      : b.hhmm >= 945 && b.hhmm < 1445;
    if (!inWindow) continue;
    if (gates.adx && adx[i] < 25) continue;
    const o = orb.get(b.d);
    const orbUp = o && b.close > o.h && bars[i - 1].close <= o.h;
    const orbDn = o && b.close < o.l && bars[i - 1].close >= o.l;
    const xUp = e9[i] > e21[i] && e9[i - 1] <= e21[i - 1];
    const xDn = e9[i] < e21[i] && e9[i - 1] >= e21[i - 1];
    const vd = Math.abs(b.close - vwap[i]) / vwap[i] * 100;
    let longSig = (xUp || orbUp) && b.close > vwap[i] && vd <= 0.5;
    let shortSig = (xDn || orbDn) && b.close < vwap[i] && vd <= 0.5;
    if (gates.trend) { longSig = longSig && b.close > e200[i]; shortSig = shortSig && b.close < e200[i]; }
    if (gates.htf)   { longSig = longSig && bias[i] >= 0;      shortSig = shortSig && bias[i] <= 0; }
    if (longSig) { pos = 1; entry = b.close; sl = entry - 1.8 * atr[i]; tp = entry + 3.6 * atr[i]; entryD = b.d; }
    else if (shortSig) { pos = -1; entry = b.close; sl = entry + 1.8 * atr[i]; tp = entry - 3.6 * atr[i]; entryD = b.d; }
  }
  return trades;
}

const st = (rr) => {
  const n = rr.length; if (!n) return { n: 0, win: 0, tot: 0, pf: 0 };
  const w = rr.filter((x) => x.ret > 0).length;
  const gp = rr.filter((x) => x.ret > 0).reduce((a, b) => a + b.ret, 0);
  const gl = -rr.filter((x) => x.ret < 0).reduce((a, b) => a + b.ret, 0);
  return { n, win: w / n, tot: rr.reduce((a, b) => a + b.ret, 0), pf: gl ? gp / gl : Infinity };
};
const fmt = (s) => s.n ? `n ${String(s.n).padStart(4)} win ${(s.win * 100).toFixed(0)}% tot ${(s.tot * 100).toFixed(2).padStart(6)}% PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}` : "no trades   ";

async function main() {
  console.log(`\n🔬 Gate-removal sensitivity — NIFTY 15m, ${YEARS}y (split-sample)\n`);
  const bars = await bars15m("NSE:NIFTY50-INDEX", YEARS);
  const c = bars.map((b) => b.close);
  const ind = {
    e9: ema(c, 9), e21: ema(c, 21), e200: ema(c, 200),
    atr: null, adx: adxArr(bars, 14), vwap: Array(bars.length), orb: new Map(), bias: [],
  };
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  ind.atr = ema(tr, 14);
  let cum = 0, cnt = 0, day = "";
  bars.forEach((b, i) => { if (b.d !== day) { day = b.d; cum = 0; cnt = 0; } cum += (b.high + b.low + b.close) / 3; cnt += 1; ind.vwap[i] = cum / cnt; });
  for (const b of bars) {
    if (!ind.orb.has(b.d)) ind.orb.set(b.d, { h: -Infinity, l: Infinity });
    if (b.hhmm >= 915 && b.hhmm < 945) { const o = ind.orb.get(b.d); o.h = Math.max(o.h, b.high); o.l = Math.min(o.l, b.low); }
  }
  let sb = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 40) {
      const hi = Math.max(...bars.slice(i - 40, i).map((b) => b.high)), lo = Math.min(...bars.slice(i - 40, i).map((b) => b.low));
      if (bars[i].close > hi) sb = 1;
      if (bars[i].close < lo) sb = -1;
    }
    ind.bias.push(sb);
  }

  const variants = [
    ["V0 baseline (all gates)",    { kz: true,  adx: true,  trend: true,  htf: true }],
    ["V1 no kill zones",           { kz: false, adx: true,  trend: true,  htf: true }],
    ["V2 no 1H bias gate",         { kz: true,  adx: true,  trend: true,  htf: false }],
    ["V3 no EMA200 trend gate",    { kz: true,  adx: true,  trend: false, htf: true }],
    ["V4 no ADX gate",             { kz: true,  adx: false, trend: true,  htf: true }],
    ["V5 no KZ + no 1H bias",      { kz: false, adx: true,  trend: true,  htf: false }],
    ["V6 no KZ + no ADX",          { kz: false, adx: false, trend: true,  htf: true }],
    ["V7 minimal (trend only)",    { kz: false, adx: false, trend: true,  htf: false }],
    ["V8 counter-trend allowed",   { kz: true,  adx: true,  trend: false, htf: false }],
    ["V9 triggers+VWAP only",      { kz: false, adx: false, trend: false, htf: false }],
  ];
  console.log("variant                      IN-SAMPLE (older half)                OUT-OF-SAMPLE (recent half)          Jul-3 PE?");
  for (const [name, g] of variants) {
    const t = run(bars, ind, g);
    const half = Math.floor(t.length / 2);
    const fri = t.filter((x) => x.d === "2026-07-03" && x.side === "PE");
    console.log(`${name.padEnd(27)}  ${fmt(st(t.slice(0, half)))}   |   ${fmt(st(t.slice(half)))}   ${fri.length ? "✅ " + fri.map((x) => (x.ret * 100).toFixed(2) + "%").join(",") : "—"}`);
  }
  // side split for the most promising variants gets printed by rerunning below if needed
}

main();
