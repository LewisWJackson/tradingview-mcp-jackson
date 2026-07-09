# Setup Guide for Claude Code

This file is a step-by-step guide for Claude Code (or any LLM agent) to install and configure the TradingView MCP server. If a user asks you to install or set up this project, follow these steps exactly.

## Step 1: Clone and Install

```bash
git clone https://github.com/LewisWJackson/tradingview-mcp-jackson.git ~/tradingview-mcp-jackson
cd ~/tradingview-mcp-jackson
npm install
```

If the user specifies a different install path, use that instead of `~/tradingview-mcp-jackson`.

## Step 2: Set Up Rules

Copy the example rules file and open it for the user to fill in:

```bash
cp ~/tradingview-mcp-jackson/rules.example.json ~/tradingview-mcp-jackson/rules.json
```

Tell the user: "Open `rules.json` and fill in your watchlist (the symbols you trade), your bias criteria (what makes something bullish/bearish for you), and your risk rules. This is what the morning brief uses every day."

## Step 3: Add to MCP Config

Register the server with Claude Code using the supported CLI. This writes to the correct config file (`~/.claude.json`) at user scope and merges with any existing servers automatically — no manual JSON editing, no overwrite risk:

```bash
claude mcp add tradingview -s user -- node ~/tradingview-mcp-jackson/src/server.js
```

Confirm it registered (`claude mcp get tradingview` should report `Status: ✔ Connected`).

> **Important:** Claude Code does **not** read `~/.claude/.mcp.json`. It loads MCP servers only from `~/.claude.json` (user/local scope) or a `.mcp.json` file at the **project root** (project scope). To use project scope instead, create `~/tradingview-mcp-jackson/.mcp.json` with (replace `YOUR_USERNAME`):
>
> ```json
> { "mcpServers": { "tradingview": { "command": "node", "args": ["/Users/YOUR_USERNAME/tradingview-mcp-jackson/src/server.js"] } } }
> ```

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

## Step 5: Restart Claude Code

The MCP server only loads when Claude Code starts. After adding the config:

1. Exit Claude Code (Ctrl+C)
2. Relaunch Claude Code
3. The tradingview MCP server should connect automatically

## Step 6: Verify Connection

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

## Step 7: Run Your First Morning Brief

Ask Claude: *"Run morning_brief and give me my session bias"*

Claude will scan your watchlist, read your indicators, apply your `rules.json` criteria, and print your bias for each symbol.

To save it: *"Save this brief using session_save"*

To retrieve tomorrow: *"Get yesterday's session using session_get"*

## Step 8: Install CLI (Optional)

To use the `tv` CLI command globally:

```bash
cd ~/tradingview-mcp-jackson
npm link
```

Then `tv status`, `tv quote`, `tv pine compile`, etc. work from anywhere.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `cdp_connected: false` | Launch TradingView with `--remote-debugging-port=9222` |
| `ECONNREFUSED` | TradingView isn't running or port 9222 is blocked |
| MCP server not showing in Claude Code | Run `claude mcp get tradingview` to check status; if missing, re-run `claude mcp add`, then restart Claude Code |
| `tv` command not found | Run `npm link` from the project directory |
| Tools return stale data | TradingView may still be loading — wait a few seconds |
| Pine Editor tools fail | Open the Pine Editor panel first (`ui_open_panel pine-editor open`) |

## What to Read Next

- `rules.json` — Your personal trading rules (fill this in before using morning_brief)
- `CLAUDE.md` — Decision tree for which tool to use when (auto-loaded by Claude Code)
- `README.md` — Full tool reference including morning brief workflow
- `RESEARCH.md` — Research context and open questions
