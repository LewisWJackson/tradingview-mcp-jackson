# PEAD (Post-Earnings-Announcement Drift) Test — Design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Cross-sectional test of whether TASI stocks drift in the direction of their earnings-day price reaction over the following ~20 trading days (PEAD), on the ~374 matured earnings events already in `catalyst_events`. Board's above-modest layer #3 (retail-behavioral). First clean pass; reuses the index-flow event-study pipeline.

## Problem

Momentum equal-weight is the only validated edge; the two above-modest layers tested (sizing #1, flow #2) came back negative. PEAD is the strongest remaining behavioral prior: it is the most-replicated anomaly in global equity research, and a retail-dominated market (TASI) is exactly where under-reaction to earnings should be strongest. It is distinct from the earlier catalyst earnings test (which took *all* earnings → average forward return, finding mild sell-the-news): PEAD **conditions on the earnings-day reaction** and tests whether the move *continues*.

## Goal / success criteria

- A cross-sectional event study over matured earnings events: sort by earnings-day reaction, measure forward 20-day drift per quintile.
- A plain-English verdict on whether drift is monotonic in the reaction (real factor), with the tradeable long-only Q5 number net of cost.
- Reuses `catalyst_events`, `bars_cache`, and `index_flow.mjs` helpers; no new table.
- Honest about the single-window OOS limitation; underpowered banner if matured n is too small.

## Non-goals (later, only if signal shows)

- Harvesting multi-year earnings history for across-time OOS (the confirmation step if the cross-section is positive).
- SUE / consensus-estimate surprise (no estimate data for TASI; reaction is the proxy).
- A long-short product (no TASI shorting; Q5 long-only is the tradeable read; Q1 reported for factor-structure only).
- Dashboard surface / live signal. Research-grade until proven.

## Scope decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Data | The ~374 matured (≥60d old) earnings events already in `catalyst_events` (Dec-2025→Jun-2026) |
| Surprise proxy | Earnings-day **price reaction** (no analyst estimates) |
| Drift window | 20 trading days, day +2 → +22 (reaction day excluded) |
| Edge construction | Reaction quintiles; spread Q5−Q1 (benchmark-robust) + Q5 long-only net of cost |
| OOS | Within-window pseudo-OOS: March-annual season vs May-Q1 season |

## Architecture

Two new units + reuse, mirroring the index-flow study:

| Unit | Responsibility | Depends on |
|---|---|---|
| `dashboard/pead.mjs` | Pure helpers (no I/O): assign quintile from a value + breakpoints; compute quantile breakpoints; mean/spread | — |
| `scripts/pead_test.mjs` | Read matured earnings from `catalyst_events`, compute reaction + drift per event, quintile-sort, print verdict | `bars_cache.mjs`, `dashboard/db.js`, `dashboard/index_flow.mjs` (`abnormalReturn`/`sliceByDate`), `dashboard/pead.mjs` |

**Reused as-is:** `catalyst_events` (earnings rows; symbols are `TADAWUL:${code}`), `bars_cache` (`getBars`/`warm`/`iso`, `toYahooSym` from `tasi_screener`), `^TASI.SR` benchmark, `index_flow.mjs` abnormal-return helpers.

### Data model

None new. Read earnings events from `catalyst_events` via:
`SELECT sym, event_date FROM catalyst_events WHERE type='earnings'`, then in JS keep only rows whose `event_date` is a valid `YYYY-MM-DD` with month 1–12 / day 1–31 (drops the malformed `2026-31-03`-type rows), and that are matured (`event_date <= today − DRIFT_END days`).

## Data flow

1. Load matured, valid-date earnings events.
2. Warm bars for all event symbols + `^TASI.SR`.
3. For each event: find the announcement index on the benchmark + name calendars (`sliceByDate`).
   - **Reaction** = abnormal return over day [0, +1] (name vs `^TASI`), the surprise proxy.
   - **Drift** = abnormal return over day [+2, +22] (20 trading days, reaction excluded).
   - Skip if either window lacks bars (not matured / gaps) — count skips.
4. Rank all usable events by reaction; assign quintiles (Q1 lowest … Q5 highest reaction).
5. Per quintile: mean drift, n. Compute Q5−Q1 spread and Q5 long-only drift net of cost+slippage.
6. Check monotonicity (Q1≤Q2≤…≤Q5 roughly), NW-t on the spread, pseudo-OOS by season.

## The edge test (`pead_test.mjs`)

- **Reaction (surprise proxy):** `abnormalReturn(name, bench, aIdx, aIdx+1)` — earnings-day plus next day, name minus `^TASI.SR`.
- **Drift (the PEAD):** `abnormalReturn(name, bench, aIdx+2, aIdx+22)` — next 20 trading days.
- **Quintiles:** sort events by reaction, split into 5 equal groups (`pead.mjs` breakpoints + assignment).
- **Headline metrics:**
  - **Spread Q5−Q1** (benchmark cancels → robust): the cleanest factor evidence.
  - **Q5 long-only drift, net of 0.11% RT + slippage:** the tradeable, no-shorting read.
  - **Monotonicity:** drift should rise across Q1→Q5 if PEAD is real (not one quintile fluke).
  - **NW-t** on the per-event drift within Q5 and on the spread (earnings cluster by season → serial/cross correlation; NW lag handles it).
- **Pseudo-OOS:** recompute Q5−Q1 spread separately for the March-annual cohort (`event_date` in 2026-02/03) and the May-Q1 cohort (2026-04/05); the pattern should appear in both, same sign.

### Verdict gates

KEEP only if: Q5−Q1 spread positive with NW-t > 2, drift roughly monotonic across quintiles, **Q5 long-only positive net of cost** (else it's a short-side-only or untradeable effect), and the spread holds same-sign in both season cohorts. Otherwise NO SIGNAL / UNDERPOWERED (matured usable n < 100), naming the failing gate. If KEEP, it enters as a candidate under the existing state machine — never auto-promoted; across-year OOS harvest is the required confirmation before any capital.

## Point-in-time & survivorship

- **No look-ahead:** reaction and drift both measured *from* the announcement date forward; the sort uses only the reaction (known by day +1) to predict drift (day +2 onward). Entry is day +2, after the reaction is observable.
- **Survivorship:** the earnings events are from a recent 6-month window on currently-listed names; over so short a span survivorship bias is negligible (no delistings in the window of consequence). Disclosed.

## Error handling / edge cases

- **Malformed dates** (`2026-31-03`) → dropped by the validity filter.
- **Unmatured / missing bars** → event skipped, counted.
- **After-close announcements** → the [0,+1] reaction window absorbs a next-day open reaction.
- **Thin quintiles** → if usable matured n < 100, print `UNDERPOWERED` banner instead of a verdict.
- **Re-run** → read-only on `catalyst_events`; no writes, idempotent.

## Testing

- **Unit (`tests/moneypath.test.js`):** `pead.mjs` pure helpers — quantile breakpoints from a sample, quintile assignment (boundary values land in the expected bucket), spread/mean. Deterministic fixtures.
- **Study script:** run by hand (research grade); validated by finite non-NaN output on real data + a sanity check (quintiles partition all usable events, counts sum correctly).

## Risk register

| Risk | Mitigation |
|---|---|
| Single 6-month window → not robust across regimes | Disclosed; pseudo-OOS season split; across-year harvest is the named confirmation step if signal |
| Earnings clustering inflates t | Newey-West t on drift/spread |
| `^TASI` benchmark is Aramco-heavy | Spread Q5−Q1 cancels benchmark; equal-weight refinement noted for the absolute Q5 number |
| Reaction window misses after-close prints | [0,+1] two-day reaction window |
| Small n after maturity+bar filtering | Underpowered banner at n<100 |

## Rollback

Additive only (two new files, no schema change, read-only on `catalyst_events`). Delete files to roll back.
