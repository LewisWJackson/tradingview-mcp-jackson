# Mawjah (موجة) — TASI Trading Dashboard: Complete Project Prompt

> **Export date:** 2026-05-15  
> **Scope:** Full project specification excluding TradingView Desktop integration.  
> Data fetching should be replaced with any OHLCV market data provider (Finnhub, Yahoo Finance, Polygon, etc.)

---

## 1. Project Identity

**Name:** Mawjah (موجة — Arabic for "Wave")  
**Type:** Single-page web application + Node.js HTTP server  
**Purpose:** A professional trading dashboard for the Saudi Stock Exchange (TASI — Tadawul All Share Index) that screens stocks using technical analysis, tracks institutional block deals, monitors macro events, and provides AI-powered analysis via Claude (Anthropic).  
**Language support:** Arabic and English (toggle in header)  
**Currency support:** SAR and USD (toggle in header)

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Server | Node.js (ESM modules), native `http` module — no Express |
| Frontend | Vanilla JavaScript SPA (~6000 lines), no framework |
| Styling | CSS custom properties (dark theme), no Tailwind |
| AI | Anthropic Claude API (`@anthropic-ai/sdk`) — Haiku for briefs, Sonnet for analysis |
| Market data | **Needs replacement** — currently uses TradingView Desktop via CDP. Replace with Finnhub, Yahoo Finance, Polygon, or any OHLCV API |
| Fundamental data | Finnhub API (`/api/v1/stock/metric`, `/api/v1/financials`) |
| Block deals | Argaam.com HTML scraper (Arabic financial news site) |
| Notifications | Telegram Bot API |
| Fonts | JetBrains Mono (numbers), Plus Jakarta Sans (text) |

### Environment Variables
```
ANTHROPIC_API_KEY=     # Claude API
FINNHUB_API_KEY=       # Fundamental data + earnings calendar
TELEGRAM_BOT_TOKEN=    # Optional: scan result notifications
TELEGRAM_CHAT_ID=      # Optional
PORT=3000              # Default server port
```

---

## 3. File Structure

```
project/
├── dashboard/
│   ├── server.mjs              # Main HTTP server (~1844 lines)
│   ├── index.html              # SPA frontend (~5928 lines)
│   ├── fundamentals.mjs        # Finnhub fundamental data fetcher
│   ├── sharia.mjs              # Sharia compliance status per stock
│   ├── backtest.mjs            # Strategy backtester
│   ├── scan-cache.json         # Latest scan results (auto-generated)
│   ├── prev-scan-cache.json    # Previous scan for delta comparison
│   ├── score_history.json      # Per-stock score over last 15 scans
│   ├── block_deals.json        # Manually entered block deals
│   ├── block_deal_log.json     # Historical block deal frequency log
│   ├── last_block_deals.json   # Last successful Argaam fetch (stale fallback)
│   ├── auto_scan_log.json      # Auto-scan scheduler state
│   ├── macro_brief_cache.json  # Claude daily macro brief (24h cache)
│   ├── alert_rules.json        # User-defined score alert rules
│   ├── positions.json          # Real portfolio positions
│   ├── virtual_portfolio.json  # Paper trading portfolio
│   ├── universe.json           # Custom stock universe overrides
│   └── settings.json           # User settings (Telegram, Finnhub keys, etc.)
└── scripts/
    └── tasi_screener.mjs       # Technical screener + indicator library
```

---

## 4. Stock Universe

**Total TASI stocks:** ~186 entries covering all sectors:

