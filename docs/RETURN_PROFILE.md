# Return Profile — What This Book Actually Does

What to expect from the live book (SPY .5 / QQQ .5 / BTC .2 / GLD .2, all
`regime_beta`), stated honestly enough to size a position against. Every figure is
from dividend-adjusted total-return data via `scratchpad/annualised.py` and
`scratchpad/monthly.py`.

**A backtest CAGR is a description of the past, not a forecast.** The point of this
document is the *shape* of the returns — dispersion, drawdown, losing streaks —
because that is what determines whether a system is survivable in practice.

## Per month

| | 2015–2026 | 48-month backtest |
|---|---|---|
| **Compound (geometric) avg month** | **2.15%** | **2.21%** |
| Arithmetic mean month | 2.29% | 2.32% |
| Median month | 1.65% | 1.83% |
| SPY buy & hold | 1.07% | 1.39% |

Use the **geometric** figure — that is what compounds. The arithmetic mean is always
higher and overstates the outcome.

**The average month is not a month you should expect to have.** Monthly standard
deviation is **5.47%**, more than twice the mean:

| percentile | 10th | 25th | 50th | 75th | 90th |
|---|---|---|---|---|---|
| month return | **−4.4%** | −0.8% | +1.6% | +5.3% | **+9.8%** |

- **69.8%** of months positive → roughly **3 months in 10 are down**
- Worst month **−11.5%**
- Longest losing streak **5 months**; longest winning streak 11

## Per year

| Window | CAGR | maxDD | vol |
|---|---|---|---|
| 48-month backtest | 29.5% | −11.3% | 16.5% |
| 2015 → 2026 | 28.0% | −21.9% | 16.9% |
| *SPY buy & hold* | *13.1%* | *−33.7%* | *17.3%* |

Rolling 1-year outcomes since 2015 — the honest range:

| percentile | 5th | 25th | 50th | 75th | 95th |
|---|---|---|---|---|---|
| 1-year return | **−8.7%** | +5.8% | +28.7% | +45.9% | +92.2% |

**14.5% of 1-year windows were negative. The longest stretch underwater was 19
months.** A year and a half of the system not working is inside normal behaviour,
not evidence that it is broken — which is exactly when discipline fails.

## The BTC dependency (read this before sizing)

More than half the headline return is one sleeve:

| 2015–2026 | avg month | CAGR | maxDD |
|---|---|---|---|
| Live book **with** BTC | 2.15% | 28.0% | −21.9% |
| Same book, **BTC removed** | **1.00%** | **12.3%** | −16.9% |
| SPY buy & hold | 1.07% | 13.1% | −33.7% |
| *2019+ with BTC* | — | *28.8%* | *−21.9%* |
| *2019+ without BTC* | — | *15.8%* | *−16.9%* |

Strip BTC and the book compounds at ~1.0%/month — about the same as holding SPY, at
materially lower drawdown. **BTC is the return engine; the regime filter is the risk
control.** 2017 alone returned **+127.6%** — early-Bitcoin, and it will not repeat.

So the forward question is not "will this make 28%?" It is "how much will the BTC
sleeve contribute from here?" As of this writing BTC sits **below** its 100-day SMA
and the bot is correctly flat on it.

## Against the original 10%/month goal

| threshold | share of months |
|---|---|
| ≥ 10% | **10.1%** (14 of 139) |
| ≥ 5% | 25.9% |
| ≥ 2% | 46.8% |
| ≥ 0% | 69.8% |

One month in ten cleared 10%, and those were overwhelmingly BTC spikes rather than a
repeatable monthly rate. **The 10%/month target (~213%/yr) remains an order of
magnitude beyond what this book does at controlled risk** — consistent with every
other finding in this project.

## What to plan around

- **~1–1.5%/month** is the defensible expectation from the equity/gold sleeves, plus
  whatever BTC trend adds on top. The full 2.15% requires BTC to keep delivering at
  historical magnitudes.
- Expect **3 down months in 10**, **5-month losing streaks**, a **−11% month**, and
  **up to 19 months underwater** as ordinary operating conditions.
- The edge that is genuinely robust is **drawdown control** (−11% to −22% vs
  buy-and-hold's −34%), not return magnitude. That is what the 123-year and
  battle-test work validated; the crypto-driven upside is the part that is least
  likely to repeat.

## Reproducibility

- `scratchpad/annualised.py` — annual/rolling dispersion, drawdown, underwater periods.
- `scratchpad/monthly.py` — monthly profile, geometric vs arithmetic, goal thresholds.
- Data: dividend-adjusted daily closes (`scratchpad/fetch_data.py`), cash = BIL,
  signals lagged one bar (no lookahead).

## Leverage and stop width — tested, both rejected

Grid over leverage × ATR stop width on the 200-day regime book (2015–2026, leverage
financed at 5%/yr on the borrowed portion).

**Stop width at 1x** — wide stops are free, tight stops are strictly worse:

| stop | CAGR | Sharpe | maxDD |
|---|---|---|---|
| none | 13.1% | **1.18** | **−19.3%** |
| 8 ATR (live bot) | 13.1% | **1.18** | **−19.3%** |
| 4 ATR | 13.1% | 1.18 | −19.3% |
| 2 ATR | 12.6% | 1.13 | −21.2% |
| **1 ATR (tight)** | **7.8%** | **0.86** | **−21.0%** |

8-ATR and 4-ATR are *identical* to no stop — they never fire, so the live bot's wide
backstop costs nothing and the regime exit does all the work. The tight stop destroys
40% of the return **and makes drawdown worse** (−21.0% vs −19.3%): it ejects you at a
local low on noise, you sit flat through the recovery, and you remain exposed to the
next decline. You pay for the stop twice and get no protection. This is the same
mechanism this project traced to a −100% wipeout on the old book.

**Leverage** — a clean risk dial, not an edge. Sharpe *declines* monotonically with
financing drag:

| leverage | CAGR | Sharpe | maxDD |
|---|---|---|---|
| 1x | 13.1% | **1.18** | −19.3% |
| 1.5x | 18.6% | 1.12 | −28.3% |
| 2x | 23.6% | 1.08 | −36.5% |
| 3x | 33.0% | 1.03 | −52.3% |

At 2x the book's drawdown exceeds the bot's own 10% circuit breaker several times over.

**The best risk-adjusted cell in the entire grid is 1x with a wide-or-no stop
(Sharpe 1.18) — which is the live bot's current configuration.**
