#!/usr/bin/env node
// Scanner runner - applies rules.json `scan_logic` to every symbol in the
// universe and prints ONE JSON signal object per line to stdout.
//
//   node scripts/scan-run.js | node scripts/notify-telegram.js   (pipe form)
//   node scripts/scan-run.js --notify                            (per-signal form)
//
// Without --notify nothing is sent from here. This script never reads .env and
// never handles the bot token - the notifier does that on its own side.
//
// Reuses the project's own CDP layer (src/connection.js + src/core/*), so
// TradingView Desktop must be running with --remote-debugging-port=9222.
//
// ALL decision logic lives in ./scan-logic.js (pure, unit-tested). This file
// only does CDP orchestration: switch symbol/timeframe, pull OHLCV + the two
// chart studies it reads ("Supertrend" 5m cross-check, "Support and Resistance
// Levels with Breaks" for levels), then hand the bars to scan-logic's
// evaluate(). Supertrend, ATR, Wilder RSI(14) and session VWAP are all computed
// from the CLOSED OHLCV series, never read from chart studies, so no gate
// repaints on the still-forming bar.
//
// Architecture: 5m = BIAS, 3m = SETUP + STRUCTURAL CONFIRMATION, 1m = TRIGGER.
// Exactly 4 indicators, no fifth: Supertrend(10,close,3), Session VWAP, Wilder
// RSI(14) on 5m, and Support & Resistance Levels with Breaks.
//
//   Gate 1   5m BIAS    - Supertrend on the last closed 5m bar sets & FIXES the
//                         direction. Fresh flip / computed-vs-chart disagreement
//                         = WAIT (before any 3m or 1m load).
//   Gate 2c  RSI(14) 5m - block BUY >= 70, block SELL <= 30.
//   Session             - inside the symbol's IST new-signal window.
//   Gate 2   3m SETUP   - (a) 5m structure still intact on the 3m  <-- HARD 5m
//                         protection; the 1m stage can never override it.
//                         (b) price in a pullback zone vs the 3m Supertrend.
//   Gate 2s  3m STRUCTURE - a meaningful S/R level (break + retest preferred, 3m
//                         swing as fallback) was pulled into AND HELD, and the
//                         last CLOSED 3m candle confirms the bias direction with
//                         the 3m Supertrend aligned on that bar. The 3m
//                         Supertrend MAY be counter-trend earlier in the
//                         pullback. Until Gate 2 AND Gate 2s both pass, the 1m
//                         trigger stays DISARMED.
//   Gate 2b  VWAP       - session VWAP supportive of the trade direction (on the
//                         3m close and again on the 1m entry).
//   Gate 2t  1m TRIGGER - only armed after Gate 1 + 2 + 2s. Last closed 1m
//                         Supertrend aligned + candle closed on the trend side.
//                         Produces the entry price only; never sets/flips the
//                         side, never fires on its own.
//   Gate 3   RISK       - 3m-swing stop (0.1*ATR3 buffer, clamped to
//                         [0.8, 2.5]*ATR3 else 1.5*ATR3), target = nearest S&R
//                         level in the trade direction, require R/R >= 2.
//
// BUY/SELL only when every gate passes and agrees on one direction; else WAIT.
// The emitted bar_time is the last closed 3m SETUP bar, so notify-telegram /
// journal-log dedupe to <=1 alert per 3m window per side.
//
// Output line shape (consumed by notify-telegram.js):
//   {"symbol","side":"BUY|SELL|WAIT","entry","stop","target","rr","rr_text",
//    "bar_time","reasons":[...],"scan_time","trend_5m","tf_trend","tf_setup","tf_entry"}
//
// Flags: --symbols a,b,c  (override universe)   --settle <ms>  (default 1800)
//        --lookback <n> (3m swing window, default 10)   --no-restore
//        --pullback-atr <P> (3m pullback-zone width in ATR3, default 1.5)
//        --per-symbol <sec> (hang guard per symbol, default 35)
//        --deadline <sec>   (hard wall-clock exit, default 420)
//        --notify           send each BUY/SELL to Telegram the moment it is
//                           evaluated, by shelling out to notify-telegram.js
//                           --signal per signal. Off by default (stdout only),
//                           so a plain run and manual smoke tests send nothing.
//                           This makes delivery independent of the pipe reader
//                           surviving to end-of-run: a later per-symbol timeout
//                           or a Task Scheduler taskkill can no longer drop an
//                           already-evaluated BUY/SELL.
//        --verbose        --help

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { chart, data } from '../src/core/index.js';
import { disconnect } from '../src/connection.js';
import { evaluate } from './scan-logic.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const RULES_PATH = resolve(PROJECT_ROOT, 'rules.json');

