# Coiled Spring Scanner v2 — Complete System Design

**Date:** 2026-04-12
**Status:** Approved
**Replaces:** Explosion Potential Scanner v1 (scoring.js, yahoo_screen.js, explosion_scanner.js)
**Horizon:** Swing trades, 2-6 weeks

---

## Problem Statement

The v1 "Explosion Potential" scanner identifies stocks **after** they've already made their move. It rewards volume spikes (30pts for 5x volume ratio), large gaps, and proximity to 52-week highs — all lagging indicators of an explosion that already happened. Results included acquired/delisted companies (HOLX) and stocks that had already gapped 48% (ZNTL).

**The goal is the opposite:** find stocks **before** they rally. Identify the coiled spring, not the launched rocket.

## Design Principle

Favor objective, measurable inputs over subjective pattern descriptions. The scoring system should consistently identify stocks demonstrating tightening volatility, rising relative strength, and signs of institutional positioning prior to expansion. Optimize for high-quality setups with asymmetric upside potential rather than high-frequency signals.

---

# 1. Revised Scoring Framework

## Architecture Overview

```
Universe (1,273 symbols)
  → Stage 1: Yahoo bulk quote + hard quality gate (pass/fail)
  → Stage 1b: Yahoo 3-month OHLCV for candidates (~30-50 stocks)
  → Stage 2: Scoring engine (120 pts total) + confidence + risk assessment
  → Output: coiled_spring_results.json + dashboard tab
```

**New Stage 1b:** After the quality gate narrows to ~30-50 candidates, fetch 3 months of daily OHLCV from Yahoo's `/v8/finance/chart/{symbol}?range=3mo&interval=1d` endpoint (~63 trading days). This provides:
- Accurate 150-day MA approximation (with 50-day and 200-day from quote data)
- Full base context for VCP detection (most bases form over 4-12 weeks)
- Better pivot detection with more swing highs/lows to reference
- Richer volume signature with 60+ days of accumulation data
- Still manageable API load (~30-50 requests at ~5KB each)

---

## Quality Gate: Hard Filters (pass/fail)

Objective, binary filters. Every stock must pass ALL of these before scoring. No points — just in or out.

| Filter | Threshold | Rationale |
|---|---|---|
| Market cap | > $1B | Exclude micro/small-cap noise |
| Avg daily volume (3-month) | > 1M shares | Liquid enough for options with tight bid-ask spreads |
| Price | > $10 | Wheel-friendly, decent option premium |
| Still tradeable | `marketState` not "CLOSED_PERMANENTLY", not halted | Kills acquired/delisted stocks (HOLX) |
| Not already exploded | abs(changePct) < 15% today AND 5-day price change < 20% (from OHLCV) | Kills ZNTL-type results — the move already happened |
| Not in downtrend | Price > 200-day MA | Only Stage 2 uptrends |

**Stage 1 pre-filter (replaces v1):** The new filter selects for quiet strength instead of noise:
- Price > 50-day MA (uptrend)
- Price within 25% of 52-week high (not broken down)
- Volume ratio < 2.5x (NOT surging today — we want quiet stocks)
- Market cap and liquidity pass quality gate

v1 selected for noise. v2 selects for quiet strength.

## Soft Red Flags (warnings, not disqualifiers)

These are messy, text-based signals that are too unreliable for a hard gate but valuable as context. They do NOT block a candidate — they appear as warnings in the output and on the dashboard card.

Detected via Yahoo RSS news keyword scan on Stage 1b candidates:

| Red Flag | Keywords scanned | Display |
|---|---|---|
| Dilution / offering | "offering", "dilution", "shelf registration", "secondary offering", "ATM program" | `redFlags: ["dilution_risk"]` |
| Litigation | "lawsuit", "sued", "litigation", "SEC investigation", "class action" | `redFlags: ["litigation"]` |
| FDA / regulatory risk | "FDA rejection", "complete response letter", "clinical hold", "FDA warning" | `redFlags: ["regulatory_risk"]` |
| Insider selling | "insider sold", "insider selling", "10b5-1 plan sale" | `redFlags: ["insider_selling"]` |
| Merger / acquisition noise | "merger", "acquisition", "takeover bid", "going private", "buyout" | `redFlags: ["merger_pending"]` |

**Output:** Each candidate gets a `redFlags: string[]` array. Empty if clean. Dashboard cards show a yellow warning icon with tooltip for each flag. The trader decides whether the flag is material.

---

## Scoring Categories (120 pts total)

### 1. Trend Health (0-30 pts)

Strong, sustained uptrends produce higher probability breakouts. This is a primary filter, not secondary.

| Signal | Points | Measurement |
|---|---|---|
| 50 MA > 150 MA > 200 MA alignment | 8 | Yahoo quote: `fiftyDayAverage`, calculated 150-day, `twoHundredDayAverage` |
| Price above 50-day MA | 5 | `regularMarketPrice > fiftyDayAverage` |
| Within 25% of 52-week high | 5 | `(price - fiftyTwoWeekHigh) / fiftyTwoWeekHigh > -0.25` |
| Relative strength vs SPY trending upward | 7 | Stock's 20-day performance vs SPY's 20-day performance. Top 30% of universe = 7 pts, top 50% = 4 pts |
| Higher highs and higher lows over 20 days | 5 | From OHLCV: current 10-day high > prior 10-day high AND current 10-day low > prior 10-day low |

**Stage 2 confirmation:** A stock scoring 25+ here is in a textbook Stage 2 uptrend — the phase where the largest gains occur (Weinstein stage analysis).

### 2. Contraction Quality (0-40 pts)

The core of the scanner. Identifies true volatility compression preceding expansion, not random sideways drift.

| Signal | Points | Measurement |
|---|---|---|
| BB Width in bottom 20% of 6-month range | 12 | Calculate 20-period BB width from OHLCV. Bottom 20% = 12 pts, bottom 30% = 7 pts |
| ATR declining over 10-20 bars | 10 | Current 5-day ATR vs 20-day ATR. Ratio < 0.5 = 10 pts, < 0.7 = 6 pts |
| VCP tightening: multiple contracting pullbacks | 10 | 3+ contractions where each is shallower than previous = 10 pts, 2 contractions = 6 pts |
| Tight daily range: 5-day avg range < 3% of price | 8 | `avg((high - low) / price)` last 5 days. < 3% = 8 pts, < 5% = 4 pts |

