# Project Status

_Last updated: 2026-06-22_

## TL;DR

One validated edge — **Sharia momentum combo** (deflated t ≈ 2.45, survived the kill-test) — plus a **seasonality drawdown overlay**, a **tiny borderline PEAD satellite**, a **multi-asset allocation policy** (50/30/20 TASI-momentum/US-Sharia/gold, validated Sharpe 0.60→1.05), and **opportunistic Main-market IPO flipping**. All sizing/exposure levers are dead → momentum runs **plain equal-weight, hold the top 6–10 names, monthly**. Honest expectation **mid-teens %/yr** (≈low-teens net of zakat; 20–30% is good-year variance, not a plan). The edge hunt is **exhausted**: ~35+ tests, 1 durable edge; the round-2 batch went 0/3 and the alpha-execution arc went 0 changes / 4 bad changes prevented. **The methodology was upgraded** (judge the SYSTEM walk-forward Calmar vs basket, not each signal's t alone). The money is now in **operating** the edge well + the structural levers (allocation, IPOs), not a fifth factor. The **operate loop is now fully built and self-measuring** — `npm run decision` emits the order list (`--save` locks it as the month's plan), a **fill-logger** (CLI `npm run log-fill` + a Lab "Real Fill Ledger" card) records actual Derayah fills → real HOLD/SELL + live P&L, and **plan-vs-actual tracking** scores each month's fills against the saved plan (coverage, entry slippage, missed/off-plan). The only missing input is real trades.

## Validated edge set

- **Sharia momentum combo** — `mom6 × 52-week-high` rank combo, top-quintile **capped at top 8 by rank**, monthly, equal-weight, liquid-half, ≥2y-listed, Derayah 0.11% RT. **Live in `getMomentumScreen` → decision view / CLI / state machine.**
  - **Kill-test PASSED (2026-06-22):** after a survivorship haircut (1–1.5%/yr → t ≈ 2.9–3.0) AND a multiple-testing deflation (~15 specs, ρ≈0.6–0.9, Meff 3–6 → Harvey-Liu t 2.35–2.60), the combo holds at **deflated t ≈ 2.45 (>2)**. Real and tradeable — but size it as a t≈2.4 single anomaly, not a fortress. (`scripts/killtest_survivorship.mjs`)
  - **Grader leaks FIXED:** `strategy_validation.mjs` had been grading **plain mom6 (not the live combo)** and applying **today's Sharia set retroactively**. Fixed → leak-free in-sample guillotine **t 3.23** (removing the leaks *raised* it from 2.71). The Lab now reports the honest number.
  - **Concentration finding → now enforced as a hard top-8 cap (2026-06-22).** Holding the **top-ranked** 6–10 names does NOT dilute the edge (top-10 t 3.97, top-8 3.35, top-6 2.81, top-4 3.10 — the rank carries return); the full ~15-name quintile dilutes into lower-conviction names. The screen now caps at **`maxHoldings=8`** (`getMomentumScreen`, `k = min(8, quintile)`), applied everywhere (decision CLI, `/api/lab/momentum`, goals, saved snapshot). Validation unaffected (grader baskets independently). The risk is *which* names: a *random* 4-slice averages +16%/yr excess but ±6.2pp — the cap takes the **top-ranked** 8, not an arbitrary slice. (`scripts/breadth_test.mjs`)
- **Seasonality** — sit out the 2 weakest calendar months. A **drawdown overlay, not a return edge** (OOS return gate fails t 0.57; DD reduction ~4.8pp robust). Correctly scoped, kept.
- **Conditioned PEAD** — small **borderline** 2nd sleeve (~10% risk budget). Gate PASS at 0.11% (guillotine t 2.14, n=118, **orthogonal to momentum r ≈ 0**) but cost-fragile (fails at 0.30%) and front-loaded. **Wired live**: `dashboard/pead_screen.mjs` + `/api/lab/pead` + a card on the Momentum tab (EXPERIMENTAL framing, 6h-TTL cached). Event-driven → empty between earnings seasons.

## Sizing — all levers dead → plain equal-weight

The board's "smarter sizing doubles growth" is **refuted**. Vol-target, fractional-Kelly conviction, and the drawdown-brake (200d-MA regime, walk-forward) all KILLED; momentum × low-vol and inverse-vol weighting both REJECTED (DD cut ~1pp vs the ≥3pp bar). **Momentum runs plain equal-weight, monthly, no exposure overlay** (seasonality sit-out is the one kept risk overlay). The strategy state machine still auto-tempers exposure (see below) — that's a governor, not an alpha lever.

## Strategy state machine (live)

- **momentum-sharia — PROMOTED, auto-tempered to `decaying` (×0.5).** Rolling-12 soft (mean +1.01%/period, t 1.86<2, DD −24.5%) → governor halves exposure. Auto-restores to ×1.0 when the window strengthens. Persists in local SQLite (not version-controlled). No manual demote by design.

## Dead / rejected signals (do not relitigate)

