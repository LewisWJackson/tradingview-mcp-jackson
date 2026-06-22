# Multi-Asset Sharia Allocation — 50/30/20 TASI-momentum / SPUS / Gold, quarterly

**Date:** 2026-06-22
**Script:** `scripts/allocation_backtest.mjs` (`node --experimental-sqlite scripts/allocation_backtest.mjs`)
**Question (structural, NOT an alpha hunt — no pass/fail gate):** Does a fixed-weight, quarterly-rebalanced multi-asset book improve *risk-adjusted* outcomes vs holding the TASI momentum book alone, and which split looks best on Sharpe/Calmar?

## Policy under test

A fixed-weight portfolio rebalanced **quarterly** back to **50% TASI momentum sleeve · 30% SPUS (US-Sharia equity) · 20% GLD (gold)**, plus two alternative splits for context (70/20/10, 35/35/30).

- **TASI leg (preferred, approach a):** the *validated momentum strategy's own equity curve* — NOT the ^TASI index. Replays the live combo line-for-line from `strategy_validation.mjs` / `breadth_test.mjs` / `exposure_arms_test.mjs`: liquid-half ∩ ≥2y-listed TASI universe, top-quintile of the `mom6-rank + 52wk-high-rank` average, equal-weight, 20-session ("monthly") rebalance, Derayah 0.11% RT, COVID carved out. This is the book the user actually holds.
- **TASI leg (conservative floor, approach b):** ^TASI index total-return over the same windows. The user does NOT hold the index — this only bounds the leg from below.
- **US leg:** SPUS daily total return, compounded per window.
- **Gold leg:** GLD daily return, compounded per window.
- Rebalance cost: **0.11%** charged on the traded delta (turnover = ½ the L1 weight gap) at each quarterly rebalance.

## Window — the honest limitation

