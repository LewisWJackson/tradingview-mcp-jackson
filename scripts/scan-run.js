#!/usr/bin/env node
// Scanner runner - applies rules.json `scan_logic` to every symbol in the
// universe and prints ONE JSON signal object per line to stdout. Nothing is
// sent from here; pipe stdout into scripts/notify-telegram.js:
//
//   node scripts/scan-run.js | node scripts/notify-telegram.js
//
// This script never reads .env and never handles the bot token - the
// notifier does that on its own side of the pipe.
//
// Reuses the project's own CDP layer (src/connection.js + src/core/*), so
// TradingView Desktop must be running with --remote-debugging-port=9222,
// with the four active indicators on the chart: "Supertrend", "Support and
// Resistance Levels with Breaks", "Volume Weighted Average Price" (Session
// VWAP), and "Relative Strength Index".
//
// Architecture: 5m = MAIN trend / bias, 3m = CONFIRMATION / trigger.
// Every gate reads the last CLOSED candle on its timeframe (index length-2),
// never the still-forming bar, so a signal does not repaint.
//
// Gates (from rules.json > scan_logic, the 4-indicator confluence version):
//   Gate 1   5m trend    - Supertrend(10, close, 3) on the last closed 5m bar:
//                          price above line = BULL, below = BEAR. This sets the
//                          directional bias; a flip on the last closed 5m bar
//                          = WAIT (one bar to confirm). The 3m stage can only
//                          confirm or withhold - it never changes the side.
//   Gate 2   3m confirm  - 3m Supertrend aligned with the 5m trend AND the last
//                          closed 3m candle closes on the trend side of the 3m
//                          line. Failure -> WAIT (a "watch", not a trade).
//   Gate 2b  VWAP        - price above session VWAP required for BUY, below
//                          required for SELL; wrong side = conflict -> WAIT.
//   Gate 2c  RSI         - RSI(14) on 5m; blocks BUY if >= 70 (overbought),
//                          blocks SELL if <= 30 (oversold) -> WAIT.
//   Gate 3   risk        - entry = last closed 3m close; ATR(14) on 3m; stop =
//                          recent closed-3m swing (±0.1*ATR), clamped to
//                          [0.8, 2.5]*ATR else 1.5*ATR; target = nearest S&R
//                          level in trade direction; require final R/R >=
//                          min_risk_reward (2.0). No valid target / R/R < min
//                          -> WAIT.
//   Session             - respects scan_logic.session_profiles (NSE / MCX GOLD)
//                          new-signal windows in IST; weekends -> WAIT.
//
// BUY/SELL requires genuine confluence across all 4 gates; any conflict -> WAIT.
//
// Output line shape (consumed by notify-telegram.js):
//   {"symbol","side":"BUY|SELL|WAIT","entry","stop","target","rr","rr_text",
//    "bar_time","reasons":[...],"scan_time","trend_5m","tf_trend","tf_entry"}
//
// Flags: --symbols a,b,c  (override universe)   --settle <ms>  (default 1800)
//        --lookback <n> (swing window, default 10)   --no-restore
//        --per-symbol <sec> (hang guard per symbol, default 35)
//        --deadline <sec>   (hard wall-clock exit, default 300)
//        --verbose        --help

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chart, data } from '../src/core/index.js';
import { disconnect } from '../src/connection.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const RULES_PATH = resolve(PROJECT_ROOT, 'rules.json');

