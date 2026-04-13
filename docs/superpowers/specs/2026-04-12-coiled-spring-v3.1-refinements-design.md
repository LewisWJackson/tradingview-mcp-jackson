# Coiled Spring Scanner v3.1 Refinements — Design Spec

**Date:** 2026-04-12
**Status:** Approved
**Approach:** Targeted enhancement of existing v3 architecture
**Scope:** 3 new helpers, 2 wiring changes, 1 weight system upgrade, 1 output enhancement

## Decisions Log

| Decision | Choice |
|---|---|
| Architecture | All changes within scoring_v2.js and coiled_spring_scanner.js |
| Regime weights | Smooth VIX-based interpolation, not binary switches |
| Parkinson gate | Gate-only confirmer, no separate point allocation |
| Contraction gate | Tiered (primary/secondary), not flat count |
| Confidence band | Wraps probability_score, does not replace it |
| MA slope lookback | 5 bars (responsive) |
| Parkinson threshold | 0.75 (accounts for high/low noise) |

---

## Section 1: Parkinson Volatility Ratio + Tiered Contraction Gate

### New Helper: `calcParkinsonVolatility(bars, period=20)`

Formula: `PV = sqrt((1 / (4n * ln2)) * sum(ln(H/L)^2))` over the period.

Returns `{ parkinsonVol, parkinsonRatio }` where `parkinsonRatio` is current 10-bar PV divided by 20-bar PV.

Threshold: ratio < 0.75 = contracting intraday ranges. Using 0.75 instead of 0.7 to account for high/low noise sensitivity. The 10-bar PV window provides mild smoothing.

### Tiered Confirmation Gate

Signals classified into Primary and Secondary tiers. Primary signals directly measure volatility compression. Secondary signals confirm structural characteristics associated with consolidation.

| Tier | Signal | Threshold |
|---|---|---|
| Primary | ATR percentile | <= 25th |
| Primary | BB width percentile | <= 30th |
| Primary | ATR ratio (fast/slow) | < 0.7 |
| Primary | Parkinson ratio | < 0.75 |
| Secondary | StdDev contracting | all 3 windows declining |
| Secondary | VCP contractions | >= 2 |

**Unlock rule:** Full contraction scoring is unlocked when either:
- At least 2 Primary signals confirm, OR
- At least 3 total signals confirm, including at least 1 Primary

If neither condition is met, the contraction category score is capped at 15 points.

Parkinson volatility ratio is used as a gate-only confirmer and does not receive separate point allocation. The existing 40-point scoring envelope remains unchanged.

This structure increases the number of valid confirmation paths while maintaining statistical rigor by requiring at least one direct measure of volatility compression.

---

## Section 2: 50 MA Slope + Trend Health Enhancement

### New Helper: `calc50MASlope(bars, period=50, lookback=5)`

Computes the 50-day SMA at current bar and 5 bars ago:

```
ma50Slope = (MA50_current - MA50_5barsAgo) / MA50_5barsAgo * 100
```

Returns `{ ma50Slope, ma50SlopePositive }` where `ma50SlopePositive` is `slope > 0`.

### Updated Trend Signal Weights

`scoreTrendHealth` gains a new 2-pt binary signal within the existing 21-pt trend subtotal. "Within 25% of 52-week high" reduced from 4 to 2 pts — this is a broad trend-maintenance condition rather than a strong leadership signal.

| Signal | Previous pts | v3.1 pts |
|---|---|---|
| MA stacking (50>150>200) | 8 | 8 |
| Price above 50 MA | 5 | 5 |
| Within 25% of 52-week high | 4 | 2 |
| Higher highs + higher lows | 4 | 4 |
| 50 MA slope positive | — | 2 |

Trend subtotal remains 21 points. RS subtotal remains 9 points. Total remains 30 points.

Binary scoring prevents overweighting accelerating momentum, which could bias toward extended stocks. Raw `ma50Slope` value returned in diagnostic output.

### 150 MA Filter

Not included. Existing MA stacking signal (50>150>200) implicitly requires price above 150 MA for full trend score. Dedicated filter can be introduced later if testing demonstrates improved selectivity.

---

## Section 3: Resistance Distance Refinement

### Updated Distance-to-Resistance Scoring

Restructured to favor 2-8% pre-breakout zone and penalize >12%:

| Distance | Previous pts | v3.1 pts | Rationale |
|---|---|---|---|
| < 2% | 6 | 4 | Extremely close — may indicate repeated tests or exhaustion. Limited entry room. |
| 2-5% | 4 | 6 | Ideal pre-breakout positioning. Close enough to signal strength, room for entry. |
| 5-8% | 2 | 4 | Constructive structure, trending toward resistance. |
| 8-12% | 0 | 1 | Far but not disqualified. Minimal credit. |
| > 12% | 0 | -2 | Penalty. Not actionable within 2-6 week horizon. |

Maximum score remains 6 points. Category total remains 15 points.

Distance calculation:

```
distancePct = abs(resistanceLevel - currentPrice) / resistanceLevel * 100
```

Penalty floor: pivot subtotal cannot fall below 0. Follows existing category behavior.

No changes to resistance strength scoring, late-stage penalties, or pivot structure logic.

