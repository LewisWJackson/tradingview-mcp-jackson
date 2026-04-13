// HTML Dashboard generator — reads ETrade Activity xlsx and writes a self-contained
// Chart.js dashboard HTML file you can open in any browser.
//
// Usage: node scripts/dashboard/build_dashboard_html.js [input-xlsx] [output-html]
// Defaults:
//   input:  C:/Users/lam61/OneDrive/Desktop/ETrade Activity_4.11.26.xlsx
//   output: C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html

import XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';
import https from 'https';

// ═══ News fetcher — Yahoo Finance RSS per ticker + Google News for geopolitical/breaking ═══
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : https;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parseRssItems(xml, maxItems = 10) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < maxItems) {
    const block = m[1];
    const tag = (name) => { const r = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`); const mt = block.match(r); return mt ? mt[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : ''; };
    const title = tag('title');
    const link = tag('link');
    const pubDate = tag('pubDate');
    const desc = tag('description').replace(/<[^>]+>/g, '').slice(0, 200);
    if (title) items.push({ title, link, pubDate, desc });
  }
  return items;
}

async function fetchTickerNews(symbols, maxPerTicker = 5) {
  const results = {};
  console.log(`[news] fetching Yahoo RSS for ${symbols.length} tickers...`);
  const BATCH = 8;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    const settled = await Promise.allSettled(
      batch.map(async (sym) => {
        const xml = await httpGet(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`);
        return { sym, items: parseRssItems(xml, maxPerTicker) };
      })
    );
    for (const r of settled) {
      if (r.status === 'fulfilled' && r.value.items.length) {
        results[r.value.sym] = r.value.items;
        process.stdout.write(`  ✓ ${r.value.sym}(${r.value.items.length})`);
      }
    }
    if (i + BATCH < symbols.length) await new Promise((r) => setTimeout(r, 200));
  }
  console.log('');
  return results;
}

async function fetchBreakingNews() {
  console.log('[news] fetching geopolitical/breaking from Google News...');
  const queries = [
    'stock+market+breaking+news',
    'geopolitical+news+markets',
    'earnings+report+today',
  ];
  const all = [];
  for (const q of queries) {
    try {
      const xml = await httpGet(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
      all.push(...parseRssItems(xml, 5));
    } catch { /* skip */ }
  }
  // Deduplicate by title
  const seen = new Set();
  const deduped = all.filter((a) => { if (seen.has(a.title)) return false; seen.add(a.title); return true; });
  console.log(`  ${deduped.length} unique breaking/geopolitical articles`);
  return deduped.slice(0, 15);
}

// ═══ Yahoo Finance live quote fetcher ═══
async function fetchLiveQuotes(symbols, crumb, cookies) {
  const quotes = {};
  console.log(`[quotes] fetching live prices for ${symbols.length} symbols...`);
  const syms = symbols.join(',');
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(syms)}&crumb=${encodeURIComponent(crumb)}`;
    const res = await yahooGet(url, cookies);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      for (const q of (data.quoteResponse?.result || [])) {
        quotes[q.symbol] = q.regularMarketPrice ?? q.postMarketPrice ?? null;
      }
    }
  } catch (e) {
    console.warn('[quotes] live fetch failed:', e.message);
  }
  return quotes;
}

// Fetch yield quotes with daily change data (^TNX = 10Y, 2YY=F = 2Y)
async function fetchYieldQuotes(crumb, cookies) {
  const yields = {};
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent('^TNX,2YY=F')}&crumb=${encodeURIComponent(crumb)}`;
    const res = await yahooGet(url, cookies);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      for (const q of (data.quoteResponse?.result || [])) {
        const key = q.symbol === '^TNX' ? 'us10y' : 'us02y';
        yields[key] = {
          price: q.regularMarketPrice,
          change: q.regularMarketChange,
          changePct: q.regularMarketChangePercent,
        };
      }
    }
    if (Object.keys(yields).length) {
      console.log(`[yields] ${Object.entries(yields).map(([k, v]) => `${k}=${v.price} (${v.changePct >= 0 ? '+' : ''}${v.changePct.toFixed(2)}%)`).join(', ')}`);
    }
  } catch (e) {
    console.warn('[yields] fetch failed:', e.message);
  }
  return yields;
}

// ═══ Yahoo Finance options chain fetcher (crumb/cookie auth) ═══
async function yahooGet(url, cookies) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function yahooGetCrumb() {
  const init = await yahooGet('https://fc.yahoo.com', '');
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await yahooGet('https://query2.finance.yahoo.com/v1/test/getcrumb', cookies);
  return { crumb: crumbRes.body, cookies };
}

function parseChain(opts) {
  const calls = (opts.calls || []).map((c) => ({
    strike: c.strike, last: c.lastPrice, bid: c.bid, ask: c.ask,
    vol: c.volume || 0, oi: c.openInterest || 0, iv: c.impliedVolatility || 0, itm: c.inTheMoney,
  }));
  const puts = (opts.puts || []).map((p) => ({
    strike: p.strike, last: p.lastPrice, bid: p.bid, ask: p.ask,
    vol: p.volume || 0, oi: p.openInterest || 0, iv: p.impliedVolatility || 0, itm: p.inTheMoney,
  }));
  return { calls, puts };
}

async function fetchOptionsForDate(symbol, epochDate, crumb, cookies) {
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(crumb)}&date=${epochDate}`;
  const res = await yahooGet(url, cookies);
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body);
    const opts = data.optionChain?.result?.[0]?.options?.[0];
    return opts ? parseChain(opts) : null;
  } catch { return null; }
}

async function fetchSymbolAllExpirations(symbol, crumb, cookies) {
  // First call: get price, expiration list, and nearest chain
  const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(crumb)}`;
  const res = await yahooGet(url, cookies);
  if (res.status !== 200) return null;
  try {
    const data = JSON.parse(res.body);
    const result = data.optionChain?.result?.[0];
    if (!result) return null;
    const price = result.quote?.regularMarketPrice || 0;
    const epochDates = result.expirationDates || [];
    const expirations = epochDates.map((e) => new Date(e * 1000).toISOString().slice(0, 10));
    const chains = {};
    // First expiration comes free from the initial call
    if (result.options?.[0]) {
      const firstExp = expirations[0];
      chains[firstExp] = parseChain(result.options[0]);
    }
    // Fetch remaining expirations (batched)
    const remaining = epochDates.slice(1);
    const BATCH = 6;
    for (let i = 0; i < remaining.length; i += BATCH) {
      const batch = remaining.slice(i, i + BATCH);
      const settled = await Promise.allSettled(
        batch.map((epoch) => fetchOptionsForDate(symbol, epoch, crumb, cookies))
      );
      for (let j = 0; j < batch.length; j++) {
        const expIdx = i + j + 1; // +1 because we skipped first
        if (settled[j].status === 'fulfilled' && settled[j].value) {
          chains[expirations[expIdx]] = settled[j].value;
        }
      }
      if (i + BATCH < remaining.length) await new Promise((r) => setTimeout(r, 150));
    }
    return { symbol, price, expirations, chains };
  } catch { return null; }
}

async function fetchAllOptionsChains(symbols) {
  const results = {};
  try {
    const { crumb, cookies } = await yahooGetCrumb();
    console.log(`[options] crumb obtained, fetching all expirations for ${symbols.length} symbols...`);
    // Process symbols sequentially (each symbol fetches many expirations internally)
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i];
      const data = await fetchSymbolAllExpirations(sym, crumb, cookies);
      if (data) {
        results[sym] = data;
        const expCount = Object.keys(data.chains).length;
        process.stdout.write(`  ✓ ${sym}(${expCount})`);
      } else {
        process.stdout.write(`  ✗ ${sym}`);
      }
      if (i < symbols.length - 1) await new Promise((r) => setTimeout(r, 100));
    }
    console.log('');
  } catch (e) {
    console.error('[options] failed to fetch:', e.message);
  }
  return results;
}

const INPUT = process.argv[2] || 'C:/Users/lam61/OneDrive/Desktop/ETrade Activity_4.11.26.xlsx';
const OUTPUT = process.argv[3] || 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/Dashboard.html';
const BRIEF_JSON = process.argv[4] || 'C:/Users/lam61/OneDrive/Desktop/Queen Mommy/Trading/morning-brief-data.json';

// Load morning brief if present
let brief = null;
try {
  if (fs.existsSync(BRIEF_JSON)) {
    brief = JSON.parse(fs.readFileSync(BRIEF_JSON, 'utf8'));
  }
} catch (e) {
  console.warn('Could not read morning brief JSON:', e.message);
}

// Load trading rules
let tradingRules = [];
try {
  const rulesPath = path.resolve(path.dirname(process.argv[1] || '.'), '../../rules.json');
  if (fs.existsSync(rulesPath)) {
    const r = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
    tradingRules = r.risk_rules || [];
  }
} catch (e) {
  console.warn('Could not read rules.json:', e.message);
}

// Load coiled spring scanner results if present
let coiledSpringResults = null;
try {
  const coiledPath = path.resolve(path.dirname(process.argv[1] || '.'), '../scanner/coiled_spring_results.json');
  if (fs.existsSync(coiledPath)) {
    coiledSpringResults = JSON.parse(fs.readFileSync(coiledPath, 'utf8'));
    console.log(`[coiled-spring] loaded ${coiledSpringResults.results?.length || 0} candidates from ${coiledSpringResults.scanDate}`);
  }
} catch (e) {
  console.warn('Could not read coiled spring results:', e.message);
}

// ---------- parsers ----------

function parseDescription(desc) {
  const m = desc.match(/^(PUT|CALL)\s+(\S+)\s+(\d{2}\/\d{2}\/\d{2})\s+([\d.]+)/);
  if (!m) return null;
  return { type: m[1], symbol: m[2], expiration: m[3], strike: parseFloat(m[4]) };
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
    } else if (t.activity === 'Bought To Cover' && pos.openLegs.length > 0) {
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
        status: 'closed',
      });
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
          status: 'expired',
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
          status: 'assigned',
        });
      }
    }
  }

  const openLegs = [];
  for (const pos of positions.values()) openLegs.push(...pos.openLegs);
  return { completed, openLegs };
}

// ---------- main ----------

const wb = XLSX.readFile(INPUT);
const cspRows = XLSX.utils.sheet_to_json(wb.Sheets['CSP Account'], { header: 1, defval: '' });
const callRows = XLSX.utils.sheet_to_json(wb.Sheets['Call Account'], { header: 1, defval: '' });
const allTxns = [...parseSheet(cspRows, 'CSP'), ...parseSheet(callRows, 'CALL')];
const { completed, openLegs } = matchTrades(allTxns);

// ---------- build chart datasets ----------

// 1. Equity curve: cumulative P&L over time (by close date)
const sortedByClose = [...completed].sort((a, b) => a.closeDate - b.closeDate);
const equityCurve = [];
let cum = 0;
for (const t of sortedByClose) {
  cum += t.pnl;
  equityCurve.push({ date: fmt(t.closeDate), cum: Math.round(cum * 100) / 100, pnl: Math.round(t.pnl * 100) / 100, symbol: t.symbol, account: t.account });
}

// 2. P&L by week
const byWeek = {};
for (const t of completed) {
  const k = weekKey(t.closeDate);
  if (!byWeek[k]) byWeek[k] = { pnl: 0, trades: 0, wins: 0, csp: 0, call: 0 };
  byWeek[k].pnl += t.pnl;
  byWeek[k].trades++;
  if (t.pnl > 0) byWeek[k].wins++;
  if (t.account === 'CSP') byWeek[k].csp += t.pnl;
  else byWeek[k].call += t.pnl;
}
const weekKeys = Object.keys(byWeek).sort();

// 3. P&L by month
const byMonth = {};
for (const t of completed) {
  const k = monthKey(t.closeDate);
  if (!byMonth[k]) byMonth[k] = { pnl: 0, trades: 0, wins: 0, csp: 0, call: 0 };
  byMonth[k].pnl += t.pnl;
  byMonth[k].trades++;
  if (t.pnl > 0) byMonth[k].wins++;
  if (t.account === 'CSP') byMonth[k].csp += t.pnl;
  else byMonth[k].call += t.pnl;
}
const monthKeys = Object.keys(byMonth).sort();

// 4. P&L by symbol
const bySymbol = {};
for (const t of completed) {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = { pnl: 0, trades: 0, wins: 0 };
  bySymbol[t.symbol].pnl += t.pnl;
  bySymbol[t.symbol].trades++;
  if (t.pnl > 0) bySymbol[t.symbol].wins++;
}
const sortedSymbols = Object.entries(bySymbol).sort((a, b) => b[1].pnl - a[1].pnl);

// 5. Win/loss distribution
const winCount = completed.filter((t) => t.pnl > 0).length;
const lossCount = completed.filter((t) => t.pnl < 0).length;
const neutralCount = completed.filter((t) => t.pnl === 0).length;

// 6. Hold-time distribution
const holdBuckets = { '0-3d': 0, '4-7d': 0, '8-14d': 0, '15-21d': 0, '22-30d': 0, '30d+': 0 };
for (const t of completed) {
  if (t.holdDays <= 3) holdBuckets['0-3d']++;
  else if (t.holdDays <= 7) holdBuckets['4-7d']++;
  else if (t.holdDays <= 14) holdBuckets['8-14d']++;
  else if (t.holdDays <= 21) holdBuckets['15-21d']++;
  else if (t.holdDays <= 30) holdBuckets['22-30d']++;
  else holdBuckets['30d+']++;
}

// 7. Headline stats
const winners = completed.filter((t) => t.pnl > 0);
const losers = completed.filter((t) => t.pnl < 0);
const totalPnL = completed.reduce((s, t) => s + t.pnl, 0);
const winPnL = winners.reduce((s, t) => s + t.pnl, 0);
const lossPnL = losers.reduce((s, t) => s + t.pnl, 0);
const winRate = (winners.length / completed.length) * 100;
const avgWin = winners.length ? winPnL / winners.length : 0;
const avgLoss = losers.length ? lossPnL / losers.length : 0;
const profitFactor = Math.abs(winPnL / lossPnL);

const cspTrades = completed.filter((t) => t.account === 'CSP');
const callTrades = completed.filter((t) => t.account === 'CALL');
const cspPnL = cspTrades.reduce((s, t) => s + t.pnl, 0);
const callPnL = callTrades.reduce((s, t) => s + t.pnl, 0);

// 8. Max drawdown on equity curve
let peak = 0;
let maxDD = 0;
let peakDate = '';
let ddDate = '';
for (const p of equityCurve) {
  if (p.cum > peak) {
    peak = p.cum;
    peakDate = p.date;
  }
  const dd = peak - p.cum;
  if (dd > maxDD) {
    maxDD = dd;
    ddDate = p.date;
  }
}

// 9. Compute unrealized P&L for open option positions
// Fetch live prices from Yahoo Finance (fallback to stale defaults if fetch fails)
const _fallbackPrices = { AMZN: 238.38, MSFT: 370.87, GOOGL: 317.24, TSM: 370.60, CIFR: 16.53, ET: 19.19, NOW: 83.00, SPX: 6816.90 };
const _quoteSymbols = [...new Set(openLegs.map((l) => l.symbol))];
let currentPrices;
let liveYields = {};
try {
  const { crumb, cookies } = await yahooGetCrumb();
  const [live, ylds] = await Promise.all([
    fetchLiveQuotes(_quoteSymbols, crumb, cookies),
    fetchYieldQuotes(crumb, cookies),
  ]);
  liveYields = ylds;
  if (Object.keys(live).length > 0) {
    currentPrices = { ..._fallbackPrices, ...live };
    console.log(`[quotes] live prices: ${Object.entries(live).map(([s, p]) => s + '=' + p).join(', ')}`);
  } else {
    currentPrices = _fallbackPrices;
    console.warn('[quotes] no live data returned, using fallback prices');
  }
} catch (e) {
  currentPrices = _fallbackPrices;
  console.warn('[quotes] fetch failed, using fallback prices:', e.message);
}

// Days from open date to today for time-value estimation
const today = new Date();

