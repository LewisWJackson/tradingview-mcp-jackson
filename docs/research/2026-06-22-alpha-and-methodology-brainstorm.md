# Alpha + Methodology Brainstorm (full room)

**Date:** 2026-06-22 · both boards + independent consultants, licensed to challenge the validation regime itself.
**Mandates:** metascience/methodology · ensemble/system alpha · execution/implementation alpha · first-principles/structural.

## The headline: we've been measuring the wrong thing

Two independent consultants converged on the same conclusion from different directions: **the gate judges each signal ALONE at a publishable-anomaly bar, when the user's payoff is the compounded wealth of the combined SYSTEM.** That single reframe is both the methodology fix AND the most promising untested alpha.

## 1. Methodology — it IS mis-calibrated (two real flaws)

- **Underpowered by construction.** At n=65 non-overlapping periods, t>2 needs a true excess information-ratio > ~1.25 *annualized* for 80% power. A genuinely *modest* real edge (IR 0.4–0.6 — exactly what the old board said exists) is **missed 60–75% of the time.** Layering **deflated-t≥3** on top makes almost no honest modest edge passable — the bar is now above the data's resolving power. **For a retail account that loses nothing by harvesting a modest real edge, the false-NEGATIVE is the expensive error** — and the regime optimizes against it.
- **Wrong objective.** Per-period excess-t of a single signal ≠ survivable compounded wealth of a 6–10-name book. A signal can be insignificant in mean-excess yet lift portfolio **Calmar** (left-tail/de-correlation); seasonality is exactly this and the t-gate can't see it.
- **Single-signal blindness.** 4 low-correlation t≈1.7 signals combine, **with no fitted weights**, to system t ≈ 1.7 × √(N/(1+(N−1)ρ)) ≈ **2.7** at ρ=0.1. The gate never builds the stack, so it kills components that would survive as a portfolio.

**The fix (adopt):**
- **Deciding objective = walk-forward SYSTEM Calmar + terminal log-wealth vs buy-and-hold the compliant basket.** Demote portfolio-guillotine t to a *component diagnostic*, not the kill switch.
- **Two-tier sizing, not binary kill:** t>2 → full sizing; **1.3<t<2 with correct sign + a strong external prior → FRACTIONAL sizing** (not dead); kill only sign-flippers and t<1 with no prior.
- **deflated-t ranks candidates, it doesn't kill them.** Overfitting gets punished in the OOS walk-forward (no fitted weights), not by an ever-rising in-sample threshold.
- **Bayesian pass is legitimate ONLY with a pre-existing OOS prior + sign-consistent near-threshold local data:** momentum (yes), **PEAD (yes — 2nd-most-replicated anomaly globally, local t≈2)**. NOT contract-flow (artifact), block-deals (folk prior), whale (wrong sign).

**Resurrected under the corrected methodology:** PEAD (fractional sleeve), seasonality (system-Calmar finally rewards it). **Stay dead:** contract-flow, whale, govt, crypto-in-the-core (violates the survivable-DD constraint).

## 2. Ensemble alpha — the cheapest decisive test (and it's nearly free)

Verified in-code: **every signal harness already emits a co-benchmarked monthly excess series through the one `portfolioGuillotine`.** So a fixed equal-weight STACK is just the element-wise average of aligned monthly series → the same gate at the system level. ~An afternoon to a verdict.

- **#1 — Equal-weight near-miss STACK:** momentum core + PEAD (earnings sleeve) + volume-**continuation** (the spike-UP leg from the failed volume test was strongly significant, t~4, corr 0.15 to momentum = distinct) + seasonality as a cash-mask. Fixed round-number weights (also test exact 1/N). **Pre-registered SYSTEM bar:** combined t>2 AND both-halves t>1.5 AND system Calmar > basket Calmar in both halves AND beats momentum-alone. **Ablation:** drop each sleeve; keep it only if removal *lowers* OOS Calmar. Run at 0.11% AND 0.30% (the cost-fragile sleeves reveal themselves as dilution).
- **#2 — Deterministic calendar/regime sleeve rotation** (the legit "self-evolving system"): momentum always-on; PEAD only in earnings-season months; seasonality forces cash in the 2 weak months; volume-continuation only when basket vol is elevated. Fixed rules, no fitting. Only build if it beats the always-on stack OOS.
- **The catch (honest):** diversification multiplies the Sharpe of a *real* mean; it does nothing for a mean that's actually ~0. PEAD@0.30% and block-deals may *dilute*. The ablation step is what protects against that.
- **Prerequisite (20 min):** compute the actual pairwise correlation matrix of the {momentum, PEAD, volume-cont, seasonality} monthly excess streams — the whole ensemble case hinges on ρ. Also: the harnesses currently `console.log` their series; each needs a ~1-line export so the stack harness imports real arrays.
- **DO NOT build:** conviction sizing via combo magnitude (re-expressed rank = hidden fitting), or any fitted-weight meta-model.

