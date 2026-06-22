# Independent Review — Board Assessment & Edge-Discovery Plan

**Date:** 2026-06-22
**Engagement:** Independent ("Deloitte-style") team, unbiased mandate: judge the advisory board, debate it, produce a ranked plan to find edges and make money. Constraints challengeable.
**Team:** Independent Quant/Factor PM · Microstructure/Alt-data/Flows · Risk/Capital-allocation · Red-Team/Integrity. (No loyalty to the existing board.)

---

## Bottom line (engagement partner synthesis)

You have **one real edge (momentum combo) and one real risk overlay (seasonality)** — and the OLD board was right all along: *one modest-but-real edge, harvest with discipline.* The NEW board's "modest was a measurement artifact → four above-modest upside layers" is **mostly narrative, and the independent team refuted it on your own data.** The money is not in a fifth factor; it is in three things you've under-invested in: **(1) fixing two live look-ahead leaks that are inflating the number you trust, (2) capturing the edge you already have (you trade ~4 names of an 11–34-name edge), and (3) running the ONE kill-test that decides whether momentum is real or a fishing-expedition survivor.**

**Honest money math:** if momentum survives the kill-test, realistic net ≈ **12–16%/yr, maxDD ~−20–25%** — clears your ~9%/9,000-SAR goal comfortably, does **not** reliably reach 20–30%. The stretch is an *edge-count* problem, not a sizing problem.

---

## The debate: judging the board

### OLD board — VINDICATED
"One modest edge, harvest with discipline; biggest enemy is overtrading." The independent team agrees across the board. ~15% CAGR / +10–15% excess from one robust cross-sectional factor is **not modest for a 100K retail account** — it's a good outcome *if realized*. Keep: Layla (edge real-but-modest), Marcus (anti-overtrading), Abdulaziz (TASI microstructure), **Daniel Stern (integrity veto — should have been louder)**.

### NEW board — MOSTLY OVERSOLD (refuted on the evidence)
| New-board layer / member | Independent verdict | Evidence |
|---|---|---|
| **Compounding geometry "≈doubles growth"** (Grace Lim) | **BUSTED** | vol-target KILLED (no cash/leverage leg in a long-only Sharia book), Kelly KILLED (no calibrated per-name edge — momentum gives a *rank*, not an expected return). Only drawdown-brake survives → **demote to defense-only.** |
| **Flow/rebalance front-running** (Reem Al-Dossari) | **REFUTED** | Ran `index_flow_test.mjs`: MSCI-add window **−0.68% net, t −1.18, win 33%**, pre-window +0.94% → you'd buy the *exit liquidity* of the real front-runners. "Low overfit because calendar-driven" is true but irrelevant — no surprise left for a retail latecomer. |
| **Retail-behavioral / PEAD** (Yousef Amin) | **CLOSE, FAILS GATE** | Ran `pead_test.mjs`: drift is monotonic Q1→Q5 (real behavioral footprint) but spread t **1.33**, Q5 long-only net **+0.22% (t 1.92<2)**, fails the season split. Earns exactly **one** conditioned re-test, then permanent kill. |
| **Alt-data (Arabic X / Google Trends)** (Ana Sokolova) | **CUT** | No clean historical Arabic corpus, no survivorship-free price spine to test against, paid/rate-capped APIs. Highest overfit-risk, lowest edge-per-effort. A 6-month rabbit hole for a solo operator. |
| **Regime allocator over a stable of edges** (Henrik Vasquez) | **PREMATURE** | You don't allocate across a stable when you have *one* edge. Solving a problem you don't have. |
| **Small-cap Halal sleeve / "liquid-half discards the edge"** (Faisal Noor) | **REJECT — the most dangerous idea in the deck** | Survivorship + execution slippage are *worst* on illiquid names — exactly where your load-bearing caveat does most damage and where 0.11% modeled cost is fiction (real spread/impact 1–3%). Confuses *capacity* with *edge*. |
| **Red Team "guilty until proven OOS, multiple-testing-aware"** (Ingrid Bauer) | **VINDICATED — should have bound harder** | Exactly the discipline the red-team below says was under-applied. |

**The one genuinely useful NEW-board insight that survives:** *combine factors instead of testing-in-isolation-and-keeping-one-survivor.* The live combo (mom6 × 52-week-high) IS a combination, and "momentum × low-vol intersection" is a contained, low-overfit improvement worth testing. Credit where due — but it does not rescue the four-layers thesis.

---

## Three findings the independent team uncovered (not previously flagged)

1. **The live grader is leaking right now.** `dashboard/strategy_validation.mjs:58` applies *today's* Sharia-compliant set to ALL 2020–2026 rebalances (look-ahead), and `:81` grades **plain `mom6`, not the combo** that the record says went live. So the Lab's headline **t≈3.6 is the leaked, single-factor number** — not the leak-free combo. Fixed in one offline script (`momentum_refinements`), believed to have propagated; it didn't.
2. **Momentum t≈3.38 is INFLATED.** The tradeable-subset t was **1.35–2.0** at realistic cost (your own `momentum_fulluniverse`). The jump to ~3.3 came from (a) the "compliant" filter, which your own notes admit is partly a size/quality/survival proxy, and (b) adding wk52 *after* a multi-spec search (mom6/mom12/idio/wk52/rev1m/lowvol/top-10/quintile/≥2y/≥3y/liquid/3 costs). Multiple-testing haircut ≈ **0.7–1.0 t** → honest **t≈2.0–2.5 on effectively one regime sample**, before survivorship + Sharia-leak correction.
3. **Concentration is the #1 money leak.** The edge is an ~11–34-name equal-weight quintile; you trade ~4. Information ratio scales ≈ √(4/11) ≈ **0.60×**; at 4 names idiosyncratic noise (~25–40%/yr per name) ≈ the entire +10–15% edge; one −40% name = a ~10% portfolio hit (vs ~4% at 10 names). **You are running a different, noisier portfolio than the one you validated.**

