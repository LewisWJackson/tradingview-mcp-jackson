// Scorecard for the discretionary news-gap trades logged in news-gap-trades.json.
// Same verdict philosophy as the overnight paper log: ~15-20 trades decide
// whether news-gap continuation is a real personal edge or luck.
//   node news-gap-report.js
import { readFileSync } from "fs";

const trades = JSON.parse(readFileSync(new URL("./news-gap-trades.json", import.meta.url), "utf8"));
const n = trades.length;
if (!n) { console.log("No trades logged yet."); process.exit(0); }

const wins = trades.filter((t) => t.pnlRupees > 0);
const gp = wins.reduce((a, t) => a + t.pnlRupees, 0);
const gl = -trades.filter((t) => t.pnlRupees < 0).reduce((a, t) => a + t.pnlRupees, 0);
const tot = trades.reduce((a, t) => a + t.pnlRupees, 0);

console.log(`\n📊 NEWS-GAP TRADE LOG — ${n} trade${n > 1 ? "s" : ""}`);
for (const t of trades)
  console.log(`  #${t.id} ${t.date} ${t.stock.padEnd(11)} ${t.side} gap ${t.preOpenGapPct}%  ${t.pnlRupees >= 0 ? "+" : ""}₹${t.pnlRupees} (${t.pnlPctPremium >= 0 ? "+" : ""}${t.pnlPctPremium}% prem)  [${t.catalystType}]`);
console.log(`\n  Win rate:  ${(wins.length / n * 100).toFixed(0)}%  (${wins.length}/${n})`);
console.log(`  Total P&L: ${tot >= 0 ? "+" : ""}₹${tot}`);
console.log(`  PF:        ${gl ? (gp / gl).toFixed(2) : "∞"}`);
console.log(`  Verdict:   ${n < 15 ? `⏳ need ~${15 - n} more trades for a verdict` : gp / (gl || 1) > 1.5 ? "✅ looks like a real personal edge" : "❌ not clearing the bar — reassess"}\n`);