const HELP = `scan-run.js - apply rules.json scan_logic and print JSON signal lines to stdout

  node scripts/scan-run.js                       scan the full universe
  node scripts/scan-run.js --symbols NSE:NIFTY,MCX:GOLD1!
  node scripts/scan-run.js | node scripts/notify-telegram.js     (the integration)

  --settle <ms>       wait after each symbol/timeframe switch (default 1800)
  --lookback <n>      bars for the 3m swing stop (default 10)
  --pullback-atr <P>  3m pullback-zone width in ATR3 (default 1.5)
  --no-restore        leave the chart on the last scanned symbol
  --notify            send each BUY/SELL to Telegram as it is evaluated
                      (notify-telegram.js --signal); off by default
  --verbose           progress + per-gate detail on stderr
  --help

5m = bias, 3m = setup + structural confirmation, 1m = entry trigger. Only stdout
carries JSON; all logs go to stderr. Without --notify nothing is sent - pipe to
notify-telegram.js. With --notify each BUY/SELL is delivered per-signal, so a
later timeout / taskkill cannot drop an already-evaluated alert.`;

// ── args ────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { symbols: null, settle: 1800, lookback: 10, pullbackAtr: null, perSymbol: 35, deadline: 420, restore: true, notify: false, verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--help' || x === '-h') a.help = true;
    else if (x === '--verbose' || x === '-v') a.verbose = true;
    else if (x === '--no-restore') a.restore = false;
    else if (x === '--notify') a.notify = true;
    else if (x === '--symbols') a.symbols = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (x === '--settle') a.settle = Math.max(0, Number(argv[++i]) || 0);
    else if (x === '--lookback') a.lookback = Math.max(2, Number(argv[++i]) || 10);
    else if (x === '--pullback-atr') a.pullbackAtr = Math.max(0.1, Number(argv[++i]) || 1.5);
    else if (x === '--per-symbol') a.perSymbol = Math.max(10, Number(argv[++i]) || 35);
    else if (x === '--deadline') a.deadline = Math.max(60, Number(argv[++i]) || 420);
    else { console.error(`scan-run: unknown argument "${x}" (try --help)`); process.exit(2); }
  }
  return a;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

// Deliver one BUY/SELL immediately by shelling out to the standalone notifier
// (which reads .env, dedupes on symbol+side+bar_time, and redacts the token on
// its own side). Synchronous and best-effort: the Telegram round-trip finishes
// before the next symbol is scanned, so a per-symbol timeout or a Task Scheduler
// taskkill later in the run cannot lose a signal that was already evaluated.
// A send failure is logged to stderr and never aborts the scan.
const NOTIFIER = resolve(SCRIPT_DIR, 'notify-telegram.js');
function notifyOne(sig) {
  if (sig.side !== 'BUY' && sig.side !== 'SELL') return;
  try {
    execFileSync(process.execPath, [NOTIFIER, '--signal', JSON.stringify(sig)], {
      stdio: ['ignore', 'ignore', 'inherit'],
      timeout: 20000,
    });
  } catch (e) {
    console.error(`scan-run: notify failed for ${sig.symbol} ${sig.side} - ${e && e.message ? e.message : e}`);
  }
}

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

