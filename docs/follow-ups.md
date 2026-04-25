# Follow-ups & Backlog

Non-blocking items surfaced during development. Each entry should have enough context to pick up cold and a note about when it's safe to address (i.e., not during an in-flight feature branch that depends on current state).

---

## Open

### [BL-3] Strengthen Level 2 vs Level 3 visual differentiation in dashboard

**Surfaced:** 2026-04-25 pre-merge sanity check.

**What's brittle:** Banner background color is currently determined by `riskFlags.overallRiskBand` (red/yellow/green), not by `fireStrength`. A green-band Level 3 fire and a green-band Level 2 fire share identical banner styling — only the prefix text differs (`🔥 PRIORITY` vs `CONFIRMED`). For glance-readability during fast market reaction windows, a stronger visual cue is needed.

**Suggested scope:**
- Level 3 banner: gold/amber border, larger font, optional pulse animation, distinct toast sound
- Level 3 row in Coiled Springs table: subtle gold left-border (parallel to the existing red `cs-fired-today` left-border)
- Toast: prefix Level 3 with a unique emoji + bold first line
- Update `dashboard_fire_banner.test.js` with assertions for the L3-specific markers

**Estimated effort:** 1–2 hours, dashboard CSS + JS only, no schema changes.

---

### [BL-4] Refresh per-row risk chips from live fire payload

**Surfaced:** 2026-04-25 pre-merge sanity check.

**What's brittle:** The `cs-risk-chip` strip on each Coiled Springs row is rendered at build time from the scanner's stale row data. When a fire arrives via SSE, the live `riskFlags` (with current spread/liquidity/etc.) reach the banner's reason text but the per-row chips don't update.

**Suggested scope:**
- On `fire` SSE event, regenerate the chip HTML for the affected row from `f.riskFlags` (mirror the build-time `csRiskChipsHtml` logic in browser JS)
- Add a tooltip on each chip showing the underlying threshold and current value (e.g. "spread 146 bps > 50 bps threshold")
- Tests: assert that chips on a row reflect the post-fire `riskFlags` payload, not the scanner's at-build-time values

**Estimated effort:** 1–2 hours. Adds a small `renderRiskChipsClient` function called from the SSE fire handler.

---

### [BL-2] Isolate E2E test disk state to a tmp dir

**Surfaced:** 2026-04-25, while applying audit fix F1 (restart recovery).

**What's brittle:** `tests/live_feed_e2e.test.js` reads/writes the real `data/poller_state.json` and `data/coiled_spring_fires_YYYY-MM-DD.json`. With F1's fire-log-authoritative restore, multiple back-to-back E2E runs on the same trading day hit the daily-fire cap (the seeded synthetic ticker accumulates fires) and the test starts skipping or failing. The audit fix is correct; the test setup is the issue.

**Why not blocking:** the test passes cleanly after `rm -f data/poller_state.json data/coiled_spring_fires_<today>.json`. Manual cleanup is acceptable for an integration test you only run on demand.

**Suggested scope when picked up:**
1. In `tests/live_feed_e2e.test.js`, override `FIRES_BASE_DIR` and `POLLER_STATE_PATH` for the test process by passing them through env vars to the spawned `live_server.js`.
2. Update `live_server.js` to honor `FIRES_BASE_DIR` and `POLLER_STATE_PATH` env vars (with the current hardcoded paths as defaults).
3. Test cleans up the tmp dir in `finally`.

**Estimated effort:** 30-45 minutes. Two file edits + one tmpdir setup.

---

### [F5] Expand tradePlan schema with sizing + strategy variants

**Surfaced:** 2026-04-24 audit + 2026-04-25 user template review.

**What's missing in current schema:**
- `tradePlan.stock.shares`, `tradePlan.stock.stopType` (`HARD`/`TRAILING`/`MENTAL_CLOSE_BELOW`)
- `tradePlan.options.contracts`, expanded `strategy` enum (`CSP` | `CC` | `IRON_CONDOR` | `DEBIT_SPREAD`)
- Top-level `sleevePctOfRisk`, `hardExitTime`

**Why not blocking shadow mode:** the current schema's `decision` fields stay null until generation logic ships. The user only consumes `planReason` (placeholder text) during shadow validation. Sizing + strategy expansion is required BEFORE any plan-generation logic populates real values.

**Suggested scope:** schema update in `live_price_poller.js` event construction + spec §15 update + `tradePlan` placeholder shape change. ~1 hour of work.

---

### [BL-1] Fix hardcoded-date test failures in `tests/coiled_spring_scanner.test.js`

**Surfaced:** 2026-04-24, during Phase A of Coiled Spring Live Feed (feature/coiled-spring-live-feed).

**What's broken:** Three pre-existing failures observed in `npm run test:unit`:

- `scoreCatalystAwareness — awards 4 pts for earnings 30-45 days out` — fixture has a hardcoded `earningsTimestamp` that has drifted into the past; `earningsDaysOut` now evaluates to `-20547` instead of the intended 30-45 days out
- Two `CLI — pine check` tests — require a live TradingView CDP connection; they belong in `test:e2e`, not `test:unit`

**Why not fix now:** Outside the Coiled Spring Live Feed scope. Fixing would touch unrelated scanner test fixtures and the test script split. Safe to address once the live-feed branch merges.

**Suggested scope when picked up:**
1. Replace hardcoded `earningsTimestamp` in `tests/coiled_spring_scanner.test.js` with a date computed at test time (`new Date(Date.now() + 35 * 86400_000)`).
2. Move the two pine-check tests out of `test:unit` into `test:e2e` (`package.json` scripts), since they depend on `tv_health_check` returning `cdp_connected: true`.
3. Re-run `npm run test:unit` and confirm all green.

**Estimated effort:** <30 minutes.

---
