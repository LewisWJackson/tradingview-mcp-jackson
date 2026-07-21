# The Capacity Thesis — Scoped, Tested, and Declined

Before spending on paid stock-level data, we tested the premise that would justify it.
The measurement said don't spend. This documents the scoping so the decision is
reproducible rather than a vibe.

## Why this was the last live idea

Every strategy this project tested was on **SPY, QQQ, GLD, BTC and 47 large liquid
ETFs** — the most heavily arbitraged instruments in existence. The literature is blunt
about what lives there:

| finding | source |
|---|---|
| Published anomalies decay **~58%** post-publication | McLean & Pontiff (2016) |
| **65% of 452 anomalies fail to replicate** | Hou, Xue & Zhang (2020) |
| 162 anomalies: avg long-short **+0.14%/mo before borrow fees → −0.01% after**; not profitable even *before* fees excluding the 12% highest-fee stock-dates | *Anomalies and Their Short-Sale Costs* |

**The published anomaly literature nets to approximately zero after real frictions.**
Our 17 independent rejections reproduced the field's own conclusion.

The one structural advantage retail genuinely has — the only claim that recurs across
credible sources — is **capacity**: a $2bn fund cannot act on a signal in a $400m
company, because 1% of the portfolio would exceed the stock's entire daily volume. The
edge in less-liquid corners should therefore be *larger*, because large players are
structurally excluded. This is also why Medallion capped and closed.

That thesis, if true, justifies buying survivorship-free stock data. So we tested it.

## The test — free data, decisive answer

**Design:** apply the *same* 200-day regime rule to 51 ETFs spanning **four orders of
magnitude of daily dollar volume** (SPY ~$1.1bn/day median down to NORW ~$0.1m/day).
For each, measure `edge = Sharpe(trend) − Sharpe(buy & hold)`, then regress edge against
`log10(median daily dollar volume)`.

- slope **< 0** → illiquidity pays → paid data justified
- slope **≈ 0** → edge is liquidity-independent → save the money
- slope **> 0** → thesis inverted

**Result:**

| | |
|---|---|
| slope | **−0.0165** Sharpe per 10× liquidity |
| t-statistic | **−1.04** |
| correlation | −0.146 |
| R² | **0.021** |
| n | 51 |

**No relationship.** By tercile:

| liquidity tercile | n | median $vol/day | B&H Sharpe | trend Sharpe | edge | DD saved |
|---|---|---|---|---|---|---|
| thin | 17 | $3.3M | 0.34 | 0.34 | **−0.00** | **+23.3pt** |
| mid | 17 | $72.1M | 0.36 | 0.29 | −0.07 | **+24.0pt** |
| liquid | 17 | $1,081.8M | 0.44 | 0.37 | −0.07 | **+23.7pt** |

Across a **~300× span in liquidity**, the trend rule's Sharpe edge is flat and
indistinguishable from zero. **Illiquidity buys nothing.**

## The finding hiding in that table

Look at the last column. The trend rule saves **+23 to +24 percentage points of
drawdown — in every liquidity tier, essentially identically.**

That is the most stable result this project has produced. Across 51 assets and four
orders of magnitude of liquidity, the regime rule reliably does one thing: **it cuts
drawdown by roughly 23 points while giving up a little Sharpe.** It is not an alpha
generator anywhere, and it is a drawdown controller everywhere.

"The trend is your friend" turns out to be exactly and only true in that sense.

## What we would have bought, and what it costs

Scoped for completeness, so the option stays open at a known price:

| provider | survivorship-free | cost/yr | notes |
|---|---|---|---|
| **EODHD** | yes (`&delisted=1`) | **< $1k** | 20–30yr history, bulk download, cheapest credible option |
| **Sharadar SF1** (Nasdaq Data Link) | yes | ~$0.6–1.8k | core US fundamentals, widely used by retail quants |
| **Norgate Data** | yes + historical index constituents | **$1–5k** | "gold standard" for systematic retail; Windows-only (fine here); AmiBroker/RealTest plugins |
| CRSP | yes | $5–10k | academic standard, out of budget |

Realistic entry cost is therefore **~$1–2k/yr**, plus the real cost: handling delistings,
wider spreads, market impact, and borrow fees on any short leg — the exact frictions
that took the published anomaly literature from +0.14%/month to −0.01%.

## Decision: not buying

The premise for the spend was that the edge is bigger where institutions can't go. **We
tested it and it isn't** — at least for the trend rule, across 51 assets.

**Honest limit of this test:** it measures *time-series trend* across the liquidity
spectrum. It does **not** directly test whether *cross-sectional stock selection* works
better in small caps — a related but distinct claim. Two things make that a weak bet
anyway: cross-sectional selection was found **anti-predictive** on the 47-ETF universe
(`corr(IS, OOS) = −0.27`), and the short-sale-cost literature shows the stock-level
anomaly complex nets to zero once borrow fees are paid. Small-cap selection is the
*expensive* path with the *weakest* remaining prior.

If that path is ever taken, it should be entered as a **funded research project with a
kill criterion set in advance**, not as an extension of this bot.

## Reproducibility

- `scratchpad/fetch_liquidity.py` — 51 ETFs spanning 4 orders of magnitude of volume.
- `scratchpad/capacity_test.py` — edge-vs-liquidity regression and tercile breakdown.
