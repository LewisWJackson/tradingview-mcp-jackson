#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "../src/core/chart.js";
import * as data from "../src/core/data.js";
import * as health from "../src/core/health.js";
import { disconnect } from "../src/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const configPath = resolve(root, "config", "mtf_paper_config.json");
const dataDir = resolve(root, "paper-data");
const reportsDir = resolve(dataDir, "reports");
const statePath = resolve(dataDir, "state.json");
const latestReportPath = resolve(reportsDir, "latest.md");
const latestCandidatesPath = resolve(dataDir, "latest-candidates.json");
const latestCandidatesProgressPath = resolve(dataDir, "latest-candidates-progress.json");

const args = process.argv.slice(2);
const HOST = argValue("--host", process.env.DASHBOARD_HOST || "127.0.0.1");
const PORT = Number(argValue("--port", process.env.DASHBOARD_PORT || "8787"));
const REFRESH_MS = Math.max(1000, Number(process.env.DASHBOARD_REFRESH_MS || "3000"));
const LIVE_CDP = process.env.DASHBOARD_LIVE_CDP !== "0";
const LIVE_TIMEOUT_MS = Math.max(1000, Number(process.env.DASHBOARD_LIVE_TIMEOUT_MS || "5000"));
const TOKEN = (process.env.DASHBOARD_TOKEN || "").trim() || randomBytes(24).toString("hex");
const TOKEN_SOURCE = process.env.DASHBOARD_TOKEN ? "DASHBOARD_TOKEN" : "generated";

if (!Number.isFinite(PORT) || PORT <= 0 || PORT > 65535) {
  console.error("Invalid dashboard port.");
  process.exit(1);
}

if (!isLoopbackHost(HOST) && process.env.DASHBOARD_ALLOW_LAN !== "1") {
  console.error(`Refusing to bind dashboard to non-loopback host "${HOST}".`);
  console.error("Use Cloudflare Tunnel to http://127.0.0.1:8787 instead, or set DASHBOARD_ALLOW_LAN=1 intentionally.");
  process.exit(1);
}

const securityHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

let liveCache = { at: 0, value: null, pending: null };
let gitCache = { at: 0, value: null, pending: null };

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(String(host).toLowerCase());
}

function readJson(path, fallback = null) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { _read_error: error.message };
  }
}

function fileInfo(path) {
  try {
    if (!existsSync(path)) return { exists: false, path };
    const stat = statSync(path);
    return {
      exists: true,
      path,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
      age_seconds: Math.max(0, Math.round((Date.now() - stat.mtimeMs) / 1000)),
    };
  } catch (error) {
    return { exists: false, path, error: error.message };
  }
}

function n(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(digits)) : null;
}

function countBy(values, key) {
  const counts = {};
  for (const value of values || []) {
    const k = value?.[key] || "UNKNOWN";
    counts[k] = (counts[k] || 0) + 1;
  }
  return counts;
}

function latestReportJson() {
  try {
    if (!existsSync(reportsDir)) return null;
    const files = readdirSync(reportsDir)
      .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
      .sort();
    if (!files.length) return null;
    const filename = files[files.length - 1];
    const path = join(reportsDir, filename);
    const report = readJson(path, null);
    return report ? { ...report, _file: fileInfo(path) } : null;
  } catch {
    return null;
  }
}