function computeOpenUnrealized(leg) {
  const price = currentPrices[leg.symbol];
  const result = {
    symbol: leg.symbol,
    account: leg.account,
    type: leg.type,
    strike: leg.strike,
    expiration: leg.expiration,
    qty: leg.qty,
    credit: leg.amount,
    openDate: fmt(leg.date),
    currentPrice: price || null,
  };

  // Parse expiration date
  const [em, ed, ey] = leg.expiration.split('/').map(Number);
  const expDate = new Date(2000 + ey, em - 1, ed);
  const dteRemaining = Math.max(0, Math.floor((expDate - today) / 86400000));
  const dteOriginal = Math.max(1, Math.floor((expDate - leg.date) / 86400000));
  result.dteRemaining = dteRemaining;
  result.dteOriginal = dteOriginal;
  result.expired = dteRemaining === 0;

  if (!price) {
    result.status = 'unknown';
    return result;
  }

  // Moneyness
  let intrinsicPerShare = 0;
  let moneyness = 'OTM';
  let moneynessAmt = 0;

  if (leg.type === 'CALL') {
    if (price > leg.strike) {
      intrinsicPerShare = price - leg.strike;
      moneyness = 'ITM';
      moneynessAmt = intrinsicPerShare;
    } else {
      moneynessAmt = -(leg.strike - price); // negative = OTM
    }
  } else {
    // PUT
    if (price < leg.strike) {
      intrinsicPerShare = leg.strike - price;
      moneyness = 'ITM';
      moneynessAmt = intrinsicPerShare;
    } else {
      moneynessAmt = -(price - leg.strike); // negative = OTM
    }
  }

  const intrinsicTotal = intrinsicPerShare * 100 * leg.qty;
  const intrinsicBasedPnL = leg.amount - intrinsicTotal;
  const maxProfit = leg.amount;

  // Rough time-value estimate for OTM: linear decay with sqrt easing
  // For ITM: less relevant, intrinsic dominates
  let estimatedOptionValue;
  if (moneyness === 'OTM') {
    // Approximate: value decays from original credit toward 0
    // Using sqrt time decay as rough theta model
    const timeRatio = Math.sqrt(dteRemaining / Math.max(dteOriginal, 1));
    estimatedOptionValue = leg.amount * timeRatio * 0.7; // 0.7 factor for market drift
  } else {
    // ITM: estimated value ≈ intrinsic + small remaining time value
    estimatedOptionValue = intrinsicTotal + Math.min(leg.amount * 0.1, 100 * leg.qty);
  }

  const estimatedPnL = leg.amount - estimatedOptionValue;

  return {
    ...result,
    moneyness,
    moneynessAmt,
    intrinsicPerShare,
    intrinsicTotal,
    intrinsicBasedPnL,
    estimatedOptionValue: Math.round(estimatedOptionValue * 100) / 100,
    estimatedPnL: Math.round(estimatedPnL * 100) / 100,
    maxProfit,
  };
}

const openUnrealized = openLegs.map(computeOpenUnrealized);

// Aggregate summary (excluding expired)
const activeLegs = openUnrealized.filter((o) => !o.expired);
const unrealizedSummary = {
  totalCredit: activeLegs.reduce((s, o) => s + o.credit, 0),
  totalIntrinsicExposure: activeLegs.reduce((s, o) => s + (o.intrinsicTotal || 0), 0),
  intrinsicBasedNetPnL: activeLegs.reduce((s, o) => s + (o.intrinsicBasedPnL || 0), 0),
  estimatedNetPnL: activeLegs.reduce((s, o) => s + (o.estimatedPnL || 0), 0),
  maxProfitPotential: activeLegs.reduce((s, o) => s + o.credit, 0),
  itmCount: activeLegs.filter((o) => o.moneyness === 'ITM').length,
  otmCount: activeLegs.filter((o) => o.moneyness === 'OTM').length,
  atmCount: activeLegs.filter((o) => o.moneyness === 'ATM').length,
};

// 10. All completed trades for table
const tradeTable = [...completed]
  .sort((a, b) => b.closeDate - a.closeDate)
  .map((t) => ({
    close: fmt(t.closeDate),
    open: fmt(t.openDate),
    account: t.account,
    symbol: t.symbol,
    type: t.type,
    strike: t.strike,
    exp: t.expiration,
    hold: t.holdDays,
    pnl: Math.round(t.pnl * 100) / 100,
    status: t.status,
  }));

// ---------- morning brief rendering ----------

function renderMorningBrief(b) {
  if (!b) {
    return `
<div class="brief-container">
  <div class="brief-panel">
    <div class="brief-missing">
      <h3>📋 No morning brief generated yet</h3>
      <p>Type <code style="background:#0d1117;padding:2px 8px;border-radius:3px;font-family:monospace;">run morning brief</code> in Claude Code to populate this section.</p>
      <p style="font-size:12px;margin-top:16px;">The brief will include live market data, geopolitical context, executive trade recommendations, and per-ticker reads for your entire watchlist.</p>
    </div>
  </div>
</div>`;
  }

  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const status = b.status || 'active';

  // Determine overall action badge color
  const topAction = b.executiveSummary?.topAction || 'NO TRADE';
  const topActionClass = topAction.toLowerCase().includes('skip') ? 'skip' :
                         topAction.toLowerCase().includes('execute') ? 'execute' : 'wait';

  // Market snapshot cells — handle both flat numbers and {price} objects
  const ms = b.marketSnapshot || {};
  const priceOf = (v) => v == null ? null : (typeof v === 'object' ? v.price : v);
  const pctOf = (v) => typeof v === 'object' ? (v.change || '') : '';
  const trendOf = (v) => typeof v === 'object' ? (v.trend || '') : '';

  const yield10y = priceOf(ms.yield10y ?? ms.us10y);
  const yield2y = priceOf(ms.yield2y ?? ms.us02y);
  const spread = priceOf(ms.yieldSpread);

  // Daily change from live Yahoo yield quotes (^TNX, 2YY=F)
  const y10 = liveYields.us10y || {};
  const y2 = liveYields.us02y || {};
  const fmtYieldChg = (y) => {
    if (y.changePct == null) return '';
    const sign = y.changePct >= 0 ? '+' : '';
    const bps = y.change != null ? Math.round(y.change * 100) : null;
    const bpsStr = bps != null ? ` (${bps >= 0 ? '+' : ''}${bps} bps)` : '';
    return `${sign}${y.changePct.toFixed(2)}%${bpsStr}`;
  };

  const gridCells = [
    { label: 'SPX', value: priceOf(ms.spx), note: pctOf(ms.spx) },
    { label: 'QQQ', value: priceOf(ms.qqq), note: pctOf(ms.qqq) },
    { label: 'VIX', value: priceOf(ms.vix), note: pctOf(ms.vix) },
    { label: 'RUT', value: priceOf(ms.rut), note: pctOf(ms.rut) },
    { label: '10Y', value: (y10.price ?? yield10y) != null ? (y10.price ?? yield10y).toFixed(3) + '%' : null, note: fmtYieldChg(y10) },
    { label: '2Y', value: (y2.price ?? yield2y) != null ? (y2.price ?? yield2y).toFixed(3) + '%' : null, note: fmtYieldChg(y2) },
    { label: '10Y-2Y', value: spread != null ? (spread >= 0 ? '+' : '') + spread.toFixed(1) + ' bps' : null, note: ms.yieldDirection || '' },
    { label: 'Regime', value: ms.regimeInterpretation ? ms.regimeInterpretation.split('.')[0] : (ms.regime || '—'), note: '' },
  ];
  const gridHtml = gridCells
    .map(
      (c) => `
        <div class="brief-cell">
          <div class="brief-cell-label">${esc(c.label)}</div>
          <div class="brief-cell-value">${esc(c.value)}</div>
          ${c.note ? `<div class="brief-cell-note">${esc(c.note)}</div>` : ''}
        </div>`
    )
    .join('');

  // Trades
  const trades = (b.executiveSummary?.trades || [])
    .map((t) => {
      const cls = t.action?.toLowerCase().includes('skip') ? 'skip' : 'execute';
      return `
        <div class="brief-trade-card ${cls}">
          <div class="brief-trade-title">
            <span class="brief-trade-action ${cls}">${esc(t.action)}</span>
            ${esc(t.strategy)}
          </div>
          <div class="brief-trade-reason">${esc(t.reasoning)}</div>
        </div>`;
    })
    .join('');

  // Manage existing
  const manage = (b.executiveSummary?.manageExisting || [])
    .map(
      (m) => `
        <div class="brief-manage-item">
          <strong>${esc(m.position)}</strong>
          <span class="action">${esc(m.action)}</span>
          <div class="reason">${esc(m.reasoning)}</div>
        </div>`
    )
    .join('');

  // Entry candidates (growth-focused)
  const skipEntries = new Set(["KO", "MRK", "JNJ", "WMT", "COST"]);
  const entries = [...(b.executiveSummary?.growthEntries || []), ...(b.executiveSummary?.defensiveEntriesOk || [])].filter(e => !skipEntries.has(e.ticker))
    .map(
      (e) => `
        <div class="brief-entry-item">
          <strong>${esc(e.ticker)}</strong> — target credit ${esc(e.targetCredit)} · collateral $${e.collateral?.toLocaleString()}<br/>
          <code>${esc(e.suggested)}</code>
          <div style="color:var(--text-dim);font-size:12px;margin-top:6px;">${esc(e.reasoning)}</div>
        </div>`
    )
    .join('');

  // Events
  const events = (b.events || [])
    .map(
      (e) => `
        <div class="brief-event ${e.impact || ''}">
          <div class="date">${esc(e.day)} ${esc(e.date)}</div>
          <div class="name">${esc(e.name)}</div>
          <div class="action">${esc(e.tradingAction)}</div>
        </div>`
    )
    .join('');

  // Kill switches
  const killSwitches = (b.killSwitches || [])
    .filter((k) => k.active)
    .map((k) => `<span class="brief-kill-switch">${esc(k.name)}</span>`)
    .join('');

  // Per-ticker reads
  const perTicker = (b.perTicker || [])
    .map((t) => {
      const labelClass = (t.label || 'context').toLowerCase().replace(/[^a-z]/g, '').split('-')[0];
      return `
        <tr>
          <td><strong>${esc(t.symbol)}</strong></td>
          <td><span class="brief-label ${labelClass}">${esc(t.label)}</span></td>
          <td class="num">$${t.price}</td>
          <td>${esc(t.note)}</td>
        </tr>`;
    })
    .join('');

  // Checklist
  const checklist = (b.checklistForMonday || [])
    .map((c) => `<li>${esc(c)}</li>`)
    .join('');

  // Geopolitical + Fed + Breadth cards
  const geo = b.geopolitical || {};
  const fed = b.fedRates || {};
  const breadth = b.breadth || {};

  const contextRow = `
    <div class="brief-section">
      <h4>🌍 Context</h4>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
        <div class="brief-manage-item" style="border-left-color:var(--red);">
          <strong>Geopolitical — ${esc(geo.iranStatus || 'Unknown')}</strong>
          <div class="reason">${esc(geo.iranSummary || '')}</div>
        </div>
        <div class="brief-manage-item" style="border-left-color:var(--purple);">
          <strong>Fed / Rates</strong>
          <div class="reason">Fed funds ${esc(fed.fedFundsRate)}. Next FOMC ${esc(fed.nextFomc)}. Powell term ends ${esc(fed.powellTermEnd)}. Warsh hearing ${esc(fed.warshHearingDate)}. ${esc(fed.marketExpectation)}</div>
        </div>
        <div class="brief-manage-item" style="border-left-color:${breadth.narrowingRally ? 'var(--red)' : 'var(--green)'};">
          <strong>Breadth</strong>
          <div class="reason">NASDAQ A/D: ${breadth.nasdaqAdv}/${breadth.nasdaqDec} (net ${breadth.netAD}). TICK ${breadth.tick}. ${breadth.narrowingRally ? '⚠️ Narrowing rally.' : 'Healthy breadth.'}</div>
        </div>
      </div>
    </div>`;

  return `
<div class="brief-container">
  <div class="brief-panel">
    <div class="brief-header">
      <h2 class="brief-title">
        📋 Morning Brief — ${esc(b.dayOfWeek)} ${esc(b.tradingDay)}
        <span class="brief-trade-action ${topActionClass}" style="font-size:12px;">${esc(topAction)}</span>
      </h2>
      <div class="brief-meta">
        Generated ${esc((b.generatedAt || '').replace('T', ' ').slice(0, 19))} · Status: ${esc(status)}
      </div>
    </div>
    ${b.staleWarning ? `<div class="brief-stale">${esc(b.staleWarning)}</div>` : ''}
    <div class="brief-body">

      ${b.oneLiner ? `<div class="brief-oneliner">${esc(b.oneLiner)}</div>` : ''}

      <div class="brief-section">
        <h4>💹 Market Snapshot</h4>
        <div class="brief-grid">${gridHtml}</div>
        ${ms.regimeInterpretation ? `<div style="color:var(--text-dim);font-size:12px;">${esc(ms.regimeInterpretation)}</div>` : ''}
      </div>

      ${killSwitches ? `<div class="brief-section">
        <h4>🚨 Active Kill Switches</h4>
        <div class="brief-kill-switches">${killSwitches}</div>
      </div>` : ''}

      ${trades ? `<div class="brief-section">
        <h4>🎯 Today's Trade(s)</h4>
        ${trades}
      </div>` : ''}

      ${manage ? `<div class="brief-section">
        <h4>📂 Manage Existing Positions</h4>
        ${manage}
      </div>` : ''}

      ${entries ? `<div class="brief-section">
        <h4>✅ Entry Candidates</h4>
        ${entries}
      </div>` : ''}

      ${contextRow}

      <div class="brief-section">
        <h4>📅 Upcoming Events (8 weeks)</h4>
        <div class="brief-events">${events}</div>
      </div>

      <details class="brief-collapse">
        <summary>📋 Per-ticker read (${(b.perTicker || []).length} names) — click to expand</summary>
        <table class="brief-ticker-table" style="width:100%;margin-top:10px;">
          <thead>
            <tr>
              <th>Symbol</th><th>Action</th><th class="num">Price</th><th>Note</th>
            </tr>
          </thead>
          <tbody>${perTicker}</tbody>
        </table>
      </details>

      ${checklist ? `<details class="brief-collapse">
        <summary>📝 Pre-market checklist — click to expand</summary>
        <ul class="brief-checklist" style="margin-top:10px;">${checklist}</ul>
      </details>` : ''}

    </div>
  </div>
</div>`;
}

const briefHtml = renderMorningBrief(brief);

// ---------- unrealized P&L rendering ----------

