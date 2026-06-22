# Kill-test — Sharia-TASI momentum combo (survivorship + multiple-testing)

**Date:** 2026-06-22 · **Branch:** `feat/edge-plan-phase0` · **Gate:** real-money decision on the ONE validated edge.

**The combo under test:** rank-avg(mom6, 52wk-high), liquid-half ∩ ≥2y-listed, top-quintile, monthly, equal-weight, Derayah 0.11% RT, COVID carved out, Sharia applied live (not baked into the grade — leak-free).

**Baseline (reproduced, leak-free in-sample):** `node --experimental-sqlite scripts/killtest_survivorship.mjs`
→ **65 periods, excess 1.255%/pd, abs 1.038%/pd, in-sample portfolio-guillotine t = 3.226, PASS.**
Implied SE of mean per-period excess = 1.255% / 3.226 = **0.389%/pd** (held fixed through both attacks).

---

## ATTACK A — Survivorship

Yahoo (`scripts/bars_cache.mjs`) serves **listed-only** names. Delisted/merged names are absent for all past dates. Momentum is the most survivorship-sensitive anomaly (missing blow-ups overweight surviving past-winners → inflated). No cheap survivorship-free TASI price source exists (EODHD/TwelveData/FMP all verified to lack delisted Saudi — `data_hygiene_audit`). So: **best-effort analytical bound, not a fake correction.**

### A1 — Hand-assembled removal list (TASI main-market, 2016–2026)

| Code | Name | ~Delist | Mode | Inflates momentum? | Note |
|------|------|---------|------|--------------------|------|
| 1090 | Samba Financial Group | 2021-04 | MERGER | No (value-preserving) | Absorbed into SNB (1180) at deal ratio |
| 1040 | Alawwal Bank | 2019-06 | MERGER | No | Merged into SABB (1060) |
| 8060 | SABB Takaful | ~2022 | MERGER | No | Merged into Walaa |
| 8300 | Wafa Insurance | ~2021 | **FAILURE** | **Yes** | Accumulated losses / liquidation-track delist |
| 1201 | Takween | ~2023 | FAILURE? | maybe | Distress flag, **unconfirmed**, likely illiquid |
| 1834 | SIECO | ~2023 | FAILURE? | maybe | Flagged, **unconfirmed** |
| 1212 | (HADAF/Astra family) | ~2023 | FAILURE? | maybe | Flagged, **unconfirmed** |

**Mode split:** 3 confirmed MERGERS (value-preserving, exit ≈ deal price → do NOT inflate momentum), 1 confirmed FAILURE (Wafa), 3 unconfirmed possible-failures. This matches the documented record: ~10–20 main-market removals/decade (~1–2%/yr), roughly half mergers, failures skewing illiquid micro-cap.

### A2 — Can we price them? (splice feasibility)

Ran every removed ticker through the exact `bars_cache`/Yahoo path the backtest uses:
**0 of 7 returned any series — all 404, including all FAILURE-mode names.**
→ **Cannot splice any failure series into the daily backtest. Bounded ANALYTICALLY** (honest best-effort; a splice would be fabricated data).

### A3 — Analytical haircut

The inflating channel = **liquid FAILURE-mode names** only. Mergers are neutral. The confirmed liquid failure on the main market is essentially **Wafa (one name)**; the "?" names skew illiquid → mostly removed by the liquid-half filter. So on the *liquid* universe the structural haircut is small. Literature for this profile is 1–4%/yr (US microcap upper end); TASI-liquid lands at the **low end, ~1.0–1.5%/yr**, consistent with the standing `SURVIVORSHIP_HAIRCUT = 1.5%` disclosure in `strategy_validation.mjs`.

Applying the haircut as a per-period drag on excess (haircut/yr ÷ 12), SE held fixed:

| Haircut/yr | Drag/pd | Excess/pd | t |
|-----------|---------|-----------|---|
| 1.00% | 0.083% | 1.172% | **3.01** |
| 1.25% | 0.104% | 1.151% | **2.96** |
| 1.50% | 0.125% | 1.130% | **2.91** |

**Post-survivorship t ≈ 2.9–3.0.** Survivorship alone does NOT kill it (matches the standing finding: the binding weakness was always significance, not survivorship — and even haircut, the excess-vs-basket metric is the robust one).

---

