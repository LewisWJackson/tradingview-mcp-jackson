# Compounding Geometry — Results (2026-06-21)

All-stocks concept proof. Sharia not filtered (later toggle). Survivorship accepted →
absolute CAGR is inflated; the **delta between stacks** is the trustworthy signal.

Sample: 65 monthly rebalance periods, 2020-01 → 2026-05, COVID carved out. In-sample =
first ~32 periods (tune), out-of-sample (OOS) = last ~33 periods (judge, unseen).

## Raw output
```
STACK                      | IN-SAMPLE                    | OUT-OF-SAMPLE
--------------------------------------------------------------------------------------
Baseline (equal-weight)    | CAGR  16.2%  maxDD -17.3%    | CAGR   9.1%  maxDD -28.6%
+L1 vol-target             | CAGR  14.0%  maxDD -12.6%    | CAGR   6.9%  maxDD -28.0%
+L1 vol-target @0.18       | CAGR  14.9%  maxDD -14.7%    | CAGR   8.2%  maxDD -28.5%
+L1+L2 conviction          | CAGR  16.8%  maxDD -11.7%    | CAGR   8.0%  maxDD -29.4%
L3 brake ONLY (eq-wt)      | CAGR  10.2%  maxDD -17.3%    | CAGR  10.5%  maxDD -22.6%
+L1+L2+L3 brake (FULL)     | CAGR  16.8%  maxDD -11.7%    | CAGR   8.7%  maxDD -23.9%

OOS GATE (vs baseline, out-of-sample half — spec OR rule):
  +L1 vol-target           FAIL  (CAGR Δ -2.2% WORSE, maxDD Δ 0.7% flat)
  +L1 vol-target @0.18     FAIL  (CAGR Δ -0.9% flat, maxDD Δ 0.2% flat)
  +L1+L2 conviction        FAIL  (CAGR Δ -1.1% WORSE, maxDD Δ -0.7% flat)
  L3 brake ONLY (eq-wt)    PASS  (CAGR Δ 1.4% up, maxDD Δ 6.1% better)
  +L1+L2+L3 brake (FULL)   PASS  (CAGR Δ -0.4% flat, maxDD Δ 4.7% better)

ROBUSTNESS — full stack, ±20% param jitter (OOS CAGR should stay > baseline):
  jitter ×0.8: OOS CAGR 7.7%  (vs baseline 9.1%, Δ -1.4%)
  jitter ×1:   OOS CAGR 8.7%  (vs baseline 9.1%, Δ -0.4%)
  jitter ×1.2: OOS CAGR 9.9%  (vs baseline 9.1%, Δ 0.8%)
```

## Verdict per lever

- **L1 vol-target (volatility targeting): KILL (as a return tool).** OOS CAGR −2.2% with
  effectively no drawdown benefit. Kill criterion fired: *worsens the un-targeted axis*
  (cut return without cutting drawdown). Cause: momentum picks are inherently high-vol, so a
  15% vol budget keeps the book throttled below full exposure most of the time — it sells the
  edge. Recalibrating to 18% only halved the damage (still −0.9%, DD flat). A vol budget that
  preserves return is so high it stops being a budget. Not worth it here.

- **L2 conviction weighting: KILL.** OOS CAGR −1.1% and maxDD slightly *worse* (−0.7pt).
  Kill criterion fired: *no out-of-sample benefit*. Tilting toward the top-ranked momentum
  names did not help and mildly concentrated risk. The equal-weight basket is already the
  right call within the picks.

- **L3 drawdown brake: KEEP — conditionally.** The only lever that passes, and brake-ONLY
  (no vol-target, no conviction) is the best stack out-of-sample: CAGR +1.4pt AND maxDD
  +6.1pt shallower. BUT it is *not free*: in-sample it cost ~6pts of CAGR (16.2 → 10.2)
  because in a steadily rising market the brake cuts exposure right after a dip and misses
  the rebound (whipsaw). It won OOS because the OOS half was choppier and had the deep
  drawdowns it was built to dodge. **With a single in/out split, that is regime-dependent and
  could be luck.** Promising defensive tool, not a proven return-booster.