### Design Rationale

- **< 2% reduced:** Scanner cannot distinguish strong breakout attempt from repeated rejection using distance alone. Mild skepticism, not disqualification.
- **2-5% maximum credit:** Highest probability positioning for controlled breakout entries with favorable risk-reward.
- **> 12% penalty:** Distance suggests setup not actionable within intended timeframe. Helps maintain focus on near-term candidates.

---

## Section 4: Regime-Aware Weight Interpolation

### New Helper: `calcRegimeWeights(vixLevel)`

Factor weights shift smoothly based on VIX level using linear interpolation between two anchor points.

### Regime Anchors

**Calm (VIX <= 18):**

| Factor | Weight |
|---|---|
| volatility_contraction | 22% |
| relative_strength_trend | 22% |
| volume_dry_up | 15% |
| trend_quality | 14% |
| distance_to_resistance | 10% |
| catalyst_presence | 10% |
| market_regime_alignment | 7% |

**Stressed (VIX >= 30):**

| Factor | Weight |
|---|---|
| volatility_contraction | 28% |
| relative_strength_trend | 18% |
| volume_dry_up | 15% |
| trend_quality | 16% |
| distance_to_resistance | 10% |
| catalyst_presence | 8% |
| market_regime_alignment | 5% |

Both columns sum to 100%.

### Interpolation Logic

```
t = clamp((VIX - 18) / (30 - 18), 0, 1)
weight = calm_weight + (stressed_weight - calm_weight) * t
```

- VIX <= 18: use calm weights
- VIX >= 30: use stressed weights
- Between: linear interpolation

### Example at VIX = 22

```
t = (22 - 18) / (30 - 18) = 0.333
contraction: 22 + (28 - 22) * 0.333 = 24%
RS: 22 + (18 - 22) * 0.333 = 20.7%
```

### Relationship to Regime Multiplier

The existing regime multiplier (1.0 / 0.85 / 0.70) remains unchanged. Weight shifting adjusts factor importance. Multiplier adjusts overall opportunity environment. Both operate independently.

### Design Rationale

- **Contraction increases:** Volatility compression becomes more predictive in uncertain markets.
- **RS decreases:** Correlation increases during risk-off, reducing RS signal reliability.
- **Trend quality increases:** Healthy trends demonstrate resilience under stress.
- **Catalyst decreases:** Event-driven narratives less predictable when macro dominates.
- **Distance unchanged:** Breakout geometry doesn't change with regime.
- **Regime alignment reduced:** Prevents double-counting with the separate multiplier.

---

## Section 5: Confidence Band

### New Helper: `calcConfidenceBand(probability_score, signals, context)`

Returns `{ low, mid, high }` — a range expressing scoring uncertainty.

```
mid  = probability_score
low  = max(0, probability_score - halfWidth)
high = min(100, probability_score + halfWidth)
```

### Half-Width Calculation

Base half-width: 5

| Condition | Adjustment |
|---|---|
| All high-confidence categories | -2 |
| Any low-confidence category | +3 |
| Fewer than 3 confirming signals | +2 |
| VIX >= 25 | +2 |

Half-width clamped to [3, 12].

### Band Interpretation

| Width | Meaning |
|---|---|
| 3-5 (narrow) | Strong internal signal agreement. Higher estimate reliability. |
| 6-8 (medium) | Moderate uncertainty. Mixed signal strength. |
| 9-12 (wide) | Higher uncertainty. Conflicting signals or elevated volatility. |

### Example 1 — Strong Setup (score 67%)

All high-confidence, 4 confirming signals, normal VIX:
- Base 5, high confidence -2 = 3 (clamped minimum)
- Band: **64-67-70%**

### Example 2 — Mixed Setup (score 55%)

One low-confidence category, 2 confirming signals, VIX 28:
- Base 5, low confidence +3, confirming<3 +2, VIX>=25 +2 = 12 (clamped maximum)
- Band: **43-55-67%**

### Output Format

```json
{
  "probability_score": 67,
  "confidence_band": { "low": 64, "mid": 67, "high": 70 },
  "setup_quality": "HIGH"
}
```

Console display: `#1 64-67-70% HIGH building_base ZION $61.05`

### Interaction With Existing Logic

The confidence band does NOT affect:
- Ranking order
- setup_quality tier classification
- trade_readiness logic
- Filtering thresholds
- probability_score calculation

All downstream logic continues to use probability_score (mid value). The band is informational only.

---

## Files Modified

| File | Change |
|---|---|
| `scripts/scanner/scoring_v2.js` | New helpers (calcParkinsonVolatility, calc50MASlope, calcConfidenceBand, calcRegimeWeights). Enhanced scoreContractionQuality (tiered gate). Enhanced scoreTrendHealth (slope signal). Enhanced scorePivotStructure (distance tiers). Enhanced computeProbabilityScore (dynamic weights). |
| `scripts/scanner/coiled_spring_scanner.js` | Pass VIX level in context. Add confidence_band to result object. Update console summary format. |
| `scripts/scanner/test_fixtures/fixtures.js` | No changes expected. |
| `tests/coiled_spring_scanner.test.js` | New tests for all new helpers + updated threshold assertions. |