- **Banking (11):** Al Rajhi, SNB, Riyad Bank, SABB, ANB, Banque Saudi Fransi, Saudi Investment Bank, Saudi Awwal Bank, Al Bilad Bank, Alinma Bank, Bank AlJazira
- **Energy:** Saudi Aramco, GASCO, Marafiq, Arabian Drilling, ADES
- **Petrochemicals:** SABIC, Tasnee, Sahara Petrochemical, Saudi Kayan, Petro Rabigh, Advanced Petrochemical, Luberef, and others
- **Mining:** Ma'aden, SIIG, and others
- **Telecom & Tech:** STC, Mobily, Zain KSA, GO Telecom, Elm, Solutions by STC, 2P, AZM
- **Utilities:** Saudi Electricity (SEC), ACWA Power
- **Food & Beverage (15+):** Almarai, Savola, Tanmiah, NADEC, SADAFCO, Americana Restaurants, Jahez, Alamar Foods, and others
- **Retail (10+):** Jarir Marketing, eXtra, Aldrees, Fawaz Alhokair, Abdullah Al Othaim Markets, SASCO, Cenomi Retail, and others
- **Healthcare & Pharma (12+):** Dr. Sulaiman Al-Habib, Dallah, Al Hammadi, Mouwasat, Dr. Fakeeh, SPIMACO, Nahdi Medical, Bindawood, Jamjoom Pharma, Avalon Pharma, and others
- **Real Estate (10+):** Dar Al Arkan, Jabal Omar, Emaar Economic City, Cenomi Centers, Alandalus, Retal, and others
- **REITs (14):** Riyad REIT, AlJazira REIT, Jadwa REIT Al Haramain, Al Rajhi REIT, SEDCO Capital REIT, Alinma Retail REIT, and others
- **Cement (10):** Saudi Cement, Yanbu Cement, Arabian Cement, Southern Province Cement, Qassim Cement, Yamama Cement, Eastern Province Cement, Tabuk Cement, Najran Cement, City Cement, Jouf Cement, Riyadh Cement
- **Industrial (10+):** Saudi Cable, Al Babtain Power, Riyadh Cables, Bawan, Shaker Group, Astra Industrial, and others
- **Insurance (20+):** Tawuniya, BUPA Arabia, Al Rajhi Takaful, MedGulf, Walaa, Arabian Shield, SAICO, Gulf Union, Saudi Re, Chubb Arabia, and others
- **Transport:** Bahri (National Shipping), SAL Aviation, flynas, Theeb, Lumi Rental, SAPTCO
- **Media:** MBC Group, SRMG
- **Financial Services:** Saudi Exchange (Tadawul Group), Kingdom Holding, Nayifat Finance, Derayah Financial

Each stock entry: `{ sym: "TADAWUL:XXXX", name: "Company Name" }`

---

## 5. Technical Screener

### Data Requirements Per Stock
- **250 daily OHLCV bars** (for EMA 200 reliability)
- **250 weekly OHLCV bars** (Position mode only)
- TASI index bars (for Relative Strength calculation)

### Indicator Library (all computed from raw OHLCV, no external indicator API needed)

```javascript
emaArray(closes, period)           // Exponential Moving Average
calcRsi(closes, period=14)         // RSI 0–100
rsiSeries(closes, period=14)       // Full RSI array (for divergence)
macdHist(closes)                   // MACD histogram (12/26/9)
volumeCheck(volumes)               // Checks if vol > 1.2× 20-day avg
atrCalc(highs, lows, closes, 14)   // Average True Range
findSRLevels(highs, lows, closes)  // Support/Resistance pivot detection
detectDivergence(closes, rsiVals)  // Bullish/bearish RSI divergence
computeSeasonality(closes, times)  // Average return by calendar month
calcMFI(highs, lows, closes, volumes, 14)  // Money Flow Index
calcOBVTrend(closes, volumes, 20)  // OBV slope (rising/falling/flat)
calcVolumeZScore(volumes, 20)      // Volume standard deviations above mean
```

### Three Scoring Modes

#### Swing Mode (3–10 day trades)
Criteria applied to **daily** bars only. Max score = 8 points (some criteria worth 2 pts):

| Criterion | Points | Pass condition |
|---|---|---|
| EMA stack aligned | 2 | EMA13 > EMA34 > EMA89 |
| Above EMA 200 | 2 | Price > EMA200 |
| RSI momentum | 2 | RSI 52–78 |
| MACD positive | 1 | MACD histogram > 0 |
| Volume confirmed | 1 | Volume > 1.2× 20-day avg |