const HELP = `scan-run.js - apply rules.json scan_logic and print JSON signal lines to stdout

  node scripts/scan-run.js                       scan the full universe
  node scripts/scan-run.js --symbols NSE:NIFTY,MCX:GOLD1!
  node scripts/scan-run.js | node scripts/notify-telegram.js     (the integration)

  --settle <ms>   wait after each symbol/timeframe switch (default 1800)
  --lookback <n>  bars for the 3m swing stop (default 10)
  --no-restore    leave the chart on the last scanned symbol
  --verbose       progress + per-gate detail on stderr
  --help

5m = main trend / bias, 3m = confirmation. Only stdout carries JSON; all logs
go to stderr. Nothing is sent - pipe to notify-telegram.js.`;

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { symbols: null, settle: 1800, lookback: 10, perSymbol: 35, deadline: 300, restore: true, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--verbose' || x === '-v') a.verbose = true;
    else if (x === '--no-restore') a.restore = false;
    else if (x === '--symbols') a.symbols = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--settle') a.settle = Math.max(0, Number(argv[++i]) || 0);
    else if (x === '--lookback') a.lookback = Math.max(2, Number(argv[++i]) || 10);
    else if (x === '--per-symbol') a.perSymbol = Math.max(10, Number(argv[++i]) || 35);
    else if (x === '--deadline') a.deadline = Math.max(60, Number(argv[++i]) || 300);
    else { console.error(`scan-run: unknown argument "${x}" (try --help)`); process.exit(2); }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// getOhlcv can throw "chart may still be loading" for a few seconds after a
// symbol / timeframe switch. Poll until we get a usable series or time out.
async function readBars(minBars, count = 250, tries = 12, gap = 600) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await data.getOhlcv({ count });
      const bars = res?.bars || [];
      if (bars.length >= minBars) return bars;
      lastErr = new Error(`only ${bars.length} bars so far`);
    } catch (e) { lastErr = e; }
    await sleep(gap);
  }
  throw new Error(`bars not ready after ${((tries * gap) / 1000).toFixed(0)}s - ${lastErr?.message || 'unknown'}`);
}
const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')));
const f2 = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });

// ── indicator math (dependency-free) ───────────────────────────────
function wilderATR(bars, period) {
  const n = bars.length;
  const atr = new Array(n).fill(null);
  if (n < period + 1) return atr;
  const tr = new Array(n).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < n; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let seed = 0;
  for (let i = 1; i <= period; i++) seed += tr[i];
  atr[period] = seed / period;
  for (let i = period + 1; i < n; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

// TradingView ta.supertrend equivalent. src = close (matches the chart's input).
function supertrend(bars, period = 10, factor = 3) {
  const n = bars.length;
  const atr = wilderATR(bars, period);
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(null); // 1 = up/bull, -1 = down/bear
  let upPrev = null, dnPrev = null, dirPrev = null;
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const src = bars[i].close;
    let up = src - factor * atr[i];
    let dn = src + factor * atr[i];
    if (upPrev != null) up = bars[i - 1].close > upPrev ? Math.max(up, upPrev) : up;
    if (dnPrev != null) dn = bars[i - 1].close < dnPrev ? Math.min(dn, dnPrev) : dn;
    let d;
    if (dirPrev == null) d = 1;
    else if (dirPrev === -1 && bars[i].close > dnPrev) d = 1;
    else if (dirPrev === 1 && bars[i].close < upPrev) d = -1;
    else d = dirPrev;
    line[i] = d === 1 ? up : dn;
    dir[i] = d;
    upPrev = up; dnPrev = dn; dirPrev = d;
  }
  return { line, dir, atr };
}

// ── study readers ──────────────────────────────────────────────────
function findStudy(list, re) { return (list || []).find((s) => re.test(s.name || '')); }

function readSupertrendChart(studies) {
  const s = findStudy(studies, /supertrend/i);
  if (!s) return null;
  const v = s.values || {};
  if (v['Up Trend'] != null) return { dir: 1, line: num(v['Up Trend']) };
  if (v['Down Trend'] != null) return { dir: -1, line: num(v['Down Trend']) };
  return null;
}

function readSR(studies) {
  const s = findStudy(studies, /support and resistance levels with breaks/i);
  if (!s) return null;
  const v = s.values || {};
  const r = num(v.Resistance), sup = num(v.Support);
  return { resistance: Number.isFinite(r) ? r : null, support: Number.isFinite(sup) ? sup : null };
}

function readVWAP(studies) {
  const s = findStudy(studies, /volume weighted average price/i);
  if (!s) return null;
  const v = s.values || {};
  const vwap = num(v.VWAP);
  return Number.isFinite(vwap) ? vwap : null;
}

function readRSI(studies) {
  const s = findStudy(studies, /relative strength index/i);
  if (!s) return null;
  const v = s.values || {};
  const rsi = num(v.RSI);
  return Number.isFinite(rsi) ? rsi : null;
}

// ── session windows (IST, from scan_logic.session_profiles) ────────
function sessionCheck(symbol, profiles) {
  const nowUtc = new Date();
  const ist = new Date(nowUtc.getTime() + 5.5 * 3600 * 1000);
  const dow = ist.getUTCDay(); // 0 Sun .. 6 Sat
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const hhmm = `${String(ist.getUTCHours()).padStart(2, '0')}:${String(ist.getUTCMinutes()).padStart(2, '0')} IST`;
  const isGold = /GOLD/i.test(symbol);
  const p = isGold ? (profiles?.MCX_GOLD || {}) : (profiles?.NSE || {});
  const toMin = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '')); return m ? +m[1] * 60 + +m[2] : null; };
  const before = toMin(p.no_new_signals_before) ?? (isGold ? 555 : 570);
  const after = toMin(p.no_new_signals_after) ?? (isGold ? 1380 : 900);
  if (dow === 0) return { ok: false, why: `market closed (Sunday) - ${hhmm}` };
  if (!isGold && dow === 6) return { ok: false, why: `NSE closed (Saturday) - ${hhmm}` };
  if (mins < before || mins > after) {
    return { ok: false, why: `outside ${isGold ? 'MCX GOLD' : 'NSE'} new-signal window (${hhmm})` };
  }
  return { ok: true, why: `within ${isGold ? 'MCX GOLD' : 'NSE'} window (${hhmm})`, hhmm };
}