function renderUnrealizedPnL(b) {
  if (!b || !b.unrealizedPnL) return '';
  const u = b.unrealizedPnL;
  const s = u.summary || {};
  const money = (n) => n == null ? '—' : (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString();
  const pct = (n) => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

  const holdings = u.holdings || [];
  const knownCount = holdings.filter((h) => h.costBasis != null).length;

  const rows = holdings.map((h) => {
    const knownPnL = h.unrealizedPnL != null;
    return `
    <tr>
      <td><strong>${h.ticker}</strong></td>
      <td class="num">${h.shares.toLocaleString()}</td>
      <td class="num">${h.costBasis != null ? '$' + h.costBasis.toFixed(2) : '<span style="color:var(--text-dim)">unknown</span>'}</td>
      <td class="num">$${h.currentPrice.toFixed(2)}</td>
      <td class="num"><strong>$${Math.round(h.marketValue).toLocaleString()}</strong></td>
      <td class="num ${knownPnL ? (h.unrealizedPnL >= 0 ? 'positive' : 'negative') : ''}">${knownPnL ? '<strong>' + money(h.unrealizedPnL) + '</strong>' : '—'}</td>
      <td class="num ${knownPnL ? (h.unrealizedPct >= 0 ? 'positive' : 'negative') : ''}">${pct(h.unrealizedPct)}</td>
      <td style="font-size:11px;color:var(--text-dim)">${h.notes || ''}</td>
    </tr>`;
  }).join('');

  return `
<div class="panel span-12" style="border-left:4px solid var(--green)">
  <h2>💰 Unrealized P&L — Stock Holdings <span style="font-size:11px;color:var(--text-dim);margin-left:8px;font-weight:400">(as of ${s.coverageNote ? b.tradingDay : 'Friday close'})</span></h2>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
    <div class="brief-cell" style="border-left:3px solid var(--blue)">
      <div class="brief-cell-label">Total Market Value</div>
      <div class="brief-cell-value">$${Math.round(s.totalMarketValue || 0).toLocaleString()}</div>
      <div class="brief-cell-note">${holdings.length} holding${holdings.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--green)">
      <div class="brief-cell-label">Unrealized Stock P&L</div>
      <div class="brief-cell-value positive">${money(s.totalKnownUnrealizedGain)}</div>
      <div class="brief-cell-note">known basis only (${knownCount} of ${holdings.length})</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--yellow)">
      <div class="brief-cell-label">Realized Options P&L</div>
      <div class="brief-cell-value positive">${money(s.totalRealizedOptionsGain)}</div>
      <div class="brief-cell-note">${s.realizedSince || 'all time'}</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--purple)">
      <div class="brief-cell-label">Total Known P&L</div>
      <div class="brief-cell-value positive">${money(s.totalHouseholdPnLKnown)}</div>
      <div class="brief-cell-note">stock + options</div>
    </div>
  </div>

  <table style="width:100%;font-size:13px;">
    <thead>
      <tr>
        <th>Ticker</th>
        <th class="num">Shares</th>
        <th class="num">Cost Basis</th>
        <th class="num">Current</th>
        <th class="num">Market Value</th>
        <th class="num">Unrealized $</th>
        <th class="num">Unrealized %</th>
        <th>Notes</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${(() => {
    const missing = (u.holdings || []).filter(h => h.costBasis == null).map(h => h.ticker);
    if (missing.length === 0) return '';
    return `
  <div style="margin-top:14px;padding:10px 14px;background:rgba(210,153,34,0.1);border-left:3px solid var(--yellow);border-radius:4px;font-size:12px;color:var(--text-dim)">
    <strong style="color:var(--yellow)">Missing cost basis:</strong> ${missing.join(', ')}.
    Tell me the cost bases and I'll update the JSON so total portfolio P&L becomes fully accurate.
  </div>`;
  })()}
</div>`;
}

const unrealizedHtml = renderUnrealizedPnL(brief);

function renderOpenOptionsUnrealized(openUnreal, summary) {
  if (!openUnreal || openUnreal.length === 0) return '';
  const money = (n) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + '$' + Math.round(n).toLocaleString();
  const moneyDetail = (n) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + '$' + n.toFixed(2);

  const rows = openUnreal.map((o) => {
    const isExpired = o.expired;
    const moneynessLabel = o.moneyness === 'ITM' ? 'ITM' : o.moneyness === 'ATM' ? 'ATM' : 'OTM';
    const moneynessClass = o.moneyness === 'ITM' ? 'negative' : o.moneyness === 'OTM' ? 'positive' : 'neutral';
    const pnlClass = (o.estimatedPnL || 0) >= 0 ? 'positive' : 'negative';

    return `
    <tr ${isExpired ? 'style="opacity:0.5"' : ''}>
      <td><span class="badge ${o.account === 'CSP' ? 'badge-csp' : 'badge-call'}">${o.account}</span></td>
      <td><strong>${o.symbol}</strong></td>
      <td><span class="badge ${o.type === 'PUT' ? 'badge-put' : 'badge-calltype'}">${o.type}</span></td>
      <td class="num">$${o.strike}</td>
      <td>${o.expiration}${isExpired ? ' ⚠️' : ''}</td>
      <td class="num">${o.qty}</td>
      <td class="num">$${o.currentPrice?.toFixed(2) || '—'}</td>
      <td class="num ${moneynessClass}"><strong>${moneynessLabel}</strong><br/><span style="font-size:11px">$${Math.abs(o.moneynessAmt || 0).toFixed(2)}</span></td>
      <td class="num">${money(o.credit)}</td>
      <td class="num negative">${o.intrinsicTotal > 0 ? '-$' + Math.round(o.intrinsicTotal).toLocaleString() : '—'}</td>
      <td class="num ${pnlClass}"><strong>${money(o.estimatedPnL)}</strong></td>
      <td class="num">${o.dteRemaining}d</td>
    </tr>`;
  }).join('');

  return `
<div class="panel span-12" style="border-left:4px solid var(--yellow)">
  <h2>🎲 Open Options — Unrealized P&L Estimates</h2>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
    <div class="brief-cell" style="border-left:3px solid var(--blue)">
      <div class="brief-cell-label">Total Credit Collected</div>
      <div class="brief-cell-value positive">+$${Math.round(summary.totalCredit).toLocaleString()}</div>
      <div class="brief-cell-note">${summary.itmCount} ITM · ${summary.otmCount} OTM</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--red)">
      <div class="brief-cell-label">Intrinsic Exposure (ITM)</div>
      <div class="brief-cell-value negative">-$${Math.round(summary.totalIntrinsicExposure).toLocaleString()}</div>
      <div class="brief-cell-note">what you'd owe if closed at intrinsic</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid ${summary.estimatedNetPnL >= 0 ? 'var(--green)' : 'var(--red)'}">
      <div class="brief-cell-label">Est. Unrealized P&L</div>
      <div class="brief-cell-value ${summary.estimatedNetPnL >= 0 ? 'positive' : 'negative'}">${money(summary.estimatedNetPnL)}</div>
      <div class="brief-cell-note">approximate liquidation value</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--green)">
      <div class="brief-cell-label">Max Profit Potential</div>
      <div class="brief-cell-value positive">+$${Math.round(summary.maxProfitPotential).toLocaleString()}</div>
      <div class="brief-cell-note">if all expire worthless</div>
    </div>
  </div>

  <table style="width:100%;font-size:12px;">
    <thead>
      <tr>
        <th>Acct</th>
        <th>Symbol</th>
        <th>Type</th>
        <th class="num">Strike</th>
        <th>Exp</th>
        <th class="num">Qty</th>
        <th class="num">Spot</th>
        <th class="num">Moneyness</th>
        <th class="num">Credit</th>
        <th class="num">Intrinsic</th>
        <th class="num">Est. P&L</th>
        <th class="num">DTE</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div style="margin-top:14px;padding:10px 14px;background:rgba(210,153,34,0.1);border-left:3px solid var(--yellow);border-radius:4px;font-size:12px;color:var(--text-dim)">
    <strong style="color:var(--yellow)">⚠️ Method:</strong> Estimated P&L uses intrinsic value + rough time-value decay model.
    For precise numbers, check E*Trade option chain P&L column.
    <strong>ITM calls</strong> show "losses" but those are really the cost of being called — offset by stock gains at the strike price (not shown here).
    <strong>OTM positions</strong> show decay estimates assuming market doesn't move against you.
  </div>
</div>`;
}

const openOptionsHtml = renderOpenOptionsUnrealized(openUnrealized, unrealizedSummary);

// ---------- dynamic recommendations rendering ----------

function renderRecommendations(b, rules) {
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  if (!b) {
    return `
<div class="panel span-12">
  <h2>🎯 Active Recommendations</h2>
  <div style="color:var(--text-dim);font-size:13px;padding:20px;">
    No morning brief loaded. Run <code>run morning brief</code> in Claude Code to populate recommendations.
  </div>
</div>`;
  }

  const es = b.executiveSummary || {};
  const trades = es.trades || [];
  const manage = es.manageExisting || [];
  const growth = es.growthEntries || [];
  const events = b.events || [];
  const kills = b.killSwitches || [];
  const checklist = b.checklistForMonday || b.checklistForTuesday || b.checklistForToday || [];

  // Tab 1: Critical / This Week — trades + kill switches + checklist
  const criticalItems = [];
  for (const t of trades) {
    criticalItems.push({ text: `<strong>${esc(t.strategy || t.action)}</strong>`, why: esc(t.reasoning), cls: 'critical' });
  }
  for (const k of kills.filter(k => k.active)) {
    criticalItems.push({ text: `<strong>⚠️ ${esc(k.name)}</strong>`, why: 'Kill switch active — restricts new entries.', cls: 'critical' });
  }
  for (const c of checklist) {
    criticalItems.push({ text: `<strong>${esc(c)}</strong>`, why: '', cls: 'critical' });
  }

  // Tab 2: Discipline Rules — from rules.json
  const ruleItems = rules.map(r => ({ text: `<strong>${esc(r)}</strong>`, why: '', cls: 'rule' }));

  // Tab 3: Position Monitoring — manageExisting
  const posItems = manage.map(m => ({
    text: `<strong>${esc(m.position)}</strong> — ${esc(m.action)}`,
    why: esc(m.reasoning),
    cls: 'position',
  }));

  // Tab 4: Market Context — events + growth entries
  const watchItems = [];
  for (const e of events) {
    const impact = e.impact === 'high' ? '🔴' : e.impact === 'medium' ? '🟡' : '🟢';
    watchItems.push({ text: `<strong>${impact} ${esc(e.day)} ${esc(e.date)} — ${esc(e.name)}</strong>`, why: esc(e.tradingAction), cls: 'watch' });
  }
  for (const g of growth) {
    watchItems.push({ text: `<strong>📈 ${esc(g.ticker)}</strong> — ${esc(g.suggested)}`, why: esc(g.reasoning), cls: 'watch' });
  }

  const renderTab = (items) => items.map((item, i) => `
        <li class="rec-item ${item.cls}"><div class="rec-row"><div class="rec-num">${i + 1}</div><div>${item.text}${item.why ? `<div class="why">${item.why}</div>` : ''}</div></div></li>`).join('');

  const briefDate = b.generatedAt ? new Date(b.generatedAt).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);

  return `
<div class="panel span-12">
  <h2>🎯 Active Recommendations</h2>
  <div style="color: var(--text-dim); font-size: 12px; margin-bottom: 12px;">
    From morning brief generated ${briefDate}. ${b.staleWarning ? '<strong style="color:var(--yellow);">' + esc(b.staleWarning) + '</strong>' : ''}
  </div>
  <div class="rec-tabs">
    <button class="rec-tab active" data-tab="critical">🔴 This Week (${criticalItems.length})</button>
    <button class="rec-tab" data-tab="rule">🟡 Discipline Rules (${ruleItems.length})</button>
    <button class="rec-tab" data-tab="position">🟢 Position Monitoring (${posItems.length})</button>
    <button class="rec-tab" data-tab="watch">🔵 Market Context (${watchItems.length})</button>
  </div>

  <div class="rec-panel active" id="rec-critical">
    <div class="rec-header critical">🚨 ${esc(es.topAction || 'Action items this week')}</div>
    <ul class="rec-list">${renderTab(criticalItems)}</ul>
  </div>

  <div class="rec-panel" id="rec-rule">
    <div class="rec-header rule">📋 Trading discipline rules</div>
    <ul class="rec-list">${renderTab(ruleItems)}</ul>
  </div>

  <div class="rec-panel" id="rec-position">
    <div class="rec-header position">📂 Open position management</div>
    <ul class="rec-list">${renderTab(posItems)}</ul>
  </div>

  <div class="rec-panel" id="rec-watch">
    <div class="rec-header watch">🌍 Upcoming events & entry targets</div>
    <ul class="rec-list">${renderTab(watchItems)}</ul>
  </div>
</div>`;
}

const recommendationsHtml = renderRecommendations(brief, tradingRules);

function renderCashPanel(b) {
  if (!b || !b.cash) return '';
  const c = b.cash;
  const t = b.totalHousehold || {};
  const money = (n) => '$' + Math.round(n || 0).toLocaleString();

  const collateralRows = (c.collateralBreakdown || [])
    .map(
      (cb) => `
      <tr>
        <td>${cb.position}</td>
        <td class="num negative">−${money(cb.collateral)}</td>
        <td style="font-size:11px;color:var(--text-dim)">${cb.note || ''}</td>
      </tr>`
    )
    .join('');

  return `
<div class="panel span-12" style="border-left:4px solid var(--blue)">
  <h2>💵 Cash & Collateral — ${c.accountName || 'Income Sleeve'}</h2>

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;">
    <div class="brief-cell" style="border-left:3px solid var(--blue)">
      <div class="brief-cell-label">Total Cash (Income Sleeve)</div>
      <div class="brief-cell-value">${money(c.totalIncomeSleeve)}</div>
      <div class="brief-cell-note">Account 2 dedicated to spreads/ICs</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--yellow)">
      <div class="brief-cell-label">Collateral Deployed</div>
      <div class="brief-cell-value" style="color:var(--yellow)">−${money(c.collateralized)}</div>
      <div class="brief-cell-note">${(c.collateralBreakdown || []).length} open CSP${c.collateralBreakdown?.length !== 1 ? 's' : ''}</div>
    </div>
    <div class="brief-cell" style="border-left:3px solid var(--green)">
      <div class="brief-cell-label">Free Cash Available</div>
      <div class="brief-cell-value positive">${money(c.freeCash)}</div>
      <div class="brief-cell-note">for new spread/IC trades</div>
    </div>
  </div>

  ${collateralRows ? `<div style="margin-top:8px;">
    <h4 style="font-size:12px;color:var(--text-dim);text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px 0">Collateral Breakdown</h4>
    <table style="width:100%;font-size:13px;">
      <thead>
        <tr>
          <th>Open Position</th>
          <th class="num">Collateral Reserved</th>
          <th>Note</th>
        </tr>
      </thead>
      <tbody>${collateralRows}</tbody>
    </table>
  </div>` : ''}

  ${t.totalMarketValue ? `
  <div style="margin-top:20px;padding:16px 18px;background:linear-gradient(135deg,rgba(88,166,255,0.12) 0%,rgba(163,113,247,0.12) 100%);border:1px solid var(--border);border-radius:6px;">
    <div style="font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin-bottom:10px">Total Household View</div>
    <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:16px;">
      <div>
        <div style="font-size:11px;color:var(--text-dim)">Stock Value</div>
        <div style="font-size:18px;font-weight:700">${money(t.stockMarketValue)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-dim)">Cash Sleeve</div>
        <div style="font-size:18px;font-weight:700">${money(t.cashIncomeSleeve)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-dim)">Total Market Value</div>
        <div style="font-size:20px;font-weight:700" class="neutral">${money(t.totalMarketValue)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-dim)">Unrealized + Realized</div>
        <div style="font-size:20px;font-weight:700" class="positive">+${money((t.unrealizedStockGain || 0) + (t.realizedOptionsGain || 0) + (t.unrealizedOptionsEstimate || 0))}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--text-dim)">P&L % of stock basis</div>
        <div style="font-size:20px;font-weight:700" class="positive">+${(((t.unrealizedStockGain || 0) / (t.stockMarketValue - t.unrealizedStockGain || 1)) * 100).toFixed(1)}%</div>
      </div>
    </div>
  </div>` : ''}
</div>`;
}

const cashHtml = renderCashPanel(brief);

function renderAlertsConfiguredPanel(b) {
  const ac = b?.alertsConfigured;
  const agents = b?.scheduledAgents || [];
  if (!ac && agents.length === 0) return '';

  const tierColors = {
    risk: 'var(--red)',
    rates: 'var(--yellow)',
    entry: 'var(--green)',
    position: 'var(--purple)'
  };
  const tierLabels = {
    risk: '🔴 Risk Management',
    rates: '🟡 Rates',
    entry: '🟢 Entry Zones',
    position: '🟣 Position Mgmt'
  };

  // Group alerts by tier
  const grouped = {};
  for (const a of ac?.alerts || []) {
    grouped[a.tier] = grouped[a.tier] || [];
    grouped[a.tier].push(a);
  }

  const alertRows = Object.entries(grouped).map(([tier, list]) => {
    const rows = list.map(a => {
      const statusIcon = a.status === 'configured' ? '✅' : a.status === 'triggered' ? '🔔' : '⬜';
      const sym = a.symbol.split(':').pop();
      return `
    <tr>
      <td><span style="font-family:monospace;font-size:11px">${statusIcon}</span></td>
      <td><strong>${sym}</strong></td>
      <td style="font-size:11px;color:var(--text-dim)">${a.condition}</td>
      <td class="num"><strong>$${a.level}</strong></td>
      <td style="font-size:11px">${a.message}</td>
    </tr>`;
    }).join('');
    return `
    <tr><td colspan="5" style="background:var(--panel-hi);padding:6px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:${tierColors[tier] || 'var(--text-dim)'};font-weight:600;">${tierLabels[tier] || tier} (${list.length})</td></tr>
    ${rows}`;
  }).join('');

  // Scheduled agents rendering
  const agentsHtml = agents.map(a => `
    <div class="brief-manage-item" style="border-left-color:${a.enabled ? 'var(--green)' : 'var(--text-dim)'}">
      <strong>${a.enabled ? '🟢' : '⏸️'} ${a.name}</strong>
      <div style="font-size:11px;color:var(--text-dim);margin-top:3px;">
        Schedule: ${a.scheduleHuman}<br/>
        Delivery: ${a.delivery}<br/>
        Runs/week: ${a.runsPerWeek} · Next run: ${new Date(a.nextRun).toLocaleString('en-US',{timeZone:'America/Los_Angeles',dateStyle:'short',timeStyle:'short'})} PT<br/>
        <a href="${a.managementUrl}" target="_blank" style="color:var(--blue);text-decoration:none;">Manage on claude.ai →</a>
      </div>
      <div style="font-size:11px;color:var(--text-dim);margin-top:8px;font-style:italic">${a.description}</div>
    </div>`).join('');

  return `
<div class="panel span-12" style="border-left:4px solid var(--purple)">
  <h2>🔔 Alerts & Scheduled Agents</h2>

  ${agentsHtml ? `
  <div style="margin-bottom:18px;">
    <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin:0 0 10px 0;font-weight:600;">☁️ Scheduled Cloud Agents</h4>
    ${agentsHtml}
  </div>` : ''}

  ${ac ? `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <h4 style="font-size:12px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-dim);margin:0;font-weight:600;">📟 TradingView Price Alerts — ${ac.configured}/${ac.recommended} configured</h4>
      <span style="font-size:11px;color:var(--text-dim);">Create manually in TradingView UI</span>
    </div>
    <div style="background:var(--panel-hi);padding:10px 14px;margin-bottom:10px;border-radius:4px;font-size:12px;color:var(--text-dim);border-left:3px solid var(--yellow);">
      ${ac.summary}
    </div>
    <table style="width:100%;font-size:13px;">
      <thead>
        <tr>
          <th style="width:32px;"></th>
          <th>Symbol</th>
          <th>Condition</th>
          <th class="num">Level</th>
          <th>Alert Message</th>
        </tr>
      </thead>
      <tbody>${alertRows}</tbody>
    </table>
  </div>` : ''}
</div>`;
}

