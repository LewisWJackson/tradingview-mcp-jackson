---
name: run-tradingview-mcp
description: Run, launch, drive, test, or screenshot the tradingview-mcp server and its live TradingView chart. Use when asked to start the app, check the CDP connection, switch symbols, add indicators, capture a chart screenshot, call an MCP tool directly, or verify a change works against the real chart.
---

# Running tradingview-mcp

This repo has **no UI of its own**. It is a CDP client: it drives a live
TradingView chart running in a Chrome tab on `localhost:9222`. "Running the
app" therefore means two things at once — a Chrome tab with CDP open on
`tradingview.com/chart`, and this repo's code talking to it.

Three surfaces, all against that same tab:

| Surface | Entry point | Use for |
|---|---|---|
| **Driver** (start here) | `.claude/skills/run-tradingview-mcp/driver.mjs` | Launching, verifying, screenshots, symbol switching |
| MCP server (stdio) | `src/server.js` — 81 tools | What Claude Code actually consumes |
| CLI | `node src/cli/index.js` | Quick one-off reads |

All paths below are relative to the repo root
(`C:\Users\BeauJohnson\tradingview-mcp-jackson`). Verified on Windows 10,
Node v24.18.0, npm 11.16.0, Chrome 150.

## Prerequisites

Node and Chrome only — no build step, no native modules.

```bash
npm install
```

## Start the chart (required first)

TradingView **Desktop** on Windows cannot be used: it ships as an MSIX/Store
package and Windows refuses to launch its binary with extra flags
("Access is denied"), so `--remote-debugging-port` can never be passed. The
connector only needs *a* Chromium page whose URL matches
`tradingview.com/chart` (see `findChartTarget()` in `src/connection.js`), so
use Chrome:

```bash
powershell -ExecutionPolicy Bypass -File start-tradingview-cdp.ps1
```

Idempotent — reuses a live CDP session if one exists:

```
CDP already live on port 9222 - reusing it.
Ready. Chart tab: AAPL
CDP endpoint:     http://localhost:9222
```

## Run (agent path)

`driver.mjs` is the harness. It exists because the CLI and MCP tools
**report success against a chart that is not actually working** — see
Gotchas. The driver verifies, and repairs, the states they paper over.

```bash
node .claude/skills/run-tradingview-mcp/driver.mjs <cmd> [args]
```

| Command | What it does |
|---|---|
| `check` | Verify CDP + chart target **and that a symbol truly resolved**. Non-zero exit if the chart is stale. |
| `dismiss` | Remove the anonymous signup modal covering the chart |
| `symbol <SYM>` | Switch symbol by page navigation (the only way that works logged out), poll until resolved |
| `study "<Name>"` | Add a study and repair its zero-height pane |
| `panes` | Repair zero-height panes so study values become readable |
| `shot [label]` | Screenshot → `screenshots/<label>_<symbol>_<tf>.png` |
| `mcp <tool> [json]` | One-shot MCP tool call over stdio |
| `smoke [SYM]` | Full end-to-end: check → dismiss → symbol → study → screenshot |

### Verify the chart is alive

Always run this first. It is the only check that distinguishes a working
chart from a stale one:

```bash
node .claude/skills/run-tradingview-mcp/driver.mjs check
```

Healthy:

```json
{
  "target_url": "https://www.tradingview.com/chart/?symbol=NASDAQ%3ANVDA",
  "authed": false,
  "requested": "BATS:NVDA",
  "resolution": "60",
  "resolved": "BATS:NVDA",
  "description": "NVIDIA Corporation",
  "status": 0,
  "bars": 300,
  "last": 196.54,
  "panes": [814, 204]
}
```

`status: 0` is healthy. `resolved: null` with `status: 2` means the chart is
**broken** — the bars on screen belong to a previous symbol. `check` exits 1
and tells you to re-seat the symbol.

### Switch symbol and screenshot

```bash
node .claude/skills/run-tradingview-mcp/driver.mjs symbol NASDAQ:NVDA
node .claude/skills/run-tradingview-mcp/driver.mjs shot verify
```

```json
{
  "file": "C:\\Users\\BeauJohnson\\tradingview-mcp-jackson\\screenshots\\verify_BATS_NVDA_60.png",
  "symbol": "BATS:NVDA",
  "resolution": "60",
  "bytes": 166399
}
```

### Call an MCP tool directly

The fastest way to exercise a tool without restarting Claude Code. Most PRs
here touch one tool in `src/tools/` or `src/core/` — this is the path to
test them:

```bash
node .claude/skills/run-tradingview-mcp/driver.mjs mcp tv_health_check
node .claude/skills/run-tradingview-mcp/driver.mjs mcp data_get_ohlcv '{"summary":true,"count":20}'
```

```json
{
  "success": true,
  "bar_count": 20,
  "open": 208.54,
  "close": 196.54,
  "high": 211.9,
  "low": 195.44,
  "change_pct": "-5.75%"
}
```

