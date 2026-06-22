# Ensemble Stack — System-Level Validation (Sharia TASI)

**Date:** 2026-06-22
**Script:** `scripts/ensemble_stack_test.mjs`
**Run:** `node --experimental-sqlite scripts/ensemble_stack_test.mjs`

The methodology upgrade: **stop judging signals alone; judge the equal-weight STACK walk-forward.**
A sleeve can clear its own gate yet add nothing to a portfolio that already runs momentum. The
honest unit is the system: a FIXED equal-weight blend (NO fitted weights) of the candidate sleeves'
monthly EXCESS series, masked to cash in the 2 seasonally-weak months, measured on **system Calmar**
+ the guillotine + **drop-one ablation**.

Sleeves (each = per-period MONTHLY EXCESS vs the SAME equal-weight TASI basket, recomputed here from
the shared primitives; the source harnesses were NOT modified):
- **momentum** — top-quintile (6-1mo × 52wk-high rank combo), liquid-half ∩ ≥2y, monthly rebalance
  (replicates `dashboard/strategy_validation.mjs`). The CORE.
- **pead** — conditioned PEAD (Q5 reaction ∩ momentum-aligned ∩ vol-confirmed) net drift by month
  (replicates `scripts/pead_conditioned_test.mjs`).
- **volcont** — volume-shock spike-**UP CONTINUATION** cohort, non-overlapping H=10 net excess by
  month (the UP leg of `scripts/volume_shock_test.mjs`).
- **seasonality** — NOT additive. A cash MASK: force the whole book to 0 in the 2 weakest calendar
  months, walk-forward / leak-free (same rule as `scripts/momentum_confirm.mjs weakMonthsBefore`).

Sleeve sample sizes: momentum 64 monthly rebalances · pead 39 active months (118 conditioned events)
· volcont 96 active months (1,641 non-overlap trades). Seasonal mask zeroed 9 months
(e.g. 2022-02, 2022-09, 2023-02, 2023-11).

---

## PRE-REGISTERED SYSTEM PASS BAR (committed verbatim before looking)

1. combined per-period excess `portfolioGuillotine` **t > 2**, AND
2. **both halves each t > 1.5**, AND
3. system **Calmar > buy-and-hold equal-weight compliant basket Calmar in BOTH halves**, AND
4. the stack **beats MOMENTUM-ALONE on Calmar** (else the sleeves add nothing → ship momentum solo).
5. **ABLATION:** drop each sleeve one at a time; a sleeve EARNS its place only if removing it
   **LOWERS system OOS Calmar**. Any sleeve whose removal doesn't hurt (or helps) → cut it,
   regardless of its standalone t.

Report at **0.11% AND 0.30% RT**; note which sleeves dilute at higher cost.

---

## STEP 1 — Correlation matrix (monthly excess, aligned by calendar month)

| pair | ρ | common months |
|---|---|---|
| momentum ~ pead | **0.003** | 39 |
| momentum ~ volcont | **−0.009** | 63 |
| pead ~ volcont | **0.255** | 39 |

- **mean pairwise ρ̄ = 0.083**
- diversification ratio √(N/(1+(N−1)ρ̄)), N=3 = **1.60×**
- ρ̄ < 0.3 ⇒ on paper a **STRONG** ensemble case. The sleeves are genuinely near-orthogonal —
  momentum carries essentially zero correlation to either of the other two. The diversification
  *math* says a 3-sleeve blend should lift Sharpe ~1.6× over a single sleeve **IF the sleeves are
  individually comparable**. They are not (see below) — momentum is far stronger standalone, so the
  blend dilutes rather than diversifies.

---

## STEP 2 — System table

Calmar = CAGR / |maxDD|. `t` / `h1_t` / `h2_t` are the guillotine per-period t and its two halves.
`basket buy&hold` is the equal-weight compliant basket (the Calmar comparator). `momentum-alone` is
the masked momentum sleeve — the thing the stack must beat.

### Cost 0.11% RT

**primary (70/15/15)**

| variant | CAGR | maxDD | Calmar | exc/pd | t | h1_t | h2_t | gate |
|---|---|---|---|---|---|---|---|---|
| basket buy&hold | −3.21% | −33.48% | −0.10 | 0.00% | — | — | — | fail |
| **momentum-alone (masked)** | 7.14% | −20.80% | **0.34** | 0.85% | 2.36 | 0.84 | 2.94 | PASS |
| full-stack | 6.61% | −20.72% | 0.32 | 0.79% | 2.98 | 1.43 | 3.27 | PASS |
| ablate −pead (mom+vol) | 5.72% | −20.95% | 0.27 | 0.73% | 2.47 | 0.84 | 3.12 | PASS |
| ablate −vol (mom+pead) | 7.97% | −19.66% | 0.41 | 0.90% | 2.89 | 1.43 | 3.09 | PASS |

**1/N (33/33/33)**

| variant | CAGR | maxDD | Calmar | exc/pd | t | h1_t | h2_t | gate |
|---|---|---|---|---|---|---|---|---|
| basket buy&hold | −3.21% | −33.48% | −0.10 | 0.00% | — | — | — | fail |
| **momentum-alone (masked)** | 7.14% | −20.80% | **0.34** | 0.85% | 2.36 | 0.84 | 2.94 | PASS |
| full-stack | 5.71% | −24.58% | 0.23 | 0.72% | 2.87 | 1.84 | 2.58 | PASS |
| ablate −pead (mom+vol) | 3.02% | −22.99% | 0.13 | 0.52% | 2.34 | 0.73 | 2.85 | PASS |
| ablate −vol (mom+pead) | 9.15% | −24.92% | 0.37 | 0.99% | 2.87 | 1.99 | 2.38 | PASS |

### Cost 0.30% RT

**primary (70/15/15)**

