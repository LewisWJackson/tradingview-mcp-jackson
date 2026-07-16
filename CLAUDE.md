# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local MCP server + CLI (`tv`) that bridges Claude Code to a live TradingView Desktop app via the Chrome DevTools Protocol (CDP, port 9222). 81 MCP tools for reading chart state, developing Pine Script, driving chart UI, and running a rules-based "morning brief" over a watchlist. No data leaves the machine; no TradingView servers are contacted directly — everything goes through the already-authenticated Desktop app.

## Development

### Commands

```bash
npm install
npm run test:unit    # offline, no TradingView needed — cli.test.js + pine_analyze.test.js
npm run test:cli     # offline — CLI help/exit-code/error-handling tests
npm test              # ⚠️ also runs tests/e2e.test.js, which REQUIRES TradingView Desktop
npm run test:e2e      #    running with --remote-debugging-port=9222 — will hang/fail without it
npm run test:all      # unit + cli + e2e together

node --test --test-name-pattern="<substring>" tests/cli.test.js   # run a single test by name
tv status              # (after `npm link`) verify the CDP connection to TradingView
```

There is no lint or build step configured in `package.json` — don't invent one.

When changing anything under `src/`, prefer `npm run test:unit` first since it doesn't require TradingView running. Only reach for `test:e2e` when you have TradingView Desktop open with CDP enabled (`./scripts/launch_tv_debug_mac.sh` or the Windows/Linux equivalents, or the `tv_launch` tool).

### Architecture

Three interfaces share one core — always add new capability to `core/` first, then thin wrappers on top:

- **`src/core/*.js`** — the actual logic. Talks to TradingView exclusively through `src/connection.js`, which holds a single retried CDP client and an `evaluate(expression)` helper that runs JS inside the TradingView page's context. `KNOWN_PATHS` in that file lists unofficial TradingView internals (e.g. `window.TradingViewApi._activeChartWidgetWV`) discovered by probing — see `RESEARCH.md` for how those were found.
- **`src/tools/*.js`** — MCP tool definitions: zod input schema + call into the matching `core/*.js` function + `jsonResult()` (from `_format.js`) to wrap the response. Each file exports a `registerXTools(server)` function; all of them are registered in `src/server.js`, which also carries the tool-selection guide baked into the MCP server's `instructions` field.
- **`src/cli/commands/*.js`** — CLI wrappers around the *same* core functions, exposed as the `tv` bin (`src/cli/index.js`) through a small zero-dependency router (`src/cli/router.js`, built on `node:util.parseArgs`).

So a new feature is: one function in `core/`, then a matching entry in `tools/` and/or `cli/commands/`. Keep `core/` as the single source of truth — MCP and CLI wrappers should stay thin.

Other structure:
- **`skills/*/SKILL.md`** — step-by-step workflows for multi-tool tasks (`pine-develop`, `chart-analysis`, `multi-symbol-scan`, `replay-practice`, `strategy-report`). Read the relevant one before improvising a workflow that already has a documented procedure — `pine-develop` in particular defines the write → push → compile → fix-errors → screenshot loop for Pine Script work.
- **`rules.json`** (tracked in git, `rules.example.json` is the blank template) — the user's watchlist, bias criteria, and risk rules; `morning_brief` reads it automatically.
- **`scripts/current.pine`** (gitignored scratch file) — working buffer for the Pine Editor push/pull scripts (`scripts/pine_push.js`, `scripts/pine_pull.js`), used by the `pine-develop` workflow.
- **`ICT_STRATEGY_SPEC.md`** — living spec for an in-progress custom ICT/smart-money-concepts indicator built on top of this server; not part of the MCP server itself, just a working doc for that side project.

### Trade alert watcher (Pushover)

`tv trade-alert check` (`src/core/trade_alert.js`) is a standalone, session-independent alert path — it does **not** go through Claude Code. It scans every symbol in `rules.json`'s `watchlist` across every timeframe in `scan_timeframes` (falls back to just `default_timeframe` if unset) using the same `chart.js`/`data.js` primitives `morning.runBrief()` uses (but not that function itself, since it only samples one timeframe), then calls the Anthropic API directly (separate `ANTHROPIC_API_KEY`, billed per-token — see `.env.example`) with the same `rules.json` bias_criteria/risk_rules verbatim, instructed to use the higher timeframe(s) for trend/bias and lower timeframe(s) to time the entry trigger (standard ICT multi-timeframe confluence), for a genuine structured-output confidence judgment. It pushes a notification via Pushover (`PUSHOVER_USER_KEY` / `PUSHOVER_API_TOKEN` — see pushover.net) when confidence crosses `ALERT_CONFIDENCE_THRESHOLD` (default 85). The message states LONG/SHORT, the entry timeframe, and a directional probability, not just a bare confidence number. A cooldown (`ALERT_COOLDOWN_MINUTES`, default 120) per symbol+direction is tracked in `~/.tradingview-mcp/alert_state.json` to avoid repeat pushes. Requires TradingView Desktop + CDP running, same as everything else here. Schedule it with `scripts/com.tradingview-mcp.trade-alert.plist.example` (macOS launchd) or an equivalent cron job — copy it, fill in the placeholders, and `launchctl load` it. Use `--dry-run` to test without sending a notification or touching cooldown state.

