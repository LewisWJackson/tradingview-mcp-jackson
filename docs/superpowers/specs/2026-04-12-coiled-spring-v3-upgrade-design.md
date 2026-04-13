# Coiled Spring Scanner v3 Upgrade — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Approach:** Enhance in place (keep 120-pt engine, layer probability on top)
**Architecture:** Signal modules + enhanced scoring (Approach 2)

## Decisions Log

| Decision | Choice |
|---|---|
| Architecture | Enhance in place (keep 120-pt engine, layer probability on top) |
| RS benchmark | Both SPY and QQQ, take stronger reading |
| Catalyst sourcing | Enhanced Yahoo only, better keywords + real sector ETF rotation |
| Regime filter | Soft multiplier (1.0x / 0.85x / 0.7x) on final probability score |
| Universe | Keep current 1,273 symbols |
| Stop/entry | Rule-based percentage ranges by classification + contraction |
| Code structure | Signal helpers within scoring_v2.js, composed by existing score*() functions |

---

## Section 1: Enhanced Contraction Quality (0-40 pts)

### New Helpers

**`calcATRPercentile(ohlcv, period=14, lookback=252)`**
Returns current ATR's percentile rank against last 252 bars of ATR values. Answers "ATR is at its Nth percentile of the past year."

**`calcStdDevContractionRate(ohlcv, windows=[10,20,40])`**
Computes standard deviation of close prices over 3 windows. Returns `{ ratio, isContracting }`. Contracting = stddev(10) < stddev(20) < stddev(40).

**Enhanced `detectVCPSwings(ohlcv)` rewrite:**
- 5-bar pivot detection (high > 2 bars on each side) instead of 3-bar
- Allow one non-declining depth in sequence (real VCPs have minor wobbles)
- Returns `vcpContractions` count and `vcpQuality` (0-1 float)

### Multi-Factor Confirmation Gate

Contraction points only awarded in full when >= 3 of these 5 signals confirm:
1. ATR percentile <= 25th
2. BB width percentile <= 30th
3. ATR ratio (fast/slow) < 0.7
4. StdDev contracting across all 3 windows
5. VCP contractions >= 2

If fewer than 3 confirm, contraction category capped at 15 pts (out of 40).

### Point Redistribution (40 pts total)

| Signal | Current | Upgraded |
|---|---|---|
| BB width percentile | 12 | 10 |
| ATR ratio (fast/slow) | 10 | 8 |
| VCP tightening | 10 | 10 |
| Tight daily range | 8 | 6 |
| ATR percentile vs 1yr | — | 6 |
| StdDev contraction rate | — | 0 (gate only) |

---

## Section 2: Relative Strength Confirmation (within Trend Health, 0-30 pts)

### New Helper

**`calcRSvsIndex(candidateOhlcv, spyOhlcv, qqqOhlcv, windows=[20,40])`**
- Rolling return ratio: `candidate_return / index_return` over 20 and 40-bar windows
- Compares against both SPY and QQQ, takes stronger reading
- Returns:
  - `rsRatio20d` — recent RS ratio (> 1.0 = outperforming)
  - `rsRatio40d` — 4-8 week RS ratio
  - `rsTrending` — boolean, rsRatio20d > rsRatio40d (accelerating)
  - `rsNearHigh` — boolean, current RS ratio within 5% of 40-bar max
  - `outperformingOnPullbacks` — boolean, candidate less negative on index-down days

### Data Flow

Orchestrator fetches SPY and QQQ 3-month OHLCV once at start of Stage 2. Passed into scoring context. Zero per-candidate fetches.

### Point Redistribution (30 pts total)

| Signal | Current | Upgraded |
|---|---|---|
| MA stacking (50>150>200) | 8 | 8 |
| Price above 50 MA | 5 | 5 |
| Within 25% of 52-week high | 5 | 4 |
| RS percentile (Yahoo) | 7 | 0 (removed) |
| Higher highs + higher lows | 5 | 4 |
| RS vs index (ratio > 1.0) | — | 4 |
| RS trending upward | — | 3 |
| Outperforming on pullbacks | — | 2 |

### Penalty

If both `rsRatio20d` and `rsRatio40d` < 0.9 (underperforming by >10%): -3 pts (floor at 0).

