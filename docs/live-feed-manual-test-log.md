# Live Feed Manual Test Log

Records of E2E test runs verifying the full coiled-spring live-feed pipeline.

The automated E2E test lives at `tests/live_feed_e2e.test.js` and runs on demand:

```bash
node --test tests/live_feed_e2e.test.js
```

## What the test exercises

1. Spawns `scripts/dashboard/live_server.js` with `SHADOW_MODE=1` (no real toasts) and `MARKET_OPEN_OVERRIDE=1` (forces the poller to run regardless of NYSE clock)
2. Subscribes to `GET /events` and captures the live SSE stream
3. Injects a synthetic fire by lowering one candidate's `entry_trigger` to 1% below its current price in `scripts/scanner/coiled_spring_results.json`
4. Waits up to 60 s for the poller to detect the cross and emit a `fire` SSE event
5. Validates the event payload: ticker, price, fireStrength in {2,3}, riskFlags band, audit.activeSource, full strict tradePlan schema
6. Verifies the fire was persisted to `data/coiled_spring_fires_YYYY-MM-DD.json`
7. Restores the original scanner output (always — wrapped in `try/finally`)
8. Kills the server cleanly

The test takes around 30-60 seconds depending on poll-cycle alignment.

## Run history

| Date | Result | Notes |
|---|---|---|
| 2026-04-24 | PASS | initial run — Task 18 commit |

(Update this table after each run.)

## Manual verification checklist (when needed)

If you want to spot-check the dashboard UI yourself:

1. `SHADOW_MODE=1 PORT=3402 node scripts/dashboard/live_server.js`
2. Open `http://localhost:3402` in your browser
3. Confirm the orange `SHADOW MODE` banner is visible at the top of the Coiled Springs tab
4. Confirm `/events` is a long-running connection in DevTools Network tab
5. Manually edit one row's `entry_trigger` in `scripts/scanner/coiled_spring_results.json` (lower it below the live price) and save
6. Within ~30 s, the dashboard banner should appear and the row should get a "FIRED TODAY" badge
7. Restore the file
8. Stop the server with Ctrl+C
