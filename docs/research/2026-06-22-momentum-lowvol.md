# Momentum quintile × low-volatility filter — 2026-06-22

**Question.** Within the validated Sharia TASI momentum top-quintile, does filtering by LOW trailing
volatility improve risk-adjusted return? This is a *contained* refinement of an already-validated
edge (low overfit risk), judged primarily on **drawdown reduction**.

**Hypothesis.** The lower-vol names inside the quintile deliver similar return with smaller drawdown
→ better geometric compounding (drawdown was the only sizing lever that survived earlier tests).

**Setup.** Copies the validated quintile backtest line-for-line
(`scripts/breadth_test.mjs` / `dashboard/strategy_validation.mjs`): liquid-half ∩ ≥2y-listed TASI,
combo = rank-avg(mom6 `c[i-21]/c[i-126]`, wk52 `c[i]/max(c[i-251..i])`), top-quintile, monthly
(20-session) non-overlapping rebalances, equal-weight, Derayah 0.11% RT, COVID carved out.
**65 periods, 176-name universe.** At each rebalance the per-name trailing realized vol = std of the
last **60 daily returns**, bars up to the rebalance index only (point-in-time). Guillotine
(`dashboard/guillotine.mjs`) t-stat on the per-period excess vs the equal-weight basket.

Three arms:
- **quintile (EW)** — full top-quintile, equal-weight (== live grade; sanity-anchors the run).
- **low-vol half** — keep the lower-vol 50% of the quintile, equal-weight.
- **inverse-vol** — full quintile, weight ∝ 1/vol (same names held → same turnover/cost as baseline).

## Results

| variant        | avgN | ABS CAGR | excess/pd | guillotine t | maxDD    | Sharpe~ | %pos | gate(t>2) |
|----------------|------|----------|-----------|--------------|----------|---------|------|-----------|
| quintile (EW)  | 14   | 11.34%   | 1.25%     | 3.23         | −19.50%  | 0.400   | 57%  | PASS      |
| low-vol half   | 7    | 11.35%   | 1.27%     | 2.84         | −18.24%  | 0.352   | 62%  | PASS      |
| inverse-vol    | 14   | 11.70%   | 1.27%     | 3.30         | −18.51%  | 0.410   | 60%  | PASS      |

(Sharpe~ = per-period mean/std of excess. Baseline reproduces the live grade: CAGR 11.3%, t 3.23.)

## Verdict vs pre-registered KEEP-criterion

KEEP iff: excess/pd ≥ 80% of baseline **AND** maxDD cut by ≥ 3pp **AND** t > 2. Else REJECT.

- **low-vol half** — retains **101%** of excess (✓) | maxDD cut **+1.3pp** (✗ <3pp) | t **2.84** (✓) → **REJECT**
- **inverse-vol** — retains **101%** of excess (✓) | maxDD cut **+1.0pp** (✗ <3pp) | t **3.30** (✓) → **REJECT**

## Conclusion — REJECT both variants

The vol filter does *not* hurt — it neither shaves return (both keep ~100% of excess, CAGR
essentially flat) nor harms the gate (both still pass t>2). But it does *not earn its keep* on the
dimension that mattered: the drawdown cut is only **~1pp** (19.5% → 18.2–18.5%), well short of the
**≥3-4pp** bar pre-registered as the reason to add a moving part.

Read: inside the momentum top-quintile the names are already fairly homogeneous in risk — the combo
(mom6 + 52wk-high proximity) implicitly tilts toward names in clean uptrends, so re-sorting them by
realized vol re-shuffles broadly the same risk profile. The ~1pp DD shave is within noise and not
worth the added complexity, the halved breadth (low-vol half drops avgN 14→7, weakening t 3.23→2.84
toward the gate), or the inverse-vol weighting machinery.

**Decision: keep the live equal-weight top-quintile unchanged.** Low-vol filtering and inverse-vol
weighting are both rejected — they only confirm the existing quintile is already near its
risk-adjusted sweet spot. No live change.

Run: `node --experimental-sqlite scripts/momentum_lowvol_test.mjs`