function paperSnapshot() {
  const config = readJson(configPath, {});
  const state = readJson(statePath, null);
  const report = latestReportJson();
  const selection = readJson(latestCandidatesPath, null);
  const selectionProgress = readJson(latestCandidatesProgressPath, null);
  const latestDaily = Array.isArray(state?.daily_reports) && state.daily_reports.length
    ? state.daily_reports[state.daily_reports.length - 1]
    : null;

  if (!state || state._read_error) {
    return {
      available: false,
      read_error: state?._read_error || null,
      strategy_name: config?.strategy_name || "MTF Trend Pullback + ATR Risk System",
      mode: config?.mode || "paper_trading_only",
      files: filesSnapshot(),
    };
  }

  const startingEquity = n(state.starting_equity ?? config.starting_equity ?? 0);
  const equity = n(state.equity ?? startingEquity);
  const realizedPnl = n(state.realized_pnl ?? 0);
  const unrealizedPnl = n(report?.unrealized_pnl ?? latestDaily?.unrealized_pnl ?? 0);
  const totalPnl = n((realizedPnl || 0) + (unrealizedPnl || 0));
  const totalReturnPct = startingEquity ? n((totalPnl / startingEquity) * 100, 4) : null;
  const openPositions = Array.isArray(state.open_positions) ? state.open_positions : [];
  const closedTrades = Array.isArray(state.closed_trades) ? state.closed_trades : [];
  const wins = closedTrades.filter((trade) => Number(trade.realized_pnl || 0) > 0).length;
  const totalRealizedR = n(closedTrades.reduce((sum, trade) => sum + Number(trade.realized_R || 0), 0), 4);
  const signals = Array.isArray(state.signal_log) ? state.signal_log : [];
  const statusCounts = report?.status_counts || latestDaily?.status_counts || countBy(signals.slice(-50), "status");

  return {
    available: true,
    strategy_name: state.strategy_name || config.strategy_name,
    mode: state.mode || config.mode || "paper_trading_only",
    created_at: state.created_at,
    starting_equity: startingEquity,
    equity,
    realized_pnl: realizedPnl,
    unrealized_pnl: unrealizedPnl,
    total_pnl: totalPnl,
    total_return_pct: totalReturnPct,
    open_position_count: openPositions.length,
    closed_trade_count: closedTrades.length,
    win_rate_pct: closedTrades.length ? n((wins / closedTrades.length) * 100, 2) : null,
    total_realized_R: totalRealizedR,
    risk_pause: Boolean(state.risk_pause),
    risk_pause_reason: state.risk_pause_reason || null,
    risk_gates: report?.risk_gates || null,
    status_counts: statusCounts,
    open_positions: openPositions.slice(0, 50),
    recent_closed_trades: closedTrades.slice(-20).reverse(),
    recent_signals: signals.slice(-30).reverse(),
    daily_reports: Array.isArray(state.daily_reports) ? state.daily_reports.slice(-60) : [],
    latest_report: report ? {
      date: report.date,
      generated_at: report.generated_at,
      scanned_symbols: report.scanned_symbols,
      closed_trade_count: report.closed_trade_count,
      win_rate: report.win_rate,
      total_realized_R: report.total_realized_R,
      file: report._file,
    } : null,
    candidate_selection: selection && !selection._read_error ? {
      generated_at: selection.generated_at,
      universe_path: selection.universe_path,
      benchmark: selection.benchmark,
      selection_mode: selection.selection_mode,
      allocation: selection.allocation,
      allocation_strict: selection.allocation_strict,
      universe_total_symbols: selection.universe_total_symbols,
      rotation_offset: selection.rotation_offset,
      symbols_considered: selection.symbols_considered,
      candidates_requested: selection.candidates_requested,
      candidates: (selection.candidates || []).slice(0, 20),
      file: fileInfo(latestCandidatesPath),
    } : null,
    candidate_selection_progress: selectionProgress && !selectionProgress._read_error ? {
      phase: selectionProgress.phase,
      generated_at: selectionProgress.generated_at,
      started_at: selectionProgress.started_at,
      universe_path: selectionProgress.universe_path,
      benchmark: selectionProgress.benchmark,
      selection_mode: selectionProgress.selection_mode,
      allocation: selectionProgress.allocation,
      universe_total_symbols: selectionProgress.universe_total_symbols,
      rotation_offset: selectionProgress.rotation_offset,
      symbols_considered: selectionProgress.symbols_considered,
      completed: selectionProgress.completed,
      current_symbol: selectionProgress.current_symbol,
      status_counts: selectionProgress.status_counts,
      candidates: (selectionProgress.candidates || []).slice(0, 20),
      file: fileInfo(latestCandidatesProgressPath),
    } : null,
    files: filesSnapshot(),
  };
}

function filesSnapshot() {
  return {
    config: fileInfo(configPath),
    state: fileInfo(statePath),
    latest_report_md: fileInfo(latestReportPath),
    latest_candidates: fileInfo(latestCandidatesPath),
    latest_candidates_progress: fileInfo(latestCandidatesProgressPath),
  };
}

function execFileText(command, commandArgs, options = {}) {
  return new Promise((resolvePromise) => {
    execFile(command, commandArgs, {
      cwd: root,
      timeout: 3000,
      maxBuffer: 64 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      resolvePromise({
        success: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: error?.message || null,
      });
    });
  });
}

async function gitSnapshot() {
  const now = Date.now();
  if (gitCache.value && now - gitCache.at < 15000) return gitCache.value;
  if (gitCache.pending) return gitCache.pending;

  gitCache.pending = (async () => {
    const status = await execFileText("git", ["status", "--short", "--branch"]);
    const lines = status.stdout.trim().split(/\r?\n/).filter(Boolean);
    const branch = lines.find((line) => line.startsWith("##")) || null;
    const changed = lines.filter((line) => !line.startsWith("##"));
    const value = {
      available: status.success,
      branch,
      changed_count: changed.length,
      changed,
      error: status.error,
    };
    gitCache = { at: Date.now(), value, pending: null };
    return value;
  })();

  return gitCache.pending;
}

