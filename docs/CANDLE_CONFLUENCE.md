# Candlestick Patterns & Candle Counts — A Real Edge That Isn't Tradeable

A test of the top-down confluence idea: **read the high timeframe, drill down, and only
buy the bounce when several things agree** — weekly trend up, price above a rising
200-day SMA, an actual pullback, and a bullish candlestick or exhaustion count.

Tested exactly as [`price-patterns`](../.claude/skills/price-patterns/SKILL.md) §11
demands: codified into explicit rules, measured against the unconditional baseline, then
out-of-sample with costs and against buy-and-hold.

**Universe:** SPY, QQQ, IWM, GLD, BTC-USD — 25 years of dividend-adjusted daily OHLC
(each bar's O/H/L/C scaled by the same factor, so candle geometry is preserved exactly).

## TL;DR

- **Candlestick formations have no edge.** Hammer, engulfing, piercing, morning star,
  doji — all ≈ zero or **negative**. Morning star and doji are significantly negative.
- **Candle *counts* do have a real edge.** Three-plus consecutive down closes and TD
  Sequential 9 beat baseline by **+0.5%/5 days (t ≈ 3.6)**, and the 200-SMA / weekly
  context *amplifies* it. This is a genuine, statistically solid finding.
- **It is still not tradeable.** As a standalone strategy it loses badly to buy-and-hold
  (SPY 2.4% vs 9.6% CAGR; Sharpe 0.32 vs 0.58) because it sits in cash ~88% of the time,
  and **the equity risk premium it forfeits while waiting exceeds the edge it harvests.**
- **As a sizing overlay it adds nothing.** Any gain is pure exposure — simply raising the
  book's weights uniformly delivers the same CAGR at *higher* Sharpe (1.49 vs 1.44).

## 1. Event study — do these signals predict anything?

Forward-return edge over the unconditional baseline, all symbols pooled. (Forward windows
overlap, so t-stats are optimistic — treat small numbers as noise.)

### Formations: nothing, or worse than nothing

| trigger | n | +5d edge | +20d edge |
|---|---|---|---|
| hammer | 1,515 | −0.079% | **−0.499%** (t −2.5) |
| bullish engulfing | 1,034 | −0.090% | +0.556% (t 1.8) |
| piercing | 468 | −0.017% | +0.009% |
| morning star | 1,573 | **−0.272%** (t −2.8) | **−0.460%** (t −2.2) |
| doji | 2,946 | **−0.179%** (t −2.6) | −0.175% |

Not one bullish formation produced a reliable positive edge, and three were reliably
*negative*. This matches the skill's own reliability warning and the academic literature.

### Counts: a genuine signal

| trigger | n | +1d | +5d | +20d |
|---|---|---|---|---|
| 3 down closes | 2,541 | +0.173% (t 4.0) | +0.220% (t 2.4) | +0.155% |
| 4 down closes | 1,070 | +0.245% (t 3.4) | +0.268% | +0.157% |
| **TD Sequential 9** | 927 | +0.186% | **+0.584%** (t 3.6) | **+0.777%** (t 2.6) |

And the **200-day SMA context genuinely amplifies them** — exactly the confluence effect
the hypothesis predicted:

| trigger | +5d raw | +5d above 200SMA | +5d full confluence |
|---|---|---|---|
| 3 down closes | +0.220% | +0.363% | **+0.528%** (t 3.6) |
| 4 down closes | +0.268% | +0.423% | +0.556% |
| TD9 | +0.584% | +0.522% | +0.698% |

**The control matters though.** Context *alone*, with no candle trigger at all:

| condition | n | +5d | +20d |
|---|---|---|---|
| above 200SMA only | 19,837 | +0.064% | +0.218% |
| above 200 + pullback | 6,126 | +0.109% | +0.380% |
| full context, **no candle** | 4,628 | +0.166% | +0.377% |

So of the +0.528% that "3 down closes + full confluence" earns at 5 days, about +0.17%
is just *being in an uptrend on a dip* — the count itself contributes the remaining
~+0.36%. Real, but small.

## 2. Strategy backtest — does the edge survive contact with reality?

Long-only bounce trades, signal on bar *t* → enter at *t+1* close (no lookahead), 5bps
per side.

**Out-of-sample split:**

| trigger / exit | IS 2001–13 Sharpe | OOS 2014–26 Sharpe | OOS CAGR |
|---|---|---|---|
| 3 down / 5-day hold | 0.83 | **0.44** | 1.8% |
| 3 down / exit above 20SMA | 0.55 | 0.43 | 2.8% |
| 4 down / 5-day hold | 0.32 | 0.30 | 0.8% |
| TD9 / 5-day hold | 0.25 | 0.52 | 1.1% |

The strongest in-sample variant halves out-of-sample — the familiar decay.

**Versus buy-and-hold, same windows:**

| symbol | strategy CAGR | Sharpe | exposure | B&H CAGR | B&H Sharpe |
|---|---|---|---|---|---|
| SPY | 2.4% | 0.32 | 11.1% | **9.6%** | **0.58** |
| QQQ | 2.1% | 0.25 | 14.0% | **12.8%** | **0.63** |
| IWM | 2.6% | 0.30 | 11.9% | **8.9%** | **0.48** |
| GLD | 2.4% | 0.41 | 11.2% | **10.3%** | **0.63** |
| BTC-USD | 6.8% | 0.39 | 13.9% | **33.6%** | **0.80** |

**It loses to buy-and-hold on every symbol, on both return and Sharpe.**

**And it is not a cost problem** — it fails even with costs set to zero:

| cost/side | CAGR | Sharpe |
|---|---|---|
| 0 bps | 2.97% | 0.51 |
| 5 bps | 2.65% | 0.46 |
| 20 bps | 1.70% | 0.31 |

## 3. Why — the diagnosis that generalizes

The edge is real and the strategy still loses, because **exposure is only ~11%**. The
strategy sits in cash roughly seven days in eight waiting for a qualifying dip. Equity
drift is earned *continuously*; the dip-buying edge is earned *occasionally*.

> **The risk premium forfeited while waiting in cash is larger than the edge harvested
> on arrival.** A +0.5%-per-event edge fired ~25 times a year cannot compete with being
> long an asset that drifts up ~10%/yr.

This is the same lesson the project's out-of-sample scan reached from a different angle:
*the only real edge on these instruments is owning beta; timing subtracts value.*

## 4. The obvious fix, and why it also fails

If sitting in cash is the problem, don't sit in cash — stay in the regime book and use
the count only to **size up** into confirmed dips. Overlay: while the book is long an
asset and a count fired in the last N days, scale that sleeve by `boost`.

| variant | CAGR | Sharpe | maxDD | avg gross |
|---|---|---|---|---|
| regime book (no overlay) | 26.8% | **1.49** | −22.9% | 1.03x |
| boost 1.25× for 5d | 27.6% | 1.47 | −22.6% | 1.06x |
| boost 1.5× for 5d | 28.3% | 1.44 | −22.3% | 1.09x |
| boost 2.0× for 10d | 31.6% | 1.34 | −28.1% | 1.25x |

Higher CAGR, but **Sharpe falls monotonically as the boost rises**. The control explains it:

| control (no overlay at all) | CAGR | Sharpe | avg gross |
|---|---|---|---|
| all weights × 1.05 | 28.2% | **1.49** | 1.08x |
| all weights × 1.10 | 29.6% | **1.49** | 1.13x |
| all weights × 1.15 | 31.0% | **1.48** | 1.18x |

At matched gross exposure (~1.08×), plain leverage delivers the **same CAGR at higher
Sharpe** (1.49 vs 1.44). **The overlay's entire apparent gain is exposure, and it
delivers that exposure less efficiently than a uniform weight increase.** The signal adds
nothing beyond the leverage it smuggles in.

## Verdict

**Rejected — but with an unusually clean explanation.**

This is the project's first genuine *statistical* edge: candle counts predict short-horizon
returns with t-stats up to 3.6, and confluence with the 200-SMA and weekly trend
measurably strengthens them. The user's intuition was directionally right.

It is still not a *tradeable* edge, for a reason worth internalizing: **statistical
significance is not economic significance.** An edge must beat not just zero, but the
opportunity cost of the capital used to harvest it. This one doesn't — standalone it
forfeits more beta than it captures, and as an overlay it is dominated by plain leverage.

**Candlestick formations, separately, should simply be retired as entry triggers here.**
Several are reliably negative. Use them for structure and stop placement, exactly as the
skill says — never as a signal.

## 5. The 200-day MA bounce — full 208-combo sweep

"Run the combos" is the right instinct *and* the classic way to manufacture an edge:
search enough rules and the best one always looks good. So the grid was run in full —
7 proximity definitions × 8 triggers × 4 holding periods = **208 combinations** — with
selection made in-sample (2001–2013) and judged out-of-sample (2014–2026).

### First, the encouraging part

| | |
|---|---|
| corr(IS Sharpe, OOS Sharpe) | **+0.589** |
| mean OOS Sharpe, best 10% in-sample | **+0.641** |
| mean OOS Sharpe, worst 10% in-sample | −0.022 |

In-sample rank genuinely predicts out-of-sample. This is **not** pure noise-mining —
there is real persistent structure. The obvious conclusion is "so there IS an edge."

### Then, what the structure actually is

| | |
|---|---|
| corr(**exposure**, OOS Sharpe) | **+0.793** |
| corr(IS Sharpe, OOS Sharpe) | +0.589 |
| **partial** corr(IS, OOS \| exposure) | **+0.232** |

Exposure predicts out-of-sample performance *better than the in-sample Sharpe does*.
Control for it and the apparent edge-persistence collapses from 0.589 to 0.232. **The
"structure" is mostly just time spent in the market** — combos that are invested more
do better, because the assets go up.

### The bounce hypothesis, answered directly

Mean OOS Sharpe by proximity requirement — i.e. how close price must be to the 200-day
MA to qualify:

| proximity rule | n | mean OOS Sharpe | mean exposure |
|---|---|---|---|
| any distance (just above a rising 200) | 32 | **+0.608** | 27.9% |
| within 5% | 32 | +0.200 | 11.8% |
| within 3% | 32 | +0.182 | 7.4% |
| within 2% | 32 | +0.150 | 5.5% |
| within 1% | 32 | +0.056 | 3.5% |
| **reclaim 200 (cross back above)** | 16 | **−0.099** | 1.9% |
| **touch 200 (wick through, close above)** | 32 | **−0.109** | 1.8% |

**A perfectly monotonic ladder, pointing the wrong way.** The tighter the "bounce off the
200" requirement, the worse it performs — and the two rules that literally encode a
bounce (a wick through the 200 closing back above it; a cross back above it) are the
**only two negative buckets in the entire 208-combo grid.**

There is no 200-MA bounce edge here. The 200-day MA is valuable as a *regime filter* —
"am I above it or below it" — and adds nothing as a *touch-and-bounce trigger*.

### What the search actually found

Best combination out of all 208, out-of-sample:

| | OOS Sharpe | OOS CAGR | exposure |
|---|---|---|---|
| **`any_dist + none + 5d`** | **1.14** | 13.2% | 69% |
| buy & hold (equal-weight) | 0.99 | **16.1%** | 100% |

The winner uses **no proximity rule, no candlestick, and no count** — it is simply *"be
long while the 200-day MA is rising."* Higher Sharpe than buy-and-hold, lower return,
partial exposure.

That is a regime filter. **The 208-combo search, run honestly, rediscovered
`regime_beta` — the strategy the bot already trades — and rejected every embellishment
placed on top of it.**

## Reproducibility

- `scratchpad/fetch_ohlc.py` — adjusted daily OHLC (candle geometry preserved).
- `scratchpad/candle_study.py` — event study: formations, counts, confluence, controls.
- `scratchpad/candle_strategy.py` — OOS split, vs buy-and-hold, cost sensitivity.
- `scratchpad/candle_overlay.py` — sizing overlay and the matched-exposure control.
- `scratchpad/ma200_sweep.py` — 208-combo 200-MA bounce sweep, IS/OOS selection, exposure decomposition.