const alertsPanelHtml = renderAlertsConfiguredPanel(brief);

// ═══ Live Charts tab — pulls tickers from brief.perTicker and builds TradingView embed iframes
const chartTimeframe = '240';
const chartTickers = (brief?.perTicker || []).map((t) => t.symbol).filter(Boolean);

function tvResolveSymbol(s) {
  if (!s) return '';
  if (s.includes(':')) return s;
  if (/^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC)USD$/.test(s)) return 'BITSTAMP:' + s;
  if (s === 'SPX') return 'FOREXCOM:SPXUSD';
  if (s === 'VIX') return 'CAPITALCOM:VIX';
  if (s === 'RUT') return 'TVC:RUT';
  if (s === 'QQQ') return 'NASDAQ:QQQ';
  if (['SPY', 'IWM', 'DIA', 'GLD', 'SLV'].includes(s)) return 'AMEX:' + s;
  return s;
}

function buildChartTile(sym) {
  const resolved = tvResolveSymbol(sym);
  const encoded = encodeURIComponent(resolved);
  const src = `https://s.tradingview.com/widgetembed/?symbol=${encoded}&interval=${chartTimeframe}&theme=dark&style=1&locale=en&toolbar_bg=%231e222d&enable_publishing=false&save_image=false&withdateranges=1&hide_side_toolbar=0&allow_symbol_change=1`;
  return `
    <div class="chart-tile">
      <div class="chart-tile-header">
        <span class="chart-tile-symbol">${resolved}</span>
        <a class="chart-tile-link" href="https://www.tradingview.com/chart/?symbol=${encoded}" target="_blank" rel="noopener">Open ↗</a>
      </div>
      <iframe src="${src}" frameborder="0" allowtransparency="true" scrolling="no" loading="lazy"></iframe>
    </div>`;
}

// ═══ Fetch live options chains for all per-ticker symbols ═══
const optionsSkip = ['SPX', 'VIX', 'RUT', 'SOXX', 'KO', 'MRK', 'JNJ']; // indices without standard options on Yahoo
const optionsSymbols = chartTickers.filter((s) => !optionsSkip.includes(s));

// Options cache support: when SKIP_OPTIONS=1, read from options_cache.json instead of fetching
const __optionsCachePath = path.resolve(path.dirname(process.argv[1] || '.'), 'options_cache.json');
let optionsData;
if (process.env.SKIP_OPTIONS === '1' && fs.existsSync(__optionsCachePath)) {
  try {
    optionsData = JSON.parse(fs.readFileSync(__optionsCachePath, 'utf-8'));
    console.log(`[options] using cached data from ${__optionsCachePath}`);
  } catch {
    console.log('[options] cache read failed, fetching fresh...');
    optionsData = await fetchAllOptionsChains(optionsSymbols);
  }
} else {
  optionsData = await fetchAllOptionsChains(optionsSymbols);
  // Write cache for future SKIP_OPTIONS runs
  try {
    fs.writeFileSync(__optionsCachePath, JSON.stringify(optionsData));
    console.log(`[options] cached to ${__optionsCachePath}`);
  } catch (e) {
    console.warn('[options] failed to write cache:', e.message);
  }
}

// Build card shells — tables are rendered client-side from embedded JSON
// Build per-ticker intel lookup from all brief data sources
function buildTickerIntel() {
  const intel = {};
  if (!brief) return intel;
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const es = brief.executiveSummary || {};

  // perTicker reads
  for (const t of (brief.perTicker || [])) {
    const sym = t.symbol || t.ticker;
    if (!intel[sym]) intel[sym] = { reads: [], positions: [], entries: [], events: [], news: [] };
    intel[sym].reads.push({ label: t.label, note: t.note, price: t.price });
  }

  // manageExisting (match ticker from position string)
  for (const m of (es.manageExisting || [])) {
    const match = m.position.match(/^([A-Z]+)/);
    if (match) {
      const sym = match[1];
      if (!intel[sym]) intel[sym] = { reads: [], positions: [], entries: [], events: [], news: [] };
      intel[sym].positions.push({ position: m.position, action: m.action, reasoning: m.reasoning });
    }
  }

  // growthEntries
  for (const g of (es.growthEntries || [])) {
    if (!intel[g.ticker]) intel[g.ticker] = { reads: [], positions: [], entries: [], events: [], news: [] };
    intel[g.ticker].entries.push({ suggested: g.suggested, reasoning: g.reasoning, credit: g.targetCredit, collateral: g.collateral });
  }

  // events (match ticker from name)
  for (const e of (brief.events || [])) {
    // Extract ticker symbols mentioned in parentheses like "JPMorgan (JPM)"
    const paren = e.name.match(/\(([A-Z]{1,5})\)/);
    if (paren) {
      const sym = paren[1];
      if (!intel[sym]) intel[sym] = { reads: [], positions: [], entries: [], events: [], news: [] };
      intel[sym].events.push({ day: e.day, date: e.date, name: e.name, impact: e.impact, action: e.tradingAction });
    }
  }

  // news (from tickerNews fetched earlier)
  for (const [sym, articles] of Object.entries(tickerNews)) {
    if (!intel[sym]) intel[sym] = { reads: [], positions: [], entries: [], events: [], news: [] };
    intel[sym].news = (articles || []).slice(0, 3);
  }

  return intel;
}

// tickerIntelMap is built after news fetch — see below

function renderTickerIntelStrip(sym) {
  const info = tickerIntelMap[sym];
  if (!info) return '';

  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [];

  // Signal badge + brief read
  if (info.reads.length) {
    const r = info.reads[0];
    const labelCls = (r.label || '').toLowerCase().includes('skip') ? 'opt-intel-skip'
      : (r.label || '').toLowerCase().includes('execute') ? 'opt-intel-go'
      : (r.label || '').toLowerCase().includes('watch') ? 'opt-intel-watch'
      : 'opt-intel-neutral';
    parts.push(`<div class="opt-intel-signal ${labelCls}"><span class="opt-intel-badge">${esc(r.label)}</span> ${esc(r.note)}</div>`);
  }

  // Open positions to manage
  for (const p of info.positions) {
    const urgent = /DO NOTHING|NO ACTION|NEVER/i.test(p.action) ? '' : ' opt-intel-urgent';
    parts.push(`<div class="opt-intel-pos${urgent}"><strong>${esc(p.position)}</strong> → ${esc(p.action)}<div class="opt-intel-reason">${esc(p.reasoning)}</div></div>`);
  }

  // New entry suggestion
  for (const e of info.entries) {
    parts.push(`<div class="opt-intel-entry"><strong>Entry target:</strong> ${esc(e.suggested)}<div class="opt-intel-reason">${esc(e.reasoning)}</div><div class="opt-intel-meta">Credit: ${esc(e.credit)} · Collateral: $${(e.collateral || 0).toLocaleString()}</div></div>`);
  }

  // Upcoming events
  for (const ev of info.events) {
    const icon = ev.impact === 'high' ? '🔴' : ev.impact === 'medium' ? '🟡' : '🟢';
    parts.push(`<div class="opt-intel-event">${icon} <strong>${esc(ev.day)} ${esc(ev.date)}</strong> — ${esc(ev.name)}<div class="opt-intel-reason">${esc(ev.action)}</div></div>`);
  }

  // Top news headlines
  if (info.news.length) {
    const headlines = info.news.map(n => {
      const ago = !n.pubDate ? '' : (() => { const ms = Date.now() - new Date(n.pubDate).getTime(); return ms < 3600000 ? Math.floor(ms/60000) + 'm' : ms < 86400000 ? Math.floor(ms/3600000) + 'h' : Math.floor(ms/86400000) + 'd'; })();
      return `<a href="${esc(n.link)}" target="_blank" rel="noopener" class="opt-intel-headline">${ago ? '<span class="opt-intel-ago">' + ago + '</span> ' : ''}${esc(n.title)}</a>`;
    }).join('');
    parts.push(`<div class="opt-intel-news">${headlines}</div>`);
  }

  if (!parts.length) return '';
  return `<div class="opt-intel-strip">${parts.join('')}</div>`;
}

function renderOptionsCardShell(sym) {
  const d = optionsData[sym];
  if (!d) return `<div class="opt-card"><div class="opt-card-header"><strong>${sym}</strong> <span style="color:var(--text-dim)">— no data</span></div></div>`;
  const expOptions = d.expirations.map((exp, i) => {
    const dt = new Date(exp + 'T12:00:00Z');
    const dte = Math.ceil((dt - new Date()) / 86400000);
    const label = exp + (dte > 0 ? ' (' + dte + ' DTE)' : ' (expired)');
    return `<option value="${exp}"${i === 0 ? ' selected' : ''}>${label}</option>`;
  }).join('');
  const intelHtml = renderTickerIntelStrip(sym);
  return `
  <div class="opt-card" data-sym="${sym}">
    <div class="opt-card-header">
      <div><strong>${sym}</strong> <span class="opt-price">$${d.price.toFixed(2)}</span></div>
      <div class="opt-exp-filter">
        <label style="font-size:11px;color:var(--text-dim);margin-right:4px;">Exp:</label>
        <select class="opt-exp-select" data-sym="${sym}">
          ${expOptions}
        </select>
        <label style="font-size:11px;color:var(--text-dim);margin-left:10px;margin-right:4px;">Strikes:</label>
        <select class="opt-strike-select" data-sym="${sym}">
          <option value="5" selected>ATM ±5</option>
          <option value="10">ATM ±10</option>
          <option value="20">ATM ±20</option>
          <option value="0">All</option>
        </select>
      </div>
    </div>
    ${intelHtml}
    <div class="opt-tables" id="opt-tables-${sym}"></div>
  </div>`;
}

const optionsFetched = Object.keys(optionsData).length;
const totalExps = Object.values(optionsData).reduce((s, d) => s + Object.keys(d.chains).length, 0);
const optionsTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });
const optionsJsonBlob = JSON.stringify(optionsData);
// optionsHtml is built after news fetch so ticker intel has access to tickerNews
let optionsHtml; // assigned below

const _optionsScriptHead = `
<script>
(function(){
  const OD = ${optionsJsonBlob};
  const fmt = v => v == null ? '—' : Number(v).toFixed(2);
  const pct = v => v == null ? '—' : (v * 100).toFixed(1) + '%';
  const num = v => v == null ? '—' : Number(v).toLocaleString();
  const thead = '<tr><th class="num">Strike</th><th class="num">Last</th><th class="num">Bid</th><th class="num">Ask</th><th class="num">Vol</th><th class="num">OI</th><th class="num">IV</th></tr>';

  function sliceATM(arr, price, range) {
    if (!arr.length || range === 0) return arr;
    let best = 0;
    for (let i = 1; i < arr.length; i++) {
      if (Math.abs(arr[i].strike - price) < Math.abs(arr[best].strike - price)) best = i;
    }
    return arr.slice(Math.max(0, best - range), best + range + 1);
  }

  function renderTable(arr, price, range) {
    const rows = sliceATM(arr, price, range);
    return rows.map(o => {
      const cls = o.itm ? ' class="opt-itm"' : '';
      return '<tr' + cls + '><td class="num">' + fmt(o.strike) + '</td><td class="num">' + fmt(o.last) + '</td><td class="num">' + fmt(o.bid) + '</td><td class="num">' + fmt(o.ask) + '</td><td class="num">' + num(o.vol) + '</td><td class="num">' + num(o.oi) + '</td><td class="num">' + pct(o.iv) + '</td></tr>';
    }).join('');
  }

  function renderCard(sym, exp) {
    const d = OD[sym];
    if (!d) return;
    const chain = d.chains[exp];
    if (!chain) return;
    const strikeSel = document.querySelector('.opt-strike-select[data-sym="' + sym + '"]');
    const range = strikeSel ? parseInt(strikeSel.value) || 5 : 5;
    const el = document.getElementById('opt-tables-' + sym);
    if (!el) return;
    el.innerHTML =
      '<div><div class="opt-side-label call-label">CALLS</div><table><thead>' + thead + '</thead><tbody>' + renderTable(chain.calls, d.price, range) + '</tbody></table></div>' +
      '<div><div class="opt-side-label put-label">PUTS</div><table><thead>' + thead + '</thead><tbody>' + renderTable(chain.puts, d.price, range) + '</tbody></table></div>';
  }

  function renderAll() {
    document.querySelectorAll('.opt-exp-select').forEach(sel => {
      renderCard(sel.dataset.sym, sel.value);
    });
  }

  // Expiration dropdown change
  document.querySelectorAll('.opt-exp-select').forEach(sel => {
    sel.addEventListener('change', () => renderCard(sel.dataset.sym, sel.value));
  });

  // Per-card strike range change
  document.querySelectorAll('.opt-strike-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const sym = sel.dataset.sym;
      const expSel = document.querySelector('.opt-exp-select[data-sym="' + sym + '"]');
      if (expSel) renderCard(sym, expSel.value);
    });
  });

  // Initial render
  renderAll();
})();
</script>`;

// ═══ Fetch news ═══
const [tickerNews, breakingNews] = await Promise.all([
  fetchTickerNews(chartTickers, 5),
  fetchBreakingNews(),
]);

// Now build tickerIntelMap and optionsHtml (needs tickerNews for per-card news)
const tickerIntelMap = buildTickerIntel();
optionsHtml = `
<div class="panel span-12">
  <h2>⛓ Options Chains</h2>
  <div style="color:var(--text-dim);font-size:12px;margin-bottom:12px;">
    ${optionsFetched}/${optionsSymbols.length} symbols · ${totalExps} total expirations fetched · Data as of ${optionsTimestamp} ET · Rebuild dashboard for fresh data
  </div>
  <div class="opt-grid">
    ${optionsSymbols.map(renderOptionsCardShell).join('\n')}
  </div>
</div>
` + _optionsScriptHead;
const newsTimestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' });