// ── one symbol ────────────────────────────────────────────────────
// CDP orchestration only. evaluate() (scan-logic.js) drives the gate pipeline
// and pulls each timeframe lazily through `load`, so the 3m / 1m series are
// fetched only when the pipeline actually reaches them - a Gate 1 WAIT still
// costs a single chart switch.
async function scanSymbol(symbol, cfg, args) {
  const scanTime = new Date(Date.now() + 5.5 * 3600 * 1000);
  const scan_time = `${String(scanTime.getUTCHours()).padStart(2, '0')}:${String(scanTime.getUTCMinutes()).padStart(2, '0')} IST`;
  const base = { symbol, tf_trend: cfg.biasTf, tf_setup: cfg.setupTf, tf_entry: cfg.entryTf, scan_time };

  await chart.setSymbol({ symbol });

  let lastTf = null;
  const load = async (tf) => {
    if (tf !== lastTf) {
      await chart.setTimeframe({ timeframe: tf });
      await sleep(args.settle);
      lastTf = tf;
    }
    const isBias = tf === cfg.biasTf;
    const bars = await readBars(isBias ? 40 : 50, isBias ? 250 : 500);
    // 1m needs no studies; 5m / 3m need Supertrend (cross-check) + S&R (levels).
    const studies = tf === cfg.entryTf ? [] : ((await data.getStudyValues())?.studies || []);
    return { bars, studies };
  };

  const sig = await evaluate({
    symbol,
    cfg,
    opts: { pullbackAtr: args.pullbackAtr, lookback: args.lookback, minRR: cfg.minRR },
    now: new Date(),
    load,
  });
  return { ...base, ...sig };
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
  // pullback-zone width: --pullback-atr flag wins, else rules.json pullback_atr_mult, else 1.5
  args.pullbackAtr = args.pullbackAtr != null ? args.pullbackAtr : Math.max(0.1, Number(sl.pullback_atr_mult) || 1.5);
  const cfg = {
    biasTf: String(sl.timeframes?.trend || '5'),
    setupTf: String(sl.timeframes?.setup || '3'),
    entryTf: String(sl.timeframes?.entry || '1'),
    minRR: Number(sl.gate3_risk?.min_risk_reward ?? 2.0),
    profiles: sl.session_profiles || {},
  };

  console.error(`scan-run: ${universe.length} symbols | bias ${cfg.biasTf}m / setup ${cfg.setupTf}m / trigger ${cfg.entryTf}m | pullback <= ${args.pullbackAtr}x ATR3 | min R/R ${cfg.minRR}:1 | notify ${args.notify ? 'ON (per-signal)' : 'off'}`);
  console.error(`scan-run: universe (${args.symbols ? 'from --symbols' : 'from rules.json'}):`);
  universe.forEach((s, i) => console.error(`  ${String(i + 1).padStart(2)}. ${s}`));

  let start = null;
  try {
    start = await chart.getState();
    const names = (start.studies || []).map((s) => s.name || '').join(' | ');
    if (!/supertrend/i.test(names)) console.error('scan-run: WARNING - "Supertrend" not found on the chart; every symbol will WAIT.');
    if (!/support and resistance levels with breaks/i.test(names)) console.error('scan-run: WARNING - "Support and Resistance Levels with Breaks" not on the chart; targets unavailable, every symbol will WAIT.');
    if (!/volume weighted average price/i.test(names)) console.error('scan-run: note - Session VWAP not on the chart; the scan computes its own from OHLCV, the chart copy is optional.');
    if (!/relative strength index/i.test(names)) console.error('scan-run: note - RSI not on the chart; the scan computes its own from OHLCV, the chart copy is optional.');
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
    if (args.notify) notifyOne(sig);
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