9-pt TA score (per-period t 0.74, relabeled context-only), whale_score (noise, culled from all deciding/UI paths), govt contract-flow (guillotine t 0.90), dividend (beta, excess +0.10%), MSCI/flow front-running (t −1.18, run-up pre-announcement), block deals (EXPERIMENTAL, t 1.94, underpowered), value-via-price long-term reversal (corr 0.36 w/ momentum or fails). **Round-2 batch (2026-06-22), 0/3 promoted:** volume-shock reversal DEAD (guillotine t 0.63; only the *continuation* leg is significant, t~4 — untradeable chase), crypto TSMOM (BTC/ETH 200d) SHELVED (Sharpe passes but maxDD cut only 16–21% vs ≥30% gate — a mild risk overlay on crypto already held, not alpha), conditioned-PEAD cost-hardening FAIL/closed (no refinement clears t>2 at 0.30%; longer-hold near-miss t 1.91).

## Operating the strategy (this month)

The screen now caps at the **top 8 by rank** (`maxHoldings=8`). **July plan SAVED** (`decision --save`, period **2026-07-01**): 8 names, equal-weight, **SAR 4,875/name, 39% deployed** on a 100k account (DECAYING ×0.5 governor + vol-target on the tighter, higher-vol 8-name book). `npm run decision -- --save --acct <SAR>` reproduces + re-saves at your real size (state → sizing → BUY/HOLD/SELL → SAR-per-name → ⚠ debt-≥50% flags). Flags: `--acct N`, `--save`, `--json`, `--quiet`, `--held "1120,2222"`. **Two of the top 8 (1304 ~59%, 2050 ~64%) are debt ≥50%** — confirm AAOIFI or drop to a 6-name clean book. This is the first real operating cycle; trade on Derayah, then `log-fill` → Plan vs Actual.

## Fill-logger loop (shipped 2026-06-22)

The operate loop is now closed end-to-end. After you place the monthly orders, log the actual fills; they flow into the `positions` book that `decision.mjs` HOLD/SELL and the exit-check P&L already read, and a live realized/unrealized P&L track record accrues. **Two ways to log — CLI or UI:**
- **CLI:** `npm run log-fill -- --sym 1120 --buy --shares 100 --price 95.4 [--fees] [--date] [--note]`, `--sell`, `--list [--prices "1120:102,…"]`, `--remove N`, `--json`.
- **Lab card:** "📒 Real Fill Ledger" on the Momentum tab — P&L summary tiles, log-a-fill form, open-book table with unrealized P&L (priced off the latest scan), removable ledger rows.
- **Engine:** `dashboard/fills.mjs` (pure `computeBook` — weighted-avg cost, buy fees fold into basis, sell fees reduce proceeds, oversell clamp; `summarize` for unrealized) + `realFills` store (`fills` table) + `GET/POST/DELETE /api/fills`. The store projects the open book into the `positions` blob and **reconciles against the live book** — selling to zero or deleting the last fill removes the position cleanly (a bug where a stale HOLD lingered was caught by an end-to-end test and fixed); manually-entered positions are left untouched.
- **Fees** are user-entered per fill; confirm they match how you want Derayah commission accounted.

## Plan-vs-actual tracking (shipped 2026-06-22)

