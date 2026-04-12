# Coiled Spring Scanner v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the v1 explosion scanner with a coiled-spring scanner that identifies stocks *before* they rally, using volatility contraction, institutional accumulation, and breakout proximity signals.

**Architecture:** Four-phase build. Phase 1 creates the Yahoo screener (with 3-month OHLCV fetch), scoring engine, and orchestrator. Phase 2 adds comprehensive unit tests with fixture data. Phase 3 updates the HTML dashboard. Phase 4 adds a TradingView Pine Script companion indicator. Each phase produces working, testable output independently.

**Tech Stack:** Node.js 20+ (ESM), Node built-in test runner (`node:test`), Yahoo Finance API (v7 quotes + v8 chart), no npm dependencies added.

**Spec:** `docs/superpowers/specs/2026-04-12-coiled-spring-scanner-v2-design.md`

---

## File Map

```
scripts/scanner/
├── yahoo_screen_v2.js      # Stage 1 + 1b: bulk quote, quality gate, 3-month OHLCV
├── scoring_v2.js            # Scoring engine: 5 categories, confidence, breakout risk
├── coiled_spring_scanner.js # Orchestrator: regime check → screen → score → JSON
├── test_fixtures/
│   └── fixtures.js          # Known-good and known-bad candidate data objects
├── scoring.js               # [DEPRECATED — keep, do not modify]
├── yahoo_screen.js          # [DEPRECATED — keep, do not modify]
├── explosion_scanner.js     # [DEPRECATED — keep, do not modify]
├── universe.json            # [UNCHANGED — reused]
└── coiled_spring_results.json  # Output (gitignored)

tests/
└── coiled_spring_scanner.test.js  # Unit tests for scoring_v2.js

scripts/dashboard/
└── build_dashboard_html.js  # [MODIFY — update Explosion tab → Coiled Springs]

scripts/pine/
└── coiled_spring_score.pine # TradingView Pine Script indicator (Phase 4)
```

---

## Phase 1: Core Scanner Foundation

### Task 1: Yahoo Screen v2 — Helpers and Auth

**Files:**
- Create: `scripts/scanner/yahoo_screen_v2.js`

- [ ] **Step 1: Create yahoo_screen_v2.js with helpers copied from v1**

Copy the auth and HTTP helpers from `yahoo_screen.js` — they work fine. The changes are in the *filter logic* and *data fetching*, not the plumbing.

```js
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
async function getCrumb() {
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
```

- [ ] **Step 2: Verify the file parses without errors**

Run: `node -e "import('./scripts/scanner/yahoo_screen_v2.js')"`
Expected: No output (clean import, no runtime errors)

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/yahoo_screen_v2.js
git commit -m "feat(scanner): scaffold yahoo_screen_v2.js with HTTP/auth helpers"
```

---

### Task 2: Yahoo Screen v2 — Hard Quality Gate + Stage 1 Filter

**Files:**
- Modify: `scripts/scanner/yahoo_screen_v2.js`

- [ ] **Step 1: Add the hard quality gate function**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 2: Add the Stage 1 pre-filter (quiet strength)**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 3: Verify exports parse**

Run: `node -e "import('./scripts/scanner/yahoo_screen_v2.js').then(m => console.log(typeof m.passesQualityGate, typeof m.passesStage1Filter))"`
Expected: `function function`

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/yahoo_screen_v2.js
git commit -m "feat(scanner): add hard quality gate and Stage 1 quiet-strength filter"
```

---

### Task 3: Yahoo Screen v2 — Market Regime + Sector ETFs

**Files:**
- Modify: `scripts/scanner/yahoo_screen_v2.js`

- [ ] **Step 1: Add market regime assessment function**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 2: Verify export**

Run: `node -e "import('./scripts/scanner/yahoo_screen_v2.js').then(m => console.log(typeof m.fetchMarketRegime))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/yahoo_screen_v2.js
git commit -m "feat(scanner): add market regime assessment and sector ETF rankings"
```

---

### Task 4: Yahoo Screen v2 — 3-Month OHLCV Fetch + Red Flags

**Files:**
- Modify: `scripts/scanner/yahoo_screen_v2.js`

- [ ] **Step 1: Add 3-month OHLCV fetch function**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 2: Add red flag scanner**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 3: Verify exports**

Run: `node -e "import('./scripts/scanner/yahoo_screen_v2.js').then(m => console.log(typeof m.fetchOHLCV, typeof m.detectRedFlags))"`
Expected: `function function`

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/yahoo_screen_v2.js
git commit -m "feat(scanner): add 3-month OHLCV fetch and red flag detection"
```

---

### Task 5: Yahoo Screen v2 — IV Context + runStage1 Orchestrator

**Files:**
- Modify: `scripts/scanner/yahoo_screen_v2.js`

- [ ] **Step 1: Add IV context fetcher (honest labeling)**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 2: Add the main runStage1 export**

Append to `yahoo_screen_v2.js`:

```js
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
```

- [ ] **Step 3: Verify the full module exports**

Run: `node -e "import('./scripts/scanner/yahoo_screen_v2.js').then(m => console.log(Object.keys(m).join(', ')))"`
Expected: `passesQualityGate, passesStage1Filter, fetchMarketRegime, fetchOHLCV, detectRedFlags, fetchIVContext, runStage1`

- [ ] **Step 4: Commit**

```bash
git add scripts/scanner/yahoo_screen_v2.js
git commit -m "feat(scanner): complete yahoo_screen_v2.js with Stage 1 + 1b pipeline"
```

---

### Task 6: Scoring Engine v2 — Trend Health

**Files:**
- Create: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Create scoring_v2.js with trend health scoring**

```js
/**
 * Coiled Spring Scanner — Scoring Engine v2
 *
 * Pure-logic module: takes data objects, returns scores, confidence, and risk.
 * No I/O, no network calls.
 *
 * 5 categories, 120 pts total:
 *   Trend Health (30), Contraction Quality (40), Volume Signature (20),
 *   Pivot Structure (15), Catalyst Awareness (15)
 */

// ---------------------------------------------------------------------------
// 1. Trend Health (0-30 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ price: number, ma50: number, ma150: number, ma200: number, high52w: number, relStrengthPctile: number, ohlcv: Array<{high:number, low:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low' }}
 */
export function scoreTrendHealth(d) {
  let pts = 0;
  let hasProxy = false;

  // 50 MA > 150 MA > 200 MA alignment (8 pts)
  if (d.ma50 > d.ma150 && d.ma150 > d.ma200 && d.ma200 > 0) {
    pts += 8;
  }

  // Price above 50-day MA (5 pts)
  if (d.ma50 > 0 && d.price > d.ma50) {
    pts += 5;
  }

  // Within 25% of 52-week high (5 pts)
  if (d.high52w > 0 && d.price >= d.high52w * 0.75) {
    pts += 5;
  }

  // Relative strength vs SPY (7 pts)
  if (d.relStrengthPctile >= 70) {
    pts += 7;
  } else if (d.relStrengthPctile >= 50) {
    pts += 4;
  }

  // Higher highs + higher lows over 20 days (5 pts)
  const bars = d.ohlcv || [];
  if (bars.length >= 20) {
    const recent10 = bars.slice(-10);
    const prior10 = bars.slice(-20, -10);
    const recentHigh = Math.max(...recent10.map((b) => b.high));
    const priorHigh = Math.max(...prior10.map((b) => b.high));
    const recentLow = Math.min(...recent10.map((b) => b.low));
    const priorLow = Math.min(...prior10.map((b) => b.low));
    if (recentHigh > priorHigh && recentLow > priorLow) {
      pts += 5;
    }
  } else {
    hasProxy = true; // insufficient data for HH/HL check
  }

  const confidence = hasProxy ? 'medium' : 'high';
  return { score: pts, confidence };
}
```

- [ ] **Step 2: Verify export**

Run: `node -e "import('./scripts/scanner/scoring_v2.js').then(m => console.log(typeof m.scoreTrendHealth))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add scoreTrendHealth (0-30 pts)"
```

---

### Task 7: Scoring Engine v2 — Contraction Quality

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Add contraction quality scoring**

Append to `scoring_v2.js`:

```js
// ---------------------------------------------------------------------------
// 2. Contraction Quality (0-40 pts)
// ---------------------------------------------------------------------------