function rejectedToObject(result) {
  if (result.status === "fulfilled") return result.value;
  return { success: false, error: result.reason?.message || String(result.reason) };
}

async function liveSnapshot() {
  if (!LIVE_CDP) return { enabled: false, reason: "DASHBOARD_LIVE_CDP=0" };

  const now = Date.now();
  if (liveCache.value && now - liveCache.at < REFRESH_MS) return liveCache.value;
  if (liveCache.pending) return liveCache.pending;

  liveCache.pending = (async () => {
    const tasks = Promise.allSettled([
      health.healthCheck(),
      chart.getState(),
      data.getQuote({}),
      data.getStudyValues(),
      data.getOhlcv({ count: 20, summary: true }),
    ]);

    const timeout = new Promise((resolvePromise) => {
      setTimeout(() => resolvePromise(null), LIVE_TIMEOUT_MS);
    });

    const settled = await Promise.race([tasks, timeout]);
    let value;
    if (!settled) {
      value = {
        enabled: true,
        connected: false,
        error: `TradingView live read timed out after ${LIVE_TIMEOUT_MS}ms`,
        refreshed_at: new Date().toISOString(),
      };
    } else {
      const [healthResult, chartResult, quoteResult, studiesResult, ohlcvResult] = settled;
      const healthValue = rejectedToObject(healthResult);
      value = {
        enabled: true,
        connected: Boolean(healthValue?.success && healthValue?.cdp_connected),
        refreshed_at: new Date().toISOString(),
        health: healthValue,
        chart: rejectedToObject(chartResult),
        quote: rejectedToObject(quoteResult),
        studies: rejectedToObject(studiesResult),
        ohlcv: rejectedToObject(ohlcvResult),
      };
    }
    liveCache = { at: Date.now(), value, pending: null };
    return value;
  })();

  return liveCache.pending;
}

async function statusSnapshot() {
  const [live, git] = await Promise.all([liveSnapshot(), gitSnapshot()]);
  return {
    success: true,
    generated_at: new Date().toISOString(),
    server: {
      host: HOST,
      port: PORT,
      refresh_ms: REFRESH_MS,
      live_cdp_enabled: LIVE_CDP,
      uptime_seconds: Math.round(process.uptime()),
      node: process.version,
      cwd: root,
      auth: TOKEN_SOURCE === "generated" ? "generated_token" : "env_token",
    },
    project: {
      name: "tradingview-mcp",
      root,
      git,
    },
    safety: {
      mode: "read_only_dashboard",
      no_trade_execution: true,
      no_alert_changes: true,
      no_watchlist_changes: true,
      cdp_host_required: "127.0.0.1",
      tunnel_target: `http://${HOST}:${PORT}`,
      warning: "Informational only. Not financial advice.",
    },
    paper: paperSnapshot(),
    live,
  };
}

function tokenFromRequest(req, url) {
  const queryToken = url.searchParams.get("token");
  if (queryToken) return queryToken;
  const header = req.headers.authorization || "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return null;
}

function secureTokenEquals(provided) {
  if (!provided) return false;
  const expectedBuffer = Buffer.from(TOKEN);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return timingSafeEqual(expectedBuffer, providedBuffer);
}

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(statusCode, {
    ...securityHeaders,
    ...headers,
    "Content-Type": contentType,
  });
  res.end(body);
}

function sendJson(res, statusCode, body, headers = {}) {
  send(res, statusCode, JSON.stringify(body, null, 2), "application/json; charset=utf-8", headers);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method !== "GET") {
      sendJson(res, 405, { success: false, error: "Method not allowed" }, { "Allow": "GET" });
      return;
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      send(res, 200, INDEX_HTML, "text/html; charset=utf-8");
      return;
    }

    if (url.pathname === "/healthz") {
      sendJson(res, 200, { success: true, ok: true, generated_at: new Date().toISOString() });
      return;
    }

    if (url.pathname.startsWith("/api/") && !secureTokenEquals(tokenFromRequest(req, url))) {
      sendJson(res, 401, {
        success: false,
        error: "Unauthorized. Open the dashboard with ?token=... or send Authorization: Bearer <token>.",
      }, { "WWW-Authenticate": "Bearer" });
      return;
    }

    if (url.pathname === "/api/status") {
      sendJson(res, 200, await statusSnapshot());
      return;
    }

    if (url.pathname === "/api/report.md") {
      if (!existsSync(latestReportPath)) {
        send(res, 404, "Latest report not found.\n", "text/plain; charset=utf-8");
        return;
      }
      send(res, 200, readFileSync(latestReportPath, "utf8"), "text/markdown; charset=utf-8");
      return;
    }

    sendJson(res, 404, { success: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { success: false, error: error.message });
  }
});

