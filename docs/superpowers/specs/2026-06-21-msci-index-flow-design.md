# MSCI Index-Flow Event Harvest + Edge Test — Design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Harvest MSCI Saudi Arabia index-review **adds/deletes** (2019→now), store them point-in-time, and run an event study testing whether the predictable forced flow around index inclusion/deletion is a tradeable edge. This is the data-backed execution of Test Plan #2 (`docs/research/2026-06-21-test-plan-2-flow-rebalance.md`), narrowed to the cleanest first slice.

## Problem

The validated momentum edge is the only return engine; every "smarter sizing" lever was killed (`[[edge-validation-findings]]`, compounding-geometry results). The board's #2 above-modest layer is **flow/rebalance front-running**: index funds are *forced* to buy/sell certain TASI names on *known dates* for reasons unrelated to value. If a nimble retail account can position ahead of that flow and exit into it, that is a new, low-overfit edge (the trigger is a published calendar, not a fitted pattern). No event data exists in the repo yet; this builds the minimum to test the hypothesis honestly.

## Goal / success criteria

- A point-in-time table of MSCI Saudi adds/deletes (2019→now) with announcement + effective dates.
- An event-study script producing a per-event abnormal-return verdict (NW-t, net of cost+slippage, time-split OOS).
- A plain-English KEEP/KILL verdict on the flow edge, applying the Test Plan #2 gates.
- Reuses the existing `catalysts.mjs` ingest pattern; harvest is by-hand (quarterly cadence, no daemon).

## Non-goals (later, only if the edge shows)

