# Alpha-Execution Arc — Results

**Date:** 2026-06-22 · branch `feat/alpha-exec` · executed the brainstorm's recommended sequence.

## Net outcome: 0 strategy changes, 4 bad changes PREVENTED, methodology upgrade validated

Every quant/execution lead came back null under a pre-registered test — but each test *prevented a wrong change* and the strategy is now stress-tested at the proper (system-Calmar) bar. Two structural leads remain (IPO, allocation). The quant edge is now empirically exhausted, not just asserted.

## What was tested

### ① Live vol-target "leak" → REFUTED (`exposure_arms_test.mjs`)
The execution consultant suspected the live `schemeDExposure` (vol-target + seasonal-zero) was leaking ~2%/yr. **3-arm test refuted it:** the live overlay (B) *beats* plain (A) — CAGR 12.43% vs 11.34%, Calmar 0.80 vs 0.58, maxDD −15.6% vs −19.5%. Stripping it would *cost* ~1%/yr. **Decision: do NOT touch the money path.** (Caveat: the win is the seasonal sit-out component, already validated; vol-target alone stays unproven — don't add it anywhere new.) **The pre-registration caught a wrong edit before it shipped.**

### ② Equal-weight ensemble STACK → MOMENTUM-SOLO (`ensemble_stack_test.mjs`)
The methodology upgrade: judge the SYSTEM walk-forward on Calmar, not each signal's t alone. Sleeves are genuinely near-orthogonal (ρ̄ **0.083** — momentum~PEAD 0.003, momentum~vol-cont −0.009). **But the stack DILUTES:** Calmar drops in every variant vs momentum-alone; ablation is unanimous (dropping PEAD or vol-continuation *raises* OOS Calmar). Critically, the stack's **t went UP (2.98) while Calmar went DOWN** — exactly why per-signal t misleads and the system-Calmar objective is right. The sleeves are 2–3× weaker than momentum, so low correlation ≠ diversification when the means are too small. **Verdict: momentum-solo + seasonal mask. Don't add PEAD/vol-continuation as portfolio sleeves.** The methodology critique was correct to demand the system test — and the system test confirms momentum-solo.

### ③ Quarterly rebalance → REFUTED (`rebalance_frequency_test.mjs`)
A prior bonus arm flashed quarterly +3.25%/yr — an **artifact** (it charged full round-trip cost on the whole basket every month, over-penalising monthly). With correct hold-the-rest turnover, **monthly wins:** net CAGR 10.27% vs 9.59%; quarterly's first-half excess t is 1.57 (<2). **Keep monthly.** (Semi-annual flashed 17%/Calmar 1.30 but n=10 < 12 — underpowered, disqualified, not chased.)

### ④ Saudi IPO base-rate ledger → MILD-YES (Main only), capped, partial data (`ipo_harvest.mjs`)
Structural alpha the backtest can't see. **Load-bearing find: Tadawul caps day-1 moves at ±30%** — the flip upside is structurally capped (press's +134%/+190% are cumulative-on-survivors, not day-1). Base rate (n=5 clean day-1): 80% pop, median +30% (3/5 pin the cap), break-issue ~5% Main / bad on Nomu. Heavy oversubscription → tiny allocation → **~+1%/deal on applied capital, ~+8–15%/yr on cycled cash, capacity-limited.** **Verdict: mild-YES for Main-market IPOs as opportunistic cash-management with a kicker; NO on Nomu** (qualified-investor gating + bad tail). Real but much smaller than the narrative. Data-gated (saudiexchange.sa Akamai-walled, firecrawl out of credits → n=5 clean); harden with a Playwright pull of the exchange listing table.

## Still open (not executed this arc)
- **Zakat honesty line** — ~2.5%/yr is modeled nowhere; the mid-teens expectation is pre-zakat. Recommendation: subtract a 2.5%/yr line in the Goals/equity projection (confirm the user's exact zakat base first — don't hard-code blindly).
- **Strategic multi-asset Sharia allocation** (TASI momentum + US-Sharia ETF SPUS/HLAL + gold) — structural (rebalance premium + DD reduction), just-do-it, not a backtest gate. The highest-Sharpe lever the program treats as "not an edge." Write the fixed-weight policy.
- **IPO ledger hardening** — Playwright pull of the full ~80-name Main population for a population-grade base rate.

## The honest bottom line
The quant edge is **exhausted** — factors, sizing, cadence, ensembles all tested and null; momentum-combo + seasonal-mask, monthly, equal-weight, hold top 6–10, is robustly the answer at the proper bar. **The remaining money is NOT a fifth factor — it's structural + operational:** (a) operate momentum with discipline, (b) opportunistic Main-market IPO subscriptions on idle cash, (c) a strategic multi-asset Sharia allocation, (d) honest zakat accounting. Mid-teens %/yr stays the realistic ceiling on the core engine.
