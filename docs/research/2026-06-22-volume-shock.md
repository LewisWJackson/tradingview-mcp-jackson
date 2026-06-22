# Volume-Shock / Attention-Reversal — Pre-Registered Edge Test (TASI, Sharia)

**Date:** 2026-06-22
**Script:** `scripts/volume_shock_test.mjs` (`node --experimental-sqlite scripts/volume_shock_test.mjs`)
**Verdict: FAIL — volume-shock attention-reversal is DEAD.**

Kill-by-default. Decided strictly by the pre-committed gate below. No goalpost-moving.

---

## PRE-REGISTERED HYPOTHESIS (committed before results)

Retail-dominated TASI over-reacts to attention spikes; names with an extreme volume+price spike
mean-revert over the next 5-20 sessions. Trade the REVERSAL of a spike-DOWN (buy the washout),
long-only.

- **Event** = a day where daily volume > 3× trailing-60-session median volume **AND** |daily return|
  in the top decile of that name's returns. Tradeable cohort = **spike-DOWN** days (return negative on
  the spike) → expect positive forward drift (reversal). Also report **spike-UP** cohort forward drift
  (expect negative/none = untradeable chase).
- **Universe** = Sharia-compliant, liquid-half, ≥2y listed (match the live screen). Cost 0.11% RT
  (env `COST_RT` default 0.0011) + slippage 0.15%/side.
- **Horizons** = 5, 10, 20 sessions forward, abnormal vs ^TASI.SR (same calendar window). Primary
  horizon a priori = **10 sessions** (report all three).

## PRE-REGISTERED GATE (PASS requires ALL)

1. spike-DOWN reversal cohort: long-only **NET excess > 0** at the primary horizon (10 sessions).
2. `portfolioGuillotine` **per-period t > 2** on the non-overlapping per-period excess series (one
   obs per non-overlapping window), excess vs the basket.
3. **OOS:** positive in BOTH halves (2021-23 / 2024-26 by event date).
4. **cost-robust at 0.30% RT.**
5. **correlation check:** reversal cohort's monthly excess correlation with momentum-combo monthly
   excess must be **< 0.4** (else momentum in disguise → FAIL). Overlap with momentum top-quintile
   names also reported.

## KILL

Fail ANY → dead. If only the spike-UP/continuation leg is significant (untradeable noise) → FAIL.
Do NOT iterate the 3×/top-decile thresholds. Primary 3×/decile is the verdict; 4×/top-5% reported as
the single allowed robustness variant only.

---

## METHOD (point-in-time, no look-ahead)

- Universe build matches `momentum_sharia.mjs`: screener ∪ catalyst syms → Sharia `compliant` only →
  ≥2y price history → **liquid-half** (top 50% by median dollar-volume). Final = **77 names**.
- Trailing-60 median volume uses only **prior** bars `[i-60, i-1]`.
- Return-decile cutoff = quantile of the name's **prior** absolute daily returns (strictly before `i`).
- Forward abnormal return = name fwd return − ^TASI.SR fwd return over the **same calendar window**.
- Per-period series = events collapsed to **non-overlapping** windows of length H per name (greedy),
  bucketed by event month → one obs/month → fed to `portfolioGuillotine`.
- Cost charged per trade: primary 0.11% RT + 2×0.15% slip = **0.41%/trade**; buffer 0.30% RT +
  2×0.15% slip = **0.60%/trade**.

---

## RESULTS — PRIMARY spec (3× volume / top-decile return)

Spike-DOWN cohort raw events **n = 835**; non-overlap trades 628 across 93 months.

| Horizon | gross abn | net @0.41% | event-t |
|--------:|----------:|-----------:|--------:|
| 5  | +0.28% | −0.13% | 0.93 |
| 10 (primary) | +0.32% | −0.09% | 0.91 |
| 20 | +0.48% | +0.07% | 1.25 |

Spike-UP cohort (expected untradeable) raw events **n = 2335**:

| Horizon | gross abn | net @0.41% | event-t |
|--------:|----------:|-----------:|--------:|
| 5  | +0.63% | +0.22% | 4.31 |
| 10 | +0.73% | +0.32% | 3.86 |
| 20 | +1.09% | +0.68% | 4.34 |

### PASS/FAIL table — PRIMARY (3×/top-decile), spike-DOWN, H=10

| Gate criterion | Threshold | Result | Verdict |
|---|---|---|---|
| net excess @H10 > 0 | > 0 | per-period +0.46%/mo | PASS |
| guillotine per-period t | > 2 | **t = 0.63** | **FAIL** |
| OOS both halves positive | both > 0 | H1 +0.73% (64mo), H2 **−0.12%** (29mo) | **FAIL** |
| cost-robust @0.30% RT | mean > 0 | +0.27% (t 0.37) | PASS |
| momentum corr < 0.40 | < 0.40 | corr **0.15**, overlap 24.6% | PASS |

**Overall: FAIL** (fails the guillotine t-gate AND OOS).

---

## ROBUSTNESS variant (4× volume / top-5% return) — reported, NOT the verdict

Spike-DOWN raw events n = 350; non-overlap 291 across 76 months.

| Horizon | gross abn | net @0.41% | event-t |
|--------:|----------:|-----------:|--------:|
| 5  | +0.86% | +0.45% | 1.38 |
| 10 | +0.66% | +0.25% | 0.95 |
| 20 | +0.90% | +0.49% | 1.26 |

Gate: per-period +2.01%/mo, **guillotine t = 1.27 (FAIL)**, OOS both+ (H1 +1.91%, H2 +2.22%) PASS,
cost-robust @0.30% PASS, momentum corr 0.15 / overlap 25.1%. Higher point estimate but the guillotine
t is still **< 2** — the reversal does not clear the cross-clustering-robust bar.

---

## WHY DEAD (numeric)

- The reversal (spike-DOWN) drift is small and statistically flat: net @H10 is **negative** (−0.09%),
  event-t < 1 at every horizon, guillotine **t = 0.63 << 2**, and it **flips negative OOS** in the
  recent half (H2 −0.12%).
- The only significant leg is **spike-UP continuation** (event-t 3.86–4.34, robust at both specs and
  every horizon). Per the pre-registration this is the **untradeable chase** leg → explicitly a FAIL
  trigger, not a pivot. Attention spikes on TASI **continue**, they do not mean-revert.
- It is NOT momentum in disguise (corr 0.15, overlap ~25%) — but that only rules out one failure mode;
  the signal simply isn't there on the tradeable side.

**Conclusion:** Volume-shock attention-reversal FAILS the pre-registered gate (guillotine t and OOS).
Logged as DEAD. Net edge set unchanged = momentum combo (validated) + seasonality (DD overlay).