Bearish mirror: inverted EMA stack, below EMA200, RSI 22–48, MACD < 0, volume elevated.

**Bias labels:**
- 7–8 pts bullish → `STRONG BUY`
- 5–6 pts bullish → `BUY`
- 3–4 pts bullish → `WATCH`
- 3–4 pts bearish → `AVOID`
- 5–6 pts bearish → `SELL`
- 7–8 pts bearish → `STRONG SELL`
- Tied or < 3 → `SKIP`

#### Position Mode (weeks to months)
Same 8 daily criteria + **weekly confirmation layer** (up to 4 bonus points):
- Weekly EMA13 > EMA34 > EMA89: +2 pts
- Weekly price > weekly EMA200: +2 pts

#### Breakout Mode (early movers before full setup)
Different 8-point criteria emphasising volume and relative strength over EMA alignment:

| Criterion | Points | Pass condition |
|---|---|---|
| Above EMA 200 | 2 | Price > EMA200 (trend filter) |
| Breakout volume | 2 | Volume ≥ 2.0× 20-day avg |
| RS vs TASI index | 2 | Stock outperforming index by >1% over 20 days |
| RSI momentum zone | 1 | RSI 50–75 (not overbought) |
| MACD positive | 1 | MACD histogram > 0 |

Same bias labels, different scoring logic.

### Proximity Detection
Each scan also computes how far each failing criterion is from its threshold:
```javascript
proximity = {
  emaStack: (ema13 - ema34) / ema34 * 100,  // % gap
  ema200:   (price - ema200) / ema200 * 100, // % above/below
  rsi:      rsiVal - 52,                      // signed distance from zone
  macd:     macdData.hist,                    // signed value
  pts_to_buy:  Math.max(0, 5 - bullish),
  pts_to_sell: Math.max(0, 5 - bearish),
}
```
Used for pre-signal detection (stocks approaching a buy/sell flip).

### Score History
After each scan, scores are persisted to `score_history.json`:
```json
{
  "TADAWUL:1120": [
    { "d": "2026-05-14", "s": 6, "m": 8, "b": "BUY", "p": 98.5, "md": "swing" }
  ]
}
```
`md` field tags which mode was used — enables warning when comparing scores across different modes.

### Score Delta (What Changed)
After each scan, the server computes a delta vs the previous scan:
- Criteria that gained or lost points
- Direction (improved / degraded)
- Rapid reversal flag: if bias flipped more than 2 steps in one scan
- Score trajectory (rising / falling / stable based on last 3 scans)
- Justification text for each changed criterion showing before/after values

---

## 6. Whale Watch & Institutional Activity

### Whale Score (0–10 per stock, computed each scan)

| Component | Source | Max pts |
|---|---|---|
| MFI > 65 (bullish) / < 35 (bearish) | Money Flow Index 14-day | 3 |
| OBV trend rising (bullish) / falling (bearish) | On-Balance Volume 20-day slope | 2 |
| Volume Z-score > 2σ | Standard deviations above 20-day baseline | 3 |
| Volume ratio ≥ 3× or ≥ 5× | Raw volume vs 20-day average | 2 |

Score is direction-aware: for bearish stocks, accumulation signals score for bears.

**Important caveat:** This is inferred from price/volume mechanics only. It does not represent actual institutional flow data.

### Block Deals (Argaam Scraper)
Argaam.com publishes daily summaries of privately negotiated block deals (صفقات خاصة) on TASI.

**Two article formats on the tag page:**
1. **TASI daily summary** (title: `"تاسي: N صفقة خاصة بقيمة X"`) — full-day table of all block deals
2. **Multi-company articles** (title: `"نمو: N صفقات على X وY"`) — broker-specific deal reports