function escHtml(s) { return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function timeAgo(pubDate) {
  if (!pubDate) return '';
  const ms = Date.now() - new Date(pubDate).getTime();
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm ago';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h ago';
  return Math.floor(ms / 86400000) + 'd ago';
}

function renderNewsItem(item) {
  return `<div class="news-item">
    <a href="${escHtml(item.link)}" target="_blank" rel="noopener" class="news-title">${escHtml(item.title)}</a>
    <div class="news-meta">${timeAgo(item.pubDate)} · ${escHtml(item.desc)}</div>
  </div>`;
}

const breakingHtml = breakingNews.length
  ? breakingNews.map(renderNewsItem).join('')
  : '<div style="color:var(--text-dim);padding:12px;">No breaking news found.</div>';

const tickerNewsCards = chartTickers.map((sym) => {
  const articles = tickerNews[sym];
  if (!articles || !articles.length) return '';
  return `<div class="news-ticker-card">
    <div class="news-ticker-header">${sym}</div>
    ${articles.map(renderNewsItem).join('')}
  </div>`;
}).filter(Boolean).join('');

const newsHtml = `
<div class="panel span-12">
  <h2>🚨 Breaking & Geopolitical News</h2>
  <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">As of ${newsTimestamp} ET · Rebuild dashboard for latest</div>
  <div class="news-list">${breakingHtml}</div>
</div>
<div class="panel span-12">
  <h2>📰 Per-Ticker News</h2>
  <div style="color:var(--text-dim);font-size:12px;margin-bottom:8px;">${Object.keys(tickerNews).length} tickers with news · Yahoo Finance RSS</div>
  <div class="news-filter-bar">
    <input type="text" id="news-ticker-filter" placeholder="Filter by ticker..." class="news-filter-input" />
  </div>
  <div class="news-ticker-grid" id="news-ticker-grid">${tickerNewsCards}</div>
</div>`;

const chartsHtml = `
<div class="panel span-12">
  <h2>📈 Live Charts — Per-Ticker Read</h2>
  <div style="color:var(--text-dim);font-size:12px;margin-bottom:12px;">Interval: ${chartTimeframe}m · ${chartTickers.length} tickers from this morning's brief</div>
  <div class="chart-grid">
    ${chartTickers.map(buildChartTile).join('\n')}
  </div>
</div>`;

// ---------- futures section (live TradingView streaming widgets) ----------

const futuresGroups = [
  {
    label: 'Index Futures — market direction & overnight gaps',
    contracts: [
      { symbol: 'CME_MINI:ES1!', name: 'S&P 500 E-mini', why: 'Overall market — sets tone for all positions' },
      { symbol: 'CME_MINI:NQ1!', name: 'Nasdaq 100 E-mini', why: 'Tech-heavy — MSFT, GOOGL, AMZN, META, NVDA' },
      { symbol: 'CBOT_MINI:YM1!', name: 'Dow E-mini', why: 'Blue chips — JPM, UNH, V, CAT, HON' },
      { symbol: 'CME_MINI:RTY1!', name: 'Russell 2000 E-mini', why: 'Breadth — small caps confirm or diverge from large' },
    ],
  },
  {
    label: 'Volatility — premium selling conditions',
    contracts: [
      { symbol: 'CBOE:VIX', name: 'VIX (spot)', why: 'Premium gauge — above 20 = fat premiums, below 15 = thin' },
      { symbol: 'CFE:VX1!', name: 'VIX Front-Month Future', why: 'Contango/backwardation — term structure shapes theta' },
    ],
  },
  {
    label: 'Rates — options pricing & sector rotation',
    contracts: [
      { symbol: 'CBOT:ZN1!', name: '10-Year T-Note', why: 'Rates direction — drives MSFT/tech valuations' },
      { symbol: 'CBOT:ZB1!', name: '30-Year T-Bond', why: 'Long end — risk appetite signal' },
    ],
  },
  {
    label: 'Commodities — geopolitical & portfolio hedges',
    contracts: [
      { symbol: 'NYMEX:CL1!', name: 'Crude Oil WTI', why: 'Iran/ceasefire proxy — directly affects ET (5,000 shares)' },
      { symbol: 'COMEX:GC1!', name: 'Gold', why: 'Risk-off gauge — spikes signal hedging demand' },
    ],
  },
  {
    label: 'Crypto — CIFR correlation',
    contracts: [
      { symbol: 'CME:BTC1!', name: 'Bitcoin Futures', why: 'CIFR (557 shares + 5 CCs) tracks BTC closely' },
    ],
  },
];

function buildFuturesTile(contract) {
  const encoded = encodeURIComponent(contract.symbol);
  const src = `https://s.tradingview.com/widgetembed/?symbol=${encoded}&interval=D&theme=dark&style=1&locale=en&toolbar_bg=%231e222d&enable_publishing=false&save_image=false&withdateranges=1&hide_side_toolbar=1&allow_symbol_change=0&studies=MAExp%407%7CClose%7C0%7C%234caf50%7C%234caf50%7Ctrue%7C0~MAExp%4021%7CClose%7C0%7C%23ffc107%7C%23ffc107%7Ctrue%7C0`;
  return `
    <div class="futures-tile">
      <div class="futures-tile-header">
        <div>
          <span class="futures-tile-name">${contract.name}</span>
          <span class="futures-tile-sym">${contract.symbol.split(':').pop()}</span>
        </div>
        <a class="chart-tile-link" href="https://www.tradingview.com/chart/?symbol=${encoded}" target="_blank" rel="noopener">Open ↗</a>
      </div>
      <div class="futures-tile-why">${contract.why}</div>
      <iframe src="${src}" frameborder="0" allowtransparency="true" scrolling="no" loading="lazy"></iframe>
    </div>`;
}

const futuresHtml = `
<div class="panel span-12">
  <h2>🔮 Futures — Live Streaming Data</h2>
  <div style="color:var(--text-dim);font-size:12px;margin-bottom:16px;">
    Real-time feeds — prices stream live while this tab is open. Grouped by how they affect your wheel strategy.
  </div>
  ${futuresGroups.map(g => `
    <div class="futures-group">
      <div class="futures-group-label">${g.label}</div>
      <div class="futures-grid">
        ${g.contracts.map(buildFuturesTile).join('\n')}
      </div>
    </div>
  `).join('\n')}
</div>`;

// ---------- trade alert banner ----------

function buildAlertBanner() {
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const alerts = [];

  if (!brief) return '';

  const es = brief.executiveSummary || {};
  const now = new Date();

  // Kill switches (highest urgency)
  for (const k of (brief.killSwitches || [])) {
    if (k.active) {
      alerts.push({ urgency: 'red', icon: '🚨', text: esc(k.name) });
    }
  }

  // Top action
  if (es.topAction) {
    const cls = /skip|no new|pause/i.test(es.topAction) ? 'red' : /watch|wait/i.test(es.topAction) ? 'yellow' : 'green';
    alerts.push({ urgency: cls, icon: '📋', text: `TODAY: ${esc(es.topAction)}` });
  }

  // Manage existing — only urgent ones
  for (const m of (es.manageExisting || [])) {
    if (/check|monitor|close|roll/i.test(m.action) && !/no action|do nothing|never|hands off/i.test(m.action)) {
      alerts.push({ urgency: 'yellow', icon: '⚡', text: `${esc(m.position)} → ${esc(m.action)}` });
    }
  }

  // Trades to execute
  for (const t of (es.trades || [])) {
    if (/execute/i.test(t.action)) {
      alerts.push({ urgency: 'green', icon: '✅', text: `EXECUTE: ${esc(t.strategy)} — ${esc(t.reasoning).slice(0, 80)}` });
    } else if (/skip/i.test(t.action)) {
      alerts.push({ urgency: 'red', icon: '🛑', text: `SKIP: ${esc(t.strategy)} — ${esc(t.reasoning).slice(0, 80)}` });
    }
  }

  // Growth entries with timing
  for (const g of (es.growthEntries || [])) {
    if (/wait|after/i.test(g.suggested)) {
      alerts.push({ urgency: 'yellow', icon: '⏳', text: `${esc(g.ticker)}: ${esc(g.suggested).slice(0, 90)}` });
    } else {
      alerts.push({ urgency: 'green', icon: '🎯', text: `${esc(g.ticker)}: ${esc(g.suggested).slice(0, 90)}` });
    }
  }

  // Events this week
  for (const e of (brief.events || [])) {
    if (e.impact === 'high') {
      alerts.push({ urgency: 'yellow', icon: '📅', text: `${esc(e.day)} ${esc(e.date)}: ${esc(e.name)} — ${esc(e.tradingAction).slice(0, 70)}` });
    }
  }

  // Per-ticker MR flags and signals
  for (const t of (brief.perTicker || [])) {
    if (/MR.*EXTENDED|EXTREMELY/i.test(t.label)) {
      alerts.push({ urgency: 'red', icon: '📊', text: `${esc(t.symbol)} MEAN-REVERSION EXTENDED — do not chase` });
    } else if (/EXECUTE/i.test(t.label)) {
      alerts.push({ urgency: 'green', icon: '💰', text: `${esc(t.symbol)}: ${esc(t.label)} — ${esc(t.note).slice(0, 70)}` });
    }
  }

  // Breaking news (top 3)
  for (const n of (breakingNews || []).slice(0, 3)) {
    alerts.push({ urgency: 'blue', icon: '📰', text: esc(n.title) });
  }

  // Coiled Springs high-score alerts
  for (const c of (coiledSpringResults?.results || [])) {
    if ((c.probability_score || c.score) >= 65) {
      const band = c.confidence_band ? `${c.confidence_band.low}-${c.confidence_band.mid}-${c.confidence_band.high}%` : `${c.probability_score || c.score}`;
      alerts.push({ urgency: 'green', icon: '🌀', text: `${esc(c.symbol)} ${band} — ${esc(c.play).slice(0, 70)}` });
    }
  }

  if (!alerts.length) return '';

  // Duplicate the items so the scroll loops seamlessly
  const items = alerts.map(a =>
    `<span class="alert-item alert-${a.urgency}">${a.icon} ${a.text}</span>`
  ).join('<span class="alert-sep">│</span>');

  return `
<div class="alert-banner" id="alert-banner">
  <div class="alert-banner-label">⚡ LIVE ALERTS</div>
  <div class="alert-banner-track">
    <div class="alert-banner-scroll" id="alert-scroll">
      ${items}<span class="alert-sep">│</span>${items}
    </div>
  </div>
</div>`;
}

const alertBannerHtml = buildAlertBanner();

// ---------- Coiled Springs renderer ----------

function renderCoiledSpringCard(c) {
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Classification badge
  const classMap = {
    coiled_spring: { label: 'COILED SPRING', bg: 'rgba(46,204,113,0.2)', color: '#2ecc71' },
    building_base: { label: 'BUILDING BASE', bg: 'rgba(241,196,15,0.2)', color: '#f1c40f' },
    catalyst_loaded: { label: 'CATALYST LOADED', bg: 'rgba(59,130,246,0.2)', color: '#3b82f6' },
    extended: { label: 'EXTENDED', bg: 'rgba(231,76,60,0.2)', color: '#e74c3c' },
    disqualified: { label: 'DISQUALIFIED', bg: 'rgba(107,114,128,0.2)', color: '#6b7280' },
  };
  const cls = classMap[c.setup_type || c.classification] || classMap.building_base;

  // Score color — use probability_score (0-100) if available, else composite (0-120)
  const prob = c.probability_score || c.score;
  const isProb = !!c.probability_score;
  let scoreColor = '#e74c3c';
  if (isProb) {
    if (prob >= 80) scoreColor = '#2ecc71';
    else if (prob >= 65) scoreColor = '#f1c40f';
    else if (prob >= 50) scoreColor = '#e67e22';
  } else {
    if (prob >= 90) scoreColor = '#2ecc71';
    else if (prob >= 70) scoreColor = '#f1c40f';
    else if (prob >= 50) scoreColor = '#e67e22';
  }

  // Setup quality badge color
  const qualityColorMap = { ELITE: '#2ecc71', HIGH: '#f1c40f', MODERATE: '#e67e22', LOW: '#e74c3c' };
  const qualityColor = qualityColorMap[c.setup_quality] || '#6b7280';

  // Confidence border
  let borderStyle = '1px solid var(--border)';
  let dimOverlay = '';
  const conf = c.composite_confidence || c.scoreConfidence;
  if (conf === 'high') borderStyle = '2px solid #2ecc71';
  else if (conf === 'medium') borderStyle = '2px dashed #f1c40f';
  else if (conf === 'low') {
    borderStyle = '1px solid var(--border)';
    dimOverlay = 'opacity:0.7;';
  }

  const changePctStr = c.changePct >= 0 ? `+${c.changePct.toFixed(2)}%` : `${c.changePct.toFixed(2)}%`;
  const changeColor = c.changePct >= 0 ? 'var(--green)' : 'var(--red, #e74c3c)';

  // 5-category signal bars with distinct colors
  const signals = c.signals || {};
  const bars = [
    { label: 'Trend',       value: signals.trendHealth || 0,        max: 30, color: '#3b82f6' },
    { label: 'Contraction', value: signals.contraction || 0,        max: 40, color: '#f59e0b' },
    { label: 'Volume',      value: signals.volumeSignature || 0,    max: 20, color: '#8b5cf6' },
    { label: 'Pivot',       value: signals.pivotProximity || 0,     max: 15, color: '#2ecc71' },
    { label: 'Catalyst',    value: signals.catalystAwareness || 0,  max: 15, color: '#6b7280' },
  ];
  const barsHtml = bars.map(b => {
    const pct = Math.min(100, (b.value / b.max) * 100);
    return `<div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim);margin-bottom:2px;">
        <span>${b.label}</span><span>${b.value}/${b.max}</span>
      </div>
      <div class="exp-bar-track"><div class="exp-bar-fill" style="width:${pct}%;background:${b.color};"></div></div>
    </div>`;
  }).join('');

  // Breakout risk indicator
  const riskColorMap = { low: '#2ecc71', medium: '#f1c40f', high: '#e74c3c' };
  const riskColor = riskColorMap[c.breakoutRisk] || '#6b7280';
  const riskDrivers = (c.breakoutRiskDrivers || []).map(d => esc(d.replace(/_/g, ' '))).join(', ');
  const riskHtml = `<div style="font-size:11px;margin-bottom:6px;">
    <span style="color:${riskColor};font-weight:700;">&#9679; Risk: ${esc((c.breakoutRisk || 'unknown').toUpperCase())}</span>
    ${riskDrivers ? `<span style="color:var(--text-dim);margin-left:6px;">${riskDrivers}</span>` : ''}
  </div>`;

  // Red flags as warning badges
  const redFlagsHtml = (c.redFlags || []).length ? `<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;">
    ${c.redFlags.map(f => `<span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:rgba(241,196,15,0.2);color:#f1c40f;">&#9888; ${esc(f.replace(/_/g, ' ').toUpperCase())}</span>`).join('')}
  </div>` : '';

  // Key metrics
  const d = c.details || {};
  // v3.1 metrics: entry trigger, risk category, stop range
  const entryHtml = c.entry_trigger ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">📍 ${esc(c.entry_trigger)}${c.suggested_stop_percent ? ` &nbsp;|&nbsp; Stop: ${c.suggested_stop_percent[0]}–${c.suggested_stop_percent[1]}%` : ''}</div>` : '';

  // v3.1 catalyst tag
  const catTagMap = { catalyst_present: { icon: '🟢', text: 'Catalyst' }, catalyst_weak: { icon: '🟡', text: 'Weak catalyst' }, catalyst_unknown: { icon: '⚪', text: 'No catalyst' } };
  const catTag = catTagMap[c.catalyst_tag] || null;
  const catTagHtml = catTag ? `<span style="font-size:10px;margin-left:6px;">${catTag.icon} ${catTag.text}</span>` : '';

  const metricsHtml = `<div class="exp-metrics">
    Dist res: ${d.distFromResistance != null ? d.distFromResistance.toFixed(1) + '%' : '—'} &nbsp;|&nbsp;
    ATR: ${d.atrRatio != null ? d.atrRatio.toFixed(2) : '—'} &nbsp;|&nbsp;
    VCP: ${d.vcpContractions != null ? d.vcpContractions + 'x' : '—'} &nbsp;|&nbsp;
    VolDrought: ${d.volDroughtRatio != null ? d.volDroughtRatio.toFixed(2) : '—'} &nbsp;|&nbsp;
    AccDist: ${d.accDistScore != null ? d.accDistScore.toFixed(2) : (d.accumulationDays != null ? d.accumulationDays + 'd' : '—')}
    ${d.parkinsonRatio != null ? `&nbsp;|&nbsp; PV: ${d.parkinsonRatio.toFixed(3)}` : ''}
    ${catTagHtml}
  </div>`;

  // News (top 2)
  const newsItems = (c.news || []).slice(0, 2);
  const newsHtml = newsItems.length ? `<div class="exp-news">${newsItems.map(n => {
    const ago = n.pubDate ? timeAgo(n.pubDate) : '';
    return `<a class="exp-news-link" href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}${ago ? ` <span class="exp-news-ago">${ago}</span>` : ''}</a>`;
  }).join('')}</div>` : '';

  // Confidence label for low
  const confLabel = c.scoreConfidence === 'low' ? '<div style="font-size:10px;color:var(--text-dim);text-align:center;margin-top:2px;">limited data</div>' : '';

  return `<div class="exp-card" data-classification="${esc(c.setup_type || c.classification)}" style="border:${borderStyle};${dimOverlay}">
    <div class="exp-card-header">
      <div>
        <span style="font-size:18px;font-weight:700;">${esc(c.symbol)}</span>
        <span style="font-size:12px;color:var(--text-dim);margin-left:6px;">${esc(c.name)}</span>
        <div style="margin-top:4px;">
          <span style="font-size:15px;font-weight:600;">$${(c.price || 0).toFixed(2)}</span>
          <span style="font-size:12px;color:${changeColor};margin-left:6px;">${changePctStr}</span>
        </div>
        <div style="margin-top:4px;">
          <span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${cls.bg};color:${cls.color};">${cls.label}</span>
        </div>
      </div>
      <div style="text-align:center;">
        <div class="exp-score" style="background:${scoreColor};">${isProb ? prob + '%' : prob}</div>
        ${c.confidence_band ? `<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">${c.confidence_band.low}–${c.confidence_band.high}%</div>` : ''}
        ${c.setup_quality ? `<div style="font-size:10px;font-weight:700;color:${qualityColor};margin-top:2px;">${c.setup_quality}</div>` : ''}
        ${confLabel}
      </div>
    </div>
    <div class="exp-signals">${barsHtml}</div>
    ${riskHtml}
    ${redFlagsHtml}
    ${c.play ? `<div class="exp-play">${esc(c.play)}</div>` : ''}
    ${entryHtml}
    ${c.notes ? `<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;font-style:italic;">${esc(c.notes)}</div>` : ''}
    ${metricsHtml}
    ${newsHtml}
  </div>`;
}

function buildCoiledSpringHtml() {
  if (!coiledSpringResults || !coiledSpringResults.results?.length) {
    return `<div class="panel span-12">
      <h2>🌀 Coiled Springs</h2>
      <p style="color:var(--text-dim);padding:20px;">No coiled spring scan results found. Run the scanner to populate this tab.</p>
    </div>`;
  }
  const r = coiledSpringResults;

  // Market regime banner
  const mr = r.marketRegime || {};
  const regimeMap = {
    constructive: { bg: 'rgba(46,204,113,0.15)', border: '#2ecc71', text: `Market Regime: Constructive (VIX ${mr.vixLevel || '—'})` },
    cautious:     { bg: 'rgba(241,196,15,0.15)', border: '#f1c40f', text: `Cautious — reduced conviction (VIX ${mr.vixLevel || '—'})` },
    defensive:    { bg: 'rgba(231,76,60,0.15)',  border: '#e74c3c', text: `DEFENSIVE REGIME — NO NEW ENTRIES (VIX ${mr.vixLevel || '—'})` },
  };
  const regime = regimeMap[mr.regime] || regimeMap.constructive;
  const regimeBanner = `<div style="padding:12px 20px;margin-bottom:16px;border-radius:8px;background:${regime.bg};border-left:4px solid ${regime.border};font-weight:600;font-size:14px;">
    ${regime.text}
  </div>`;

  const benchmarks = r.benchmarks || {};
  const benchStr = benchmarks.spy20dReturn != null ? `SPY 20d: ${(benchmarks.spy20dReturn * 100).toFixed(1)}%` : '';
  const benchStr2 = benchmarks.qqq20dReturn != null ? `QQQ 20d: ${(benchmarks.qqq20dReturn * 100).toFixed(1)}%` : '';
  const regimeMult = r.regimeMultiplier != null ? `Multiplier: ${r.regimeMultiplier}x` : '';

  const meta = `<div style="color:var(--text-dim);font-size:12px;margin-bottom:16px;">
    Scanned: ${r.scanDate || '—'} &nbsp;|&nbsp;
    Universe: ${r.universe || '—'} → Stage 1: ${r.stage1Passed || '—'} → Qualified: ${r.results.length}
    ${benchStr ? `&nbsp;|&nbsp; ${benchStr}` : ''}${benchStr2 ? ` &nbsp;|&nbsp; ${benchStr2}` : ''}${regimeMult ? ` &nbsp;|&nbsp; ${regimeMult}` : ''}
  </div>`;
  const filters = `<div style="margin-bottom:16px;display:flex;gap:6px;flex-wrap:wrap;">
    <button class="exp-filter active" data-filter="all">All</button>
    <button class="exp-filter" data-filter="coiled_spring">Coiled Spring</button>
    <button class="exp-filter" data-filter="building_base">Building Base</button>
    <button class="exp-filter" data-filter="catalyst_loaded">Catalyst Loaded</button>
  </div>`;
  const cards = r.results.map(renderCoiledSpringCard).join('\n');
  return `<div class="panel span-12">
    <h2>🌀 Coiled Springs</h2>
    ${regimeBanner}
    ${meta}
    ${filters}
    <div class="exp-grid">${cards}</div>
  </div>`;
}

const coiledSpringHtml = buildCoiledSpringHtml();

// ---------- generate HTML ----------

const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="900">
<title>Queen Mommy Trading Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117;
    --panel: #161b22;
    --panel-hi: #1c232c;
    --border: #30363d;
    --text: #e6edf3;
    --text-dim: #8b949e;
    --green: #3fb950;
    --red: #f85149;
    --blue: #58a6ff;
    --yellow: #d29922;
    --purple: #a371f7;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    margin: 0;
    padding: 24px;
    line-height: 1.5;
  }
  header { max-width: 1600px; margin: 0 auto 24px; }
  h1 { font-size: 28px; font-weight: 600; margin: 0 0 4px 0; }

  /* Trade Alert Banner */
  .alert-banner {
    display: flex;
    align-items: stretch;
    background: linear-gradient(90deg, #1a1a2e 0%, #16213e 100%);
    border-top: 1px solid rgba(255,255,255,0.06);
    border-bottom: 1px solid rgba(255,255,255,0.06);
    overflow: hidden;
    position: sticky;
    top: 0;
    z-index: 100;
  }
  .alert-banner-label {
    flex-shrink: 0;
    background: linear-gradient(135deg, #e53935 0%, #c62828 100%);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 1px;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    white-space: nowrap;
    text-shadow: 0 1px 2px rgba(0,0,0,0.3);
    animation: alert-pulse 2s ease-in-out infinite;
  }
  @keyframes alert-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.8; }
  }
  .alert-banner-track {
    flex: 1;
    overflow: hidden;
    position: relative;
    mask-image: linear-gradient(90deg, transparent 0%, black 3%, black 97%, transparent 100%);
    -webkit-mask-image: linear-gradient(90deg, transparent 0%, black 3%, black 97%, transparent 100%);
  }
  .alert-banner-scroll {
    display: inline-flex;
    align-items: center;
    white-space: nowrap;
    animation: alert-scroll var(--scroll-duration, 60s) linear infinite;
    padding: 9px 0;
  }
  .alert-banner-scroll:hover { animation-play-state: paused; }
  @keyframes alert-scroll {
    0% { transform: translateX(0); }
    100% { transform: translateX(-50%); }
  }
  .alert-item {
    font-size: 12px;
    font-weight: 500;
    padding: 3px 10px;
    border-radius: 3px;
    display: inline-block;
    line-height: 1.4;
  }
  .alert-red { color: #ff6b6b; background: rgba(229,57,53,0.1); }
  .alert-yellow { color: #ffd54f; background: rgba(255,213,79,0.08); }
  .alert-green { color: #69f0ae; background: rgba(105,240,174,0.08); }
  .alert-blue { color: #64b5f6; background: rgba(100,181,246,0.08); }
  .alert-sep {
    color: rgba(255,255,255,0.12);
    margin: 0 12px;
    font-size: 14px;
    user-select: none;
  }
  .subtitle { color: var(--text-dim); font-size: 14px; }
  .container { max-width: 1600px; margin: 0 auto; display: grid; grid-template-columns: repeat(12, 1fr); gap: 16px; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 20px;
  }
  .panel h2 {
    font-size: 14px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin: 0 0 12px 0;
  }
  .kpi {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    grid-column: span 12;
  }
  .kpi .panel {
    text-align: center;
    padding: 24px 20px;
  }
  .kpi-label {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin-bottom: 8px;
  }
  .kpi-value {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .kpi-sub {
    font-size: 12px;
    color: var(--text-dim);
    margin-top: 4px;
  }
  .positive { color: var(--green); }
  .negative { color: var(--red); }
  .neutral { color: var(--blue); }
  .span-12 { grid-column: span 12; }
  .span-8 { grid-column: span 8; }
  .span-6 { grid-column: span 6; }
  .span-4 { grid-column: span 4; }
  .span-3 { grid-column: span 3; }
  canvas { max-width: 100%; }
  .chart-wrap { position: relative; height: 300px; }
  .chart-wrap-lg { position: relative; height: 400px; }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  th {
    text-align: left;
    padding: 8px 12px;
    background: var(--panel-hi);
    border-bottom: 1px solid var(--border);
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
  }
  th.num { text-align: right; }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tr:hover td { background: var(--panel-hi); }
  .table-wrap { max-height: 500px; overflow-y: auto; }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
  }
  .badge-csp { background: rgba(88, 166, 255, 0.15); color: var(--blue); }
  .badge-call { background: rgba(163, 113, 247, 0.15); color: var(--purple); }
  .badge-put { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .badge-calltype { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
  .filter-bar {
    display: flex;
    gap: 12px;
    margin-bottom: 12px;
    align-items: center;
  }
  button {
    background: var(--panel-hi);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 6px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
  }
  button.active { background: var(--blue); color: white; border-color: var(--blue); }
  button:hover:not(.active) { background: #2a3038; }
  .insight {
    background: var(--panel-hi);
    border-left: 3px solid var(--yellow);
    padding: 12px 16px;
    margin-bottom: 12px;
    font-size: 13px;
    border-radius: 4px;
  }
  .insight.good { border-left-color: var(--green); }
  .insight.bad { border-left-color: var(--red); }
  .insight strong { color: var(--text); }
  .rec-header {
    font-size: 14px;
    font-weight: 600;
    margin: 0 0 12px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .rec-header.critical { color: var(--red); }
  .rec-header.rule { color: var(--yellow); }
  .rec-header.position { color: var(--green); }
  .rec-header.watch { color: var(--blue); }
  .rec-list {
    list-style: none;
    padding: 0;
    margin: 0 0 20px 0;
  }
  .rec-item {
    background: var(--panel-hi);
    border-left: 3px solid var(--border);
    padding: 10px 14px;
    margin-bottom: 8px;
    border-radius: 4px;
    font-size: 13px;
  }
  .rec-item.critical { border-left-color: var(--red); }
  .rec-item.rule { border-left-color: var(--yellow); }
  .rec-item.position { border-left-color: var(--green); }
  .rec-item.watch { border-left-color: var(--blue); }
  .rec-item strong { color: var(--text); display: block; margin-bottom: 4px; }
  .rec-item .why { color: var(--text-dim); font-size: 12px; }
  .rec-row { display: flex; gap: 12px; align-items: flex-start; }
  .rec-num {
    background: var(--border);
    color: var(--text-dim);
    border-radius: 4px;
    padding: 2px 8px;
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
    min-width: 28px;
    text-align: center;
  }
  .rec-item.critical .rec-num { background: rgba(248, 81, 73, 0.2); color: var(--red); }
  .rec-item.rule .rec-num { background: rgba(210, 153, 34, 0.2); color: var(--yellow); }
  .rec-item.position .rec-num { background: rgba(63, 185, 80, 0.2); color: var(--green); }
  .rec-item.watch .rec-num { background: rgba(88, 166, 255, 0.2); color: var(--blue); }
  .rec-tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .rec-tab {
    padding: 8px 16px;
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
  }
  .rec-tab.active { color: var(--text); border-bottom-color: var(--blue); }
  .rec-tab:hover { color: var(--text); }
  .rec-panel { display: none; }
  .rec-panel.active { display: block; }

  /* Morning Brief section */
  .brief-container { grid-column: span 12; }
  .brief-panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0;
    overflow: hidden;
  }
  .brief-header {
    background: linear-gradient(135deg, #1c2b4a 0%, #1a1f2e 100%);
    padding: 20px 24px;
    border-bottom: 1px solid var(--border);
  }
  .brief-title {
    font-size: 22px;
    font-weight: 700;
    margin: 0;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .brief-meta {
    color: var(--text-dim);
    font-size: 12px;
    margin-top: 6px;
  }
  .brief-stale {
    background: rgba(210, 153, 34, 0.15);
    border-left: 3px solid var(--yellow);
    color: var(--yellow);
    padding: 10px 16px;
    font-size: 12px;
    margin: 0;
  }
  .brief-missing {
    padding: 48px 24px;
    text-align: center;
    color: var(--text-dim);
  }
  .brief-missing h3 {
    color: var(--text);
    font-size: 18px;
    margin: 0 0 8px 0;
  }
  .brief-body { padding: 20px 24px; }
  .brief-oneliner {
    background: rgba(88, 166, 255, 0.1);
    border-left: 4px solid var(--blue);
    padding: 14px 18px;
    margin: 0 0 20px 0;
    border-radius: 4px;
    font-size: 15px;
    font-weight: 500;
    color: var(--text);
  }
  .brief-grid {
    display: grid;
    grid-template-columns: repeat(8, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }
  .brief-cell {
    background: var(--panel-hi);
    border-radius: 6px;
    padding: 12px;
    text-align: center;
    border: 1px solid var(--border);
  }
  .brief-cell-label {
    font-size: 10px;
    text-transform: uppercase;
    color: var(--text-dim);
    letter-spacing: 0.05em;
    margin-bottom: 4px;
  }
  .brief-cell-value {
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }
  .brief-cell-note {
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 2px;
  }
  .brief-section {
    margin-bottom: 24px;
  }
  .brief-section h4 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    margin: 0 0 10px 0;
    font-weight: 600;
  }
  .brief-trade-card {
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-left: 4px solid var(--blue);
    border-radius: 6px;
    padding: 16px 20px;
    margin-bottom: 10px;
  }
  .brief-trade-card.skip { border-left-color: var(--red); }
  .brief-trade-card.execute { border-left-color: var(--green); }
  .brief-trade-title {
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .brief-trade-action {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    margin-right: 8px;
  }
  .brief-trade-action.skip { background: rgba(248, 81, 73, 0.2); color: var(--red); }
  .brief-trade-action.execute { background: rgba(63, 185, 80, 0.2); color: var(--green); }
  .brief-trade-action.wait { background: rgba(210, 153, 34, 0.2); color: var(--yellow); }
  .brief-trade-reason { font-size: 13px; color: var(--text-dim); margin-top: 8px; }
  .brief-manage-item {
    background: var(--panel-hi);
    border-left: 3px solid var(--yellow);
    padding: 10px 14px;
    margin-bottom: 8px;
    border-radius: 4px;
    font-size: 13px;
  }
  .brief-manage-item strong { color: var(--text); display: block; margin-bottom: 3px; }
  .brief-manage-item .action { color: var(--yellow); font-weight: 600; font-size: 12px; }
  .brief-manage-item .reason { color: var(--text-dim); font-size: 12px; margin-top: 4px; }
  .brief-entry-item {
    background: var(--panel-hi);
    border-left: 3px solid var(--green);
    padding: 10px 14px;
    margin-bottom: 8px;
    border-radius: 4px;
    font-size: 13px;
  }
  .brief-entry-item strong { color: var(--green); }
  .brief-entry-item code {
    background: #0d1117;
    padding: 2px 8px;
    border-radius: 3px;
    font-family: 'SFMono-Regular', Menlo, monospace;
    font-size: 12px;
    color: var(--text);
  }
  .brief-events {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
  }
  .brief-event {
    background: var(--panel-hi);
    border-radius: 4px;
    padding: 10px 12px;
    border-left: 3px solid var(--border);
    font-size: 12px;
  }
  .brief-event.critical { border-left-color: var(--red); }
  .brief-event.high { border-left-color: var(--yellow); }
  .brief-event.low { border-left-color: var(--green); }
  .brief-event .date { font-weight: 700; color: var(--text); }
  .brief-event .name { color: var(--text); margin-top: 2px; }
  .brief-event .action { color: var(--text-dim); font-size: 11px; margin-top: 4px; }
  .brief-ticker-table {
    font-size: 12px;
  }
  .brief-ticker-table td {
    padding: 5px 10px;
  }
  .brief-label {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
  }
  .brief-label.skip { background: rgba(248, 81, 73, 0.15); color: var(--red); }
  .brief-label.wait { background: rgba(210, 153, 34, 0.15); color: var(--yellow); }
  .brief-label.execute,
  .brief-label.enter { background: rgba(63, 185, 80, 0.15); color: var(--green); }
  .brief-label.manage { background: rgba(88, 166, 255, 0.15); color: var(--blue); }
  .brief-label.watch { background: rgba(163, 113, 247, 0.15); color: var(--purple); }
  .brief-label.context,
  .brief-label.secondary { background: var(--border); color: var(--text-dim); }
  .brief-kill-switches {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .brief-kill-switch {
    background: rgba(248, 81, 73, 0.15);
    color: var(--red);
    padding: 4px 10px;
    border-radius: 3px;
    font-size: 11px;
    font-weight: 600;
  }
  .brief-checklist { list-style: none; padding: 0; margin: 0; }
  .brief-checklist li {
    background: var(--panel-hi);
    padding: 8px 14px;
    margin-bottom: 6px;
    border-radius: 4px;
    font-size: 13px;
    border-left: 3px solid var(--border);
  }
  details.brief-collapse > summary {
    cursor: pointer;
    padding: 10px 0;
    color: var(--text-dim);
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-weight: 600;
    list-style: none;
  }
  details.brief-collapse > summary::-webkit-details-marker { display: none; }
  details.brief-collapse > summary::before {
    content: '▸ ';
    display: inline-block;
    transition: transform 0.15s;
  }
  details.brief-collapse[open] > summary::before {
    transform: rotate(90deg);
  }
  @media (max-width: 1200px) {
    .brief-grid { grid-template-columns: repeat(4, 1fr); }
  }
  @media (max-width: 700px) {
    .brief-grid { grid-template-columns: repeat(2, 1fr); }
  }

  /* Main tabs (Current / Historical) */
  .main-tabs {
    max-width: 1600px;
    margin: 0 auto 20px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 6px;
  }
  .main-tab {
    padding: 14px 24px;
    background: transparent;
    border: none;
    border-radius: 8px;
    color: var(--text-dim);
    cursor: pointer;
    font-size: 15px;
    font-weight: 600;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
  }
  .main-tab:hover:not(.active) {
    background: var(--panel-hi);
    color: var(--text);
  }
  .main-tab.active {
    background: var(--blue);
    color: white;
    box-shadow: 0 2px 6px rgba(88, 166, 255, 0.3);
  }
  .main-tab-icon { font-size: 18px; }
  .main-tab-label { font-size: 15px; }
  .main-tab-count {
    font-size: 11px;
    padding: 2px 8px;
    background: rgba(255, 255, 255, 0.15);
    border-radius: 10px;
    font-weight: 500;
  }
  .main-tab:not(.active) .main-tab-count { background: rgba(255, 255, 255, 0.05); }

  .main-section { display: none; }
  .main-section.active { display: contents; }

  /* Live Charts tab */
  .chart-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(480px, 1fr));
    gap: 16px;
  }
  .chart-tile {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
  .chart-tile-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--panel-hi);
    border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .chart-tile-symbol { font-weight: 600; color: var(--text); }
  .chart-tile-link {
    color: var(--blue);
    text-decoration: none;
    font-size: 11px;
  }
  .chart-tile-link:hover { text-decoration: underline; }
  .chart-tile iframe {
    width: 100%;
    height: 420px;
    border: 0;
    display: block;
  }

  /* Futures section */
  .futures-group {
    margin-bottom: 24px;
  }
  .futures-group-label {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 10px;
    padding-left: 4px;
    border-left: 3px solid var(--blue);
    padding: 4px 10px;
  }
  .futures-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 16px;
  }
  .futures-tile {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .futures-tile-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 12px;
    background: var(--panel-hi);
    border-bottom: 1px solid var(--border);
  }
  .futures-tile-name { font-weight: 600; font-size: 13px; color: var(--text); }
  .futures-tile-sym {
    font-size: 11px;
    color: var(--text-dim);
    margin-left: 8px;
    font-family: monospace;
    background: rgba(255,255,255,0.05);
    padding: 1px 6px;
    border-radius: 3px;
  }
  .futures-tile-why {
    font-size: 11px;
    color: var(--text-dim);
    padding: 6px 12px;
    border-bottom: 1px solid var(--border);
    line-height: 1.4;
  }
  .futures-tile iframe {
    width: 100%;
    height: 350px;
    border: 0;
    display: block;
  }

  /* Options chain tab */
  .opt-grid {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  .opt-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .opt-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    background: var(--panel-hi);
    border-bottom: 1px solid var(--border);
    font-size: 14px;
  }
  .opt-price { color: var(--blue); margin-left: 8px; }
  .opt-exp { font-size: 12px; color: var(--text-dim); }
  .opt-tables {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0;
  }
  .opt-tables > div { padding: 8px; }
  .opt-tables > div:first-child { border-right: 1px solid var(--border); }
  .opt-side-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-bottom: 6px;
    padding: 2px 8px;
    border-radius: 3px;
    display: inline-block;
  }
  .call-label { color: #4caf50; background: rgba(76,175,80,0.1); }
  .put-label { color: #f44336; background: rgba(244,67,54,0.1); }
  .opt-tables table { width: 100%; font-size: 12px; }
  .opt-tables th { font-size: 11px; color: var(--text-dim); padding: 4px 6px; text-align: right; }
  .opt-tables td { padding: 3px 6px; }
  .opt-itm { background: rgba(255,255,255,0.03); }
  .opt-itm td:first-child { font-weight: 600; }
  .opt-exp-filter { display: flex; align-items: center; }
  .opt-exp-select {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
    min-width: 180px;
  }
  .opt-exp-select:focus { border-color: var(--blue); outline: none; }
  .opt-strike-select {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 4px 8px;
    font-size: 12px;
    cursor: pointer;
  }

  /* Per-ticker intel strip */
  .opt-intel-strip {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    gap: 8px;
    font-size: 12px;
    background: var(--panel);
  }
  .opt-intel-signal {
    padding: 6px 10px;
    border-radius: 4px;
    line-height: 1.5;
  }
  .opt-intel-skip { background: rgba(244,67,54,0.08); border-left: 3px solid #f44336; }
  .opt-intel-go { background: rgba(76,175,80,0.08); border-left: 3px solid #4caf50; }
  .opt-intel-watch { background: rgba(255,193,7,0.08); border-left: 3px solid #ffc107; }
  .opt-intel-neutral { background: rgba(100,100,100,0.08); border-left: 3px solid var(--text-dim); }
  .opt-intel-badge {
    display: inline-block;
    font-weight: 700;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 6px;
    background: rgba(255,255,255,0.08);
  }
  .opt-intel-pos {
    padding: 5px 10px;
    border-left: 3px solid var(--blue);
    background: rgba(33,150,243,0.06);
    border-radius: 4px;
    line-height: 1.5;
  }
  .opt-intel-pos.opt-intel-urgent { border-left-color: #ff9800; background: rgba(255,152,0,0.08); }
  .opt-intel-entry {
    padding: 5px 10px;
    border-left: 3px solid #4caf50;
    background: rgba(76,175,80,0.06);
    border-radius: 4px;
    line-height: 1.5;
  }
  .opt-intel-event {
    padding: 5px 10px;
    border-left: 3px solid #9c27b0;
    background: rgba(156,39,176,0.06);
    border-radius: 4px;
    line-height: 1.5;
  }
  .opt-intel-reason { color: var(--text-dim); font-size: 11px; margin-top: 2px; }
  .opt-intel-meta { color: var(--text-dim); font-size: 11px; margin-top: 3px; font-family: monospace; }
  .opt-intel-news {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .opt-intel-headline {
    color: var(--text-dim);
    text-decoration: none;
    font-size: 11px;
    line-height: 1.4;
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .opt-intel-headline:hover { color: var(--blue); text-decoration: underline; }
  .opt-intel-ago {
    display: inline-block;
    font-size: 10px;
    color: var(--text-dim);
    background: rgba(255,255,255,0.05);
    padding: 0 4px;
    border-radius: 2px;
    margin-right: 4px;
    font-family: monospace;
  }

  /* Coiled Springs section */
  .exp-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .exp-card {
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    transition: border-color 0.2s;
  }
  .exp-card:hover { border-color: var(--blue); }
  .exp-card-ep {
    border-color: #9b59b6;
    box-shadow: 0 0 12px rgba(155, 89, 182, 0.3);
    animation: ep-pulse 2s ease-in-out infinite;
  }
  @keyframes ep-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(155, 89, 182, 0.2); }
    50% { box-shadow: 0 0 20px rgba(155, 89, 182, 0.5); }
  }
  .exp-card-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 12px;
  }
  .exp-score {
    width: 44px; height: 44px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 16px; color: #fff;
    flex-shrink: 0;
  }
  .exp-signals {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 10px;
  }
  .exp-bar-track {
    height: 5px;
    background: rgba(255,255,255,0.08);
    border-radius: 3px;
    overflow: hidden;
  }
  .exp-bar-fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, var(--blue), #2ecc71);
  }
  .exp-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .exp-tag {
    font-size: 10px; font-weight: 700; padding: 2px 8px;
    border-radius: 4px; text-transform: uppercase;
    background: rgba(255,255,255,0.08); color: var(--text-dim);
  }
  .exp-tag-acc { background: rgba(46,204,113,0.2); color: #2ecc71; }
  .exp-tag-harv { background: rgba(241,196,15,0.2); color: #f1c40f; }
  .exp-tag-ep { background: rgba(155,89,182,0.2); color: #bb86fc; }
  .exp-play {
    font-size: 12px; color: var(--text-dim);
    line-height: 1.4; margin-bottom: 8px;
    overflow: hidden; text-overflow: ellipsis;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  }
  .exp-metrics {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px; color: var(--text-dim);
    margin-bottom: 8px;
  }
  .exp-news { display: flex; flex-direction: column; gap: 4px; }
  .exp-news-link {
    font-size: 12px; color: var(--blue); text-decoration: none;
    display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .exp-news-link:hover { text-decoration: underline; }
  .exp-news-ago {
    font-size: 10px; color: var(--text-dim);
    background: rgba(255,255,255,0.05);
    padding: 0 4px; border-radius: 2px;
    margin-left: 4px; font-family: monospace;
  }
  .exp-filter {
    padding: 6px 14px; font-size: 12px; font-weight: 600;
    background: var(--panel); color: var(--text-dim);
    border: 1px solid var(--border); border-radius: 6px; cursor: pointer;
  }
  .exp-filter:hover { color: var(--text); border-color: var(--text-dim); }
  .exp-filter.active { color: var(--blue); border-color: var(--blue); background: rgba(59,130,246,0.1); }

  /* Breaking News section */
  .news-list { display: flex; flex-direction: column; gap: 2px; }
  .news-item {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border);
  }
  .news-item:last-child { border-bottom: none; }
  .news-title {
    color: var(--blue);
    text-decoration: none;
    font-size: 13px;
    font-weight: 500;
    display: block;
    line-height: 1.4;
  }
  .news-title:hover { text-decoration: underline; }
  .news-meta {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 4px;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .news-ticker-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
    gap: 16px;
  }
  .news-ticker-card {
    background: var(--panel-hi);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
  }
  .news-ticker-header {
    padding: 8px 12px;
    font-weight: 700;
    font-size: 14px;
    background: rgba(255,255,255,0.03);
    border-bottom: 1px solid var(--border);
  }
  .news-filter-bar { margin-bottom: 12px; }
  .news-filter-input {
    background: var(--panel);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    font-size: 13px;
    width: 250px;
  }
  .news-filter-input:focus { border-color: var(--blue); outline: none; }
  .section-current.active, .section-historical.active { display: contents; }
  @media (max-width: 1200px) {
    .kpi { grid-template-columns: repeat(2, 1fr); }
    .span-8, .span-6, .span-4, .span-3 { grid-column: span 12; }
    .futures-grid { grid-template-columns: 1fr; }
    .exp-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>

<header>
  <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;">
    <div>
      <h1>Queen Mommy Trading Dashboard</h1>
      <div class="subtitle">Generated: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', dateStyle: 'medium', timeStyle: 'short' })} · Source: ${path.basename(INPUT)}</div>
    </div>
    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:8px;">
      <div id="live-clock" style="font-family:monospace;font-size:14px;line-height:1.5;text-align:right;"></div>
      <div style="font-size:12px;color:var(--text-dim)">Auto-refresh: <span id="refresh-countdown">15:00</span></div>
      <button id="pause-refresh" style="background:var(--panel-hi);border:1px solid var(--border);color:var(--text);padding:6px 12px;border-radius:6px;cursor:pointer;font-size:12px;">⏸ Pause auto-refresh</button>
    </div>
  </div>
</header>

${alertBannerHtml}

<nav class="main-tabs">
  <button class="main-tab active" data-target="current">
    <span class="main-tab-icon">🎯</span>
    <span class="main-tab-label">Current / Active</span>
    <span class="main-tab-count">today's plan</span>
  </button>
  <button class="main-tab" data-target="historical">
    <span class="main-tab-icon">📊</span>
    <span class="main-tab-label">Historical</span>
    <span class="main-tab-count">${completed.length} trades</span>
  </button>
  <button class="main-tab" data-target="charts">
    <span class="main-tab-icon">📈</span>
    <span class="main-tab-label">Live Charts</span>
    <span class="main-tab-count">${chartTickers.length} tickers</span>
  </button>
  <button class="main-tab" data-target="options">
    <span class="main-tab-icon">⛓</span>
    <span class="main-tab-label">Options Chains</span>
    <span class="main-tab-count">${optionsFetched} chains</span>
  </button>
  <button class="main-tab" data-target="futures">
    <span class="main-tab-icon">🔮</span>
    <span class="main-tab-label">Futures</span>
    <span class="main-tab-count">live feed</span>
  </button>
  <button class="main-tab" data-target="explosion">
    <span class="main-tab-icon">🌀</span>
    <span class="main-tab-label">Coiled Springs</span>
    <span class="main-tab-count">${coiledSpringResults?.results?.length || 0} candidates</span>
  </button>
</nav>

<div class="container">

  <!-- ══════ CURRENT / ACTIVE section 1: brief + holdings + cash + open options ══════ -->
  <div class="main-section section-current active">

  ${briefHtml}

  ${unrealizedHtml}

  ${cashHtml}

  ${openOptionsHtml}

  ${alertsPanelHtml}

  ${newsHtml}

  </div><!-- end current 1 -->

  <!-- ══════ LIVE CHARTS section: TradingView iframe embeds ══════ -->
  <div class="main-section section-charts">
  ${chartsHtml}
  </div><!-- end charts -->

  <!-- ══════ OPTIONS CHAINS section: Yahoo Finance data ══════ -->
  <div class="main-section section-options">
  ${optionsHtml}
  </div><!-- end options -->

  <!-- ══════ FUTURES section: live TradingView streaming widgets ══════ -->
  <div class="main-section section-futures">
  ${futuresHtml}
  </div><!-- end futures -->

  <!-- ══════ COILED SPRINGS section ══════ -->
  <div class="main-section section-explosion">
  ${coiledSpringHtml}
  </div><!-- end coiled-springs -->

  <!-- ══════ HISTORICAL section 1: KPIs ══════ -->
  <div class="main-section section-historical">

  <!-- KPIs -->
  <div class="kpi">
    <div class="panel">
      <div class="kpi-label">Net P&L</div>
      <div class="kpi-value ${totalPnL >= 0 ? 'positive' : 'negative'}">${totalPnL >= 0 ? '+' : ''}$${totalPnL.toFixed(2)}</div>
      <div class="kpi-sub">${completed.length} closed trades</div>
    </div>
    <div class="panel">
      <div class="kpi-label">Win Rate</div>
      <div class="kpi-value neutral">${winRate.toFixed(1)}%</div>
      <div class="kpi-sub">${winners.length} wins / ${losers.length} losses</div>
    </div>
    <div class="panel">
      <div class="kpi-label">Profit Factor</div>
      <div class="kpi-value ${profitFactor >= 1.5 ? 'positive' : 'negative'}">${profitFactor.toFixed(2)}×</div>
      <div class="kpi-sub">winners ÷ |losers|</div>
    </div>
    <div class="panel">
      <div class="kpi-label">Max Drawdown</div>
      <div class="kpi-value negative">−$${maxDD.toFixed(2)}</div>
      <div class="kpi-sub">${peakDate} → ${ddDate}</div>
    </div>
  </div>

  </div><!-- end historical 1 -->

  <!-- ══════ CURRENT / ACTIVE section 2: recommendations ══════ -->
  <div class="main-section section-current active">

  ${recommendationsHtml}

  </div><!-- end current 2 -->

  <!-- ══════ HISTORICAL section 2: charts + trade table ══════ -->
  <div class="main-section section-historical">

  <!-- Equity curve -->
  <div class="panel span-12">
    <h2>📈 Equity Curve — Cumulative P&L over time</h2>
    <div class="chart-wrap-lg"><canvas id="equityChart"></canvas></div>
  </div>

  <!-- Weekly and Monthly -->
  <div class="panel span-8">
    <h2>📅 Weekly P&L (stacked by account)</h2>
    <div class="chart-wrap"><canvas id="weeklyChart"></canvas></div>
  </div>
  <div class="panel span-4">
    <h2>🗓️ Monthly P&L</h2>
    <div class="chart-wrap"><canvas id="monthlyChart"></canvas></div>
  </div>

  <!-- Symbols and Win/Loss -->
  <div class="panel span-8">
    <h2>🏷️ P&L by Symbol</h2>
    <div class="chart-wrap"><canvas id="symbolChart"></canvas></div>
  </div>
  <div class="panel span-4">
    <h2>🎯 Win / Loss</h2>
    <div class="chart-wrap"><canvas id="winLossChart"></canvas></div>
  </div>

  <!-- Account comparison and Hold time -->
  <div class="panel span-4">
    <h2>💼 Account Comparison</h2>
    <div class="chart-wrap"><canvas id="accountChart"></canvas></div>
  </div>
  <div class="panel span-4">
    <h2>⏱️ Hold Time Distribution</h2>
    <div class="chart-wrap"><canvas id="holdChart"></canvas></div>
  </div>
  <div class="panel span-4">
    <h2>💡 Key Insights</h2>
    <div class="insight ${cspPnL > 0 && callPnL < 0 ? 'bad' : 'good'}">
      <strong>Account split:</strong> CSP ${cspPnL >= 0 ? '+' : ''}$${cspPnL.toFixed(0)}, Call ${callPnL >= 0 ? '+' : ''}$${callPnL.toFixed(0)}.
      ${cspPnL > 0 && callPnL < 0 ? 'Big CC losses during a rally wiped out small wins. See table below.' : 'Both accounts contributing.'}
    </div>
    <div class="insight ${avgLoss && Math.abs(avgLoss / avgWin) > 3 ? 'bad' : 'good'}">
      <strong>Average loss is ${Math.abs(avgLoss / avgWin).toFixed(1)}× average win.</strong>
      ${avgLoss && Math.abs(avgLoss / avgWin) > 3 ? 'High win rate masks this — single bad trades wipe out many good ones.' : 'Win/loss balance is healthy.'}
    </div>
    <div class="insight good">
      <strong>ASML IV crush trades</strong> captured ~$4,278 in 3 days post-ceasefire. Your best executed setup to date.
    </div>
  </div>

  <!-- Trade table -->
  <div class="panel span-12">
    <h2>📋 All Completed Trades</h2>
    <div class="filter-bar">
      <button class="active" data-filter="all">All (${completed.length})</button>
      <button data-filter="csp">CSP (${cspTrades.length})</button>
      <button data-filter="call">Call (${callTrades.length})</button>
      <button data-filter="winners">Winners (${winners.length})</button>
      <button data-filter="losers">Losers (${losers.length})</button>
    </div>
    <div class="table-wrap">
      <table id="tradeTable">
        <thead>
          <tr>
            <th>Close</th><th>Open</th><th>Acct</th><th>Symbol</th><th>Type</th>
            <th class="num">Strike</th><th>Expiration</th><th class="num">Hold (d)</th><th class="num">P&L</th><th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${tradeTable
            .map(
              (t) => `
          <tr data-account="${t.account.toLowerCase()}" data-winner="${t.pnl > 0}">
            <td>${t.close}</td>
            <td>${t.open}</td>
            <td><span class="badge ${t.account === 'CSP' ? 'badge-csp' : 'badge-call'}">${t.account}</span></td>
            <td><strong>${t.symbol}</strong></td>
            <td><span class="badge ${t.type === 'PUT' ? 'badge-put' : 'badge-calltype'}">${t.type}</span></td>
            <td class="num">$${t.strike}</td>
            <td>${t.exp}</td>
            <td class="num">${t.hold}</td>
            <td class="num ${t.pnl >= 0 ? 'positive' : 'negative'}"><strong>${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)}</strong></td>
            <td>${t.status}</td>
          </tr>`
            )
            .join('')}
        </tbody>
      </table>
    </div>
  </div>

  </div><!-- end historical 2 -->

  <!-- ══════ CURRENT / ACTIVE section 3: open positions ══════ -->
  <div class="main-section section-current active">

  <!-- Open positions -->
  <div class="panel span-12">
    <h2>📂 Currently Open Positions (${openLegs.length})</h2>
    <table>
      <thead>
        <tr>
          <th>Account</th><th>Symbol</th><th>Type</th><th class="num">Strike</th><th>Expiration</th><th>Opened</th><th class="num">Credit</th>
        </tr>
      </thead>
      <tbody>
        ${openLegs
          .map(
            (t) => `
        <tr>
          <td><span class="badge ${t.account === 'CSP' ? 'badge-csp' : 'badge-call'}">${t.account}</span></td>
          <td><strong>${t.symbol}</strong></td>
          <td><span class="badge ${t.type === 'PUT' ? 'badge-put' : 'badge-calltype'}">${t.type}</span></td>
          <td class="num">$${t.strike}</td>
          <td>${t.expiration}</td>
          <td>${fmt(t.date)}</td>
          <td class="num positive">+$${t.amount.toFixed(2)}</td>
        </tr>`
          )
          .join('')}
      </tbody>
    </table>
  </div>

  </div><!-- end current 3 -->

</div>

<script>
// Chart.js theming
Chart.defaults.color = '#8b949e';
Chart.defaults.borderColor = '#30363d';
Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Embedded data
const equityData = ${JSON.stringify(equityCurve)};
const weekKeys = ${JSON.stringify(weekKeys)};
const weekData = ${JSON.stringify(byWeek)};
const monthKeys = ${JSON.stringify(monthKeys)};
const monthData = ${JSON.stringify(byMonth)};
const symbols = ${JSON.stringify(sortedSymbols.map(([s, v]) => ({ symbol: s, pnl: v.pnl })))};
const holdBuckets = ${JSON.stringify(holdBuckets)};

// 1. Equity curve
new Chart(document.getElementById('equityChart').getContext('2d'), {
  type: 'line',
  data: {
    labels: equityData.map(p => p.date),
    datasets: [{
      label: 'Cumulative P&L',
      data: equityData.map(p => p.cum),
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88, 166, 255, 0.1)',
      fill: true,
      tension: 0.1,
      pointRadius: 3,
      pointHoverRadius: 6,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        callbacks: {
          afterLabel: (ctx) => {
            const p = equityData[ctx.dataIndex];
            return 'Trade: ' + (p.pnl >= 0 ? '+' : '') + '$' + p.pnl.toFixed(2) + ' (' + p.symbol + ' ' + p.account + ')';
          }
        }
      }
    },
    scales: {
      x: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { maxRotation: 45, minRotation: 45 } },
      y: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { callback: v => '$' + v.toFixed(0) } }
    }
  }
});

// 2. Weekly P&L stacked
new Chart(document.getElementById('weeklyChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: weekKeys,
    datasets: [
      { label: 'CSP', data: weekKeys.map(k => weekData[k].csp), backgroundColor: '#58a6ff' },
      { label: 'Call', data: weekKeys.map(k => weekData[k].call), backgroundColor: '#a371f7' },
    ]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'top' } },
    scales: {
      x: { stacked: true, grid: { color: 'rgba(48, 54, 61, 0.5)' } },
      y: { stacked: true, grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { callback: v => '$' + v.toFixed(0) } }
    }
  }
});

// 3. Monthly P&L
new Chart(document.getElementById('monthlyChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: monthKeys,
    datasets: [{
      label: 'P&L',
      data: monthKeys.map(k => monthData[k].pnl),
      backgroundColor: monthKeys.map(k => monthData[k].pnl >= 0 ? '#3fb950' : '#f85149'),
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(48, 54, 61, 0.5)' } },
      y: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { callback: v => '$' + v.toFixed(0) } }
    }
  }
});

// 4. Symbol P&L horizontal bar
new Chart(document.getElementById('symbolChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: symbols.map(s => s.symbol),
    datasets: [{
      label: 'P&L',
      data: symbols.map(s => s.pnl),
      backgroundColor: symbols.map(s => s.pnl >= 0 ? '#3fb950' : '#f85149'),
    }]
  },
  options: {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { callback: v => '$' + v.toFixed(0) } },
      y: { grid: { color: 'rgba(48, 54, 61, 0.5)' } }
    }
  }
});

// 5. Win/Loss doughnut
new Chart(document.getElementById('winLossChart').getContext('2d'), {
  type: 'doughnut',
  data: {
    labels: ['Winners', 'Losers'],
    datasets: [{
      data: [${winners.length}, ${losers.length}],
      backgroundColor: ['#3fb950', '#f85149'],
      borderWidth: 0,
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { position: 'bottom' } },
    cutout: '65%'
  }
});

// 6. Account comparison
new Chart(document.getElementById('accountChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: ['CSP Account', 'Call Account'],
    datasets: [{
      label: 'P&L',
      data: [${cspPnL}, ${callPnL}],
      backgroundColor: ['#58a6ff', '#a371f7'],
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(48, 54, 61, 0.5)' } },
      y: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, ticks: { callback: v => '$' + v.toFixed(0) } }
    }
  }
});

// 7. Hold time distribution
new Chart(document.getElementById('holdChart').getContext('2d'), {
  type: 'bar',
  data: {
    labels: Object.keys(holdBuckets),
    datasets: [{
      label: 'Trades',
      data: Object.values(holdBuckets),
      backgroundColor: '#d29922',
    }]
  },
  options: {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(48, 54, 61, 0.5)' } },
      y: { grid: { color: 'rgba(48, 54, 61, 0.5)' }, beginAtZero: true }
    }
  }
});

// Table filters
document.querySelectorAll('.filter-bar button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-bar button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('#tradeTable tbody tr').forEach(row => {
      const acct = row.dataset.account;
      const winner = row.dataset.winner === 'true';
      let show = true;
      if (filter === 'csp') show = acct === 'csp';
      else if (filter === 'call') show = acct === 'call';
      else if (filter === 'winners') show = winner;
      else if (filter === 'losers') show = !winner;
      row.style.display = show ? '' : 'none';
    });
  });
});

// Recommendation tab switcher
document.querySelectorAll('.rec-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.rec-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.rec-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('rec-' + target).classList.add('active');
  });
});

// Alert banner — set scroll speed based on content width
(function() {
  const scroll = document.getElementById('alert-scroll');
  if (!scroll) return;
  // Measure full width, set duration so it scrolls at ~80px/sec
  requestAnimationFrame(() => {
    const halfWidth = scroll.scrollWidth / 2;
    const speed = 80; // pixels per second
    const duration = Math.max(30, Math.round(halfWidth / speed));
    scroll.style.setProperty('--scroll-duration', duration + 's');
    scroll.style.animationDuration = duration + 's';
  });
})();

// Live clock — EST + PST with date
(function() {
  const el = document.getElementById('live-clock');
  if (!el) return;
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  function tick() {
    const now = new Date();
    const est = now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const pst = now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    const dateFmt = now.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    el.innerHTML = '<span style="color:var(--text);">' + dateFmt + '</span><br/>'
      + '<span style="color:var(--blue);">' + est + ' EST</span>'
      + ' &nbsp;·&nbsp; '
      + '<span style="color:var(--green, #3fb950);">' + pst + ' PST</span>';
  }
  tick();
  setInterval(tick, 1000);
})();

// Staleness indicator — warn if data is older than 15 minutes
(function() {
  const buildTime = ${Date.now()};
  const banner = document.createElement('div');
  banner.id = 'stale-banner';
  banner.style.cssText = 'display:none;background:rgba(210,153,34,0.15);border:1px solid var(--yellow);border-radius:6px;padding:8px 14px;margin-top:8px;font-size:12px;color:var(--yellow);text-align:center;';
  const header = document.querySelector('header');
  if (header) header.appendChild(banner);
  function check() {
    const age = Math.floor((Date.now() - buildTime) / 60000);
    if (age >= 15) {
      banner.style.display = 'block';
      banner.innerHTML = '⚠️ Data is <strong>' + age + ' min</strong> old. '
        + (age >= 60 ? 'Run <code>node scripts/dashboard/build_dashboard_html.js</code> to refresh, or use <code>--watch</code> mode.' : 'Auto-refresh will update shortly.');
    } else {
      banner.style.display = 'none';
    }
  }
  check();
  setInterval(check, 60000);
})();

// Auto-refresh countdown + pause control
(function() {
  const refreshInterval = 900; // seconds (15 min)
  let remaining = refreshInterval;
  let paused = false;
  const countdownEl = document.getElementById('refresh-countdown');
  const pauseBtn = document.getElementById('pause-refresh');

  function updateDisplay() {
    const mm = Math.floor(remaining / 60);
    const ss = remaining % 60;
    countdownEl.textContent = (paused ? '⏸ ' : '') + mm + ':' + String(ss).padStart(2, '0');
  }

  let manualPause = false;
  let autoPause = false;

  function applyPause() {
    const wasPaused = paused;
    paused = manualPause || autoPause;
    if (paused === wasPaused) { updateDisplay(); return; }
    if (paused) {
      const meta = document.querySelector('meta[http-equiv="refresh"]');
      if (meta) meta.remove();
    } else {
      const meta = document.createElement('meta');
      meta.setAttribute('http-equiv', 'refresh');
      meta.setAttribute('content', String(remaining));
      document.head.appendChild(meta);
    }
    pauseBtn.textContent = manualPause
      ? '▶ Resume auto-refresh'
      : (autoPause ? '⏸ Paused (on Charts tab)' : '⏸ Pause auto-refresh');
    updateDisplay();
  }

  pauseBtn.addEventListener('click', () => {
    manualPause = !manualPause;
    applyPause();
  });

  // Expose for tab switcher: auto-pause while on Live Charts tab
  window.__dashSetAutoPause = (on) => {
    autoPause = !!on;
    applyPause();
  };

  setInterval(() => {
    if (!paused && remaining > 0) {
      remaining--;
      updateDisplay();
    }
  }, 1000);
  updateDisplay();
})();

// News ticker filter
(function() {
  const input = document.getElementById('news-ticker-filter');
  const grid = document.getElementById('news-ticker-grid');
  if (!input || !grid) return;
  input.addEventListener('input', () => {
    const q = input.value.toUpperCase().trim();
    grid.querySelectorAll('.news-ticker-card').forEach(card => {
      const sym = card.querySelector('.news-ticker-header')?.textContent || '';
      card.style.display = (!q || sym.toUpperCase().includes(q)) ? '' : 'none';
    });
  });
})();

// Main section tab switcher (Current / Historical)
// Uses CSS class toggling so interspersed section-current / section-historical wrappers
// can coexist in the natural HTML order while only one set is visible at a time.
document.querySelectorAll('.main-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.target; // 'current' | 'historical' | 'charts'
    document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    // Pause page auto-refresh while viewing Live Charts so iframes don't reload mid-stream
    if (typeof window.__dashSetAutoPause === 'function') {
      window.__dashSetAutoPause(target === 'charts');
    }
    // Show all sections of the target type, hide the other type
    document.querySelectorAll('.main-section').forEach(s => {
      if (s.classList.contains('section-' + target)) {
        s.classList.add('active');
      } else {
        s.classList.remove('active');
      }
    });
    // Resize charts in the newly visible section so Chart.js renders correctly
    setTimeout(() => {
      document.querySelectorAll('canvas').forEach(canvas => {
        const chart = Chart.getChart(canvas);
        if (chart) chart.resize();
      });
    }, 50);
    // Scroll to top of content for cleaner tab switch
    window.scrollTo({ top: document.querySelector('.container').offsetTop - 80, behavior: 'smooth' });
  });
});

// Coiled Springs filter buttons
document.querySelectorAll('.exp-filter').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.exp-filter').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const filter = btn.dataset.filter;
    document.querySelectorAll('.exp-card').forEach(card => {
      if (filter === 'all') {
        card.style.display = '';
      } else {
        card.style.display = card.dataset.classification === filter ? '' : 'none';
      }
    });
  });
});
</script>

</body>
</html>`;

