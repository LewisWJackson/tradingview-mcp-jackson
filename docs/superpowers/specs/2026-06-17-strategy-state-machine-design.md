# Strategy State Machine — Design Spec

**Date:** 2026-06-17
**Status:** Approved (brainstorm)
**Context:** Lab self-learning roadmap, P2. Builds on P0+P1 (commit 38b6bc8): cost fixed to 0.11%, per-signal families tagged experimental, `strategy_validation.mjs` grades strategies per rebalance period.

## Goal

A transparent, rule-driven governor that moves each **trading strategy** through a lifecycle based on accumulated out-of-sample evidence, and feeds that verdict into live position sizing. "Self-learning" = a disciplined evidence accumulator with guardrails, **not** an ML model that retrains on noise. The machine only ever *reduces* risk on its own; *adding* risk always needs a human.

## Scope

- **Governs strategies only** (momentum-sharia, block-deals, future ones). Per-signal families stay statically tagged `experimental`/`retired` — never auto-promoted (avoids thin-data flukes).
- Out of scope: meta-weighting across multiple promoted strategies (that is P4, after ≥2 strategies are promoted).

## States

`candidate → promoted → decaying → retired`, with manual recovery `decaying|retired → promoted`.

| State | Meaning | exposure_mult |
|---|---|---|
| candidate | Accumulating evidence; not your money yet | 0 |
| promoted | You confirmed; live at full Scheme-D sizing | 1.0 |
| decaying | Edge weakening; auto-reduced, warning | 0.5 |
| retired | Edge gone / crashed; auto-excluded | 0 |

## Transition model (asymmetric)

The machine can **only move a strategy down** (cut risk) automatically. **Every move up** (add risk), including recovery, requires a user click.

### AUTO transitions (machine fires; risk-reducing)

| From → To | Trigger (any) | exposure_mult |
|---|---|---|
| promoted → decaying | rolling-12 mean-excess < 0 · OR rolling-12 t < 1.0 · OR current DD < −20% | 1.0 → 0.5 |
| promoted/decaying → retired | rolling-18 mean-excess < 0 (sustained) · OR current DD ≤ −30% (circuit-breaker) | → 0 |

### MANUAL transitions (machine recommends; user confirms; risk-adding)

| From → To | Recommended when | Action |
|---|---|---|
| candidate → promoted | n≥24 AND t>2 AND both-halves t>1.5 AND net>0 | user clicks Promote |
| decaying\|retired → promoted (recovery) | rolling-12 t>2 AND rolling-12 mean>0 | user clicks Re-promote |

The drawdown circuit-breaker (−30%) retires regardless of rolling stats (fast crash beats slow stats). New strategies start `candidate` (exposure 0).

### Config constants (tunable, not magic numbers)

```
PROMOTE_MIN_N=24  PROMOTE_T=2.0  PROMOTE_HALF_T=1.5
ROLL_WINDOW=12    DECAY_ROLL_T=1.0   DECAY_DD=-0.20
RETIRE_WINDOW=18  RETIRE_DD=-0.30
```

## Evidence inputs

Computed by `strategy_validation.mjs` from the per-period excess series:
- Lifetime: n, mean excess, t, both-halves t (already produced).
- Rolling: last `ROLL_WINDOW`/`RETIRE_WINDOW` periods → mean-excess, t.
- Current drawdown: `equity_now / running_peak − 1` of the compounded per-period abs equity (live, not lifetime-max).

## Architecture

**New module:** `dashboard/strategy_state.mjs` — pure transition logic + DB persistence. `strategy_validation.mjs` stays the evidence producer; the state machine is the governor.

**Data model — two tables (db.js):**

```sql
CREATE TABLE strategy_state (
  strategy_id   TEXT PRIMARY KEY,
  state         TEXT NOT NULL,      -- candidate|promoted|decaying|retired
  since         TEXT,               -- date entered this state
  evidence      TEXT,               -- JSON snapshot that set it
  exposure_mult REAL NOT NULL DEFAULT 0,
  updated_at    TEXT
);
CREATE TABLE strategy_transitions (   -- append-only audit log = the "memory"
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL,
  from_state  TEXT, to_state TEXT NOT NULL,
  reason      TEXT,                  -- human-readable trigger
  actor       TEXT NOT NULL,         -- 'auto' | 'user'
  evidence    TEXT,                  -- JSON snapshot
  at          TEXT NOT NULL
);
```

**Data flow:**
```
daily grade cycle (server.mjs ~597)
  → strategy_validation.getStrategyValidation()   (per-period stats + rolling + current DD)
  → strategy_state.evaluate(stats)                (apply AUTO transitions, append log, set exposure_mult)
momentum_screen.getMomentumScreen()
  → reads strategy_state.exposure_mult
  → effective_exposure = SchemeD_exposure × exposure_mult
user clicks Promote
  → POST /api/lab/strategy/promote {id}           (gate re-checked, apply MANUAL up-transition, append log)
```

**Evaluation hook:** piggyback the existing once-a-day `gradePending` tick (server.mjs ~597). No new scheduler.

## Sizing feedback

`exposure_mult` composes with Scheme D in `momentum_screen.mjs`:
`effective exposure = SchemeD_exposure × state_mult`.
Scheme D decides how much *given it's on*; the state machine decides *whether it's on*. Momentum displays as `candidate` (0% deployed) until the user clicks Promote once; thereafter auto decay/retire can pull it back. Block-deals stays `candidate` (oc-t ~1.9 < 2 fails the gate).

## API

- `GET /api/lab/strategy` (extend) → add `state`, `exposure_mult`, `recommended_action`, recent `transitions`.
- `POST /api/lab/strategy/promote {id}` (auth) → manual up-transition; re-checks the gate (rejects if not met); writes state + log.

## UI (Strategy Edge card)

- State badge (promoted/candidate/decaying/retired).
- **Promote** button shown only when `recommended_action === 'promote'`.
- Transition timeline ("developed over time"): e.g. `2026-06 candidate→promoted (you) · 2026-09 →decaying (auto: rolling t 0.8)`.
- Effective-exposure line reflecting `state_mult`.
- Plain-English tooltips throughout (per standing preference).

## Testing

`tests/strategy_state.test.js` (`node --test`) — the machine is pure logic; test every rule with synthetic evidence:
- promote gate pass / each-condition-fail
- auto decay on rolling-12 mean<0; on rolling-12 t<1; on DD<−20%
- auto retire on rolling-18 mean<0; on DD≤−30% circuit-breaker
- no auto candidate→promoted
- recovery recommends but does not auto-apply
- exposure_mult correct per state

## Out of scope / future

- P3: regime-conditioned calibration + data-sufficiency meter + decay flags on per-signal calibration.
- P4: meta-weighting across ≥2 promoted strategies (risk-parity, held-out validated).
