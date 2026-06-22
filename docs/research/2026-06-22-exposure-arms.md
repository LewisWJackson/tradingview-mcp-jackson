# Exposure Arms — does the live Scheme-D overlay leak return? (2026-06-22)

Pre-registered 3-arm test. Suspicion (from `2026-06-21-compounding-geometry-results.md` +
`2026-06-22-drawdown-brake.md`): vol-target sizing was KILLED and the live `schemeDExposure`
still applies vol-target × seasonal-hard-zero, so the live book may be throttled below full
exposure most months — leaking return vs the research-endorsed PLAIN equal-weight engine.

**Verdict: REFUTED. Do NOT strip the overlay. The leak is NEGATIVE.** On the same 65-period
sample, the live overlay (arm B) ADDED ~+1.1%/yr CAGR over plain (arm A) and cut maxDD from
−19.5% to −15.6% (Calmar 0.58 → 0.80). Robust across every vol-lookback (20/40/60/90d). The
A−B "recoverable leak" is **−1.09%/yr** (i.e. stripping would COST ~1%/yr, not recover it).

Script: `scripts/exposure_arms_test.mjs` · `node --experimental-sqlite scripts/exposure_arms_test.mjs`

## Method (mirrors strategy_validation.mjs / breadth_test.mjs line-for-line)
- Universe: 176 usable TASI names (liquid-half ∩ ≥2y-listed, point-in-time).
- Picks: top-quintile of the LIVE combo (mom6-rank + 52wk-high-rank avg), equal-weight,
  monthly (H=20), Derayah 0.11% RT, COVID carved out, 65 non-overlapping rebalances.
- SAME basket each rebalance; the three arms only change exposure `e`:
  - **A PLAIN** — `e = 1`.
  - **B LIVE** — `e = min(1, 0.15/realizedVol) × (inSeason?1:0) × stateMult`, faithfully
    replicating `schemeDExposure`. `realizedVol` = annualized vol of the held basket's
    trailing 60d daily returns (mirrors momentum_screen `portDaily`, point-in-time).
    `inSeason` = current month not in the 2 weakest calendar months, weakest computed on an
    EXPANDING window up to each rebalance (point-in-time).
  - **C STATE-ONLY** — `e = stateMult` (drop vol-target + seasonal-zero, keep only governor).
- De-invested fraction (1−e) → cash @0. Cost scales with deployed fraction: `e×(gross−cost)`.
- Excess = arm return − equal-weight basket; per-period guillotine t on that series.
- Live diagnostics: in-season **82%** of periods · vol-throttled (eB<1) **71%** · avg live
  exposure (sm=1) **73%**. So yes, the live book IS throttled below full most months — but
  that throttling helped, not hurt, on this sample.

## The 3-arm table (full sample + both halves)

### stateMult = 1.0 (isolates vol-target+seasonal from the governor)
| arm | CAGR | maxDD | Calmar | t | excess/pd | h1 t | h2 t | gate |
|---|---|---|---|---|---|---|---|---|
| **A PLAIN** | 11.34% | −19.50% | 0.58 | 3.23 | 1.25% | 1.58 | 3.56 | PASS |
| **B LIVE** | **12.43%** | **−15.57%** | **0.80** | 2.98 | 1.29% | 1.40 | 2.98 | PASS |
| **C STATE-ONLY** | 11.34% | −19.50% | 0.58 | 3.23 | 1.25% | 1.58 | 3.56 | PASS |

C ≡ A at sm=1 (governor neutral) — sanity check passes. B beats A on CAGR, maxDD, Calmar.

### stateMult = 0.5 (decaying governor)
| arm | CAGR | maxDD | Calmar | t | excess/pd | h1 t | h2 t | gate |
|---|---|---|---|---|---|---|---|---|
| A PLAIN | 11.34% | −19.50% | 0.58 | 3.23 | 1.25% | 1.58 | 3.56 | PASS |
| B LIVE | 6.50% | −7.77% | 0.84 | 1.83 | 0.75% | 0.90 | 1.68 | FAIL |
| C STATE-ONLY | 6.13% | −10.01% | 0.61 | 2.15 | 0.74% | 1.13 | 1.95 | PASS |

