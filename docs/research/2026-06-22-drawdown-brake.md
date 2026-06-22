# Drawdown-Brake — Walk-Forward / OOS Verdict (2026-06-22)

**Status: COMPLETE. Verdict: SHELVE.**

The last surviving sizing lever for the Sharia TASI momentum strategy. Vol-target and
Kelly/conviction sizing were already KILLED (no OOS uplift). A prior EQUITY-PEAK brake (cut
when own equity is >15% below its running peak) was walk-forwarded on 2026-06-21 and
downgraded to "insurance, not edge". This test takes the next, **different** pre-registered
rule to its decisive walk-forward and gives a ship/shelve call.

Script: `scripts/drawdown_brake_test.mjs` — `node --experimental-sqlite scripts/drawdown_brake_test.mjs`.

## Pre-registered rule (ONE fixed knob, no threshold-hunting)

- **Regime state = the equal-weight basket is BELOW its own 200-day moving average**
  (point-in-time: the MA uses only past closes). This is a *market-regime* brake, distinct
  from the prior *own-equity-peak* brake.
- Risk-OFF (below the 200d MA) → cut gross exposure to **50%**; risk-ON (at/above) → **100%**.
- The de-risked half goes to **cash (earns 0, Sharia-clean)**.
- Applied to the validated momentum combo top-quintile (mom6 percentile-rank + 52-week-high
  proximity rank, liquid-half ∩ ≥2y-listed TASI, equal-weight, 20-session rebalance), identical
  universe/signal to `scripts/breadth_test.mjs` and the live grade. Derayah **0.11% RT**, COVID
  carved out (2020-02-20 → 2021-03-31). Cost scales with deployed capital.
- The 200d MA is computed on a **daily** equal-weight basket price index (broad-market proxy =
  cross-sectional mean of all usable names' one-day returns, compounded) so a true 200-DAY MA is
  point-in-time available at every rebalance. **176 usable names; 65 monthly periods,
  2020-01 → 2026-05; 46% of rebalances were risk-off.**

The brake has essentially one knob (200 days), held FIXED → this is an **OOS robustness check**,
not tuning. All-stocks concept proof (Sharia not re-filtered, survivorship accepted) → trust the
DELTA between stacks, not the absolute CAGR.

## Pre-registered KEEP-criterion

SHIP only if, **out-of-sample**, the brake cuts maxDD by **≥5pp** without giving back more than
**~2%/yr** of return (i.e. Calmar improves OOS). Else SHELVE.

## Results — baseline vs braked × {CAGR, maxDD, Calmar}

| Segment | Stack | CAGR | maxDD | Calmar |
|---|---|---|---|---|
| In-sample (1st half) | baseline | 9.9% | −16.5% | 0.60 |
| In-sample (1st half) | braked | 10.1% | −14.9% | 0.68 |
| **Out-of-sample (2nd half)** | **baseline** | **12.7%** | **−19.5%** | **0.65** |
| **Out-of-sample (2nd half)** | **braked** | **9.6%** | **−18.2%** | **0.52** |
| Full sample | baseline | 11.3% | −19.5% | 0.58 |
| Full sample | braked | 9.8% | −18.2% | 0.54 |

### OOS criterion check

| Test | Result | Threshold | Pass? |
|---|---|---|---|
| OOS maxDD cut | **−1.3pp** | ≥ 5.0pp | **FAIL** |
| OOS CAGR giveback | **3.2pp** | ≤ 2.0pp | **FAIL** |
| OOS Calmar | **0.65 → 0.52** (worse) | improves | **FAIL** |

**All three fail. VERDICT: SHELVE.**

### (B) Rolling 24-period windows (step 4), 11 windows

- CAGR: brake held (Δ > −2pp) 7/11 (64%), median Δ −0.4%.
- maxDD: brake shallower 7/11 (64%), not-worse 10/11, median Δ +1.3pp.

The DD help is real but **small and inconsistent** (median only +1.3pp), never reaching the 5pp
bar except in a few deep-drawdown windows.

### (C) Per-year attribution (regime story)

| Year | base | brake | Δ | risk-off pds | verdict |
|---|---|---|---|---|---|
| 2020 | −8.9% | −8.9% | 0.0% | 0/2 | ~flat |
| 2021 | 6.3% | 3.6% | −2.6% | 1/9 | gave back |
| 2022 | 2.6% | 11.2% | **+8.7%** | 8/12 | **defended** |
| 2023 | 48.0% | 37.9% | **−10.1%** | 4/13 | gave back |
| 2024 | 21.5% | 16.7% | −4.9% | 2/12 | gave back |
| 2025 | −14.4% | −10.3% | **+4.1%** | 10/12 | **defended** |
| 2026 | 13.8% | 7.0% | −6.9% | 5/5 | gave back |

## Conclusion

The 200-day-MA regime brake **fails the pre-registered OOS criterion on all three axes**. It is
the same story the equity-peak brake told, from a different angle: a **regime-dependent
insurance policy, not a return edge**. It defends exactly the two down years it was built for
(2022 +8.7pp, 2025 +4.1pp) and **gives back materially more in trending up-years** (2023 −10.1pp,
2026 −6.9pp, 2024 −4.9pp). On net it pays ~1.5%/yr CAGR (full sample 11.3% → 9.8%) to shave maxDD
by only ~1.3pp (−19.5% → −18.2%) — a bad trade, and **Calmar gets worse, not better**, both OOS
(0.65 → 0.52) and full-sample (0.58 → 0.54).

The DD benefit is genuine in the worst windows but too small and too costly in return to clear
the bar. The 200d-MA whipsaw — re-risking just as a recovery starts, de-risking into the dip —
is what eats the up-years.

**Decision: SHELVE the drawdown-brake.** With vol-target and Kelly/conviction already killed,
**all sizing levers are now exhausted.** The momentum return engine stays plain equal-weight,
top-quintile, monthly rebalance — no exposure overlay. If a defensive overlay is ever wanted, it
must be chosen as an explicit, accepted risk-preference (pay return for shallower crashes), not
sold as a Calmar improvement — because on this data it is not one.

## Files

- `scripts/drawdown_brake_test.mjs` — the walk-forward test (new; reuses breadth_test universe/combo).
- Prior related: `docs/research/2026-06-21-compounding-geometry-results.md` (equity-peak brake +
  vol-target + conviction, all killed); `dashboard/compounding_geometry.mjs` (equity-peak
  `drawdownBrake` helper — left unused by the live path).
