# Conditioned-PEAD cost-hardening — pre-registered, kill-by-default (2026-06-22)

**Verdict: FAIL.** No refinement clears the gate at 0.30% RT with n≥80 in both season
halves. Conditioned-PEAD cost-hardening FAILS. Keep it ONLY as the tiny ~10% sleeve at
0.11% RT; do **not** promote to a 2nd sleeve; **PEAD hardening thread CLOSED — no further
iteration.**

Test: `scripts/pead_hardening_test.mjs` (reuses event/reaction/combo/vol machinery copied
verbatim from `scripts/pead_conditioned_test.mjs`; no existing module modified). Point-in-time.

## Pre-registered hypothesis (verbatim)

The conditioned-PEAD edge (Q5 earnings-reaction ∩ momentum-aligned ∩ volume-confirmed,
[+2,+22] drift) is real but cost-fragile. A tighter entry/liquidity/hold refinement can make
it survive realistic cost. Test ≤3 pre-registered refinements:

1. **Liquidity filter:** restrict to the liquid-HALF of the conditioned cohort (by
   trailing-60d traded value at the event) — fewer, cheaper-to-trade names.
2. **Stronger reaction cut:** require reaction in the top-DECILE (not just top-quintile/Q5)
   — concentrate on the highest-surprise names.
3. **Longer hold:** [+2,+42] instead of [+2,+22] — let the drift run to dilute per-trade
   cost (only if the drift is monotone-ish; check it isn't giving the gains back like
   block-deals did past 20d).

## Pre-registered gate (verbatim) — PASS requires ALL

- conditioned cohort net excess > 0 AND `portfolioGuillotine` per-period t > 2 **at 0.30% RT
  cost** (the cost level it currently fails — this is the bar).
- positive in BOTH season halves.
- n ≥ 80 (power floor — do not lower; if a refinement cuts n below 80 it FAILS on power).

## Results

Base conditioned cohort reproduced: **n=113** (Q5=572 from 2861 compliant events; the
original test's n=118 was an earlier data snapshot — same deterministic machinery). Slip
0.15%/side. Drift = abnormal vs equal-weight ^TASI; guillotine = one non-overlapping obs per
calendar month.

### Baseline (unrefined, [+2,+22]) — reproduces the known finding
| cost | n | net/event | guillotine t | both-halves | gate |
|---|---|---|---|---|---|
| 0.11% | 113 | 2.37% | **2.05** | Y (early 4.79% / late 0.80%) | PASS |
| 0.30% | 113 | 2.18% | **1.87** | Y | FAIL (t≤2) |

Confirms the premise: passes at 0.11%, fails at 0.30% (t→1.87), front-loaded (early ≫ late).

### Refinements
| refinement | cost | n | net excess | guillotine t @0.11% | guillotine t @0.30% | both-halves | PASS/FAIL @0.30% |
|---|---|---|---|---|---|---|---|
| R1 liquidity-half | 0.11/0.30% | **57** | 1.58% / 1.39% | 0.83 | **0.74** | **N** (early 4.31% / late −0.25%) | **FAIL** (n<80, t≤2, halves) |
| R2 top-decile reaction | 0.11/0.30% | **57** | 2.71% / 2.52% | 1.54 | **1.41** | **N** (early 6.74% / late −0.37%) | **FAIL** (n<80, t≤2, halves) |
| R3 longer-hold [+2,+42] | 0.11/0.30% | 113 | 2.99% / 2.80% | 2.03 | **1.91** | Y (early 3.48% / late 3.31%) | **FAIL** (t≤2) |

### Why each fails
- **R1 (liquidity-half):** halves n to 57 (fails the n≥80 power floor outright), and
  concentrating on the most-liquid names *weakens* the signal — t collapses to 0.74 and the
  late season goes negative (−0.25%). The drift does not live in the liquid tail.
- **R2 (top-decile):** also n=57 (fails power floor), highest net/event (2.52%) but the
  monthly series is lumpy → t only 1.41, and late season negative (−0.37%). More surprise,
  more concentration, not more robustness.
- **R3 (longer hold):** closest. The [+22,+42] tail is **+0.65% gross** (drift continues, not
  given back — unlike block-deals), so extending the hold genuinely adds return and *fixes the
  front-loading* (early 3.48% / late 3.31%, balanced). n stays 113. But spreading the same
  monthly clustering over a longer window does not raise the per-period t enough: **1.91 at
  0.30%** — still under the 2.0 bar. A near-miss, but the pre-registered gate is t>2 and a
  fail is a fail.

## Decision

The hypothesis ("a tighter refinement can make it survive realistic cost") is **refuted**.
- The two *tightening* refinements (R1, R2) both fail the n≥80 power floor and degrade the
  signal — concentrating the cohort does not help.
- The one *helping* refinement (R3, longer hold) repairs the front-loading and adds the tail
  drift but lands at t=1.91 @0.30%, short of the bar.

Conditioned-PEAD does not survive realistic 0.30% RT cost under any pre-registered refinement.

**Action:** keep conditioned-PEAD ONLY as the existing tiny ~10% sleeve at 0.11% RT (where it
holds, t 2.05). Do NOT promote it to a real 2nd sleeve. Momentum combo remains the one
gate-passing edge. **PEAD hardening thread is CLOSED — no further iteration.**
