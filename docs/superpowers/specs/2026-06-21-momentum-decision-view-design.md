# Momentum Monthly-Decision View (Harden Package) — Design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Close the research→action gap on the one validated edge (Sharia momentum). Turn the existing momentum screen from a stats view into a monthly *decision*: BUY/HOLD/SELL vs the user's actual holdings, the strategy-state badge where the picks are, and a SAR-per-name sizing calculator. Server + UI; reuses the existing `/api/lab/momentum` surface; no new table.

## Problem

The momentum screen (`getMomentumScreen` → `/api/lab/momentum` → `loadMomentumScreen` in `app-lab.js`) already returns the live picks, Scheme-D sizing %, cash %, per-name %, seasonal flag, next-rebalance date, and realized vol — but it does NOT tell the user **what to trade this month**, **why the size is what it is** (state is shown in a different Lab section), or **how many SAR per name**. The audit (2026-06-21) put the decision view at ~60% complete. This closes the gap so the proven edge is actually harvestable with discipline.

## Goal / success criteria

- `/api/lab/momentum` response gains: `turnover{buy,hold,sell}` (vs the user's real positions), `state{status,exposure_mult,reason}`, and `sizing.breakdown` (the components behind the final exposure %).
- The momentum tab renders: a strategy-state badge, a BUY/HOLD/SELL action block, and a SAR calculator (account size → per-name SAR + total deployed + cash).
- Pure, unit-tested helpers for the new logic; behavior-equivalent for everything already there.
- No new table; reuses `state.positions`, `getState`/`transitions`, and the existing sizing fields.

## Non-goals

- Broker/"execute" buttons or order placement (the user trades externally on Derayah).
- Storing pick history / snapshot-forward turnover (turnover is vs live positions — basis A).
- Changing the edge, the screen logic, or sizing math.
- Reconciling non-strategy holdings intelligently (see the SELL assumption below).

## Scope decisions (locked in brainstorm)

| Decision | Choice |
|---|---|
| Turnover basis | **A — vs the user's actual `positions`** (BUY=pick∖held, HOLD=pick∩held, SELL=held∖picks) |
| SELL semantics | held-but-not-a-current-pick → labelled "exit — no longer a top pick" (assumes positions = the strategy book) |
| State badge source | `getState('momentum-sharia')` + latest `transitions` reason (already in the codebase) |
| SAR calc input | account size typed in the UI, pre-filled from settings capital if present |
| Persistence | none new — read `state.positions` (object keyed by `TADAWUL:${code}`) |

## Architecture

| Unit | Responsibility | Depends on |
|---|---|---|
| `dashboard/momentum_screen.mjs` (modify) | Accept `{ heldSyms }`; add `computeTurnover` + `sarPerName` pure exports; add `turnover`, `state`, `sizing.breakdown` to the response | `getState`/`transitions` from `strategy_state.mjs` (getState already imported) |
| `dashboard/server.mjs` (modify, ~line 2239) | Inject held syms: `getMomentumScreen({ heldSyms: Object.keys(state.positions || {}) })` | `state.positions` |
| `dashboard/assets/app-lab.js` (modify, `loadMomentumScreen` ~612) | Render state badge, BUY/HOLD/SELL block, SAR calculator | the enriched response |
| `tests/moneypath.test.js` (modify) | Unit-test `computeTurnover` + `sarPerName` | — |

Pure helpers live in `momentum_screen.mjs` alongside the existing `schemeDExposure`/`sizingNote` (same established pattern), so they unit-test without bars/DB.

### New pure helpers (in `momentum_screen.mjs`)

```
computeTurnover(pickSyms: string[], heldSyms: string[]) -> { buy:[], hold:[], sell:[] }
  buy  = picks not held
  hold = picks held
  sell = held not in picks
  (set operations on TADAWUL:${code} strings; order preserves pickSyms order for buy/hold)

sarPerName({ accountSize, exposurePct, nHoldings }) -> { perName, totalDeployed, cash }
  perName       = accountSize * (exposurePct/100) / nHoldings   (0 if nHoldings 0)
  totalDeployed = perName * nHoldings
  cash          = accountSize - totalDeployed
  (rounded to whole SAR in the helper; UI formats)
```

### Response additions (`getMomentumScreen`)

```jsonc
{
  // ...existing: asOf, nextRebalance, universe, params, validated, seasonal, sizing, holdings...
  "turnover": { "buy": [ {rank,sym,name,...} ], "hold": [...], "sell": [ {sym,name} ] },
  "state":    { "status": "promoted", "exposure_mult": 1.0, "reason": "<latest transition reason>" },
  "sizing":   { /* existing fields + */ "breakdown": {
      "targetVolPct": 15, "realizedVolPct": 17, "volTargetRaw": 0.88,
      "seasonalMult": 1, "stateMult": 1.0, "finalExposurePct": 85 } }
}
```
`sell` entries carry `{sym,name}` (name resolved from `TASI_STOCKS`; falls back to the code if unknown — a held non-universe name still shows its code). `buy`/`hold` reuse the existing holding objects.

## Data flow

1. Server route reads `state.positions` (object keyed by `TADAWUL:${code}`) → `heldSyms = Object.keys(...)`.
2. `getMomentumScreen({ heldSyms })` computes the screen as today, then: `turnover = computeTurnover(holdings.map(h=>h.sym), heldSyms)`; `state` from `getState('momentum-sharia')` + `transitions('momentum-sharia',1)[0]?.reason`; `sizing.breakdown` from the values already computed (targetVol, realizedVol, the `min(1,target/realized)` raw, inSeason→0/1, stateMult, final exposure).
3. UI `loadMomentumScreen` renders: **state badge** (status + exposure_mult% + reason) by the sizing banner; **BUY/HOLD/SELL** three-list block; **SAR calculator** (account-size input, pre-filled from settings capital, → per-name SAR / deployed / cash); existing picks table + seasonal banner stay.

## Error handling / edge cases

- **No positions** (table empty, current state) → `hold`/`sell` empty, all picks are `buy`; UI shows "You hold nothing in these names yet — this is your starting buy-list." (honest, not an error).
- **Held name not in TASI universe** → `sell` entry shows the code; no crash.
- **Seasonal sit-out / state retired** (exposure 0) → SAR calc shows 0 per name + 100% cash; turnover still lists what to exit.
- **nHoldings = 0** (no eligible picks) → `sarPerName` returns zeros; UI shows "no eligible picks this month."
- **Missing account size** (no settings capital, user hasn't typed) → calculator shows a prompt, no SAR numbers until entered.

## Testing

- **Unit (`tests/moneypath.test.js`):** `computeTurnover` (buy/hold/sell partition correct incl. empty-held = all-buy and held-not-in-picks = sell); `sarPerName` (per-name/deployed/cash math, nHoldings 0 → zeros, exposure 0 → all cash). Deterministic.
- **UI verification (per [[feedback-dashboard-verify]]):** DOM-assertion via `pw-verify` style — momentum tab renders the badge, the three turnover lists, and the SAR calc; 0 console errors; one top-of-tab screenshot. No mid-scroll shots.
- **Behavior-equivalence:** existing momentum fields unchanged; `npm run test:money` + `test:strategy` green; server boots; `/api/lab/momentum` 200.

## Risk register

| Risk | Mitigation |
|---|---|
| Non-strategy holdings flagged as SELL | Documented assumption (positions = strategy book); SELL label is "no longer a top pick" not "dump"; user judgment retained. Revisit with a soft "review" label only if it bites. |
| `getMomentumScreen` signature change breaks callers | Default `heldSyms = []` → existing no-arg callers still work (turnover = all-buy); only the route passes positions |
| State/transitions add latency or throw | Already called in the screen (`getState` at line 120); `transitions` is a cheap DB read; wrap reason in optional-chaining |
| UI clutter | Decision blocks placed above the stats table; existing banners reused, not duplicated |

## Rollback

Server change is additive (new response fields + optional param). UI change is contained to `loadMomentumScreen`. Revert the three files; no schema/data migration.