**VCP tightening detection algorithm:**
1. Find local peaks and troughs in 3-month price data (swing highs/lows using 3-bar pivot)
2. Calculate depth of each pullback: `(peak - trough) / peak * 100`
3. If each successive pullback is shallower (e.g., 12% → 7% → 3%), that's VCP tightening
4. 3+ tightening contractions = full points
5. Decreasing volatility across contractions must be monotonic (each < previous)

### 3. Volume Signature (0-20 pts)

Captures institutional accumulation characteristics. Distinguishes passive consolidation (dead money) from active accumulation (smart money positioning).

| Signal | Points | Measurement |
|---|---|---|
| Volume dry-up into consolidation | 6 | `avgVol10d / avgVol3mo`. Ratio < 0.7 = 6 pts, < 0.85 = 3 pts |
| At least 2 accumulation days in last 10 sessions | 5 | Days where `close > open` AND `volume > avgVol50d`. 3+ = 5 pts, 2 = 3 pts |
| Up-volume exceeding down-volume | 5 | Sum volume on up days vs down days over 20 sessions. Ratio > 1.5 = 5 pts, > 1.2 = 3 pts |
| Constructive volume increases on higher lows | 4 | Volume rises on each successive higher low in the base. Pattern present = 4 pts |

**Why this matters:** A stock can be quiet for two reasons: (a) nobody cares — dead money, or (b) institutions are quietly accumulating while retail sells. Dead money shows flat volume with no accumulation days. Active accumulation shows volume dry-up on pullbacks but volume pops on up-moves.

### 4. Pivot Structure (0-15 pts)

Measures breakout readiness — how close and how well-tested the resistance level is.

| Signal | Points | Measurement |
|---|---|---|
| Price within 3-8% of resistance (20-day high) | 6 | Within 3% = 6 pts, within 5% = 4 pts, within 8% = 2 pts |
| Resistance tested at least twice | 4 | Count touches of 20-day high zone (within 1%). 2+ = 4 pts |
| Tight closes near highs of range | 3 | `avg(close - low) / (high - low)` over 5 days. > 0.7 = 3 pts |
| Higher lows structure (flat base or ascending) | 2 | Last 3 swing lows ascending. Present = 2 pts |

**Penalty:** Price extended > 10% above 50-day MA → subtract 5 pts (floor 0). Extended stocks pull back more often than they break higher.

### 5. Catalyst Awareness (0-15 pts)

Catalysts act as accelerants, not primary justification.

| Signal | Points | Measurement |
|---|---|---|
| Earnings within 30-45 days | 5 | Yahoo `earningsTimestamp`. 30-45d = 5 pts, < 30d = 2 pts (too late), > 45d = 0 pts |
| Analyst upgrades or estimate revisions | 3 | Yahoo RSS keyword scan: "upgrade", "buy rating", "price target raised", "guidance", "estimate" |
| Sector momentum tailwind | 4 | Sector ETF in top 3 performing over 20 days = 4 pts, top 5 = 2 pts |
| Elevated short interest (squeeze fuel) | 3 | `shortPercentOfFloat` > 15% = 3 pts, > 10% = 2 pts |

---

# 2. Updated Classification Logic

Total possible: 120 pts.

### Coiled Spring (primary target)
- Score >= 85
- AND contraction >= 30
- AND volume signature >= 10
- AND pivot distance <= 8% from resistance

Highest-conviction setup: tight volatility, institutional accumulation confirmed, near breakout point. **Action:** Active entry candidate.

### Building Base
- Score 60-84
- Trend >= 15
- Breakout not imminent (pivot proximity < 8 or contraction < 25)

Good setup forming but needs more time. **Action:** Watchlist — check back weekly.

### Catalyst Loaded
- Catalyst >= 12
- AND trend >= 20
- Early positioning opportunity ahead of event

Coil may not be as tight, but a credible catalyst approaches with healthy trend. **Action:** Position early for IV ramp.

## Score Confidence

Not every 88 is created equal. A score built from complete data with no proxy fallbacks is more trustworthy than one assembled from approximations and missing fields.

Each candidate gets a `scoreConfidence` field: `"high"` | `"medium"` | `"low"`

| Level | Criteria |
|---|---|
| **high** | All core OHLCV fields present with >= 60 trading days, no proxy fallbacks used, volume data complete, earnings date available |
| **medium** | 1-2 proxy calculations used (e.g., approximated 150-day MA, estimated ATR from incomplete window), or OHLCV has 30-59 days |
| **low** | Missing or approximate data in catalyst fields (no earnings date, no short interest), history window < 30 days, IV rank unavailable or crude estimate |

**Implementation:** Each scoring function returns a `confidence` metadata flag alongside its score. The composite confidence is the lowest of any category's confidence (weakest link).

**Dashboard impact:** Cards show a confidence badge. High = solid border. Medium = dashed border. Low = dimmed card with "limited data" label.

---

## Breakout Risk Assessment

Two stocks can score 88 but have very different failure profiles. The `breakoutRisk` field captures this as a derived assessment: `"low"` | `"medium"` | `"high"`

| Risk Driver | Adds risk | Measurement |
|---|---|---|
| Extended > 8% above 50-day MA | +1 | `(price - ma50) / ma50 > 0.08` |
| High daily ATR despite tight pivot distance | +1 | ATR > 2% of price AND pivot distance < 5% (volatile stock near resistance = prone to false breakout) |
| Weak up/down volume ratio | +1 | Up/down volume ratio < 1.1 (no accumulation conviction) |
| Weak market/sector backdrop | +1 | SPY below 50-day MA OR stock's sector ETF in bottom 3 performers |
| Earnings too close (< 20 days) | +1 | Imminent catalyst creates binary event risk |