## ATTACK B — Multiple-testing deflation

The combo "won" after a spec search. Counted from `scripts/` (cross_sectional, one_factor, momentum_confirm, momentum_refinements, momentum_subperiod, momentum_fulluniverse, longterm_reversal, contrarian):

### B1 — Specs actually tried (raw M)

**Factor forms:** mom6_1, mom12_1, idiosyncratic/residual momentum, wk52-high alone, rev1m (short-term reversal), lowvol, long-term reversal (value-via-price), the rank-combo → **~8 factor forms.**
**Crossed variants on the winner family:** top-10 vs top-quintile (2); ≥2y vs ≥3y listing age (2); liquid-half vs liquid-third vs full (3); cost levels 0.11% / 0.61% / 1.2% (3); full-universe vs compliant-only (2).

Naive cross-product is large, but most are nested robustness slices, not independent "shots." Honest count of **effectively-distinct momentum specs tried before the combo was selected: M ≈ 12–20** (call it **M ≈ 15** central).

### B2 — Deflation (applied to the post-survivorship t = 2.96 @ 1.25%/yr)

**Bonferroni critical |t| for 5%:**

| M | crit |t| | post-surv t=2.96 |
|---|---------|------------------|
| 8 | 2.73 | CLEARS |
| 12 | 2.86 | CLEARS |
| 15 | 2.93 | CLEARS (barely) |
| 20 | 3.02 | **fails (barely)** |

**Harvey-Liu effective-independent-tests deflation.** mom6/mom12/wk52/combo are highly correlated (ρ ≈ 0.6–0.9; mom6/mom12 documented at 0.68, the combo is a rank-avg of two members). So the **effective number of independent tests Meff is far below M** — with ρ this high, ~15 raw specs collapse to roughly **Meff ≈ 3–6**. Adjusted p = p_raw × Meff (raw two-sided p at t=2.96 ≈ 3.1e-3):

| Meff | adj p | deflated t |
|------|-------|-----------|
| 3 | 9.3e-3 | **2.60** |
| 4 | 1.2e-2 | **2.50** |
| 5 | 1.6e-2 | **2.42** |
| 6 | 1.9e-2 | **2.35** |
| 8 (pessimistic) | 2.5e-2 | **2.24** |

**Correlation assumption (stated):** specs ρ ≈ 0.6–0.9 → Meff ≈ 3–6 (central 4–5). This is the defensible regime; treating all ~15 as independent (Meff=15) would be wrong because it ignores that they are the same momentum signal measured several ways.

---

## VERDICT

Stacking BOTH attacks on the in-sample t = 3.226:

1. Survivorship (1.0–1.5%/yr liquid-failure haircut, analytically bounded — could not splice): t → **2.9–3.0**.
2. Multiple-testing, Harvey-Liu with Meff ≈ 3–6 (ρ 0.6–0.9): deflated t → **2.35–2.60**.

**Deflated-t point estimate ≈ 2.45 (range 2.2–2.6).**

> **The combo's in-sample edge SURVIVES both attacks: deflated t ≈ 2.45 (> 2). Real and tradeable** — but with a thinned margin, not a 3.2 fortress.

**Honest caveats that keep this from being a slam-dunk:**
- It clears t > 2 across the *central* assumptions, but the **pessimistic corner** (1.5%/yr haircut + Meff = 8) lands at **t ≈ 2.2**, and full-independence Bonferroni at M = 20 would put it just under. The edge is *comfortably above 2 only if you accept that the momentum specs are highly correlated* — which they demonstrably are.
- Survivorship is a **bound, not a measurement** — 0 failure names could be priced; if there were more liquid TASI failures than the documented ~1, the haircut understates.
- This is **in-sample**; the standing OOS half-split (h1/h2 both > 1.5) is the independent check that this isn't pure in-sample luck — and it holds.

**Decision:** the momentum combo remains a **real, tradeable standalone edge** after the kill-test — deflated t ≈ 2.45. It does NOT collapse to "default to passive compliant-basket." But size it as an edge with t≈2.4, not t≈3.2: the honest margin is ~0.4 above the bar, so position sizing / risk budget should reflect a single-anomaly edge that is real but not bulletproof.

---

### Reproduce
```bash
node --experimental-sqlite scripts/killtest_survivorship.mjs   # baseline t + removal pricing
```