fs.writeFileSync(OUTPUT, html);
console.log(`Dashboard written to ${OUTPUT}`);
console.log(`  ${completed.length} completed trades, ${openLegs.length} open`);
console.log(`  Net P&L: $${totalPnL.toFixed(2)}, Win rate: ${winRate.toFixed(1)}%`);

// --watch mode: rebuild every 15 minutes so the browser's meta-refresh picks up fresh data
if (process.argv.includes('--watch')) {
  const INTERVAL = 15 * 60 * 1000; // 15 minutes
  console.log(`  Watch mode active — rebuilding every 15 minutes. Press Ctrl+C to stop.`);
  console.log(`  Open ${OUTPUT} in a browser; it auto-refreshes to pick up new data.`);
  setInterval(async () => {
    console.log(`\n[${new Date().toLocaleTimeString()}] Rebuilding...`);
    try {
      const { execSync } = await import('child_process');
      execSync(`node "${process.argv[1]}" "${INPUT}" "${OUTPUT}" "${BRIEF_JSON}"`, {
        stdio: 'inherit',
        env: { ...process.env, SKIP_OPTIONS: '1' }, // use cached options for speed
      });
    } catch (e) {
      console.error('Rebuild failed:', e.message);
    }
  }, INTERVAL);
} else {
  console.log(`  Open in a browser to view.`);
  console.log(`  Tip: run with --watch to auto-rebuild every 15 min for live data.`);
}
