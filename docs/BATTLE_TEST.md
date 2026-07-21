# Battle Test — Reactive Regime vs the Alternatives

A stress test of the reactive-regime approach (`regime_beta`: long while price is
above its trend SMA, cash below) that this bot uses. The goal was to find where the
approach **fails**, not to confirm that it works. Four dimensions: era-by-era
consistency, parameter robustness, crash-by-crash protection, and cross-asset
generalization — plus two things the tests forced us to correct.

## TL;DR

- **Reactive regime timing beats predictive cycle-timing decisively, and beats
  buy-and-hold on a risk-adjusted basis over full market cycles** — but it has three
  clear, honestly-mapped failure modes.
- **It works** on trending, drawdown-prone assets (equity indices, BTC, gold),
  across all reasonable SMA lengths, and in 7 of 8 major crashes.
- **It fails** in grinding low-volatility bull markets (whipsaw, lags return) and on
  structurally broken / non-trending instruments.
- Actions taken: **removed USO** (broken ETF), **kept GLD** (converted to regime_beta),
  and **did not add a fast-crash overlay** (tested — the daily signal already handles it).

## 1. Era-by-era consistency (S&P 500 total return, 1900–2023, by decade)

Regime beat buy-and-hold on **return in 9 of 13 decades** and cut **max drawdown in
all 13**. The pattern is consistent:

- **Crash decades** (1930s, 1970s, 2000s): regime *dominates* — it turned buy-and-hold's
  lost decades (1930s **0.0%**, 2000s **−0.7%** CAGR) into **+8.8%** and **+8.0%**.
- **Grinding bull decades** (1950s, **1990s**, 2010s, 2020s): regime **lags on return** —
  biggest miss the 1990s (**14.1% vs 18.2%**, the dot-com melt-up whipsawed the signal).

**Read:** it wins big in busts, loses modestly in strong bulls, always lowers drawdown.
That is the trade — give up some bull upside to avoid catastrophe.

## 2. Parameter robustness (SMA length sweep, full 1900–present)

Not cherry-picked — every reasonable length beats buy-and-hold:

| SMA (months) | CAGR | max DD | Sharpe |
|---|---|---|---|
| buy & hold | 9.8% | −82% | 0.71 |
| 6 | 12.3% | −25% | 1.24 |
| 10 | 12.0% | −41% | 1.20 |
| 15 | 11.0% | −40% | 1.09 |

The edge is structural, not a fitted fluke.

## 3. Crash-by-crash (peak-to-trough drawdown, buy&hold vs regime)

Protected in **7 of 8** major crashes:

| Crash | Buy&Hold DD | Regime DD | Saved |
|---|---|---|---|
| 1929 Depression | −82% | −37% | 45 pts |
| 2008 GFC | −49% | −5% | 44 pts |
| 2000–02 dot-com | −41% | −6% | 34 pts |
| 1937 / 1973–74 / 1987 / 2022 | −18 to −42% | −3 to −15% | 12–32 pts |
| **2020 COVID** (monthly signal) | −19% | −19% | **0 — failed** |

The 2020 miss was specific to the **monthly** test signal (10-month SMA, checks only
month-ends). See correction #2.

## 4. Cross-asset generalization (complete daily data, 2010–2026, 100-day regime)

| Asset | Buy&Hold (CAGR / DD / Sharpe) | Regime (CAGR / DD / Sharpe) | Verdict |
|---|---|---|---|
| BTC | 52% / −83% / 0.96 | **62% / −61% / 1.22** | Best — beats B&H on return *and* risk |
| SPY | 14% / −34% / 0.86 | 9% / −18% / 0.87 | Risk win (lags return in the bull) |
| GLD | 8% / −46% / 0.52 | 7% / −38% / 0.55 | Risk win — a valid uncorrelated diversifier |
| QQQ | 19% / −35% / 0.94 | 10% / −23% / 0.74 | **Lags even risk-adjusted** (strong secular bull) |
| USO | −6% / −95% / 0.02 | 1% / −57% / 0.15 | Instrument is broken regardless |

## Corrections the tests forced (integrity notes)

1. **Alpaca's free daily feed is incomplete for 2018–2021** (SPY returned ~1,500 bars
   for 2018–2026 vs the ~1,940 expected, and **zero bars in the Feb–May 2020 window**).
   The first cross-asset pass used it and was wrong (SPY showed 5.8% CAGR; with complete
   data it is 9.3%). Dimension 4 was **re-run on complete daily data (yfinance)**. Any
   backtest touching 2018–2021 on the Alpaca free feed should be treated with suspicion.
