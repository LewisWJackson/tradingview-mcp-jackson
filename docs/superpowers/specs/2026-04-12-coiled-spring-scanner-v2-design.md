# Coiled Spring Scanner v2 — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Replaces:** Explosion Potential Scanner v1 (scoring.js, yahoo_screen.js, explosion_scanner.js)

## Problem Statement

The v1 "Explosion Potential" scanner identifies stocks **after** they've already made their move. It rewards volume spikes (30pts for 5x volume ratio), large gaps, and proximity to 52-week highs — all lagging indicators of an explosion that already happened. Results included acquired/delisted companies (HOLX) and stocks that had already gapped 48% (ZNTL).

**The goal is the opposite:** find stocks **before** they rally. Identify the coiled spring, not the launched rocket.

## Design Principle

Favor objective, measurable inputs over subjective pattern descriptions. The scoring system should consistently identify stocks demonstrating tightening volatility, rising relative strength, and signs of institutional positioning prior to expansion.

## Architecture Overview

Same three-stage pipeline as v1, but with fundamentally different scoring logic:

```
Universe (1,273 symbols)
  → Stage 1: Yahoo bulk quote + quality gate (pass/fail)
  → Stage 1b: Yahoo 30-day OHLCV for candidates (~30-50 stocks)
  → Stage 2: Scoring engine (120 pts total)
  → Output: coiled_spring_results.json + dashboard tab
```

**New Stage 1b:** After the quality gate narrows to ~30-50 candidates, fetch 30 days of daily OHLCV from Yahoo's `/v8/finance/chart/` endpoint. This provides the historical bars needed for BB width, ATR contraction, volume signature, and pivot proximity calculations — all self-contained in Yahoo, no TradingView dependency.

---

## Quality Gate (pass/fail)

Every stock must pass ALL of these before scoring. No points awarded — just in or out.

| Filter | Threshold | Rationale |
|---|---|---|
| Market cap | > $1B | Exclude micro/small-cap noise |
| Avg daily volume (3-month) | > 1M shares | Must be liquid enough for options trading with tight spreads |
| Price | > $10 | Wheel-friendly, decent option premium |
| Still tradeable | `marketState` not "CLOSED_PERMANENTLY", not halted | Kills acquired/delisted stocks like HOLX |
| Not already exploded | abs(changePct) < 15% today AND 5-day price change < 20% (from OHLCV in Stage 1b) | Kills ZNTL-type results — the move already happened |
| Not in downtrend | Price > 200-day MA | Only Stage 2 uptrends |
| Sufficient float/liquidity | No recent dilution events flagged in news | Avoid structurally weak candidates |

**Stage 1 pre-filter (replaces v1):** Instead of filtering for high volume ratio and big day changes (which selects for already-exploded stocks), the new Stage 1 filter selects for:
- Price > 50-day MA (uptrend)
- Price within 25% of 52-week high (not broken down)
- Volume ratio < 2.5x (NOT surging today — we want quiet stocks)
- Market cap and liquidity pass quality gate

This inverts the v1 funnel: v1 selected for noise, v2 selects for quiet strength.

---

## Scoring Categories (120 pts total)

### 1. Trend Health (0-30 pts)

Strong trends produce higher probability breakouts. This is a primary filter, not secondary.

| Signal | Points | Measurement |
|---|---|---|
| 50-day MA > 150-day MA > 200-day MA (stacked alignment) | 8 | Yahoo quote: `fiftyDayAverage`, calculated 150-day, `twoHundredDayAverage` |
| Price above 50-day MA | 5 | `regularMarketPrice > fiftyDayAverage` |
| Within 25% of 52-week high | 5 | `(price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh > -0.25` |
| Relative strength vs SPY trending upward | 7 | Compare stock's 20-day performance vs SPY's 20-day performance. Top 30% of universe = full points, top 50% = 4 pts |
| Higher highs and higher lows over 20 days | 5 | From 30-day OHLCV: current 10-day high > prior 10-day high AND current 10-day low > prior 10-day low |