**Scoring:** Sum risk drivers (0-5). Low = 0-1 drivers. Medium = 2-3 drivers. High = 4-5 drivers.

**Output:** `breakoutRisk: "low"` with `breakoutRiskDrivers: ["extended_above_ma", "weak_sector"]` for transparency.

**Dashboard impact:** Low = green shield icon. Medium = yellow caution. High = red warning. The drivers list shows the specific reasons on hover/tooltip.

---

### Play Generation

| Classification | Recommended Action |
|---|---|
| Coiled Spring | Sell CSP at support (rising 50-day MA). If assigned, hold for breakout, sell CC at resistance. Stop below consolidation low. |
| Building Base | Add to watchlist. Set alert at 20-day high for breakout trigger. Do not enter yet. |
| Catalyst Loaded | Sell CSP 30-45 DTE into rising IV. Premium is the primary play. If assigned, you own a trending stock at a discount. |

---

# 3. TradingView Pine Script Design Specification

A companion Pine indicator to visually validate scanner candidates on the chart. This does NOT replace the Yahoo-based scanner — it overlays the scoring logic on any chart for manual confirmation and refinement.

## Indicator Name
`Coiled Spring Score [v2]`

## Indicator Type
Overlay + separate pane (dual output)

## Pine Script Structure

```
//@version=6
indicator("Coiled Spring Score [v2]", overlay=true, max_labels_count=50)
```

### Input Parameters (all adjustable)

```
// Quality Gate
i_minPrice     = input.float(10.0,  "Min Price")
i_minVolume    = input.int(1000000, "Min Avg Volume")

// Trend Health
i_maFast       = input.int(50,  "Fast MA Length")
i_maMid        = input.int(150, "Mid MA Length")
i_maSlow       = input.int(200, "Slow MA Length")
i_rsLookback   = input.int(20,  "Relative Strength Lookback")

// Contraction
i_bbLength     = input.int(20,  "BB Length")
i_bbMult       = input.float(2.0, "BB Multiplier")
i_atrFast      = input.int(5,   "ATR Fast Period")
i_atrSlow      = input.int(20,  "ATR Slow Period")
i_rangeAvg     = input.int(5,   "Range Avg Period")
i_rangePct     = input.float(3.0, "Tight Range Threshold %")

// Pivot
i_pivotLookback = input.int(20, "Pivot Lookback")
i_extendedPct   = input.float(10.0, "Extended Above MA %")

// Volume
i_volFast      = input.int(10,  "Volume Fast Avg")
i_volSlow      = input.int(50,  "Volume Slow Avg")
i_accumDays    = input.int(10,  "Accumulation Lookback")
```

### Scoring Category Implementations

**Trend Health (0-30):**
```
// Proxy: Use SMA since Pine has ta.sma built-in
ma50  = ta.sma(close, i_maFast)
ma150 = ta.sma(close, i_maMid)
ma200 = ta.sma(close, i_maSlow)

// Stacked alignment: 50 > 150 > 200
trendStack = ma50 > ma150 and ma150 > ma200 ? 8 : 0

// Price above 50 MA
trendAbove = close > ma50 ? 5 : 0

// Within 25% of 52-week high
high52  = ta.highest(high, 252)
nearHigh = close >= high52 * 0.75 ? 5 : 0

// RS vs SPY — Pine limitation: cannot fetch SPY data in free plans
// Proxy: RS rank vs own history using ROC percentile
roc20      = ta.roc(close, i_rsLookback)
rocPctile  = ta.percentrank(roc20, 252)
rsScore    = rocPctile >= 70 ? 7 : rocPctile >= 50 ? 4 : 0
// Assumption: top-percentile ROC vs own history approximates relative strength

// Higher highs + higher lows
hh = ta.highest(high, 10) > ta.highest(high, 10)[10]
hl = ta.lowest(low, 10) > ta.lowest(low, 10)[10]
hhhlScore = hh and hl ? 5 : 0

trendTotal = trendStack + trendAbove + nearHigh + rsScore + hhhlScore
```

**Contraction Quality (0-40):**
```
// BB Width percentile (6-month)
[bbUpper, bbBasis, bbLower] = ta.bb(close, i_bbLength, i_bbMult)
bbWidth    = (bbUpper - bbLower) / bbBasis * 100
bbPctile   = ta.percentrank(bbWidth, 126)  // 126 trading days ≈ 6 months
bbScore    = bbPctile <= 20 ? 12 : bbPctile <= 30 ? 7 : 0

// ATR contraction ratio
atrFast    = ta.atr(i_atrFast)
atrSlow    = ta.atr(i_atrSlow)
atrRatio   = atrSlow > 0 ? atrFast / atrSlow : 1.0
atrScore   = atrRatio < 0.5 ? 10 : atrRatio < 0.7 ? 6 : 0

// VCP detection — count successive shallower pullbacks
// Simplified proxy: compare recent ATR contractions in thirds of lookback
atr10ago   = ta.atr(5)[10]
atr20ago   = ta.atr(5)[20]
atrNow     = ta.atr(5)
vcpCount   = 0
vcpCount  := atrNow < atr10ago ? vcpCount + 1 : vcpCount
vcpCount  := atr10ago < atr20ago ? vcpCount + 1 : vcpCount
// Assumption: declining ATR across 3 windows approximates VCP tightening
// Full VCP detection with swing pivots would require 100+ bars
vcpScore   = vcpCount >= 2 ? 10 : vcpCount >= 1 ? 6 : 0

// Tight daily range
avgRange   = ta.sma((high - low) / close * 100, i_rangeAvg)
rangeScore = avgRange < i_rangePct ? 8 : avgRange < 5.0 ? 4 : 0

contractionTotal = bbScore + atrScore + vcpScore + rangeScore
```

