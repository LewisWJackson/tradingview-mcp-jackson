/**
 * Stage 1 + 1b — Yahoo Finance Screener v2 (Coiled Spring)
 *
 * Stage 1:  Bulk quote fetch + hard quality gate → ~30-50 candidates
 * Stage 1b: 3-month OHLCV + IV + news for candidates
 *
 * Export: runStage1(symbols) => { candidates, marketRegime, stats }
 */

import https from 'node:https';

// ---------------------------------------------------------------------------
// HTTP + Auth helpers (unchanged from v1)
// ---------------------------------------------------------------------------

/** HTTPS GET with cookie/user-agent headers, 15s timeout */
function yahooGet(url, cookies) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        ...(cookies ? { Cookie: cookies } : {}),
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        yahooGet(res.headers.location, cookies).then(resolve, reject);
        res.resume();
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/** Auth flow — returns { crumb, cookies } */
export async function getCrumb() {
  const init = await yahooGet('https://fc.yahoo.com', '');
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await yahooGet('https://query2.finance.yahoo.com/v1/test/getcrumb', cookies);
  if (crumbRes.status !== 200) throw new Error(`getCrumb failed: status ${crumbRes.status}`);
  return { crumb: crumbRes.body.trim(), cookies };
}

/** Fetch a batch of up to 50 symbols */
async function fetchQuoteBatch(symbols, crumb, cookies) {
  const joined = symbols.map(encodeURIComponent).join(',');
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${joined}&crumb=${encodeURIComponent(crumb)}`;
  const res = await yahooGet(url, cookies);
  if (res.status !== 200) throw new Error(`quote batch failed: status ${res.status}`);
  const data = JSON.parse(res.body);
  return data?.quoteResponse?.result || [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse RSS XML items */
function parseRssItems(xml, maxItems = 3) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) && items.length < maxItems) {
    const block = m[1];
    const tag = (name) => {
      const r = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`);
      const mt = block.match(r);
      return mt ? mt[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };
    items.push({ title: tag('title'), link: tag('link'), pubDate: tag('pubDate') });
  }
  return items;
}

/** Fetch Yahoo RSS headlines for a symbol */
async function fetchNews(symbol, max = 3) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    const res = await yahooGet(url, '');
    if (res.status !== 200) return [];
    return parseRssItems(res.body, max);
  } catch { return []; }
}

// ---------------------------------------------------------------------------
// Hard Quality Gate (pass/fail)
// ---------------------------------------------------------------------------

/**
 * @param {object} q — raw Yahoo quote object
 * @returns {boolean}
 */
export function passesQualityGate(q) {
  const price = q.regularMarketPrice || 0;
  const avgVol = q.averageDailyVolume3Month || 0;
  const marketCap = q.marketCap || 0;
  const ma200 = q.twoHundredDayAverage || 0;
  const changePct = Math.abs(q.regularMarketChangePercent || 0);
  const marketState = q.marketState || '';

  // Hard filters — any failure = out
  if (marketCap < 1_000_000_000) return false;   // > $1B
  if (avgVol < 1_000_000) return false;           // > 1M avg daily volume
  if (price < 10) return false;                    // > $10
  if (price <= ma200 && ma200 > 0) return false;  // above 200-day MA
  if (changePct >= 15) return false;               // not already exploded today
  if (marketState === 'CLOSED_PERMANENTLY') return false; // not delisted

  return true;
}

// ---------------------------------------------------------------------------
// Stage 1 Pre-Filter (quiet strength, not noise)
// ---------------------------------------------------------------------------

/**
 * @param {object} q — raw Yahoo quote object
 * @returns {boolean}
 */
