// REVANCHE loss-attribution study — institutional style.
// Replicates the v2.7 intraday momentum model (both sides) + overnight module
// on NIFTY 15m, then attributes P&L by SIDE (CE long / PE short) and by MONTH,
// so losing periods can be mapped to macro events.
//   node backtest-revanche-attrib.js [years]
// Gates replicated: kill zones, trend (EMA200), VWAP side + <=0.5% distance,
// ADX>=25, EMA9/21 cross or ORB-30 break trigger, SL 1.8*ATR, TP 2R,
// EMA-cross exit, EOD close. VIX gate omitted (no reliable VIX history via
// Fyers) — noted as a caveat, it mostly trims trade count, not direction.
import "./fyers-client.js";

const YEARS = parseFloat(process.argv[2] || "4");
const COST_RT = 0.0002; // 0.02% RT on index points (approximates TV run)

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
    return { ...b, d: ist.toISOString().slice(0, 10), mo: ist.toISOString().slice(0, 7),
      hhmm: ist.getUTCHours() * 100 + ist.getUTCMinutes() };
  });
}

const ema = (a, len) => { const k = 2 / (len + 1); let e = a[0]; return a.map((v) => (e = v * k + e * (1 - k))); };

// Wilder DMI/ADX
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
  console.log(`\n🔬 REVANCHE attribution — NIFTY 15m, ${YEARS}y | side + monthly breakdown\n`);
  const bars = await bars15m("NSE:NIFTY50-INDEX", YEARS);
  const c = bars.map((b) => b.close);
  const e9 = ema(c, 9), e21 = ema(c, 21), e200 = ema(c, 200);
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  const atr = ema(tr, 14);
  const adx = adxArr(bars, 14);
  // session TWAP (index has no volume — matches ta.vwap on index)
  const vwap = Array(bars.length); let cum = 0, cnt = 0, day = "";
  bars.forEach((b, i) => { if (b.d !== day) { day = b.d; cum = 0; cnt = 0; } cum += (b.high + b.low + b.close) / 3; cnt += 1; vwap[i] = cum / cnt; });
  // ORB 30-min per day
  const orb = new Map();
  for (const b of bars) {
    if (!orb.has(b.d)) orb.set(b.d, { h: -Infinity, l: Infinity });
    if (b.hhmm >= 915 && b.hhmm < 945) { const o = orb.get(b.d); o.h = Math.max(o.h, b.high); o.l = Math.min(o.l, b.low); }
  }

  const trades = [];
  let pos = 0, entry = 0, sl = 0, tp = 0, entryD = "", entryMo = "";
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
      let ret = null, why = "";
      if (b.d !== entryD) { ret = pos * (bars[i - 1].close - entry) / entry; why = "carry?"; } // safety, shouldn't happen
      else if (pos > 0 && b.low <= sl) { ret = (sl - entry) / entry; why = "SL"; }
      else if (pos < 0 && b.high >= sl) { ret = (entry - sl) / entry; why = "SL"; }
      else if (pos > 0 && b.high >= tp) { ret = (tp - entry) / entry; why = "TP"; }
      else if (pos < 0 && b.low <= tp) { ret = (entry - tp) / entry; why = "TP"; }
      else if (pos > 0 && xDn) { ret = (b.close - entry) / entry; why = "EMAx"; }
      else if (pos < 0 && xUp) { ret = (entry - b.close) / entry; why = "EMAx"; }
      else if (b.hhmm >= 1500) { ret = pos * (b.close - entry) / entry; why = "EOD"; }
      if (ret !== null) {
        trades.push({ mo: entryMo, side: pos > 0 ? "CE" : "PE", ret: ret - COST_RT, why });
        pos = 0;
      }
      continue;
    }
    if (!inKZ || b.hhmm >= 1445 || adx[i] < 25) continue;
    const longSig = (xUp || orbUp) && b.close > e200[i] && b.close > vwap[i] && vd <= 0.5;
    const shortSig = (xDn || orbDn) && b.close < e200[i] && b.close < vwap[i] && vd <= 0.5;
    if (longSig) { pos = 1; entry = b.close; sl = entry - 1.8 * atr[i]; tp = entry + 2 * 1.8 * atr[i]; entryD = b.d; entryMo = b.mo; }
    else if (shortSig) { pos = -1; entry = b.close; sl = entry + 1.8 * atr[i]; tp = entry - 2 * 1.8 * atr[i]; entryD = b.d; entryMo = b.mo; }
  }

  const st = (rr) => {
    const n = rr.length; if (!n) return { n: 0 };
    const w = rr.filter((x) => x.ret > 0).length;
    const gp = rr.filter((x) => x.ret > 0).reduce((a, b) => a + b.ret, 0);
    const gl = -rr.filter((x) => x.ret < 0).reduce((a, b) => a + b.ret, 0);
    return { n, win: w / n, tot: rr.reduce((a, b) => a + b.ret, 0), pf: gl ? gp / gl : Infinity };
  };
  const fmt = (s) => s.n ? `n ${String(s.n).padStart(4)}  win ${(s.win * 100).toFixed(0)}%  total ${(s.tot * 100).toFixed(2)}%  PF ${s.pf === Infinity ? "∞" : s.pf.toFixed(2)}` : "no trades";

  console.log("═══ SIDE ATTRIBUTION (intraday module) ═══");
  console.log(`  ALL     ${fmt(st(trades))}`);
  console.log(`  CE/long ${fmt(st(trades.filter((t) => t.side === "CE")))}`);
  console.log(`  PE/short${fmt(st(trades.filter((t) => t.side === "PE")))}`);

  console.log("\n═══ MONTHLY P&L (intraday, % sum | CE / PE split) ═══");
  const months = [...new Set(trades.map((t) => t.mo))].sort();
  const losers = [];
  for (const mo of months) {
    const mt = trades.filter((t) => t.mo === mo);
    const ce = st(mt.filter((t) => t.side === "CE")), pe = st(mt.filter((t) => t.side === "PE"));
    const tot = st(mt).tot;
    if (tot < -0.005) losers.push({ mo, tot });
    console.log(`  ${mo}  ${(tot * 100) >= 0 ? "+" : ""}${(tot * 100).toFixed(2)}%  (CE ${ce.n ? (ce.tot * 100).toFixed(2) : "—"} / PE ${pe.n ? (pe.tot * 100).toFixed(2) : "—"})  ${tot < -0.005 ? "🔴" : tot > 0.005 ? "🟢" : ""}`);
  }

  // Overnight module monthly (IBS>=0.8+green+SMA200, close->next open) — daily calc
  const dayMap = new Map();
  for (const b of bars) { if (!dayMap.has(b.d)) dayMap.set(b.d, []); dayMap.get(b.d).push(b); }
  const dl = [...dayMap.entries()].map(([d, bs]) => {
    bs.sort((a, b) => a.ts - b.ts);
    return { d, mo: d.slice(0, 7), o: bs[0].open, h: Math.max(...bs.map(x => x.high)), l: Math.min(...bs.map(x => x.low)), c: bs[bs.length - 1].close, nextO: null };
  }).filter(x => dayMap.get(x.d)[0].hhmm === 915);
  for (let i = 0; i < dl.length - 1; i++) dl[i].nextO = dl[i + 1].o;
  const dcl = dl.map(x => x.c);
  const onTrades = [];
  for (let i = 200; i < dl.length - 1; i++) {
    const sma = dcl.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
    const t = dl[i], ibs = (t.c - t.l) / ((t.h - t.l) || 1);
    if (ibs >= 0.8 && t.c > t.o && t.c > sma) onTrades.push({ mo: t.mo, ret: (t.nextO - t.c) / t.c - COST_RT });
  }
  console.log("\n═══ MONTHLY P&L (🌙 overnight module) ═══");
  const onMonths = [...new Set(onTrades.map((t) => t.mo))].sort();
  for (const mo of onMonths) {
    const mt = onTrades.filter((t) => t.mo === mo);
    const s = st(mt.map(r => ({ ret: r.ret })));
    console.log(`  ${mo}  ${(s.tot * 100) >= 0 ? "+" : ""}${(s.tot * 100).toFixed(2)}%  (${s.n} tr, ${(s.win * 100).toFixed(0)}% win)  ${s.tot < -0.003 ? "🔴" : s.tot > 0.003 ? "🟢" : ""}`);
  }
  console.log(`\n  Overnight ALL: ${fmt(st(onTrades.map(r => ({ ret: r.ret }))))}`);
  console.log(`\nWorst intraday months: ${losers.sort((a, b) => a.tot - b.tot).slice(0, 6).map(l => `${l.mo} (${(l.tot * 100).toFixed(2)}%)`).join(", ")}`);
}

main();