### 2. Contraction Score (0-40 pts)

The core of the scanner. Identifies true volatility compression rather than random sideways price action.

| Signal | Points | Measurement |
|---|---|---|
| Bollinger Band Width in bottom 20% of 6-month range | 12 | Calculate 20-period BB width from 30-day OHLCV. Compare to historical range (approximate 6-month from available data). Bottom 20% = 12 pts, bottom 30% = 7 pts |
| ATR declining over 10-20 bars | 10 | Compare current 5-day ATR to 20-day ATR. If ratio < 0.5 = 10 pts, < 0.7 = 6 pts |
| Range compression across multiple pullbacks (VCP tightening) | 10 | Identify successive pullback depths from 30-day OHLCV. 3+ contractions where each is shallower than previous = 10 pts, 2 contractions = 6 pts |
| Tight daily range: 5-day avg range < 3% of price | 8 | `avg((high - low) / price)` over last 5 days. < 3% = 8 pts, < 5% = 4 pts |

**VCP tightening detection algorithm:**
1. Find local peaks and troughs in 30-day price data
2. Calculate depth of each pullback: `(peak - trough) / peak * 100`
3. If each successive pullback is shallower (e.g., 12% → 7% → 3%), that's VCP tightening
4. 3+ tightening contractions = full points

### 3. Volume Signature (0-20 pts) — NEW

Explosive moves almost always show signs of institutional accumulation before the breakout. This category distinguishes passive consolidation from active accumulation.

| Signal | Points | Measurement |
|---|---|---|
| Volume dry-up into consolidation: 10-day avg vol < 70% of 50-day avg vol | 6 | `averageDailyVolume10Day / averageDailyVolume3Month`. Ratio < 0.7 = 6 pts, < 0.85 = 3 pts |
| At least 2 accumulation days in last 20 sessions | 5 | From OHLCV: count days where `close > open` AND `volume > 50-day avg volume`. 3+ = 5 pts, 2 = 3 pts |
| Up-volume exceeding down-volume | 5 | Sum volume on up days vs down days over 20 sessions. Ratio > 1.5 = 5 pts, > 1.2 = 3 pts |
| Increasing volume on higher lows | 4 | Detect if volume increases on each successive higher low in the base. Pattern present = 4 pts |

**Why this matters:** A stock can be quiet (low ATR, tight range) for two very different reasons: (a) nobody cares — dead money, or (b) institutions are quietly accumulating while retail sells. The volume signature separates these cases. Dead money shows flat/declining volume with no accumulation days. Active accumulation shows volume dry-up on pullbacks but volume pops on up-moves.

### 4. Pivot Proximity (0-15 pts)

Measures how close the stock is to its breakout point. Reduced from 20 to 15 — proximity matters but contraction and accumulation are more predictive.

| Signal | Points | Measurement |
|---|---|---|
| Price within 3-8% of resistance (20-day high) | 6 | `(20d_high - price) / 20d_high * 100`. Within 3% = 6 pts, within 5% = 4 pts, within 8% = 2 pts |
| Resistance tested at least twice | 4 | Count touches of 20-day high zone (within 1%). 2+ touches = 4 pts |
| Tight closes near highs of range | 3 | `avg(close - low) / (high - low)` over last 5 days. If > 0.7 (closing near daily highs) = 3 pts |
| Higher lows structure | 2 | Last 3 swing lows are ascending. Present = 2 pts |

**Penalty:** If price is extended > 10% above 50-day MA, subtract 5 pts from this section (floor 0). Extended stocks are more likely to pull back than break out further.

### 5. Catalyst Awareness (0-15 pts)

Catalysts act as accelerants, not primary justification. A coiled spring doesn't need a catalyst, but one makes the setup higher probability.

