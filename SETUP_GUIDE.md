# Setup Guide for OpenCode

This file is a step-by-step guide for OpenCode (or any LLM agent) to install and configure the TradingView MCP server. If a user asks you to install or set up this project, follow these steps exactly.

## Step 1: Clone and Install

```bash
git clone https://github.com/LewisWJackson/tradingview-mcp.git ~/tradingview-mcp
cd ~/tradingview-mcp
npm install
```

If the user specifies a different install path, use that instead of `~/tradingview-mcp`.

## Step 2: Set Up Rules

Copy the example rules file and open it for the user to fill in:

```bash
cp ~/tradingview-mcp/rules.example.json ~/tradingview-mcp/rules.json
```

Tell the user: "Open `rules.json` and fill in your watchlist (the symbols you trade), your bias criteria (what makes something bullish/bearish for you), and your risk rules. This is what the morning brief uses every day."

## Step 3: Project Already Has OpenCode Config

This project includes `opencode.json` at the root, which configures the MCP server automatically. The config is:

```json
{
  "mcp": {
    "tradingview": {
      "type": "local",
      "command": ["node", "src/server.js"],
      "enabled": true
    }
  }
}
```

When OpenCode loads this project, it will automatically discover and start the TradingView MCP server.

**For global MCP config** (all projects), add to `~/.config/opencode/opencode.json`:

```json
{
  "mcp": {
    "tradingview": {
      "type": "local",
      "command": ["node", "/PATH/TO/tradingview-mcp/src/server.js"],
      "enabled": true
    }
  }
}
```

## Step 4: Launch TradingView Desktop

TradingView Desktop must be running with Chrome DevTools Protocol enabled.

**Auto-detect and launch (recommended):**
After the MCP server is connected, use the `tv_launch` tool — it auto-detects TradingView on Mac, Windows, and Linux.

**Manual launch by platform:**

Mac:
```bash
/Applications/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=9222
```

Windows:
```bash
%LOCALAPPDATA%\TradingView\TradingView.exe --remote-debugging-port=9222
```

Linux:
```bash
/opt/TradingView/tradingview --remote-debugging-port=9222
# or: tradingview --remote-debugging-port=9222
```

## Step 5: Verify Connection

Use the `tv_health_check` tool. Expected response:

```json
{
  "success": true,
  "cdp_connected": true,
  "chart_symbol": "...",
  "api_available": true
}
```

If `cdp_connected: false`, TradingView is not running with `--remote-debugging-port=9222`.

## Step 6: Run Your First Morning Brief

Ask OpenCode: *"Run morning_brief and give me my session bias"*

OpenCode will scan your watchlist, read your indicators, apply your `rules.json` criteria, and print your bias for each symbol.

To save it: *"Save this brief using session_save"*

To retrieve tomorrow: *"Get yesterday's session using session_get"*

## Step 7: Install CLI (Optional)

To use the `tv` CLI command globally:

```bash
cd ~/tradingview-mcp
npm link
```

Then `tv status`, `tv quote`, `tv pine compile`, etc. work from anywhere.

## Step 8: Available Skills

This project includes OpenCode skills in `.opencode/skills/`:

- **pine-develop** — Full Pine Script development loop
- **chart-analysis** — Technical analysis workflow
- **replay-practice** — Practice trading in replay mode
- **multi-symbol-scan** — Scan multiple symbols for setups
- **strategy-report** — Generate strategy performance reports

Use the `skill` tool to load any of these.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in OpenCode | Check `opencode.json` syntax |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |
| Skills not loading | Ensure SKILL.md files are in `.opencode/skills/*/` |

## What to Read Next

- `rules.json` — Your personal trading rules (fill this in before using morning_brief)
- `AGENTS.md` — Decision tree for which tool to use when (auto-loaded by OpenCode)
- `README.md` — Full tool reference including morning brief workflow
- `RESEARCH.md` — Research context and open questions