The loop now **measures its own execution**. `decision --save` (or the card's "Save plan" button) locks the month's momentum picks as a snapshot; logged fills are then scored against it — so you learn whether you traded the edge as designed, not just that you traded.
- **Capture:** `npm run decision -- --save` → one snapshot per rebalance period (`decision_snapshots` table). UI button → `POST /api/decision/snapshot` (server recomputes the screen authoritatively).
- **Read:** `npm run log-fill -- --list` prints a **Plan vs Actual** section; the fill card shows coverage / entry-slippage / missed tiles + a per-name table; `GET /api/tracking`.
- **Metrics** (`dashboard/tracking.mjs`, pure `compareToSnapshot`): per-name status (filled / partial / missed / off-plan), **entry slippage** (avg fill cost vs decision price), **coverage %** (plan names held), and intended → actual capital.
- **Scope (deliberate):** this is **execution fidelity**, NOT return attribution (book P&L vs a backtested basket) — a separate, later layer. Next nice-to-have: month-over-month coverage/slippage trend (the snapshot history `getAll` is built but unused).

## Standing research discipline (adopted 2026-06-22)

Pre-register hypothesis/universe/signal/holding/cost **and spec count** before any backtest; **cap ~5 new specs per arc**; bar rises with N (**deflated-t ≥ 3** vs the full ~35-trial count); mandatory OOS `portfolioGuillotine` (pooled NW-t ≠ the gate); **kill-by-default — no "experimental/borderline purgatory."**

## Visual redesign (shipped 2026-06-22)

B+C hybrid design-system refresh merged to `main`: violet→indigo tokens, editorial + fintech-polish across all 8 tabs, Momentum/Goals hero, drawer "Volume Flow" restyle. Also fixed a live `_oppCache` ReferenceError that had been crashing **every** drawer open. CI honesty guard + drawer smoke test added.

## Multi-asset allocation policy (shipped 2026-06-22)

Fixed-weight Sharia portfolio across **TASI momentum book (50%) / US-Sharia equity SPUS (30%) / gold (20%)**, quarterly rebalance. **Validated** (`scripts/allocation_backtest.mjs`, 2020–2026): vs TASI-momentum-alone, lifts **Sharpe 0.60→1.05**, cuts **maxDD −19.5%→−13%**, adds **+1%/yr** rebalancing premium; legs near-uncorrelated (0.20/0.10/0.03). Caveat: ~5y window. **Built:** `dashboard/allocation.mjs` (pure `normalizeWeights`/`computeRebalance`, 8 tests) + `/api/allocation` + a **Goals-tab card** with editable weights/values → live BUY/SELL/HOLD rebalance actions. Weights editable (50/30/20 default).

## Zakat honesty (shipped 2026-06-22)

The Goals card shows the target **net of zakat** (~2.5%/yr of portfolio value — a real headwind no return figure included): gross +X% → **net +Y%**, with an editable `zakat_pct`. Makes the mid-teens expectation honest (≈low-teens net).

## Alpha-execution arc + methodology upgrade (2026-06-22)

Full-room brainstorm licensed to challenge the validation regime, then executed the leads. **Methodology upgrade adopted:** the per-signal guillotine t is underpowered at n=65 (misses modest edges 60–75%) and tests the wrong object — **judge the SYSTEM walk-forward Calmar vs buy-and-hold basket; two-tier sizing (full / fractional-if-strong-prior / kill); deflated-t ranks not kills.** Executed 4 pre-registered tests → **0 strategy changes, 4 bad changes prevented:**
- **Vol-target "leak" REFUTED** (`exposure_arms_test.mjs`) — the live overlay BEATS plain (Calmar 0.80 vs 0.58); stripping it would COST ~1%/yr. Don't touch the money path.
- **Ensemble STACK = MOMENTUM-SOLO** (`ensemble_stack_test.mjs`) — sleeves near-orthogonal (ρ̄ 0.083) but 2–3× weaker → they DILUTE (Calmar drops; ablation unanimous). Stack t rose (2.98) while Calmar fell = proof the system-Calmar objective is right.
- **Quarterly rebalance REFUTED** (`rebalance_frequency_test.mjs`) — the +3.25% was a turnover-accounting artifact; monthly wins (10.27 vs 9.59).
- **Saudi IPO ledger = MILD-YES (Main only)** (`ipo_harvest.mjs` + `ipo_population.mjs`) — Tadawul caps day-1 ±30% → flip upside capped; n=12 true offer-pop: 83% pop / median +30% / ~17% shallow break → **~+8–15%/yr on cycled cash, capacity-limited.** Opportunistic Main-market subscriptions on idle cash; NO Nomu. (Population-grade base rate still needs prospectus offer prices — Akamai-walled.)

## Honest ceiling

~9% / 9,000-SAR goal: comfortably reachable. **Mid-teens %/yr is the realistic mean; 20–30% is good-year variance, not an engineered target** — the uncorrelated 2nd engine that would lift the mean has been hunted ~30 times and not appeared. Biggest return lever = operating momentum at high fidelity (6–10 names, monthly discipline), not new factors.

## Tests

`test:money` **158** · `test:strategy` **23** · `test:honesty` **2** · `test:drawer` 18 rows clean · `pw-verify` 8 tabs / 0 console errors (LTR + RTL). e2e needs a live TradingView CDP session (not run).

## Open threads

- **Operate it** — `npm run decision -- --save` to lock the plan, trade the picks on Derayah, log the fills (`npm run log-fill` or the Lab fill card), then read Plan vs Actual to check your execution. The loop is fully built and self-measuring now; the only missing piece is real fills. This is the primary work, not more research.
- **Snapshot history view** (small, optional) — `decisionSnapshots.getAll` is built but unused; a month-over-month coverage/slippage trend would show whether execution discipline is improving.
- **Block-deal re-test** — only remaining untested flow signal with positive shape; data-gated (needs a headed Argaam harvest past ~30 buckets).
- **Reserve idea (not yet run):** buyback / treasury-purchase under-reaction — harvest the saudiexchange JSON feed to >150 events *before* testing (currently 92 = block-deal-grade thin).

## Reference docs (this session)

`docs/research/2026-06-22-independent-review-edge-plan.md` (board judged) · `-edge-plan-results.md` (Phases 0–2) · `-killtest-survivorship-multipletesting.md` · `-new-approaches-consult.md` (round 2) · `-volume-shock.md` · `-crypto-tsmom.md` · `-pead-hardening.md` · `-pead-conditioned.md` · `-momentum-lowvol.md` · `-drawdown-brake.md` · `-alpha-and-methodology-brainstorm.md` · `-alpha-exec-results.md` · `-exposure-arms.md` · `-ensemble-stack.md` · `-rebalance-frequency.md` · `-ipo-ledger.md` · `-multi-asset-allocation.md`. Design: `docs/superpowers/specs|plans/2026-06-22-visual-redesign*`.