// ── one symbol ────────────────────────────────────────────────────
async function scanSymbol(symbol, cfg, args) {
  const { trendTf, entryTf, minRR, profiles } = cfg;
  const scanTime = new Date(Date.now() + 5.5 * 3600 * 1000);
  const scan_time = `${String(scanTime.getUTCHours()).padStart(2, '0')}:${String(scanTime.getUTCMinutes()).padStart(2, '0')} IST`;
  const base = { symbol, tf_trend: trendTf, tf_entry: entryTf, scan_time };
  const wait = (reasons, extra = {}) => ({ ...base, side: 'WAIT', reasons: [].concat(reasons), ...extra });

  // ---- 5m : MAIN trend / bias (Gate 1) ----
  await chart.setSymbol({ symbol });
  await chart.setTimeframe({ timeframe: trendTf });
  await sleep(args.settle);

  const bars5m = await readBars(40);
  if (bars5m.length < 40) return wait(`insufficient 5m history (${bars5m.length} bars)`);
  const studies5m = (await data.getStudyValues())?.studies || [];
  const sr5m = readSR(studies5m);

  const st5m = supertrend(bars5m, 10, 3);
  const iMain = bars5m.length - 2; // last CLOSED 5m bar - never the forming bar
  if (iMain < 1) return wait(`insufficient 5m history (${bars5m.length} bars)`);
  const dir5m = st5m.dir[iMain];
  const dirPrev5m = st5m.dir[iMain - 1];
  const line5m = st5m.line[iMain];
  const bar5mTime = bars5m[iMain].time;
  const price5m = bars5m[iMain].close;
  if (dir5m == null || line5m == null) return wait('5m Supertrend not computable yet', { bar_time: bar5mTime });

  const chartSt5m = readSupertrendChart(studies5m);
  if (chartSt5m && chartSt5m.dir !== dir5m) {
    return wait(
      `5m Supertrend disagreement: computed ${dir5m === 1 ? 'BULL' : 'BEAR'} vs chart ${chartSt5m.dir === 1 ? 'BULL' : 'BEAR'} - standing aside`,
      { bar_time: bar5mTime },
    );
  }
  if (dir5m !== dirPrev5m) {
    return wait(`5m Supertrend flipped on the last closed bar - waiting one bar to confirm`, { bar_time: bar5mTime, trend_5m: dir5m === 1 ? 'BULL' : 'BEAR' });
  }

  const trend5m = dir5m === 1 ? 'BULL' : 'BEAR';
  const side = dir5m === 1 ? 'BUY' : 'SELL';
  base.trend_5m = trend5m;

  // ---- Gate 2c: RSI(14) 5m momentum confirmation ----
  const rsi5m = readRSI(studies5m);
  if (rsi5m == null) {
    return wait([`5m trend ${trend5m}`, `RSI(14) 5m unavailable - cannot confirm momentum, standing aside`], { bar_time: bar5mTime, trend_5m: trend5m });
  }
  if (side === 'BUY' && rsi5m >= 70) {
    return wait([`5m trend ${trend5m}`, `RSI(14) 5m ${rsi5m.toFixed(2)} is overbought (>=70) - momentum exhausted, no BUY`], { bar_time: bar5mTime, trend_5m: trend5m });
  }
  if (side === 'SELL' && rsi5m <= 30) {
    return wait([`5m trend ${trend5m}`, `RSI(14) 5m ${rsi5m.toFixed(2)} is oversold (<=30) - momentum exhausted, no SELL`], { bar_time: bar5mTime, trend_5m: trend5m });
  }

  // ---- session ----
  const sess = sessionCheck(symbol, profiles);
  if (!sess.ok) return wait([`5m trend ${trend5m}`, `Session - ${sess.why}`], { bar_time: bar5mTime });

  // ---- 3m : CONFIRMATION / trigger (Gate 2) ----
  await chart.setTimeframe({ timeframe: entryTf });
  await sleep(args.settle);
  const bars3m = await readBars(40);
  if (bars3m.length < 40) return wait(`insufficient 3m history (${bars3m.length} bars)`, { bar_time: bar5mTime });
  const studies3m = (await data.getStudyValues())?.studies || [];
  const sr3m = readSR(studies3m) || sr5m;

  const st3m = supertrend(bars3m, 10, 3);
  const j3 = bars3m.length - 2; // last CLOSED 3m bar - never the forming bar
  if (j3 < 1) return wait(`insufficient 3m history (${bars3m.length} bars)`, { bar_time: bar5mTime });
  const dir3m = st3m.dir[j3];
  const line3m = st3m.line[j3];
  const bar3m = bars3m[j3];
  const bar_time = bar3m.time;
  if (dir3m == null || line3m == null) return wait('3m Supertrend not computable yet', { bar_time });

  // The 3m stage can only confirm the 5m bias; it never sets or flips `side`.
  const aligned = (trend5m === 'BULL' && dir3m === 1) || (trend5m === 'BEAR' && dir3m === -1);
  if (!aligned) {
    return wait([`5m trend ${trend5m}`, `3m confirm - 3m Supertrend not aligned with the 5m trend (watch, not a trade)`], { bar_time });
  }
  const closedOnSide = trend5m === 'BULL' ? bar3m.close > line3m : bar3m.close < line3m;
  if (!closedOnSide) {
    return wait([`5m trend ${trend5m}`, `3m confirm - last closed 3m candle has not closed on the trend side of the 3m Supertrend line (watch, not a trade)`], { bar_time });
  }

  // ---- Gate 2b: session VWAP directional confirmation ----
  const vwap = readVWAP(studies3m) ?? readVWAP(studies5m);
  if (vwap == null) {
    return wait([`5m trend ${trend5m}`, `3m confirm OK`, `VWAP unavailable - cannot confirm direction, standing aside`], { bar_time });
  }
  if (side === 'BUY' && bar3m.close <= vwap) {
    return wait([`5m trend ${trend5m}`, `3m confirm OK`, `VWAP conflict - price ${f2(bar3m.close)} is not above session VWAP ${f2(vwap)}, no BUY`], { bar_time });
  }
  if (side === 'SELL' && bar3m.close >= vwap) {
    return wait([`5m trend ${trend5m}`, `3m confirm OK`, `VWAP conflict - price ${f2(bar3m.close)} is not below session VWAP ${f2(vwap)}, no SELL`], { bar_time });
  }

  // ---- Gate 3: risk (3m data, closed bars only) ----
  const atr3arr = wilderATR(bars3m, 14);
  const atr3 = atr3arr[j3]; // ATR at the last closed 3m bar
  if (!Number.isFinite(atr3) || atr3 <= 0) return wait([`5m trend ${trend5m}`, `3m confirm OK`, `Risk - 3m ATR(14) not available`], { bar_time });

  const entry = bar3m.close;
  const win = bars3m.slice(0, -1).slice(-args.lookback); // closed 3m bars only
  let stop;
  if (side === 'BUY') {
    const swingLow = Math.min(...win.map((b) => b.low));
    const raw = swingLow - 0.1 * atr3;
    const dist = entry - raw;
    stop = dist < 0.8 * atr3 || dist > 2.5 * atr3 ? entry - 1.5 * atr3 : raw;
  } else {
    const swingHigh = Math.max(...win.map((b) => b.high));
    const raw = swingHigh + 0.1 * atr3;
    const dist = raw - entry;
    stop = dist < 0.8 * atr3 || dist > 2.5 * atr3 ? entry + 1.5 * atr3 : raw;
  }
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return wait([`5m trend ${trend5m}`, `3m confirm OK`, `Risk - could not derive a valid stop`], { bar_time });

  // target = nearest S&R level in the trade direction
  let target = null;
  if (side === 'BUY') target = sr3m?.resistance != null && sr3m.resistance > entry ? sr3m.resistance : null;
  else target = sr3m?.support != null && sr3m.support < entry ? sr3m.support : null;

  if (target == null) {
    const lvl = side === 'BUY' ? sr3m?.resistance : sr3m?.support;
    return wait(
      [`5m trend ${trend5m}`, `3m confirm OK`, `Risk - no structural ${side === 'BUY' ? 'resistance above' : 'support below'} entry ${f2(entry)} (nearest S&R level ${lvl != null ? f2(lvl) : 'n/a'} is on the wrong side); do not invent a target`],
      { bar_time },
    );
  }

  const reward = Math.abs(target - entry);
  const rr = reward / risk;
  if (rr < minRR) {
    return wait(
      [`5m trend ${trend5m}`, `3m confirm OK`, `Risk - nearest structural target ${f2(target)} gives R/R 1:${rr.toFixed(2)}, below the ${minRR}:1 minimum`],
      { bar_time },
    );
  }

  const extended = Math.abs(entry - line3m) > 1.5 * atr3;
  return {
    ...base,
    side,
    entry: Number(entry.toFixed(4)),
    stop: Number(stop.toFixed(4)),
    target: Number(target.toFixed(4)),
    rr: Number(rr.toFixed(2)),
    rr_text: `1:${rr.toFixed(1)}`,
    bar_time,
    reasons: [
      `5m trend ${trend5m} - price ${f2(price5m)} ${trend5m === 'BULL' ? 'above' : 'below'} the 5m Supertrend line ${f2(line5m)} on the last closed bar; no fresh flip`,
      `RSI(14) 5m ${rsi5m.toFixed(2)} confirms momentum (not ${side === 'BUY' ? 'overbought' : 'oversold'})`,
      `3m confirm - 3m Supertrend aligned ${trend5m === 'BULL' ? 'bullish' : 'bearish'}; last closed 3m candle closed ${trend5m === 'BULL' ? 'above' : 'below'} the 3m Supertrend line ${f2(line3m)}${extended ? ' (note: extended from the line - not a pullback entry)' : ''}`,
      `VWAP confirms - price ${f2(bar3m.close)} is ${side === 'BUY' ? 'above' : 'below'} session VWAP ${f2(vwap)}`,
      `Risk - stop ${f2(stop)} (${side === 'BUY' ? 'swing low' : 'swing high'} +/- 0.1*ATR, ATR14 ${f2(atr3)}), target ${f2(target)} (nearest S&R ${side === 'BUY' ? 'resistance' : 'support'}), risk ${f2(risk)}, R/R 1:${rr.toFixed(2)}`,
      `Session - ${sess.why}`,
    ],
  };
}