export function passesStage1Filter(q) {
  const price = q.regularMarketPrice || 0;
  const ma50 = q.fiftyDayAverage || 0;
  const high52w = q.fiftyTwoWeekHigh || 0;
  const volume = q.regularMarketVolume || 0;
  const avgVol = q.averageDailyVolume10Day || 0;
  const volumeRatio = avgVol > 0 ? volume / avgVol : 0;

  // Must pass quality gate first
  if (!passesQualityGate(q)) return false;

  // Price above 50-day MA (uptrend)
  if (ma50 > 0 && price <= ma50) return false;

  // Within 25% of 52-week high (not broken down)
  if (high52w > 0 && price < high52w * 0.75) return false;

  // NOT surging today — volume ratio must be < 2.5x
  if (volumeRatio >= 2.5) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Market Regime Assessment
// ---------------------------------------------------------------------------

const REGIME_SYMBOLS = [
  'SPY', 'QQQ', '^VIX',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU',
];

/**
 * Fetch SPY, QQQ, VIX, and sector ETFs. Return regime + sector rankings.
 * @param {string} crumb
 * @param {string} cookies
 * @returns {Promise<{ regime: object, sectorRankings: string[] }>}
 */
export async function fetchMarketRegime(crumb, cookies) {
  const quotes = await fetchQuoteBatch(REGIME_SYMBOLS, crumb, cookies);
  const bySymbol = Object.fromEntries(quotes.map((q) => [q.symbol, q]));

  const spy = bySymbol['SPY'] || {};
  const qqq = bySymbol['QQQ'] || {};
  const vix = bySymbol['^VIX'] || {};

  const spyPrice = spy.regularMarketPrice || 0;
  const spy50 = spy.fiftyDayAverage || 0;
  const spy200 = spy.twoHundredDayAverage || 0;
  const qqqPrice = qqq.regularMarketPrice || 0;
  const qqq50 = qqq.fiftyDayAverage || 0;
  const qqq200 = qqq.twoHundredDayAverage || 0;
  const vixLevel = vix.regularMarketPrice || 0;

  const spyAbove200dma = spyPrice > spy200;
  const spyAbove50dma = spyPrice > spy50;
  const qqqAbove200dma = qqqPrice > qqq200;
  const qqqAbove50dma = qqqPrice > qqq50;

  let regime = 'constructive';
  if (!spyAbove200dma || vixLevel > 35) {
    regime = 'defensive';
  } else if (!spyAbove50dma || (vixLevel >= 25 && vixLevel <= 35)) {
    regime = 'cautious';
  }

  // Sector rankings by 20-day performance (regularMarketChangePercent as proxy)
  const sectorETFs = ['XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLC', 'XLY', 'XLP', 'XLB', 'XLRE', 'XLU'];
  const sectorPerf = sectorETFs
    .map((sym) => ({
      symbol: sym,
      changePct: bySymbol[sym]?.regularMarketChangePercent || 0,
    }))
    .sort((a, b) => b.changePct - a.changePct);

  return {
    regime: {
      spyAbove200dma,
      spyAbove50dma,
      qqqAbove200dma,
      qqqAbove50dma,
      vixLevel: +vixLevel.toFixed(1),
      regime,
    },
    sectorRankings: sectorPerf.map((s) => s.symbol),
    spyPerf20d: spy.regularMarketChangePercent || 0,
  };
}

// ---------------------------------------------------------------------------
// Stage 1b: 3-month OHLCV fetch
// ---------------------------------------------------------------------------

/**
 * Fetch 3 months of daily OHLCV for a single symbol.
 * @param {string} symbol
 * @param {string} crumb
 * @param {string} cookies
 * @returns {Promise<{ bars: Array<{date:string, open:number, high:number, low:number, close:number, volume:number}>, error:string|null }>}
 */
export async function fetchOHLCV(symbol, crumb, cookies) {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=3mo&interval=1d&crumb=${encodeURIComponent(crumb)}`;
    const res = await yahooGet(url, cookies);
    if (res.status !== 200) return { bars: [], error: `status ${res.status}` };

    const data = JSON.parse(res.body);
    const result = data?.chart?.result?.[0];
    if (!result) return { bars: [], error: 'no chart data' };

    const timestamps = result.timestamp || [];
    const ohlcv = result.indicators?.quote?.[0] || {};
    const bars = [];

    for (let i = 0; i < timestamps.length; i++) {
      const o = ohlcv.open?.[i];
      const h = ohlcv.high?.[i];
      const l = ohlcv.low?.[i];
      const c = ohlcv.close?.[i];
      const v = ohlcv.volume?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: +o.toFixed(2),
        high: +h.toFixed(2),
        low: +l.toFixed(2),
        close: +c.toFixed(2),
        volume: v || 0,
      });
    }

    return { bars, error: null };
  } catch (err) {
    return { bars: [], error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Soft Red Flags (warnings from news keywords)
// ---------------------------------------------------------------------------

const RED_FLAG_PATTERNS = [
  { flag: 'dilution_risk', keywords: ['offering', 'dilution', 'shelf registration', 'secondary offering', 'ATM program'] },
  { flag: 'litigation', keywords: ['lawsuit', 'sued', 'litigation', 'SEC investigation', 'class action'] },
  { flag: 'regulatory_risk', keywords: ['FDA rejection', 'complete response letter', 'clinical hold', 'FDA warning'] },
  { flag: 'insider_selling', keywords: ['insider sold', 'insider selling', '10b5-1 plan sale'] },
  { flag: 'merger_pending', keywords: ['merger', 'acquisition', 'takeover bid', 'going private', 'buyout'] },
];

/**
 * Scan news items for red flag keywords.
 * @param {Array<{title: string}>} newsItems
 * @returns {string[]}
 */
export function detectRedFlags(newsItems) {
  const flags = new Set();
  const allText = newsItems.map((n) => n.title.toLowerCase()).join(' ');
  for (const { flag, keywords } of RED_FLAG_PATTERNS) {
    if (keywords.some((kw) => allText.includes(kw.toLowerCase()))) {
      flags.add(flag);
    }
  }
  return [...flags];
}

// ---------------------------------------------------------------------------
// IV Context (approximate — not a real IV rank)
// ---------------------------------------------------------------------------

/**
 * Fetch nearest ATM call IV as a rough context field.
 * This is NOT a true IV rank — it maps current IV to a fixed 15-80% range.
 * @param {string} symbol
 * @param {string} crumb
 * @param {string} cookies
 * @returns {Promise<{ currentIV: number|null, ivContext: number|null, ivLabel: string }>}
 */
export async function fetchIVContext(symbol, crumb, cookies) {
  const none = { currentIV: null, ivContext: null, ivLabel: 'unavailable' };
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(crumb)}`;
    const res = await yahooGet(url, cookies);
    if (res.status !== 200) return none;
    const data = JSON.parse(res.body);
    const chain = data?.optionChain?.result?.[0];
    if (!chain) return none;

    const quote = chain.quote || {};
    const price = quote.regularMarketPrice || 0;
    const calls = chain.options?.[0]?.calls || [];

    let nearestATM = null;
    let minDist = Infinity;
    for (const c of calls) {
      const dist = Math.abs(c.strike - price);
      if (dist < minDist) { minDist = dist; nearestATM = c; }
    }
    if (!nearestATM?.impliedVolatility) return none;

    const currentIV = +(nearestATM.impliedVolatility * 100).toFixed(1);
    // Map to 15-80% range — crude approximation
    const ivContext = Math.max(0, Math.min(100,
      Math.round(((nearestATM.impliedVolatility - 0.15) / (0.80 - 0.15)) * 100)
    ));

    return {
      currentIV,
      ivContext,
      ivLabel: `~${ivContext} (approximate, not a true IV rank)`,
    };
  } catch { return none; }
}