**Parsing:** Both formats use the same HTML table structure: Company Name → Stock Price → Deal Price → Quantity → Value (millions SAR). The parser resolves Arabic company names to TADAWUL codes via a 50+ entry name→code lookup map.

**Fallback:** When today's Argaam fetch returns empty (e.g. weekend, market holiday), the last successful fetch is served with a `stale: true` flag and the original date shown.

**Frequency tracking:** Each stock's block deal appearances are logged to `block_deal_log.json`. The UI shows "3× this week" or "5× in 30d" badges when a stock appears repeatedly.

**Direction (buy/sell):** Block deals do NOT have a disclosed direction. The buyer/seller identity is never published. Do not show BUY/SELL labels on block deal entries — show raw deal data only (price, quantity, value, date).

---

## 7. Macro Calendar

### Hardcoded 2026 Events
Scheduled economic events with TASI impact classification:

| Type | Examples | Impact |
|---|---|---|
| `fed` | FOMC rate decisions (8/year), Jackson Hole | High |
| `sama` | SAMA rate decisions (follows Fed, ~4/year) | High |
| `opec` | OPEC+ meetings (~2/year) | High |
| `cpi` | US CPI monthly | Medium |
| `nfp` | US Non-Farm Payrolls monthly | Medium |
| `holiday` | Saudi public holidays (TASI closed) | Low/Closed |
| `earnings` | TASI quarterly earnings seasons | Medium |
| `macro` | Saudi GDP quarterly releases | Medium |

Saudi public holidays 2026: Founding Day (Feb 22), Eid Al-Fitr (Mar 28–Apr 1 approx), Eid Al-Adha (Jun 4–7 approx), National Day (Sep 23).

### Claude Daily Brief
Once per day, Claude Haiku generates a single sentence (≤40 words) summarizing:
1. The most impactful upcoming event in the next 14 days
2. Whether the macro backdrop is risk-on or risk-off for TASI
3. One specific thing traders should watch

Cached in `macro_brief_cache.json` for 24 hours (KSA time).

---

## 8. AI Analysis (Claude)

### Per-Stock Analysis (Claude Sonnet)
Triggered on demand per stock. Generates 3 short paragraphs:
1. **WHY** the signal is forming — specific indicator combination
2. **KEY RISKS** — what levels/conditions would invalidate the setup
3. **TIMING** — whether to enter now or wait, and what confirmation to look for

Input data: name, symbol, bias, score, mode, price, EMA values, RSI, MACD histogram, volume ratio, ATR, RS score, weekly data (if Position mode), Sharia status.

### 360° Analysis Card
Combines three pillars:
- **Technical** (from screener score 0–8)
- **Fundamental** (from Finnhub: P/E ratio, ROE, debt/equity, revenue growth — scored 0–100)
- **Institutional** (whale_score 0–10, block deal frequency)

Claude synthesizes all three into a single verdict paragraph.

### Pre-Signal Detection
Endpoint `/api/scan/presignal` scans the proximity object for stocks within 1–2 points of a BUY/SELL flip, filters by:
- Score trajectory trending toward the threshold
- Not already past the threshold
Returns "approaching BUY", "approaching SELL", "potential recovery" categories.

---

## 9. Dashboard UI — Six Main Tabs

### Tab 1: Screener
- **Mode selector** (top): Swing / Position / Breakout — each with a one-line description
- **Summary cards:** Strong Buy / Buy / Watch / Strong Sell counts + total scanned
- **Stock table:** Symbol | Name | Bias badge | Score bar | RSI | MACD | Volume | RS | Whale | Weekly (if Position mode)
- **Sector filter** dropdown
- **Signal guide** legend (collapsible)
- **Score history sparkline** in each row — dots colored by score, mode-mismatch warning if history mixed modes
- **Quick scan** button — re-scans only BUY/WATCH/SELL stocks (~5–8s)
- **Auto-scan pill** in header — shows next scheduled scan time on trading days

### Tab 2: Morning Brief
- AI-generated brief (from `runBrief()`) — summary of overnight global moves, sector outlook, top TASI opportunities