// ── main ──────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  let rules;
  try { rules = JSON.parse(readFileSync(RULES_PATH, 'utf8')); }
  catch (e) { console.error(`scan-run: cannot read ${RULES_PATH} - ${e.message}`); process.exit(2); }

  const sl = rules.scan_logic || {};
  const universe = args.symbols || sl.universe?.symbols || rules.watchlist || [];
  if (!universe.length) { console.error('scan-run: no symbols in rules.json (scan_logic.universe.symbols / watchlist)'); process.exit(2); }
  const cfg = {
    trendTf: String(sl.timeframes?.trend || '5'),
    entryTf: String(sl.timeframes?.entry || '3'),
    minRR: Number(sl.gate3_risk?.min_risk_reward ?? 2.0),
    profiles: sl.session_profiles || {},
  };

  console.error(`scan-run: ${universe.length} symbols | trend ${cfg.trendTf}m / entry ${cfg.entryTf}m | min R/R ${cfg.minRR}:1`);
  console.error(`scan-run: universe (${args.symbols ? 'from --symbols' : 'from rules.json'}):`);
  universe.forEach((s, i) => console.error(`  ${String(i + 1).padStart(2)}. ${s}`));

  let start = null;
  try {
    start = await chart.getState();
    const names = (start.studies || []).map((s) => s.name || '').join(' | ');
    if (!/supertrend/i.test(names)) console.error('scan-run: WARNING - "Supertrend" not found on the chart; every symbol will WAIT.');
    if (!/support and resistance levels with breaks/i.test(names)) console.error('scan-run: WARNING - "Support and Resistance Levels with Breaks" not on the chart; targets unavailable, every symbol will WAIT.');
    if (!/volume weighted average price/i.test(names)) console.error('scan-run: WARNING - "Volume Weighted Average Price" (Session VWAP) not on the chart; every symbol will WAIT.');
    if (!/relative strength index/i.test(names)) console.error('scan-run: WARNING - "Relative Strength Index" not on the chart; every symbol will WAIT.');
  } catch (e) {
    console.error(`scan-run: cannot reach TradingView via CDP - ${e.message}`);
    console.error('  Is TradingView Desktop running with --remote-debugging-port=9222?');
    process.exit(3);
  }

  // Hard wall-clock guard - whatever stalls, the process exits by the deadline
  // so the pipe closes and the notifier finishes.
  const deadlineAt = Date.now() + args.deadline * 1000;
  const killTimer = setTimeout(() => {
    console.error(`scan-run: hard deadline (${args.deadline}s) reached - exiting`);
    process.exit(0);
  }, args.deadline * 1000);
  killTimer.unref();

  const withTimeout = (p, ms, onTimeout) =>
    Promise.race([p, new Promise((res) => setTimeout(() => res(onTimeout()), ms))]);

  const tally = { BUY: 0, SELL: 0, WAIT: 0 };
  for (let i = 0; i < universe.length; i++) {
    const symbol = universe[i];
    if (Date.now() > deadlineAt) { console.error(`scan-run: deadline - skipping remaining ${universe.length - i} symbols`); break; }
    if (args.verbose) console.error(`  [${i + 1}/${universe.length}] ${symbol} ...`);
    let sig;
    let timedOut = false;
    try {
      sig = await withTimeout(
        scanSymbol(symbol, cfg, args),
        args.perSymbol * 1000,
        () => { timedOut = true; return { symbol, side: 'WAIT', reasons: [`per-symbol timeout after ${args.perSymbol}s - chart / CDP not responding`], scan_time: '' }; },
      );
    } catch (e) {
      sig = { symbol, side: 'WAIT', reasons: [`scan error: ${e.message}`], scan_time: '' };
    }
    if (timedOut) { await disconnect().catch(() => {}); await sleep(500); }
    tally[sig.side] = (tally[sig.side] || 0) + 1;
    emit(sig);
    if (args.verbose) console.error(`      -> ${sig.side}${sig.side !== 'WAIT' ? ` entry ${sig.entry} stop ${sig.stop} target ${sig.target} R/R ${sig.rr_text}` : ` (${(sig.reasons || []).slice(-1)[0] || ''})`}`);
  }
  clearTimeout(killTimer);

  if (args.restore && start?.symbol) {
    try {
      await chart.setSymbol({ symbol: start.symbol });
      if (start.resolution) await chart.setTimeframe({ timeframe: String(start.resolution) });
    } catch { /* best effort */ }
  }
  await disconnect().catch(() => {});
  console.error(`scan-run: done - ${tally.BUY} BUY, ${tally.SELL} SELL, ${tally.WAIT} WAIT`);
  process.exit(0);
}

main().catch((e) => { console.error(`scan-run: fatal - ${e && e.message ? e.message : e}`); process.exit(1); });
