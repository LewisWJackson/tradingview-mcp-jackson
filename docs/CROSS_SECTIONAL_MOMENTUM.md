# Cross-Sectional Momentum — The Last Unturned Stone

The bot has only ever traded a handful of broad index ETFs on a **time-series** rule
("is SPY above its own trend?"). It had never tested **selection** — *"which N of these
47 are strongest right now?"* That is cross-sectional momentum: a relative rather than
absolute judgement, one of the most robustly documented anomalies in finance, and the
one edge family none of this project's rejections had covered.

It was tested because it was the last idea with genuine prior support. **It failed —
and failed in a more decisive way than anything else tested here.**

> **Prediction on record, for calibration:** before running it I estimated Sharpe
> 1.3–1.5 vs the book's 1.18 — "real improvement, not a transformation." **The actual
> result was 0.79, materially worse than the book.** The prior was wrong, and it is
> recorded here because a forecasting process that never marks itself is worthless.

## Method

- **Universe:** 47 ETFs — 9 US sectors, broad US + size + style, 11 international, 7
  fixed income, 6 real assets, 7 industries. Chosen for long history, not for what
  happened to work.
- **Signal:** total return over a lookback (1/3/6/12 months), optionally skipping the
  most recent month (the academic 12-1 convention, which avoids short-term reversal).
- **Portfolio:** equal-weight top N (3/5/8), monthly rebalance, optional absolute filter
  (hold only if above own 200-day SMA), uninvested capital earns T-bills.
- **Costs:** 10bps per side — rotation turns over far more than the trend book.
- **Discipline:** 48 combos, selected in-sample (2007–2016), judged out-of-sample
  (2017–2026). Signals lagged; no lookahead.

## Result: nothing beat the book

| strategy | IS Sharpe | OOS CAGR | OOS Sharpe | OOS maxDD |
|---|---|---|---|---|
| best XS combo (12m/skip0/top3) | 0.39 | 14.7% | **0.79** | −34.3% |
| 12m/skip1/top5 | 0.39 | 15.2% | 0.74 | −35.2% |
| SPY buy & hold | 0.39 | 14.6% | 0.85 | −33.7% |
| equal-weight universe (no selection) | 0.39 | 10.5% | 0.76 | −31.6% |
| **LIVE regime book (200-day)** | **0.68** | 13.3% | **1.15** | **−16.2%** |

**0 of 48 combinations beat the live book out-of-sample.** Not one. The book wins on
Sharpe (1.15 vs 0.79) and less than half the drawdown (−16.2% vs −34.3%).

## The selection signal is *anti*-predictive

The 208-combo candle sweep at least showed `corr(IS, OOS) = +0.59` — real structure,
even if it turned out to be exposure. Here:

| | |
|---|---|
| corr(IS Sharpe, OOS Sharpe) | **−0.266** |
| rank correlation | −0.278 |
| partial corr controlling exposure | −0.276 |
| mean OOS Sharpe, **best** 25% in-sample | +0.521 |
| mean OOS Sharpe, **worst** 25% in-sample | **+0.602** |

**In-sample performance predicts out-of-sample performance *negatively*.** Choosing the
best-looking rule from the backtest would have left you worse off than choosing the
worst-looking one. That is the signature of pure noise plus overfitting — there is no
stable parameter to find.

## Less selection is better — all the way down

| top N held | mean OOS Sharpe |
|---|---|
| top 3 | +0.49 |
| top 5 | +0.54 |
| top 8 | +0.59 |
| **all 47 (equal weight, no selection at all)** | **+0.76** |

Monotonic. **The more the portfolio relies on the momentum ranking, the worse it does**,
and simply holding the entire universe beats every degree of selection. The absolute
200-SMA filter didn't help either (none +0.56 vs own200 +0.53) — it cannot rescue a
ranking that carries no information.

Of the parameter dimensions, only the 12-month lookback showed mild support (+0.71 vs
+0.41 for 3-month), consistent with the literature's preference for 12-1. But the skip
month — the most standard convention of all — *hurt* (skip0 +0.62 vs skip1 +0.47), which
is what parameter noise looks like.

## Not a diversifier either

Even a weaker sleeve can earn a place if it is uncorrelated (this is exactly how the
bond-carry question was adjudicated). It isn't:

- corr(XS momentum, live regime book) = **+0.629**
- corr(XS momentum, SPY) = **+0.567**

| blend | OOS CAGR | OOS Sharpe | OOS maxDD |
|---|---|---|---|
| **100% book** | 13.3% | **1.15** | **−16.2%** |
| 80% book / 20% XS | 14.6% | 1.12 | −17.9% |
| 70% book / 30% XS | 15.3% | 1.08 | −18.9% |
| 50% book / 50% XS | 16.3% | 0.98 | −20.9% |

Adding it raises CAGR and lowers Sharpe monotonically — the same signature as leverage.
It is buying return with risk, not with edge.

## Honest limits of this test

Cross-sectional momentum is best documented on **individual stocks** (Jegadeesh–Titman),
where the cross-section is hundreds or thousands of names with genuine dispersion. A
47-ETF universe is far more correlated — sectors and countries share a dominant common
factor and mean-revert against each other — so this is a materially weaker setting than
the one the academic literature describes. **This result does not refute stock-level
momentum; it tests the version reachable from here**, which is what matters for a bot
trading liquid ETFs. Testing it properly on single names would need survivorship-free,
delisting-adjusted stock data — a different and much larger data problem.

## Verdict

**Rejected.** The last idea with real prior support, tested at full stretch, and it lost
to the existing book on every axis: lower Sharpe, more than double the drawdown, no
diversification benefit, and a selection signal that is *negatively* predictive
out-of-sample.

The search for a better signal is now genuinely closed. Across this project: intraday
timing, mean-reversion, Bollinger variants, cycle timing, the overnight anomaly, adaptive
regime-switching, multi-market trend, bond carry, FX carry, credit, volatility premium,
a beta anchor, candlestick formations, candle counts, 200-MA bounces, leverage, tight
stops — and now cross-sectional selection. Every one lost to a simple regime rule applied
to a handful of liquid assets.

**The remaining levers are not signal levers.** They are capital, cost, discipline, and
execution.

## Reproducibility

- `scratchpad/fetch_universe.py` — 48-ticker adjusted daily universe.
- `scratchpad/xsmom.py` — the 48-combo grid, selection discipline, diversification test.
