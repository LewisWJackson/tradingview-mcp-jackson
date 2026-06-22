# Edge Plan — Execution Results (Phases 0–2)

**Date:** 2026-06-22 · branch `feat/edge-plan-phase0`
Executed the independent-review plan (`2026-06-22-independent-review-edge-plan.md`) end-to-end. All money/strategy tests green (122 / 23).

## Headline
**Momentum survives the kill-test — it is a real, tradeable edge (deflated t ≈ 2.45).** Keep stock-picking. Sizing geometry is fully exhausted (nothing beats plain equal-weight). One genuine, orthogonal, *borderline* 2nd edge found (conditioned PEAD). Hold the **top-ranked ~6–10 combo names**, not 4-arbitrary.

## Phase 0 — Integrity
- **0a. Grader leaks FIXED** (`strategy_validation.mjs`, commit `c27361e`). Both confirmed real: it graded plain `mom6` (not the live combo) and applied today's Sharia set retroactively. Fixed → grades the leak-free combo on the full universe (Sharia = live filter only). **Removing the leaks RAISED the in-sample guillotine t from 2.71 → 3.23** (the Sharia snapshot was not propping it up; if anything the opposite). Lab now reports the honest number.
- **0b. THE KILL-TEST → PASS** (commit `45cfe34`, `docs/.../killtest-survivorship-multipletesting.md`).
  - Survivorship: 0/7 known delisted/merged TASI names are even priceable on Yahoo → analytical bound only (haircut 1–1.5%/yr; mergers value-neutral, failures illiquid/filtered) → post-survivorship t ≈ 2.9–3.0.
  - Multiple-testing: ~15 momentum specs tried, but ρ≈0.6–0.9 → effective independent tests Meff≈3–6 → Harvey-Liu deflated t ≈ 2.35–2.60.
  - **Combined verdict: deflated t ≈ 2.45 (range 2.2–2.6) > 2 → real.** Size as a t≈2.4 single anomaly, not a t≈3.2 fortress.

## Phase 1 — Capture the edge
- **1a. Breadth/concentration** (commit `ae90e3f`, `scripts/breadth_test.mjs`). The "4 names is the #1 leak" premise was **wrong (good news)**: taking the TOP-ranked names keeps t>2 at every count (top-10 t 3.97, top-8 3.35, top-6 2.81, top-4 3.10) and the combo rank adds return (top concentrations beat the quintile average). The real cost is **variance from WHICH names**: a *random* 4-slice averages +16%/yr excess but sd 6.2pp (p10 +8% / p90 +25%). **Rule: hold ~6–10 of the highest-combo names — not an arbitrary 4, not a random handful.**
- **1b. Drawdown-brake (200d-MA regime) → SHELVE** (commit `40e047b`). OOS maxDD cut only 1.3pp (need ≥5), gave back 3.2%/yr (need ≤2), Calmar worse. Defends down-years, costs more in up-years. With vol-target + Kelly already dead, **all sizing/exposure levers are now exhausted** → momentum runs plain equal-weight, monthly, no overlay (seasonality 2-weak-month sit-out remains the one kept risk overlay from prior work).

## Phase 2 — One pre-registered shot each
- **2a. Conditioned PEAD → PASS, borderline** (commits `25f1877`, `fa8c41f`). Q5 earnings-reaction ∩ momentum-aligned ∩ volume-confirmed, [+2,+22] drift. n=118, net excess +2.44%/event, guillotine **t 2.14 (>2)**, both seasons positive. **Correlation to momentum = −0.003 (n=39) → genuinely orthogonal.** BUT cost-fragile (t→1.96 at 0.30% RT) and front-loaded. Verdict: **add as a small, monitored 2nd sleeve (~10% of risk budget)**; retire if a refresh drops t<2 at live cost.
- **2b. Momentum × low-vol / inverse-vol → REJECT** (commit `a159e7f`). Return + t hold but maxDD cut only ~1pp (need ≥3). No keep.
- **2c. Block-deal re-test → NOT RUN (data-gated).** Needs a fresh headed-browser Argaam harvest to extend history ≥2 non-overlapping years; can't be done unattended. Stays EXPERIMENTAL until harvested.

## Net edge set after this work
1. **Momentum combo** (mom6 × 52-week-high rank-avg, liquid-half, ≥2y, top-quintile, monthly, equal-weight, Derayah 0.11%) — THE edge, deflated t≈2.45. Hold top-ranked ~6–10 names.
2. **Seasonality** — DD overlay (sit out 2 weak months), kept.
3. **Conditioned PEAD** — small orthogonal 2nd sleeve (~10%), borderline/cost-fragile, monitored.
- DEAD/rejected this round: low-vol & inverse-vol weighting, drawdown-brake (all sizing levers), flow/rebalance front-running (refuted earlier), raw PEAD, alt-data, small-cap sleeve.

## Recommended operating spec (for the live tool)
- **Core:** monthly, hold the **top 6–10 combo-ranked Sharia-compliant liquid ≥2y names, equal-weight**. No vol-target, no Kelly, no exposure brake.
- **Risk overlay:** seasonal 2-weak-month sit-out (kept).
- **Satellite (optional, ~10% risk budget):** conditioned-PEAD names (momentum-aligned, volume-confirmed earnings reactions), [+2,+22] hold; monitor the gate, retire if t<2 at live cost.
- **Honest expectation:** mid-teens %/yr net, maxDD ~−18–20%; clears the ~9%/9,000-SAR goal; 20–30% remains a good-year tail, not a plan (would need a *third* uncorrelated edge — none found yet).
- **Standing discipline:** every future signal is **pre-registered** (spec + kill-criterion declared before running) to stop multiple-testing inflation — this is now the rule, per the integrity-gate resourcing decision.

## Open / next
- Block-deal re-harvest (headed browser) — only remaining untested flow signal with positive shape.
- Wire the operating spec into the live Momentum/Goals tabs (currently the screen already ranks on the combo; the breadth rule "6–10 names" and the PEAD satellite are not yet surfaced in the UI).
- The kill-test was best-effort on survivorship (no priceable delisted data). An airtight version still needs a survivorship-free TASI source (none affordable exists) — accepted, bias bounded low.
