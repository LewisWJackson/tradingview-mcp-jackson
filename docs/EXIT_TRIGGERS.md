# Exit Triggers — Is There a Better "Get Out" Rule?

This is the right question to ask of this project. Everything it has established says the
edge is **drawdown control, not alpha**. So the highest-value remaining question is not
"what should I buy" but **"what should get me out"**.

Fifteen candidate rules, each long SPY while the condition holds and in T-bills when it
does not. Signals lagged one bar, 5bps per side, selected IS 2001–2013 / judged OOS
2014–2026.

## Results (SPY, 2001–2026)

| rule | CAGR | Sharpe | maxDD | IS Sh | OOS Sh | exposure | round trips |
|---|---|---|---|---|---|---|---|
| always invested (B&H) | **9.2%** | 0.57 | **−55.2%** | 0.36 | 0.81 | 100% | 0 |
| close > 50-day SMA | 4.1% | 0.44 | −35.6% | 0.24 | 0.65 | 68% | 224 |
| **close > 100-day SMA (bot)** | 6.7% | 0.65 | **−21.3%** | 0.53 | 0.77 | 72% | 129 |
| close > 200-day SMA | 7.3% | 0.69 | −22.7% | 0.53 | 0.84 | 75% | 82 |
| **close > 10-month SMA** | 7.6% | **0.72** | −24.1% | 0.58 | 0.84 | 76% | **74** |
| VIX < 20 | 4.2% | 0.50 | **−18.7%** | 0.41 | 0.58 | 65% | 172 |
| VIX < 25 | 5.9% | 0.55 | −40.5% | 0.31 | 0.78 | 82% | 115 |
| VIX < 30 | 6.5% | 0.53 | −37.3% | 0.33 | 0.74 | 90% | 65 |
| VIX < its own 50d MA | 3.9% | 0.42 | −51.1% | 0.05 | 0.91 | 60% | **359** |
| realized vol < 20% | 7.1% | 0.65 | −36.3% | 0.35 | 0.93 | 79% | 70 |
| drawdown < 10% | 6.1% | 0.59 | −24.5% | 0.34 | 0.79 | 72% | 45 |
| 12-1 momentum > 0 | **8.1%** | 0.68 | −25.0% | 0.63 | 0.72 | 79% | **41** |
| credit (HYG/IEF) > 100d MA | 3.8% | 0.44 | −39.3% | 0.40 | 0.48 | 49% | 127 |
| 200SMA AND VIX<30 | 7.0% | 0.68 | −23.4% | 0.54 | 0.81 | 74% | 95 |
| **200SMA OR VIX<20** | 7.9% | **0.73** | −23.9% | 0.56 | 0.88 | 79% | 82 |

## The test that matters — the three crises

Total return through each drawdown:

| rule | 2008 GFC | 2020 COVID | 2022 bear | **average** |
|---|---|---|---|---|
| always invested | −54.8% | −33.4% | −24.1% | **−37.4%** |
| **VIX < 20** | −12.4% | −4.1% | −8.1% | **−8.2%** |
| **close > 100-day SMA (bot)** | **−8.4%** | −7.0% | −15.2% | **−10.2%** |
| close > 10-month SMA | −9.7% | −15.0% | −11.8% | −12.2% |
| 200SMA AND VIX<30 | −11.8% | −11.5% | −13.9% | −12.4% |
| realized vol < 20% | −27.6% | −11.5% | −2.5% | −13.9% |
| close > 200-day SMA | −11.8% | −17.1% | −13.9% | −14.3% |
| close > 50-day SMA | −32.1% | −4.1% | −8.8% | −15.0% |
| 200SMA OR VIX<20 | −15.4% | −17.1% | −13.3% | −15.3% |
| VIX < 25 | −29.4% | −4.1% | −18.1% | −17.2% |
| VIX < its own 50d MA | −40.9% | +0.2% | −11.5% | −17.4% |
| 12-1 momentum > 0 | −13.9% | −22.6% | −16.8% | −17.8% |
| drawdown < 10% | −17.3% | −17.1% | −19.2% | −17.9% |
| credit (HYG/IEF) | −22.9% | +0.2% | −37.8% | −20.2% |
| VIX < 30 | −27.7% | −11.5% | −29.1% | −22.8% |

## What this actually shows

**1. The "smart" indicators are the worst.** Credit spreads — the classic institutional
stress gauge — finished 14th of 15: Sharpe 0.44, OOS 0.48, only 49% invested, and
**−37.8% in the 2022 bear**, the exact scenario it exists to catch. `VIX < its own 50d MA`
generated **359 round trips**, destroyed calm-market returns (6.0% in 2013 vs B&H's 32.3%),
and *still* lost −40.9% in 2008.

**2. Drawdown stops don't work.** Exiting at −10% averaged −17.9% through the crises: by
the time the rule fires you have taken the damage *and* you sell near the low.

**3. Slow moving averages dominate.** The top of the table is 10-month SMA, 200-day SMA,
and combinations built on them. Simplicity wins again.

**4. The bot's current 100-day SMA is tuned for the right thing.** It ranks ~6th on
Sharpe but **2nd on crisis protection (−10.2%)** and has the **best maximum drawdown of any
return-preserving rule (−21.3%)**. That is a coherent trade, not an oversight.

**5. Genuine upgrade candidates exist, but they are trades, not free wins:**

| swap | you gain | you give up |
|---|---|---|
| 100-day → **10-month SMA** | Sharpe 0.65→0.72, OOS 0.77→0.84, trips 129→74, zero whipsaw in calm years | crisis average −10.2% → −12.2% |
| 100-day → **200-day SMA** | Sharpe 0.69, OOS 0.84, trips →82, zero whipsaw | crisis average → −14.3% |

The slower rules recover the whipsaw drag entirely — in 2013/2017/2024 the 200-day and
10-month rules returned **exactly buy-and-hold** (32.3% / 21.7% / 24.9%), while the
100-day gave up ~3 points. But they are slower to leave, so crises cost more.

**6. VIX < 20 is the interesting outlier.** Best crisis protection (**−8.2%**) and lowest
drawdown (−18.7%) of anything tested — but CAGR of only 4.2% against buy-and-hold's 9.2%.
It is genuinely excellent insurance at a genuinely prohibitive price, which is the same
verdict this project reached on the bond-carry sleeve and on tight stops.

## The structural answer

**No trigger gets you out *before* conditions are bad. Every one of them gets you out
*after* conditions have already turned.** That is not a defect in the rules — it is what
"confirmation" means. The unavoidable cost is roughly 8–15% of drawdown before any exit
fires.

The achievement is not prescience. It is turning **−55% into −10% to −20%**, repeatedly,
across three completely different crises (a credit collapse, a pandemic crash, and an
inflation bear). Nothing here does better than that, and the things that *try* to be
cleverer about it — volatility triggers, credit spreads, drawdown stops — do measurably
worse.

## Caveat before changing anything

This is a **single-asset test on SPY**, and the differences between the top rules
(Sharpe 0.65 vs 0.72) sit inside the noise of n=3 crises over 25 years. Consistent with
this project's own discipline, **no config change should follow from this table alone** —
a switch from the 100-day to the 200-day/10-month rule should first be tested across the
full four-asset book, where BTC and GLD have very different volatility profiles and the
faster rule may be earning its keep.

## Reproducibility

- `scratchpad/exit_triggers.py` — all 15 rules, IS/OOS split, crisis and whipsaw tables.