- FTSE reviews, IPO fast-entry index-adds (Plan #2 widening — separate spec).
- Reweights / FII (foreign-inclusion-factor) changes (messier extraction; power boost later).
- A live/automated harvester or dashboard surface. This is research-grade until an edge is proven.
- Correcting survivorship (N/A here — index names are surviving large-caps).

## Scope decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Source | MSCI Saudi index reviews only |
| Depth | Max available, 2019 EM inclusion → now (~28 quarterly reviews) |
| Event types | Adds + deletes only |
| Ingestion | Agent-assisted firecrawl extract → verified JSON → import script |

## Architecture

Four units, mirroring the catalyst pipeline (`catalysts.mjs` → `import_catalysts.mjs` → `catalyst_edge_test.mjs`):

| Unit | Responsibility | Depends on |
|---|---|---|
| `dashboard/index_events.mjs` | Own the `index_events` table; `ingest(events)` upsert + `getEvents(filter?)` | `db.js` |
| `data/index_events_harvest.json` | The verified event records (agent-produced from firecrawl extracts) | — |
| `scripts/import_index_events.mjs` | Read the JSON, validate, call `ingest()` | `index_events.mjs` |
| `dashboard/index_flow.mjs` | Pure, unit-testable helpers (no I/O): abnormal-return calc, window-slicing by date, direction sign | — |
| `scripts/index_flow_test.mjs` | Event study over stored events; print abnormal-return verdict | `bars_cache.mjs`, `tasi_screener.mjs`, `index_events.mjs`, `index_flow.mjs` |

Pure helpers live in `dashboard/index_flow.mjs` so the study's math is tested without bars (tested in `tests/moneypath.test.js`).

### Data model — `index_events` table

```sql
CREATE TABLE IF NOT EXISTS index_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sym            TEXT NOT NULL,          -- 4-digit TADAWUL code, e.g. "1120"
  action         TEXT NOT NULL,          -- 'add' | 'delete'
  review         TEXT NOT NULL,          -- review tag, e.g. "2024-11"
  announce_date  TEXT NOT NULL,          -- YYYY-MM-DD (public-info timestamp)
  effective_date TEXT NOT NULL,          -- YYYY-MM-DD (flow execution date)
  index_name     TEXT NOT NULL DEFAULT 'MSCI Saudi',
  source         TEXT,                   -- 'msci' | 'argaam' | URL
  created_at     TEXT DEFAULT (datetime('now')),
  UNIQUE(sym, effective_date, action, index_name)
);
CREATE INDEX IF NOT EXISTS idx_idxev_eff ON index_events(effective_date);
```

### Harvested JSON shape (`data/index_events_harvest.json`)

```json
[
  { "code": "1120", "name": "Al Rajhi Bank", "action": "add",
    "review": "2019-05", "announce_date": "2019-05-14",
    "effective_date": "2019-05-28", "index": "MSCI Saudi", "source": "argaam:<url>" }
]
```
`name` is retained for audit only; `code` is authoritative.

## Data flow

1. **Harvest (agent, by hand):** firecrawl_extract over public MSCI index-review add/delete pages + Argaam MSCI quarterly-review PDF summaries, one record per add/delete, capturing both dates. Cross-check the two sources where they overlap. Write verified records to `data/index_events_harvest.json`.
2. **Resolve codes:** each MSCI/Argaam name → 4-digit TADAWUL code via the existing `TASI_STOCKS` name map (`scripts/tasi_screener.mjs`); unresolved names filled manually and logged. `code` must be 4 digits.
3. **Import:** `node scripts/import_index_events.mjs` validates each record (required fields, date format, action ∈ {add,delete}, 4-digit code) and upserts into `index_events` (UNIQUE dedups re-runs).
4. **Study:** `node --experimental-sqlite scripts/index_flow_test.mjs` reads events, computes abnormal returns, prints the verdict.

## The edge test (`index_flow_test.mjs`)

For each event, using daily bars (`bars_cache.mjs`) for the name and `^TASI.SR`:
- **Abnormal return** = name return − TASI return over the same calendar window (cancels market-wide moves; the fair-benchmark rule from `[[edge-validation-findings]]`).
- **Windows:** `pre` (announce−5 → announce), `trade` (announce+1 → effective−1, the front-run), `reversal` (effective → effective+20).
- **Direction:** adds → expect positive `trade` abnormal return then reversal; deletes → expect negative (tradeable only as "avoid/don't hold" — no TASI shorting).
- **Stats:** mean abnormal return per window, Newey-West t (overlapping events), n. Net of **0.11% RT cost + an explicit slippage haircut** (parameter, default e.g. 0.15%/side; these are liquid large-caps so slippage is modest but disclosed).
- **OOS:** time-split events (earlier half derive the rule shape; later half judges) — report both.
- **Capacity:** these are index large-caps → retail-tradeable; note ADV for sanity, do not gate.

### Verdict gates (from Test Plan #2)

KEEP only if: `trade` abnormal return positive, net of cost+slippage, NW-t > 2, holds in the later (OOS) half, not driven by 1–2 events (trim-one-event robustness). Otherwise KILL with the specific failing gate. New edge → if KEEP, it enters as a **candidate** under the existing state machine (`[[shipped-state]]`), never auto-promoted.

## Point-in-time & survivorship

- **No look-ahead:** the trade is timestamped at `announce_date` (when the change became public). The `effective_date` is the exit, never treated as knowable earlier. The study only uses bars at/after `announce_date` for entry.
- **Survivorship ≈ nil:** MSCI Saudi constituents are surviving large-caps present in the Yahoo cache; the delisted-name gap that haunts the momentum backtest does not apply here. This is why the flow edge can be tested cleanly despite no survivorship-free price source.

## Error handling / edge cases

- **Missing bars** for a name around its event window → skip that event, log it (don't silently drop — count skips).
- **Unresolved name→code** → record kept out of JSON until resolved; importer rejects non-4-digit codes.
- **Date parse** → importer enforces strict `YYYY-MM-DD`; reject otherwise.
- **Re-run safety** → UNIQUE constraint makes import idempotent.
- **Thin sample** → if total tradeable events < ~20 after bar-availability filtering, the study prints an explicit "UNDERPOWERED — verdict not reliable" banner rather than a false KEEP/KILL.

## Testing

- **Unit (in `tests/moneypath.test.js`):** the pure helpers in `index_flow.mjs` — abnormal-return calc (name minus benchmark over a window), window-slicing by date, direction sign. Deterministic fixtures, no bars.
- **Import validation:** a tiny fixture JSON through `import_index_events.mjs` round-trips into the table (can fold into `test:strategy` DB tests, or a focused check).
- **Study script:** run by hand (research grade), like `catalyst_edge_test.mjs`; validated by producing finite, non-NaN output on real data + a sanity check that adds show a different sign than deletes.

## Risk register

| Risk | Mitigation |
|---|---|
| Historical MSCI lists incomplete/login-gated pre-2021 | Cross-source with Argaam PDF summaries (public S3); accept whatever depth is reachable, report actual n; underpowered-banner if thin |
| Name→code resolution errors (MSCI English names vs TADAWUL) | Authoritative 4-digit code in JSON; importer rejects non-4-digit; manual fill logged |
| Small event count → weak power | Depth maxed (2019→now); NW-t + trim-one robustness; explicit underpowered banner |
| Overlapping event windows inflate t | Newey-West t (same correction used across the edge suite) |
| Slippage assumption too optimistic | Slippage a disclosed parameter; report edge net of a conservative default |

## Rollback

Additive only (new table, new files). Drop the table / delete files; nothing existing depends on it.
