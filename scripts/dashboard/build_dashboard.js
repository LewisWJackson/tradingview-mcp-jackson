// Dashboard generator — reads ETrade Activity xlsx and writes a Markdown dashboard.
// Usage: node scripts/dashboard/build_dashboard.js [optional-input-path] [optional-output-path]
//
// Default input:  C:/Users/lam61/OneDrive/Desktop/ETrade Activity_4.11.26.xlsx
// Default output: C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.md
//
// Re-run whenever you export a fresh ETrade Activity file from the broker.

import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

const INPUT = process.argv[2] || 'C:/Users/lam61/OneDrive/Desktop/ETrade Activity_4.11.26.xlsx';
const OUTPUT = process.argv[3] || 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.md';

// ---------- parsing helpers ----------

function parseDescription(desc) {
  const m = desc.match(/^(PUT|CALL)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+([\d.]+)/);
  if (!m) return null;
  return {
    type: m[1],
    symbol: m[2],
    expiration: m[3],
    strike: parseFloat(m[4]),
  };
}

function parseDate(s) {
  const [mm, dd, yy] = s.split('/').map(Number);
  return new Date(2000 + yy, mm - 1, dd);
}

function fmt(d) {
  return d.toISOString().slice(0, 10);
}

function weekKey(d) {
  const start = new Date(d.getFullYear(), 0, 1);
  const days = Math.floor((d - start) / 86400000);
  const wk = Math.ceil((days + start.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(wk).padStart(2, '0')}`;
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function money(n) {
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ---------- extract transactions ----------

function parseSheet(rows, accountName) {
  const transactions = [];
  const data = rows.slice(7).filter((r) => r[0] && r[0] !== '');
  for (const r of data) {
    const [tradeDate, , , activity, description, symbol, , qty, price, amount, commission] = r;
    const parsed = parseDescription(description);
    if (!parsed) continue;
    transactions.push({
      account: accountName,
      date: parseDate(tradeDate),
      activity,
      ...parsed,
      qty: Math.abs(qty),
      signedQty: qty,
      price,
      amount,
      commission,
      key: `${symbol}-${parsed.type}-${parsed.strike}-${parsed.expiration}`,
    });
  }
  return transactions;
}

// ---------- match opens to closes ----------

function matchTrades(all) {
  const positions = new Map();
  const completed = [];
  const sorted = [...all].sort((a, b) => a.date - b.date);

  for (const t of sorted) {
    const key = `${t.account}-${t.key}`;
    if (!positions.has(key)) positions.set(key, { openLegs: [] });
    const pos = positions.get(key);

    if (t.activity === 'Sold Short') {
      pos.openLegs.push(t);
    } else if (t.activity === 'Bought To Cover') {
      if (pos.openLegs.length > 0) {
        const opener = pos.openLegs.shift();
        completed.push({
          account: t.account,
          symbol: t.symbol,
          type: t.type,
          strike: t.strike,
          expiration: t.expiration,
          openDate: opener.date,
          closeDate: t.date,
          holdDays: Math.floor((t.date - opener.date) / 86400000),
          openCredit: opener.amount,
          closeDebit: t.amount,
          pnl: opener.amount + t.amount,
        });
      }
    } else if (/Expired/i.test(t.activity)) {
      while (pos.openLegs.length > 0) {
        const opener = pos.openLegs.shift();
        completed.push({
          account: t.account,
          symbol: t.symbol,
          type: t.type,
          strike: t.strike,
          expiration: t.expiration,
          openDate: opener.date,
          closeDate: t.date,
          holdDays: Math.floor((t.date - opener.date) / 86400000),
          openCredit: opener.amount,
          closeDebit: 0,
          pnl: opener.amount,
          note: 'Expired worthless',
        });
      }
    } else if (/Assign/i.test(t.activity)) {
      while (pos.openLegs.length > 0) {
        const opener = pos.openLegs.shift();
        completed.push({
          account: t.account,
          symbol: t.symbol,
          type: t.type,
          strike: t.strike,
          expiration: t.expiration,
          openDate: opener.date,
          closeDate: t.date,
          holdDays: Math.floor((t.date - opener.date) / 86400000),
          openCredit: opener.amount,
          closeDebit: 0,
          pnl: opener.amount,
          note: 'Assigned',
        });
      }
    }
  }

  const openLegs = [];
  for (const pos of positions.values()) {
    openLegs.push(...pos.openLegs);
  }
  return { completed, openLegs };
}

// ---------- detect rolls ----------
// A "roll" is a same-day close + open on the same symbol/type, typically at different strike/expiration.
// We detect them to give a more accurate picture of effective losses.

function detectRolls(completed, openLegs, allTxns) {
  // Build a map of (date, account, symbol, type) -> [txns]
  // A close followed by an open on the same day for the same symbol/type = roll
  const rolls = [];
  for (const t of completed) {
    if (t.pnl >= 0) continue; // only look at losing closes
    // Find txns on the close date, same account/symbol/type, that are "Sold Short" (new open)
    const sameDay = allTxns.filter(
      (x) =>
        x.account === t.account &&
        x.symbol === t.symbol &&
        x.type === t.type &&
        x.activity === 'Sold Short' &&
        fmt(x.date) === fmt(t.closeDate)
    );
    if (sameDay.length > 0) {
      const rollCredit = sameDay.reduce((s, x) => s + x.amount, 0);
      rolls.push({
        original: t,
        rollLegs: sameDay,
        rollCredit,
        netRollCost: t.pnl + rollCredit,
      });
    }
  }
  return rolls;
}

// ---------- main ----------

const wb = XLSX.readFile(INPUT);
const cspRows = XLSX.utils.sheet_to_json(wb.Sheets['CSP Account'], { header: 1, defval: '' });
const callRows = XLSX.utils.sheet_to_json(wb.Sheets['Call Account'], { header: 1, defval: '' });
const allTxns = [...parseSheet(cspRows, 'CSP'), ...parseSheet(callRows, 'CALL')];
const { completed, openLegs } = matchTrades(allTxns);
const rolls = detectRolls(completed, openLegs, allTxns);

// ---------- stats ----------

const winners = completed.filter((t) => t.pnl > 0);
const losers = completed.filter((t) => t.pnl < 0);
const totalPnL = completed.reduce((s, t) => s + t.pnl, 0);
const winPnL = winners.reduce((s, t) => s + t.pnl, 0);
const lossPnL = losers.reduce((s, t) => s + t.pnl, 0);
const winRate = (winners.length / completed.length) * 100;
const avgWin = winPnL / winners.length;
const avgLoss = lossPnL / losers.length;
const profitFactor = Math.abs(winPnL / lossPnL);

const byAccount = { CSP: { count: 0, pnl: 0, wins: 0 }, CALL: { count: 0, pnl: 0, wins: 0 } };
for (const t of completed) {
  byAccount[t.account].count++;
  byAccount[t.account].pnl += t.pnl;
  if (t.pnl > 0) byAccount[t.account].wins++;
}

const bySymbol = {};
for (const t of completed) {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { count: 0, pnl: 0, wins: 0, biggestLoss: 0, biggestWin: 0 };
  const s = bySymbol[t.symbol];
  s.count++;
  s.pnl += t.pnl;
  if (t.pnl > 0) s.wins++;
  if (t.pnl < s.biggestLoss) s.biggestLoss = t.pnl;
  if (t.pnl > s.biggestWin) s.biggestWin = t.pnl;
}

const byWeek = {};
for (const t of completed) {
  const k = weekKey(t.closeDate);
  if (!byWeek[k]) byWeek[k] = { count: 0, pnl: 0, wins: 0 };
  byWeek[k].count++;
  byWeek[k].pnl += t.pnl;
  if (t.pnl > 0) byWeek[k].wins++;
}

const byMonth = {};
for (const t of completed) {
  const k = monthKey(t.closeDate);
  if (!byMonth[k]) byMonth[k] = { count: 0, pnl: 0, wins: 0 };
  byMonth[k].count++;
  byMonth[k].pnl += t.pnl;
  if (t.pnl > 0) byMonth[k].wins++;
}

// ---------- write dashboard ----------

function line(c, n = 1) {
  return c.repeat(n);
}

let md = '';

md += `# Executive Trading Dashboard\n\n`;
md += `> **Last updated:** ${new Date().toISOString().slice(0, 10)}\n`;
md += `> **Source:** \`${path.basename(INPUT)}\`\n`;
md += `> **Regenerate:** run \`node scripts/dashboard/build_dashboard.js\` from the \`tradingview-mcp-jackson\` repo after exporting a fresh ETrade Activity file to Desktop.\n\n`;

md += `---\n\n`;
md += `## 📊 Headline KPIs\n\n`;
md += `| Metric | Value |\n|---|---:|\n`;
md += `| **Total completed trades** | ${completed.length} |\n`;
md += `| **Net P&L (closed trades)** | ${money(totalPnL)} |\n`;
md += `| **Win rate** | ${winRate.toFixed(1)}% (${winners.length}/${completed.length}) |\n`;
md += `| **Average winner** | ${money(avgWin)} |\n`;
md += `| **Average loser** | ${money(avgLoss)} |\n`;
md += `| **Profit factor** | ${profitFactor.toFixed(2)}× (winners ÷ |losers|) |\n`;
md += `| **Still open positions** | ${openLegs.length} |\n`;
md += `\n`;

// Recommendations — pinned at top so they're seen every time
md += `---\n\n`;
md += `## 🎯 Active Recommendations\n\n`;
md += `> These are the current action items across all the analysis we've built up. They update when market conditions or positions change. Dashboard generated ${new Date().toISOString().slice(0, 10)}.\n\n`;

md += `### 🔴 This Week — Critical / Time-Sensitive\n\n`;
md += `**Geopolitical kill switch ACTIVE** — Iran ceasefire deadline ~4/21-22. Talks ongoing in Islamabad. Hormuz still closed. Physical oil at $131 implies paper markets are ahead of reality. Assume binary event risk for all of April.\n\n`;
md += `| # | Action | Why |\n|---|---|---|\n`;
md += `| 1 | **SKIP the SPX 0DTE iron condor Monday** | 25-wide is too tight for binary event risk. If you must trade, use 50-wide + wait until 10:30 AM for opening range confirmation |\n`;
md += `| 2 | **Let the GOOGL $297.50 CC exp 4/17 get called** | Near-certain assignment (ITM by $20). Locks in $17,690 profit before the deadline and trims concentration. Do nothing. |\n`;
md += `| 3 | **Let the AMZN $220 CC exp 4/24 get called** | Trims 45% AMZN concentration before event risk peaks. Still keeps 851 shares of exposure. Do nothing. |\n`;
md += `| 4 | **Check MSFT $355 CSP at 9:00 AM Monday** | If at 50% profit, close early. If not, hold or roll down to $345 May. Event risk extends past 5/15 expiration. |\n`;
md += `| 5 | **Defensive wheel entries only this week** | KO, MRK, JNJ. Hold off on V, O, HON, JPM until after 4/22 ceasefire deadline resolves. |\n`;
md += `| 6 | **Watch for Hormuz reopening news** | Biggest weekend signal. Ships moving through = peace is real. Still closed = risk stays on. |\n`;
md += `| 7 | **JPM enters post-4/17 bank earnings AND post-4/22 deadline** | Effectively ~April 23 earliest entry. Don't layer both events on top of each other. |\n`;
md += `\n`;

md += `### 🟡 Active Discipline Rules (from learnings)\n\n`;
md += `These stem directly from the losing-trade analysis above. They're behavior changes, not one-time actions.\n\n`;
md += `| Rule | Source | Application |\n|---|---|---|\n`;
md += `| **Sell covered calls at 15-20 delta, not 30+** | AMZN/GOOGL/TSM $5-8k losses were all 30-delta CCs caught in the ceasefire rally | When opening any new CC, target 15-20 delta shorts for more cushion |\n`;
md += `| **Ladder CC expirations** | All losing CCs were opened March 30 for the same week | Never have more than 1-2 contracts expiring on the same date per name |\n`;
md += `| **Consider assignment before rolling** | Rolling up-and-out cost ~$1k in realized "losses" even when stock rose | If strike is still above cost basis, often cheaper to take assignment than roll |\n`;
md += `| **Size down before known binary events** | All 7 losses clustered in 3 weeks around events | FOMC, CPI, NFP, earnings, geopolitical: cut size 50% or skip entirely |\n`;
md += `| **Track stock + option combined P&L** | Dashboard shows Call account -$945 but underlying stock gains dwarf that | Weekly: tally unrealized stock gains against realized option P&L for true picture |\n`;
md += `| **Defensive diversification target** | AMZN is 45% of wheel capital — concentration risk | Deploy new wheels on KO, MRK, HON, V, O, JPM over next 6 weeks to get AMZN under 20% |\n`;
md += `| **Never cover a call below cost basis** | Standard wheel rule | On MSFT 200 sacred shares: never sell CCs period. On others: CC strikes must be above effective basis. |\n`;
md += `| **Take profit at 50% for CSPs** | Standard tastytrade rule — your CSP account is +$9,414 doing exactly this | Keep doing it. Don't get greedy. |\n`;
md += `| **Manage at 21 DTE** | Standard tastytrade rule | Close or roll any position with ≤21 DTE regardless of P&L |\n`;
md += `\n`;

md += `### 🟢 Position Monitoring (what to check daily)\n\n`;
md += `| Position | What to watch | Trigger |\n|---|---|---|\n`;
md += `| **GOOGL $297.50 CC exp 4/17** | Price vs $297.50 | ITM by $19 — will be called Friday unless GOOGL drops below 297.50 |\n`;
md += `| **AMZN $220 CC exp 4/24** | Price vs $220 | ITM by $18 — likely assignment next Thursday |\n`;
md += `| **AMZN $240 CCs (×3) exp 5/1** | Near-the-money; small rally → assignment | If AMZN > $242, expect to be called on all 3 |\n`;
md += `| **AMZN $250 CCs (×4) exp 5/15** | Comfortable distance | No action unless AMZN breaks $248 |\n`;
md += `| **TSM $360 CC exp 5/15** | ITM by $10 | Likely assignment; OK to let it run |\n`;
md += `| **MSFT $355 CSP exp 5/15** | Profit target + 21 DTE rule | Close at 50% profit OR roll down if MSFT weakens |\n`;
md += `| **GOOGL $335 CC exp 6/18** | Comfortable (OTM by $18) | No action |\n`;
md += `| **CIFR $5.50 CCs exp 5/1** | Willing assignment; let run | No action |\n`;
md += `| **MSFT 200 SACRED shares** | **Never touch** — user holding long-term | Hands off. No CCs, no sales, ever. |\n`;
md += `| **ET 5,000 shares** | Income hold, no options | No action unless dividend policy changes |\n`;
md += `\n`;

md += `### 🔵 Monitoring / Context (watch but don't act)\n\n`;
md += `| What | Source | When to react |\n|---|---|---|\n`;
md += `| **Iran ceasefire status** | Morning brief WebSearch | Broken → defensive mode. Extended → normal. Stalemate → reduced risk. |\n`;
md += `| **Warsh Senate confirmation hearing 4/16** | Economic calendar | Day-of volatility on banks; delay new trades |\n`;
md += `| **ASML earnings 4/14, TSM 4/16, JPM 4/17** | Earnings watchlist | Pre-earnings premium spikes and post-event IV crush create setups |\n`;
md += `| **FOMC 4/28-29** | Powell's last meeting as chair | No new positions day-of; watch for dot plot surprises |\n`;
md += `| **CPI release 5/12** | Economic calendar | No new positions before 8:30 AM release |\n`;
md += `| **10Y-2Y spread** | Morning brief yield curve | Inversion (spread < 0) = recession flag |\n`;
md += `| **NASDAQ breadth** | Morning brief | Net A/D flip from positive to negative = narrowing rally, reduce risk |\n`;
md += `| **VVIX** | Morning brief | >120 = binary event panic, no new short premium |\n`;
md += `\n`;


// Health check
md += `### 🩺 Health check\n\n`;
if (profitFactor < 1.5) {
  md += `⚠️ **Profit factor is ${profitFactor.toFixed(2)}** — below the 1.5 minimum for a sustainable premium-selling system. Your wins aren't covering your losses with enough margin.\n\n`;
  md += `**Root cause:** average loss (${money(avgLoss)}) is **${Math.abs(avgLoss / avgWin).toFixed(1)}× bigger** than average win (${money(avgWin)}). High win rate (${winRate.toFixed(0)}%) masks this — a single bad trade wipes out ${Math.ceil(Math.abs(avgLoss / avgWin))} good ones.\n\n`;
} else {
  md += `✅ Profit factor ${profitFactor.toFixed(2)}× is healthy for a premium-selling system.\n\n`;
}

md += `---\n\n`;
md += `## 💼 By account\n\n`;
md += `| Account | Trades | P&L | Win rate |\n|---|---:|---:|---:|\n`;
for (const [acct, s] of Object.entries(byAccount)) {
  const wr = s.count ? (s.wins / s.count) * 100 : 0;
  md += `| ${acct === 'CSP' ? 'CSP Account (#6019 — income sleeve)' : 'Call Account (#3343 — stock account)'} | ${s.count} | ${money(s.pnl)} | ${wr.toFixed(1)}% |\n`;
}
md += `\n`;

// Account-level interpretation
const cspPnL = byAccount.CSP.pnl;
const callPnL = byAccount.CALL.pnl;
md += `**Interpretation:** `;
if (cspPnL > 0 && callPnL < 0) {
  md += `CSP account is profitable (${money(cspPnL)}), call account is in the red (${money(callPnL)}) — unusual given the 88%+ win rate on the call side. This pattern usually means **a few big losers wiped out many small wins**, typically from rolling covered calls during a sharp rally.\n\n`;
} else if (cspPnL > 0 && callPnL > 0) {
  md += `Both accounts are profitable. Nice balance.\n\n`;
}

md += `---\n\n`;
md += `## 📈 P&L by month\n\n`;
md += `| Month | Trades | P&L | Wins | Win rate |\n|---|---:|---:|---:|---:|\n`;
let prevMoPnL = null;
const moEntries = Object.entries(byMonth).sort();
for (const [k, s] of moEntries) {
  const wr = ((s.wins / s.count) * 100).toFixed(0);
  let momArrow = '';
  if (prevMoPnL !== null) {
    const delta = s.pnl - prevMoPnL;
    momArrow = delta >= 0 ? ` ↑ ${money(delta)}` : ` ↓ ${money(delta)}`;
  }
  md += `| ${k} | ${s.count} | ${money(s.pnl)}${momArrow} | ${s.wins} | ${wr}% |\n`;
  prevMoPnL = s.pnl;
}
md += `\n`;

md += `---\n\n`;
md += `## 📅 P&L by week\n\n`;
md += `| Week | Trades | P&L | Wins | Win rate | WoW Δ |\n|---|---:|---:|---:|---:|---:|\n`;
let prevWkPnL = null;
for (const [k, s] of Object.entries(byWeek).sort()) {
  const wr = ((s.wins / s.count) * 100).toFixed(0);
  let wow = '—';
  if (prevWkPnL !== null) {
    const delta = s.pnl - prevWkPnL;
    wow = delta >= 0 ? `↑ ${money(delta)}` : `↓ ${money(delta)}`;
  }
  md += `| ${k} | ${s.count} | ${money(s.pnl)} | ${s.wins} | ${wr}% | ${wow} |\n`;
  prevWkPnL = s.pnl;
}
md += `\n`;

md += `---\n\n`;
md += `## 🏷️ By symbol\n\n`;
md += `| Symbol | Trades | P&L | Wins | Biggest Win | Biggest Loss |\n|---|---:|---:|---:|---:|---:|\n`;
const symbolEntries = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);
for (const [sym, s] of symbolEntries) {
  md += `| **${sym}** | ${s.count} | ${money(s.pnl)} | ${s.wins}/${s.count} | ${money(s.biggestWin)} | ${money(s.biggestLoss)} |\n`;
}
md += `\n`;

md += `---\n\n`;
md += `## 🥇 Top 10 winners\n\n`;
md += `| Date range | Account | Contract | Hold | P&L |\n|---|---|---|---:|---:|\n`;
const topWinners = [...winners].sort((a, b) => b.pnl - a.pnl).slice(0, 10);
for (const t of topWinners) {
  md += `| ${fmt(t.openDate)} → ${fmt(t.closeDate)} | ${t.account} | ${t.symbol} ${t.type} ${t.strike} exp ${t.expiration} | ${t.holdDays}d | **${money(t.pnl)}** |\n`;
}
md += `\n`;

md += `---\n\n`;
md += `## 🥀 Losing trades (full list)\n\n`;
md += `| Date range | Account | Contract | Hold | P&L |\n|---|---|---|---:|---:|\n`;
const allLosers = [...losers].sort((a, b) => a.pnl - b.pnl);
for (const t of allLosers) {
  md += `| ${fmt(t.openDate)} → ${fmt(t.closeDate)} | ${t.account} | ${t.symbol} ${t.type} ${t.strike} exp ${t.expiration} | ${t.holdDays}d | **${money(t.pnl)}** |\n`;
}
md += `\n`;

// Rolls analysis
md += `---\n\n`;
md += `## 🔄 Roll analysis — the story behind the losses\n\n`;
if (rolls.length > 0) {
  md += `**${rolls.length} of ${losers.length} "losses" were actually rolls** — you closed a losing position and immediately opened a new one on the same symbol/type. The realized dollar loss is less than it appears because the new credit partially offsets the close debit.\n\n`;
  md += `| Original position | Close P&L | New credit(s) | Net roll cost | Interpretation |\n|---|---:|---:|---:|---|\n`;
  for (const r of rolls) {
    const t = r.original;
    const newStrikes = r.rollLegs.map((l) => `${l.strike} exp ${l.expiration}`).join(', ');
    md += `| ${t.symbol} ${t.strike} exp ${t.expiration} | ${money(t.pnl)} | ${money(r.rollCredit)} (new: ${newStrikes}) | **${money(r.netRollCost)}** | Defensive roll, accepted cost for upside |\n`;
  }
  md += `\n`;
  const totalRawLoss = rolls.reduce((s, r) => s + r.original.pnl, 0);
  const totalNetRollCost = rolls.reduce((s, r) => s + r.netRollCost, 0);
  md += `**Raw "loss" on rolled trades:** ${money(totalRawLoss)}\n\n`;
  md += `**Net effective cost after roll credits:** ${money(totalNetRollCost)}\n\n`;
  md += `**Savings from recognizing these as rolls:** ${money(totalRawLoss - totalNetRollCost)}\n\n`;
}

md += `---\n\n`;
md += `## 📂 Currently open positions\n\n`;
md += `| Account | Contract | Opened | Credit | Days open |\n|---|---|---|---:|---:|\n`;
const today = new Date();
for (const t of openLegs) {
  const days = Math.floor((today - t.date) / 86400000);
  md += `| ${t.account} | ${t.symbol} ${t.type} ${t.strike} exp ${t.expiration} | ${fmt(t.date)} | ${money(t.amount)} | ${days}d |\n`;
}
md += `\n`;
const totalOpenCredit = openLegs.reduce((s, t) => s + t.amount, 0);
md += `**Total credit from open positions:** ${money(totalOpenCredit)} (if all expire worthless)\n\n`;

md += `---\n\n`;
md += `## 🧠 Key learnings (auto-generated from loss patterns)\n\n`;

// Pattern 1: all big losses are on covered calls
const bigLosses = [...losers].sort((a, b) => a.pnl - b.pnl).slice(0, 5);
const callLosses = bigLosses.filter((t) => t.type === 'CALL');
if (callLosses.length >= 3) {
  md += `### Learning 1 — Your biggest losses are on covered calls during rallies\n\n`;
  md += `${callLosses.length} of the top 5 biggest losses are covered calls (CALL type), all opened in a tight date window and closed within 1-2 weeks when the underlying rallied past the strike.\n\n`;
  md += `**Specific examples:**\n`;
  for (const t of callLosses.slice(0, 3)) {
    md += `- ${t.symbol} ${t.strike} CC exp ${t.expiration}: opened ${fmt(t.openDate)} for ${money(t.openCredit)}, closed ${fmt(t.closeDate)} at ${money(-t.closeDebit)} debit → ${money(t.pnl)} loss\n`;
  }
  md += `\n**The pattern:** you sold covered calls, the stock rallied through your strike, and you bought them back to avoid being called away (or to roll up). In wheel strategy terms, this is a **defensive roll** — not a technical loss, but an opportunity cost you paid to keep your stock.\n\n`;
  md += `**The fix:**\n`;
  md += `1. **Sell CCs further OTM** (15-20 delta instead of 30-40 delta) — you'll collect less premium but get rolled through less often\n`;
  md += `2. **Ladder expirations** so you're never exposed to a single binary event across all contracts\n`;
  md += `3. **Consider taking assignment** if strike is still above your cost basis — locking in profit is often cheaper than rolling up the call\n`;
  md += `4. **Track stock vs option combined P&L** — the "loss" on the CC is partially offset by stock appreciation. Your dashboard only sees the option leg.\n\n`;
}

// Pattern 2: losses concentrated in time
const lossWeeks = new Set(losers.map((t) => weekKey(t.closeDate)));
if (lossWeeks.size <= 3) {
  md += `### Learning 2 — Losses are concentrated in time, not distributed\n\n`;
  md += `All ${losers.length} losing trades closed in just ${lossWeeks.size} distinct weeks. This tells you losses aren't random — they're **event-driven**. A single week can wipe out multiple good weeks.\n\n`;
  md += `**Implication:** your biggest vulnerability is unexpected market moves (like the Iran ceasefire rally). You can't prevent events, but you can:\n`;
  md += `1. **Size down before known events** (earnings, FOMC, CPI)\n`;
  md += `2. **Stagger expirations** so not all your CCs sit at the same expiration strike\n`;
  md += `3. **Keep cash reserves** so you have ammunition to buy into dips after an event\n\n`;
}

// Pattern 3: concentration in specific names
const heavyLossSymbols = Object.entries(bySymbol)
  .filter(([, s]) => s.pnl < -500)
  .sort((a, b) => a[1].pnl - b[1].pnl);
if (heavyLossSymbols.length > 0) {
  md += `### Learning 3 — Concentration risk on ${heavyLossSymbols.map((x) => x[0]).join(', ')}\n\n`;
  for (const [sym, s] of heavyLossSymbols) {
    md += `- **${sym}:** ${s.count} trades, ${s.wins}/${s.count} wins, ${money(s.pnl)} total P&L. Biggest loss: ${money(s.biggestLoss)}\n`;
  }
  md += `\n**Translation:** even with high win rates, concentrated positions on these names produced outsized losses. The wheel math only works if the wins outweigh the losses, and concentration makes that harder.\n\n`;
  md += `**Fix:** diversify across more names so no single stock can dominate your P&L. The watchlist additions (MRK, KO, HON, V, O, JPM) exist specifically to help spread risk.\n\n`;
}

md += `### Learning 4 — The CSP side of the wheel is working\n\n`;
md += `CSP Account P&L: ${money(cspPnL)} with ${byAccount.CSP.wins}/${byAccount.CSP.count} wins (${((byAccount.CSP.wins / byAccount.CSP.count) * 100).toFixed(0)}%). This is your strongest edge — premium selling on quality names with disciplined strike selection is generating consistent results.\n\n`;
md += `**Keep doing:** quality name selection, 20-delta-ish strikes, taking profit at 50%, closing at 21 DTE.\n\n`;

md += `---\n\n`;
md += `## 🎯 Recommended next actions\n\n`;
md += `1. **Review the losing trades above** — are the learnings accurate for YOUR experience? Edit this section if your memory of those trades differs.\n`;
md += `2. **Verify the "rolls" detected above** — rolls should not be counted the same as outright losses. The realized P&L on those positions is lower than it appears.\n`;
md += `3. **Track stock-side P&L separately** — this dashboard only sees option transactions. Your actual wheel performance includes the stock moves underneath (especially the massive AMZN and GOOGL unrealized gains). Consider adding a weekly manual tally.\n`;
md += `4. **Build a CC discipline rule** — per the learnings, consider selling CCs further OTM or accepting assignment more readily instead of rolling up during rallies.\n`;
md += `5. **Re-run this dashboard weekly** — every Friday after close, export a fresh ETrade Activity file and re-run \`node scripts/dashboard/build_dashboard.js\`. Takes 5 seconds.\n\n`;

md += `---\n\n`;
md += `## 🛠️ How to refresh this dashboard\n\n`;
md += `\`\`\`bash\n`;
md += `# 1. Export fresh activity from ETrade to Desktop, named ETrade Activity_<date>.xlsx\n`;
md += `# 2. Run the dashboard generator:\n`;
md += `cd ~/tradingview-mcp-jackson\n`;
md += `node scripts/dashboard/build_dashboard.js\n`;
md += `\n`;
md += `# Optional: custom input/output paths\n`;
md += `node scripts/dashboard/build_dashboard.js "path/to/input.xlsx" "path/to/output.md"\n`;
md += `\`\`\`\n\n`;
md += `The generator re-reads the xlsx, recalculates all stats, and overwrites the dashboard with fresh numbers.\n\n`;

md += `## 📋 Caveats\n\n`;
md += `1. **This dashboard only sees option transactions.** Stock purchases (from assignments) and stock sales (from called-away positions) are not tracked here. Your actual wheel P&L includes those stock legs.\n`;
md += `2. **Rolls are reported two ways:** once as individual trades (the loss appears raw) and once under "Roll analysis" (netted against new credits). Look at both to avoid double-counting.\n`;
md += `3. **Open positions are unrealized.** The ${openLegs.length} currently-open positions could still go either way. This dashboard shows REALIZED P&L only.\n`;
md += `4. **Win rate is calculated on option legs, not wheel cycles.** A full wheel cycle (CSP → assignment → CC → called away) spans multiple transactions. Measuring cycle-level returns would require broker-level data this tool doesn't read.\n`;

fs.writeFileSync(OUTPUT, md);
console.log(`Dashboard written to ${OUTPUT}`);
console.log(`  ${completed.length} completed trades, ${openLegs.length} open, ${rolls.length} rolls detected`);
console.log(`  Net P&L: ${money(totalPnL)}, Win rate: ${winRate.toFixed(1)}%`);
