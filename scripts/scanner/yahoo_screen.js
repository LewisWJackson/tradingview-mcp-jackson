/**
 * Stage 1 — Yahoo Finance Bulk Screener
 *
 * Screens ~1,000 tickers via Yahoo Finance API and filters to ~20-50 candidates.
 * Uses only Node.js built-in modules (https, no npm deps).
 *
 * Export: runStage1(symbols) => { candidates, crumb, cookies, stats }
 */

import https from 'node:https';

// ---------------------------------------------------------------------------
// Internal helpers
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
      // Follow redirects (Yahoo sometimes 301/302)
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
async function getCrumb() {
  const init = await yahooGet('https://fc.yahoo.com', '');
  const setCookie = init.headers['set-cookie'] || [];
  const cookies = setCookie.map((c) => c.split(';')[0]).join('; ');
  const crumbRes = await yahooGet('https://query2.finance.yahoo.com/v1/test/getcrumb', cookies);
  if (crumbRes.status !== 200) {
    throw new Error(`getCrumb failed: status ${crumbRes.status}`);
  }
  return { crumb: crumbRes.body.trim(), cookies };
}

/** Fetch a single batch of up to 50 symbols */
async function fetchQuoteBatch(symbols, crumb, cookies) {
  const joined = symbols.map(encodeURIComponent).join(',');
  const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${joined}&crumb=${encodeURIComponent(crumb)}`;
  const res = await yahooGet(url, cookies);
  if (res.status !== 200) {
    throw new Error(`quote batch failed: status ${res.status}`);
  }
  const data = JSON.parse(res.body);
  return data?.quoteResponse?.result || [];
}

/** Fetch options chain and extract IV rank approximation */
async function fetchIVRank(symbol, crumb, cookies) {
  try {
    const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}?crumb=${encodeURIComponent(crumb)}`;
    const res = await yahooGet(url, cookies);
    if (res.status !== 200) return null;
    const data = JSON.parse(res.body);
    const chain = data?.optionChain?.result?.[0];
    if (!chain) return null;

    const quote = chain.quote || {};
    const price = quote.regularMarketPrice || 0;
    const options = chain.options?.[0];
    if (!options) return null;

    // Find nearest ATM option (calls)
    const calls = options.calls || [];
    let nearestATM = null;
    let minDist = Infinity;
    for (const c of calls) {
      const dist = Math.abs(c.strike - price);
      if (dist < minDist) { minDist = dist; nearestATM = c; }
    }

    if (!nearestATM || !nearestATM.impliedVolatility) return null;

    const currentIV = nearestATM.impliedVolatility;

    // Approximate IV rank using historical volatility as proxy:
    // Use regularMarketChangePercent magnitude over trailing period
    // as a rough measure. Yahoo doesn't give historical IV, so we
    // estimate: if current IV is high relative to a typical range
    // (20%-80% annualised), map it to a 0-100 rank.
    const ivLow = 0.15;   // typical low-vol floor
    const ivHigh = 0.80;  // typical high-vol ceiling
    const ivRank = Math.max(0, Math.min(100,
      Math.round(((currentIV - ivLow) / (ivHigh - ivLow)) * 100)
    ));

    return { currentIV: +(currentIV * 100).toFixed(1), ivRank };
  } catch {
    return null;
  }
}