**Volume Signature (0-20):**
```
// Volume drought
volFastAvg  = ta.sma(volume, i_volFast)
volSlowAvg  = ta.sma(volume, i_volSlow)
droughtRatio = volSlowAvg > 0 ? volFastAvg / volSlowAvg : 1.0
droughtScore = droughtRatio < 0.7 ? 6 : droughtRatio < 0.85 ? 3 : 0

// Accumulation days (up day + above-avg volume) in last N sessions
isAccum(i) => close[i] > open[i] and volume[i] > volSlowAvg[i]
accumCount = 0
for i = 0 to i_accumDays - 1
    accumCount += isAccum(i) ? 1 : 0
accumScore = accumCount >= 3 ? 5 : accumCount >= 2 ? 3 : 0

// Up-volume vs down-volume ratio
upVol   = 0.0
downVol = 0.0
for i = 0 to 19
    if close[i] > open[i]
        upVol += volume[i]
    else
        downVol += volume[i]
udRatio    = downVol > 0 ? upVol / downVol : 0.0
udScore    = udRatio > 1.5 ? 5 : udRatio > 1.2 ? 3 : 0

// Volume on higher lows — simplified: volume increasing at swing lows
// Proxy: check if volume at most recent low > volume at prior low
pivotLow1    = ta.pivotlow(low, 3, 3)
pivotLow2    = ta.pivotlow(low, 3, 3)[10]
volAtLow1    = ta.valuewhen(not na(pivotLow1), volume, 0)
volAtLow2    = ta.valuewhen(not na(pivotLow2), volume, 0)
hlVolScore   = (not na(volAtLow1) and not na(volAtLow2) and volAtLow1 > volAtLow2) ? 4 : 0

volumeTotal = droughtScore + accumScore + udScore + hlVolScore
```

**Pivot Structure (0-15):**
```
// Distance from resistance
resist      = ta.highest(high, i_pivotLookback)
distPct     = resist > 0 ? (resist - close) / resist * 100 : 99
pivotDist   = distPct <= 3 ? 6 : distPct <= 5 ? 4 : distPct <= 8 ? 2 : 0

// Resistance touches (close within 1% of 20-day high)
touchZone   = resist * 0.99
touchCount  = 0
for i = 0 to i_pivotLookback - 1
    touchCount += high[i] >= touchZone ? 1 : 0
touchScore  = touchCount >= 2 ? 4 : 0

// Tight closes near highs
closePos    = ta.sma((close - low) / math.max(high - low, 0.01), 5)
closePosScore = closePos > 0.7 ? 3 : 0

// Higher lows
swLow1 = ta.pivotlow(low, 5, 5)
swLow2 = ta.pivotlow(low, 5, 5)[10]
swLow3 = ta.pivotlow(low, 5, 5)[20]
hlScore = (not na(swLow1) and not na(swLow2) and swLow1 > swLow2) ? 2 : 0

// Extension penalty
extendedPct = ma50 > 0 ? (close - ma50) / ma50 * 100 : 0
penalty     = extendedPct > i_extendedPct ? -5 : 0

pivotTotal  = math.max(pivotDist + touchScore + closePosScore + hlScore + penalty, 0)
```

**Catalyst Awareness:**
Not implementable in Pine Script — earnings dates, news, sector ETF rankings, and short interest are not available as Pine built-in data. This category scored only by the Yahoo-based scanner.

**Assumption label:** Pine Script will display "Catalyst: N/A (scanner only)" on the overlay.

### Composite Score & Display

```
// Total score (without catalyst — Pine max is 105)
pineScore = trendTotal + contractionTotal + volumeTotal + pivotTotal

// Classification (adjusted thresholds for Pine's 105 max)
classification = pineScore >= 72 ? "COILED SPRING" :
                 pineScore >= 50 ? "BUILDING BASE" : "BELOW THRESHOLD"

// Color coding
scoreColor = pineScore >= 72 ? color.green :
             pineScore >= 50 ? color.yellow : color.gray
```

### Overlay Components

1. **Score label** (top-right): Shows total score, classification, and category breakdown
2. **MA ribbons**: Plot 50/150/200 MAs with fill between 50 and 200 (green when stacked, red when inverted)
3. **Resistance line**: Horizontal line at 20-day high (breakout level)
4. **Consolidation zone**: Shaded box from 20-day low to 20-day high
5. **Accumulation day markers**: Small green triangles below bars on accumulation days

### Separate Pane (optional)

Bar chart showing the 4 Pine-measurable categories as stacked bars:
- Trend Health (blue)
- Contraction (orange)
- Volume Signature (purple)
- Pivot Structure (green)

### Watchlist Compatibility

The indicator can be added to a TradingView watchlist column using:
```
// Watchlist column output
plot(pineScore, "CS Score", display=display.status_line)
```

This allows sorting the watchlist by Coiled Spring score.

### Pine Script Limitations & Proxy Assumptions

| Feature | Yahoo Scanner | Pine Script | Proxy Used |
|---|---|---|---|
| RS vs SPY | Direct comparison | Cannot fetch SPY | ROC percentile vs own history |
| VCP detection | Swing pivot algorithm on OHLCV | Limited lookback | ATR decline across 3 windows |
| Catalyst score | Earnings date, news, short interest | Not available | Omitted (15 pts unavailable) |
| Market cap filter | Yahoo `marketCap` field | Not available | Manual watchlist curation |
| 150-day MA | Calculated from OHLCV | SMA(150) available | Direct `ta.sma(close, 150)` |

**Pine max score: 105** (120 minus 15 catalyst points). Classification thresholds adjusted proportionally:
- Coiled Spring: >= 72 (85/120 * 105 ≈ 74, rounded down for slight leniency)
- Building Base: >= 50 (60/120 * 105 = 52.5, rounded down)

---

# 4. Daily Workflow for Scanning and Prioritization

## Premarket (6:00-9:30 AM ET)

### Step 1: Run Scanner
```bash
node scripts/scanner/coiled_spring_scanner.js
```
This produces `coiled_spring_results.json` with scored and classified candidates.

### Step 2: Review Dashboard
Open the HTML dashboard — the "Coiled Springs" tab shows candidates sorted by score with card details.

### Step 3: Triage Candidates