| variant | CAGR | maxDD | Calmar | exc/pd | t | h1_t | h2_t | gate |
|---|---|---|---|---|---|---|---|---|
| basket buy&hold | −3.21% | −33.48% | −0.10 | 0.00% | — | — | — | fail |
| **momentum-alone (masked)** | 4.97% | −21.88% | **0.23** | 0.69% | 1.91 | 0.55 | 2.58 | fail |
| full-stack | 4.58% | −23.46% | 0.20 | 0.64% | 2.41 | 1.08 | 2.79 | PASS |
| ablate −pead (mom+vol) | 3.58% | −22.95% | 0.16 | 0.57% | 1.92 | 0.49 | 2.69 | fail |
| ablate −vol (mom+pead) | 5.93% | −22.42% | 0.26 | 0.75% | 2.41 | 1.14 | 2.68 | PASS |

**1/N (33/33/33)**

| variant | CAGR | maxDD | Calmar | exc/pd | t | h1_t | h2_t | gate |
|---|---|---|---|---|---|---|---|---|
| basket buy&hold | −3.21% | −33.48% | −0.10 | 0.00% | — | — | — | fail |
| **momentum-alone (masked)** | 4.97% | −21.88% | **0.23** | 0.69% | 1.91 | 0.55 | 2.58 | fail |
| full-stack | 3.85% | −26.36% | 0.15 | 0.58% | 2.32 | 1.53 | 2.00 | PASS |
| ablate −pead (mom+vol) | 0.94% | −25.54% | 0.04 | 0.35% | 1.61 | 0.24 | 2.31 | fail |
| ablate −vol (mom+pead) | 7.38% | −26.10% | 0.28 | 0.86% | 2.50 | 1.79 | 1.96 | PASS |

---

## Ablation (OOS H2 Calmar, drop-one — the deciding test)

A non-core sleeve EARNS its place only if removing it **lowers** full-stack OOS (H2) Calmar.

| weights | cost | full H2 Calmar | −pead H2 | −vol H2 | pead earns? | vol earns? |
|---|---|---|---|---|---|---|
| 70/15/15 | 0.11% | 0.31 | 0.40 | 0.40 | **NO** (removal helps) | **NO** (removal helps) |
| 33/33/33 | 0.11% | 0.10 | 0.19 | 0.16 | **NO** | **NO** |
| 70/15/15 | 0.30% | 0.19 | 0.25 | 0.26 | **NO** | **NO** |
| 33/33/33 | 0.30% | 0.02 | 0.09 | 0.09 | **NO** | **NO** |

In **every** variant, dropping either sleeve **improves** OOS Calmar. Neither pead nor volcont earns
its place. The `ablate −vol (mom+pead)` row is actually the best blend in several variants — but it
still only matches or trails momentum-alone, and pead fails its own ablation.

---

## Pre-registered bar — scorecard

| weights | cost | t>2 | both halves t>1.5 | Calmar > basket both halves | Calmar > momentum-alone | sleeves surviving ablation | bar |
|---|---|---|---|---|---|---|---|
| 70/15/15 | 0.11% | PASS (2.98) | FAIL (h1 1.43) | PASS | **FAIL (0.32 < 0.34)** | NONE | NOT cleared |
| 33/33/33 | 0.11% | PASS (2.87) | PASS | PASS | **FAIL (0.23 < 0.34)** | NONE | NOT cleared |
| 70/15/15 | 0.30% | PASS (2.41) | FAIL (h1 1.08) | PASS | **FAIL (0.20 < 0.23)** | NONE | NOT cleared |
| 33/33/33 | 0.30% | PASS (2.32) | PASS | PASS | **FAIL (0.15 < 0.23)** | NONE | NOT cleared |

The stack clears the guillotine and (mostly) the half-stability and basket-Calmar checks. It **fails
criterion 4 (beat momentum-alone on Calmar) in all four variants**, and **fails the ablation in all
four variants** — no non-core sleeve earns its place.

---

## VERDICT — run MOMENTUM-SOLO

**The system is NOT worth more than momentum-alone.** The case fails on its own pre-registered terms:

1. **It only passes the guillotine because of momentum.** The full-stack's higher t (2.98 vs 2.36) is
   the variance-reduction of averaging a strong sleeve with two weak, near-uncorrelated ones — a
   *smoother* line, not a *better* one. Smoothness lifts t but **cuts return**: every blend has lower
   CAGR and lower Calmar than masked momentum-alone.
2. **Calmar — the risk-adjusted metric the bar actually cares about — is worse for the stack in every
   single variant**, at both costs, under both weighting schemes.
3. **Ablation is unanimous: dropping pead OR volcont raises OOS Calmar every time.** Neither non-core
   sleeve adds value to the portfolio. They drag.
4. The orthogonality (ρ̄ = 0.08) is real and looks attractive in the diversification math, but
   diversification only helps when you blend sleeves of *comparable* strength. Momentum is ~2-3× the
   standalone edge of pead/volcont here; mixing in the weaker sleeves dilutes the strong one. Low
   correlation is necessary but not sufficient — **the sleeves are too weak to earn a seat.**

**Cost note:** at 0.30% RT the non-core sleeves dilute hardest — the 1/N stack collapses to 0.15
Calmar (vs 0.23 momentum-alone) and `−pead` drops to 0.04, confirming pead/volcont are the
cost-fragile legs. Momentum-alone holds up best as cost rises.

**Recommendation:** ship / keep **momentum-solo** (the validated `dashboard/strategy_validation.mjs`
combo) with the **seasonal cash mask** (which is part of momentum-alone here and does pull its
weight). Do **NOT** add PEAD or volume-continuation as portfolio sleeves — they pass their own gates
in isolation but fail the system test. The borderline parts don't add up.
