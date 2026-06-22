# Crypto Time-Series Momentum (TSMOM) — Pre-Registered Single Edge Test

**Date:** 2026-06-22
**Script:** `scripts/crypto_tsmom_test.mjs`
**Assets:** BTC-USD, ETH-USD (Yahoo v8 daily, via `scripts/bars_cache.mjs`)
**Verdict:** **FAIL — crypto TSMOM is SHELVED for this program.**

Crypto Sharia status is disputed. This test governs *crypto the user already holds* (risk control on existing exposure) — it is **not** a proposal for a new Sharia sleeve.

---

## PRE-REGISTERED HYPOTHESIS (verbatim, not tuned)

Time-series (absolute) momentum, borrowed from Moskowitz-Ooi-Pedersen — NOT tuned here.
- **Signal:** daily close vs 200-day SMA. **Long** when close > SMA, **FLAT** (cash, 0 return) when close ≤ SMA. Long-only, no shorting, no leverage. Point-in-time SMA (only past/current closes).
- **Assets:** BTC-USD and ETH-USD — individually AND pooled (equal-weight the two when both long).
- **Cost:** 0.20% per switch (entry or exit). Cash earns 0.
- **Benchmark:** buy-and-hold the same asset(s).

## PRE-REGISTERED GATE (verbatim — PASS requires ALL)

1. Net Sharpe (annualized, daily returns) **≥ 0.8**.
2. **Beats buy-and-hold on Sharpe** (the claim is risk-adjusted + drawdown control, NOT raw return).
3. **maxDrawdown reduced by ≥ 30%** vs buy-and-hold.
4. **Holds in BOTH halves** of the sample (date range split in two) — not a single-cycle artifact.

## KILL RULE (verbatim)

Fail ANY → crypto TSMOM is shelved for this program (log it). **ONE lookback (200-day). Do NOT search for the lookback that passes** — if 200d fails, it fails. 100-day and 50-day are INFORMATIONAL ONLY (footnote), not used for the verdict.

---

## SAMPLE SPAN (actual, range='10y')

- **BTC-USD:** 2016-06-22 → 2026-06-22 (3,652 daily bars)
- **ETH-USD:** 2017-11-09 → 2026-06-22 (3,147 daily bars)
- **Pooled common window:** ~2018-05 → 2026-06-22 (both assets have a defined 200d SMA)

Annualization uses 365 trading days (crypto trades every calendar day).

---

## PRE-REGISTERED 200d RESULTS — STRATEGY vs BUY&HOLD

| Asset | Series | CAGR | Sharpe | maxDD |
|---|---|---|---|---|
| **BTC** | TSMOM | 54.3% | 1.08 | −70.3% |
| | Buy&Hold | 56.9% | 1.00 | −83.4% |
| **ETH** | TSMOM | 41.7% | 0.89 | −71.4% |
| | Buy&Hold | 14.7% | 0.58 | −86.4% |
| **POOLED** | TSMOM | 40.7% | 0.97 | −60.0% |
| | Buy&Hold | 25.8% | 0.68 | −76.3% |

### Both-halves Sharpe (strategy vs B&H)

| Asset | H1 strat | H1 B&H | H2 strat | H2 B&H |
|---|---|---|---|---|
| BTC | 1.35 | 1.41 | 0.72 | 0.44 |
| ETH | 1.09 | 0.78 | 0.63 | 0.33 |
| POOLED | 1.10 | 0.85 | 0.82 | 0.47 |

---

## GATE TABLE — PASS/FAIL per criterion (200d, the verdict)

| Asset | G1 Sharpe≥0.8 | G2 beats B&H | G3 DD reduced ≥30% | G4 holds both halves | **VERDICT** |
|---|---|---|---|---|---|
| **BTC** | ✅ (1.08) | ✅ (1.08>1.00) | ❌ (15.7% reduction) | ❌ (H1 no / H2 no) | **FAIL** |
| **ETH** | ✅ (0.89) | ✅ (0.89>0.58) | ❌ (17.3% reduction) | ❌ (H1 no / H2 no) | **FAIL** |
| **POOLED** | ✅ (0.97) | ✅ (0.97>0.68) | ❌ (21.4% reduction) | ❌ (H1 no / H2 yes) | **FAIL** |

> G4 ("holds in both halves") is evaluated as the **full gate applied inside each half** (Sharpe≥0.8 AND beats B&H AND DD reduced ≥30% within that half). It fails everywhere because the ≥30% DD-reduction sub-test is not met within the halves either.

### OVERALL VERDICT: **FAIL on all three (BTC, ETH, pooled).**

**Why it fails:** TSMOM does improve risk-adjusted return (Sharpe up on ETH/pooled, roughly flat on BTC) and it cuts drawdown — but **not by enough**. The 200d filter only reduces max drawdown by 16–21% versus buy-and-hold, well short of the pre-committed ≥30% bar. The reason is structural: a 200-day SMA is slow, so the strategy is still fully long deep into every crypto bear leg before it exits, eating most of the initial crash. The headline "trend-following controls crypto drawdown" claim, at the canonical 200d spec, **does not clear our own pre-registered threshold.** Per the kill rule, it is shelved.

---

## FOOTNOTE — INFORMATIONAL ONLY

**Not the pre-registered spec. Shown for context. NOT used for the verdict.** Reporting these is explicitly *not* a search for a passing lookback — the 200d verdict stands regardless.

| Lookback | Asset | strat Sharpe | B&H Sharpe | DD reduction | (info) gate |
|---|---|---|---|---|---|
| 100d | BTC | 1.32 | 1.05 | 25.6% | FAIL |
| 100d | ETH | 0.69 | 0.51 | 18.5% | FAIL |
| 100d | POOLED | 0.92 | 0.60 | 36.4% | FAIL |
| 50d | BTC | 1.38 | 1.05 | 28.7% | FAIL |
| 50d | ETH | 0.92 | 0.55 | 35.3% | FAIL |
| 50d | POOLED | 1.08 | 0.60 | 36.0% | FAIL |

Even faster filters (which exit sooner and therefore cut more drawdown) still fail the full gate — chiefly the both-halves requirement. This reinforces, rather than rescues, the kill: nothing here is a robust, dual-half edge at the pre-registered standard.

---

## DISPOSITION

Crypto TSMOM (200d absolute momentum, BTC/ETH, long-flat) is **SHELVED** for this program by the kill-by-default rule. It is a reasonable *risk-management overlay* on crypto already held (it does cut volatility and shave drawdown), but it does **not** meet the pre-registered edge bar and is **not** promoted to a validated edge. The validated edge set is unchanged (Sharia+liquid momentum combo + seasonal DD overlay).