## 3. Execution alpha — a LIVE LEAK found in the money path

- **🔴 The live exposure formula still contradicts the research.** `dashboard/momentum_screen.mjs` `schemeDExposure` STILL computes `e = min(1, 0.15/realizedVol) × inSeason × stateMult` — i.e. **vol-target + a seasonal hard-zero are still throttling the live book**, even though the research KILLED vol-target (measured **−2.2% OOS CAGR, no DD benefit**) and concluded "plain equal-weight, no exposure overlay." Momentum names are high-vol, so `min(1, 0.15/realizedVol)` keeps the book **below full exposure most months** — the −2.2%/yr leak is running RIGHT NOW. **Fix: strip vol-target + inSeason→0; keep `stateMult` (the ×0.5 governor) as the sole multiplier. ~+150–220 bps/yr recoverable.**
- **🟡 Zakat (~2.5%/yr) is modeled NOWHERE** (grep = 0 hits). It's a guaranteed headwind *larger than the net momentum excess* — and the mid-teens expectation the user plans around is **pre-zakat**. Not a strategy change, but subtract a 2.5%/yr line in the Goals/equity projection so the plan is honest. (Confirm the user's exact zakat base first.)
- **🟡 Rebalance FREQUENCY (not day):** a 6mo signal decays slowly → quarterly likely ≈ same return at ~⅓ turnover/cost. The "rebalance mid-month to dodge the crowd" angle is low-conviction (a 100K book has no impact). Test frequency, not timing.
- **The one backtest:** 3-arm with/without-governor compounding — plain `e=1` vs the live formula vs `e=stateMult` — + a monthly-vs-quarterly arm. Confirms the leak size and the governor's net effect.

## 4. Structural alpha the backtest gate is blind to

- **🟢 Saudi IPO subscription flipping — THE edge the quant frame literally can't see.** Primary-market: apply at the offer price, get scaled allocation, flip the listing pop. Positive-skew, repeatable, needs NO price backtest. Realized return = `pop% × allocation% − lockup_drag` (headline 20–30% pops shrink to mid-single-to-low-double-digit % on cycled capital after allocation scaling). **Validate via an IPO base-rate LEDGER, not a price model:** scrape ~5y of Tadawul/Nomu IPOs (offer, oversubscription, retail allocation, day-1 pop, break-issue rate, decay over time) → a frequency table + a decision rule ("subscribe to every eligible Sharia deal if median return-on-cycled-capital clears the hurdle and break-issue rate is tolerable").
- **🟢 Strategic multi-asset Sharia allocation** (TASI momentum sleeve + US-Sharia ETF SPUS/HLAL + gold) — the user runs siloed TASI/US/crypto accounts and leaves the **rebalancing premium + drawdown reduction** on the table. Structural (Fernholz), not a signal — just-do-it; the highest-Sharpe lever available. SAR is USD-pegged so the US sleeve has little FX risk.
- **Warn against:** Vision-2030/budget-capex sector rotation — most-consensus trade in the market, priced before it's a known calendar event; it's resurrected dead event-study (contract-flow/block-deals) in a macro costume.

## Recommended sequence (highest leverage first)
1. **Fix the live vol-target leak** (strip it from `schemeDExposure`, keep `stateMult`) + run the 3-arm confirm — recovers ~2%/yr **now**, and aligns live code with research. *Cheapest, most certain money.*
2. **Build `ensemble_stack_test.mjs`** (after the 20-min ρ-matrix + the 1-line series exports) — the methodology upgrade AND the resurrection test in one. System-Calmar vs basket, with ablation. Could promote PEAD + volume-continuation + seasonality from "dead/borderline parts" to "a system worth more than its parts."
3. **Zakat line** in the Goals projection (honesty) + **rebalance-frequency** arm.
4. **Saudi IPO base-rate ledger** — the one genuinely new, structural, non-backtestable edge. Build the ledger, compute the base rate, decide.
5. **Strategic multi-asset allocation** — write the fixed-weight Sharia policy across the accounts the user already runs.

The methodology change is the big one: **stop killing components at a publishable bar; judge the SYSTEM walk-forward on what the user can actually spend (compounded wealth, survivable drawdown).** That, plus fixing the live leak and adding the IPO ledger, is where the next real money is — not a fifth factor.
