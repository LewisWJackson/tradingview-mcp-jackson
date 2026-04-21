---
name: the-strat
description: Analyze charts using The Strat methodology — classify candles as 1 (inside), 2 (directional), or 2U/2D and identify high-probability combo patterns (3-1-2, 2-1-2, 2-2 reversal, 1-2-2, 3-2-2). Use when the user wants to find Strat setups, classify candle sequences, identify broadening formations, or trade continuation/reversal patterns using The Strat framework.
---

# The Strat — Pattern Recognition & Trade Identification

## Candle Classification

Every candle is classified relative to the previous candle (including wicks):

| Type | Definition | Meaning |
|------|-----------|---------|
| **1** | Current candle (high+low) fully inside previous candle | Compression / indecision |
| **2U** | Current candle breaks above previous high only | Bullish directional |
| **2D** | Current candle breaks below previous low only | Bearish directional |
| **3** | Current candle breaks both sides of previous candle | Outside bar / expansion / liquidity grab |

Use `data_get_ohlcv` to pull recent bars and classify each candle sequentially.

## High-Probability Strat Combos

### 1. 3-1-2 Continuation (Highest Probability)
- **3** = Outside bar clears stops on both sides
- **1** = Inside bar compresses volatility
- **2** = Break resumes dominant trend direction

**Best conditions**: HTF trend aligned (Weekly/Daily), inside bar near VWAP / 8 or 21 EMA / prior support  
**Edge**: Institutions re-entering after shaking out weak hands

### 2. 2-1-2 Reversal (Elite at Key Levels)
- **2** = Directional push in one direction
- **1** = Inside bar traps late entries
- **2** = Break in the *opposite* direction

**Best conditions**: At major HTF S/R levels, after extended runs/overextension, near LVLs/low liquidity zones  
**Edge**: Trap → unwind → reversal pattern

### 3. 2-2 Reversal
Two consecutive directional candles in one direction → watch for reversal on the second 2's break of the opposite side.

### 4. 1-2-2 Reversal
Inside bar followed by two directional candles. Trade through swing high/low, target previous candle magnitude.

### 5. 3-2-2 Reversal
Outside bar followed by two directional candles. Large magnitude setup — target can develop over multiple candles/days.

## Stop Rule

- **Long**: Stop out after **two consecutive 2D** (down directional) candles against the trade
- **Short**: Stop out after **two consecutive 2U** (up directional) candles against the trade

## Entry Signals at Broadening Formation Edges

At the edge of a broadening formation, look for actionable triggers:
- Pinbars / Hammers
- Shooters (bearish wicks)
- Inside bars (type 1) — compression before the break

Wait for the trigger candle to confirm before entry — do not anticipate.

## Analysis Workflow

```
1. chart_get_state → confirm symbol, timeframe
2. data_get_ohlcv (count: 10-20) → classify last N candles as 1/2U/2D/3
3. Identify the combo pattern in the last 3 candles (e.g., "3-1-2U forming")
4. Check HTF alignment: chart_set_timeframe("W" or "D") → is the trend clear?
5. Confirm entry signal at broadening formation edge (pinbar, hammer, shooter, or 1)
6. capture_screenshot → visual confirmation of setup
7. Define stop: previous candle high/low; exit rule = 2 directional candles against
```

## Trade Filters (Common Mistakes to Avoid)

| Mistake | Correct Approach |
|---------|-----------------|
| Low magnitude — previous candle high/low too close to entry | Look for higher TF candle or wait for wider prior candle |
| Trading *into* a major high or low | Only trade *through* and *away* from HTF levels |
| Entry in the middle of a range | Wait for price to reach one edge of the range first, then take the trigger break |

## Quick Candle Classification (pseudocode)

```
prev = bar[-1], curr = bar[0]

if curr.high < prev.high AND curr.low > prev.low → Type 1 (inside)
if curr.high > prev.high AND curr.low > prev.low → Type 2U (up directional)
if curr.low < prev.low AND curr.high < prev.high → Type 2D (down directional)
if curr.high > prev.high AND curr.low < prev.low → Type 3 (outside)
```
