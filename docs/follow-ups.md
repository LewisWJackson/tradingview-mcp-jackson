# Follow-ups & Backlog

Non-blocking items surfaced during development. Each entry should have enough context to pick up cold and a note about when it's safe to address (i.e., not during an in-flight feature branch that depends on current state).

---

## Open

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
