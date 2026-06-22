# server.mjs helper extraction — design (server split, phase 1)

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Extract the cleanly-decoupled top-level helper functions + constants out of `dashboard/server.mjs` (4065 lines, 97 routes) into 4 focused flat modules. Behavior-equivalent. The `createServer` dispatcher + 97 routes stay in server.mjs (full router modularization is a later phase).

## Problem

`dashboard/server.mjs` is a 4065-line monolith — the platform-audit's other "100 routes in one file" liability. It mixes ~30 top-level helpers, module-level mutable state, and one giant `createServer` closure holding all 97 routes. Unlike the browser files (Phases 1/2), this is real ESM, so extraction is a genuine refactor (free-variable refs must resolve via imports/params), not a byte-identical slice. The safety net is stronger: backend `.mjs` test suites + `pw-verify` hitting real endpoints + every route is curl-able.

## Goal / success criteria

- 4 new modules; server.mjs ~4065 → ~3745 lines.
- Behavior-equivalent: all endpoints respond as before; full suite + pw-verify green.
- Modules are `state`-free and import nothing from server.mjs (no cycles) → independently testable later.
- Single revertable commit.

## Non-goals (later phases)

- Full router modularization (split the 97 routes into domain router modules).
- Extracting the `state`/scan/CDP-coupled helpers (`computeRegime`, `getSymbolMetrics`, `captureScreenshot`, `broadcastSSE`/sse, auto-scan cluster).
- New unit tests for the now-extractable pure functions (modules become test-ready; tests are a follow-on).

## Module layout

Four new flat snake_case modules (matching `momentum_screen.mjs`/`blockdeal_signal.mjs`):

| New module | Moves out of server.mjs (approx source lines) | Notes |
|---|---|---|
| `dashboard/notify.mjs` | `sendTelegram` (56) | pure (fetch) |
| `dashboard/news.mjs` | `newsCache` (142), `NEWS_TTL` (143), `fetchGoogleNews` (145), `getEarningsCalendar` (128) | owns its cache; `getEarningsCalendar` gains a `finnhubToken` param |
| `dashboard/macro.mjs` | `MACRO_EVENTS` (174), `getUpcomingEvents` (245) | pure data + fn |
| `dashboard/signal_format.mjs` | `tickerDisplay` (53), `BIAS_RANK` (367), `BEAR_BIASES` (368), `CRIT_LABELS` (435), `resolveSignalLabel` (375), `computeVelocity` (384), `sectorOf` (397), `getCritPasses` (422), `computeDelta` (444) | self-contained cluster; `computeDelta` gains a `scoreHistory` param |

server.mjs gains 4 `import` lines and loses these definitions.

**Stays in server.mjs** (coupled to `state`/scan/CDP): `computeRegime`, `getSymbolMetrics`, `captureScreenshot`, `broadcastSSE`/`sseClients`, auto-scan cluster (`AUTO_SCAN_TIMES`/`autoScanLog`/`loadAutoScanLog`/`saveAutoScanLog`/`getNextAutoScanSlot`/`checkAutoScan`), `state` + loaders, overview cache + symbols.

No import cycles: the 4 modules import nothing from server.mjs (the two `state` reads become params). Within `signal_format.mjs`, `computeDelta` calls `getCritPasses` and uses `BEAR_BIASES`/`BIAS_RANK` — all co-located.

## The two signature changes (only non-mechanical part)

Everything else is move-and-import. Two functions read `state`; they become parameterized:

**`getEarningsCalendar(sym)` → `getEarningsCalendar(sym, finnhubToken)`** — internal `state.settings?.finnhub_token` becomes the param. Two call sites in server.mjs (lines 1748, 2834) pass `state.settings?.finnhub_token`.

**`computeDelta(newResults, prevResults)` → `computeDelta(newResults, prevResults, scoreHistory)`** — internal `state.score_history` becomes the param. One call site (line 1224) passes `state.score_history`.

All other moved functions keep identical signatures.

## Verification (behavior-equivalence — no byte guard)

- `node --check` on server.mjs + all 4 new modules.
- Server boots clean (missing import/ref throws at load); `curl /` → 200.
- Curl the affected endpoints, each → 200 / well-formed JSON (not 500):
  - Telegram test (`sendTelegram`), news (`fetchGoogleNews`), earnings (`getEarningsCalendar`+token), macro calendar (`getUpcomingEvents`), scan delta (`computeDelta`+scoreHistory), a scan/screener response (`sectorOf`/`computeVelocity`/`getCritPasses`/`resolveSignalLabel`).
- `pw-verify` 8/8 tabs, 0 console errors.
- Full suite: `test:unit` 29, `test:strategy` 22, `test:money` 51 — green (server.mjs is money-adjacent; autorun-tests rule applies).

## Risk register

| Risk | Mitigation |
|---|---|
| Missed reference in a moved fn | `node --check` + server-boot throw + endpoint curl |
| Wrong param threading (token/scoreHistory) | curl earnings + scan-delta specifically |
| Behavior drift | suite + pw-verify |
| Import cycle | none — modules import nothing from server.mjs (verified) |

## Rollback

Single commit; `git revert`.