---

## Section 3: Institutional Accumulation Signals (within Volume Signature, 0-20 pts)

### New/Enhanced Helpers

**Enhanced `calcAccumulationScore(ohlcv)`**
- Up days: close > open AND volume > 1.2x 20-bar avg
- Down days: close < open AND volume < 0.8x 20-bar avg
- Returns `accDistScore` — ratio of weighted up-volume days to weighted down-volume days over last 20 bars

**`calcOBVTrendSlope(ohlcv, period=20)`**
- On-Balance Volume with linear slope (least-squares on 20 points)
- Returns `obvSlope` and `obvSlopeNormalized` (slope / avg volume)

**`calcVolumeClustering(ohlcv, period=20)`**
- Identifies bars near swing lows (within 2% of 10-bar low)
- Compares avg volume at support-area bars vs overall avg
- Returns `supportVolumeRatio` (> 1.3 = institutional dip-buying)

### Point Redistribution (20 pts total)

| Signal | Current | Upgraded |
|---|---|---|
| Volume drought (10d/3mo) | 6 | 5 |
| Accumulation days (count) | 5 | 0 (replaced) |
| Accumulation/distribution score | — | 5 |
| Up/down volume ratio | 5 | 3 |
| Volume on higher lows | 4 | 3 |
| OBV trend slope | — | 2 |
| Volume clustering at support | — | 2 |

---

## Section 4: Enhanced Resistance Detection (within Pivot Structure, 0-15 pts)

### New/Enhanced Helpers

**Enhanced `calcResistanceLevel(ohlcv, windows=[20,40,60])`**
- Highest close across 20, 40, 60-bar windows
- Cluster closes within 1.5% across windows
- 2+ windows agreeing = confirmed resistance
- Returns `resistancePrice`, `resistanceStrength` (1-3), `resistanceTouches`

**`detectGapNearResistance(ohlcv, resistancePrice)`**
- Scans last 20 bars for gaps > 5% within 3% of resistance
- Returns `gapFormedResistance` boolean
- If true, resistance strength capped at 1

### Late-Stage Penalties (stacking, floor at 0)

- Extended > 10% above 50 MA: -5 pts (existing)
- Recent gap > 8% in last 10 bars: -3 pts (new)
- ATR expanding (current > 1.5x 20-bar avg): -2 pts (new)

### Point Redistribution (15 pts total)

| Signal | Current | Upgraded |
|---|---|---|
| Distance from resistance (20-bar) | 6 | 0 (replaced) |
| Distance from confirmed resistance | — | 6 |
| Resistance touches (20-bar) | 4 | 0 (replaced) |
| Resistance strength (multi-window) | — | 4 |
| Tight closes near highs | 3 | 3 |
| Higher swing lows | 2 | 2 |

---

## Section 5: Catalyst Awareness + Sector Rotation (0-15 pts)

### New/Enhanced Helpers

**`matchCatalystKeywords(news, patterns)`**
Categorized pattern groups:
- **Earnings/guidance:** `upgrade`, `beat`, `raised guidance`, `above estimates`, `price target raised`, `revenue growth`
- **M&A/restructuring:** `merger`, `acquisition`, `buyout`, `spin-off`, `activist`, `strategic review`
- **Product/regulatory:** `FDA approval`, `phase 3`, `launch`, `patent`, `contract win`, `new product`
- Returns `catalystType` tag, confidence (`strong`/`weak`), deduplicates same catalyst

**`calcSectorMomentumRank(sectorETFs)`**
- 20-day return for 11 sector ETFs (XLK, XLF, XLV, XLE, XLI, XLY, XLP, XLU, XLB, XLRE, XLC)
- Rank 1-11, maps candidate to sector via Yahoo `sector` field
- Replaces hardcoded rank=6

### Output Tagging

Each candidate gets `catalystTag`:
- `catalyst_present` — strong match OR earnings within 45 days
- `catalyst_weak` — weak matches or short interest only
- `catalyst_unknown` — no catalyst signals

No stock excluded for lacking a catalyst.

### Point Redistribution (15 pts total)