### Tab 3: Markets (Global Overview + Macro)
- **Market cards** — global indices, oil, gold via TradingView *(replace with Finnhub or similar)*
- **Macro Watch** — horizontal scrollable event calendar (21 days), color-coded by impact and type
- **Claude macro brief** — daily AI sentence above the calendar
- **Whale Watch** — whale activity sorted by score, block deals list with frequency badges
- **Top Opportunities** — Strong Buy signals from last scan

### Tab 4: Portfolio
- **Real positions:** symbol, entry price, current price, P&L
- **Virtual portfolio:** paper trading with cash tracking, buy/sell, trade log
- **Watchlist:** manually tracked stocks

### Tab 5: Alerts
- **Smart alert rules:** trigger on score ≥ N, bias = X, RS crossover, whale spike
- Rules fire during each scan and send Telegram notifications

### Tab 6: Settings
- Scoring rules editor
- Stock universe manager (per market: TASI, US Equity, ETFs, Crypto, Commodities)
- API keys (Finnhub, Telegram)
- Notification preferences

---

## 10. Stock Drawer (Click Any Stock)

Four tabs inside the drawer:

### Overview Tab
- Bias badge + score bar + score explanation
- EMA levels, RSI, MACD histogram, Volume ratio
- **Score history sparkline** (last 5 scans, mode-tagged dots, mixed-mode warning)
- **What Changed Since Last Scan** — delta with justification text per criterion
- **Rapid reversal warning** (yellow box if bias flipped >2 steps in one scan)
- **Pre-signal proximity bars** for each criterion approaching a flip
- **360° Analysis card** — Technical + Fundamental + Institutional pillars

### Setup Tab
- Support/Resistance levels (automatically detected pivots)
- Divergence detection (RSI vs price)
- Seasonality chart (average monthly return)
- Weekly confirmation (Position mode only)

### Execute Tab
- ATR-based trade levels: Stop (1.5×ATR), Target 1 (1.5×ATR), Target 2 (3×ATR)
- Structure stop (EMA 89 level)
- Volume confirmation (direction-aware: buying for bullish, selling for bearish)
- Sharia compliance badge (Compliant / Non-Compliant / Under Review)
- Claude AI analysis button → generates the 3-paragraph analysis
- Add to virtual portfolio shortcut

### Research Tab
- Fundamental data from Finnhub: P/E, P/B, EV/EBITDA, ROE, debt/equity, revenue growth
- Fundamental score 0–100
- Earnings calendar (next scheduled report date)

---

## 11. Auto-Scan Scheduler

Fires automatically 3 times per trading day (Sun–Thu, KSA time):
- **10:30 KSA** — morning slot
- **13:00 KSA** — midday slot
- **15:30 KSA** — afternoon slot

Implementation: `setInterval(checkAutoScan, 60 * 1000)` checks every minute. Fires within a 5-minute window of each slot. State persisted in `auto_scan_log.json` (format: `{ "2026-05-15": ["morning", "midday"] }`).

On fire: broadcasts SSE event `auto_scan_starting`, updates header pill, triggers full scan.

---

## 12. Real-Time Events (Server-Sent Events)

The server maintains an SSE stream at `/api/events`. Events:

| Type | When |
|---|---|
| `scan_complete` | Scan finishes — includes count, lastRun, quickScan flag |
| `score_change` | A stock's bias changed during scan |
| `alert_rule_triggered` | A user alert rule fired |
| `auto_scan_starting` | Auto-scheduler is firing a slot |
| `live_started` / `live_stopped` | Live mode toggled |

Frontend connects via `new EventSource('/api/events')` and updates the table in real-time.

---

## 13. Server API Endpoints