At sm=0.5 the governor halves everything; B's t drops below the gate (1.83) — but that's the
governor cutting exposure, not the vol/seasonal overlay. A stays unaffected (governor not in A).

## A − B recoverable leak (the headline)
**A − B = −1.09%/yr** at sm=1. Negative → the overlay is NOT a leak; it ADDS return here.
Ordering test `A ≥ C > B`: **NO** (A=11.34%, C=11.34%, B=12.43% — B is highest). The
pre-registered "confirmed leak" condition did not fire.

**Robustness — vol lookback sweep (every window says the same):**
| lookback | A CAGR | B CAGR | A−B leak | B maxDD | B t |
|---|---|---|---|---|---|
| 20d | 11.34% | 13.39% | −2.05% | −13.3% | 3.15 |
| 40d | 11.34% | 14.55% | −3.21% | −14.2% | 3.28 |
| 60d | 11.34% | 12.43% | −1.09% | −15.6% | 2.98 |
| 90d | 11.34% | 12.36% | −1.03% | −15.3% | 3.00 |

B beats A on CAGR AND maxDD at every lookback. The overlay's value is robust, not a
single-window artifact.

## Reconciling with the prior "vol-target KILL" (2026-06-21)
The two studies disagree, and the disagreement is methodological, not a bug:
- Prior research measured **vol-target ALONE vs a full-exposure baseline, on the OOS half
  only** → −2.2% OOS CAGR, DD flat → KILL. There, throttling a high-vol momentum book below
  full exposure only sells the edge.
- This study measures **vol-target BUNDLED with the seasonal sit-out, on the full 65-period
  sample**. The seasonal sit-out (cash in the 2 weakest months) is the part that carries its
  weight — it dodges drawdown periods, and combined with mild vol-throttling, B's maxDD
  improves a lot (−19.5%→−15.6%) while CAGR edges up.
- The tension is honest and worth flagging: B's **OOS-half** evidence is weaker than A
  (h2 t 2.98 vs 3.56), consistent with the prior OOS-half finding that vol-target alone hurt.
  The full-sample CAGR win for B is real but partly carried by the seasonal overlay (already
  separately DD-validated) more than the vol-target. **This does not justify ADDING vol-target
  anywhere it isn't — it justifies NOT ripping out the existing bundled overlay**, which is the
  actual question asked.

## BONUS — rebalance frequency on arm A (plain)
| freq | periods | CAGR | maxDD | Calmar | avgTurnover | reb/yr | annCostDrag |
|---|---|---|---|---|---|---|---|
| monthly (20) | 65 | 11.34% | −19.50% | 0.58 | 35% | 12.6 | 0.49% |
| quarterly (60) | 20 | **14.59%** | −19.22% | **0.76** | 56% | 4.2 | **0.26%** |

Quarterly does NOT just retain the return at lower cost — it **beats** monthly by +3.25%/yr
CAGR at roughly HALF the annual cost drag (0.26% vs 0.49%) and a better Calmar (0.76 vs 0.58).
Per-rebalance turnover is higher (56% vs 35%, names drift more over 3 months) but there are
3× fewer rebalances, so net cost drag falls. This is a separate, cheap, genuine improvement —
worth a dedicated test before acting, but the signal is strong.

## Decisions
- **Strip vol-target + seasonal-zero from `schemeDExposure`: NO.** The overlay adds
  +1.0 to +3.2%/yr CAGR and cuts maxDD ~4pp across all vol-lookbacks; stripping would cost
  ~1%/yr. The suspected live leak does not exist on this sample. *Caveat:* the CAGR win is
  partly the seasonal sit-out (already DD-validated), and B's OOS-half t is softer than A's,
  so the vol-target component specifically remains unproven as a standalone return tool —
  consistent with prior research. Keep the bundle; do not add vol-target elsewhere.
- **Rebalance frequency:** monthly → quarterly is a candidate upside (+3.25%/yr, −half cost).
  Not actioned here (out of scope) — flagged for a dedicated frequency test.

No money-path module was edited. Research only.