| Signal | Current | Upgraded |
|---|---|---|
| Earnings 30-45 days out | 5 | 4 |
| Earnings < 30 days | 2 | 2 |
| News keyword match (flat) | 3 | 0 (replaced) |
| Categorized catalyst match | — | 3 |
| Sector rank (hardcoded) | 4 | 0 (replaced) |
| Sector rank (calculated) | — | 4 |
| Short interest > 15% | 3 | 2 |

### Data Flow

Orchestrator fetches 11 sector ETF OHLCV once at start of Stage 2 (bulk Yahoo call, ~13 symbols total with SPY/QQQ).

---

## Section 6: Probability Scoring Engine + Market Regime Filter

### New Function: `computeProbabilityScore(signals, context)`

**Step 1 — Normalize each category to 0-1:**

| Category | Max | Normalization |
|---|---|---|
| Contraction Quality | 40 | score / 40 |
| Trend Health | 30 | score / 30 |
| Volume Signature | 20 | score / 20 |
| Pivot Structure | 15 | score / 15 |
| Catalyst Awareness | 15 | score / 15 |

**Step 2 — Weighted mapping (7 factors from 5 categories):**

Trend Health splits into RS sub-signals and non-RS signals:

| Factor | Weight | Source |
|---|---|---|
| volatility_contraction | 25% | Contraction Quality normalized |
| relative_strength_trend | 20% | RS sub-signals from Trend Health (9-pt subtotal / 9) |
| volume_dry_up | 15% | Volume Signature normalized |
| trend_quality | 15% | Non-RS Trend Health signals (21-pt subtotal / 21) |
| distance_to_resistance | 10% | Pivot Structure normalized |
| catalyst_presence | 10% | Catalyst Awareness normalized |
| market_regime_alignment | 5% | Regime score (constructive=1.0, cautious=0.5, defensive=0.0) |

**Step 3 — Raw probability:**
```
rawProb = (contraction * 0.25) + (rs * 0.20) + (volume * 0.15) +
          (trend * 0.15) + (resistance * 0.10) + (catalyst * 0.10) +
          (regime * 0.05)
```

**Step 4 — Regime multiplier:**
```
regimeMultiplier = { constructive: 1.0, cautious: 0.85, defensive: 0.70 }
probabilityScore = Math.round(rawProb * 100 * regimeMultiplier)
```
Capped at 100. Regime affects score twice intentionally: 5% input weight (gentle signal) + final multiplier (visible penalty).

**Step 5 — Derived fields:**

`setup_quality`:
- ELITE: probability >= 80
- HIGH: probability >= 65
- MODERATE: probability >= 50
- LOW: probability < 50

`trade_readiness`:
- `true` if probability >= 65 AND classification is coiled_spring or catalyst_loaded AND breakout risk is not high
- `false` otherwise

**Returns:**
```js
{
  probability_score,      // 0-100 integer
  setup_quality,          // ELITE | HIGH | MODERATE | LOW
  trade_readiness,        // boolean
  regime_multiplier,      // 1.0 | 0.85 | 0.70
  factor_breakdown: {
    volatility_contraction,
    relative_strength_trend,
    volume_dry_up,
    trend_quality,
    distance_to_resistance,
    catalyst_presence,
    market_regime_alignment
  }
}
```

Both the 120-pt composite and 0-100 probability appear in output. Composite preserved for diagnostics.

---

## Section 7: Output Format, Classification, Risk Framework, Ranking

### Updated Classification

Checked in priority order:

```
DISQUALIFIED:
  - price < $5
  - avg 10d volume < 200,000
  - composite score < 30

EXTENDED:
  - extendedAbove50ma > 15% (note: 10-15% triggers pivot penalty in Section 4 but not classification)
  - OR recent gap > 8% in last 10 bars
  - OR ATR expanding (current > 1.5x 20-bar avg)

COILED_SPRING:  (unchanged thresholds)
  - composite >= 85 AND contraction >= 30 AND volumeSignature >= 10 AND distFromResistance <= 8%

CATALYST_LOADED:  (unchanged)
  - catalystAwareness >= 12 AND trendHealth >= 20

BUILDING_BASE:  (unchanged)
  - composite >= 60 AND trendHealth >= 15

BELOW_THRESHOLD:
  - everything else
```