```
GET  /api/status                    Scan + brief running status, current mode
GET  /api/scan/results              Latest scan results array
POST /api/scan/start                { market, mode } — starts full scan
POST /api/scan/quick                Re-scan actionable stocks only
GET  /api/scan/delta                Score changes vs previous scan
GET  /api/scan/presignal            Stocks approaching a signal flip
GET  /api/brief/results             Morning brief data
POST /api/brief/start               Generate new morning brief
GET  /api/markets/overview          Global market data (needs market data API)
GET  /api/whale/activity            Stocks sorted by whale score
GET  /api/whale/block-deals         Block deals (Argaam + manual) with frequency
POST /api/whale/block-deals/add     Add manual block deal
POST /api/whale/block-deals/delete  Delete manual block deal by sym+time
GET  /api/macro/events?days=21      Upcoming macro events
GET  /api/macro/brief?refresh=1     Claude daily macro sentence
GET  /api/score-history             Full score history object
GET  /api/fundamentals?sym=X        Finnhub fundamental data for stock
GET  /api/positions                 Real portfolio
POST /api/positions/add             Add position
POST /api/positions/delete          Delete position
GET  /api/virtual                   Virtual portfolio
POST /api/virtual/buy               Paper buy
POST /api/virtual/sell              Paper sell
POST /api/virtual/reset             Reset with new balance
GET  /api/settings                  User settings
POST /api/settings                  Save settings
GET  /api/universe                  Stock universe per market
POST /api/universe                  Save custom universe
GET  /api/sharia?sym=X              Sharia status for stock
POST /api/analyse                   Generate Claude AI analysis for stock
GET  /api/alert-rules               Smart alert rules
POST /api/alert-rules               Save alert rules
GET  /api/auto-scan/status          Next auto-scan slot, today's log
GET  /api/events                    SSE stream
POST /api/live/start                Start live mode (interval in minutes)
POST /api/live/stop                 Stop live mode
GET  /api/live/status               Live mode state
```

---

## 14. Design System

**Theme:** Dark OLED glass (`#0a0a0f` background), JetBrains Mono for numbers, Plus Jakarta Sans for text.

**CSS variables:**
```css
--bg:      #0a0a0f;   --bg2:  #12121a;   --bg3:  #1a1a26;
--card:    #13131e;   --border: rgba(255,255,255,.07);
--text:    #e8e8f0;   --text2: #a0a0b8;  --text3: #5a5a78;
--green:   #00e676;   --red:   #ff5252;  --orange:#ff9100;
--yellow:  #ffd740;   --blue:  #3d8eff;
--radius:  8px;
```

**Bias badge colors:** Strong Buy = green, Buy = teal, Watch = yellow, Avoid = orange, Sell = red-orange, Strong Sell = red, Skip = gray.

**Score bar:** Gradient fill from red (low) to green (high) proportional to score/maxScore.

**Mode context pill** shows in the screener toolbar: "Swing Trading" / "Position Investing" / "Breakout Hunting".

---

## 15. Multi-Market Support

Beyond TASI, the screener supports:
- **US Equity** (~24 stocks: AAPL, MSFT, NVDA, AMZN, etc.)
- **ETFs** (SPY, QQQ, GLD, TLT, etc.)
- **Crypto** (BTC, ETH, SOL, XRP, BNB — using BINANCE feed)
- **Commodities** (Gold, Silver, Crude Oil, Natural Gas, Copper)

Each market has its own index for RS calculation (S&P 500 for US, TASI for Saudi, BTC for crypto).

---

## 16. Key Design Decisions & Constraints

1. **No external framework** — the SPA is deliberately framework-free (vanilla JS + CSS variables) for portability and zero build step.
2. **No authentication** — the dashboard is localhost-only by design. Adding auth (server-side session + password cookie) is required before any public/cloud deployment.
3. **Score max = 8** — all three modes use the same 8-point scale for UI consistency, even though criteria differ. The mode is stamped on each history entry so cross-mode comparisons can be flagged.
4. **Block deals are neutral** — direction (buy/sell) is never shown on block deals because Argaam does not publish it. Showing the technical bias badge next to a block deal is misleading and should be avoided.
5. **Whale score is inferential** — it reflects volume/money-flow patterns, not actual institutional flow data.
6. **TASI trading days:** Sunday–Thursday (Friday–Saturday = weekend/closed).
7. **KSA timezone:** UTC+3. All scheduled features (auto-scan, macro calendar) use KSA time.
8. **Arabic name resolution:** Argaam block deal articles publish company names in Arabic. A 50+ entry lookup map (`ARABIC_NAME_MAP`) resolves Arabic names to TADAWUL codes. Unrecognized names are dropped (not accumulated under the previous company).