/**
 * Calculate ATR (Average True Range) from OHLCV bars.
 * @param {Array<{high:number, low:number, close:number}>} bars
 * @param {number} period
 * @returns {number}
 */
function calcATR(bars, period) {
  if (bars.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Calculate Bollinger Band width from OHLCV bars.
 * @param {Array<{close:number}>} bars
 * @param {number} period
 * @returns {number} BB width as percentage of basis
 */
function calcBBWidth(bars, period) {
  if (bars.length < period) return 0;
  const closes = bars.slice(-period).map((b) => b.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
  const stddev = Math.sqrt(variance);
  return mean > 0 ? (stddev * 2 * 2) / mean * 100 : 0; // 2 std devs * 2 bands / basis
}

/**
 * Detect VCP tightening: successive pullback depths from swing pivots.
 * Uses 3-bar pivot detection (simplified).
 * @param {Array<{high:number, low:number}>} bars
 * @returns {{ contractions: number, depths: number[] }}
 */
function detectVCP(bars) {
  if (bars.length < 15) return { contractions: 0, depths: [] };

  // Find swing highs and lows using 3-bar pivots
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high &&
        bars[i].high > bars[i + 1].high && bars[i].high > bars[i + 2].high) {
      swingHighs.push({ idx: i, price: bars[i].high });
    }
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
        bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
      swingLows.push({ idx: i, price: bars[i].low });
    }
  }

  // Calculate pullback depths: from each swing high to the next swing low
  const depths = [];
  for (let i = 0; i < swingHighs.length; i++) {
    const nextLow = swingLows.find((sl) => sl.idx > swingHighs[i].idx);
    if (nextLow && swingHighs[i].price > 0) {
      const depth = ((swingHighs[i].price - nextLow.price) / swingHighs[i].price) * 100;
      depths.push(+depth.toFixed(1));
    }
  }

  // Count tightening contractions (each shallower than previous)
  let contractions = 0;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i] < depths[i - 1]) {
      contractions++;
    } else {
      break; // must be monotonic
    }
  }

  return { contractions, depths };
}

/**
 * @param {{ ohlcv: Array<{open:number, high:number, low:number, close:number, volume:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', bbWidthPctile: number, atrRatio: number, vcpContractions: number, vcpDepths: number[], dailyRangePct: number }}
 */
export function scoreContractionQuality(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  if (bars.length < 20) {
    return { score: 0, confidence: 'low', bbWidthPctile: 0, atrRatio: 1, vcpContractions: 0, vcpDepths: [], dailyRangePct: 99 };
  }

  // BB Width percentile (12 pts)
  // Compare current BB width to range over all available bars
  const currentBBW = calcBBWidth(bars.slice(-20), 20);
  const allBBWs = [];
  for (let i = 20; i <= bars.length; i++) {
    allBBWs.push(calcBBWidth(bars.slice(i - 20, i), 20));
  }
  allBBWs.sort((a, b) => a - b);
  const bbRank = allBBWs.findIndex((w) => w >= currentBBW);
  const bbWidthPctile = allBBWs.length > 0 ? +(bbRank / allBBWs.length * 100).toFixed(1) : 50;

  if (bbWidthPctile <= 20) pts += 12;
  else if (bbWidthPctile <= 30) pts += 7;

  // ATR contraction ratio (10 pts)
  const atrFast = calcATR(bars, 5);
  const atrSlow = calcATR(bars, 20);
  const atrRatio = atrSlow > 0 ? +(atrFast / atrSlow).toFixed(2) : 1;

  if (atrRatio < 0.5) pts += 10;
  else if (atrRatio < 0.7) pts += 6;

  // VCP tightening (10 pts)
  const vcp = detectVCP(bars);
  if (vcp.contractions >= 3) pts += 10;
  else if (vcp.contractions >= 2) pts += 6;

  if (bars.length < 40) confidence = 'medium'; // less data for VCP detection

  // Tight daily range (8 pts)
  const recent5 = bars.slice(-5);
  const avgRange = recent5.reduce((sum, b) => sum + (b.high - b.low) / b.close * 100, 0) / recent5.length;
  const dailyRangePct = +avgRange.toFixed(2);

  if (dailyRangePct < 3) pts += 8;
  else if (dailyRangePct < 5) pts += 4;

  return {
    score: pts,
    confidence,
    bbWidthPctile,
    atrRatio,
    vcpContractions: vcp.contractions,
    vcpDepths: vcp.depths,
    dailyRangePct,
  };
}
```

- [ ] **Step 2: Verify export**

Run: `node -e "import('./scripts/scanner/scoring_v2.js').then(m => console.log(typeof m.scoreContractionQuality))"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add scoreContractionQuality (0-40 pts) with BB, ATR, VCP, range"
```

---

### Task 8: Scoring Engine v2 — Volume Signature

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Add volume signature scoring**

Append to `scoring_v2.js`:

```js
// ---------------------------------------------------------------------------
// 3. Volume Signature (0-20 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ avgVol10d: number, avgVol3mo: number, ohlcv: Array<{open:number, close:number, volume:number, low:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', volDroughtRatio: number, accumulationDays: number, upDownVolRatio: number, volOnHigherLows: boolean }}
 */
