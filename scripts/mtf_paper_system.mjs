#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "../src/core/chart.js";
import * as watchlist from "../src/core/watchlist.js";
import { disconnect, evaluate } from "../src/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const configPath = resolve(root, "config", "mtf_paper_config.json");
const dataDir = resolve(root, "paper-data");
const reportsDir = resolve(dataDir, "reports");
const logsDir = resolve(dataDir, "logs");
const statePath = resolve(dataDir, "state.json");
const latestReportPath = resolve(reportsDir, "latest.md");
const latestCandidatesPath = resolve(dataDir, "latest-candidates.json");
const scanScript = resolve(root, "scripts", "mtf_trend_pullback_scan.mjs");
const selectScript = resolve(root, "scripts", "mtf_universe_select.mjs");

const args = process.argv.slice(2);
const symbolsArg = argValue("--symbols");
const config = readJson(configPath);

mkdirSync(reportsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

function argValue(name) {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2), "utf8");
}

function sgDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.report_timezone || "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function timestamp() {
  return new Date().toISOString();
}

function n(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function ensureState() {
  const existing = readJson(statePath);
  if (existing) return existing;
  return {
    strategy_name: config.strategy_name,
    mode: "paper_trading_only",
    created_at: timestamp(),
    starting_equity: config.starting_equity,
    equity: config.starting_equity,
    realized_pnl: 0,
    open_positions: [],
    closed_trades: [],
    signal_log: [],
    daily_reports: [],
    risk_pause: false,
    risk_pause_reason: null
  };
}

async function openWatchlistPanelIfNeeded() {
  let current = await watchlist.get();
  if (current.count > 0) return current;

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Watchlist, details, and news"]')
        || document.querySelector('[aria-label*="Watchlist"]');
      if (btn && btn.offsetParent !== null) btn.click();
      return true;
    })()
  `);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  current = await watchlist.get();
  return current;
}

async function resolveSymbols() {
  const source = symbolsArg || config.candidate_source || "watchlist";

  if (source !== "watchlist" && source !== "universe") {
    return symbolsArg.split(",").map((symbol) => symbol.trim()).filter(Boolean);
  }

  if (source === "universe") {
    const cached = cachedUniverseSymbols();
    if (cached.length > 0) return cached;

    try {
      const { selection, stderr } = await runUniverseSelect();
      if (stderr) {
        writeFileSync(join(logsDir, `${sgDate()}.universe.stderr.log`), stderr, "utf8");
      }
      const symbols = (selection.candidates || []).map((candidate) => candidate.symbol).filter(Boolean);
      const filtered = filterSymbols(symbols);
      if (filtered.length > 0) return filtered.slice(0, config.max_symbols_per_run || filtered.length);
      console.error("Universe preselection returned no candidates; falling back to watchlist/default symbols.");
    } catch (error) {
      console.error(`Universe preselection failed: ${error.message}`);
      if (error.stderr) writeFileSync(join(logsDir, `${sgDate()}.universe.stderr.log`), error.stderr, "utf8");
      if (error.stdout) writeFileSync(join(logsDir, `${sgDate()}.universe.stdout.log`), error.stdout, "utf8");
    }
  }

  try {
    const list = await openWatchlistPanelIfNeeded();
    const symbols = (list.symbols || []).map((item) => item.symbol).filter(Boolean);
    const filtered = filterSymbols(symbols);
    if (filtered.length > 0) return filtered.slice(0, config.max_symbols_per_run || filtered.length);
  } catch (error) {
    console.error(`Watchlist read failed: ${error.message}`);
  }

  return filterSymbols(config.default_symbols_if_watchlist_unavailable || []);
}

function cachedUniverseSymbols() {
  if (!existsSync(latestCandidatesPath)) return [];
  const cacheMinutes = Number(config.preselect_cache_minutes || 0);
  if (cacheMinutes <= 0) return [];

  let stat;
  try {
    stat = statSync(latestCandidatesPath);
  } catch {
    return [];
  }

  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs > cacheMinutes * 60 * 1000) return [];

  const selection = readJson(latestCandidatesPath, null);
  if (!selection?.success) return [];

  const minCachedSymbols = Number(config.preselect_min_cached_symbols || Math.min(config.preselect_max_symbols || 0, 20));
  if (minCachedSymbols > 0 && Number(selection.symbols_considered || 0) < minCachedSymbols) return [];

  const symbols = (selection.candidates || []).map((candidate) => candidate.symbol).filter(Boolean);
  const filtered = filterSymbols(symbols);
  if (!filtered.length) return [];

  console.error(`Using cached universe candidates from ${latestCandidatesPath} (${Math.round(ageMs / 60000)}m old).`);
  return filtered.slice(0, config.max_symbols_per_run || filtered.length);
}

function runUniverseSelect() {
  return new Promise((resolvePromise, reject) => {
    const childArgs = [
      selectScript,
      `--benchmark=${config.benchmark}`,
      `--top=${config.preselect_top_n || config.max_symbols_per_run || 8}`,
      `--max=${config.preselect_max_symbols || 120}`,
      `--min-score=${config.preselect_min_score ?? 0}`,
      "--save-latest",
    ];
    if (config.universe_path) childArgs.push(`--universe=${config.universe_path}`);

    execFile(process.execPath, childArgs, {
      cwd: root,
      timeout: 45 * 60 * 1000,
      maxBuffer: 40 * 1024 * 1024,
      env: { ...process.env, TRADINGVIEW_CDP_HOST: "127.0.0.1" },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      try {
        resolvePromise({ selection: JSON.parse(stdout), stderr });
      } catch (parseError) {
        parseError.stdout = stdout;
        parseError.stderr = stderr;
        reject(parseError);
      }
    });
  });
}

function filterSymbols(symbols) {
  const exclude = new Set((config.exclude_symbols || []).map((symbol) => symbol.toUpperCase()));
  const prefixes = config.exclude_prefixes || [];
  const seen = new Set();
  return symbols.filter((symbol) => {
    const upper = symbol.toUpperCase();
    if (seen.has(upper)) return false;
    seen.add(upper);
    if (exclude.has(upper)) return false;
    if (prefixes.some((prefix) => upper.startsWith(prefix.toUpperCase()))) return false;
    return true;
  });
}

function assetClass(symbol) {
  if (/BITSTAMP:|BINANCE:/i.test(symbol)) return "crypto";
  if (/^FX:/i.test(symbol)) return "forex";
  if (/^TVC:/i.test(symbol)) return "commodity";
  if (/AMEX:SPY|NASDAQ:QQQ|AMEX:IWM|AMEX:DIA|AMEX:SMH|AMEX:XL|AMEX:GLD|AMEX:SLV|AMEX:USO|NASDAQ:TLT/i.test(symbol)) return "etf";
  return "stock";
}

function benchmarkForSymbol(symbol) {
  const cls = assetClass(symbol);
  const byClass = config.benchmark_by_asset_class || {};
  const fallbackByClass = config.fallback_benchmark_by_asset_class || {};
  let selected = byClass[cls] || config.benchmark;
  if (selected && selected.toUpperCase() === symbol.toUpperCase()) {
    selected = fallbackByClass[cls] || config.benchmark;
  }
  return selected || config.benchmark;
}

async function runScan(symbols) {
  const groups = new Map();
  for (const symbol of symbols) {
    const groupBenchmark = benchmarkForSymbol(symbol);
    if (!groups.has(groupBenchmark)) groups.set(groupBenchmark, []);
    groups.get(groupBenchmark).push(symbol);
  }

  if (groups.size <= 1) {
    const [groupBenchmark, groupSymbols] = [...groups.entries()][0] || [config.benchmark, symbols];
    return runScanGroup(groupSymbols, groupBenchmark);
  }

  const mergedResults = [];
  const stderrs = [];
  for (const [groupBenchmark, groupSymbols] of groups.entries()) {
    const { scan, stderr } = await runScanGroup(groupSymbols, groupBenchmark);
    if (stderr) stderrs.push(stderr);
    mergedResults.push(...(scan.results || []));
  }
  return {
    scan: {
      success: true,
      generated_at: timestamp(),
      strategy: config.strategy_name,
      benchmark: "grouped_by_asset_class",
      symbols_scanned: mergedResults.length,
      results: mergedResults,
    },
    stderr: stderrs.join("\n"),
  };
}

function runScanGroup(symbols, groupBenchmark) {
  return new Promise((resolvePromise, reject) => {
    const childArgs = [
      scanScript,
      `--benchmark=${groupBenchmark}`,
      `--symbols=${symbols.join(",")}`,
    ];
    execFile(process.execPath, childArgs, {
      cwd: root,
      timeout: 20 * 60 * 1000,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        TRADINGVIEW_CDP_HOST: "127.0.0.1",
        MTF_SCAN_BAR_TIMEOUT_MS: String(config.scan_bar_timeout_ms || 20000),
        MTF_SCAN_SYMBOL_TIMEOUT_MS: String(config.scan_symbol_timeout_ms || 70000),
      },
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      try {
        resolvePromise({ scan: JSON.parse(stdout), stderr });
      } catch (parseError) {
        parseError.stdout = stdout;
        parseError.stderr = stderr;
        reject(parseError);
      }
    });
  });
}

function currentPrice(result) {
  return result?.risk_plan?.entry_price ?? result?.metrics?.daily_close ?? null;
}

function positionFor(state, symbol) {
  return state.open_positions.find((position) => position.symbol === symbol && position.status === "OPEN");
}

function sideForStatus(status) {
  if (/^SHORT_|^BUY_INVALIDATED$/.test(status || "")) return "SHORT";
  if (/^BUY_|^WATCH_PULLBACK$|^SELL_INVALIDATED$/.test(status || "")) return "LONG";
  return "NONE";
}

function isShortPosition(position) {
  return position.side === "SHORT";
}

function riskGates(state, date, side = null) {
  const dayLoss = state.closed_trades
    .filter((trade) => trade.exit_date === date || trade.event_date === date)
    .reduce((sum, trade) => sum + (trade.realized_pnl || 0), 0);
  const weekKey = date.slice(0, 7);
  const weekLoss = state.closed_trades
    .filter((trade) => (trade.exit_date || trade.event_date || "").startsWith(weekKey))
    .reduce((sum, trade) => sum + (trade.realized_pnl || 0), 0);
  const peak = Math.max(state.starting_equity, ...(state.daily_reports || []).map((report) => report.equity || 0));
  const drawdownPct = peak > 0 ? Math.max(0, (peak - state.equity) / peak) : 0;
  const blocked = [];
  if (dayLoss <= -state.starting_equity * config.daily_loss_stop_pct) blocked.push("DAILY_LOSS_STOP");
  if (weekLoss <= -state.starting_equity * config.weekly_loss_stop_pct) blocked.push("WEEKLY_LOSS_STOP");
  if (drawdownPct >= config.pause_drawdown_pct) blocked.push("DRAWDOWN_PAUSE");
  if (side && side !== "NONE") {
    const sameDirectionOpen = state.open_positions.filter((p) => p.status === "OPEN" && (p.side || "LONG") === side).length;
    if (sameDirectionOpen >= config.max_same_direction_open_positions) blocked.push(`MAX_OPEN_${side}_POSITIONS`);
  }
  return { blocked, dayLoss, weekLoss, drawdownPct };
}

function openPaperPosition(state, result, date, events) {
  const riskPlan = result.risk_plan || {};
  const entry = riskPlan.entry_price;
  const stop = riskPlan.stop_price;
  const rValue = riskPlan.R_value;
  const side = result.trade_side || sideForStatus(result.status);
  if (!Number.isFinite(entry) || !Number.isFinite(stop) || !Number.isFinite(rValue) || rValue <= 0) {
    events.push({ type: "ENTRY_SKIPPED", symbol: result.symbol, reason: "INVALID_RISK_PLAN" });
    return;
  }
  if (side !== "LONG" && side !== "SHORT") {
    events.push({ type: "ENTRY_SKIPPED", symbol: result.symbol, reason: "UNKNOWN_SIDE" });
    return;
  }

  const riskDollars = state.equity * config.risk_per_trade_pct;
  const quantity = riskDollars / rValue;
  const position = {
    id: `${date}-${result.symbol.replace(/[^A-Z0-9]/gi, "_")}-${Date.now()}`,
    symbol: result.symbol,
    side,
    status: "OPEN",
    entry_date: date,
    entry_time: timestamp(),
    entry_signal: result.status,
    entry_price: entry,
    stop_price: stop,
    initial_stop_price: stop,
    R_value: rValue,
    target_1: riskPlan.target_1,
    target_2: riskPlan.target_2,
    target_3: n(side === "SHORT" ? entry - rValue * 3 : entry + rValue * 3),
    quantity,
    remaining_quantity: quantity,
    risk_dollars: riskDollars,
    risk_pct: config.risk_per_trade_pct,
    milestones: {
      TAKE_PROFIT_1: false,
      TAKE_PROFIT_2: false,
      TAKE_PROFIT_3: false
    },
    events: [
      {
        event_date: date,
        event_time: timestamp(),
        type: "PAPER_ENTRY",
        signal: result.status,
        side,
        price: entry,
        stop_price: stop
      }
    ]
  };
  state.open_positions.push(position);
  events.push({ type: "PAPER_ENTRY", symbol: result.symbol, side, price: entry, stop_price: stop, R_value: rValue });
}

function closeQuantity(state, position, date, price, quantity, reason, events) {
  const qty = Math.min(quantity, position.remaining_quantity);
  if (qty <= 0) return;
  const short = isShortPosition(position);
  const realizedPnl = short ? (position.entry_price - price) * qty : (price - position.entry_price) * qty;
  const realizedR = short ? (position.entry_price - price) / position.R_value : (price - position.entry_price) / position.R_value;
  position.remaining_quantity = n(position.remaining_quantity - qty, 8);
  const event = {
    event_date: date,
    event_time: timestamp(),
    type: reason,
    symbol: position.symbol,
    side: position.side || "LONG",
    price,
    quantity: qty,
    realized_pnl: n(realizedPnl),
    realized_R: n(realizedR, 4)
  };
  position.events.push(event);
  state.closed_trades.push({
    id: position.id,
    symbol: position.symbol,
    side: position.side || "LONG",
    entry_date: position.entry_date,
    event_date: date,
    exit_date: position.remaining_quantity <= 0 ? date : null,
    entry_price: position.entry_price,
    exit_price: price,
    quantity: qty,
    realized_pnl: n(realizedPnl),
    realized_R: n(realizedR, 4),
    exit_reason: reason,
    signal: position.entry_signal
  });
  state.realized_pnl = n((state.realized_pnl || 0) + realizedPnl);
  state.equity = n((state.equity || state.starting_equity) + realizedPnl);
  events.push(event);
  if (position.remaining_quantity <= 0) {
    position.status = "CLOSED";
    position.exit_date = date;
    position.exit_reason = reason;
  }
}

function updateOpenPosition(state, position, result, date, events) {
  const price = currentPrice(result);
  if (!Number.isFinite(price)) {
    events.push({ type: "POSITION_UPDATE_SKIPPED", symbol: position.symbol, reason: "NO_CURRENT_PRICE" });
    return;
  }

  const short = isShortPosition(position);
  const hitTarget1 = short ? price <= position.target_1 : price >= position.target_1;
  const hitTarget2 = short ? price <= position.target_2 : price >= position.target_2;
  const hitTarget3 = short ? price <= position.target_3 : price >= position.target_3;
  const hitStop = short ? price >= position.stop_price : price <= position.stop_price;
  const exitStatuses = short ? (config.short_exit_statuses || config.exit_statuses || []) : (config.long_exit_statuses || config.exit_statuses || []);

  if (!position.milestones.TAKE_PROFIT_1 && hitTarget1) {
    position.milestones.TAKE_PROFIT_1 = true;
    position.stop_price = short ? Math.min(position.stop_price, position.entry_price) : Math.max(position.stop_price, position.entry_price);
    position.events.push({ event_date: date, event_time: timestamp(), type: "TAKE_PROFIT_1", price, action: "MOVE_STOP_TO_BREAKEVEN" });
    events.push({ type: "TAKE_PROFIT_1", symbol: position.symbol, side: position.side || "LONG", price, action: "MOVE_STOP_TO_BREAKEVEN" });
  }

  if (!position.milestones.TAKE_PROFIT_2 && hitTarget2) {
    position.milestones.TAKE_PROFIT_2 = true;
    closeQuantity(state, position, date, position.target_2, position.quantity / 3, "TAKE_PROFIT_2", events);
  }

  if (!position.milestones.TAKE_PROFIT_3 && hitTarget3) {
    position.milestones.TAKE_PROFIT_3 = true;
    closeQuantity(state, position, date, position.target_3, position.quantity / 3, "TAKE_PROFIT_3", events);
  }

  if (position.status !== "OPEN") return;

  if (hitStop) {
    closeQuantity(state, position, date, price, position.remaining_quantity, "STOP_LOSS", events);
    return;
  }

  if (exitStatuses.includes(result.status)) {
    closeQuantity(state, position, date, price, position.remaining_quantity, result.status, events);
  }
}

function processScan(state, scan, date) {
  const events = [];
  let gates = riskGates(state, date);
  for (const result of scan.results || []) {
    state.signal_log.push({
      date,
      time: timestamp(),
      symbol: result.symbol,
      status: result.status,
      side: result.trade_side || sideForStatus(result.status),
      entry_price: result.risk_plan?.entry_price ?? null,
      stop_price: result.risk_plan?.stop_price ?? null,
      R_value: result.risk_plan?.R_value ?? null,
      trend_condition: result.trend_condition,
      setup_condition: result.setup_condition,
      trigger_condition: result.trigger_condition
    });

    const position = positionFor(state, result.symbol);
    if (position) {
      updateOpenPosition(state, position, result, date, events);
      continue;
    }

    if ((config.entry_statuses || []).includes(result.status)) {
      const side = result.trade_side || sideForStatus(result.status);
      const entryGates = riskGates(state, date, side);
      if (entryGates.blocked.length > 0) {
        events.push({ type: "ENTRY_BLOCKED_BY_RISK_GATE", symbol: result.symbol, side, gates: entryGates.blocked });
      } else {
        openPaperPosition(state, result, date, events);
      }
    } else if ((config.watch_statuses || []).includes(result.status)) {
      events.push({ type: result.status, symbol: result.symbol, side: result.trade_side || sideForStatus(result.status), price: currentPrice(result) });
    }
  }
  state.open_positions = state.open_positions.filter((position) => position.status === "OPEN");
  gates = riskGates(state, date);
  return { events, gates };
}

function unrealizedPnl(state, scan) {
  const bySymbol = new Map((scan.results || []).map((result) => [result.symbol, result]));
  return state.open_positions.reduce((sum, position) => {
    const price = currentPrice(bySymbol.get(position.symbol));
    if (!Number.isFinite(price)) return sum;
    return sum + (isShortPosition(position)
      ? (position.entry_price - price) * position.remaining_quantity
      : (price - position.entry_price) * position.remaining_quantity);
  }, 0);
}

function buildReport({ date, state, scan, events, gates, symbols, unrealized }) {
  const counts = {};
  for (const result of scan.results || []) counts[result.status] = (counts[result.status] || 0) + 1;
  const closed = state.closed_trades;
  const wins = closed.filter((trade) => (trade.realized_pnl || 0) > 0).length;
  const winRate = closed.length ? `${n((wins / closed.length) * 100)}%` : "n/a";
  const totalR = closed.reduce((sum, trade) => sum + (trade.realized_R || 0), 0);
  const reportJson = {
    date,
    generated_at: timestamp(),
    strategy: config.strategy_name,
    mode: "paper_trading_only",
    scanned_symbols: symbols,
    status_counts: counts,
    events,
    risk_gates: gates,
    equity: state.equity,
    realized_pnl: state.realized_pnl,
    unrealized_pnl: n(unrealized),
    open_positions: state.open_positions,
    closed_trade_count: closed.length,
    win_rate: winRate,
    total_realized_R: n(totalR, 4),
    scan_results: scan.results
  };

  const lines = [];
  lines.push(`# ${config.strategy_name} Paper Report - ${date}`);
  lines.push("");
  lines.push("Mode: paper trading only. No real orders, no alert changes, no watchlist changes.");
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Equity: ${n(state.equity)}`);
  lines.push(`- Realized PnL: ${n(state.realized_pnl)}`);
  lines.push(`- Unrealized PnL: ${n(unrealized)}`);
  lines.push(`- Open positions: ${state.open_positions.length}`);
  lines.push(`- Closed trade events: ${closed.length}`);
  lines.push(`- Win rate: ${winRate}`);
  lines.push(`- Total realized R: ${n(totalR, 4)}`);
  lines.push(`- Risk gates: ${gates.blocked.length ? gates.blocked.join(", ") : "CLEAR"}`);
  lines.push("");
  lines.push("## Status Counts");
  for (const [status, count] of Object.entries(counts)) lines.push(`- ${status}: ${count}`);
  lines.push("");
  lines.push("## Signals");
  lines.push("| Symbol | Side | Status | Entry | Stop | R | RSI 1H | RSI 15m |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const result of scan.results || []) {
    lines.push(`| ${result.symbol} | ${result.trade_side || sideForStatus(result.status)} | ${result.status} | ${result.risk_plan?.entry_price ?? ""} | ${result.risk_plan?.stop_price ?? ""} | ${result.risk_plan?.R_value ?? ""} | ${result.metrics?.rsi14_1h ?? ""} | ${result.metrics?.rsi14_15m ?? ""} |`);
  }
  lines.push("");
  lines.push("## Events");
  if (!events.length) lines.push("No paper entries, exits, or take-profit events today.");
  for (const event of events) lines.push(`- ${event.type} | ${event.symbol || ""} | side=${event.side || ""} | price=${event.price ?? ""} | pnl=${event.realized_pnl ?? ""} | R=${event.realized_R ?? ""}`);
  lines.push("");
  lines.push("## Open Positions");
  if (!state.open_positions.length) lines.push("No open paper positions.");
  for (const position of state.open_positions) {
    lines.push(`- ${position.symbol} ${position.side || "LONG"}: entry=${position.entry_price}, stop=${position.stop_price}, remaining=${n(position.remaining_quantity, 6)}, target1=${position.target_1}, target2=${position.target_2}, target3=${position.target_3}`);
  }
  lines.push("");
  lines.push("## Notes");
  lines.push("- Output states include: NO_TRADE / WATCH_PULLBACK / SHORT_WATCH_PULLBACK / BUY_TRIGGER_* / SHORT_TRIGGER_* / SELL_INVALIDATED / BUY_INVALIDATED.");
  lines.push("- This report is for research and strategy testing only.");
  return { reportJson, markdown: `${lines.join("\n")}\n` };
}

async function main() {
  const date = sgDate();
  const state = ensureState();
  const original = await chart.getState().catch(() => null);
  const symbols = await resolveSymbols();
  if (!symbols.length) throw new Error("No symbols available for paper run.");

  const { scan, stderr } = await runScan(symbols);
  if (stderr) {
    writeFileSync(join(logsDir, `${date}.scan.stderr.log`), stderr, "utf8");
  }
  const { events, gates } = processScan(state, scan, date);
  const unrealized = unrealizedPnl(state, scan);
  const { reportJson, markdown } = buildReport({ date, state, scan, events, gates, symbols, unrealized });

  state.daily_reports = (state.daily_reports || []).filter((report) => report.date !== date);
  state.daily_reports.push({
    date,
    generated_at: reportJson.generated_at,
    equity: state.equity,
    realized_pnl: state.realized_pnl,
    unrealized_pnl: n(unrealized),
    open_positions: state.open_positions.length,
    status_counts: reportJson.status_counts,
    events: events.length
  });

  const backup = existsSync(statePath) ? `${statePath}.backup.${Date.now()}` : null;
  if (backup) copyFileSync(statePath, backup);
  writeJson(statePath, state);
  writeJson(join(reportsDir, `${date}.json`), reportJson);
  writeFileSync(join(reportsDir, `${date}.md`), markdown, "utf8");
  writeFileSync(latestReportPath, markdown, "utf8");

  if (original?.symbol) {
    try {
      await chart.setSymbol({ symbol: original.symbol });
      await chart.setTimeframe({ timeframe: original.resolution });
    } catch {}
  }

  console.log(JSON.stringify({
    success: true,
    date,
    report: join(reportsDir, `${date}.md`),
    latest_report: latestReportPath,
    state: statePath,
    scanned_symbols: symbols,
    events,
    status_counts: reportJson.status_counts,
    equity: state.equity,
    unrealized_pnl: n(unrealized)
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ success: false, error: error.message, stdout: error.stdout, stderr: error.stderr }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect();
  });