---

## 17. Replacing the TradingView Data Layer

The screener (`tasi_screener.mjs`) currently fetches OHLCV data by controlling a live TradingView Desktop session via Chrome DevTools Protocol. To make the project standalone, replace this with any OHLCV data provider:

**What each stock scan needs:**
- 250 daily bars: open, high, low, close, volume, timestamp
- 250 weekly bars (Position mode only)
- ~25 bars of index data (TASI index) for RS calculation

**Suggested replacement:**
```javascript
// Replace the CDP-based data.getOhlcv() calls with:
async function getOhlcv(symbol, timeframe = 'D', count = 250) {
  // Finnhub: GET /api/v1/stock/candle?symbol=X&resolution=D&from=X&to=X&token=X
  // Yahoo Finance: GET /v8/finance/chart/SYMBOL?range=1y&interval=1d
  // Polygon: GET /v2/aggs/ticker/X/range/1/day/from/to?apiKey=X
  return { bars: [{ open, high, low, close, volume, time }] };
}
```

The rest of the indicator math (EMA, RSI, MACD, ATR, etc.) runs entirely in JavaScript from the raw bars and requires no changes.

---

## 18. Saudi Market Local Context

This section captures TASI-specific characteristics that any developer or analyst working on this project must understand.

### Market Structure
- **Trading days:** Sunday to Thursday. Friday and Saturday are the weekend — all scheduled features skip these days.
- **Market hours:** 10:00 AM – 3:30 PM KSA (UTC+3). Pre-open auction: 9:30–10:00 AM. The auto-scan slots (10:30, 13:00, 15:30) are all within active trading hours.
- **Settlement:** T+2 (trades settle two business days after execution).
- **Daily price limits:** ±10% from the previous close for most stocks. Some newly listed stocks have wider limits (±30%) in early trading days.
- **Currency:** Saudi Riyal (SAR) is pegged 1:1 to USD at 3.75 SAR/USD since 1986. There is no exchange rate risk for USD investors, but Fed rate decisions directly affect Saudi monetary policy since SAMA mirrors Fed moves to maintain the peg.
- **Foreign ownership:** Foreign institutional investors can own up to 49% of listed companies. Retail foreign investors require Qualified Foreign Investor (QFI) status. This is why block deals sometimes represent foreign institutional repositioning.

### SAMA and the Fed Relationship
SAMA (Saudi Central Bank) has historically mirrored every Federal Reserve rate decision within 24 hours to defend the SAR peg. This means:
- US Fed rate hikes → SAMA hikes → higher Saudi lending rates → pressure on leveraged TASI positions and real estate stocks
- US Fed rate cuts → SAMA cuts → lower borrowing costs → typically bullish for banking stocks and real estate
- The macro calendar includes SAMA decisions the day after each FOMC meeting

### Oil Dependency and TASI Correlation
Saudi Aramco alone represents ~16–20% of TASI market cap. The energy and petrochemical sectors together represent ~25–30%. As a result:
- Brent crude above $80–90 is broadly bullish for TASI, particularly for Aramco, SABIC, Petro Rabigh, Saudi Kayan
- OPEC+ production cut announcements typically cause immediate positive gaps in energy stocks
- Oil below $60 creates fiscal pressure and can trigger broad TASI selloffs
- Non-oil sectors (banking, healthcare, telecom, retail) have been growing as part of Vision 2030 and are increasingly decoupled from oil