Do **not** hand-roll this as `printf … | node src/server.js` — the server
never closes stdout, so the pipe hangs forever. The driver resolves on the
matching response id and kills the child.

### CLI (quick reads)

```bash
node src/cli/index.js status
node src/cli/index.js quote
node src/cli/index.js state
node src/cli/index.js values
node src/cli/index.js ohlcv --summary
node src/cli/index.js ui eval "1+1"
```

`node src/cli/index.js` with no args prints all 30 commands.

## MCP registration

Already registered globally at `C:\Users\BeauJohnson\.claude\.mcp.json`:

```json
{
  "mcpServers": {
    "tradingview": {
      "command": "node",
      "args": ["C:\\Users\\BeauJohnson\\tradingview-mcp-jackson\\src\\server.js"]
    }
  }
}
```

Claude Code loads MCP servers **only at startup** — restart it after editing
tool definitions.

## Test

```bash
npm test           # e2e (live chart) + pine_analyze
npm run test:unit  # pine_analyze + cli — no chart, but needs network
```

**Neither suite passes on this setup, and that is expected.** Measured this
session — establish the baseline before blaming your change:

| Command | Result | Exit | Time |
|---|---|---|---|
| `npm test` | `tests 95, pass 78, fail 17` | 1 | ~10m 41s |
| `npm run test:unit` | `tests 29, pass 27, fail 2` | 1 | ~2s |

The 17 e2e failures break down as:

- **1 environmental** — `tv_launch — auto-detect binary` asserts
  `TradingView binary found on disk`. TradingView Desktop is not installed
  here (we drive Chrome instead), so this can never pass.
- **1 genuine API drift** — `ui_open_panel` for `pine-editor`:
  `window.TradingView.bottomWidgetBar.hideWidget is not a function`.
- **~15 cascade** — `chart_set_symbol` hangs 195s and fails (the
  anonymous-session symbol bug in Gotchas), the page reloads, and every
  later test in the file hits
  `Cannot read properties of undefined (reading '_activeChartWidgetWV')`
  or `Inspected target navigated or closed` while the page is still
  booting. All Chart Control and Replay tests fall over this way.

**`npm test` also hijacks your live chart.** The e2e suite drives the real
tab: it changes symbol and timeframe, adds studies, opens the Strategy Report
panel, and enters replay mode. It leaves the chart *broken* — during this
session it left `resolved: null, status: 2`. Re-seat afterwards:

```bash
node .claude/skills/run-tradingview-mcp/driver.mjs symbol NASDAQ:NVDA
```

Prefer `npm run test:unit` unless you specifically need e2e — it runs in ~2s
and does not touch your tab. It needs no chart, but `pine check` POSTs to
`pine-facade.tradingview.com/pine-facade/translate_light`, so it does need
network. Its 2 failures are both
`CLI — pine check (server compile)`, caused by the libuv exit crash in
Gotchas, not by the compile itself.

## Gotchas

These cost real time to find. None are in the README.

- **`success: true` means "the JS call didn't throw", not "the chart
  changed."** This is the single most important thing to know. Every write
  tool reports success regardless of outcome. Verify against `driver.mjs
  check`, never against the tool's own return value.

- **A backgrounded tab screenshots blank — and every data tool still says
  everything is fine.** Chrome does not paint canvases in a hidden tab. The
  capture succeeds, the legend and price header render, but the candles are
  gone: every `<canvas>` is stuck at its default `300x150` while the
  container is `843x1204`, and the PNG drops from ~167 KB to ~37 KB.
  `document.visibilityState` is `"hidden"`. It survives page reloads, so it
  looks like corrupted chart state rather than a focus problem. Anything that
  steals foreground — opening a second tab via `/json/new`, minimizing the
  window — triggers it. `driver.mjs shot` calls `Page.bringToFront()`, polls
  until `visibilityState === "visible"`, then waits for the repaint. **File
  size is the quickest tell:** under ~50 KB means blank.

- **`setPaneHeight` does not shrink its siblings.** Grow a pane without
  taking the space from another and the heights sum past the container
  (e.g. `1176 + 294` in an 1176-tall chart); the layout collapses and the
  canvas blanks exactly as above. Always redistribute and keep the total
  fixed — `driver.mjs panes` does. To recover a chart already in this state:
  `m.removePane(p)` for the extra panes, reset pane 0 to the full height,
  then reload.

- **Symbol switching does not work on an anonymous session.** `tv symbol NVDA`
  and `chart_set_symbol` return `success: true`, and `chart.symbol()` starts
  echoing the new ticker — but `mainSeries().symbolInfo()` stays `null`,
  `status()` is `2`, and the bars keep the *old* symbol's values forever.
  Polled for 60s: never resolves. Exchange-qualifying it (`NASDAQ:NVDA`)
  does not help. `quote_get` will confidently report NVDA with AAPL's exact
  OHLC. **Workaround:** navigate the tab to
  `https://www.tradingview.com/chart/?symbol=NASDAQ:NVDA` — that re-resolves
  properly. This is what `driver.mjs symbol` does.

