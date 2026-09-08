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
// TradingView Desktop must be running with --remote-debugging-port=9222.
// Two chart studies are read directly: "Supertrend" (a 15m direction cross-check
// only) and "Support and Resistance Levels with Breaks" (target levels).
// Supertrend, ATR, Wilder RSI(14) and session VWAP are all computed here from
// the OHLCV series - not read from chart studies - so every gate can use the
// last CLOSED bar. Keeping the "Volume Weighted Average Price" and "Relative
// Strength Index" studies on the chart is optional (visual reference only).
//
// Architecture: 15m = BIAS, 5m = pullback / SETUP, 1m = entry TRIGGER.
// The 15m Supertrend fixes the direction; the 5m and 1m stages only confirm or
// withhold and can never trade against an invalidated 15m bias or broken
// structure. Every gate evaluates the last CLOSED candle on its timeframe
// (index length-2), never the still-forming bar, so a signal does not repaint.
//
// Gates (from rules.json > scan_logic, the 4-indicator confluence version):
//   Gate 1   15m bias    - Supertrend(10, close, 3) on the last closed 15m bar:
//                          price above line = BULL, below = BEAR. Sets and FIXES
//                          the direction. A flip on the last closed 15m bar, or
//                          a computed-vs-chart direction disagreement, = WAIT
//                          (returns before 5m/1m load).
//   Gate 2   5m setup    - (a) STRUCTURE: last closed 5m close still on the bias
//                          side of the 15m Supertrend line, else the bias is
//                          being invalidated -> WAIT (before the 1m stage).
//                          (b) PULLBACK: |close5 - line5| <= P*ATR5 (P from
//                          rules.json pullback_atr_mult / --pullback-atr,
//                          default 1.5). The 5m Supertrend direction is NOT
//                          checked - an opposed 5m Supertrend is a valid
//                          pullback state. Fail -> WAIT (a "watch").
//   Gate 2t  1m trigger  - last closed 1m Supertrend aligned with the 15m bias
//                          AND the last closed 1m candle closes on the trend
//                          side of the 1m line. This produces the entry price.
//                          Fail -> WAIT (a "watch").
//   Gate 2b  VWAP        - session VWAP (hlc3, from the full CLOSED 5m session
//                          series): 1m entry above it for BUY, below for SELL;
//                          wrong side = conflict -> WAIT.
//   Gate 2c  RSI         - Wilder RSI(14) from CLOSED 15m OHLCV bars; blocks BUY
//                          if >= 70 (overbought), blocks SELL if <= 30
//                          (oversold) -> WAIT.
//   Gate 3   risk        - entry = last closed 1m close; ATR(14) and swing on
//                          5m; stop = recent closed-5m swing (±0.1*ATR5),
//                          clamped to [0.8, 2.5]*ATR5 else 1.5*ATR5; target =
//                          nearest S&R level in trade direction; require final
//                          R/R >= min_risk_reward (2.0). No valid target /
//                          R/R < min -> WAIT.
//   Session             - respects scan_logic.session_profiles (NSE / MCX GOLD)
//                          new-signal windows in IST; weekends -> WAIT.
//
// BUY/SELL requires genuine confluence across all gates; any conflict -> WAIT.
// The emitted bar_time is the last closed 5m SETUP bar (not the 1m trigger),
// so notify-telegram / journal-log dedupe to <=1 alert per 5m window per side.
//
// Output line shape (consumed by notify-telegram.js):
//   {"symbol","side":"BUY|SELL|WAIT","entry","stop","target","rr","rr_text",
//    "bar_time","reasons":[...],"scan_time","trend_15m","tf_trend","tf_setup","tf_entry"}
//
// Flags: --symbols a,b,c  (override universe)   --settle <ms>  (default 1800)
//        --lookback <n> (5m swing window, default 10)   --no-restore
//        --pullback-atr <P> (5m pullback-zone width in ATR5, default 1.5)
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

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const RULES_PATH = resolve(PROJECT_ROOT, 'rules.json');