### Risk Framework: `calcRiskCategory(classification, details)`

| Condition | risk_category | suggested_stop_percent |
|---|---|---|
| coiled_spring + vcpContractions >= 3 | tight_vcp | [3, 5] |
| coiled_spring + vcpContractions < 3 | standard_coil | [5, 7] |
| catalyst_loaded | catalyst_play | [5, 8] |
| building_base | base_watch | [7, 10] |
| ATR percentile > 75th | adds +2% to range | — |

### Entry Trigger: `calcEntryTrigger(classification, details)`

| Classification | entry_trigger |
|---|---|
| coiled_spring | `"break above {resistancePrice}"` |
| catalyst_loaded | `"break above {resistancePrice} or sell CSP at {ma50Price}"` |
| building_base | `"watchlist — alert at {resistancePrice}"` |
| extended / disqualified | `"no entry"` |

### Ranking Engine

Weighted rank across 4 factors (rank position per factor, weighted average):

| Factor | Weight |
|---|---|
| probability_score | 40% |
| contraction quality (raw pts) | 25% |
| institutional signature (accDistScore + obvSlope) | 20% |
| resistance clarity (resistanceStrength * inverse distance) | 15% |

Ties broken by probability_score. Return top 15.

### Output JSON Per Candidate

```json
{
  "rank": 1,
  "ticker": "MASI",
  "probability_score": 80,
  "setup_quality": "ELITE",
  "trade_readiness": true,
  "setup_type": "COILED_SPRING",
  "composite_score": 92,
  "composite_confidence": "high",
  "distance_to_resistance": "0.4%",
  "resistance_strength": 3,
  "risk_level": "LOW",
  "risk_category": "tight_vcp",
  "suggested_stop_percent": [3, 5],
  "entry_trigger": "break above 167.50",
  "catalyst_tag": "catalyst_present",
  "regime_multiplier": 1.0,
  "factor_breakdown": {
    "volatility_contraction": 0.82,
    "relative_strength_trend": 0.71,
    "volume_dry_up": 0.65,
    "trend_quality": 0.78,
    "distance_to_resistance": 0.90,
    "catalyst_presence": 0.40,
    "market_regime_alignment": 1.0
  },
  "signals": { "trendHealth": 24, "contraction": 35, "volumeSignature": 16, "pivotProximity": 12, "catalystAwareness": 5 },
  "details": { "...existing detail fields plus new ones..." },
  "breakout_risk": "low",
  "breakout_risk_drivers": [],
  "red_flags": [],
  "play": "Sell CSP at support (MA50). If assigned, hold for breakout, sell CC at resistance.",
  "notes": "strong contraction, merger catalyst present",
  "news": []
}
```

### Top-Level Metadata Additions

```json
{
  "regimeMultiplier": 1.0,
  "benchmarks": { "spy20dReturn": 0.034, "qqq20dReturn": 0.041 },
  "sectorRanks": { "Technology": 1, "Healthcare": 4, "..." }
}
```

---

## Section 8: Orchestrator Changes

### New Data Fetches (once per scan, start of Stage 2)

| Fetch | Symbols | Purpose |
|---|---|---|
| SPY 3-month OHLCV | SPY | RS benchmark |
| QQQ 3-month OHLCV | QQQ | RS benchmark |
| 11 sector ETFs | XLK, XLF, XLV, XLE, XLI, XLY, XLP, XLU, XLB, XLRE, XLC | Sector momentum |

One bulk Yahoo call for 13 symbols. Adds ~2-3 seconds.

### Updated Scoring Context

```js
const scoringContext = {
  regime: marketRegime,
  spyOhlcv: spyBars,
  qqqOhlcv: qqqBars,
  sectorRanks: calcSectorRanks(sectorETFData),
  candidateSector: candidate.sector
};
```

### Updated Per-Candidate Loop