| Signal | Points | Measurement |
|---|---|---|
| Earnings within 30-45 days | 5 | Yahoo `earningsTimestamp`. 30-45 days out = 5 pts. < 30 days = 2 pts (too late to position optimally). > 45 days = 0 pts |
| Analyst upgrades or guidance revisions | 3 | Yahoo RSS news keyword scan: "upgrade", "buy rating", "price target raised", "guidance" |
| Sector momentum tailwind | 4 | Stock's sector ETF in top 3 performing sectors over 20 days = 4 pts, top 5 = 2 pts |
| Elevated short interest (squeeze fuel) | 3 | Yahoo quote `shortPercentOfFloat` if available. > 15% = 3 pts, > 10% = 2 pts |

---

## Classification Thresholds

Total possible: 120 pts.

### Coiled Spring (primary target)
- Score >= 85
- AND contraction >= 30
- AND volume signature >= 10
- AND pivot distance <= 8% from resistance

This is the highest-conviction setup: tight volatility, institutional accumulation confirmed, near the breakout point.

### Building Base
- Score 60-84
- Trend >= 15
- Breakout not imminent (pivot proximity < 8 or contraction < 25)

Good setup forming but needs more time. Watchlist candidate — check back in 1-2 weeks.

### Catalyst Loaded
- Catalyst >= 12
- Trend >= 20
- Early positioning opportunity ahead of a known event

The coil may not be as tight, but a credible catalyst is approaching and the trend is healthy. Position early for the IV ramp.

---

## Play Generation (revised)

Each classification maps to a recommended action aligned with the wheel strategy:

- **Coiled Spring:** "Sell CSP at support (rising 50-day MA). If assigned, hold for breakout and sell CC at resistance. Tight stop below consolidation low."
- **Building Base:** "Add to watchlist. Set alert at [20-day high] for breakout trigger. Do not enter yet."
- **Catalyst Loaded:** "Sell CSP 30-45 DTE into rising IV. Premium is the primary play — if assigned, you own a trending stock at a discount."

---

## Data Sources

All data comes from Yahoo Finance API — no TradingView dependency for scanning.

| Data | Endpoint | When fetched |
|---|---|---|
| Quote snapshot (price, MAs, volume, market cap, earnings date) | `/v7/finance/quote` | Stage 1 — full universe in batches of 50 |
| 30-day daily OHLCV (for BB, ATR, VCP, pivot, volume signature) | `/v8/finance/chart/{symbol}?range=1mo&interval=1d` | Stage 1b — only ~30-50 candidates that pass quality gate |
| Options chain (IV rank) | `/v7/finance/options/{symbol}` | Stage 1b — same candidates |
| News (catalyst keywords) | Yahoo RSS feed | Stage 1b — same candidates |
| Sector ETF performance (for sector momentum) | `/v7/finance/quote` for XLK, XLF, XLE, XLV, XLI, XLC, XLY, XLP, XLB, XLRE, XLU | Stage 1 — single batch of 11 symbols |

---

## Output Schema

File: `coiled_spring_results.json`

```json
{
  "scanDate": "2026-04-12",
  "scannedAt": "2026-04-12T19:14:29.800Z",
  "universe": 1273,
  "stage1Passed": 42,
  "results": [
    {
      "symbol": "EXAMPLE",
      "name": "Example Corp",
      "price": 85.50,
      "changePct": 0.8,
      "score": 92,
      "classification": "coiled_spring",
      "signals": {
        "trendHealth": 25,
        "contraction": 35,
        "volumeSignature": 16,
        "pivotProximity": 11,
        "catalystAwareness": 5
      },
      "details": {
        "ma50": 82.10,
        "ma150": 78.50,
        "ma200": 74.20,
        "maStacked": true,
        "relStrengthPctile": 82,
        "bbWidthPctile": 12.5,
        "atrRatio": 0.45,
        "vcpContractions": 3,
        "vcpDepths": [11.2, 6.8, 2.9],
        "dailyRangePct": 2.1,
        "volDroughtRatio": 0.62,
        "accumulationDays": 3,
        "upDownVolRatio": 1.65,
        "distFromResistance": 3.2,
        "resistanceTouches": 2,
        "extendedAbove50ma": false,
        "earningsDaysOut": 38,
        "sectorMomentumRank": 2,
        "shortFloat": 8.5,
        "ivRank": 35
      },
      "play": "Sell CSP at support ($82 area, rising 50-day MA). If assigned, hold for breakout and sell CC at resistance ($88). Tight stop below $79.",
      "news": []
    }
  ]
}
```