| Classification | Action |
|---|---|
| Coiled Spring (score >= 85) | Pull up on TradingView. Apply Pine indicator for visual confirmation. Mark as "actionable today" if chart confirms. |
| Catalyst Loaded (catalyst >= 12) | Check earnings date, news catalyst. If event is 30-45 days out, mark for CSP entry. |
| Building Base (score 60-84) | Add to watchlist in TradingView with Pine indicator for ongoing monitoring. No action today. |

### Step 4: Filter Actionable vs Watchlist
For each Coiled Spring candidate, answer:
1. Does the Pine overlay confirm the coil? (BB tight, MAs stacked, resistance line clear)
2. Is volume signature healthy? (accumulation days visible, no distribution)
3. Is the entry zone near the 50-day MA (for CSP strike placement)?
4. Does the news contain red flags? (lawsuits, FDA rejections, insider selling)

If all 4 = yes → **actionable today.** Otherwise → watchlist.

## Intraday (9:30 AM - 4:00 PM ET)

### Breakout Monitoring
For actionable Coiled Spring candidates:
- Set alerts in TradingView at the 20-day high (resistance level) for each
- **Breakout confirmation requires:**
  - Price closes above 20-day high (intraday spike then reversal does NOT count)
  - Volume on breakout bar >= 1.5x average daily volume
  - Relative strength vs SPY positive on the breakout day

### Volume Confirmation
- If a candidate breaks out on low volume (< 1.2x avg), do NOT chase
- Mark as "failed breakout attempt" — wait for re-test or next coil
- High-volume breakout (>= 2x avg) on first try = strongest signal

### Relative Strength Check
- If SPY is down 1%+ and candidate is flat/green → strong relative strength, confirms accumulation thesis
- If candidate sells off harder than SPY on a down day → distribution, consider removing from watchlist

## Weekly (Sunday evening or Monday premarket)

### Watchlist Refresh
1. Re-run scanner with updated universe data
2. Compare this week's results to last week's:
   - Did any Building Base stocks graduate to Coiled Spring? → Move to actionable
   - Did any Coiled Spring stocks break out? → Track outcome for backtest
   - Did any candidates break down (lost 50-day MA)? → Remove from watchlist
3. Update TradingView watchlist to match current scanner output

### Catalyst Calendar Review
- Check earnings dates for all watchlist stocks
- If any moved from 45 → 30 days out → window for CSP entry opening
- If any are now < 14 days → too late for new entry, monitor only

### Trend Health Validation
- Check sector ETF rankings — has the sector rotation shifted?
- Run `data_get_study_values` on TradingView for top candidates to cross-reference Pine scores with live chart data

---

# 5. Entry, Exit, and Risk Management Rules

## Entry Triggers

### Primary: Breakout Entry (Coiled Spring)
**Trigger:** Price closes above 20-day consolidation high on >= 1.5x average volume.

| Condition | Required | Notes |
|---|---|---|
| Close above resistance | Yes | Intraday wick doesn't count — must close above |
| Volume >= 1.5x avg | Yes | Confirms institutional participation |
| RS vs SPY positive | Preferred | Same-day relative outperformance |
| Score still >= 85 | Yes | Re-validate score on breakout day |

**Entry method (equity):** Buy within 2% of breakout price. Do not chase if price runs > 5% from breakout level intraday.

**Entry method (wheel/CSP):** Sell CSP at or near the 50-day MA as strike price. 30-45 DTE. This gives you entry at a discount if the breakout fails and pulls back.

### Secondary: Early Entry (Catalyst Loaded)
**Trigger:** Score >= 55, catalyst in 30-45 days, contraction >= 20.

| Condition | Required | Notes |
|---|---|---|
| Trend >= 20 | Yes | Healthy uptrend in place |
| Catalyst 30-45 days out | Yes | Time to position before IV ramp |
| IV rank < 50 | Preferred | Premium hasn't yet expanded |

**Entry method:** Sell CSP 30-45 DTE. Strike at or below 50-day MA. Premium is the primary play. If assigned, you own a trending stock at a discount.

### Conditions That Invalidate Entry
- Price already > 5% above breakout level (chasing)
- Volume declining on the breakout day (< 1x avg)
- Broad market in distribution (SPY below 50-day MA and falling)
- News contains material negative catalyst (lawsuit, FDA rejection, management departure)

## Stop Placement Logic

### Structural Stop (primary)
Place stop below the consolidation low — the lowest price in the 20-day base.

```
stop = lowest_low_in_consolidation - (ATR * 0.5)
```

**Rationale:** If price drops below the entire base, the thesis is broken. The 0.5 ATR buffer avoids getting shaken out by normal noise.

### ATR-Based Stop (alternative)
For stocks where the consolidation base is unusually wide:

```
stop = entry_price - (2.0 * ATR_20)
```

**Use when:** Consolidation low would create risk > 8% from entry. The 2x ATR stop caps downside at a more manageable level.

### Failed Breakout Handling
If price breaks above resistance, then closes back below it within 3 trading days:
1. **Day 1 below:** Hold — normal re-test behavior
2. **Day 2 below:** Tighten stop to breakeven if trade is profitable, or to 1x ATR below entry
3. **Day 3 close below resistance:** Exit. The breakout failed. No exceptions.

Failed breakouts are the primary risk of this strategy. Fast exits on failures preserve capital for the next setup.

## Profit Management

### Scaling Framework
| Condition | Action |
|---|---|
| Price reaches 1R profit (risk amount) | Move stop to breakeven |
| Price reaches 2R profit | Sell 1/3 position, trail stop to 1R |
| Price reaches 3R+ | Sell another 1/3, trail remaining with 10-day MA |
| 10-day MA broken on close | Exit remaining position |

Where R = distance from entry to stop (the risk per share).

### Trailing Stop Concepts
- **10-day EMA trail:** For momentum continuation. Exit when price closes below 10-day EMA on increasing volume.
- **21-day EMA trail:** For longer holds (4-6 week horizon). More room for consolidation during the move.
- **3-bar low trail:** Exit if price closes below the lowest low of the prior 3 bars. Tightest trail, for taking quick profits.