const HELP = `scan-run.js - apply rules.json scan_logic and print JSON signal lines to stdout

  node scripts/scan-run.js                       scan the full universe
  node scripts/scan-run.js --symbols NSE:NIFTY,MCX:GOLD1!
  node scripts/scan-run.js | node scripts/notify-telegram.js     (the integration)

  --settle <ms>       wait after each symbol/timeframe switch (default 1800)
  --lookback <n>      bars for the 5m swing stop (default 10)
  --pullback-atr <P>  5m pullback-zone width in ATR5 (default 1.5)
  --no-restore        leave the chart on the last scanned symbol
  --notify            send each BUY/SELL to Telegram as it is evaluated
                      (notify-telegram.js --signal); off by default
  --verbose           progress + per-gate detail on stderr
  --help

15m = bias, 5m = pullback / setup, 1m = entry trigger. Only stdout carries JSON;
all logs go to stderr. Without --notify nothing is sent - pipe to
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

// Wilder RSI over closes - matches TradingView ta.rsi(close, period). Returns an
// array aligned to `bars` (null during the warmup). Read it at the last CLOSED
// bar index so Gate 2c does not repaint on the still-forming bar.
function wilderRSI(bars, period = 14) {
  const n = bars.length;
  const rsi = new Array(n).fill(null);
  if (n < period + 1) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < n; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

// Calendar-date key in IST for a unix-seconds bar time - the session anchor
// (NSE 09:15-15:30 and MCX GOLD 09:00-23:30 each fall on one IST date).
function istDateKey(unixSec) {
  const d = new Date(unixSec * 1000 + 5.5 * 3600 * 1000);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

// Session VWAP through bars[lastIdx] inclusive: hlc3 weighted by volume over
// every bar sharing lastIdx's IST session date. Matches the chart's "Volume
// Weighted Average Price" (hlc3 source, Session anchor) but is computed from
// CLOSED OHLCV bars, so Gate 2b does not repaint. Falls back to an unweighted
// hlc3 mean when the symbol carries no volume (e.g. a cash index).
function sessionVWAP(bars, lastIdx) {
  const dayKey = istDateKey(bars[lastIdx].time);
  let pv = 0, vol = 0, tpSum = 0, count = 0;
  for (let i = lastIdx; i >= 0; i--) {
    if (istDateKey(bars[i].time) !== dayKey) break;
    const b = bars[i];
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 0;
    pv += tp * v; vol += v; tpSum += tp; count += 1;
  }
  if (vol > 0) return pv / vol;
  return count > 0 ? tpSum / count : null;
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
  const { biasTf, setupTf, entryTf, minRR, profiles } = cfg;
  const P = args.pullbackAtr;
  const scanTime = new Date(Date.now() + 5.5 * 3600 * 1000);
  const scan_time = `${String(scanTime.getUTCHours()).padStart(2, '0')}:${String(scanTime.getUTCMinutes()).padStart(2, '0')} IST`;
  const base = { symbol, tf_trend: biasTf, tf_setup: setupTf, tf_entry: entryTf, scan_time };
  const wait = (reasons, extra = {}) => ({ ...base, side: 'WAIT', reasons: [].concat(reasons), ...extra });

  // ---- 15m : BIAS (Gate 1) - sets and FIXES the direction ----
  await chart.setSymbol({ symbol });
  await chart.setTimeframe({ timeframe: biasTf });
  await sleep(args.settle);

  const bars15 = await readBars(40);
  if (bars15.length < 40) return wait(`insufficient 15m history (${bars15.length} bars)`);
  const studies15 = (await data.getStudyValues())?.studies || [];
  const sr15 = readSR(studies15);

  const st15 = supertrend(bars15, 10, 3);
  const iBias = bars15.length - 2; // last CLOSED 15m bar - never the forming bar
  if (iBias < 1) return wait(`insufficient 15m history (${bars15.length} bars)`);
  const dir15 = st15.dir[iBias];
  const dirPrev15 = st15.dir[iBias - 1];
  const line15 = st15.line[iBias];
  const bar15Time = bars15[iBias].time;
  const price15 = bars15[iBias].close;
  if (dir15 == null || line15 == null) return wait('15m Supertrend not computable yet', { bar_time: bar15Time });

  const chartSt15 = readSupertrendChart(studies15);
  if (chartSt15 && chartSt15.dir !== dir15) {
    return wait(
      `15m Supertrend disagreement: computed ${dir15 === 1 ? 'BULL' : 'BEAR'} vs chart ${chartSt15.dir === 1 ? 'BULL' : 'BEAR'} - standing aside`,
      { bar_time: bar15Time },
    );
  }
  if (dir15 !== dirPrev15) {
    return wait(`15m Supertrend flipped on the last closed bar - waiting one bar to confirm`, { bar_time: bar15Time, trend_15m: dir15 === 1 ? 'BULL' : 'BEAR' });
  }

  const bias = dir15 === 1 ? 'BULL' : 'BEAR';
  const side = dir15 === 1 ? 'BUY' : 'SELL';
  base.trend_15m = bias;

  // ---- Gate 2c: RSI(14) 15m momentum ----
  // Wilder RSI from the 15m OHLCV series at the last CLOSED bar - not the chart
  // study, which reports the still-forming bar and would repaint.
  const rsi15 = wilderRSI(bars15, 14)[iBias];
  if (rsi15 == null || !Number.isFinite(rsi15)) {
    return wait([`15m bias ${bias}`, `RSI(14) 15m unavailable - cannot confirm momentum, standing aside`], { bar_time: bar15Time });
  }
  if (side === 'BUY' && rsi15 >= 70) {
    return wait([`15m bias ${bias}`, `RSI(14) 15m ${rsi15.toFixed(2)} is overbought (>=70) - momentum exhausted, no BUY`], { bar_time: bar15Time });
  }
  if (side === 'SELL' && rsi15 <= 30) {
    return wait([`15m bias ${bias}`, `RSI(14) 15m ${rsi15.toFixed(2)} is oversold (<=30) - momentum exhausted, no SELL`], { bar_time: bar15Time });
  }

  // ---- session ----
  const sess = sessionCheck(symbol, profiles);
  if (!sess.ok) return wait([`15m bias ${bias}`, `Session - ${sess.why}`], { bar_time: bar15Time });

  // ---- 5m : pullback / SETUP (Gate 2) ----
  // The 5m Supertrend DIRECTION is not checked - an opposed 5m Supertrend near
  // its line is a valid pullback state. Two checks: (a) the 15m bias must still
  // be structurally intact on the 5m, and (b) price must be in a pullback zone.
  await chart.setTimeframe({ timeframe: setupTf });
  await sleep(args.settle);
  const bars5 = await readBars(50, 500);
  if (bars5.length < 50) return wait([`15m bias ${bias}`, `insufficient 5m history (${bars5.length} bars)`], { bar_time: bar15Time });
  const studies5 = (await data.getStudyValues())?.studies || [];
  const sr = sr15 || readSR(studies5);

  const st5 = supertrend(bars5, 10, 3);
  const iSetup = bars5.length - 2; // last CLOSED 5m bar
  if (iSetup < 1) return wait([`15m bias ${bias}`, `insufficient 5m history (${bars5.length} bars)`], { bar_time: bar15Time });
  const dir5 = st5.dir[iSetup];
  const line5 = st5.line[iSetup];
  const bar5 = bars5[iSetup];
  const bar_time = bar5.time; // dedupe anchor: the 5m SETUP bar, for every line below
  if (dir5 == null || line5 == null) return wait([`15m bias ${bias}`, `5m Supertrend not computable yet`], { bar_time });

  const atr5arr = wilderATR(bars5, 14);
  const atr5 = atr5arr[iSetup];
  if (!Number.isFinite(atr5) || atr5 <= 0) return wait([`15m bias ${bias}`, `5m setup - ATR(14) 5m not available`], { bar_time });

  // (a) STRUCTURE: last closed 5m price must still be on the bias side of the
  // 15m Supertrend line. If it has crossed against the bias, the 15m bias is
  // being invalidated - stand aside BEFORE the 1m stage loads.
  const structureIntact = bias === 'BULL' ? bar5.close > line15 : bar5.close < line15;
  if (!structureIntact) {
    return wait(
      [`15m bias ${bias}`, `5m setup - 15m bias structurally broken: last closed 5m ${f2(bar5.close)} has crossed the 15m Supertrend line ${f2(line15)} against the bias; standing aside`],
      { bar_time },
    );
  }

  // (b) PULLBACK: last closed 5m price within P*ATR5 of the 5m Supertrend line.
  const distToLine5 = Math.abs(bar5.close - line5);
  const st5Aligned = (bias === 'BULL' && dir5 === 1) || (bias === 'BEAR' && dir5 === -1);
  if (distToLine5 > P * atr5) {
    return wait(
      [`15m bias ${bias}`, `5m setup - not in a pullback zone: price ${f2(bar5.close)} is ${(distToLine5 / atr5).toFixed(2)}x ATR5 from the 5m Supertrend line ${f2(line5)} (need <= ${P}x); ${st5Aligned ? 'trend extended' : 'pullback too deep'}, watch`],
      { bar_time },
    );
  }

  // ---- Gate 2b: session VWAP from the FULL closed 5m session series ----
  const vwap = sessionVWAP(bars5, iSetup);
  if (vwap == null || !Number.isFinite(vwap)) {
    return wait([`15m bias ${bias}`, `5m setup OK`, `VWAP unavailable - cannot confirm direction, standing aside`], { bar_time });
  }

  // ---- 1m : entry TRIGGER (Gate 2t) - produces the entry price ----
  await chart.setTimeframe({ timeframe: entryTf });
  await sleep(args.settle);
  const bars1 = await readBars(50, 500);
  if (bars1.length < 50) return wait([`15m bias ${bias}`, `5m setup OK`, `insufficient 1m history (${bars1.length} bars)`], { bar_time });

  const st1 = supertrend(bars1, 10, 3);
  const jTrig = bars1.length - 2; // last CLOSED 1m bar
  if (jTrig < 1) return wait([`15m bias ${bias}`, `5m setup OK`, `insufficient 1m history (${bars1.length} bars)`], { bar_time });
  const dir1 = st1.dir[jTrig];
  const line1 = st1.line[jTrig];
  const bar1 = bars1[jTrig];
  if (dir1 == null || line1 == null) return wait([`15m bias ${bias}`, `5m setup OK`, `1m Supertrend not computable yet`], { bar_time });

  // The 1m stage can only trigger IN the 15m bias direction; it never sets or
  // flips `side`, and it is only reached once the 15m bias and 5m structure are
  // both intact.
  const trigAligned = (bias === 'BULL' && dir1 === 1) || (bias === 'BEAR' && dir1 === -1);
  if (!trigAligned) {
    return wait([`15m bias ${bias}`, `5m setup OK`, `1m trigger - 1m Supertrend not yet aligned with the 15m bias (watch, not a trade)`], { bar_time });
  }
  const trigClosedOnSide = bias === 'BULL' ? bar1.close > line1 : bar1.close < line1;
  if (!trigClosedOnSide) {
    return wait([`15m bias ${bias}`, `5m setup OK`, `1m trigger - last closed 1m candle has not closed on the trend side of the 1m Supertrend line (watch, not a trade)`], { bar_time });
  }

  const entry = bar1.close;

  // ---- Gate 2b: VWAP directional check on the 1m entry price ----
  if (side === 'BUY' && entry <= vwap) {
    return wait([`15m bias ${bias}`, `5m setup OK`, `1m trigger OK`, `VWAP conflict - entry ${f2(entry)} is not above session VWAP ${f2(vwap)}, no BUY`], { bar_time });
  }
  if (side === 'SELL' && entry >= vwap) {
    return wait([`15m bias ${bias}`, `5m setup OK`, `1m trigger OK`, `VWAP conflict - entry ${f2(entry)} is not below session VWAP ${f2(vwap)}, no SELL`], { bar_time });
  }

  // ---- Gate 3: risk - 5m ATR + 5m swing, entered at the 1m close ----
  const win = bars5.slice(0, -1).slice(-args.lookback); // closed 5m bars only
  let stop;
  if (side === 'BUY') {
    const swingLow = Math.min(...win.map((b) => b.low));
    const raw = swingLow - 0.1 * atr5;
    const dist = entry - raw;
    stop = dist < 0.8 * atr5 || dist > 2.5 * atr5 ? entry - 1.5 * atr5 : raw;
  } else {
    const swingHigh = Math.max(...win.map((b) => b.high));
    const raw = swingHigh + 0.1 * atr5;
    const dist = raw - entry;
    stop = dist < 0.8 * atr5 || dist > 2.5 * atr5 ? entry + 1.5 * atr5 : raw;
  }
  const risk = Math.abs(entry - stop);
  if (!Number.isFinite(risk) || risk <= 0) return wait([`15m bias ${bias}`, `5m setup OK`, `1m trigger OK`, `Risk - could not derive a valid stop`], { bar_time });

  // target = nearest S&R level in the trade direction
  let target = null;
  if (side === 'BUY') target = sr?.resistance != null && sr.resistance > entry ? sr.resistance : null;
  else target = sr?.support != null && sr.support < entry ? sr.support : null;

  if (target == null) {
    const lvl = side === 'BUY' ? sr?.resistance : sr?.support;
    return wait(
      [`15m bias ${bias}`, `5m setup OK`, `1m trigger OK`, `Risk - no structural ${side === 'BUY' ? 'resistance above' : 'support below'} entry ${f2(entry)} (nearest S&R level ${lvl != null ? f2(lvl) : 'n/a'} is on the wrong side); do not invent a target`],
      { bar_time },
    );
  }

  const reward = Math.abs(target - entry);
  const rr = reward / risk;
  if (rr < minRR) {
    return wait(
      [`15m bias ${bias}`, `5m setup OK`, `1m trigger OK`, `Risk - nearest structural target ${f2(target)} gives R/R 1:${rr.toFixed(2)}, below the ${minRR}:1 minimum`],
      { bar_time },
    );
  }

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
      `15m bias ${bias} - price ${f2(price15)} ${bias === 'BULL' ? 'above' : 'below'} the 15m Supertrend line ${f2(line15)} on the last closed bar; no fresh flip`,
      `RSI(14) 15m ${rsi15.toFixed(2)} confirms momentum (not ${side === 'BUY' ? 'overbought' : 'oversold'})`,
      `5m setup - 15m structure intact; last closed 5m ${f2(bar5.close)} is ${(distToLine5 / atr5).toFixed(2)}x ATR5 from the 5m Supertrend line ${f2(line5)} (${st5Aligned ? 'aligned pullback' : 'counter-trend pullback'}, within ${P}x ATR5)`,
      `1m trigger - 1m Supertrend aligned ${bias === 'BULL' ? 'bullish' : 'bearish'}; last closed 1m candle closed ${bias === 'BULL' ? 'above' : 'below'} the 1m Supertrend line ${f2(line1)}`,
      `VWAP confirms - entry ${f2(entry)} is ${side === 'BUY' ? 'above' : 'below'} session VWAP ${f2(vwap)}`,
      `Risk - stop ${f2(stop)} (${side === 'BUY' ? 'swing low' : 'swing high'} +/- 0.1*ATR5, ATR14(5m) ${f2(atr5)}), target ${f2(target)} (nearest S&R ${side === 'BUY' ? 'resistance' : 'support'}), risk ${f2(risk)}, R/R 1:${rr.toFixed(2)}`,
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
  // pullback-zone width: --pullback-atr flag wins, else rules.json pullback_atr_mult, else 1.5
  args.pullbackAtr = args.pullbackAtr != null ? args.pullbackAtr : Math.max(0.1, Number(sl.pullback_atr_mult) || 1.5);
  const cfg = {
    biasTf: String(sl.timeframes?.trend || '15'),
    setupTf: String(sl.timeframes?.setup || '5'),
    entryTf: String(sl.timeframes?.entry || '1'),
    minRR: Number(sl.gate3_risk?.min_risk_reward ?? 2.0),
    profiles: sl.session_profiles || {},
  };

  console.error(`scan-run: ${universe.length} symbols | bias ${cfg.biasTf}m / setup ${cfg.setupTf}m / trigger ${cfg.entryTf}m | pullback <= ${args.pullbackAtr}x ATR5 | min R/R ${cfg.minRR}:1 | notify ${args.notify ? 'ON (per-signal)' : 'off'}`);
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