Each alert also attaches a chart screenshot, captured via `capture.captureScreenshot()` and sent as a direct binary attachment in the Pushover API call (multipart `FormData`, up to 2.5MB) — no public URL or tunnel needed, since Pushover (unlike Twilio MMS) accepts the image bytes directly in the request. (An earlier version of this feature used Twilio SMS/MMS, which required a `cloudflared` quick-tunnel workaround to give Twilio a fetchable `MediaUrl`; that was dropped in favor of Pushover specifically to avoid Twilio's A2P 10DLC compliance registration, which blocked delivery entirely.) If the screenshot step fails for any reason, it falls back to a text-only notification rather than blocking the alert.

### Known fragility

- `pine_push.js` / `pine_pull.js` locate the Pine Editor's Monaco instance by walking React-fiber internals off `.monaco-editor.pine-editor-monaco` DOM nodes. TradingView can leave more than one such element in the DOM (a stale hidden instance ahead of the live one) — the code must scan all matches for the one whose fiber actually exposes a `monacoEnv`, not just take the first `querySelector` hit, or injection silently fails with "Could not inject into Pine editor".
- If no Pine Editor surface is already open, `pine_push.js` opens one itself: open the Object tree panel (`[aria-label="Object tree and data window"]`), right-click the study's row, click the "Source code…" context-menu item (real ellipsis U+2026, not "..."). This opens a full-screen "Pine Editor" modal whose Monaco instance does **not** expose `monacoEnv` at the same `memoizedProps.value.monacoEnv` path the smaller popover uses — the fiber search must also probe `memoizedState` (hooks) and duck-type on `{editor: {getEditors}}` or a direct `{getValue, setValue, getModel}` editor instance, not just look for `monacoEnv` by name. This modal's compile button is **"Add to chart"** even when a copy of the script is already on the chart — clicking it does not update the existing instance, it adds a second, duplicate one. After every push via this path, check `tv state` for a duplicate entity ID and `tv indicator remove --entity_id <old one>` before treating the push as done.
- TradingView Desktop exposes exactly one CDP endpoint (port 9222) for the whole app. If more than one Claude Code session/worktree is driving it at the same time, their `tv ui`/`tv pine`/mouse-click commands collide on the same browser tab — symptoms include the chart's timeframe or symbol changing with no corresponding command from you, stray drawings appearing, or the global `tv` CLI (`npm link`ed, `/usr/local/lib/node_modules/tradingview-mcp`) silently starting to point at a different worktree because another session re-ran `npm link` from theirs. If chart state changes unexpectedly mid-session, check `ls -la $(which tv)`'s resolved target and `ps aux | grep TradingView` before assuming your own automation is at fault.
- Symbol resolution (`chart_set_symbol` / `tv symbol --set`) goes through TradingView's own search and can resolve a bare ticker to an unexpected instrument — e.g. `GBPUSD` resolving to a CME futures contract instead of spot forex, depending on the account's linked broker. Prefer exchange-qualified symbols (`OANDA:GBPUSD`, not `GBPUSD`/`FX:GBPUSD`) and verify the result with `chart_get_state` / `tv state` (check the exchange, not just the ticker) after setting.

## Tool Selection — Decision Tree

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, list of all indicators with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators (RSI, MACD, BBands, EMAs, etc.)
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine indicators draw with `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to normal data tools. Use:

1. `data_get_pine_lines` → horizontal price levels drawn by indicators (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550", "Bias Long ✓")
3. `data_get_pine_tables` → table data formatted as rows (e.g., session stats, analytics dashboards)
4. `data_get_pine_boxes` → price zones / ranges as {high, low} pairs

Use `study_filter` parameter to target a specific indicator by name substring (e.g., `study_filter: "Profiler"`).

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key price levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context (e.g., "Settlement", "ASN O/U")
5. `data_get_pine_tables` → session stats, analytics tables
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### "Run my morning routine"
1. `morning_brief` → scans watchlist from `rules.json`, reads indicators, applies bias/risk criteria
2. `session_save` → persist today's brief to `~/.tradingview-mcp/sessions/`
3. `session_get` → retrieve today's (or yesterday's) saved brief for comparison

### "Change the chart"
- `chart_set_symbol` → switch ticker (e.g., "AAPL", "ES1!", "NYMEX:CL1!") — see symbol-resolution caveat above
- `chart_set_timeframe` → switch resolution (e.g., "1", "5", "15", "60", "D", "W")
- `chart_set_type` → switch chart style (Candles, HeikinAshi, Line, Area, Renko, etc.)
- `chart_manage_indicator` → add or remove studies (use full name: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format: "2025-01-15")
- `chart_set_visible_range` → zoom to exact date range (unix timestamps)

### "Work on Pine Script"
Follow the `pine-develop` skill. Summary:
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → remove all

### "Manage alerts"
- `alert_create` → set price alert (condition: "crossing", "greater_than", "less_than")
- `alert_list` → view active alerts
- `alert_delete` → remove alerts

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
2. **Always use `study_filter`** on pine tools when you know which indicator you want — don't scan all studies unnecessarily
3. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data with IDs/colors
4. **Avoid calling `pine_get_source`** on complex scripts — it can return 200KB+. Only read if you need to edit the code.
5. **Avoid calling `data_get_indicator`** on protected/encrypted indicators — their inputs are encoded blobs. Use `data_get_study_values` instead for current values.
6. **Use `capture_screenshot`** for visual context instead of pulling large datasets — a screenshot is ~300KB but gives you the full visual picture
7. **Call `chart_get_state` once** at the start to get entity IDs, then reference them — don't re-call repeatedly
8. **Cap your OHLCV requests** — `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs (from `chart_get_state`) are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)
- Pine graphics path for reading custom drawings directly: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## Scope boundaries (see CONTRIBUTING.md)

This is a **local bridge only**. Changes must not: connect directly to TradingView's servers (everything goes through the local Desktop app via CDP), bypass auth/subscription restrictions, scrape/cache/redistribute market data, add automated trading/order execution, or bundle/reverse-engineer TradingView's proprietary charting code.
