# server foundation extraction — design (router phase, sub-1)

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Extract the `state` singleton and the `json`/`html`/`readBody` HTTP helpers out of `dashboard/server.mjs` into two small importable modules. Behavior-equivalent. First of several sub-specs that together form the "server router phase."

## Problem

`dashboard/server.mjs` (3783 lines) holds all 97 routes inside one `createServer` closure (lines 1208–2759). The routes reference a module-level `state` object (131 refs) and `json`/`html`/`readBody` helpers (169/3/35 refs). To split routes into modules later **verbatim** (no per-route edits), `state` and the helpers must first become importable — otherwise route extraction would require threading a context object through 131 `state.` references (invasive, high-risk). This sub-spec lays that foundation.

Decisive feasibility fact: `state` is declared once (`const state = {}` @240) and **never reassigned** — only its properties are mutated (`state.settings = …`, `state.positions = …`). An exported singleton therefore preserves the shared-object-reference semantics every mutation relies on. Route bodies can keep `state.x` verbatim and resolve it via `import { state }`.

## Goal / success criteria

- Two new modules; `state` + http helpers importable.
- Behavior-equivalent: all endpoints respond as before; full suite + pw-verify green.
- No call-site edits (the 131 `state.` + 207 helper refs resolve via the new imports).
- Single revertable commit.

## Non-goals (later sub-specs)

- Scan-core module (`startScan`/`broadcastSSE`/`sseClients`/auto-scan/`liveTimer`).
- Route-group modules + thin dispatcher.
- The `state`/scan/CDP-coupled helpers (`computeRegime`, `getSymbolMetrics`, `captureScreenshot`).
- Moving `DEFAULT_UNIVERSE` or the `load*` functions (they stay, referencing imported `state`).

## Module layout

| New module | Moves out of server.mjs | Imports needed | server.mjs change |
|---|---|---|---|
| `dashboard/state.mjs` | `const state = { … }` literal (lines 240–248) → `export const state` | none (pure value literal) | delete literal; add `import { state } from "./state.mjs";` |
| `dashboard/http_util.mjs` | `json` (986–989), `html` (991–997), `readBody` (999–1009) → each prefixed `export` | `import { readFileSync } from "node:fs";` (used by `html`) | delete the 3 defs; add `import { json, html, readBody } from "./http_util.mjs";` |

The `state` literal is self-contained (initial values only — `scan`, `universe`, `settings`, `positions`, `virtual`, `score_history`, `alert_rules`), no references to other module symbols. `json`/`readBody` are pure; `html` needs only `readFileSync`.

**Stays in server.mjs:** routes, `DEFAULT_UNIVERSE`, `load*` (loadSettings/Positions/Virtual/ScoreHistory/AlertRules/Universe), `updateScoreHistory`, scan machinery, all imported domain modules. These reference the now-imported `state`/helpers.

No import cycles: `state.mjs` imports nothing; `http_util.mjs` imports only `node:fs`. Neither imports from server.mjs.

## Verification (behavior-equivalence — no byte guard)

- `node --check` on server.mjs + state.mjs + http_util.mjs.
- Server boots clean (a missed `state`/helper ref throws at load or first request); `curl /` → 200 (exercises `html`).
- Curl across the helper + state surface (authed with the `.playwright-auth.json` JWT), each → 200 / normal (not 500):
  - a GET JSON route (`json`): `/api/scan/results` (also reads `state.scan`).
  - a POST write path (`readBody` + `json` + `state` mutation): settings save → then GET to confirm the write persisted (proves the singleton mutates across the import boundary).
  - `/` (`html`).
- `grep -c "Error\|ReferenceError" /tmp/mawjah-srv.log` → 0.
- `pw-verify` 8/8 tabs, 0 console errors.
- Full suite: `test:unit` 29, `test:strategy` 22, `test:money` 78 — green.

## Risk register

| Risk | Mitigation |
|---|---|
| Missed `state`/helper reference after move | `node --check` + server boot + endpoint curl |
| Shared-singleton mutation not propagating across import | verified `state` never reassigned, only property-mutated; a settings-save-then-read curl confirms live |
| A route `state.x =` write silently no-ops | curl the settings write path + read it back |
| Import cycle | none — state.mjs imports nothing; http_util.mjs imports only node:fs |

## Rollback

Single commit; `git revert`.
