#!/usr/bin/env node

/**
 * tv — CLI for TradingView Desktop via Chrome DevTools Protocol.
 * Outputs JSON to stdout. Errors to stderr.
 * Exit codes: 0 success, 1 error, 2 connection failure.
 *
 * All 70 MCP tools are accessible via CLI commands.
 * Pipe-friendly: every command outputs JSON for use with jq.
 */

// Load .env (PUSHOVER_*, ANTHROPIC_*, ALERT_* — see .env.example) before anything else
import "dotenv/config";

// Register all commands
import "./commands/health.js";
import "./commands/chart.js";
import "./commands/data.js";
import "./commands/pine.js";
import "./commands/capture.js";
import "./commands/replay.js";
import "./commands/drawing.js";
import "./commands/alerts.js";
import "./commands/watchlist.js";
import "./commands/layout.js";
import "./commands/indicator.js";
import "./commands/ui.js";
import "./commands/pane.js";
import "./commands/tab.js";
import "./commands/stream.js";
import "./commands/morning.js";
import "./commands/trade_alert.js";

// Run
import { run } from "./router.js";
await run(process.argv);
