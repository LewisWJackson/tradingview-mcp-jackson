#!/usr/bin/env node
/**
 * chart-strategy.js — Multi-timeframe chart analysis via TradingView MCP CLI
 *
 * Usage:
 *   node chart-strategy.js BAC          # analyze Bank of America
 *   node chart-strategy.js ES1!         # analyze E-mini S&P
 *   node chart-strategy.js AAPL D       # AAPL on daily timeframe
 *
 * What it does:
 *   1. Switches chart to the requested symbol + timeframe
 *   2. Pulls current quote, OHLCV summary, and indicator readings
 *   3. Reads Pine-drawn levels, labels, and tables (if any custom indicators present)
 *   4. Captures a screenshot
 *   5. Outputs a structured JSON report to stdout + saves to reports/
 */

import { execSync } from "child_process";
import { mkdirSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = `node ${join(__dirname, "src", "cli", "index.js")}`;

// ── Helpers ────────────────────────────────────────────────────────
function tv(cmd) {
  try {
    const raw = execSync(`${CLI} ${cmd}`, {
      encoding: "utf8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return JSON.parse(raw);
  } catch (e) {
    return { success: false, error: e.message.slice(0, 200) };
  }
}

function log(msg) {
  process.stderr.write(msg + "\n");
}

// ── Main ───────────────────────────────────────────────────────────
const symbol = process.argv[2] || "BAC";
const timeframe = process.argv[3] || "D";

log(`\n── Chart Strategy Report ──`);
log(`Symbol: ${symbol} | Timeframe: ${timeframe}\n`);

// Step 1 — Health check
log("1. Checking TradingView connection...");
const health = tv("status");
if (!health.success) {
  log("   TradingView is not connected. Launch it with:");
  log('   TradingView.exe --remote-debugging-port=9222');
  log("   Then re-run this script.");
  process.exit(1);
}
log("   Connected.");

// Step 2 — Switch symbol and timeframe
log(`2. Setting chart to ${symbol} / ${timeframe}...`);
const symResult = tv(`symbol ${symbol}`);
if (!symResult.success) {
  log(`   Failed to set symbol: ${symResult.error}`);
  process.exit(1);
}
// Small pause for chart to load
execSync("ping -n 2 127.0.0.1 > NUL", { stdio: "pipe" }); // ~1s delay on Windows
tv(`timeframe ${timeframe}`);
execSync("ping -n 2 127.0.0.1 > NUL", { stdio: "pipe" });
log("   Done.");

// Step 3 — Gather data (parallel-safe since each is a read)
log("3. Gathering data...");

const quote = tv("quote");
const ohlcv = tv("ohlcv --summary");
const values = tv("values");
const state = tv("state");

// Pine graphics (only useful if custom indicators are on chart)
const pineLines = tv("data lines");
const pineLabels = tv("data labels");
const pineTables = tv("data tables");

log("   Data collected.");

// Step 4 — Screenshot
log("4. Taking screenshot...");
const screenshot = tv("screenshot");
log(`   ${screenshot.success ? screenshot.path || "Saved" : "Skipped (no connection)"}`);

// Step 5 — Build report
log("5. Building report...\n");

const report = {
  generated: new Date().toISOString(),
  symbol,
  timeframe,
  quote: quote.success ? strip(quote) : null,
  ohlcv_summary: ohlcv.success ? strip(ohlcv) : null,
  indicators: values.success ? strip(values) : null,
  chart_state: state.success ? strip(state) : null,
  pine_levels: pineLines.success ? strip(pineLines) : null,
  pine_labels: pineLabels.success ? strip(pineLabels) : null,
  pine_tables: pineTables.success ? strip(pineTables) : null,
  screenshot: screenshot.success ? screenshot.path || null : null,
};

// Save report
const reportsDir = join(__dirname, "reports");
if (!existsSync(reportsDir)) mkdirSync(reportsDir, { recursive: true });
const filename = `${symbol.replace(/[^a-zA-Z0-9]/g, "_")}_${timeframe}_${Date.now()}.json`;
const filepath = join(reportsDir, filename);
writeFileSync(filepath, JSON.stringify(report, null, 2));
log(`Report saved: reports/${filename}`);

// Print summary to stdout
printSummary(report);

// ── Formatting ─────────────────────────────────────────────────────
function strip(obj) {
  const { success, ...rest } = obj;
  return rest;
}

function printSummary(r) {
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  ${r.symbol} — ${r.timeframe} Chart Report`);
  console.log(`${"═".repeat(50)}`);

  if (r.quote) {
    const q = r.quote;
    const price = q.last || q.lp || q.close || "N/A";
    const change = q.ch != null ? `${q.ch > 0 ? "+" : ""}${q.ch}` : "";
    const changePct = q.chp != null ? ` (${q.chp > 0 ? "+" : ""}${q.chp}%)` : "";
    console.log(`\n  Price: $${price} ${change}${changePct}`);
    if (q.open) console.log(`  Open: $${q.open}  High: $${q.high_price || q.high || "—"}  Low: $${q.low_price || q.low || "—"}`);
    if (q.volume) console.log(`  Volume: ${Number(q.volume).toLocaleString()}`);
  }

  if (r.ohlcv_summary) {
    console.log(`\n  OHLCV Summary:`);
    const s = r.ohlcv_summary;
    if (s.high) console.log(`    Range: $${s.low} — $${s.high}`);
    if (s.avg_volume) console.log(`    Avg Volume: ${Number(s.avg_volume).toLocaleString()}`);
    if (s.change_pct != null) console.log(`    Change: ${s.change_pct}%`);
  }

  if (r.indicators && typeof r.indicators === "object") {
    const entries = Object.entries(r.indicators).filter(([k]) => k !== "error");
    if (entries.length > 0) {
      console.log(`\n  Indicators:`);
      for (const [name, val] of entries) {
        if (typeof val === "object") {
          console.log(`    ${name}:`);
          for (const [k, v] of Object.entries(val)) {
            console.log(`      ${k}: ${v}`);
          }
        } else {
          console.log(`    ${name}: ${val}`);
        }
      }
    }
  }

  if (r.pine_levels) {
    const levels = Array.isArray(r.pine_levels) ? r.pine_levels : r.pine_levels.levels || [];
    if (levels.length > 0) {
      console.log(`\n  Key Levels (from indicators):`);
      levels.slice(0, 10).forEach((l) => {
        const label = l.label || l.name || "";
        console.log(`    ${label ? label + ": " : ""}$${l.price || l.value || l}`);
      });
    }
  }

  if (r.pine_labels) {
    const labels = Array.isArray(r.pine_labels) ? r.pine_labels : r.pine_labels.labels || [];
    if (labels.length > 0) {
      console.log(`\n  Chart Labels:`);
      labels.slice(0, 8).forEach((l) => {
        console.log(`    ${l.text || l}`);
      });
    }
  }

  console.log(`\n${"═".repeat(50)}`);
  console.log(`  Report: reports/${filename}`);
  console.log(`${"═".repeat(50)}\n`);
}