```
1.  scoreTrendHealth(candidate, context)          // uses spyOhlcv, qqqOhlcv for RS
2.  scoreContractionQuality(candidate)            // multi-factor gate, new helpers
3.  scoreVolumeSignature(candidate)               // OBV, volume clustering
4.  scorePivotStructure(candidate)                // multi-window resistance, gap detection
5.  scoreCatalystAwareness(candidate, context)    // real sector ranks
6.  computeCompositeScore(signals, context)       // unchanged
7.  computeProbabilityScore(signals, context)     // NEW
8.  classifyCandidate(composite, probability, signals, details)  // EXTENDED, DISQUALIFIED added
9.  calcRiskCategory(classification, details)     // NEW
10. calcEntryTrigger(classification, details)     // NEW
11. generatePlay(classification, context)         // unchanged
12. generateNotes(signals, details)               // NEW
```

### Ranking Change

After all candidates scored: 4-factor weighted ranking, top 15 (down from 20).

### No Changes To

- `universe.json`
- `yahoo_screen_v2.js` (Stage 1)
- Dashboard HTML builder (new fields are additive)

---

## Section 9: Test Strategy

### Existing Tests to Update

39 tests in `coiled_spring_scanner.test.js` — update threshold assertions for redistributed points:
- Trend Health RS tests (7 pts → RS-vs-index signals)
- Contraction point values (BB 12→10, ATR ratio 10→8)
- Volume accumulation days → accDistScore
- Pivot resistance → multi-window calculation

### New Test Blocks (~35-40 tests)

| Helper | Key Cases |
|---|---|
| `calcATRPercentile` | Low pctile on contracting, high on volatile, handles < 252 bars |
| `calcStdDevContractionRate` | True when declining across windows, false when flat |
| `calcRSvsIndex` | Ratio > 1.0 for outperformer, < 1.0 for underperformer, takes stronger of SPY/QQQ |
| `calcOBVTrendSlope` | Positive on accumulating, negative on distributing, normalized comparable |
| `calcVolumeClustering` | High ratio at swing lows, low when uniform |
| `calcResistanceLevel` | Multi-window agreement → higher strength |
| `detectGapNearResistance` | Detects 6% gap near resistance, ignores small/far gaps |
| `calcSectorMomentumRank` | Returns 1-11, strongest = 1 |
| `matchCatalystKeywords` | Categorizes, deduplicates, strong vs weak confidence |
| `computeProbabilityScore` | Weights sum to 1.0, regime applied, boundary values correct |
| `calcRiskCategory` | VCP → tight, base → wider, volatile adds +2% |
| `calcEntryTrigger` | Each classification → correct template |
| Multi-factor contraction gate | Cap at 15 when < 3 confirm |

### New Fixtures (in `test_fixtures/fixtures.js`)

| Fixture | Purpose |
|---|---|
| `SPY_BARS` | 63-bar SPY OHLCV for RS tests |
| `QQQ_BARS` | 63-bar QQQ OHLCV for RS tests |
| `SECTOR_ETFS` | Minimal sector ETF data for rank tests |
| `OUTPERFORMER` | Returns > SPY, trending RS |
| `UNDERPERFORMER` | Returns < both indices |
| `GAP_NEAR_RESISTANCE` | Recent 7% gap near 20-bar high |

### Integration Test Updates

- Pipeline test: VALID_COIL produces probability_score, setup_quality, risk_category, entry_trigger
- Ranking test: 3+ candidates verify weighted rank order

### Estimated Total

~75-80 tests after upgrade (39 updated + ~35-40 new).

---

## Files Modified

| File | Change |
|---|---|
| `scripts/scanner/scoring_v2.js` | New helpers, enhanced score*() functions, new probability/risk/entry/notes functions |
| `scripts/scanner/coiled_spring_scanner.js` | Fetch SPY/QQQ/sector ETFs, pass context, probability scoring loop, weighted ranking |
| `scripts/scanner/test_fixtures/fixtures.js` | New fixtures (SPY_BARS, QQQ_BARS, SECTOR_ETFS, OUTPERFORMER, UNDERPERFORMER, GAP_NEAR_RESISTANCE) |
| `tests/coiled_spring_scanner.test.js` | Updated thresholds, ~35-40 new test cases |

## Files Not Modified

- `universe.json` — same 1,273 symbols
- `yahoo_screen_v2.js` — Stage 1 unchanged
- `scripts/dashboard/build_dashboard_html.js` — new fields are additive
- `scripts/pine/coiled_spring_score.pine` — separate upgrade cycle if needed