### Momentum Continuation Scenarios
If a stock breaks out and immediately gaps up on day 2:
- Do NOT sell into the gap — this often signals a powerful "follow-through" move
- Tighten trail to 3-bar low or 10-day EMA
- Let the trend run until the trail is hit
- These are the trades that make the strategy — let them work

## Position Sizing

### Risk Per Trade
- **Standard:** 1% of account equity per trade ($3,000 on $300K account)
- **High conviction (Coiled Spring, score >= 95):** Up to 1.5% ($4,500)
- **Lower conviction (Catalyst Loaded, Building Base breakout):** 0.5% ($1,500)

### Volatility-Adjusted Sizing
```
position_size = risk_dollars / (entry_price - stop_price)
shares = floor(position_size)
```

**Example:** $3,000 risk, entry at $85.50, stop at $81.00 (structural stop)
```
shares = floor(3000 / (85.50 - 81.00)) = floor(3000 / 4.50) = 666 shares
position_value = 666 * 85.50 = $56,943
```

### CSP Sizing (for wheel entries)
- Max 1 contract per setup unless account size supports more
- Strike at or below 50-day MA
- Max assignment cost should not exceed 20% of free cash per position
- Never have more than 3 CSP positions from the scanner simultaneously (concentration risk)

### Portfolio Heat
- Maximum 5% total portfolio risk open at any time from scanner positions
- This means 3-5 simultaneous positions depending on conviction level
- If portfolio heat exceeds 5%, do not add new positions until existing ones move to breakeven stops

---

# 6. Backtesting Framework

## Universe Selection
- Same universe as live scanner: S&P 500 + Nasdaq 100 + Russell Mid-Cap (~1,273 symbols)
- Remove stocks that were delisted/acquired during the test period
- Apply quality gate filters as of each scan date (survivorship-bias aware)

## Historical Lookback Period
- **Primary:** 2 years (2024-04-12 to 2026-04-12)
- **Market regime coverage:** Must include at least one correction (>10% drawdown) and one sustained uptrend
- 2024-2026 includes: 2024 Q3 correction, 2025 rally, 2026 tariff volatility — good regime diversity

## Scan Frequency
- Weekly scans (every Monday) over the 2-year period
- Apply the full scoring model to each week's universe
- Record all stocks classified as Coiled Spring, Building Base, or Catalyst Loaded

## Definition of Successful Breakout
A scan candidate is a "success" if within 30 trading days (6 weeks) of being flagged:
1. Price closes above 20-day consolidation high
2. AND subsequently achieves at least 2R gain (2x the distance from entry to structural stop) before hitting the stop

A "partial success" is breakout achieved but only 1R gained before stop or trail hit.

A "failure" is:
- No breakout within 30 days, OR
- Breakout occurs but stop hit before 1R achieved

## Evaluation Metrics

| Metric | Target | Description |
|---|---|---|
| Win rate | >= 45% | Percentage of flagged candidates that achieve 2R+ |
| Average winner | >= 3R | Mean R-multiple of winning trades |
| Average loser | <= -1R | Mean R-multiple of losing trades (should be capped by stops) |
| Expectancy | > 0.5R | `(win% * avg_win) - (loss% * avg_loss)` per trade |
| Max drawdown | < 15% | Worst peak-to-trough on simulated portfolio |
| Profit factor | > 2.0 | Gross profit / gross loss |
| Avg hold period | 10-30 days | Confirms swing-trade horizon |
| Signals per week | 2-8 | Enough to trade, not so many it's noise |

## Backtest Phasing

**Phase 1 question (prove the main signal):** How did Coiled Spring candidates (score >= 85) perform? Win rate, avg R-multiple, max drawdown. This is the only question that matters initially.

**Phase 2 question (once main signal validated):** How did Building Base and Catalyst Loaded perform? Did Building Base names that later became Coiled Springs have better outcomes?

**Phase 3 question:** v1 vs v2 head-to-head. Same universe, same dates — which model has better expectancy?

## Backtest Implementation Notes
- Use Yahoo `/v8/finance/chart/` with `range=2y&interval=1d` for historical data
- Process weekly snapshots: for each Monday, calculate scores using only data available as of that date (no look-ahead bias)
- Log each candidate with: date flagged, score, scoreConfidence, classification, entry price (next-day open after breakout), stop level, outcome (R-multiple), hold period
- Output: CSV file for analysis + summary statistics
- Track scoreConfidence distribution: do "high confidence" candidates outperform "medium" ones? This validates the confidence field.

---

# 7. Known Limitations and Tradeoffs

## Data Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Yahoo 150-day MA not available directly | Must approximate as `(50d + 200d) / 2` or calculate from OHLCV | Stage 1b OHLCV fetch provides exact calculation for candidates |
| IV rank is crude approximation | Yahoo doesn't provide historical IV; current ATM IV mapped to a fixed 15-80% range. This is NOT a real IV rank — it's a rough context field. | Label it clearly as `ivContext` (not `ivRank`) in output. Do not use it in scoring until a reliable source is available. Display as "IV context: ~35 (approximate)" on dashboard. If it becomes unreliable, omit entirely rather than mislead. |
| Short interest data may be stale | Yahoo's `shortPercentOfFloat` updates bi-monthly (FINRA schedule) | Small weight (3 pts). Treat as bonus confirmation, not primary signal. |
| 3-month OHLCV limits deep VCP detection | True VCP patterns can span 6+ months with 4+ contractions | 3 months catches 2-4 contractions — covers most actionable setups. Could extend to `range=6mo` for deeper analysis at cost of larger payloads. |
| Sector ETF comparison is a proxy | True sector relative strength would use component-weighted baskets | 11 SPDR sector ETFs are a standard, widely-accepted proxy. |
| Pine Script cannot fetch external symbols on free plans | RS vs SPY requires Premium+ | Proxy: ROC percentile vs own history. Label assumption in output. |

## Model Tradeoffs