SPUS inception (2019-12) bounds the common window. After carving out COVID (2020-02-20 → 2021-03-31, consistent with the momentum grade) and requiring ≥2y of history before the first momentum pick, the **effective aligned sample is 2020-01-05 → 2026-06-11 (~5.2y, 65 non-overlapping monthly periods).** This is **short** — ~5 years, one major regime (2022 drawdown + 2023-25 recovery, gold's 2024-25 run). Read everything below as *directional structure*, not a precision estimate. Vol/Sharpe are annualized from monthly periods (×√12.6); Sharpe uses rf=0.

## Metrics — all variants

| variant | CAGR | ann. vol | Sharpe | maxDD | Calmar |
|---|---|---|---|---|---|
| **50/30/20 qtr (mom leg)** | **14.57%** | **13.95%** | **1.05** | **-12.95%** | **1.12** |
| 70/20/10 qtr (mom leg) | 13.30% | 16.59% | 0.84 | -14.12% | 0.94 |
| **35/35/30 qtr (mom leg)** | 15.54% | 12.55% | **1.22** | -12.92% | **1.20** |
| TASI-momentum ALONE (100%) | 11.34% | 21.62% | 0.60 | -19.50% | 0.58 |
| SPUS alone | 13.34% | 19.10% | 0.75 | -25.75% | 0.52 |
| GLD alone | 18.70% | 16.91% | 1.10 | -17.12% | 1.09 |
| ^TASI index alone | -0.02% | 16.55% | 0.08 | -22.70% | -0.00 |
| 50/30/20 qtr (^TASI-index floor) | 8.40% | 12.22% | 0.72 | -16.27% | 0.52 |

## Leg correlations (per-period returns)

| pair | corr |
|---|---|
| momentum ↔ SPUS | **0.20** |
| momentum ↔ GLD | **0.10** |
| SPUS ↔ GLD | **0.03** |
| (context) ^TASI-idx ↔ SPUS | 0.24 |
| (context) ^TASI-idx ↔ GLD | 0.27 |
| (context) momentum ↔ ^TASI-idx | 0.79 |

The three preferred legs are **near-uncorrelated** (0.03–0.20). That is the entire mechanical case for the allocation: low pairwise correlation is what lets the blend cut vol/DD far more than it cuts return. (The momentum book tracks its index at 0.79, as expected — it *is* a TASI long book — but its idiosyncratic, near-zero correlation to US equity and gold is what matters here.)

## Rebalancing premium (50/30/20, momentum leg)

| | CAGR | total return | maxDD | Sharpe |
|---|---|---|---|---|
| quarterly-rebalanced | 14.57% | 101.71% | -12.95% | 1.05 |
| buy & hold (no rebal) | 13.56% | 92.68% | -13.59% | 0.98 |
| **rebalancing premium** | **+1.01%/yr** | **+9.03% over window** | +0.64pp DD relief | +0.07 Sharpe |

Quarterly rebalancing adds **~+1.0%/yr** over letting the weights drift, *after* paying the 0.11% turnover cost — a real (if modest) diversification-rebalance bonus, sourced from systematically trimming the winner and topping up the laggard across three uncorrelated legs. It also slightly reduces drawdown and lifts Sharpe.

## Verdict — does 50/30/20 improve risk-adjusted outcomes vs TASI-momentum alone?

**Yes, decisively on a risk-adjusted basis — and it does NOT cost raw return; it adds it.**

50/30/20 (momentum leg) vs TASI-momentum ALONE over this window:

| | 50/30/20 | mom alone | Δ |
|---|---|---|---|
| CAGR | 14.57% | 11.34% | **+3.23%** (higher, not a sacrifice) |
| ann. vol | 13.95% | 21.62% | **−7.67pp** |
| maxDD | -12.95% | -19.50% | **+6.55pp relief** |
| Sharpe | 1.05 | 0.60 | **+0.44** |
| Calmar | 1.12 | 0.58 | **+0.54** |

The usual framing — "give up some return for lower risk" — does **not** apply here: the blend *raised* CAGR by ~3.2pp while nearly halving vol and cutting maxDD by a third. The reason is the momentum-alone leg's high standalone vol (21.6%) and the legs' near-zero correlation: diversifying into SPUS and gold removed a large chunk of TASI-specific volatility cheaply, and gold's strong 2024-25 run (18.7% standalone CAGR) lifted the blend's return rather than dragging it.

**Best split on Sharpe/Calmar: 35/35/30** (Sharpe 1.22, Calmar 1.20, maxDD -12.9%, CAGR 15.5%) — i.e. *more* gold and US, *less* TASI, scores best because gold was the highest-Sharpe standalone leg in this sample and the TASI book was the highest-vol one. 50/30/20 is a close, more TASI-weighted second (Sharpe 1.05). 70/20/10 (the most concentrated split) is the weakest of the three (Sharpe 0.84) — confirming that tilting *toward* the highest-vol leg erodes the risk-adjusted gain.

## Caveats — read before building a UI policy on this

1. **~5-year sample, one regime.** The window is SPUS-bounded and short; gold's standout contribution leans heavily on its 2024-25 rally. A different 5 years (e.g. a gold bear) would compress the gold leg's lift and likely move "best split" back toward 50/30/20 or even more TASI. The *structure* (low correlation → vol/DD reduction → rebalance premium) is robust; the *exact* "35/35/30 wins" ranking is sample-specific. Do not hard-code 35/35/30 as gospel.
2. **The momentum leg inherits its own survivorship optimism** (~1–1.5%/yr, listed-only Yahoo data — see `strategy_validation.mjs`). Absolute CAGRs here are correspondingly optimistic; the *relative* risk/return comparison between variants is far more reliable than the absolute levels.
3. **Conservative floor:** even using the dead ^TASI *index* (CAGR ≈ 0% over the window) as the TASI leg, the 50/30/20 blend still posts Sharpe 0.72 / maxDD -16.3% — better risk-adjusted than the index alone (0.08 / -22.7%) and than SPUS alone (0.75 / -25.8% — comparable Sharpe but far worse DD). The diversification+rebalance benefit survives even the pessimistic leg assumption; it's the *return* of the blend that depends on the momentum book delivering.
4. **No transaction-cost stress beyond 0.11%**, no FX cost on the USD legs (SPUS/GLD are USD; a SAR-based holder carries USDSAR exposure — pegged, so small, but not modeled), no tax. These are second-order here but should be acknowledged before a live policy.

**Bottom line for the UI policy:** the multi-asset Sharia blend is structurally sound — three near-uncorrelated Sharia-permissible legs, a real ~+1%/yr rebalance premium, and a large risk-adjusted improvement over the momentum book alone with *no* raw-return give-up in this sample. 50/30/20 is a defensible, TASI-tilted default; 35/35/30 scored best on Sharpe/Calmar but is more gold-dependent and sample-sensitive. Build the policy as a *configurable* split (50/30/20 default, expose the weights), not a fixed 35/35/30, given the short window.