// ---------------------------------------------------------------------------
// Quote data extraction
// ---------------------------------------------------------------------------

/**
 * Extract structured candidate data from a raw Yahoo quote.
 * @param {object} q — raw Yahoo quote
 * @returns {object}
 */
function extractQuoteData(q) {
  const price = q.regularMarketPrice || 0;
  const ma50 = q.fiftyDayAverage || 0;
  const ma200 = q.twoHundredDayAverage || 0;
  const ma150 = ma50 > 0 && ma200 > 0 ? (ma50 + ma200) / 2 : 0; // approximate
  const high52w = q.fiftyTwoWeekHigh || 0;
  const avgVol10d = q.averageDailyVolume10Day || 0;
  const avgVol3mo = q.averageDailyVolume3Month || 0;

  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: +price.toFixed(2),
    changePct: +(q.regularMarketChangePercent || 0).toFixed(2),
    marketCap: q.marketCap || 0,
    volume: q.regularMarketVolume || 0,
    avgVol10d,
    avgVol3mo,
    ma50: +ma50.toFixed(2),
    ma150: +ma150.toFixed(2),
    ma200: +ma200.toFixed(2),
    high52w: +high52w.toFixed(2),
    low52w: +(q.fiftyTwoWeekLow || 0).toFixed(2),
    earningsTimestamp: q.earningsTimestamp || null,
    shortPercentOfFloat: q.shortPercentOfFloat || null,
    // Populated in Stage 1b:
    ohlcv: [],
    ivContext: null,
    currentIV: null,
    ivLabel: 'pending',
    news: [],
    redFlags: [],
  };
}

// ---------------------------------------------------------------------------
// Relative strength ranking
// ---------------------------------------------------------------------------