server.listen(PORT, HOST, () => {
  const localUrl = `http://${HOST}:${PORT}/?token=${TOKEN}`;
  console.log(`TradingView MCP dashboard listening on http://${HOST}:${PORT}/`);
  console.log(`Auth token source: ${TOKEN_SOURCE}`);
  console.log(`Open: ${localUrl}`);
  console.log(`Cloudflare Tunnel target: http://${HOST}:${PORT}`);
  console.log("Do not tunnel or expose localhost:9222.");
});

async function shutdown() {
  server.close();
  await disconnect().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TradingView MCP Dashboard</title>
  <style>
    :root {
      --bg: #f4f6f8;
      --panel: #ffffff;
      --panel-soft: #f9fafb;
      --ink: #18202a;
      --muted: #667085;
      --line: #d9dee7;
      --line-strong: #b8c0cc;
      --green: #137a4b;
      --green-bg: #e8f5ee;
      --red: #b42318;
      --red-bg: #fdecea;
      --amber: #a15c07;
      --amber-bg: #fff3d7;
      --blue: #175cd3;
      --blue-bg: #e8f0ff;
      --shadow: 0 10px 30px rgba(24, 32, 42, 0.08);
    }

    * { box-sizing: border-box; letter-spacing: 0; }
    [hidden] { display: none !important; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--ink); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { font-size: 14px; line-height: 1.45; }
    button, input { font: inherit; }
    .shell { max-width: 1440px; margin: 0 auto; padding: 20px; }
    .topbar { display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 16px; }
    .title h1 { margin: 0; font-size: 24px; line-height: 1.15; font-weight: 750; }
    .title p { margin: 5px 0 0; color: var(--muted); }
    .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    .button { border: 1px solid var(--line-strong); background: var(--panel); color: var(--ink); height: 36px; padding: 0 12px; border-radius: 7px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; box-shadow: 0 1px 0 rgba(24, 32, 42, 0.04); }
    .button:hover { border-color: #8792a2; }
    .button.primary { background: var(--ink); color: white; border-color: var(--ink); }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--line-strong); display: inline-block; }
    .dot.ok { background: var(--green); }
    .dot.bad { background: var(--red); }
    .dot.warn { background: var(--amber); }
    .notice { border: 1px solid var(--line); background: #fff; border-left: 4px solid var(--blue); border-radius: 8px; padding: 10px 12px; color: var(--muted); margin-bottom: 16px; }
    .grid { display: grid; gap: 12px; }
    .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); margin-bottom: 12px; }
    .main-grid { grid-template-columns: minmax(0, 1.1fr) minmax(360px, 0.9fr); align-items: start; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); overflow: hidden; }
    .panel-header { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel-soft); }
    .panel-header h2 { margin: 0; font-size: 15px; line-height: 1.25; }
    .panel-header p { margin: 3px 0 0; color: var(--muted); font-size: 12px; }
    .panel-body { padding: 14px 16px; }
    .metric { padding: 14px 16px; min-height: 132px; display: flex; flex-direction: column; justify-content: space-between; }
    .metric-label { color: var(--muted); font-size: 12px; }
    .metric-value { font-size: 28px; font-weight: 760; line-height: 1.1; margin-top: 8px; word-break: break-word; }
    .metric-sub { color: var(--muted); font-size: 12px; margin-top: 8px; }
    .positive { color: var(--green); }
    .negative { color: var(--red); }
    .neutral { color: var(--muted); }
    .badge { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 3px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--line); background: var(--panel); white-space: nowrap; }
    .badge.ok { color: var(--green); background: var(--green-bg); border-color: #bfe3cd; }
    .badge.bad { color: var(--red); background: var(--red-bg); border-color: #f3bbb5; }
    .badge.warn { color: var(--amber); background: var(--amber-bg); border-color: #f2d99a; }
    .badge.info { color: var(--blue); background: var(--blue-bg); border-color: #b8cbff; }
    .split { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .kv { display: grid; grid-template-columns: minmax(120px, 0.7fr) minmax(0, 1.3fr); gap: 8px 12px; align-items: start; }
    .kv div:nth-child(odd) { color: var(--muted); }
    .kv div:nth-child(even) { font-weight: 620; word-break: break-word; }
    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; min-width: 660px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { background: var(--panel-soft); color: var(--muted); font-size: 12px; font-weight: 650; }
    tr:last-child td { border-bottom: 0; }
    .stack { display: grid; gap: 12px; }
    .spark { width: 100%; height: 142px; border: 1px solid var(--line); border-radius: 8px; background: linear-gradient(#fff, #fff), var(--panel-soft); padding: 8px; }
    .spark svg { width: 100%; height: 100%; display: block; }
    .empty { color: var(--muted); padding: 18px; text-align: center; border: 1px dashed var(--line-strong); border-radius: 8px; background: var(--panel-soft); }
    .subtle { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: 12px; }
    .token-screen { position: fixed; inset: 0; background: rgba(244, 246, 248, 0.96); display: grid; place-items: center; padding: 20px; z-index: 20; }
    .token-card { width: min(460px, 100%); background: #fff; border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); padding: 18px; }
    .token-card h2 { margin: 0 0 8px; font-size: 18px; }
    .token-card p { margin: 0 0 12px; color: var(--muted); }
    .token-row { display: flex; gap: 8px; }
    .token-row input { flex: 1; height: 38px; border: 1px solid var(--line-strong); border-radius: 7px; padding: 0 10px; min-width: 0; }
    .footer { color: var(--muted); font-size: 12px; margin-top: 16px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; }

    @media (max-width: 1100px) {
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .main-grid { grid-template-columns: 1fr; }
    }

    @media (max-width: 700px) {
      .shell { padding: 12px; }
      .topbar { align-items: flex-start; flex-direction: column; }
      .actions { justify-content: flex-start; }
      .metrics, .split { grid-template-columns: 1fr; }
      .metric-value { font-size: 24px; }
      .kv { grid-template-columns: 1fr; gap: 2px 0; }
      .kv div:nth-child(even) { margin-bottom: 8px; }
    }
  </style>
</head>
<body>
  <div id="tokenScreen" class="token-screen" hidden>
    <div class="token-card">
      <h2>Dashboard token</h2>
      <p>Paste a replacement token to reconnect, or close this window to keep the current view. Data APIs are token protected.</p>
      <form id="tokenForm" class="token-row">
        <input id="tokenInput" autocomplete="off" spellcheck="false" placeholder="Dashboard token">
        <button class="button primary" type="submit">Connect</button>
        <button id="tokenCloseButton" class="button" type="button">Close</button>
      </form>
    </div>
  </div>

  <div class="shell">
    <header class="topbar">
      <div class="title">
        <h1>TradingView MCP Dashboard</h1>
        <p>Read-only paper trading status, PnL, live chart health, and report freshness.</p>
      </div>
      <div class="actions">
        <span id="liveBadge" class="badge warn"><span class="dot warn"></span>Connecting</span>
        <button id="refreshButton" class="button" type="button">Refresh</button>
        <button id="tokenButton" class="button" type="button">Token</button>
      </div>
    </header>

    <div class="notice">Informational only. This dashboard does not place trades, does not change alerts, and does not modify watchlists. Do not expose TradingView CDP port 9222.</div>

    <section class="grid metrics" aria-label="Core metrics">
      <article class="panel metric">
        <div>
          <div class="metric-label">Equity</div>
          <div id="equityValue" class="metric-value">--</div>
        </div>
        <div id="equitySub" class="metric-sub">Waiting for paper state</div>
      </article>
      <article class="panel metric">
        <div>
          <div class="metric-label">Total PnL</div>
          <div id="pnlValue" class="metric-value">--</div>
        </div>
        <div id="pnlSub" class="metric-sub">Realized plus latest unrealized</div>
      </article>
      <article class="panel metric">
        <div>
          <div class="metric-label">Open Positions</div>
          <div id="openValue" class="metric-value">--</div>
        </div>
        <div id="openSub" class="metric-sub">Paper positions only</div>
      </article>
      <article class="panel metric">
        <div>
          <div class="metric-label">Live Chart</div>
          <div id="chartValue" class="metric-value">--</div>
        </div>
        <div id="chartSub" class="metric-sub">TradingView connection</div>
      </article>
    </section>

    <main class="grid main-grid">
      <section class="stack">
        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Equity Curve</h2>
              <p>Last 60 daily paper reports</p>
            </div>
            <span id="riskBadge" class="badge">Risk</span>
          </div>
          <div class="panel-body">
            <div id="sparkline" class="spark"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Open Positions</h2>
              <p>Current paper positions from paper-data/state.json</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="positionsTable"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Candidate Selection</h2>
              <p>Large-universe preselection before MTF strategy scan</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="candidatesTable"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Recent Signals</h2>
              <p>Most recent scan classifications</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="signalsTable"></div>
          </div>
        </article>
      </section>

      <aside class="stack">
        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>System Status</h2>
              <p>Dashboard, Git, files, and TradingView CDP</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="systemStatus" class="kv"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Live Quote</h2>
              <p>Current active TradingView chart</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="quoteStatus" class="kv"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Study Values</h2>
              <p>Visible indicator values from the data window</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="studyValues"></div>
          </div>
        </article>

        <article class="panel">
          <div class="panel-header">
            <div>
              <h2>Status Counts</h2>
              <p>Latest paper scan result distribution</p>
            </div>
          </div>
          <div class="panel-body">
            <div id="statusCounts" class="stack"></div>
          </div>
        </article>
      </aside>
    </main>

    <div class="footer">
      <span id="lastUpdated">Last update: --</span>
      <span id="reportLink"></span>
    </div>
  </div>

  <script>
    (function () {
      var tokenParam = new URLSearchParams(window.location.search).get("token");
      if (tokenParam) {
        localStorage.setItem("tvMcpDashboardToken", tokenParam);
        history.replaceState(null, "", window.location.pathname);
      }

      var token = localStorage.getItem("tvMcpDashboardToken") || "";
      var timer = null;
      var tokenPromptDismissed = false;

      var el = function (id) { return document.getElementById(id); };
      var h = function (value) {
        return String(value == null ? "" : value)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      };
      var cls = function (value) {
        var n = Number(value);
        if (!Number.isFinite(n) || n === 0) return "neutral";
        return n > 0 ? "positive" : "negative";
      };
      var money = function (value) {
        var n = Number(value);
        if (!Number.isFinite(n)) return "--";
        return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
      };
      var num = function (value, digits) {
        var n = Number(value);
        if (!Number.isFinite(n)) return "--";
        return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits == null ? 2 : digits }).format(n);
      };
      var age = function (seconds) {
        var n = Number(seconds);
        if (!Number.isFinite(n)) return "--";
        if (n < 60) return n + "s ago";
        if (n < 3600) return Math.round(n / 60) + "m ago";
        if (n < 86400) return Math.round(n / 3600) + "h ago";
        return Math.round(n / 86400) + "d ago";
      };

      function showTokenScreen(show) {
        el("tokenScreen").hidden = !show;
      }

      function setLiveBadge(ok, text) {
        var kind = ok ? "ok" : "bad";
        el("liveBadge").className = "badge " + kind;
        el("liveBadge").innerHTML = '<span class="dot ' + kind + '"></span>' + h(text);
      }

      function table(headers, rows, emptyText) {
        if (!rows || !rows.length) return '<div class="empty">' + h(emptyText) + '</div>';
        var html = '<div class="table-wrap"><table><thead><tr>';
        headers.forEach(function (header) { html += '<th>' + h(header) + '</th>'; });
        html += '</tr></thead><tbody>';
        rows.forEach(function (row) {
          html += '<tr>';
          row.forEach(function (cell) { html += '<td>' + cell + '</td>'; });
          html += '</tr>';
        });
        html += '</tbody></table></div>';
        return html;
      }

      function renderSparkline(points) {
        if (!points || points.length < 2) {
          el("sparkline").innerHTML = '<div class="empty">No equity history yet</div>';
          return;
        }
        var values = points.map(function (point) { return Number(point.equity); }).filter(Number.isFinite);
        if (values.length < 2) {
          el("sparkline").innerHTML = '<div class="empty">No equity history yet</div>';
          return;
        }
        var width = 680;
        var height = 120;
        var min = Math.min.apply(null, values);
        var max = Math.max.apply(null, values);
        var pad = 10;
        var span = Math.max(1, max - min);
        var d = "";
        values.forEach(function (value, index) {
          var x = pad + (index / Math.max(1, values.length - 1)) * (width - pad * 2);
          var y = height - pad - ((value - min) / span) * (height - pad * 2);
          d += (index ? " L " : "M ") + x.toFixed(2) + " " + y.toFixed(2);
        });
        el("sparkline").innerHTML =
          '<svg viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Equity curve">' +
          '<path d="' + d + '" fill="none" stroke="#175cd3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<line x1="' + pad + '" y1="' + (height - pad) + '" x2="' + (width - pad) + '" y2="' + (height - pad) + '" stroke="#d9dee7"/>' +
          '<text x="' + pad + '" y="16" fill="#667085" font-size="12">' + h(money(max)) + '</text>' +
          '<text x="' + pad + '" y="' + (height - 16) + '" fill="#667085" font-size="12">' + h(money(min)) + '</text>' +
          '</svg>';
      }

      function renderSnapshot(data) {
        var paper = data.paper || {};
        var live = data.live || {};
        var quote = live.quote || {};
        var chart = live.chart || {};

        el("equityValue").textContent = paper.available ? money(paper.equity) : "--";
        el("equitySub").textContent = paper.available ? "Starting equity " + money(paper.starting_equity) : "paper-data/state.json unavailable";

        el("pnlValue").textContent = paper.available ? money(paper.total_pnl) : "--";
        el("pnlValue").className = "metric-value " + cls(paper.total_pnl);
        el("pnlSub").textContent = paper.available
          ? "Realized " + money(paper.realized_pnl) + " / Unrealized " + money(paper.unrealized_pnl) + " / " + num(paper.total_return_pct, 4) + "%"
          : "No PnL data";

        el("openValue").textContent = paper.available ? String(paper.open_position_count) : "--";
        el("openSub").textContent = paper.available ? "Closed trade events " + paper.closed_trade_count + " / Win rate " + (paper.win_rate_pct == null ? "n/a" : num(paper.win_rate_pct, 2) + "%") : "No paper state";

        el("chartValue").textContent = chart.symbol || quote.symbol || "--";
        el("chartSub").textContent = live.connected ? "CDP connected, " + (chart.resolution || "--") + " timeframe" : (live.error || "CDP disconnected");
        setLiveBadge(Boolean(live.connected), live.connected ? "Live connected" : "Live offline");

        var riskClear = !paper.risk_pause && !(paper.risk_gates && paper.risk_gates.blocked && paper.risk_gates.blocked.length);
        el("riskBadge").className = "badge " + (riskClear ? "ok" : "warn");
        el("riskBadge").textContent = riskClear ? "Risk clear" : "Risk gated";

        renderSparkline(paper.daily_reports || []);
        renderPositions(paper.open_positions || []);
        renderCandidates(paper.candidate_selection, paper.candidate_selection_progress);
        renderSignals(paper.recent_signals || []);
        renderSystem(data);
        renderQuote(live);
        renderStudies(live.studies || {});
        renderCounts(paper.status_counts || {});

        el("lastUpdated").textContent = "Last update: " + new Date(data.generated_at).toLocaleString();
        el("reportLink").innerHTML = paper.files && paper.files.latest_report_md && paper.files.latest_report_md.exists
          ? '<a href="/api/report.md?token=' + encodeURIComponent(token) + '">Latest markdown report</a>'
          : "";
      }

      function renderPositions(positions) {
        var rows = positions.map(function (p) {
          return [
            h(p.symbol),
            h(p.side || "LONG"),
            h(p.entry_signal || p.status || "OPEN"),
            h(money(p.entry_price)),
            h(money(p.stop_price)),
            h(num(p.remaining_quantity, 6)),
            h(money(p.target_1)) + " / " + h(money(p.target_2)) + " / " + h(money(p.target_3))
          ];
        });
        el("positionsTable").innerHTML = table(["Symbol", "Side", "Signal", "Entry", "Stop", "Remaining", "Targets"], rows, "No open paper positions");
      }

      function renderSignals(signals) {
        var rows = signals.map(function (s) {
          return [
            h(s.time ? new Date(s.time).toLocaleString() : s.date),
            h(s.symbol),
            '<span class="badge info">' + h(s.status) + '</span>',
            h(money(s.entry_price)),
            h(money(s.stop_price)),
            h(num(s.R_value, 4))
          ];
        });
        el("signalsTable").innerHTML = table(["Time", "Symbol", "Status", "Entry", "Stop", "R"], rows, "No recent signals");
      }

      function renderCandidates(selection, progress) {
        var activeProgress = progress && progress.phase && progress.phase !== "complete";
        var source = activeProgress ? progress : selection;
        if (!source || !source.candidates || !source.candidates.length) {
          if (activeProgress) {
            el("candidatesTable").innerHTML =
              '<div class="empty">Scanning large universe: ' +
              h(progress.completed || 0) + '/' + h(progress.symbols_considered || 0) +
              (progress.current_symbol ? ' current ' + h(progress.current_symbol) : '') +
              '</div>';
            return;
          }
          el("candidatesTable").innerHTML = '<div class="empty">No large-universe selection has run yet</div>';
          return;
        }
        var rows = source.candidates.map(function (candidate) {
          return [
            h(candidate.symbol),
            h(candidate.asset_class || "--"),
            h(candidate.side || "--"),
            h(num(candidate.score, 2)),
            h(candidate.metrics ? money(candidate.metrics.close) : "--"),
            h(candidate.metrics ? num(candidate.metrics.relative_strength_20d_vs_benchmark, 2) : "--"),
            h((candidate.reasons || []).slice(0, 4).join(", "))
          ];
        });
        var progressText = activeProgress
          ? '<div class="subtle">Mode ' + h(progress.selection_mode || "--") + ' · scanning large universe: ' + h(progress.completed || 0) + '/' + h(progress.symbols_considered || 0) + (progress.current_symbol ? ' current ' + h(progress.current_symbol) : '') + '</div>'
          : '<div class="subtle">Mode ' + h(selection.selection_mode || "--") + ' · considered ' + h(selection.symbols_considered || 0) + ' symbols</div>';
        el("candidatesTable").innerHTML = progressText + table(["Symbol", "Class", "Side", "Score", "Close", "RS 20D", "Reasons"], rows, "No candidates selected");
      }

      function renderSystem(data) {
        var paper = data.paper || {};
        var git = data.project && data.project.git ? data.project.git : {};
        var files = paper.files || {};
        var live = data.live || {};
        var stateAge = files.state ? age(files.state.age_seconds) : "--";
        var reportAge = files.latest_report_md ? age(files.latest_report_md.age_seconds) : "--";
        var html = "";
        [
          ["Dashboard", data.server.host + ":" + data.server.port],
          ["Auth", data.server.auth],
          ["Mode", data.safety.mode],
          ["CDP", live.connected ? "connected" : "offline"],
          ["Git", git.branch || "unavailable"],
          ["Changed files", git.changed_count == null ? "--" : git.changed_count],
          ["State file", files.state && files.state.exists ? stateAge : "missing"],
          ["Latest report", files.latest_report_md && files.latest_report_md.exists ? reportAge : "missing"],
          ["Tunnel target", data.safety.tunnel_target],
        ].forEach(function (pair) {
          html += "<div>" + h(pair[0]) + "</div><div>" + h(pair[1]) + "</div>";
        });
        el("systemStatus").innerHTML = html;
      }

      function renderQuote(live) {
        var quote = live.quote || {};
        var ohlcv = live.ohlcv || {};
        var html = "";
        [
          ["Symbol", quote.symbol || "--"],
          ["Description", quote.description || "--"],
          ["Exchange", quote.exchange || "--"],
          ["Last", money(quote.last || quote.close)],
          ["Open / High / Low", money(quote.open) + " / " + money(quote.high) + " / " + money(quote.low)],
          ["Volume", num(quote.volume, 0)],
          ["20-bar change", ohlcv.change_pct || "--"],
          ["20-bar range", num(ohlcv.range, 4)]
        ].forEach(function (pair) {
          html += "<div>" + h(pair[0]) + "</div><div>" + h(pair[1]) + "</div>";
        });
        el("quoteStatus").innerHTML = html;
      }

      function renderStudies(studiesPayload) {
        var studies = studiesPayload.studies || [];
        if (!studies.length) {
          el("studyValues").innerHTML = '<div class="empty">No visible study values returned</div>';
          return;
        }
        var html = '<div class="stack">';
        studies.forEach(function (study) {
          html += '<div class="table-wrap"><table><thead><tr><th colspan="2">' + h(study.name) + '</th></tr></thead><tbody>';
          Object.keys(study.values || {}).forEach(function (key) {
            html += '<tr><td>' + h(key) + '</td><td class="mono">' + h(study.values[key]) + '</td></tr>';
          });
          html += '</tbody></table></div>';
        });
        html += '</div>';
        el("studyValues").innerHTML = html;
      }

      function renderCounts(counts) {
        var keys = Object.keys(counts);
        if (!keys.length) {
          el("statusCounts").innerHTML = '<div class="empty">No status counts yet</div>';
          return;
        }
        el("statusCounts").innerHTML = keys.sort().map(function (key) {
          return '<div class="badge info">' + h(key) + ': ' + h(counts[key]) + '</div>';
        }).join("");
      }

      async function load() {
        if (!token) {
          if (!tokenPromptDismissed) showTokenScreen(true);
          return;
        }
        try {
          var response = await fetch("/api/status", {
            headers: { "Authorization": "Bearer " + token },
            cache: "no-store"
          });
          if (response.status === 401) {
            localStorage.removeItem("tvMcpDashboardToken");
            token = "";
            tokenPromptDismissed = false;
            showTokenScreen(true);
            setLiveBadge(false, "Unauthorized");
            return;
          }
          var payload = await response.json();
          if (!response.ok || !payload.success) throw new Error(payload.error || "Dashboard API failed");
          showTokenScreen(false);
          renderSnapshot(payload);
        } catch (error) {
          setLiveBadge(false, "API error");
          el("lastUpdated").textContent = "Last error: " + error.message;
        }
      }

      el("refreshButton").addEventListener("click", load);
      el("tokenButton").addEventListener("click", function () {
        tokenPromptDismissed = false;
        el("tokenInput").value = "";
        showTokenScreen(true);
      });
      el("tokenCloseButton").addEventListener("click", function () {
        tokenPromptDismissed = true;
        showTokenScreen(false);
      });
      el("tokenForm").addEventListener("submit", function (event) {
        event.preventDefault();
        token = el("tokenInput").value.trim();
        if (token) {
          tokenPromptDismissed = false;
          localStorage.setItem("tvMcpDashboardToken", token);
          el("tokenInput").value = "";
          showTokenScreen(false);
          load();
        }
      });

      load();
      timer = setInterval(load, 3000);
      window.addEventListener("beforeunload", function () {
        if (timer) clearInterval(timer);
      });
    })();
  </script>
</body>
</html>`;
