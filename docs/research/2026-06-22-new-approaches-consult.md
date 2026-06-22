# New Approaches — Independent Consult (round 2)

**Date:** 2026-06-22 · Independent "Deloitte" team reconvened to GENERATE new approaches (not re-judge old ones), bound by the standing pre-registration rule.
**Team:** cross-market/multi-asset · factor/quant · event/behavioral · red-team/integrity.

## Engagement-partner synthesis

The red team is right about the frame and the generators are right that a *few* genuinely new, uncorrelated, high-power ideas exist. Resolution: run a **small disciplined batch** (not a safari), gated hard, while the dominant effort stays operate-and-harden. The generators, when grounded in the actual DB + data paths, narrowed to a short list; most "exciting" ideas died on power or data.

**Honest ceiling (red team, unsoftened):** ~9%/9,000-SAR goal is comfortably reachable; **mid-teens %/yr is the realistic mean; 20–30% is good-year variance, not an engineered target.** The uncorrelated second engine that would lift the *mean* has been hunted ~30 times and not appeared. Promising 20–30% invites over-leverage. Accept mid-teens; treat more as fortune.

## What died on arrival (don't spend effort — grounded in real counts)
- **IPO drift / lock-up dip** — survivorship-fatal (listed-only, recent) + underpowered (<40 clean Sharia events) + no lock-up dates in DB.
- **FTSE / non-MSCI index reweights** — 0 rows harvested; MSCI add/delete already dead (t −1.18, run-up is pre-announcement).
- **Guidance drift** — only **4 events** in DB. Dead.
- **Quality / profitability / accruals** — needs point-in-time fundamentals; the data wall already killed value-by-fundamentals; quality needs *more* history. Not backtestable.
- **Meta-model / regularized signal-combiner** — the classic overfit machine; ~130 non-overlapping periods can't fit *and* validate a weight vector over 3 correlated signals. **Only legitimate "system" = a fixed-weight, no-fit stack of independently pre-registered rules** (momentum core + seasonality DD overlay + PEAD trigger if it passes). Not a learned model.
- **Pure TASI trend-following** — one index = one regime sample + contaminated (no survivorship-free TASI total-return series). The transferable trend logic belongs on crypto (clean data), not TASI.
- **GCC/MENA momentum** — NOT a new edge: global momentum is correlated, so 4 markets ≠ 4 independent tests; worse GCC survivorship; **untradeable on a Derayah Saudi retail account.** Value is only as t-stat *hardening* of the existing edge, and even that needs ticker-coverage confirmation first. De-prioritized.

## The disciplined batch — ranked (≤5 specs total for this arc)

### #1 — Volume-shock / attention reversal  ·  TEST FIRST (cheapest, highest power)
- **Thesis:** retail-dominated TASI → extreme volume+price spikes are attention-driven over-reactions that mean-revert over 5–20 sessions (Barber-Odean; stronger in retail markets). Trade the reversal of the washout, long-only.
- **Why it's worth it:** distinct mechanism from price-trend momentum (must verify corr < 0.4); **price-volume only — zero harvest, no Akamai, data already local**; thousands of events → by far the highest statistical power on the board.
- **Pre-registered gate:** event = daily volume > 3× 60-day median AND |ret| top-decile; equal-weight compliant basket; 5/10/20d; `portfolioGuillotine` per-period t > 2, excess vs equal-weight compliant basket, OOS split (2021–23 / 2024–26), cost-robust at 0.30%.
- **Kill:** reversal t < 2 after cost, OR only the continuation (chase) leg is significant, OR corr with momentum ≥ 0.4 (it's momentum in disguise).

### #2 — Crypto time-series momentum (BTC/ETH)  ·  different assets you already hold
- **Thesis:** long-when-above-trend / flat-when-below. TSMOM is the most-replicated standalone anomaly globally; crypto is its purest substrate; it's the regime/exit tool the drawdown-brake failed to be — but here it IS the signal, not a sizing bolt-on.
- **Why it's worth it:** **pristine survivorship-free data** (BTC-USD/ETH-USD native on Yahoo, reuses the existing fetch); governs money you **already deploy outside the Sharia mandate** (frame: "a rule for the crypto I already own", not a new Sharia sleeve); one parameter, borrow the literature's canonical lookback — no tuning.
- **Pre-registered gate:** close vs 200-day SMA, long/flat, 0.20%/switch, BTC+ETH pooled. PASS = net Sharpe ≥ 0.8 AND beats buy-&-hold Sharpe AND maxDD cut ≥ 30% AND holds in both sample halves.
- **Kill:** fails to beat buy-&-hold Sharpe, or works only 2017–21 and dies 2022+. **One lookback — no hunting for the one that passes.**
- **Caveat:** crypto Sharia status disputed → not a Derayah sleeve; scoped to crypto you already trade.

### #3 — Conditioned-PEAD cost-robustness hardening  ·  rescue the near-survivor (red-team's pick)
- **Thesis:** the validated 2nd sleeve passes at 0.11% but dies at 0.30% and is front-loaded. Deepen it (better entry timing / tighter liquidity filter / hold-window) to make it cost-robust — *deepening a near-survivor, not widening the search*. The only test with clearly positive EV per the red team.
- **Pre-registered gate (≤2–3 specs):** make conditioned-PEAD clear the guillotine t>2 AND stay positive at **0.30% RT** in both season halves.
- **Kill:** can't be made cost-robust within 2–3 pre-registered specs → PEAD thesis closes; keep it as the tiny ~10% sleeve only.

### Reserve — Buyback / treasury-purchase under-reaction (needs data first)
- Cleanest *positive, long-only* corporate signal (unlike dead dividend / negative debt-resignations). But only **92 events** now = block-deal-grade thin. **Harvest the saudiexchange JSON feed to >150 buyback events BEFORE testing**; then event-level guillotine. Until ≥150, do not run (avoids block-deal mistake 2.0).

## Standing discipline for this batch (adopted)
1. Pre-register hypothesis/universe/signal/holding/cost **and the spec count** in the repo before any backtest.
2. **Hard cap ≈5 new specs total** this arc (not per idea — the family is already deep).
3. Bar rises with N: **deflated-t ≥ 3** against the full ~35-trial count, not the single test.
4. Mandatory OOS on an untouched held-out period; `portfolioGuillotine` per-period gate (pooled NW-t ≠ the gate).
5. **Kill-by-default; no "experimental/borderline purgatory"** — that's how PEAD/block-deals lingered.

## Recommendation
Run the batch in order **#1 → #2 → #3**, each pre-registered + kill-by-default. #1 is an afternoon and either dies cheap or becomes a real, *uncorrelated* 2nd edge (the thing that actually moves the mean). Everything else above the line is dead — don't relitigate. And per the red team: the single biggest return lever is still **operating the existing momentum edge at high fidelity** (6–10 names, monthly discipline), not any new factor.