function rankRelativeStrength(candidates, spyPerf20d) {
  for (const c of candidates) {
    c.perfVsSpy = c.ma200 > 0
      ? +((c.price - c.ma200) / c.ma200 * 100 - spyPerf20d).toFixed(1)
      : 0;
  }
  const sorted = [...candidates].sort((a, b) => b.perfVsSpy - a.perfVsSpy);
  const total = sorted.length;
  for (let i = 0; i < total; i++) {
    const pctile = Math.round(((total - i) / total) * 100);
    sorted[i].relStrengthPctile = pctile;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Run Stage 1 + 1b screen.
 * @param {string[]} symbols
 * @returns {Promise<{ candidates: object[], marketRegime: object, stats: object }>}
 */
export async function runStage1(symbols) {
  console.log(`[stage1] screening ${symbols.length} symbols via Yahoo Finance...`);

  // 1. Auth
  const { crumb, cookies } = await getCrumb();
  console.log(`[stage1] authenticated`);

  // 2. Fetch market regime + sector rankings
  const { regime, sectorRankings, spyPerf20d } = await fetchMarketRegime(crumb, cookies);
  console.log(`[stage1] market regime: ${regime.regime} (VIX ${regime.vixLevel})`);

  // 3. Batch quote fetch
  const BATCH_SIZE = 50;
  const allQuotes = [];
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    try {
      const quotes = await fetchQuoteBatch(batch, crumb, cookies);
      allQuotes.push(...quotes);
    } catch (err) {
      console.error(`[stage1] batch error at ${i}: ${err.message}`);
    }
    const fetched = Math.min(i + BATCH_SIZE, symbols.length);
    process.stdout.write(`\r[stage1] ${fetched}/${symbols.length} fetched`);
    if (i + BATCH_SIZE < symbols.length) await sleep(200);
  }
  console.log('');

  // 4. Apply Stage 1 filter (quality gate + quiet strength)
  const candidates = allQuotes
    .filter((q) => q && q.regularMarketPrice && passesStage1Filter(q))
    .map(extractQuoteData);

  console.log(`[stage1] ${candidates.length} candidates passed filters (from ${allQuotes.length} quotes)`);

  // 5. Rank relative strength
  rankRelativeStrength(candidates, spyPerf20d);

  // 6. Stage 1b: fetch 3-month OHLCV for candidates
  if (candidates.length > 0) {
    console.log(`[stage1b] fetching 3-month OHLCV for ${candidates.length} candidates...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const result = await fetchOHLCV(c.symbol, crumb, cookies);
      c.ohlcv = result.bars;
      if (result.error) c._ohlcvError = result.error;
      process.stdout.write(`\r[stage1b] ${i + 1}/${candidates.length} OHLCV`);
      if (i < candidates.length - 1) await sleep(200);
    }
    console.log('');

    // 5-day explosion check (from OHLCV — can't do this from single quote)
    for (let i = candidates.length - 1; i >= 0; i--) {
      const bars = candidates[i].ohlcv;
      if (bars.length >= 5) {
        const fiveDaysAgo = bars[bars.length - 5]?.close || 0;
        const latest = bars[bars.length - 1]?.close || 0;
        const fiveDayChange = fiveDaysAgo > 0 ? Math.abs((latest - fiveDaysAgo) / fiveDaysAgo * 100) : 0;
        if (fiveDayChange >= 20) {
          console.log(`[stage1b] removing ${candidates[i].symbol}: 5-day change ${fiveDayChange.toFixed(1)}% exceeds 20%`);
          candidates.splice(i, 1);
        }
      }
    }
  }

  // 7. Stage 1b: fetch IV context
  if (candidates.length > 0) {
    console.log(`[stage1b] fetching IV context for ${candidates.length} candidates...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const iv = await fetchIVContext(c.symbol, crumb, cookies);
      c.ivContext = iv.ivContext;
      c.currentIV = iv.currentIV;
      c.ivLabel = iv.ivLabel;
      if (i < candidates.length - 1) await sleep(150);
    }
  }

  // 8. Stage 1b: fetch news + detect red flags
  if (candidates.length > 0) {
    console.log(`[stage1b] fetching news for ${candidates.length} candidates...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      c.news = await fetchNews(c.symbol, 3);
      c.redFlags = detectRedFlags(c.news);
      if (i < candidates.length - 1) await sleep(100);
    }
  }

  const stats = {
    universe: symbols.length,
    quoted: allQuotes.length,
    passedFilter: candidates.length,
  };

  console.log(`[stage1] done. ${stats.passedFilter} candidates from ${stats.universe} universe.`);

  return { candidates, marketRegime: regime, sectorRankings, stats };
}