export function scoreVolumeSignature(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  // Volume drought (6 pts)
  const droughtRatio = d.avgVol3mo > 0 ? +(d.avgVol10d / d.avgVol3mo).toFixed(2) : 1;
  if (droughtRatio < 0.7) pts += 6;
  else if (droughtRatio < 0.85) pts += 3;

  // Accumulation days in last 10 sessions (5 pts)
  const recent10 = bars.slice(-10);
  const avgVol = d.avgVol3mo || 0;
  let accumDays = 0;
  for (const b of recent10) {
    if (b.close > b.open && b.volume > avgVol) accumDays++;
  }
  if (accumDays >= 3) pts += 5;
  else if (accumDays >= 2) pts += 3;

  // Up-volume vs down-volume ratio over 20 sessions (5 pts)
  const recent20 = bars.slice(-20);
  let upVol = 0;
  let downVol = 0;
  for (const b of recent20) {
    if (b.close > b.open) upVol += b.volume;
    else downVol += b.volume;
  }
  const udRatio = downVol > 0 ? +(upVol / downVol).toFixed(2) : 0;
  if (udRatio > 1.5) pts += 5;
  else if (udRatio > 1.2) pts += 3;

  // Volume increases on higher lows (4 pts)
  // Find last 3 swing lows, check if volume increases at each
  let volOnHigherLows = false;
  if (bars.length >= 20) {
    const swingLows = [];
    for (let i = 2; i < bars.length - 2; i++) {
      if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
          bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
        swingLows.push({ price: bars[i].low, vol: bars[i].volume });
      }
    }
    const lastThree = swingLows.slice(-3);
    if (lastThree.length >= 2) {
      const pricesRising = lastThree.every((sl, i) => i === 0 || sl.price > lastThree[i - 1].price);
      const volRising = lastThree.every((sl, i) => i === 0 || sl.vol > lastThree[i - 1].vol);
      if (pricesRising && volRising) {
        volOnHigherLows = true;
        pts += 4;
      }
    }
  }

  if (bars.length < 20) confidence = 'medium';
  if (bars.length < 10) confidence = 'low';

  return {
    score: pts,
    confidence,
    volDroughtRatio: droughtRatio,
    accumulationDays: accumDays,
    upDownVolRatio: udRatio,
    volOnHigherLows,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add scoreVolumeSignature (0-20 pts)"
```

---

### Task 9: Scoring Engine v2 — Pivot Structure

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Add pivot structure scoring**

Append to `scoring_v2.js`:

```js
// ---------------------------------------------------------------------------
// 4. Pivot Structure (0-15 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ price: number, ma50: number, ohlcv: Array<{high:number, low:number, close:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', distFromResistance: number, resistanceTouches: number, closePosAvg: number, extendedAbove50ma: boolean }}
 */
export function scorePivotStructure(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  if (bars.length < 20) {
    return { score: 0, confidence: 'low', distFromResistance: 99, resistanceTouches: 0, closePosAvg: 0, extendedAbove50ma: false };
  }

  const recent20 = bars.slice(-20);
  const resistance = Math.max(...recent20.map((b) => b.high));

  // Distance from resistance (6 pts)
  const distPct = resistance > 0 ? +((resistance - d.price) / resistance * 100).toFixed(1) : 99;
  if (distPct <= 3) pts += 6;
  else if (distPct <= 5) pts += 4;
  else if (distPct <= 8) pts += 2;

  // Resistance tested at least twice (4 pts)
  const touchZone = resistance * 0.99;
  let touches = 0;
  for (const b of recent20) {
    if (b.high >= touchZone) touches++;
  }
  if (touches >= 2) pts += 4;

  // Tight closes near highs of range (3 pts)
  const recent5 = bars.slice(-5);
  const closePosAvg = recent5.reduce((sum, b) => {
    const range = b.high - b.low;
    return sum + (range > 0.01 ? (b.close - b.low) / range : 0.5);
  }, 0) / recent5.length;

  if (closePosAvg > 0.7) pts += 3;

  // Higher lows structure (2 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
        bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
      swingLows.push(bars[i].low);
    }
  }
  const lastThreeLows = swingLows.slice(-3);
  if (lastThreeLows.length >= 2 && lastThreeLows.every((l, i) => i === 0 || l > lastThreeLows[i - 1])) {
    pts += 2;
  }

  // Penalty: extended > 10% above 50-day MA
  const extendedAbove50ma = d.ma50 > 0 && ((d.price - d.ma50) / d.ma50 * 100) > 10;
  if (extendedAbove50ma) pts = Math.max(pts - 5, 0);

  return {
    score: pts,
    confidence: bars.length < 40 ? 'medium' : confidence,
    distFromResistance: distPct,
    resistanceTouches: touches,
    closePosAvg: +closePosAvg.toFixed(2),
    extendedAbove50ma,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add scorePivotStructure (0-15 pts) with extension penalty"
```

---

### Task 10: Scoring Engine v2 — Catalyst Awareness

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Add catalyst awareness scoring**

Append to `scoring_v2.js`:

```js
// ---------------------------------------------------------------------------
// 5. Catalyst Awareness (0-15 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ earningsTimestamp: number|null, news: Array<{title:string}>, sectorRank: number, shortPercentOfFloat: number|null }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', earningsDaysOut: number|null, sectorMomentumRank: number, shortFloat: number|null }}
 */
export function scoreCatalystAwareness(d) {
  let pts = 0;
  let confidence = 'high';
  let earningsDaysOut = null;

  // Earnings within 30-45 days (5 pts)
  if (d.earningsTimestamp) {
    const now = Date.now() / 1000;
    const daysOut = Math.round((d.earningsTimestamp - now) / 86400);
    earningsDaysOut = daysOut;
    if (daysOut >= 30 && daysOut <= 45) pts += 5;
    else if (daysOut > 0 && daysOut < 30) pts += 2;
  } else {
    confidence = 'medium'; // no earnings date available
  }

  // Analyst upgrades or estimate revisions (3 pts)
  const upgradeKeywords = ['upgrade', 'buy rating', 'price target raised', 'guidance', 'estimate'];
  const newsText = (d.news || []).map((n) => n.title.toLowerCase()).join(' ');
  if (upgradeKeywords.some((kw) => newsText.includes(kw))) {
    pts += 3;
  }

  // Sector momentum tailwind (4 pts)
  const rank = d.sectorRank ?? 99;
  if (rank <= 3) pts += 4;
  else if (rank <= 5) pts += 2;

  // Elevated short interest (3 pts)
  const sf = d.shortPercentOfFloat;
  if (sf != null) {
    if (sf > 15) pts += 3;
    else if (sf > 10) pts += 2;
  } else {
    if (confidence === 'high') confidence = 'medium'; // missing data
  }

  return {
    score: pts,
    confidence,
    earningsDaysOut,
    sectorMomentumRank: rank,
    shortFloat: d.shortPercentOfFloat ?? null,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add scoreCatalystAwareness (0-15 pts)"
```

---

### Task 11: Scoring Engine v2 — Composite Score, Confidence, Breakout Risk, Classification

**Files:**
- Modify: `scripts/scanner/scoring_v2.js`

- [ ] **Step 1: Add composite score, confidence, breakout risk, classification, and play generation**

Append to `scoring_v2.js`:

```js
// ---------------------------------------------------------------------------
// Composite Score + Confidence + Breakout Risk + Classification
// ---------------------------------------------------------------------------

/**
 * Compute the composite score from all 5 category results.
 * @param {{ trend: {score:number, confidence:string}, contraction: {score:number, confidence:string, atrRatio:number, distFromResistance?:number}, volume: {score:number, confidence:string, upDownVolRatio:number}, pivot: {score:number, confidence:string, distFromResistance:number, extendedAbove50ma:boolean}, catalyst: {score:number, confidence:string, earningsDaysOut:number|null} }} cats
 * @param {{ regime: string, sectorRank: number }} context
 * @returns {{ score: number, signals: object, scoreConfidence: string, breakoutRisk: string, breakoutRiskDrivers: string[] }}
 */
export function computeCompositeScore(cats, context = {}) {
  const score = cats.trend.score + cats.contraction.score + cats.volume.score + cats.pivot.score + cats.catalyst.score;

  const signals = {
    trendHealth: cats.trend.score,
    contraction: cats.contraction.score,
    volumeSignature: cats.volume.score,
    pivotProximity: cats.pivot.score,
    catalystAwareness: cats.catalyst.score,
  };

  // Score confidence: weakest link
  const confidences = [cats.trend.confidence, cats.contraction.confidence, cats.volume.confidence, cats.pivot.confidence, cats.catalyst.confidence];
  let scoreConfidence = 'high';
  if (confidences.includes('low')) scoreConfidence = 'low';
  else if (confidences.includes('medium')) scoreConfidence = 'medium';

  // Breakout risk assessment (0-5 drivers)
  const breakoutRiskDrivers = [];
  if (cats.pivot.extendedAbove50ma) breakoutRiskDrivers.push('extended_above_ma');
  if (cats.contraction.atrRatio > 0.8 && cats.pivot.distFromResistance < 5) breakoutRiskDrivers.push('volatile_near_resistance');
  if (cats.volume.upDownVolRatio < 1.1) breakoutRiskDrivers.push('weak_accumulation');
  if (context.regime === 'cautious' || context.regime === 'defensive') breakoutRiskDrivers.push('weak_market_backdrop');
  if (cats.catalyst.earningsDaysOut != null && cats.catalyst.earningsDaysOut < 20 && cats.catalyst.earningsDaysOut > 0) breakoutRiskDrivers.push('imminent_earnings');

  const driverCount = breakoutRiskDrivers.length;
  const breakoutRisk = driverCount <= 1 ? 'low' : driverCount <= 3 ? 'medium' : 'high';

  return { score, signals, scoreConfidence, breakoutRisk, breakoutRiskDrivers };
}

/**
 * Classify a scored candidate.
 * @param {{ score: number, signals: object, distFromResistance: number }} candidate
 * @returns {string} 'coiled_spring' | 'building_base' | 'catalyst_loaded' | 'below_threshold'
 */
export function classifyCandidate(candidate) {
  const { score, signals } = candidate;

  // Coiled Spring: score >= 85, contraction >= 30, volume >= 10, pivot distance <= 8%
  if (score >= 85 && signals.contraction >= 30 && signals.volumeSignature >= 10 && candidate.distFromResistance <= 8) {
    return 'coiled_spring';
  }

  // Catalyst Loaded: catalyst >= 12, trend >= 20
  if (signals.catalystAwareness >= 12 && signals.trendHealth >= 20) {
    return 'catalyst_loaded';
  }

  // Building Base: score 60-84, trend >= 15
  if (score >= 60 && signals.trendHealth >= 15) {
    return 'building_base';
  }

  return 'below_threshold';
}

/**
 * Generate a play recommendation.
 * @param {string} symbol
 * @param {string} classification
 * @param {{ ma50: number, distFromResistance: number, price: number }} details
 * @param {string} regime — market regime
 * @returns {string}
 */
export function generatePlay(symbol, classification, details, regime) {
  if (regime === 'defensive') {
    return `${symbol}: DEFENSIVE REGIME — no new entries. Watchlist only.`;
  }

  const watchOnly = regime === 'cautious' ? ' (reduced conviction — cautious regime)' : '';

  if (classification === 'coiled_spring') {
    const support = details.ma50 > 0 ? `$${details.ma50.toFixed(0)}` : 'rising 50-day MA';
    const resist = details.price > 0 && details.distFromResistance > 0
      ? `$${(details.price * (1 + details.distFromResistance / 100)).toFixed(0)}`
      : 'resistance';
    return `${symbol}: Sell CSP at support (${support}). If assigned, hold for breakout, sell CC at ${resist}.${watchOnly}`;
  }

  if (classification === 'catalyst_loaded') {
    return `${symbol}: Sell CSP 30-45 DTE into rising IV. Premium play — if assigned, own a trending stock at a discount.${watchOnly}`;
  }

  if (classification === 'building_base') {
    return `${symbol}: Watchlist. Set alert at 20-day high for breakout trigger. Do not enter yet.`;
  }

  return `${symbol}: Below threshold — no active play.`;
}
```

- [ ] **Step 2: Verify all exports**

Run: `node -e "import('./scripts/scanner/scoring_v2.js').then(m => console.log(Object.keys(m).join(', ')))"`
Expected: `scoreTrendHealth, scoreContractionQuality, scoreVolumeSignature, scorePivotStructure, scoreCatalystAwareness, computeCompositeScore, classifyCandidate, generatePlay`

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/scoring_v2.js
git commit -m "feat(scoring): add composite score, confidence, breakout risk, classification, plays"
```

---

### Task 12: Orchestrator — coiled_spring_scanner.js

**Files:**
- Create: `scripts/scanner/coiled_spring_scanner.js`

- [ ] **Step 1: Create the orchestrator**

```js
#!/usr/bin/env node
/**
 * Coiled Spring Scanner v2 — Main Orchestrator
 *
 * Ties Stage 1/1b (Yahoo screen) + scoring engine together.
 * Writes coiled_spring_results.json.
 *
 * Usage:
 *   node scripts/scanner/coiled_spring_scanner.js [--top=N]
 *
 *   --top=N   Max candidates to output (default 20)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runStage1 } from './yahoo_screen_v2.js';
import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
} from './scoring_v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const topArg = args.find((a) => a.startsWith('--top='));
const topN = topArg ? parseInt(topArg.split('=')[1], 10) || 20 : 20;

// ---------------------------------------------------------------------------
// Sector mapping (symbol → sector ETF)
// ---------------------------------------------------------------------------

const SECTOR_MAP = {
  // This is a simplified mapping. For full accuracy, use Yahoo's sector field.
  // The scanner uses sectorRankings from fetchMarketRegime instead.
};

function getSectorRank(symbol, quote, sectorRankings) {
  // Use Yahoo sector field if available, map to ETF, find rank
  // Fallback: return 6 (middle of pack)
  return 6;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Coiled Spring Scanner v2 ===\n');

  // 1. Load universe
  const universeFile = resolve(__dirname, 'universe.json');
  const universe = JSON.parse(readFileSync(universeFile, 'utf-8'));
  const symbols = universe.symbols || universe;

  // 2. Run Stage 1 + 1b
  const { candidates, marketRegime, sectorRankings, stats } = await runStage1(symbols);

  console.log(`\n[scoring] scoring ${candidates.length} candidates...\n`);

  // 3. Score each candidate
  const scored = [];
  for (const c of candidates) {
    const sectorRank = getSectorRank(c.symbol, c, sectorRankings);

    const trend = scoreTrendHealth(c);
    const contraction = scoreContractionQuality(c);
    const volume = scoreVolumeSignature(c);
    const pivot = scorePivotStructure(c);
    const catalyst = scoreCatalystAwareness({
      ...c,
      sectorRank,
    });

    const composite = computeCompositeScore(
      { trend, contraction, volume, pivot, catalyst },
      { regime: marketRegime.regime, sectorRank },
    );

    const classification = classifyCandidate({
      score: composite.score,
      signals: composite.signals,
      distFromResistance: pivot.distFromResistance,
    });

    if (classification === 'below_threshold') continue;

    const play = generatePlay(c.symbol, classification, {
      ma50: c.ma50,
      distFromResistance: pivot.distFromResistance,
      price: c.price,
    }, marketRegime.regime);

    scored.push({
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      changePct: c.changePct,
      score: composite.score,
      scoreConfidence: composite.scoreConfidence,
      classification,
      breakoutRisk: composite.breakoutRisk,
      breakoutRiskDrivers: composite.breakoutRiskDrivers,
      redFlags: c.redFlags,
      signals: composite.signals,
      details: {
        ma50: c.ma50,
        ma150: c.ma150,
        ma200: c.ma200,
        maStacked: c.ma50 > c.ma150 && c.ma150 > c.ma200,
        relStrengthPctile: c.relStrengthPctile || 0,
        bbWidthPctile: contraction.bbWidthPctile,
        atrRatio: contraction.atrRatio,
        vcpContractions: contraction.vcpContractions,
        vcpDepths: contraction.vcpDepths,
        dailyRangePct: contraction.dailyRangePct,
        volDroughtRatio: volume.volDroughtRatio,
        accumulationDays: volume.accumulationDays,
        upDownVolRatio: volume.upDownVolRatio,
        distFromResistance: pivot.distFromResistance,
        resistanceTouches: pivot.resistanceTouches,
        extendedAbove50ma: pivot.extendedAbove50ma,
        earningsDaysOut: catalyst.earningsDaysOut,
        sectorMomentumRank: catalyst.sectorMomentumRank,
        shortFloat: catalyst.shortFloat,
        ivContext: c.ivContext,
        ivLabel: c.ivLabel,
      },
      play,
      news: c.news,
    });
  }

  // 4. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topN);

  // 5. Write output
  const output = {
    scanDate: new Date().toISOString().slice(0, 10),
    scannedAt: new Date().toISOString(),
    universe: stats.universe,
    stage1Passed: stats.passedFilter,
    marketRegime,
    results,
  };

  const outFile = resolve(__dirname, 'coiled_spring_results.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  // 6. Summary
  console.log(`\n=== Results ===`);
  console.log(`Market regime: ${marketRegime.regime} (VIX ${marketRegime.vixLevel})`);
  console.log(`Universe: ${stats.universe} → Stage 1: ${stats.passedFilter} → Scored: ${scored.length} → Top ${results.length}`);

  for (const r of results) {
    const conf = r.scoreConfidence === 'high' ? '' : ` [${r.scoreConfidence} confidence]`;
    const risk = r.breakoutRisk !== 'low' ? ` ⚠${r.breakoutRisk} risk` : '';
    const flags = r.redFlags.length > 0 ? ` 🚩${r.redFlags.join(',')}` : '';
    console.log(`  ${r.score} ${r.classification.padEnd(16)} ${r.symbol.padEnd(6)} $${r.price}${conf}${risk}${flags}`);
  }

  console.log(`\nOutput: ${outFile}`);
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it parses**

Run: `node -e "import('./scripts/scanner/coiled_spring_scanner.js')" 2>&1 | head -1`
Expected: `=== Coiled Spring Scanner v2 ===` (it will start running; Ctrl+C to stop, or let it complete)

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/coiled_spring_scanner.js
git commit -m "feat(scanner): add coiled_spring_scanner.js orchestrator"
```

---

### Task 13: First Live Run

**Files:** None created — validation only.

- [ ] **Step 1: Run the scanner end-to-end**

Run: `node scripts/scanner/coiled_spring_scanner.js --top=10`
Expected: Scanner completes without errors, writes `coiled_spring_results.json`, prints summary with scored candidates.

- [ ] **Step 2: Validate output schema**

Run: `node -e "const r = JSON.parse(require('fs').readFileSync('scripts/scanner/coiled_spring_results.json','utf-8')); console.log('regime:', r.marketRegime.regime); console.log('results:', r.results.length); if(r.results[0]) { const c = r.results[0]; console.log('first:', c.symbol, c.score, c.scoreConfidence, c.classification, c.breakoutRisk, c.redFlags); }"`
Expected: Prints regime, result count, and first candidate with all new fields populated.

- [ ] **Step 3: Spot-check — no already-exploded stocks**

Verify no candidate has `changePct > 15` or a 5-day move > 20%. Check that no delisted/acquired stocks made it through.

- [ ] **Step 4: Commit results (optional, for reference)**

```bash
git add scripts/scanner/coiled_spring_results.json
git commit -m "data: first coiled spring scanner v2 run results"
```

---

## Phase 2: Trust and Validation

### Task 14: Test Fixtures

**Files:**
- Create: `scripts/scanner/test_fixtures/fixtures.js`

- [ ] **Step 1: Create fixture data**

```js
/**
 * Test fixtures for Coiled Spring Scanner v2.
 * Each fixture is a candidate data object matching the shape
 * expected by scoring_v2.js functions.
 */

// Generate N days of OHLCV bars with configurable behavior
function makeBars(count, { basePrice = 50, trend = 'flat', volatility = 'normal', volumeBase = 1000000, volumeTrend = 'flat' } = {}) {
  const bars = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const dayFactor = i / count;
    // Price trend
    if (trend === 'up') price += basePrice * 0.003;
    else if (trend === 'down') price -= basePrice * 0.003;

    // Volatility
    let rangePct = 0.02; // 2% normal range
    if (volatility === 'tight') rangePct = 0.01;
    else if (volatility === 'contracting') rangePct = 0.03 * (1 - dayFactor * 0.7); // 3% → 0.9%
    else if (volatility === 'wide') rangePct = 0.05;

    const range = price * rangePct;
    const open = price - range * 0.3;
    const high = price + range * 0.5;
    const low = price - range * 0.5;
    const close = price + range * 0.2; // slight upward bias

    // Volume
    let vol = volumeBase;
    if (volumeTrend === 'drying') vol = volumeBase * (1 - dayFactor * 0.5);
    else if (volumeTrend === 'surging') vol = volumeBase * (1 + dayFactor * 3);

    bars.push({
      date: `2026-0${1 + Math.floor(i / 30)}-${String((i % 30) + 1).padStart(2, '0')}`,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(vol),
    });
  }
  return bars;
}

/** Valid coiled spring — tight BB, low ATR, stacked MAs, accumulation days */
export const VALID_COIL = {
  price: 85.50,
  ma50: 82.10,
  ma150: 78.50,
  ma200: 74.20,
  high52w: 88.00,
  relStrengthPctile: 82,
  avgVol10d: 800000,
  avgVol3mo: 1500000,
  earningsTimestamp: Math.floor(Date.now() / 1000) + 35 * 86400, // 35 days out
  shortPercentOfFloat: 12,
  news: [{ title: 'Analyst upgrades EXAMPLE to buy rating' }],
  sectorRank: 2,
  ohlcv: makeBars(63, { basePrice: 80, trend: 'up', volatility: 'contracting', volumeBase: 1500000, volumeTrend: 'drying' }),
};

/** Already exploded — ZNTL-like: huge gap, massive volume */
export const ALREADY_EXPLODED = {
  price: 6.61,
  ma50: 2.63,
  ma150: 2.25,
  ma200: 1.88,
  high52w: 7.00,
  relStrengthPctile: 95,
  avgVol10d: 5000000,
  avgVol3mo: 700000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 5,
  ohlcv: makeBars(63, { basePrice: 4, trend: 'up', volatility: 'wide', volumeBase: 700000, volumeTrend: 'surging' }),
};

/** Broken down — below 200-day MA, downtrend */
export const BROKEN_DOWN = {
  price: 35.00,
  ma50: 38.00,
  ma150: 42.00,
  ma200: 45.00,
  high52w: 60.00,
  relStrengthPctile: 15,
  avgVol10d: 1200000,
  avgVol3mo: 1500000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [{ title: 'Company sued in class action lawsuit' }],
  sectorRank: 9,
  ohlcv: makeBars(63, { basePrice: 45, trend: 'down', volatility: 'normal' }),
};

/** Illiquid — too little volume for options */
export const ILLIQUID = {
  price: 22.00,
  ma50: 20.00,
  ma150: 19.00,
  ma200: 18.00,
  high52w: 25.00,
  relStrengthPctile: 60,
  avgVol10d: 50000,
  avgVol3mo: 80000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 6,
  ohlcv: makeBars(63, { basePrice: 20, trend: 'up', volatility: 'tight', volumeBase: 80000, volumeTrend: 'drying' }),
};

/** Fake compression — tight range but no accumulation, dead money */
export const FAKE_COMPRESSION = {
  price: 42.00,
  ma50: 41.50,
  ma150: 41.00,
  ma200: 40.50,
  high52w: 48.00,
  relStrengthPctile: 40,
  avgVol10d: 900000,
  avgVol3mo: 1000000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 8,
  ohlcv: makeBars(63, { basePrice: 41.5, trend: 'flat', volatility: 'tight', volumeBase: 1000000, volumeTrend: 'flat' }),
};

/** Edge case: score near classification boundary */
export const BOUNDARY_CANDIDATE = {
  price: 55.00,
  ma50: 53.00,
  ma150: 50.00,
  ma200: 48.00,
  high52w: 58.00,
  relStrengthPctile: 65,
  avgVol10d: 1100000,
  avgVol3mo: 1400000,
  earningsTimestamp: Math.floor(Date.now() / 1000) + 40 * 86400,
  shortPercentOfFloat: 8,
  news: [],
  sectorRank: 4,
  ohlcv: makeBars(63, { basePrice: 52, trend: 'up', volatility: 'contracting', volumeBase: 1400000, volumeTrend: 'drying' }),
};

export { makeBars };
```

- [ ] **Step 2: Verify import**

Run: `node -e "import('./scripts/scanner/test_fixtures/fixtures.js').then(m => console.log(Object.keys(m).join(', ')))"`
Expected: `VALID_COIL, ALREADY_EXPLODED, BROKEN_DOWN, ILLIQUID, FAKE_COMPRESSION, BOUNDARY_CANDIDATE, makeBars`

- [ ] **Step 3: Commit**

```bash
git add scripts/scanner/test_fixtures/fixtures.js
git commit -m "test: add fixture library for coiled spring scanner v2"
```

---

### Task 15: Unit Tests — Trend Health + Contraction Quality

**Files:**
- Create: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Create test file with trend health and contraction tests**

```js
/**
 * Unit tests for Coiled Spring Scanner v2 scoring engine.
 * Pure logic — no network, no TradingView.
 *
 * Run: node --test tests/coiled_spring_scanner.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
} from '../scripts/scanner/scoring_v2.js';

import {
  VALID_COIL,
  ALREADY_EXPLODED,
  BROKEN_DOWN,
  ILLIQUID,
  FAKE_COMPRESSION,
  BOUNDARY_CANDIDATE,
  makeBars,
} from '../scripts/scanner/test_fixtures/fixtures.js';

// ---------------------------------------------------------------------------
// scoreTrendHealth (0-30 pts)
// ---------------------------------------------------------------------------
describe('scoreTrendHealth', () => {
  it('returns high score for valid coil (stacked MAs, strong RS)', () => {
    const { score, confidence } = scoreTrendHealth(VALID_COIL);
    assert.ok(score >= 20, `expected >= 20, got ${score}`);
    assert.equal(confidence, 'high');
  });

  it('returns low score for broken-down stock', () => {
    const { score } = scoreTrendHealth(BROKEN_DOWN);
    assert.ok(score <= 5, `expected <= 5, got ${score}`);
  });

  it('gives 8 pts for stacked MA alignment', () => {
    const { score } = scoreTrendHealth({
      price: 100, ma50: 90, ma150: 85, ma200: 80, high52w: 200,
      relStrengthPctile: 0, ohlcv: [],
    });
    assert.ok(score >= 8, `stacked MAs should give at least 8, got ${score}`);
  });

  it('gives 0 for inverted MAs', () => {
    const { score } = scoreTrendHealth({
      price: 50, ma50: 60, ma150: 70, ma200: 80, high52w: 100,
      relStrengthPctile: 0, ohlcv: [],
    });
    assert.equal(score, 0);
  });

  it('returns medium confidence when OHLCV has < 20 bars', () => {
    const { confidence } = scoreTrendHealth({
      ...VALID_COIL,
      ohlcv: makeBars(10),
    });
    assert.equal(confidence, 'medium');
  });

  it('awards 7 pts for top 30% relative strength', () => {
    const { score: high } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 75 });
    const { score: mid } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 55 });
    const { score: low } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 30 });
    assert.ok(high > mid, 'top 30% should score higher than top 50%');
    assert.ok(mid > low, 'top 50% should score higher than bottom');
  });
});

// ---------------------------------------------------------------------------
// scoreContractionQuality (0-40 pts)
// ---------------------------------------------------------------------------
describe('scoreContractionQuality', () => {
  it('returns high score for contracting volatility', () => {
    const { score } = scoreContractionQuality(VALID_COIL);
    assert.ok(score >= 15, `expected >= 15 for contracting vol, got ${score}`);
  });

  it('returns low score for wide/volatile bars', () => {
    const { score } = scoreContractionQuality(ALREADY_EXPLODED);
    assert.ok(score <= 10, `expected <= 10 for wide vol, got ${score}`);
  });

  it('returns 0 with confidence low for < 20 bars', () => {
    const result = scoreContractionQuality({ ohlcv: makeBars(5) });
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 'low');
  });

  it('detects VCP contractions in contracting fixture', () => {
    const { vcpContractions } = scoreContractionQuality(VALID_COIL);
    assert.ok(vcpContractions >= 1, `expected at least 1 VCP contraction, got ${vcpContractions}`);
  });

  it('reports tight daily range for low-volatility bars', () => {
    const tight = scoreContractionQuality({
      ohlcv: makeBars(30, { volatility: 'tight' }),
    });
    assert.ok(tight.dailyRangePct < 5, `expected < 5%, got ${tight.dailyRangePct}`);
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `node --test tests/coiled_spring_scanner.test.js`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/coiled_spring_scanner.test.js
git commit -m "test: add trend health and contraction quality tests"
```

---

### Task 16: Unit Tests — Volume Signature + Pivot Structure + Catalyst

**Files:**
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Add volume, pivot, and catalyst tests**

Append to `tests/coiled_spring_scanner.test.js`:

```js
// ---------------------------------------------------------------------------
// scoreVolumeSignature (0-20 pts)
// ---------------------------------------------------------------------------
describe('scoreVolumeSignature', () => {
  it('rewards volume drought (low 10d vs 3mo ratio)', () => {
    const { score, volDroughtRatio } = scoreVolumeSignature(VALID_COIL);
    assert.ok(volDroughtRatio < 0.85, `expected drought ratio < 0.85, got ${volDroughtRatio}`);
    assert.ok(score >= 3, `expected >= 3 pts for drought, got ${score}`);
  });

  it('gives 0 for surging volume (no drought)', () => {
    const { volDroughtRatio } = scoreVolumeSignature(ALREADY_EXPLODED);
    assert.ok(volDroughtRatio > 1, `expected ratio > 1 for surging vol, got ${volDroughtRatio}`);
  });

  it('distinguishes real accumulation from dead money', () => {
    const coil = scoreVolumeSignature(VALID_COIL);
    const dead = scoreVolumeSignature(FAKE_COMPRESSION);
    assert.ok(coil.score > dead.score, `coil (${coil.score}) should score higher than dead money (${dead.score})`);
  });

  it('returns low confidence for < 10 bars', () => {
    const { confidence } = scoreVolumeSignature({ avgVol10d: 1000000, avgVol3mo: 1500000, ohlcv: makeBars(5) });
    assert.equal(confidence, 'low');
  });
});

// ---------------------------------------------------------------------------
// scorePivotStructure (0-15 pts)
// ---------------------------------------------------------------------------
describe('scorePivotStructure', () => {
  it('scores high when price is near resistance', () => {
    const { score, distFromResistance } = scorePivotStructure(VALID_COIL);
    assert.ok(distFromResistance <= 10, `expected near resistance, got ${distFromResistance}%`);
    assert.ok(score >= 4, `expected >= 4 pts near resistance, got ${score}`);
  });

  it('penalizes extension > 10% above 50-day MA', () => {
    const extended = {
      price: 100,
      ma50: 80, // 25% above
      ohlcv: makeBars(30, { basePrice: 95 }),
    };
    const { extendedAbove50ma, score } = scorePivotStructure(extended);
    assert.equal(extendedAbove50ma, true);
    // Score should be reduced by penalty
  });

  it('returns 0 with low confidence for < 20 bars', () => {
    const result = scorePivotStructure({ price: 50, ma50: 45, ohlcv: makeBars(5) });
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 'low');
  });
});

// ---------------------------------------------------------------------------
// scoreCatalystAwareness (0-15 pts)
// ---------------------------------------------------------------------------
describe('scoreCatalystAwareness', () => {
  it('awards 5 pts for earnings 30-45 days out', () => {
    const { score, earningsDaysOut } = scoreCatalystAwareness(VALID_COIL);
    assert.ok(earningsDaysOut >= 30 && earningsDaysOut <= 45, `expected 30-45d out, got ${earningsDaysOut}`);
    assert.ok(score >= 5, `expected >= 5 pts, got ${score}`);
  });

  it('awards 2 pts for earnings < 30 days', () => {
    const close = {
      ...VALID_COIL,
      earningsTimestamp: Math.floor(Date.now() / 1000) + 15 * 86400,
    };
    const { score } = scoreCatalystAwareness(close);
    assert.ok(score >= 2, 'should get at least 2 pts for close earnings');
  });

  it('returns medium confidence when no earnings date', () => {
    const { confidence } = scoreCatalystAwareness({ ...VALID_COIL, earningsTimestamp: null });
    assert.equal(confidence, 'medium');
  });

  it('detects upgrade keywords in news', () => {
    const { score: withUpgrade } = scoreCatalystAwareness(VALID_COIL);
    const { score: withoutUpgrade } = scoreCatalystAwareness({ ...VALID_COIL, news: [] });
    assert.ok(withUpgrade > withoutUpgrade, 'upgrade news should add points');
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `node --test tests/coiled_spring_scanner.test.js`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/coiled_spring_scanner.test.js
git commit -m "test: add volume, pivot, and catalyst scoring tests"
```

---

### Task 17: Unit Tests — Composite Score, Classification, Red Flags

**Files:**
- Modify: `tests/coiled_spring_scanner.test.js`

- [ ] **Step 1: Add composite, classification, and red flag tests**

Append to `tests/coiled_spring_scanner.test.js`:

```js
import { detectRedFlags } from '../scripts/scanner/yahoo_screen_v2.js';

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------
describe('computeCompositeScore', () => {
  it('sums all category scores', () => {
    const result = computeCompositeScore({
      trend: { score: 25, confidence: 'high' },
      contraction: { score: 35, confidence: 'high', atrRatio: 0.4 },
      volume: { score: 15, confidence: 'high', upDownVolRatio: 1.6 },
      pivot: { score: 12, confidence: 'high', distFromResistance: 3, extendedAbove50ma: false },
      catalyst: { score: 8, confidence: 'high', earningsDaysOut: 35 },
    });
    assert.equal(result.score, 95);
  });

  it('confidence is weakest link', () => {
    const result = computeCompositeScore({
      trend: { score: 20, confidence: 'high' },
      contraction: { score: 30, confidence: 'medium' },
      volume: { score: 10, confidence: 'high' },
      pivot: { score: 8, confidence: 'high', distFromResistance: 5, extendedAbove50ma: false },
      catalyst: { score: 5, confidence: 'low', earningsDaysOut: null },
    });
    assert.equal(result.scoreConfidence, 'low');
  });

  it('detects breakout risk drivers', () => {
    const result = computeCompositeScore({
      trend: { score: 20, confidence: 'high' },
      contraction: { score: 30, confidence: 'high', atrRatio: 0.9 },
      volume: { score: 10, confidence: 'high', upDownVolRatio: 0.9 },
      pivot: { score: 8, confidence: 'high', distFromResistance: 3, extendedAbove50ma: true },
      catalyst: { score: 5, confidence: 'high', earningsDaysOut: 15 },
    }, { regime: 'cautious' });
    assert.ok(result.breakoutRiskDrivers.includes('extended_above_ma'));
    assert.ok(result.breakoutRiskDrivers.includes('weak_accumulation'));
    assert.ok(result.breakoutRiskDrivers.includes('weak_market_backdrop'));
    assert.ok(result.breakoutRiskDrivers.includes('imminent_earnings'));
    assert.equal(result.breakoutRisk, 'high');
  });
});

// ---------------------------------------------------------------------------
// classifyCandidate
// ---------------------------------------------------------------------------
describe('classifyCandidate', () => {
  it('classifies coiled spring correctly', () => {
    const cls = classifyCandidate({
      score: 90,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      distFromResistance: 3,
    });
    assert.equal(cls, 'coiled_spring');
  });

  it('classifies building base for score 60-84', () => {
    const cls = classifyCandidate({
      score: 70,
      signals: { trendHealth: 20, contraction: 20, volumeSignature: 10, pivotProximity: 10, catalystAwareness: 10 },
      distFromResistance: 12,
    });
    assert.equal(cls, 'building_base');
  });

  it('classifies catalyst loaded', () => {
    const cls = classifyCandidate({
      score: 75,
      signals: { trendHealth: 25, contraction: 15, volumeSignature: 10, pivotProximity: 12, catalystAwareness: 13 },
      distFromResistance: 10,
    });
    assert.equal(cls, 'catalyst_loaded');
  });

  it('returns below_threshold for low scores', () => {
    const cls = classifyCandidate({
      score: 40,
      signals: { trendHealth: 10, contraction: 10, volumeSignature: 5, pivotProximity: 10, catalystAwareness: 5 },
      distFromResistance: 15,
    });
    assert.equal(cls, 'below_threshold');
  });

  it('requires contraction >= 30 for coiled spring', () => {
    const cls = classifyCandidate({
      score: 90,
      signals: { trendHealth: 25, contraction: 25, volumeSignature: 15, pivotProximity: 15, catalystAwareness: 10 },
      distFromResistance: 3,
    });
    assert.notEqual(cls, 'coiled_spring', 'contraction 25 < 30 threshold');
  });
});

// ---------------------------------------------------------------------------
// detectRedFlags
// ---------------------------------------------------------------------------
describe('detectRedFlags', () => {
  it('detects dilution keywords', () => {
    const flags = detectRedFlags([{ title: 'Company announces secondary offering' }]);
    assert.ok(flags.includes('dilution_risk'));
  });

  it('detects litigation keywords', () => {
    const flags = detectRedFlags([{ title: 'Company sued in class action lawsuit' }]);
    assert.ok(flags.includes('litigation'));
  });

  it('detects merger keywords', () => {
    const flags = detectRedFlags([{ title: 'Reports of takeover bid emerge' }]);
    assert.ok(flags.includes('merger_pending'));
  });

  it('returns empty array for clean news', () => {
    const flags = detectRedFlags([{ title: 'Company reports strong Q1 earnings' }]);
    assert.deepEqual(flags, []);
  });

  it('detects multiple flags', () => {
    const flags = detectRedFlags([
      { title: 'Company sued in lawsuit' },
      { title: 'New secondary offering announced' },
    ]);
    assert.ok(flags.includes('litigation'));
    assert.ok(flags.includes('dilution_risk'));
  });
});

// ---------------------------------------------------------------------------
// generatePlay
// ---------------------------------------------------------------------------
describe('generatePlay', () => {
  it('generates CSP play for coiled spring', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'constructive');
    assert.ok(play.includes('CSP'), 'should mention CSP');
    assert.ok(play.includes('TEST'), 'should include symbol');
  });

  it('shows defensive regime warning', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'defensive');
    assert.ok(play.includes('DEFENSIVE'), 'should warn about defensive regime');
    assert.ok(play.includes('no new entries'), 'should say no entries');
  });

  it('shows cautious regime note', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'cautious');
    assert.ok(play.includes('cautious'), 'should mention cautious regime');
  });

  it('says watchlist for building base', () => {
    const play = generatePlay('TEST', 'building_base', { ma50: 50, distFromResistance: 12, price: 55 }, 'constructive');
    assert.ok(play.includes('Watchlist'), 'should say watchlist');
  });
});
```

- [ ] **Step 2: Run all tests**

Run: `node --test tests/coiled_spring_scanner.test.js`
Expected: All tests pass.

- [ ] **Step 3: Add to package.json test scripts**

Update `package.json` — add `coiled_spring_scanner.test.js` to the `test:unit` and `test:all` scripts:

```json
"test:unit": "node --test tests/pine_analyze.test.js tests/cli.test.js tests/coiled_spring_scanner.test.js",
"test:all": "node --test tests/e2e.test.js tests/pine_analyze.test.js tests/cli.test.js tests/coiled_spring_scanner.test.js",
```

- [ ] **Step 4: Run full unit test suite**

Run: `npm run test:unit`
Expected: All unit tests pass (pine_analyze + cli + coiled_spring_scanner).

- [ ] **Step 5: Commit**

```bash
git add tests/coiled_spring_scanner.test.js package.json
git commit -m "test: complete unit test suite for coiled spring scanner v2"
```

---

## Phase 3: Dashboard and Output QA

### Task 18: Update Dashboard — Coiled Springs Tab

**Files:**
- Modify: `scripts/dashboard/build_dashboard_html.js`

This is a large file (132KB). The changes are targeted: replace the Explosion Potential tab content with a Coiled Springs tab that shows the new fields.

- [ ] **Step 1: Find and replace the Explosion Potential tab references**

Search for `explosion` and `Explosion Potential` in `build_dashboard_html.js`. Replace:
- Tab label: "Explosion Potential" → "Coiled Springs"
- Tab ID: any `explosion` references → `coiled-springs`
- Data source: `explosion_results.json` → `coiled_spring_results.json`

- [ ] **Step 2: Update the card renderer for new fields**

Replace the explosion card rendering function with one that shows:
- Score with 5-category breakdown bars (colored: trend=blue, contraction=orange, volume=purple, pivot=green, catalyst=gray)
- `scoreConfidence` badge: high=solid green border, medium=dashed yellow border, low=dimmed with "limited data" label
- `breakoutRisk` indicator: low=green shield, medium=yellow caution, high=red warning, with `breakoutRiskDrivers` on hover tooltip
- `redFlags` as yellow warning icons with tooltip text
- `classification` badge: coiled_spring=green, building_base=yellow, catalyst_loaded=blue
- `play` recommendation text (adjusted by regime)
- `ivLabel` shown as-is (honest approximation labeling)

- [ ] **Step 3: Add market regime banner at tab top**

Before the card grid, add a regime status banner:
- constructive: green bar "Market Regime: Constructive — normal operation"
- cautious: yellow bar "Market Regime: Cautious — reduced conviction, watch only"
- defensive: red bar "DEFENSIVE REGIME — NO NEW ENTRIES"

Read the regime from `coiled_spring_results.json`'s `marketRegime` field.

- [ ] **Step 4: Test the dashboard visually**

Run: `node scripts/dashboard/build_dashboard_html.js`
Open the output HTML. Verify:
- Coiled Springs tab appears and loads data
- Cards show score, confidence, risk, flags correctly
- Regime banner is visible
- Category breakdown bars are proportional

- [ ] **Step 5: Commit**

```bash
git add scripts/dashboard/build_dashboard_html.js
git commit -m "feat(dashboard): replace Explosion Potential tab with Coiled Springs"
```

---

## Phase 4: Pine Script Companion

### Task 19: Create Pine Script Indicator

**Files:**
- Create: `scripts/pine/coiled_spring_score.pine`

- [ ] **Step 1: Create the Pine Script file**

Write the Pine Script indicator as specified in the design spec Section 3. Include:
- All input parameters (adjustable thresholds)
- Trend Health scoring (30 pts max)
- Contraction Quality scoring (40 pts, using ATR proxy for VCP)
- Volume Signature scoring (20 pts)
- Pivot Structure scoring (15 pts, with extension penalty)
- Composite score display (105 pts max — catalyst unavailable in Pine)
- Classification with adjusted thresholds (72 for coiled spring, 50 for building base)
- Overlay: MA ribbons, resistance line, accumulation day markers
- Watchlist column: `plot(pineScore, "CS Score", display=display.status_line)`
- Label at top-right: score, classification, category breakdown

Note in comments: "Catalyst Awareness (15 pts) is not available in Pine Script — scored only by the Yahoo-based scanner. Pine max score is 105."

- [ ] **Step 2: Load into TradingView for visual check**

Use `pine_set_source` + `pine_smart_compile` to load the indicator onto a chart. Verify it compiles without errors and displays the score label.

- [ ] **Step 3: Commit**

```bash
git add scripts/pine/coiled_spring_score.pine
git commit -m "feat(pine): add Coiled Spring Score v2 indicator"
```

---

## Final Validation

### Task 20: End-to-End Validation

**Files:** None — validation only.

- [ ] **Step 1: Run full unit test suite**

Run: `npm run test:unit`
Expected: All tests pass.

- [ ] **Step 2: Run live scanner**

Run: `node scripts/scanner/coiled_spring_scanner.js --top=10`
Expected: Completes without errors, produces sensible results.

- [ ] **Step 3: Validate no already-exploded stocks in output**

Check that no result has `changePct > 15` or a recent 20%+ move. Check that all results have `marketCap > 1B` and `avgVol > 1M`.

- [ ] **Step 4: Build dashboard and inspect**

Run: `node scripts/dashboard/build_dashboard_html.js`
Open HTML, verify Coiled Springs tab looks correct.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete Coiled Spring Scanner v2 — all phases"
```
