# Test Plan #1 — Compounding Geometry

**Date:** 2026-06-21
**Rank:** #1 (lowest overfit risk, ~free uplift on the existing edge)
**Status:** authorized by board conclusion; not yet run

---

## Plain-English summary

We already have one proven edge: buy the Sharia-OK, liquid, established TASI stocks with the
strongest 6-month price strength, refresh monthly. That edge says *what* to hold. It says nothing
about *how much* to hold of each, or *how hard to step on the brakes* when things go wrong.

"Compounding geometry" = the math of how money grows over time when you reinvest. The claim being
tested: the *same* stock picks, sized smarter, compound to a materially higher ending balance —
**without predicting anything new**. No new signal, no new data feed. Just bet-sizing and brakes
applied to the picks we already trust.

Why this could be real and not wishful: two portfolios with the *same* average return can end up
far apart if one has bigger swings (drawdowns). A −50% loss needs a +100% gain to recover. Cutting
the depth of the bad stretches raises the *compounded* (geometric) return even if the *average*
(arithmetic) return is unchanged. This is arithmetic, not a forecast — which is exactly why it is
ranked first and lowest-risk.

---

## Hypothesis (precise)

> Applying volatility-targeted position sizing + conviction weighting + a drawdown brake to the
> existing momentum portfolio raises the **compound annual growth rate (CAGR)** and lowers
> **max drawdown**, net of Derayah 0.11% round-trip cost, versus the current equal-weight version —
> and the improvement survives out-of-sample.

Three levers, tested in this order (each must earn its place before adding the next):

1. **Volatility targeting** — scale total exposure so the portfolio aims at a fixed risk level
   (e.g. target ~12% annualized volatility). Calm market → lean in; wild market → pull back.
2. **Conviction weighting** — within the held names, tilt weight toward the higher-ranked momentum
   names instead of equal-weighting all of them. (Capped, to avoid concentration blow-ups.)
3. **Drawdown brake** — when the portfolio is down more than X% from its peak, cut gross exposure
   (e.g. halve it) until it recovers a set fraction. A circuit breaker, not a prediction.

---

## What "win" means (primary + guardrails)

**Primary metric:** geometric CAGR, net of cost.
**Co-primary:** max drawdown (must not get worse to count as a win).
**Tie-break / sanity:** Sharpe and Sortino (return per unit of risk), turnover (does the brake
churn and bleed cost?).

A lever only advances if it **raises CAGR OR cuts drawdown meaningfully, while not worsening the
other**. Raising return by taking wildly more risk is not a win — that is just leverage, and it
fails the drawdown guardrail.

---

## Data needed

**Scope decision (2026-06-21):** the concept proof runs on **ALL stocks** (Sharia + non-Sharia).
Sharia compliance (the Halal-stock filter) is applied **later as a toggle** on the live picks, NOT
inside the backtest. This deliberately removes the Sharia data leak (today's compliance list applied
to the past) from the test — the list never touches the math. Survivorship bias (the universe only
contains stocks that still exist today; delisted/dead names are missing) is **accepted** for the
concept proof per the user; it inflates absolute numbers but not the sizing *delta* this plan measures.

- **Already have:** monthly momentum holdings history (the existing screen output), Derayah cost
  model (0.11% RT = round-trip, i.e. buy + sell combined).
- **Need to assemble / confirm:**
  - Daily (or at least weekly) total-return prices for every name ever held, across the full
    backtest window — to compute realized volatility (how much a stock's price swings) and drawdown
    paths (how far the portfolio falls from its peak) between monthly rebalances.
  - Point-in-time liquidity + listing-age filter (already in the screen, already audited clean) so
    sizing is not computed on names that would not have passed at the time.
  - A realized-volatility estimator (e.g. trailing 20- or 60-day) per name and for the portfolio.

**Hygiene gate (relaxed for concept-proof):** Sharia leak removed (not filtered). Survivorship
accepted (concept-proof only — re-confirm before any live capital). Price/liquidity/listing-age
confirmed point-in-time by the 2026-06-21 audit ([[data-hygiene-audit]]). Remaining blocker: the
daily-return series must itself be backward-looking (no future bars in volatility/drawdown calc).

---

## Method

1. **Rebuild the baseline** exactly as the current live edge: equal-weight the monthly momentum
   picks, net of cost. Record CAGR, max drawdown, Sharpe, turnover. This is the number to beat.
2. **Split the timeline** into in-sample (tune) and out-of-sample (judge) — e.g. first 60% / last
   40%, plus a walk-forward variant (roll the train window forward, always test on unseen months).
   Lever parameters (vol target, conviction slope, brake threshold) are chosen **only on in-sample**.
3. **Add lever 1 (vol targeting)** on in-sample, pick the target volatility, then freeze it and
   measure on out-of-sample. Keep only if it clears the win bar OOS.
4. **Add lever 2 (conviction weighting)** on top of whatever survived, same freeze-then-test.
5. **Add lever 3 (drawdown brake)**, same.
6. **Cost honesty:** every rebalance, every brake on/off, every resize pays the 0.11% RT on the
   traded fraction. A brake that flickers and churns must show its cost.
7. **Robustness:** re-run with jittered parameters (±20%) and a couple of alternate vol windows.
   If the win evaporates under small parameter changes, it was overfit, not real.

---

## Out-of-sample (OOS) gate — must pass ALL

Reuse the existing promotion-gate spirit ([[shipped-state]] state machine):

- OOS CAGR **strictly above** baseline OOS CAGR, net of cost.
- OOS max drawdown **not worse** than baseline (ideally better).
- Improvement **stable across both OOS halves** (not one lucky stretch) — same direction in each.
- Holds under ±20% parameter jitter (no knife-edge tuning).
- Turnover increase does not eat the gain (net-of-cost is the only number that counts).

Only a lever that clears every line graduates to live sizing.

---

## Kill criteria (when to abandon a lever, fast)

- Lever raises CAGR in-sample but **not** out-of-sample → overfit → kill it.
- Win only appears at one exact parameter value, dies under jitter → kill.
- Drawdown brake improves drawdown but **lowers** net CAGR (brake sells the bottoms) → kill or
  redesign the trigger.
- Conviction weighting's gain is entirely from one or two names → it is luck/concentration → kill.
- Any input found to be non-point-in-time → halt the whole plan until hygiene fixed.

---

## Expected effort & deliverable

- Mostly reuses existing backtest plumbing + the screen output; the new work is the sizing layer
  and the daily-return data assembly.
- Deliverable: a backtest report — baseline vs each lever, in-sample and OOS, with the gate
  check per lever — and, for survivors, a sizing spec to fold into Scheme-D.
- This formalizes what Scheme-D already gestures at (vol-target sizing); the test tells us whether
  it actually compounds better OOS or is decoration.