### Vision 2030 Context
Saudi Vision 2030 is a government economic diversification plan that materially affects listed companies:
- **Direct beneficiaries:** ACWA Power, Elm, Saudi Exchange (Tadawul Group), Cenomi Centers, flynas, SAL Aviation, SRMG (media), construction and cement companies
- **Tourism & Hospitality:** Red Sea Global, NEOM (not yet listed), Dur Hospitality — this sector is growing rapidly
- **Financial sector reform:** Fintech licenses expanding, mortgage products growing — benefits Alinma, Al Bilad, Nayifat
- **Entertainment:** Leejam Sports, MBC Group — newly emerging sector
- When analyzing stocks in these sectors, score alone is insufficient — regulatory tailwinds matter

### Ramadan Effect
TASI typically exhibits reduced liquidity and lower volatility during Ramadan (a 30-day period shifting ~11 days earlier each year):
- Trading volumes can drop 30–50% during Ramadan
- The afternoon session is often the more active period (post-iftar trading on short days)
- Volume-based indicators (whale score, volume Z-score) will produce lower readings during Ramadan — this is seasonal, not a genuine signal reduction
- Ramadan 2026 is approximately February 18 – March 19

### Sharia Compliance
Many Saudi investors — both retail and institutional — are restricted to Sharia-compliant stocks. Non-compliant stocks are excluded from Islamic funds and Zakat-calculating portfolios:
- **Compliant:** Companies with low debt ratios and no haram revenue (alcohol, gambling, conventional interest)
- **Non-Compliant:** Companies with excessive debt or interest income (many banks fall here under strict interpretations)
- **Under Review:** Status changes periodically as company financials change
- The dashboard shows Sharia status in the Execute tab but does not yet filter the screener by compliance

### Earnings Season Timing
TASI companies report quarterly results according to CMA (Capital Market Authority) deadlines:
- **Q1 results:** Published by end of April / early May
- **Q2 results:** Published by end of July / early August
- **Q3 results:** Published by end of October / early November
- **Q4 results (annual):** Published by end of March (with audited annual report)
- Expect elevated volatility and volume around earnings releases — the macro calendar marks approximate earnings seasons

### Block Deals (صفقات خاصة) — Regulatory Context
Block deals on TASI are privately negotiated transactions reported to the exchange within 30 minutes of execution. They are:
- **Exempt from the order book** — they don't move the price directly, but can signal institutional conviction
- **Not disclosed directionally** — buyer and seller identities and which side initiated are never published
- **Typical triggers:** Government entity rebalancing, index reweighting, PE/VC exits, foreign investor onboarding at scale
- **Size threshold:** There is a minimum size for block deal reporting (varies by stock liquidity tier)
- The Argaam source (argaam.com) is the most reliable Arabic-language financial news aggregator for TASI block deal data

### Key Local Data Sources
| Source | What it provides | Access |
|---|---|---|
| **Argaam** (argaam.com) | Block deals (Arabic), earnings summaries, sector news | HTML scraping |
| **Tadawul official** (saudiexchange.sa) | Official price data, company filings, IPO info | Web/API |
| **CMA** (cma.org.sa) | Regulatory filings, insider trading disclosures | Web |
| **SAMA** (sama.gov.sa) | Monetary policy, banking sector statistics | Web/PDF |
| **Mubasher** (mubasher.info) | Alternative Arabic financial data source | HTML |
| **Argaam Plus** | Premium fundamental data for Saudi stocks | Subscription |

---

## 19. Pending / Not Yet Built

- **Position sizing calculator** — ATR-based position size given account size and risk %
- **Sharia-aware filtering** — currently shows status but doesn't filter screener results
- **Complete drawer tab restructure** — planned reorganization of Overview/Setup/Execute/Research tabs
- **Authentication** — required before any public deployment (see Section 16, point 2)
- **Real block deal direction** — currently unknown; possible inference from deal price vs last market price (premium = buyer, discount = seller) requires live price at deal time