## Plain-English conclusion

**The headline claim did not hold.** The board ranked "compounding geometry" #1 as a
near-free way to grow the *same* picks faster (the idea that smarter bet-sizing roughly
doubles compounded growth). On TASI all-stocks data, **it did not.** Volatility targeting and
conviction weighting both *lost* money out-of-sample versus plain equal-weight. Smarter sizing
was not a free lunch here.

The one thing with a real signal is the **drawdown brake** — a simple circuit breaker that
halves how much is invested after the account falls >15% from its peak. Run on its own it both
made more money and suffered shallower crashes out-of-sample. The catch: it gives back return
in calm, rising markets (it pulls back after a dip, then the market bounces without it). Its
out-of-sample win came from the choppier second half, so it is regime-dependent — good
insurance, not a guaranteed return engine.

**What this means for the strategy:** keep the existing equal-weight momentum book as-is
(it was the strongest *return* engine in every test). Do **not** add vol-targeting or
conviction weighting — they failed the gate. Treat the drawdown brake as the one idea worth
carrying forward, as a *defensive* overlay, but only after it survives a harder test.

**The OOS gate did its job.** In-sample, every lever looked great (maxDD 17.3% → 11.7%). The
out-of-sample split killed three of them. This is exactly the red-team discipline working —
ambition in the hypothesis, ruthlessness in what we trust.

## WALK-FORWARD UPDATE (2026-06-21) — brake DOWNGRADED to "insurance, not edge"

Ran `scripts/compounding_geometry_walkforward.mjs`: 11 rolling 24-period windows + continuous
per-year attribution. It overturns the conditional-keep above.

```
(A) ROLLING WINDOWS — brake vs equal-weight
  CAGR:  brake wins 3/11 (27%), median Δ 0.0%
  maxDD: brake shallower 3/11 (27%), not-worse 11/11, median Δ 0.0%
  (brake COSTS CAGR -3.8%..-9.1% in trending windows 2020-24; HELPS +1.6%..+4.3% in
   choppy/down windows 2024-26. DD help only in deep-drawdown windows: -28.6%→-22.6%.)

(B) PER-YEAR (continuous path)
  2022 brake -4.5% (whipsaw) | 2023 brake -14.6% (whipsaw, +65.7% year) | 2024 flat
  2025 brake +6.4% (DEFENDED, -25.5% crash year) | 2026 brake -5.2% (whipsaw)
  FULL: CAGR base 12.5% → brake 10.3% (Δ -2.2%); maxDD -28.6% → -22.6% (Δ +6.1pt)
```

**Finding:** the brake earns its keep in exactly ONE year of seven — the 2025 crash. Every
other year it does nothing or costs return (worst: 2023, gave up 14.6pt of a +65.7% year by
pulling back after dips and missing the rebound). **The single-split "brake wins both axes"
result was cut-point luck** — that split put the brake's one good year (2025) in the OOS half
and its costly year (2023) in the IS half. Walk-forward averaged the luck out.

**Revised verdict — L3 drawdown brake: KILL as a return tool.** It is INSURANCE: pay ~2.2%/yr
CAGR to cut the worst crash −28%→−22% (DD help is real and never-worse across all 11 windows).
Not free money, not a return edge. Keep ONLY as an explicit risk-preference choice. **All three
sizing levers now killed; the momentum return engine stays plain equal-weight.**

## What to test next (if the brake is pursued)

1. **Walk-forward across multiple regimes** (deferred in this plan) — re-test the brake on
   rolling train/test windows, not one 50/50 split, to separate "real insurance" from "the
   OOS half happened to be choppy." This is the decisive test before any live use.
2. **Brake-cost accounting** — quantify the in-sample give-back (the whipsaw) as the premium
   paid for the insurance; decide if shallower crashes are worth it for *this* account.
3. **Then, and only then**, fold the brake into Scheme-D as a downgrade-only defensive lever
   under the existing state machine (guilty until proven across regimes).

Vol-target and conviction are shelved. The momentum edge's *return* engine stays equal-weight.
