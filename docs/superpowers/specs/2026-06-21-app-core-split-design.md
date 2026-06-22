# app-core.js split — Phase 2 design

**Date:** 2026-06-21
**Status:** approved (brainstorm), pending implementation plan
**Scope:** Slice the 6309-line `dashboard/assets/app-core.js` into 8 contiguous plain-`<script>` files by concern, in original order. Behavior byte-identical. No ES modules, no reordering, no logic change. Continuation of the Phase 1 index.html split (commit `8994ece`).

## Problem

`dashboard/assets/app-core.js` (extracted in Phase 1) is 6309 lines — the largest remaining single file, 311 top-level declarations sharing one global scope. Still the platform-audit "can't hold in context / one bad bracket kills the app" liability, just relocated out of index.html.

Constraints:
- **51 distinct functions are called from inline HTML handlers** in index.html (`onclick="switchTab()"` etc.; 120 handler refs total). They work only because everything is global. **True ES modules would break all 51** unless each is `window.`-attached — high risk with only `pw-verify` as the net. Therefore: plain `<script src>`, global scope preserved.
- No build step; `/assets/` route already serves any `.js` — **no server change needed**.
- Function declarations hoist **within** a file, not across files.

## Goal / success criteria

- `app-core.js` replaced by 8 files of ~450–1050 lines each, each `node --check`-clean and holdable in context.
- Behavior byte-identical: concatenation of the 8 slices in order === original `app-core.js`.
- `pw-verify` 8/8 tabs, 0 console errors. Full suite (102) green.
- Single revertable commit.

## Non-goals (Phase 3+)

- True ES modules / encapsulation; `window.`-attaching handlers.
- Reordering functions by concern; deduping cross-slice helpers.
- `server.mjs` route split.

## File layout & boundaries

Cut into 8 contiguous slices at top-level declaration seams, original order preserved. In index.html, the single `<script src="/assets/app-core.js"></script>` becomes 8 `<script src>` in numeric order, still between `auth.js` and `app-lab.js`. `app-core.js` deleted.

| # | File | Lines | Cut-line marker (start) | Concern |
|---|---|---|---|---|
| 1 | `app-core-01-i18n-fmt.js` | 1–790 | (file start) | translations TR/EXPL, lang, viewMode, currency, sector maps, clock |
| 2 | `app-core-02-screener.js` | 791–1244 | `function switchTab(name,btn){` | tabs, universe, filters, table controls, scan, live/SSE, sort, drawer backtest |
| 3 | `app-core-03-panels.js` | 1245–1887 | `const calCache={};` | calendar, risk, trades, positions, settings, breadth, heatmap, movers, pre-signal |
| 4 | `app-core-04-table-drawer-nav.js` | 1888–2897 | `function shariaHtml(sym){` | badges, renderTable, row click, drawer nav, watchlist, archive, native chart, TV actions, alert rules |
| 5 | `app-core-05-markets-portfolio.js` | 2898–3946 | `const divCache={};` | dividends, markets, playbook, strategy-validation, virtual portfolio, regime, sizer, criteria table |
| 6 | `app-core-06-drawer-analysis.js` | 3947–4943 | `function get360TechPillar(r) {` | 360 pillars/synthesis, dynamics/vol cards, signal/trade/analysis/fundamentals tabs, Kelly |
| 7 | `app-core-07-drawer-scan-init.js` | 4944–5640 | `function openDrawer(r){` | openDrawer, buildDrawerBody, criteria editor, fmt helpers, startScan, poll, `init()` |
| 8 | `app-core-08-feeds-misc.js` | 5641–6309 | `const TYPE_LABELS = { fed:'Fed',` | macro, sector breadth, exit, correlation, whale, block deals, glossary, CMA, market status, checklist |

Each `slice(prevStart-1, thisStart-1)`; slice 8 runs to EOF (6309).

## Load-order safety

Function declarations hoist within a file only. The hazard: an early-file top-level immediate statement calling a function a cut pushed into a later file. Audit found **6 top-level immediate-execution statements**, all safe under this slicing:

| Line | Statement | Needs | Safe because |
|---|---|---|---|
| 649 | `if (scanMode === 'invest') {…}` | `scanMode` (decl 612) | same slice (F1) |
| 786 | `setInterval(updateClock,1000); updateClock();` | `updateClock` (780) | same slice (F1) |
| 5591 | `document.addEventListener('keydown', …)` | — | handler body deferred; all files loaded by keypress |
| 5638 | `setInterval(loadAutoScanStatus, 60*1000)` | `loadAutoScanStatus` (5600) | same slice (F7) |
| 5939 | `init();` | `init` (5540, F7) | F7 loads before F8; init body reaches all earlier slices |
| 6201 | `setInterval(updateMarketStatus,30000); updateMarketStatus();` | `updateMarketStatus` (6178) | same slice (F8) |

Invariant the builder preserves: never cut between an immediate statement and an earlier symbol it references — satisfied by all chosen cut lines. `init()` works today before `app-lab.js`/`app-init.js` load, so it references only core symbols — unchanged. The 51 onclick handlers fire after full load → unaffected.

## Execution

One-shot deterministic builder `scripts/split_core.mjs` (untracked):
1. Read `dashboard/assets/app-core.js`; assert each cut line starts with its expected marker (exact prefix; abort if any moved).
2. Write 8 slices via exact line ranges (bytes preserved).
3. Rewrite `index.html`: replace the lone `app-core.js` script tag with 8 `app-core-0N-*.js` tags in order.
4. Delete `app-core.js`.

## Verification gate (all pass before commit)

- **Byte-equivalence:** concat of the 8 slices (joined as written) === original `app-core.js` (saved `.orig`). Exact, includes inter-slice joins.
- `node --check` on each of the 8 files (syntax; cross-file globals are intentionally not resolved by --check).
- index.html links exactly 8 `app-core-0N-*.js` in order 1→8; no remaining `app-core.js` reference.
- Restart server; `pw-verify` → 8/8 tabs, 0 console errors (the real net for load-order/missing-global/404).
- Full suite (`test:unit` 29, `test:strategy` 22, `test:money` 51) green — should be untouched (no `.mjs` change, no route change).

## Risk register

| Risk | Mitigation |
|---|---|
| Cut splits a hoisted forward-call | load-order audit (6 statements, all same/earlier slice); pw-verify catches |
| Mid-declaration cut | all cut lines are col-0 declaration starts; `node --check` per file |
| Content drift | byte-equivalence guard vs `.orig` |
| Missing-asset 404 / load break | pw-verify console-errors |
| Stale browser cache | `/assets/` route already sends `Cache-Control: no-cache` |

## Rollback

Single commit; `git revert` restores `app-core.js`. During the run, `.orig` snapshot restores instantly.
