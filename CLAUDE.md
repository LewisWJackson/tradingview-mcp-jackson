# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this project is

A local MCP (Model Context Protocol) server that bridges Claude Code to the **TradingView Desktop app** running on the user's own machine, via **Chrome DevTools Protocol on port 9222**. It exposes ~81 MCP tools that read and control a live chart. Everything runs locally — no network calls to TradingView servers, no data egress.

It's also available as a `tv` CLI that wraps the same core functions with pipe-friendly JSON output.

This is a fork of [tradesdontlie/tradingview-mcp](https://github.com/tradesdontlie/tradingview-mcp) that adds a `morning_brief` workflow, a `rules.json` config, and a launch-bug fix for TradingView Desktop v2.14+.

## Architecture

```
Claude Code  ←→  MCP Server (stdio)  ←→  CDP (localhost:9222)  ←→  TradingView Desktop (Electron)
```

The key architectural pattern is a **three-layer split**:

- `src/core/*.js` — pure business logic. Each file is a domain (chart, data, pine, replay, alerts, etc.). Callable programmatically via `import { chart } from 'tradingview-mcp/core'`. **No MCP or CLI concerns here.**
- `src/tools/*.js` — thin MCP tool wrappers. Each `register*Tools(server)` function calls into the matching `core/` module, validates inputs with zod, and formats output via `_format.js`'s `jsonResult`.
- `src/cli/` — the `tv` CLI router and commands. Same pattern: commands call into `core/`.

This split is **intentional and load-bearing**. When adding a new capability:
1. Put the implementation in `src/core/` (testable in isolation, no MCP needed)
2. Add an MCP wrapper in `src/tools/`
3. Optionally add a CLI command in `src/cli/commands/`

Tests in `tests/` exercise the core layer directly — they do not depend on a running TradingView instance unless the file name includes `e2e`.

### CDP connection layer

`src/connection.js` owns the singleton CDP client. It caches a live client and re-connects on liveness failures. `KNOWN_PATHS` at the top of that file is the discovered set of TradingView internal APIs (e.g. `window.TradingViewApi._activeChartWidgetWV.value()`) — adding a new capability that needs a new API path means updating this file.

### Pine graphics data path

Custom Pine indicators draw via `line.new()`, `label.new()`, `table.new()`, `box.new()`. These are invisible to the normal chart-reading APIs. They're read via:
```
study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById
```
This path is brittle — if TradingView updates their internals, pine-graphics tools are the first thing to break. The `data_get_pine_*` tools in `src/core/data.js` handle this path with fallbacks.

### Tool count

`src/server.js` calls ~15 `register*Tools(server)` functions to register tools. Total across all groups is about 81 tools. The server instructions string inside `server.js` and this `CLAUDE.md` should stay in rough sync — they're the two places that document tool selection for an LLM client.

## Commands

### Install and run
```bash
npm install
node src/server.js          # run the MCP server directly (stdio)
npm start                   # same as above
npm link                    # install tv CLI globally (one-time)
tv status                   # verify CDP is connected
tv brief                    # run the morning brief workflow
```

### Tests
```bash
npm test                    # default: e2e + pine_analyze (requires TradingView for e2e)
npm run test:unit           # offline unit tests only (pine_analyze + cli)
npm run test:cli            # just the CLI tests
npm run test:e2e            # e2e against live TradingView
npm run test:all            # everything
npm run test:verbose        # with spec reporter for detailed output

# Run a single test file:
node --test tests/pine_analyze.test.js
# Run a single test within a file (Node's built-in runner syntax):
node --test --test-name-pattern="specific test name" tests/pine_analyze.test.js
```

The `test:unit` target is the fast path — it runs without needing TradingView open.

### Launching TradingView with CDP
```bash
# Windows
scripts/launch_tv_debug.bat

# Mac
./scripts/launch_tv_debug_mac.sh

# Linux
./scripts/launch_tv_debug_linux.sh

# Or from within Claude: use the tv_launch tool (auto-detects platform)
```

TradingView must run with `--remote-debugging-port=9222` for the MCP server to connect. If `tv_health_check` returns `cdp_connected: false`, TradingView isn't launched correctly.

## Tool selection for a running chart

When operating on a user's TradingView chart via the MCP tools, use this decision tree:

### "What's on my chart right now?"
1. `chart_get_state` → symbol, timeframe, chart type, all indicators with entity IDs
2. `data_get_study_values` → current numeric values from visible indicators
3. `quote_get` → real-time price, OHLC, volume

### "What levels/lines/labels are drawn on the chart?"
Custom Pine indicators draw via `line.new()`, `label.new()`, `table.new()`, `box.new()`. Normal data tools can't see these. Use:
- `data_get_pine_lines` → horizontal price levels (deduplicated, sorted)
- `data_get_pine_labels` → text annotations with prices
- `data_get_pine_tables` → table rows
- `data_get_pine_boxes` → price zones as `{high, low}`

**Always pass `study_filter`** to target a specific indicator by name substring. Indicators must be **visible** on the chart for these to work.

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats
- `data_get_ohlcv` without summary → raw bars (use `count` to limit, capped at 500)
- `quote_get` → single latest snapshot

### Full chart analysis workflow
1. `quote_get` → current price
2. `data_get_study_values` → all indicator readings
3. `data_get_pine_lines` → key levels from custom indicators
4. `data_get_pine_labels` → labeled levels with context
5. `data_get_pine_tables` → session stats / analytics
6. `data_get_ohlcv` with `summary: true` → price action summary
7. `capture_screenshot` → visual confirmation

### Changing the chart
- `chart_set_symbol` / `chart_set_timeframe` / `chart_set_type`
- `chart_manage_indicator` — add/remove studies. **Requires full names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB".
- `indicator_set_inputs` / `indicator_toggle_visibility`
- `chart_scroll_to_date` / `chart_set_visible_range`

### Pine Script development
1. `pine_set_source` → inject code
2. `pine_smart_compile` → compile + error check
3. `pine_get_errors` → read errors
4. `pine_get_console` → read `log.info()` output
5. `pine_save` → save to TradingView cloud
6. `pine_new` / `pine_open` — create blank / load saved

**Warning:** `pine_get_source` can return 200KB+ for complex scripts. Avoid unless editing.

### Replay practice
`replay_start` → `replay_step` / `replay_autoplay` → `replay_trade` → `replay_status` → `replay_stop`

### Other groups
- `batch_run` — run action across multiple symbols/timeframes
- `draw_shape` / `draw_list` / `draw_remove_one` / `draw_clear`
- `alert_create` / `alert_list` / `alert_delete`
- `ui_open_panel` / `ui_click` / `layout_switch` / `ui_fullscreen`
- `capture_screenshot` (regions: "full", "chart", "strategy_tester")
- `pane_set_layout` (grids: `s`, `2h`, `2v`, `2x2`, `4`, `6`, `8`), `pane_set_symbol`, `pane_focus`
- `tab_list` / `tab_new` / `tab_close` / `tab_switch`
- `tv_launch` / `tv_health_check` / `tv_discover` / `tv_ui_state`

## Context management rules (important for any chart-reading session)

These tools can return large payloads. Follow these rules to keep context clean:

1. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars.
2. **Always use `study_filter`** on pine tools when you know which indicator you want.
3. **Never use `verbose: true`** on pine tools unless the user asks for raw drawing data.
4. **Avoid `pine_get_source`** on complex scripts (can be 200KB+). Only read if editing.
5. **Avoid `data_get_indicator`** on protected/encrypted indicators — use `data_get_study_values` instead.
6. **Prefer `capture_screenshot`** for visual context over pulling large datasets. A screenshot's tool result is a file path (~300 bytes), not the image data.
7. **Call `chart_get_state` once** at the start of a session. Entity IDs are session-specific; reuse them instead of re-calling.
8. **Cap OHLCV requests**: `count: 20` for quick analysis, `count: 100` for deeper work, `count: 500` only when specifically needed.

Rough output sizes (compact mode):

| Tool | Typical output |
|---|---|
| `quote_get` | ~200 B |
| `data_get_study_values` | ~500 B |
| `data_get_pine_lines` | ~1–3 KB per study |
| `data_get_pine_labels` | ~2–5 KB per study (capped at 50 labels) |
| `data_get_ohlcv` (summary) | ~500 B |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 B (path only) |

## Tool return conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs from `chart_get_state` are **session-specific** — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to work
- `chart_manage_indicator` requires **full** indicator names (see above)
- Screenshots save to `screenshots/` with timestamps
- OHLCV capped at 500 bars; trades capped at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Morning brief and rules.json

`rules.json` holds the user's trading rules: `watchlist`, `bias_criteria`, `risk_rules`, optional `options_day_trading` section. The `morning_brief` tool reads this file and scans each symbol in the watchlist, applying the bias criteria to produce a per-symbol read. `session_save` / `session_get` persist the output under `~/.tradingview-mcp/sessions/YYYY-MM-DD.json`.

If a user asks "run morning brief" or "my bias for today," the tool sequence is:
1. `morning_brief` (reads `rules.json`, scans watchlist, returns structured data)
2. Apply the bias criteria from `rules.json` to the data
3. `session_save` with the generated output

`rules.example.json` is the stub; users copy it to `rules.json` and edit. Never commit a user-specific `rules.json`.

## Contribution scope (from CONTRIBUTING.md)

This tool is a **local bridge**. Contributions must not:
- Connect directly to TradingView's servers (all data must go through the local Desktop app via CDP)
- Bypass authentication or subscription restrictions
- Scrape, cache, or redistribute market data
- Enable automated order execution (this is a reading/development tool, not a trading bot)
- Reverse-engineer or redistribute TradingView's proprietary code
- Access other users' data

If unsure, open an issue before submitting a PR.