**Red-team's honest probability you beat a passive Halal benchmark over 5 years: ~45–55%** (coin-flip-ish) *as currently traded* — because the +EV momentum tilt is swamped by 4-name variance + slippage + one-regime sample. The fix below moves this materially in your favor.

---

## The plan (ranked, sequenced, money-tied)

### Phase 0 — INTEGRITY (do first; cheap; decides everything)
- **0a. Fix the live grader leaks** — `strategy_validation.mjs`: grade the **combo** (not plain mom6); remove the today's-Sharia snapshot from the backtest path (run concept on all stocks, apply Sharia as a *live* filter only, OR get dated compliance — minimum, stop reporting the leaked number as validated).
- **0b. THE KILL-TEST** *(not yet run — the single most valuable thing to do)*: hand-assemble the ~15–20 delisted/merged TASI names **+** the ~10–15 names that **lost Sharia compliance** over 2016–2026 (the lists are already bounded in your notes), splice them in at real exit prices/dates, re-run the **guillotine on the leak-free combo**. ~$30 (one month FMP/TwelveData active history) + ~4 hours.
  - **If per-period t ≥ 2:** momentum is real → proceed to Phase 1 with confidence.
  - **If t < 2** (plausible — it's already 1.35–2.0 on the clean subset before correction): momentum is **not a standalone edge** → default to a **passive compliant-basket + mild momentum tilt + seasonal DD overlay** (still beats the 9% goal; just be honest it's basket+2–4%, not alpha).

### Phase 1 — CAPTURE THE EDGE YOU HAVE (highest money-per-effort, zero new overfit)
- **1a. Breadth fix — hold ~8–10 equal-weight names, not 4.** First run the breadth-degradation backtest (excess + guillotine-t at n=4/6/8/10; bootstrap random 4-name slices vs the full quintile) to set the number with data and put the tracking-error distribution on the Lab. **This is the #1 lever to raise *expected* (not lucky) return** — free, already-validated.
- **1b. Defense layer** — finish the drawdown-brake walk-forward (pre-registered rule, judged on maxDD/Calmar not CAGR) + keep the seasonality 2-weak-month sit-out. Ship as one "defense" toggle.

### Phase 2 — ONE disciplined shot at a 2nd edge (pre-registered, single attempt, hard kill)
- **2a. Conditioned PEAD** — Q5 earnings-reaction **× momentum-aligned × reaction-day volume-confirmed**, drift [+2,+22], through `portfolioGuillotine`, must pass in **both** season cohorts (spread>0 AND t>2 AND monotonic AND Q5 net>0 AND ≥~100 events). Pass → genuine 2nd, low-correlation edge. **Fail on the first pass → close the information-edge thesis permanently** (no condition-iteration — that's the overfit trap).
- **2b. (Contained) momentum × low-vol intersection** — a *filter* on the validated quintile, judged on DD reduction (keep ≥80% excess, cut maxDD ≥3–4pp). Low overfit because it's not an independent factor.
- **Finish the block-deal re-test** (extend Argaam history, event-level guillotine on ≥2 non-overlapping years) — only real flow signal with positive shape; pass t>2 → promote, else permanent EXPERIMENTAL.

### Phase 3 — only if Phase 0 passes AND a Phase-2 edge validates
Regime/blend across the (now two) edges. Otherwise **STOP** — do not build a regime allocator over one edge.

**Hard stops (do NOT pursue):** alt-data sentiment, small-cap Halal sleeve, conviction/vol-target sizing (dead), flow/rebalance front-running (refuted), more feature-building.

---

## Resourcing (hire / replace / cut)

- **HIRE (the binding constraint): a data-engineer / execution-quant**, not another factor researcher. The two real constraints are *data* (survivorship-free universe, dated Sharia, PEAD earnings history) and *implementation* (turn an 11–34-name quintile into a disciplined 6–10-name book with honest fills + fix the grader leak). Every validated-vs-dead result already exists.
- **PROMOTE:** Daniel Stern (integrity) + Ingrid Bauer (red-team) to a standing **pre-registration gate** — every new test declares its spec + kill-criterion *before* running, to stop the multiple-testing inflation that produced the t≈3.38 illusion.
- **DEMOTE:** Grace Lim (risk-geometry) from "offense, doubles growth" → "defense only (DD-brake)."
- **BENCH/CUT:** Reem (flows — refuted), Ana (alt-data — rabbit hole), Faisal (small-cap — dangerous), Henrik (regime allocator — premature). Retire the "self-evolving edge" narrative; replace with "operate one edge + pre-registered kill-tests."

---

## What this means for your goals
- **~9%/yr (9,000 SAR) goal:** achievable with high confidence *if* you fix concentration and the kill-test passes — even the passive-basket fallback gets you close.
- **20–30% stretch:** not an expectation on one edge. It requires a *second uncorrelated edge* (PEAD if it passes) — sizing/leverage won't get you there and leverage isn't Sharia-clean. Treat mid-teens as the plan; the stretch as a good-year tail.
- **The honest risk:** if the kill-test fails, the stock-picking apparatus is largely *elaborate self-employment dressed as alpha*. Running Phase 0 is how you find out for ~$30 — cheaper than another month of building.