/** Fetch top N Yahoo RSS headlines for a symbol */
async function fetchNews(symbol, max = 3) {
  try {
    const url = `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;
    const res = await yahooGet(url, '');
    if (res.status !== 200) return [];
    return parseRssItems(res.body, max);
  } catch {
    return [];
  }
}

/** Parse RSS XML with regex (same pattern as dashboard builder) */
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
    const title = tag('title');
    const link = tag('link');
    const pubDate = tag('pubDate');
    if (title) items.push({ title, link, pubDate });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Stage 1 filter logic
// ---------------------------------------------------------------------------

/** Does a quote pass Stage 1 filters? */
function passesStage1(q) {
  const price = q.regularMarketPrice || 0;
  const avgVol = q.averageDailyVolume10Day || 0;

  // Hard minimums
  if (price < 5) return false;
  if (avgVol < 200000) return false;

  const volume = q.regularMarketVolume || 0;
  const volumeRatio = avgVol > 0 ? volume / avgVol : 0;
  const changePct = Math.abs(q.regularMarketChangePercent || 0);
  const ma50 = q.fiftyDayAverage || 0;

  // Criterion 1: Volume ratio >= 1.8x
  if (volumeRatio >= 1.8) return true;

  // Criterion 2: Price within 3% of 50-day MA (coiling)
  if (ma50 > 0 && Math.abs(price - ma50) / ma50 <= 0.03) return true;

  // Criterion 3: Day change >= 3% with volume ratio >= 1.5x (breakout)
  if (changePct >= 3 && volumeRatio >= 1.5) return true;

  return false;
}

/** Map Yahoo quote fields to our candidate data shape */
function extractQuoteData(q) {
  const price = q.regularMarketPrice || 0;
  const volume = q.regularMarketVolume || 0;
  const avgVol = q.averageDailyVolume10Day || 0;
  const ma50 = q.fiftyDayAverage || 0;
  const ma200 = q.twoHundredDayAverage || 0;
  const high52w = q.fiftyTwoWeekHigh || 0;
  const low52w = q.fiftyTwoWeekLow || 0;
  const prevClose = q.regularMarketPreviousClose || 0;
  const changePct = q.regularMarketChangePercent || 0;

  const volumeRatio = avgVol > 0 ? volume / avgVol : 0;
  const ma150 = ma50 > 0 && ma200 > 0 ? (ma50 + ma200) / 2 : 0;  // approximate
  const distFrom52wkHigh = high52w > 0 ? ((price - high52w) / high52w) * 100 : 0;
  const gapPct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

  return {
    symbol: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: +price.toFixed(2),
    changePct: +changePct.toFixed(2),
    volume,
    avgVolume: avgVol,
    volumeRatio: +volumeRatio.toFixed(2),
    ma50: +ma50.toFixed(2),
    ma150: +ma150.toFixed(2),
    ma200: +ma200.toFixed(2),
    high52w: +high52w.toFixed(2),
    low52w: +low52w.toFixed(2),
    distFrom52wkHigh: +distFrom52wkHigh.toFixed(1),
    ma200rising: price > ma200,  // proxy: price above 200-day
    emaStacked: price > ma50 && ma50 > ma150 && ma150 > ma200,
    gapPct: +gapPct.toFixed(2),
    gapVolumeRatio: +volumeRatio.toFixed(2),  // same as volumeRatio for day-of
    relStrength: 0,       // filled in ranking step
    relStrengthTop20: false,  // filled in ranking step
    // Filled later by IV and news fetchers
    ivRank: null,
    currentIV: null,
    news: [],
  };
}

// ---------------------------------------------------------------------------
// Relative strength ranking
// ---------------------------------------------------------------------------

/** Rank all quotes by performance vs 200-day MA, mark top 20% */
function rankRelativeStrength(candidates) {
  // relStrength = (price - ma200) / ma200 * 100
  for (const c of candidates) {
    c.relStrength = c.ma200 > 0
      ? +((c.price - c.ma200) / c.ma200 * 100).toFixed(1)
      : 0;
  }
  // Sort descending by relStrength
  const sorted = [...candidates].sort((a, b) => b.relStrength - a.relStrength);
  const cutoff = Math.ceil(sorted.length * 0.2);
  const top20Syms = new Set(sorted.slice(0, cutoff).map((c) => c.symbol));
  for (const c of candidates) {
    c.relStrengthTop20 = top20Syms.has(c.symbol);
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run Stage 1 bulk screen.
 * @param {string[]} symbols — array of ticker strings
 * @returns {Promise<{ candidates: object[], crumb: string, cookies: string, stats: { universe: number, quoted: number, passed: number } }>}
 */
export async function runStage1(symbols) {
  console.log(`[stage1] screening ${symbols.length} symbols via Yahoo Finance...`);

  // 1. Yahoo auth
  const { crumb, cookies } = await getCrumb();
  console.log(`[stage1] authenticated (crumb obtained)`);

  // 2. Batch quote fetch — batches of 50, 200ms delay
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
  console.log('');  // newline after progress

  // 3. Extract data for ALL quotes (for relative strength ranking)
  const allExtracted = allQuotes
    .filter((q) => q && q.regularMarketPrice)
    .map(extractQuoteData);

  // 4. Rank relative strength across full universe
  rankRelativeStrength(allExtracted);

  // 5. Apply Stage 1 filter
  const candidates = allExtracted.filter((c) => {
    // Re-check filter using raw-ish data
    const vol = c.volume;
    const avgVol = c.avgVolume;
    const price = c.price;
    const volumeRatio = c.volumeRatio;
    const changePct = Math.abs(c.changePct);
    const ma50 = c.ma50;

    if (price < 5 || avgVol < 200000) return false;
    if (volumeRatio >= 1.8) return true;
    if (ma50 > 0 && Math.abs(price - ma50) / ma50 <= 0.03) return true;
    if (changePct >= 3 && volumeRatio >= 1.5) return true;
    return false;
  });

  console.log(`[stage1] ${candidates.length} candidates passed filters (from ${allExtracted.length} quotes)`);

  // 6. Fetch IV rank for candidates
  if (candidates.length > 0) {
    console.log(`[stage1] fetching IV rank for ${candidates.length} candidates...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const iv = await fetchIVRank(c.symbol, crumb, cookies);
      if (iv) {
        c.ivRank = iv.ivRank;
        c.currentIV = iv.currentIV;
      }
      if (i < candidates.length - 1) await sleep(150);
    }
  }

  // 7. Fetch news for candidates
  if (candidates.length > 0) {
    console.log(`[stage1] fetching news for ${candidates.length} candidates...`);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      c.news = await fetchNews(c.symbol, 3);
      if (i < candidates.length - 1) await sleep(100);
    }
  }

  const stats = {
    universe: symbols.length,
    quoted: allExtracted.length,
    passed: candidates.length,
  };

  console.log(`[stage1] done. ${stats.passed} candidates from ${stats.universe} universe.`);

  return { candidates, crumb, cookies, stats };
}
