// Day-type classifier — is today an ORB day? (run at/after 10:00 IST)
// TREND if first-45m efficiency >= 0.6 AND (H45-L45) >= 0.25 x ATR14(D).
// Research 2026-07-13 (BANKNIFTY 15m, 249d): ORB on TREND days 76% win PF 2.46;
// on RANGE days PF 0.93. TREND -> trade ORB per plan; RANGE -> stand down.
//
//   node fyers-daytype.js [SYMBOL]     (default NSE:NIFTYBANK-INDEX)
import { getHistory } from "./fyers-client.js";

const SYM = process.argv[2] || "NSE:NIFTYBANK-INDEX";
const iD = ts => new Date((ts + 330 * 60) * 1000).toISOString().slice(0, 10);
const iM = ts => { const d = new Date((ts + 330 * 60) * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

const daily = await getHistory(SYM, "D", 40);
if (daily.length < 16) { console.log("not enough daily data"); process.exit(1); }
const tr = [];
for (let i = 1; i < daily.length; i++)
  tr.push(Math.max(daily[i].high - daily[i].low, Math.abs(daily[i].high - daily[i - 1].close), Math.abs(daily[i].low - daily[i - 1].close)));
const atr = tr.slice(-15, -1).reduce((a, b) => a + b, 0) / 14;   // prior 14 days

const bars = await getHistory(SYM, "15", 2);
const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const f45 = bars.filter(b => iD(b.ts) === today && iM(b.ts) >= 555 && iM(b.ts) < 600);
if (f45.length < 3) { console.log(`Only ${f45.length}/3 bars of the 9:15-10:00 window — run at/after 10:00 IST.`); process.exit(1); }

const H = Math.max(...f45.map(b => b.high)), L = Math.min(...f45.map(b => b.low));
const eff = Math.abs(f45[2].close - f45[0].open) / ((H - L) || 1);
const rngPct = (H - L) / atr * 100;
const trend = eff >= 0.6 && (H - L) >= 0.25 * atr;

console.log(`\n${SYM.replace("NSE:", "")} — ${today}`);
console.log(`  eff ${eff.toFixed(2)} (need ≥0.60) · 45m range ${(H - L).toFixed(0)}pts = ${rngPct.toFixed(0)}% of ATR (need ≥25%)`);
console.log(`  OR15: H ${f45[0].high} / L ${f45[0].low}`);
console.log(trend
  ? `\n🔥 TREND DAY — ORB ACTIVE. Trade the ORB signal per its plan (verified: 76% win, PF 2.46 on trend days).\n`
  : `\n😴 RANGE DAY — STAND DOWN. ORB has no edge today (PF 0.93 on range days). No trade is the trade.\n`);