2. **The fast-crash overlay was tested and rejected.** The 2020 "gap" existed only for
   the slow *monthly* signal. On complete daily data the bot's **100-day daily** signal
   exited **2020-02-25 — four trading days after the Feb-19 peak** — cutting the crash from
   buy-and-hold's **−33.7% to −8.2%**. A fast-crash overlay (e.g. exit on a 10-day drop >
   8%) forces **0 extra exits** — it is redundant. Not implemented; unvalidated complexity
   that provably does nothing is exactly what this project avoids.
3. **USO vs GLD.** The earlier "drop both" was based on the corrupted data plus both being
   on the old (losing) `trend_following` strategy. Clean data shows **GLD is a fine regime
   fit** (cuts drawdown, Sharpe up) — it was just on the wrong strategy — while **USO is a
   structurally broken ETF** (−95% buy&hold drawdown from contango decay) that no strategy
   fixes.

## Actions taken

- **Removed USO** from the live config.
- **Converted GLD** from `trend_following` to `regime_beta` (uncorrelated diversifier).
- **No fast-crash overlay added** (see correction #2).
- Live book is now **SPY, QQQ, BTC, GLD — all `regime_beta` on daily bars.**

Post-change confirmation (48-month backtest, eval mode, correlation filter on the
combined row): **combined +173% total return, 10.1% max drawdown, Sharpe 1.77** (41
trades), up from +136% before — converting GLD to regime_beta *added* value rather than
subtracting it, and removed the negative-expectancy drag USO/GLD carried on the old
`trend_following` strategy. (Per-instrument: SPY +28% / PF 5.24, QQQ +43% / PF 8.48,
BTC +33% / PF 3.18, GLD +22% / PF 19.1.) Standard caveat: a 2022–2026 window flatters
the numbers — gold's rally helps GLD here, and the book runs >1x gross.

## Honest limits (do not forget)

The reactive-regime approach is strong **within its domain** and has three permanent
failure modes:

1. **Grinding low-volatility bull markets** → whipsaws, lags buy-and-hold on return.
2. **Fast single-bar flash events** → a slow signal reacts within days, not minutes.
3. **Choppy / non-trending / structurally-broken instruments** → the rule needs the
   asset to actually trend; on oil (USO) it is at best "less bad."

Every long-window backtest here (2010–2026, and much of 1900–2023) is dominated by
rising markets, which *understates* the regime rule's real value (bear-market
protection) and *overstates* buy-and-hold's. Forward, expect regime to roughly match
beta's return while cutting drawdown — its job is the bear market this data can't show.

## Setups, regimes, and where the edge actually lives

Follow-up study (clean daily data, 2011–2026) testing whether *matching setup to
market* or *adapting across regimes/timeframes* beats a simple fixed trend rule.

**Setup × market (Sharpe):** the setup character sorts by the asset's character —
trend-following wins trending assets (crypto, tech, equities), regime-filtered
mean-reversion wins the range-prone ones (gold, bonds). Naive Bollinger band-fade is
weak everywhere and *loses money* on crypto (fading a violent uptrend: $1 → $0.60).

**Condition split (efficiency ratio):** the cleanest result — mean-reversion earns in
*ranging* conditions and dies in trends; trend-following earns *all* its return in
trends and bleeds in ranges (crypto: trend-follow +165%/yr in trending days, −42%/yr in
ranging). **The edge is the condition, not the indicator.**

**But adapting failed OOS.** A top-down multi-timeframe regime-switch (weekly trend gate
→ efficiency-ratio regime → trend-follow or mean-revert accordingly) was built and
tested. **It underperformed the simple fixed trend rule out-of-sample** and was worst on
QQQ and gold. Reason: regime is obvious in hindsight but lagging/noisy live; switching
adds whipsaw; more knobs = more overfit. Not added to the bot.

**Diversified multi-market trend-following (the CTA edge, 16 markets, vol-targeted):**
CAGR 7.7%, maxDD −27%, Sharpe 0.72 — it **lagged buy-and-hold SPY** (14.9%, Sharpe 0.79)
over 2012–2026. BUT: correlation to SPY only **0.44**, and it *outperformed in 2022's
bear* (−15.8% vs −18.2%). Note 2012–2020 was a documented "lost decade" for trend
(vol-suppressed, V-shaped recoveries); its value is **diversification + crisis-alpha,
not beating stocks on return.**