| Tradeoff | Chosen | Alternative | Why |
|---|---|---|---|
| Contraction weighted heaviest (40 pts) | Tight coils rank highest | Equal weighting across categories | Research shows VCP is the single most predictive pre-breakout signal (Minervini, 90%+ in trending markets) |
| Quality gate excludes < $1B market cap | Misses small-cap runners | Lower to $500M | User runs the wheel — needs liquid options, tight spreads, assignable at reasonable cost |
| Volume ratio > 2.5x disqualifies | May filter a legitimate Day 1 breakout | Allow up to 4x | Primary goal is finding setups BEFORE the move. A 2.5x volume day is likely the move itself. Scanner can be re-run next day to catch follow-through. |
| Earnings 30-45d sweet spot | Ignores < 30d setups | Widen to 14-45d | < 30d means IV has already expanded and the crowd has arrived. 30-45d is the positioning window. |
| Pine Script omits catalyst (15 pts) | Pine max is 105 not 120 | Skip Pine, rely only on scanner | Pine provides visual confirmation on chart — valuable even without catalyst score. Thresholds adjusted proportionally. |

## Strategy Risks

| Risk | Probability | Severity | Mitigation |
|---|---|---|---|
| Market regime change (bear market) | Medium | High | Quality gate requires price > 200-day MA. In sustained downtrends, few stocks pass → scanner naturally produces fewer signals. Additional mitigation: check SPY vs its 200-day MA before acting on any signal. If SPY < 200-day, reduce position sizes by 50%. |
| Overfitting to VCP pattern | Low-Medium | Medium | Scoring uses 5 independent categories, not a single pattern. VCP tightening is only 10 of 120 points. Backtest across 2 years of diverse regimes validates robustness. |
| Low signal frequency | Medium | Low | In quiet markets, scanner may flag 0-2 candidates per week. This is a feature — better to have no setup than a forced one. Building Base candidates provide watchlist continuity. |
| Yahoo API rate limiting or changes | Medium | High | Batched requests with 200ms delays. Fallback: reduce universe size. Long-term: consider caching quote data and using TradingView's data tools as backup source. |
| Failed breakouts (main P&L risk) | High (30-50% of breakouts) | Medium | 3-day failed breakout rule enforces fast exits. Average loser capped at 1R by structural stops. The 45%+ win rate with 3R avg winner overcomes the failed breakout rate. |
| Survivorship bias in backtest | Low | Medium | Track delistings/acquisitions during test period. Exclude from universe on date of event, not retroactively. |

## What This System Does NOT Do
- **It does not predict direction.** It identifies setups with favorable risk/reward structure. Some will fail.
- **It does not time the market.** It assumes the user is trading in a generally constructive market environment (SPY > 200-day MA). In bear markets, the correct action is to not trade this system.
- **It does not replace judgment.** The scanner flags candidates; the trader makes the final decision after visual confirmation and news review.
- **It does not automate execution.** All entries, exits, and position sizing are manual decisions informed by the scoring model.

---

## Market Regime Gate

Formalized as a scanner-level check, not just prose guidance. The scanner fetches SPY, QQQ, and VIX quotes alongside the universe and computes a regime assessment included in every scan output.

```json
"marketRegime": {
  "spyAbove200dma": true,
  "spyAbove50dma": true,
  "qqqAbove200dma": true,
  "qqqAbove50dma": false,
  "vixLevel": 21.4,
  "regime": "constructive"
}
```

| Regime | Condition | Scanner behavior |
|---|---|---|
| **constructive** | SPY > 200-day MA AND QQQ > 200-day MA AND VIX < 30 | Normal operation. Candidates labeled "actionable" |
| **cautious** | SPY > 200-day MA but < 50-day MA, OR VIX 25-35 | Scanner runs but all candidates labeled "watch only — reduced conviction" |
| **defensive** | SPY < 200-day MA OR VIX > 35 | Scanner runs for watchlist building only. Dashboard header shows red "DEFENSIVE REGIME — NO NEW ENTRIES" banner |

**VIX source:** Fetched as `^VIX` in the Stage 1 sector ETF quote batch (single extra symbol, no additional API call).

**Dashboard impact:** Regime badge appears at top of Coiled Springs tab. In cautious/defensive modes, card action language changes from "Sell CSP at support" to "Watchlist only — wait for regime improvement."

---

## Data Sources

| Data | Endpoint | When fetched |
|---|---|---|
| Quote snapshot (price, MAs, volume, market cap, earnings date) | `/v7/finance/quote` | Stage 1 — full universe in batches of 50 |
| 3-month daily OHLCV (BB, ATR, VCP, pivot, volume signature) | `/v8/finance/chart/{symbol}?range=3mo&interval=1d` | Stage 1b — ~30-50 candidates that pass quality gate |
| Options chain (IV rank) | `/v7/finance/options/{symbol}` | Stage 1b — same candidates |
| News (catalyst keywords) | Yahoo RSS feed | Stage 1b — same candidates |
| Sector ETF performance | `/v7/finance/quote` for XLK, XLF, XLE, XLV, XLI, XLC, XLY, XLP, XLB, XLRE, XLU | Stage 1 — single batch of 11 symbols |

## Output Schema

File: `coiled_spring_results.json`

```json
{
  "scanDate": "2026-04-12",
  "scannedAt": "2026-04-12T19:14:29.800Z",
  "universe": 1273,
  "stage1Passed": 42,
  "marketRegime": {
    "spyAbove200dma": true,
    "spyAbove50dma": true,
    "qqqAbove200dma": true,
    "qqqAbove50dma": false,
    "vixLevel": 21.4,
    "regime": "constructive"
  },
  "results": [
    {
      "symbol": "EXAMPLE",
      "name": "Example Corp",
      "price": 85.50,
      "changePct": 0.8,
      "score": 92,
      "scoreConfidence": "high",
      "classification": "coiled_spring",
      "breakoutRisk": "low",
      "breakoutRiskDrivers": [],
      "redFlags": [],
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
      "play": "Sell CSP at support ($82, rising 50-day MA). If assigned, hold for breakout, sell CC at $88. Stop below $79.",
      "news": []
    }
  ]
}
```

## Implementation Phasing

### Phase 1: Core Scanner Foundation
Build the scoring pipeline end-to-end. Get results flowing.