---

## Files to Create/Modify

| File | Action | Description |
|---|---|---|
| `scripts/scanner/scoring_v2.js` | Create | New scoring engine with all 5 categories |
| `scripts/scanner/yahoo_screen_v2.js` | Create | Revised Stage 1 with inverted filters + Stage 1b OHLCV fetch |
| `scripts/scanner/coiled_spring_scanner.js` | Create | New orchestrator replacing explosion_scanner.js |
| `scripts/scanner/scoring_v2.test.js` | Create | Unit tests for all scoring functions |
| `scripts/dashboard/build_dashboard_html.js` | Modify | Update Explosion Potential tab → "Coiled Springs" tab, new card layout |
| `scripts/scanner/explosion_scanner.js` | Deprecate | Keep for reference, no longer called |
| `scripts/scanner/scoring.js` | Deprecate | Keep for reference, replaced by scoring_v2.js |

---

## What Changed from v1

| Aspect | v1 (Explosion Potential) | v2 (Coiled Spring) |
|---|---|---|
| Philosophy | Find stocks that just exploded | Find stocks about to explode |
| Heaviest weight | Volume Momentum (30 pts for 5x vol) | Contraction (40 pts for tight, quiet stocks) |
| Volume signal | Rewards surges | Rewards drought + accumulation pattern |
| Stage 1 filter | Selects for big movers (vol ratio >= 1.8x, change >= 3%) | Selects for quiet strength (uptrend, near highs, NOT surging) |
| Quality gate | Minimal (price > $5, vol > 200K) | Strict ($1B cap, 1M vol, no recent explosions, must be tradeable) |
| Total points | 100 | 120 |
| New category | — | Volume Signature (20 pts): accumulation days, up/down vol ratio |
| Catalyst timing | Earnings within 14 days (too late) | Earnings 30-45 days out (time to position) |
| Historical data | None (single-day snapshot) | 30-day OHLCV for BB, ATR, VCP, pivot calculations |
| Classification | accumulate, harvest, episodic_pivot | coiled_spring, building_base, catalyst_loaded |

---

## Sources

Research informing this design:
- [VCP Pattern: Volatility Contraction Trading Guide](https://www.tradingsim.com/blog/volatility-contraction-pattern)
- [Mastering the VCP | TraderLion](https://traderlion.com/technical-analysis/volatility-contraction-pattern/)
- [VCP Complete Guide — Mark Minervini](https://www.finermarketpoints.com/post/what-is-a-vcp-pattern-mark-minervini-s-volatility-contraction-pattern-explained)
- [Qullamaggie Episodic Pivot Setup | ChartMill](https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/494-Mastering-the-Qullamaggie-Episodic-Pivot-Setup-A-Flexible-Stock-Screening-Approach)
- [Qullamaggie's 3 Timeless Setups](https://qullamaggie.com/my-3-timeless-setups-that-have-made-me-tens-of-millions/)
- [How to Find Stocks Before They Break Out](https://pro.stockalarm.io/blog/how-to-find-stocks-before-they-break-out)
- [Breakout Stock Screener: Proven Strategies](https://chartswatcher.com/pages/blog/breakout-stock-screener-proven-strategies-from-pro-traders)
- [Best Stocks for the Wheel Strategy 2026](https://options.cafe/blog/best-stocks-for-wheel-strategy/)
- [Wheel Strategy DTE Guide](https://www.daystoexpiry.com/blog/wheel-strategy-guide)
