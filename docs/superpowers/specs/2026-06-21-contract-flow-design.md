# Contract-Flow (Govt/Vision-2030 Award Drift) Test — Design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Cross-sectional event study testing whether **contract awards from government / SOE / Vision-2030 counterparties, to liquid (non-micro) TASI companies, drift up over 20 trading days** after announcement. Board's above-modest layer #4 (alt-data / information edge), narrowed by feasibility to the only reachable slice. Reuses the PEAD/flow event-study pipeline on the 196 contract events already in `catalyst_events`.

## Problem

Momentum equal-weight is the only validated edge; three above-modest layers (sizing #1, flow #2, PEAD #3) came back negative. Alt-data #4's only reachable data is the **contract-award catalysts** already harvested. The earlier catalyst study tested contracts *pooled* → "flat." The untested, on-thesis refinement: condition on **counterparty** (government/SOE megaproject flow — NEOM/PIF/Vision-2030) and **company liquidity** (drop micro/Nomu noise). Award *value* is NOT in the data (only 29/196 headlines have any figure), so size-conditioning is impossible — counterparty is the feasible distinguishing cut.

## Goal / success criteria

- A study over matured contract events: classify counterparty (govt vs private), filter to liquid companies, measure 20-day forward drift.
- Plain-English verdict: do govt/Vision-2030 awards to liquid names drift, net of cost, vs private awards — with NW-t and trim-one robustness.
- Reuses `catalyst_events`, `bars_cache`, `index_flow.mjs`; one small new pure module + one study script; no new table.
- Honest UNDERPOWERED banner (the govt-liquid subset is likely small).

## Non-goals

- Award-size conditioning (no value data — the reason counterparty is the cut).
- Sentiment / Google Trends alt-data (not reachable point-in-time).
- Multi-year contract history harvest (the confirmation step if a signal appears).
- Dashboard surface / live signal. Research-grade.

## Scope decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Signal | Contract awards, conditioned on **counterparty (govt/SOE) + company liquidity** |
| Data | 196 `type='contract'` events in `catalyst_events` (Feb→Jun 2026) |
| Why not size | Award value absent from headlines (29/196, mostly false positives) |
| Drift window | 20 trading days, entry day +1, `[+1, +21]` |
| Liquidity | trailing-60d avg price×volume, keep top half of contract names |

## Architecture

| Unit | Responsibility | Depends on |
|---|---|---|
| `dashboard/contract_flow.mjs` | Pure: `classifyCounterparty(headline)` → 'govt' \| 'private'; `isContractHeadline(headline)` anti-leakage gate | — |
| `scripts/contract_flow_test.mjs` | Read contract events, classify + liquidity-filter + matured-filter, compute 20d drift, print govt-vs-private verdict | `bars_cache.mjs`, `dashboard/db.js`, `dashboard/index_flow.mjs` (`abnormalReturn`/`sliceByDate`), `dashboard/contract_flow.mjs` |

**Reused as-is:** `catalyst_events` (`type='contract'`, symbols `TADAWUL:${code}`, `headline`), `bars_cache` (`getBars`/`warm`/`iso`, `toYahooSym`), `^TASI.SR` benchmark, `index_flow.mjs` helpers.

### Counterparty classifier (`classifyCounterparty`)

Keyword match on the headline (case-insensitive). GOVT/SOE if it names a government or state-owned counterparty:
`aramco, ministry, municipalit, saudi electricity|sec\b, water (NWC), neom, pif|public investment, royal commission, national guard, authority, university, government, tatweer, red sea, roshn, diriyah, qiddiya, sabic` (Vision-2030 / SOE / ministry / public-sector terms). Else `private`. The exact term list is a tunable constant; document each term's rationale inline.

### Anti-leakage gate (`isContractHeadline`)

The `contract` classifier upstream is leaky (some rows are financial-results / capital-increase). Keep only headlines that actually denote an award: match `contract|project award|project sign|awarded|purchase order|sign off|signing of a contract|tender`. Drop the rest (counted).

## Data flow

1. Pull `SELECT sym, event_date, headline FROM catalyst_events WHERE type='contract'`.
2. Keep rows with valid `YYYY-MM-DD` date, matured (`event_date <= today − (DRIFT_DAYS+15) calendar days`), and `isContractHeadline(headline)`.
3. Warm bars for all symbols + `^TASI.SR`.
4. Per event: compute trailing-60d liquidity (avg `close×volume` over the 60 bars ending at the announcement) and the 20d forward drift = abnormal return `[+1, +21]` vs `^TASI` (two-range aligned). Skip if bars missing (counted).
5. Liquidity filter: keep events whose company liquidity is in the **top half** of the surviving set.
6. Split liquid events by counterparty (govt vs private). Report mean drift, n, NW-t per group; govt−private spread; trim-one on the govt group.

## The edge test (`contract_flow_test.mjs`)

- **Drift:** `abnAligned(nC, benchC, aN+1, aN+21, aB+1, aB+21)` — enter the day after the announcement, hold 20 trading days, abnormal vs `^TASI`.
- **Headline metric:** GOVT-liquid mean drift, **net 0.11% RT + slippage**, NW-t.
- **Comparison:** govt−private spread (does the govt/Vision-2030 tag add anything over private awards?).
- **Robustness:** trim-one on the govt-liquid group (not driven by 1–2 names).
- **Underpowered guard:** if matured govt-liquid n < `MIN_N` (default 30), print UNDERPOWERED instead of a verdict.

### Verdict gates

KEEP only if: govt-liquid drift > 0 net of cost, NW-t > 2, **beats private** (positive govt−private spread), survives trim-one, and n ≥ MIN_N. Otherwise NO SIGNAL / UNDERPOWERED, naming the failing gate. If KEEP → candidate under the existing state machine; multi-year contract harvest is the required confirmation before any capital.

## Point-in-time & survivorship

- **No look-ahead:** counterparty/liquidity from the announcement and prior bars only; entry is day +1 (after the announcement is public). Drift measured forward.
- **Survivorship ≈ nil:** 4-month recent window, currently-listed names.

## Error handling / edge cases

- **Leaky contract rows** → `isContractHeadline` gate drops non-awards (counted).
- **Missing/short bars** (micro/Nomu, recent IPOs) → event skipped (counted); the liquidity filter also removes most micro names.
- **Empty govt or private group after filtering** → report `—`, no spread; underpowered banner.
- **Malformed dates** → validity filter drops them.
- **Re-run** → read-only on `catalyst_events`; idempotent.

## Testing

- **Unit (`tests/moneypath.test.js`):** `classifyCounterparty` (Aramco/Ministry/NEOM/Municipality → 'govt'; a private-company counterparty → 'private'); `isContractHeadline` (a real award headline → true; a financial-results headline → false). Deterministic.
- **Study script:** run by hand; validated by finite non-NaN output + counts that partition (govt + private = liquid total).

## Risk register

| Risk | Mitigation |
|---|---|
| Govt-liquid subset too small (n<30) | UNDERPOWERED banner; report actual n; don't force a verdict |
| Classifier leakage (non-award rows) | `isContractHeadline` gate |
| Micro/Nomu noise dominates | top-half liquidity filter |
| Single 4-month window | disclosed; multi-year harvest = the confirmation step if signal |
| Counterparty keyword misses/false-positives | tunable term list, documented; spot-check govt/private split counts in output |
| `^TASI` Aramco-heavy benchmark | govt−private spread cancels it; absolute govt number noted as benchmark-sensitive |

## Rollback

Additive only (two files, no schema change, read-only). Delete files to roll back.