**Honest conclusion on "do profitable traders exist?":** Yes — but the real edges
(Medallion, CTAs, macro, market-making) are **modest** (Sharpe ~0.5–0.8), **specialized**,
and **regime-dependent**, made "very profitable" by *leverage on small edges*,
*diversification across many uncorrelated bets*, *scale/infrastructure*, or being a tiny
capacity-capped elite. They are **not** magic single-setups that crush buy-and-hold every
year. Retail "signal/indicator gurus" selling setups are survivorship + hindsight
screenshots + course revenue — a different business than trading. **The path to a better
system is a portfolio of modest, uncorrelated edges sized by risk and run with
discipline — not a better indicator.** Every "clever" single-setup we tested (cycle
timing, mean-reversion, Bollinger variants, adaptive regime-switch) lost to a simple
fixed trend rule OOS; the durable improvements are *diversification* and *risk
management*, which is exactly what the multi-asset regime-beta book already leans on.

## The one thing that beat buy-and-hold: diversification

The capstone. Instead of hunting a better signal, combine *uncorrelated* return
sleeves and size by risk (the professional playbook — risk parity / return stacking).
Growth of $1, 2012–2026:

| Portfolio | CAGR | maxDD | Sharpe | $1 → |
|---|---|---|---|---|
| 100% Equity (SPY) | 14.9% | −33.7% | 0.79 | $7.5 |
| 60/40 SPY/Bonds | 9.6% | −27.2% | 0.80 | $3.8 |
| **Equity + Trend (60/40)** | 12.3% | **−23.5%** | **0.87** | $5.4 |
| **Diversified 3-sleeve** (equity + trend + BTC-trend) | 19.8% | −25.4% | **1.15** | $13.8 |

**Why it works — sleeve correlations to equity:** diversified-trend **0.44**, BTC-trend
**0.07**, bonds **−0.21**. Uncorrelated sleeves cut risk faster than return → Sharpe rises.

- **The sober, repeatable win is "Equity + Trend"** — Sharpe 0.87 vs 0.79 and drawdown
  cut from −34% to −23%, *without* any moonshot. This is the durable, honest benefit.
- **The 3-sleeve's spectacular number is BTC-inflated** — a 20% BTC-trend sleeve captured
  early-Bitcoin's one-time rise (2012–2017) that will NOT repeat. The *structure* is right;
  the *19.8% magnitude is optimistic.* Use a forward-realistic (smaller) crypto weight.

**The critical qualifier (learned the hard way):** diversification only helps when the
sleeves are **fundamentally different return SOURCES.** The win above worked because it
mixed *equity beta* (Sharpe 0.79) with *trend* (Sharpe 0.72, corr 0.44) — different edges.

Two failed attempts proved the boundary:
1. **Naive** — bolting hand-picked bond (TLT) + commodity (DBC) sleeves onto the live
   trend book over 2022–2026 *underperformed* (Sharpe 1.37 vs 1.77): TLT lost on trend
   (PF 0.12) in a trendless bond market — a sleeve that loses on your strategy is a drag,
   not a diversifier.
2. **Proper** — a vol-weighted, many-market trend diversifier stacked on the trend core
   *still* didn't improve Sharpe (1.15 → 1.14 best), because core-vs-diversifier
   correlation was **0.48: both are trend-following.** You cannot diversify trend with
   more trend, even across different markets.

**Conclusion: the live bot is a single, strong, complete TREND source (concentrated
SPY/QQQ/BTC/GLD, Sharpe ~1.15). It cannot be improved by adding more trend.** A genuine
diversifier would have to be a *non-trend* return source (carry, volatility premium, or a
plain buy-and-hold beta anchor) — a separate build. The bot is deliberately kept
concentrated, because every attempt to "diversify" it with more trend made it worse.

> **Follow-up — the non-trend sleeve got built and tested.** See
> [NON_TREND_SLEEVE.md](NON_TREND_SLEEVE.md). Short version: a *held* (not
> trend-traded) bond-carry sleeve is genuinely uncorrelated (−0.06) and lifts
> full-window Sharpe 0.77 → 0.93 — but split-half testing shows that was the
> 2007–2016 bond bull; it **hurt** in 2017–2026 (2022 crushed bonds). Built and
> shipped **OFF by default** as optional deflationary-crash insurance, not alpha.
> **The search is now closed:** carry (bonds *and* FX), volatility premium, credit, and a
> plain beta anchor were all tested — FX carry is negative-Sharpe with a −28% 2008 and its
> ETF was liquidated; the credit premium is equity beta in disguise (corr 0.67, *rising* to
> 0.69 in crisis) paying 0.9%/yr for a −47% drawdown. The only genuinely uncorrelated sleeve
> that survives forward is **crypto-trend, which the live bot already runs.**

## Reproducibility

- Long history: Shiller monthly S&P 500 (`github.com/datasets/s-and-p-500`), total
  return with dividends; cash earns the 10-year yield when out.
- Cross-asset / daily: complete daily bars (yfinance), dividend-adjusted.
- All signals lagged one month/bar (no lookahead — a lookahead bug was caught and fixed
  during this work, which is why the numbers here supersede any earlier draft).