| File | Action | Description |
|---|---|---|
| `scripts/scanner/yahoo_screen_v2.js` | Create | Stage 1 with inverted filters + Stage 1b 3-month OHLCV fetch |
| `scripts/scanner/scoring_v2.js` | Create | Scoring engine: hard quality gate, trend, contraction proxies, volume signature, pivot structure, basic catalyst |
| `scripts/scanner/coiled_spring_scanner.js` | Create | Orchestrator: market regime check, Stage 1 → 1b → scoring → JSON output |

**Scope for Phase 1:**
- Hard quality gate only (no red flag scanning yet)
- VCP: use ATR contraction proxy — skip fancy swing-pivot detection initially
- IV rank: include as a simple context field, clearly labeled as approximate. Do not make it sound more precise than it is. If Yahoo IV is crude, say so in the output.
- Catalyst: include earnings date and sector momentum if easily available. Skip news keyword scanning.
- Score confidence and breakout risk: include from day one — these are simple derived fields.
- Market regime: include from day one — single extra quote fetch.

### Phase 2: Trust and Validation
Prove the main signal works before polishing.

| File | Action | Description |
|---|---|---|
| `scripts/scanner/scoring_v2.test.js` | Create | Unit tests for all scoring functions |
| `scripts/scanner/test_fixtures/` | Create | Small fixture library of known examples |

**Required test fixtures:**
- Valid coiled spring (tight BB, low ATR, stacked MAs, accumulation days)
- Already exploded (ZNTL-like: 48% gap, 6x volume)
- Broken down (below 200-day MA, downtrend)
- Illiquid (< 1M avg volume, wide spreads)
- Fake compression (tight range but no accumulation, dead money)
- Edge case: score exactly at classification boundary (84/85)

**Focus question:** How did Coiled Spring names perform? Building Base and Catalyst Loaded comparison comes later.

### Phase 3: Dashboard and Output QA
Make the output trustworthy and useful.

| File | Action | Description |
|---|---|---|
| `scripts/dashboard/build_dashboard_html.js` | Modify | Update Explosion Potential tab → "Coiled Springs" tab |

**Dashboard cards show:**
- Score with category breakdown bars (trend / contraction / volume / pivot / catalyst)
- Score confidence badge (high / medium / low)
- Breakout risk indicator (green / yellow / red) with drivers on hover
- Red flags as yellow warning icons with tooltip
- Market regime banner at tab top
- Top reason it scored high + top reason to be cautious
- Play recommendation (adjusted by regime)

### Phase 4: Pine Companion
Only after scanner output feels credible.

| File | Action | Description |
|---|---|---|
| `scripts/pine/coiled_spring_score.pine` | Create | TradingView Pine Script indicator |

**Pine simplifications for v1:**
- VCP logic: use ATR contraction proxy across 3 windows. Do not over-engineer pivot intelligence in Pine on day one.
- RS vs SPY: use ROC percentile proxy (documented limitation)
- Catalyst: omitted entirely (15 pts unavailable in Pine, thresholds adjusted)
- Watchlist column output for sorting

### Deprecated Files
| File | Action | Description |
|---|---|---|
| `scripts/scanner/explosion_scanner.js` | Deprecate | Keep for reference, no longer called |
| `scripts/scanner/scoring.js` | Deprecate | Keep for reference, replaced by scoring_v2.js |

---

## What Changed from v1

| Aspect | v1 (Explosion Potential) | v2 (Coiled Spring) |
|---|---|---|
| Philosophy | Find stocks that just exploded | Find stocks about to explode |
| Heaviest weight | Volume Momentum (30 pts for 5x vol) | Contraction Quality (40 pts for tight, quiet stocks) |
| Volume signal | Rewards surges | Rewards drought + accumulation pattern |
| Stage 1 filter | Selects big movers (vol >= 1.8x, change >= 3%) | Selects quiet strength (uptrend, near highs, NOT surging) |
| Quality gate | Minimal (price > $5, vol > 200K) | Strict ($1B cap, 1M vol, no explosions, tradeable) |
| Total points | 100 | 120 |
| New category | — | Volume Signature (20 pts) |
| Catalyst timing | Within 14 days (too late) | 30-45 days out (time to position) |
| Historical data | Single-day snapshot | 3-month OHLCV for all calculations |
| Classification | accumulate, harvest, episodic_pivot | coiled_spring, building_base, catalyst_loaded |
| Pine Script | None | Full companion indicator |
| Risk management | None | Complete entry/exit/sizing framework |
| Backtesting | None | Defined framework with metrics |

---

## Sources

- [VCP Pattern: Volatility Contraction Trading Guide](https://www.tradingsim.com/blog/volatility-contraction-pattern)
- [Mastering the VCP | TraderLion](https://traderlion.com/technical-analysis/volatility-contraction-pattern/)
- [VCP Complete Guide — Mark Minervini](https://www.finermarketpoints.com/post/what-is-a-vcp-pattern-mark-minervini-s-volatility-contraction-pattern-explained)
- [Qullamaggie Episodic Pivot Setup | ChartMill](https://www.chartmill.com/documentation/stock-screener/technical-analysis-trading-strategies/494-Mastering-the-Qullamaggie-Episodic-Pivot-Setup-A-Flexible-Stock-Screening-Approach)
- [Qullamaggie's 3 Timeless Setups](https://qullamaggie.com/my-3-timeless-setups-that-have-made-me-tens-of-millions/)
- [How to Find Stocks Before They Break Out](https://pro.stockalarm.io/blog/how-to-find-stocks-before-they-break-out)
- [Breakout Stock Screener: Proven Strategies](https://chartswatcher.com/pages/blog/breakout-stock-screener-proven-strategies-from-pro-traders)
- [Best Stocks for the Wheel Strategy 2026](https://options.cafe/blog/best-stocks-for-wheel-strategy/)
- [Wheel Strategy DTE Guide](https://www.daystoexpiry.com/blog/wheel-strategy-guide)
- [Yahoo Finance API Guide](https://publicapis.io/blog/yahoo-finance-api-guide)
