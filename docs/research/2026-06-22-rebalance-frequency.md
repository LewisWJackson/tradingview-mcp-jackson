# Rebalance Frequency — Quarterly vs Monthly (pre-registered, kill-by-default)

**Date:** 2026-06-22 · **Branch:** `feat/alpha-exec` · **Script:** `scripts/rebalance_frequency_test.mjs`
**Run:** `node --experimental-sqlite scripts/rebalance_frequency_test.mjs`

## Question
Does QUARTERLY rebalancing beat MONTHLY for the validated Sharia TASI momentum combo? A prior
bonus arm (`exposure_arms_test.mjs`) hinted quarterly **+3.25%/yr at ~⅓ the cost**. Confirm or
refute it properly.

## Construction (stated for the record)
- **Combo (unchanged):** mom6-rank + 52wk-high-rank avg, liquid-half ∩ ≥2y listed, top-quintile,
  equal-weight, Derayah 0.11% RT, COVID carved out (2020-02-20 → 2021-03-31), point-in-time,
  ^TASI calendar. Same universe (172 names) as breadth/exposure-arms.
- **Per-cadence non-overlapping grid:** monthly steps every 21 sessions, quarterly every 63,
  semi-annual every 126. One excess observation per non-overlapping period → directly
  guillotine-able (the gate needs non-overlap to absorb cross-sectional clustering).
- **HOLD-THE-REST turnover (the key fix vs the prior bonus):** at each rebalance we re-rank, KEEP
  names still in the top set, and SWAP only the names that left. Cost is charged ONLY on the
  swapped fraction — not the full book. `turnoverFrac = boughtIn / basketSize`; first period pays
  full deploy (1.0). `netRet = grossPort − 0.11% × turnoverFrac`.
- **Excess** = net basket return − equal-weight universe return, one obs/period. Guillotine minT=2.

> The prior bonus re-ranked the whole book each cadence and charged FULL round-trip cost on the
> entire basket every rebalance — which over-penalised monthly and never put quarterly through the
> guillotine or both halves. That is the +3.25% artifact.

## Results

| cadence    | periods | gross CAGR | net CAGR | maxDD   | Calmar | turn/yr | cost drag | guillotine t | h1 t | h2 t | gate |
|------------|--------:|-----------:|---------:|--------:|-------:|--------:|----------:|-------------:|-----:|-----:|------|
| **MONTHLY**   | 62 | 10.80% | **10.27%** | -29.78% | 0.34 | 426% | 0.47% | **3.79** | 2.07 | 4.85 | PASS |
| **QUARTERLY** | 21 |  9.88% |  9.59%     | -25.99% | 0.37 | 229% | 0.25% |  2.93    | 1.57 | 3.26 | PASS |
| SEMI-ANN      | 10 | 17.60% | 17.41%     | -13.39% | 1.30 | 148% | 0.16% |  3.57    | 2.86 | 2.11 | FAIL* |

Both-halves net CAGR: MONTHLY h1 7.27% / h2 13.35% · QUARTERLY h1 8.55% / h2 10.55% · SEMI-ANN h1 20.35% / h2 14.54%

\* Semi-annual is context only (10 non-overlapping periods is underpowered; it FAILs the gate's
`minPeriods` guard despite t=3.57). Its high CAGR/Calmar is a small-sample, low-`n` artifact — not a
basis for any decision.

## Pre-registered pass bar — QUARTERLY (wins requires ALL)

| # | Criterion | Result | Detail |
|---|-----------|--------|--------|
| 1 | Q net CAGR ≥ M net CAGR        | **FAIL** | Q 9.59% vs M 10.27% (Δ **−0.68%/yr**) |
| 2 | Q Calmar ≥ M Calmar            | PASS | Q 0.37 vs M 0.34 |
| 3 | Q guillotine t > 2             | PASS | Q t 2.93 (gate PASS) |
| 4 | Q holds in BOTH halves         | PASS | h1 t 1.57 cagr 8.55% · h2 t 3.26 cagr 10.55% |
| — | trap watch: Q maxDD not worse  | PASS | Q −25.99% vs M −29.78% (Q is shallower) |

**Criterion 1 — the headline claim — FAILS.** Quarterly does NOT retain the gross excess: gross
CAGR drops from 10.80% → 9.88% (−0.92pp), and the cost saving (0.47% → 0.25% = +0.22pp) only
recovers a quarter of that. Net is **−0.68%/yr worse**, the opposite sign of the prior +3.25%.

Caveat on criterion 4: it passed as coded (h1/h2 t>0 and cagr>0), but quarterly's first-half
excess t is only **1.57 — below the gate's 2**. The edge weakens OOS in the early half. This
reinforces, not softens, the verdict.

## VERDICT — KEEP MONTHLY

Quarterly fails criterion 1 (and effectively criterion 4 on a strict gate reading). It is REFUTED.

The prior **+3.25%/yr "quarterly beats monthly" was a measurement artifact** of charging full
round-trip cost on the entire book every month. Once cost is charged only on real turnover
(hold-the-rest), monthly's higher gross momentum capture dominates the modest cost saving.

**Deltas (Q − M):** net CAGR **−0.68%** · Calmar +0.02 · turnover/yr −197pp · cost drag −0.22%/yr ·
maxDD +3.78pp (shallower).

What quarterly *does* buy — slightly higher Calmar (0.37 vs 0.34, via a shallower −26% vs −30% DD)
and far lower turnover — is real but small, and it costs 0.68%/yr of net CAGR plus a sub-2 first-half
edge t. Not worth switching the live cadence. **Live stays MONTHLY (~21 sessions).**
