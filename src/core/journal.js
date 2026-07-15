/**
 * Trade journal — auto-captured from replay mode only (no manual live-trade
 * logging yet). `replay.trade()` calls recordOpen/recordClose around each
 * buy/sell/close so backtest runs land here with a win/loss outcome, taggable
 * by which setup/bias-criterion triggered the trade.
 *
 * Only clean buy/sell -> close pairs are journaled. If a position is flipped
 * (buy then sell with no intervening close), the first leg's `pending` entry
 * is silently overwritten and never journaled — not solving general
 * position-flip accounting here.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const DEFAULT_JOURNAL_PATH = join(homedir(), ".tradingview-mcp", "journal.json");

function load(journalPath) {
  const p = journalPath || DEFAULT_JOURNAL_PATH;
  if (!existsSync(p)) return { trades: [], pending: null };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return { trades: parsed.trades || [], pending: parsed.pending || null };
  } catch (e) {
    throw new Error(`Failed to parse journal at ${p}: ${e.message}`);
  }
}

function save(journalPath, state) {
  const p = journalPath || DEFAULT_JOURNAL_PATH;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(state, null, 2));
}

function classify(pnlDelta) {
  if (pnlDelta > 0) return "win";
  if (pnlDelta < 0) return "loss";
  return "breakeven";
}

export function recordOpen({ symbol, timeframe, side, currentDate, cumulativePnl, tag, journal_path } = {}) {
  const state = load(journal_path);
  state.pending = {
    symbol,
    timeframe,
    side,
    opened_date: currentDate ?? null,
    pnl_at_open: cumulativePnl ?? 0,
    tag: tag || null,
  };
  save(journal_path, state);
  return { success: true, pending: state.pending };
}

export function recordClose({ currentDate, cumulativePnl, journal_path } = {}) {
  const state = load(journal_path);
  if (!state.pending) return { success: true, recorded: false };

  const pnlDelta = (cumulativePnl ?? 0) - (state.pending.pnl_at_open ?? 0);
  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: state.pending.symbol,
    timeframe: state.pending.timeframe,
    side: state.pending.side,
    opened_date: state.pending.opened_date,
    closed_date: currentDate ?? null,
    pnl_delta: pnlDelta,
    outcome: classify(pnlDelta),
    tag: state.pending.tag,
    source: "replay",
  };

  state.trades.push(record);
  state.pending = null;
  save(journal_path, state);
  return { success: true, recorded: true, trade: record };
}

export function getTrades({ tag, symbol, limit, journal_path } = {}) {
  const state = load(journal_path);
  let trades = [...state.trades].reverse(); // most recent first
  if (tag) trades = trades.filter((t) => t.tag === tag);
  if (symbol) trades = trades.filter((t) => t.symbol === symbol);
  if (limit) trades = trades.slice(0, limit);
  return { success: true, trades, pending: state.pending };
}

function summarize(trades) {
  const wins = trades.filter((t) => t.outcome === "win").length;
  const losses = trades.filter((t) => t.outcome === "loss").length;
  const breakeven = trades.filter((t) => t.outcome === "breakeven").length;
  const count = trades.length;
  const decisive = wins + losses;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl_delta, 0);
  return {
    count,
    wins,
    losses,
    breakeven,
    win_rate: decisive > 0 ? wins / decisive : null,
    total_pnl: totalPnl,
  };
}

export function getStats({ tag, symbol, journal_path } = {}) {
  const state = load(journal_path);
  let trades = state.trades;
  if (symbol) trades = trades.filter((t) => t.symbol === symbol);

  if (tag) {
    trades = trades.filter((t) => t.tag === tag);
    return { success: true, tag, ...summarize(trades) };
  }

  const tags = [...new Set(trades.map((t) => t.tag))];
  const by_tag = {};
  for (const t of tags) {
    by_tag[t === null ? "(untagged)" : t] = summarize(trades.filter((tr) => tr.tag === t));
  }

  return { success: true, overall: summarize(trades), by_tag };
}

export function clear({ journal_path } = {}) {
  save(journal_path, { trades: [], pending: null });
  return { success: true };
}