- **The CDP Chrome profile is logged out** (`<html class="is-not-authenticated
  is-not-pro">`). Consequences: symbols resolve to **BATS/Cboe**, not the
  exchange you asked for (`NASDAQ:NVDA` → `BATS:NVDA`); saved layouts, Pine
  scripts, and alerts are unavailable; studies do not persist across a
  reload. Log in once at `~/tradingview-cdp-profile` to change this — the
  profile persists.

- **A signup modal covers the chart** on an anonymous session
  (`[data-dialog-name="gopro"]`, "Look first / Then leap"). It has **no close
  button** and **ignores Escape**. The only reliable dismissal is removing
  the `#overlap-manager-root` child that contains it and clearing
  `body.i-no-scroll` — `driver.mjs dismiss`.

- **Separate-pane studies land in a zero-height pane**, which hides them from
  both the chart *and* `tv values`. `chart_manage_indicator add "Relative
  Strength Index"` returns a real entity id and shows up in `tv state`, but
  `tv values` reports nothing and the pane heights read `[1176, 0]`. Resize
  the pane and it immediately reports (`RSI: 33.23`) and draws. `driver.mjs
  study` and `driver.mjs panes` handle this. Overlay studies (EMA) get values
  with no fix needed.

  Once the pane has height **and** the tab is foregrounded, the study renders
  normally — a full RSI subplot with its 30/70 band. If a study looks
  "invisible," check those two things before concluding it failed to attach;
  both failure modes look identical to a study that was never added.

- **`new_study_count` is wrong.** It returned `1` on every add while the
  chart actually held 1, then 2, then 3 studies. Use `tv state` for the real
  list.

- **`tv pine check` prints correct output and then crashes on exit.** The
  JSON is complete and valid, then Node aborts during handle teardown:
  `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file
  src\win\async.c, line 94`. Exit code is `127` under Git Bash and
  `3221226505` (`0xC0000409`) under the test runner — never `0`. A libuv
  teardown bug on Windows, not a compile error. **Parse stdout; ignore the
  exit code** for this one command. It is the sole cause of both
  `npm run test:unit` failures.

- **Tool count drifts across docs.** `CLAUDE.md` says 68, the MCP server
  description says 78; `tools/list` actually returns **81**.

- **`tv health` is not a command** — it is `tv status`. (`tv_health_check`
  is the *MCP* tool name; the CLI does not mirror it.)

- **`tv screenshot` writes `tv_undefined_<timestamp>.png`** — the symbol is
  never interpolated into the filename. `driver.mjs shot` names files by
  resolved symbol and timeframe instead.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `FAIL: no CDP on port 9222` | Chrome isn't running with remote debugging. `powershell -ExecutionPolicy Bypass -File start-tradingview-cdp.ps1` |
| `Join-Path : Cannot bind argument to parameter 'Path'` from the launch script | `$HOME` is empty — the script builds its profile path from it. Happens under a stripped environment (`env -i`). Run it from a normal shell, or set `USERPROFILE`. |
| `CDP is up but no tradingview.com/chart tab exists` | `curl -s -X PUT "http://localhost:9222/json/new?https://www.tradingview.com/chart/"` |
| `check` says `resolved: null`, `status: 2` | Symbol never loaded; bars are stale. `driver.mjs symbol NASDAQ:NVDA` |
| `quote` returns the wrong symbol's prices | Same stale-series problem. Re-seat the symbol. |
| Screenshot has the UI but no candles; PNG < 50 KB | Tab is backgrounded — Chrome isn't painting. `driver.mjs shot` foregrounds it; if it still warns, un-minimize the Chrome window. |
| `tv values` omits an indicator you just added | Zero-height pane. `driver.mjs panes` |
| Indicator missing from a screenshot | Zero-height pane or backgrounded tab. `driver.mjs study` fixes the pane; `driver.mjs shot` foregrounds the tab. |
| `printf … \| node src/server.js` hangs | Server never closes stdout. Use `driver.mjs mcp <tool>`. |
| Chart covered by "Look first / Then leap" | `driver.mjs dismiss` |
| `window.TradingView.bottomWidgetBar.hideWidget is not a function` | Known e2e failure — TradingView changed the API. `ui_open_panel` for `pine-editor` is broken. |
| `Promise was collected` during replay | Known e2e failure in `replay_start`; CDP drops the promise on `showReplayToolbar()`. |
| `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` after `tv pine check` | Cosmetic libuv teardown crash. Output above it is valid — parse stdout, ignore the exit code. |
| MCP tool changes not visible in Claude Code | Servers load at startup only — restart Claude Code. |
