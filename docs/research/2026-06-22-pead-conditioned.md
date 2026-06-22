# Conditioned PEAD — pre-registered single-shot re-test (2026-06-22)

**Status: PASS (borderline) — clears all four pre-registered criteria at the live Derayah 0.11% cost.**

## Context

Raw PEAD already FAILED the gate (quintile spread t 1.33, Q5 long-only net +0.22% t 1.92 < 2,
failed the season split — `scripts/pead_test.mjs`, `docs/research/2026-06-21-pead-results.md`).
This was the **single allowed re-test** with a HARD pre-committed kill. No condition-iteration
after this run.

## Pre-registered hypothesis (committed before looking at results)

Raw earnings-reaction drift is too noisy. Drift survives only in the top-reaction cohort (Q5 by
earnings-day abnormal reaction, measured on the **compliant tradeable universe**) when the name is
ALSO, point-in-time at the event date:

1. **momentum-aligned** — in the TOP HALF of the live combo momentum rank (6-1mo momentum +
   52wk-high proximity, percentile-averaged within the liquid half of compliant names), AND
2. **volume-confirmed** — reaction-day volume ABOVE its trailing-60-session median (prior to event).

Hold [+2,+22] sessions, abnormal vs equal-weight ^TASI basket, Derayah 0.11% RT + 0.15%/side slip.
All conditions use only data up to the event date (point-in-time; no look-ahead).

## Pre-registered kill-criterion

PASS requires ALL of: conditioned long-only net excess > 0 AND portfolioGuillotine per-period
(one non-overlapping observation per calendar month) t > 2 AND positive in BOTH date-split season
halves AND ≥ ~80–100 usable conditioned events (else underpowered = FAIL).

## Results

| Stage | n |
|---|---|
| Usable earnings events | 6,067 |
| Compliant tradeable universe | 3,071 |
| Q5 top-reaction (compliant) | 614 |
| **Conditioned (Q5 ∩ momentum-aligned ∩ volume-confirmed)** | **118** |

**Conditioned long-only drift:** gross +2.85% / **net +2.44%** per event (n=118).

**Guillotine** (per-month non-overlapping, net excess vs equal-weight ^TASI basket):
- periods (months): 39
- net excess/period: +2.25%
- **per-period t: 2.14** (> 2)
- gross excess/period: +2.66%
- verdict: PASS — cross-clustering-robust

**Both-season split** (by date, two halves; split at 2024-05-08 | 2024-05-12):
- early half: n=59, gross +4.43% / net +4.02%
- late half: n=59, gross +1.27% / net +0.86%
- both positive ✓ (but late half is materially weaker)

## Pre-registered gate scorecard

| Criterion | Threshold | Result | Verdict |
|---|---|---|---|
| Power | n ≥ 80 | 118 | PASS |
| Long-only net excess | > 0 | +2.44% | PASS |
| Guillotine per-period t | > 2 | 2.14 | PASS |
| Positive in both seasons | both > 0 | +4.43% / +1.27% | PASS |

**All four PASS → VERDICT: PASS.**

## Verdict (pre-committed)

Conditioned PEAD — Q5 top earnings-reaction names that are also momentum-aligned and
volume-confirmed — clears the pre-registered gate at the live Derayah 0.11% cost. It is a
**genuine low-correlation 2nd-edge candidate; recommend adding it** (long-only, [+2,+22] drift hold).

## Honesty / fragility notes (do NOT oversell)

This is a **borderline** pass, not a momentum-grade edge (momentum gate t 3.38):

- **Sits right on the gate.** Per-period t is 2.14 vs the 2.0 bar. Stress the cost to 0.30% RT and
  the per-period t drops to **1.96 — FAIL**. The pass is cost-fragile and survives only at the real
  0.11% Derayah cost. The kill-criterion is pre-registered on 0.11%, so it passes as written, but a
  thinner cost margin would flip it.
- **Front-loaded in time.** The early date half (+4.43%) carries most of the signal; the late half
  is +1.27% gross / +0.86% net — positive but weak. Both-seasons-positive is met, barely, on the
  late side.
- **Condition multiple-testing.** Two conditions were applied in one shot as pre-registered; no
  iteration was done. The kill rule forbids further condition tuning, and none was attempted.

**Recommendation:** add it as a small, secondary, monitored sleeve only — not equal-weight with
momentum. Re-run the gate periodically; if the per-period t falls below 2 on the live cost on a
future refresh, retire it. The core engine remains the momentum combo (the ONE validated edge).
PEAD survives, but on a thin margin.

## Correlation to momentum

A 2nd sleeve only earns its risk budget if its return stream is **low-correlation** to momentum —
otherwise it is just more momentum and adds no diversification. `scripts/pead_momentum_correlation.mjs`
rebuilds both per-period net-excess series with the same machinery the gates used and aligns them by
calendar month:

- **Series A — conditioned-PEAD monthly net-excess**: the exact `excessSeries` the guillotine consumed
  in `scripts/pead_conditioned_test.mjs` (one obs per calendar month, equal-weight conditioned events'
  net [+2,+22] drift vs equal-weight ^TASI). 118 events across **39 months** (2021-07 … 2026-05),
  mean +2.25% / month — matches the gate exactly.
- **Series B — momentum combo quintile monthly net-excess**: the full top-quintile baseline from
  `scripts/breadth_test.mjs` (== the live grade), per 20-session rebalance, mapped to the rebalance
  **start month** and averaged within-month. 64 months, mean +1.27% / month over the overlap.

### Result

| Metric | Value |
|---|---|
| Overlapping months | **39** (all PEAD months fall inside the momentum span 2021-07 … 2026-05) |
| Pearson r | **−0.003** |
| PEAD overlap mean excess (sd) | +2.25% (6.55%) |
| Momentum overlap mean excess (sd) | +1.27% (2.90%) |

**Interpretation:** GENUINELY DIVERSIFYING. |r| ≈ 0.00 is far below the 0.3 diversification
threshold — the conditioned-PEAD excess stream is effectively orthogonal to the momentum combo's. It
is **not** momentum in disguise; it is a distinct return source (an event-reaction drift, not a
cross-sectional trend rank), and n = 39 overlapping months is enough to trust the estimate (not
underpowered).

**Sizing recommendation:** a small, monitored 2nd sleeve of **≈10–20% of the risk budget** is
justified on the diversification grounds. This *reinforces* the borderline-gate caveats above rather
than overriding them: the edge passes the gate only on a thin cost margin (t 2.14, flips to FAIL at
0.30% RT) and is front-loaded in time, so keep the allocation at the **low end (~10%)**, monitored,
and retire it if a future gate refresh drops the per-period t below 2. Low correlation makes it a
*legitimate* second sleeve; it does not make it a strong one.

### Alignment caveat (honest)

The two series do not share an identical holding window. PEAD is event-driven — a month exists only
when a conditioned earnings event occurred, and its "return" is a [+2,+22]-session drift starting
mid-month. Momentum is a fixed 20-session rebalance whose window starts on the rebalance date. Both
are *abnormal-vs-equal-weight-basket monthly excess streams* — the correct object to correlate for
diversification — but the alignment is approximate-by-calendar-month, not trade-for-trade. With r
this close to zero the conclusion (uncorrelated) is robust to that approximation; a small nonzero
correlation would have warranted more caution.
