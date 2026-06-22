/**
 * TASI Strategy Dashboard — HTTP Server
 * Usage: node dashboard/server.mjs
 */

// .env is loaded via `node -r dotenv/config` in the npm script (preloads before
// ESM eval, so env vars are present when imported modules initialize).

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import CDP from "chrome-remote-interface";
import { getRules, updateRules } from "../src/rules-engine.js";
import { scoreHistory as dbScoreHistory, positions as dbPositions, alertRules as dbAlertRules, virtualPortfolio as dbVirtual, insiderBuys as dbInsiderBuys, blockDeals as dbBlockDeals, cmaFilings as dbCMA, oppSignals as dbOppSignals, dbTracked, dbMilestones, goalsProfile, allocationPolicy, accuracyLab, realFills, decisionSnapshots } from "./db.js";
import { summarize as summarizeFills } from "./fills.mjs";
import { compareToSnapshot, buildSnapshot } from "./tracking.mjs";
import { computeRebalance, SLEEVES, normalizeWeights } from "./allocation.mjs";
import * as dataCore from "../src/core/data.js";
import { runBacktest, sweepParams, simulatePortfolio, prepareIndicators, simulateTrades } from "./backtest.mjs";
import { runScreener, getUniverseByMarket, TASI_STOCKS, US_EQUITY_STOCKS, ETF_STOCKS, CRYPTO_STOCKS, COMMODITY_STOCKS, INDEX_FOR_MARKET, emaArray, calcRsi, atrCalc, rsiSeries, macdHist, volumeCheck, scoreBias, findSRLevels, detectDivergence, computeSeasonality, toYahooSym, fetchYahooOHLCV } from "../scripts/tasi_screener.mjs";
import { getFundamentals, scoreFundamentals } from "./fundamentals.mjs";
import { getShariaStatus, getAllStatuses } from "./sharia.mjs";
import * as chartCore from "../src/core/chart.js";
import { create as createAlert } from "../src/core/alerts.js";
import { signJWT, verifyJWT, hashPassword, verifyPassword, users as authUsers, generateId } from "./auth.mjs";
import { backfillFromTables, gradePending, getValidationStats, HORIZONS as VAL_HORIZONS } from "./validation.mjs";
import { getCalibration, calibrateSignal } from "./calibration.mjs";
import { getMomentumScreen, sarPerName } from "./momentum_screen.mjs";
import { getPeadScreen } from "./pead_screen.mjs";
import { getBlockDealSignal } from "./blockdeal_signal.mjs";
import { getStrategyValidation, bustCache as bustStrategyCache } from "./strategy_validation.mjs";
import { getActiveRiskFlags, getRiskFlags } from "./catalysts.mjs";
import { json, html, readBody } from "./http_util.mjs";
import { state } from "./state.mjs";
import { sendTelegram } from "./notify.mjs";
import { getUpcomingEvents } from "./macro.mjs";
import { fetchGoogleNews, getEarningsCalendar, newsCache, NEWS_TTL } from "./news.mjs";
import { tickerDisplay, BEAR_BIASES, resolveSignalLabel, computeVelocity, sectorOf, computeDelta } from "./signal_format.mjs";

const __dirname      = dirname(fileURLToPath(import.meta.url));
const PORT           = process.env.PORT || 3000;
const SCAN_CACHE     = join(__dirname, "scan-cache.json");
const PREV_SCAN_CACHE= join(__dirname, "prev-scan-cache.json");
const RULES_PATH     = resolve(__dirname, "../rules.json");
const UNIVERSE_PATH   = join(__dirname, "universe.json");
const SETTINGS_PATH   = join(__dirname, "settings.json");
const POSITIONS_PATH  = join(__dirname, "positions.json");
const VIRTUAL_PATH       = join(__dirname, "virtual_portfolio.json");
const SCORE_HISTORY_PATH    = join(__dirname, "score_history.json");
const ALERT_RULES_PATH      = join(__dirname, "alert_rules.json");
const AUTO_SCAN_LOG_PATH    = join(__dirname, "auto_scan_log.json");
const LAST_BLOCK_DEALS_PATH = join(__dirname, "last_block_deals.json");
const BLOCK_DEAL_LOG_PATH = join(__dirname, "block_deal_log.json");
const INSIDER_BUYS_PATH = join(__dirname, 'insider_buys.json');
const SCREENSHOTS_DIR = join(__dirname, "screenshots");
mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// ── Auth ──────────────────────────────────────────────────────────────────────
const API_KEY = process.env.DASHBOARD_API_KEY || '';
if (!API_KEY) console.warn('[auth] DASHBOARD_API_KEY not set — dashboard is unprotected. Add it to .env to enable.');

// ── Market Regime ─────────────────────────────────────────────────────────────
async function getSymbolMetrics(meta) {
  // meta has { sym, label, flag, category, yahoo }
  const yahooSym = meta.yahoo || toYahooSym(meta.sym);
  const bars = await fetchYahooOHLCV(yahooSym, '1d', 260);
  if (!bars || bars.length < 20) return null;
  const closes = bars.map(b => b.close);
  const highs  = bars.map(b => b.high);
  const lows   = bars.map(b => b.low);
  const price  = closes[closes.length - 1];
  const prev   = closes[closes.length - 2];
  const change_pct = +((price - prev) / prev * 100).toFixed(2);
  const e13  = emaArray(closes, 13), e34 = emaArray(closes, 34);
  const e89  = emaArray(closes, 89), e200 = emaArray(closes, 200);
  const ema13 = e13[e13.length-1], ema34 = e34[e34.length-1];
  const ema89 = e89[e89.length-1], ema200 = e200[e200.length-1];
  const ema_stack = ema13 > ema34 && ema34 > ema89;
  const above_200 = ema200 ? price > ema200 : null;
  const rsiVals = rsiSeries(closes, 14);
  const rsiVal  = +(rsiVals[rsiVals.length-1] || 50).toFixed(1);
  const atr     = atrCalc(highs, lows, closes, 14);
  const atr_pct = atr ? +(atr / price * 100).toFixed(2) : null;
  const sl52 = bars.slice(-252);
  const hi52 = +Math.max(...sl52.map(b => b.high)).toFixed(2);
  const lo52 = +Math.min(...sl52.map(b => b.low)).toFixed(2);
  const pos52 = hi52 > lo52 ? Math.round((price - lo52) / (hi52 - lo52) * 100) : null;
  const perf20d = closes.length >= 21
    ? +((price - closes[closes.length-21]) / closes[closes.length-21] * 100).toFixed(2)
    : null;
  let trend = "ranging";
  if (ema_stack && above_200 && rsiVal > 52) trend = "bullish";
  else if (!ema_stack && above_200 === false && rsiVal < 48) trend = "bearish";
  return {
    sym: meta.sym, price: +price.toFixed(4), change_pct, trend, ema_stack, above_200,
    ema13: +ema13.toFixed(2), ema34: +ema34.toFixed(2), ema89: +ema89.toFixed(2),
    ema200: ema200 ? +ema200.toFixed(2) : null, rsi: rsiVal,
    atr: atr ? +atr.toFixed(4) : null, atr_pct, hi52, lo52, pos52, perf20d,
  };
}

async function computeRegime(market) {
  const yahoo = { tasi:'^TASI.SR', us:'^GSPC', etf:'^GSPC', crypto:'BTC-USD', commodity:'GC=F' };
  const yahooSym = yahoo[market] || '^TASI.SR';
  const meta = { sym: INDEX_FOR_MARKET[market] || INDEX_FOR_MARKET.tasi, yahoo: yahooSym };
  const data = await getSymbolMetrics(meta);
  if (!data) return null;
  return { ...data, market };
}

const OVERVIEW_SYMBOLS = [
  { sym: "TADAWUL:TASI",    label: "TASI",      flag: "🇸🇦", category: "index",     yahoo: "^TASI.SR" },
  { sym: "NYSE:SPY",        label: "S&P 500",   flag: "🇺🇸", category: "index",     yahoo: "SPY"      },
  { sym: "NASDAQ:QQQ",      label: "NASDAQ",    flag: "🇺🇸", category: "index",     yahoo: "QQQ"      },
  { sym: "TVC:USOIL",       label: "Oil (WTI)", flag: "🛢",  category: "commodity", yahoo: "CL=F"     },
  { sym: "TVC:GOLD",        label: "Gold",      flag: "🥇",  category: "commodity", yahoo: "GC=F"     },
  { sym: "TVC:SILVER",      label: "Silver",    flag: "🥈",  category: "commodity", yahoo: "SI=F"     },
  { sym: "BITSTAMP:BTCUSD", label: "Bitcoin",   flag: "₿",   category: "crypto",    yahoo: "BTC-USD"  },
];
let overviewCache = { data: null, ts: 0 };
const OVERVIEW_TTL = 20 * 60 * 1000;

// ── SSE broadcast ─────────────────────────────────────────────────────────────
const sseClients = new Set();
function broadcastSSE(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const c of sseClients) {
    try { c.write(msg); } catch (_) { sseClients.delete(c); }
  }
}

// ── Live scanner ──────────────────────────────────────────────────────────────
let liveTimer = null;
let liveInterval = 10; // minutes

// ── Auto-scan scheduler (KSA = UTC+3, trading days Sun-Thu) ──────────────────
const AUTO_SCAN_TIMES = [
  { h: 10, m: 15, slot: 'open'      },
  { h: 11, m: 30, slot: 'morning'   },
  { h: 12, m: 45, slot: 'midday'    },
  { h: 14, m:  0, slot: 'afternoon' },
  { h: 15, m: 15, slot: 'closing'   },
];

let autoScanLog = {}; // { 'YYYY-MM-DD': ['morning', 'midday', 'afternoon'] }

function loadAutoScanLog() {
  try {
    if (existsSync(AUTO_SCAN_LOG_PATH)) autoScanLog = JSON.parse(readFileSync(AUTO_SCAN_LOG_PATH, 'utf8'));
  } catch (_) { autoScanLog = {}; }
}

function saveAutoScanLog() {
  try { writeFileSync(AUTO_SCAN_LOG_PATH, JSON.stringify(autoScanLog, null, 2)); } catch (_) {}
}

function getNextAutoScanSlot() {
  const nowKSA = new Date(Date.now() + 3 * 3600 * 1000);
  const day    = nowKSA.getUTCDay();
  const hKSA   = nowKSA.getUTCHours();
  const mKSA   = nowKSA.getUTCMinutes();
  const dateStr = nowKSA.toISOString().slice(0, 10);
  const done    = autoScanLog[dateStr] || [];

  // Check remaining slots today (if trading day and market hours)
  if (day >= 0 && day <= 4) {
    for (const { h, m, slot } of AUTO_SCAN_TIMES) {
      if (done.includes(slot)) continue;
      const slotMin = h * 60 + m;
      const nowMin  = hKSA * 60 + mKSA;
      if (slotMin > nowMin) {
        const msUntil = (slotMin - nowMin) * 60 * 1000 - nowKSA.getUTCSeconds() * 1000;
        return { slot, h, m, dateStr, msUntil };
      }
    }
  }

  // Find next trading day
  let daysAhead = 1;
  while (daysAhead <= 7) {
    const futureDay = (day + daysAhead) % 7;
    if (futureDay >= 0 && futureDay <= 4) {
      const first = AUTO_SCAN_TIMES[0];
      return { slot: first.slot, h: first.h, m: first.m, daysAhead };
    }
    daysAhead++;
  }
  return null;
}

function checkAutoScan() {
  const nowKSA = new Date(Date.now() + 3 * 3600 * 1000);
  const day    = nowKSA.getUTCDay(); // 0=Sun … 4=Thu; 5=Fri, 6=Sat
  if (day === 5 || day === 6) return; // weekend

  const hKSA   = nowKSA.getUTCHours();
  const mKSA   = nowKSA.getUTCMinutes();
  if (hKSA < 10 || hKSA >= 16) return; // outside market window

  const dateStr = nowKSA.toISOString().slice(0, 10);
  if (!autoScanLog[dateStr]) autoScanLog[dateStr] = [];

  for (const { h, m, slot } of AUTO_SCAN_TIMES) {
    if (autoScanLog[dateStr].includes(slot)) continue;
    const nowMin  = hKSA * 60 + mKSA;
    const slotMin = h * 60 + m;
    // Fire within a 5-minute window after scheduled time
    if (nowMin >= slotMin && nowMin < slotMin + 5) {
      autoScanLog[dateStr].push(slot);
      saveAutoScanLog();
      console.log(`[Auto-scan] Firing ${slot} slot at KSA ${hKSA}:${String(mKSA).padStart(2,'0')}`);
      broadcastSSE({ type: 'auto_scan_starting', slot, dateStr });
      startScan(null, state.scan.currentMarket || 'tasi', state.scan.mode || 'swing');
      break;
    }
  }
}

setInterval(checkAutoScan, 60 * 1000);
loadAutoScanLog();

// ── Screenshot ────────────────────────────────────────────────────────────────
async function captureScreenshot(filename) {
  let client;
  try {
    client = await CDP({ port: process.env.CDP_PORT || 9222 });
    const { data } = await client.Page.captureScreenshot({ format: "jpeg", quality: 75 });
    const fp = join(SCREENSHOTS_DIR, filename);
    writeFileSync(fp, Buffer.from(data, "base64"));
    return fp;
  } finally {
    if (client) { try { await client.close(); } catch (_) {} }
  }
}

const DEFAULT_UNIVERSE = {
  tasi:      TASI_STOCKS,
  us:        US_EQUITY_STOCKS,
  etf:       ETF_STOCKS,
  crypto:    CRYPTO_STOCKS,
  commodity: COMMODITY_STOCKS,
};

function loadSettings() {
  if (existsSync(SETTINGS_PATH)) {
    try { state.settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")); return; } catch (_) {}
  }
  state.settings = { telegram: { enabled: false, token: "", chat_id: "" }, notifications: { on_strong_buy: true, on_strong_sell: true }, finnhub_token: "", account_balance: 100000, risk_percent: 1.5 };
  writeFileSync(SETTINGS_PATH, JSON.stringify(state.settings, null, 2));
}

function loadPositions() {
  state.positions = dbPositions.getAll();
}

function loadVirtual() {
  state.virtual = dbVirtual.get();
}

function loadScoreHistory() {
  state.score_history = dbScoreHistory.allGrouped();
}

function updateScoreHistory(results) {
  const date = new Date().toISOString().split("T")[0];
  results.forEach(r => {
    const entry = { d: date, s: r.score, m: r.maxScore || 8, b: r.bias, p: r.price,
      md: state.scan.mode || 'swing',
      vc: r.vol_compression?.is_compressed || false,
      rb: r.rsi_buildup?.is_building || false,
      wh: r.whale_score || 0,
    };
    dbScoreHistory.upsert(r.sym, entry);
    if (!state.score_history[r.sym]) state.score_history[r.sym] = [];
    state.score_history[r.sym] = state.score_history[r.sym].filter(h => h.d !== date);
    state.score_history[r.sym].push(entry);
    state.score_history[r.sym] = state.score_history[r.sym].slice(-15);
  });

  // Log market index regime to score_history for daily context
  if (results.length > 0) {
    const sampleRegime = results[0]?.market_regime || 'neutral';
    const firstSym = results[0]?.sym || '';
    const mktKey = firstSym.startsWith('TADAWUL:') ? 'tasi'
                 : firstSym.match(/XRP|BTC|ETH|SOL|BNB/) ? 'crypto'
                 : ['TVC:', 'NYMEX:', 'COMEX:'].some(p => firstSym.startsWith(p)) ? 'commodity' : 'us';
    const idxSym     = INDEX_FOR_MARKET[mktKey] || INDEX_FOR_MARKET.tasi;
    const regimeScore = sampleRegime === 'bull' ? 8 : sampleRegime === 'bear' ? 2 : 5;
    const regimeBias  = sampleRegime === 'bull' ? 'BUY' : sampleRegime === 'bear' ? 'SELL' : 'SKIP';

    const idxEntry = { d: date, s: regimeScore, m: 9, b: regimeBias, p: null,
      md: 'index', vc: 0, rb: 0, wh: 0 };
    dbScoreHistory.upsert(idxSym, idxEntry);
    if (!state.score_history[idxSym]) state.score_history[idxSym] = [];
    state.score_history[idxSym] = state.score_history[idxSym].filter(h => h.d !== date);
    state.score_history[idxSym].push(idxEntry);
    state.score_history[idxSym] = state.score_history[idxSym].slice(-15);
  }
}

// ── Validation spine: sync signals + grade matured outcomes vs equal-weight basket ──
let _valLastRun = null;
const _valBarsCache = new Map();
async function _valGetBars(sym) {
  if (_valBarsCache.has(sym)) return _valBarsCache.get(sym);
  let b = [];
  try { b = (await fetchYahooOHLCV(toYahooSym(sym), '1d', 520)).map(x => ({ date: new Date(x.time * 1000).toISOString().slice(0, 10), close: x.close })); } catch {}
  _valBarsCache.set(sym, b); return b;
}
// Run at most once per calendar day (grading only changes as new daily bars print).
async function runValidationGradeThrottled() {
  const today = new Date().toISOString().slice(0, 10);
  if (_valLastRun === today) return;
  _valLastRun = today;
  try {
    backfillFromTables();
    _valBarsCache.clear();
    const res = await gradePending({ getBars: _valGetBars, universe: TASI_STOCKS.map(s => s.sym) });
    console.log(`[validation] graded ${res.graded}, pending ${res.stillPending}`);
    // Strategy state machine: force a fresh (uncached) evaluation so AUTO risk-down
    // transitions persist daily, independent of anyone opening the Lab page.
    try {
      const sv = await getStrategyValidation({ ttlMs: 0 });
      const m = sv.strategies?.[0];
      if (m) console.log(`[strategy] ${m.id}: ${m.status} (exposure ${m.exposure_mult}, rec ${m.recommendedAction || 'none'})`);
    } catch (e) { console.warn('[strategy] eval error:', e.message); }
  } catch (e) { console.warn('[validation] grade error:', e.message); }
}

function autoLogAccuracySignals(results) {
  // After each scan, log STRONG BUY/SELL signals (score ≥7) for accuracy tracking.
  // regime and market_index are sourced from the scan result (per-market, already computed).
  // Label is resolved to EXIT/EXIT NOW/SKIP/AVOID based on regime + position holding.
  try {
    accuracyLab.checkPriceOutcomes(results);
    accuracyLab.checkAndExpire();

    const strongSignals = results.filter(r =>
      (r.bias === 'STRONG BUY' || r.bias === 'STRONG SELL') && r.score >= 7 && r.atr
    );

    for (const r of strongSignals) {
      const isBear = r.bias === 'STRONG SELL';
      const stop = isBear ? r.price + 1.5 * r.atr : r.price - 1.5 * r.atr;
      const t1   = isBear ? r.price - 1.5 * r.atr : r.price + 1.5 * r.atr;
      const t2   = isBear ? r.price - 3 * r.atr   : r.price + 3 * r.atr;

      const market = r.sym.startsWith('TADAWUL:') ? 'tasi'
                   : r.sym.match(/XRP|BTC|ETH|SOL|BNB/) ? 'crypto'
                   : ['TVC:','NYMEX:','COMEX:'].some(p => r.sym.startsWith(p)) ? 'commodity' : 'us';

      const regime      = r.market_regime || 'neutral';
      const marketIndex = INDEX_FOR_MARKET[market] || INDEX_FOR_MARKET.tasi;

      // Check if user holds this position
      const isHolding = !!dbPositions.get(r.sym);

      // Resolve display label
      const resolvedBias = resolveSignalLabel(r.bias, regime, isHolding);

      accuracyLab.log({
        sym: r.sym, name: r.name,
        price_entry: r.price, price_stop: stop, price_t1: t1, price_t2: t2,
        bias: resolvedBias,
        score: r.score, max_score: r.maxScore || 9,
        composite: r.composite || Math.round(r.score / (r.maxScore || 9) * 100),
        scan_mode: state.scan.mode || 'swing',
        style_tags: r.style_tags || [],
        market, sector: null,
        hurst: r.hurst, atr_rank: r.atr_pct_rank,
        rsi_entry: r.rsi, vol_ratio_entry: r.vol_ratio,
        regime,
        market_index: marketIndex,
      });
    }
  } catch (e) { console.warn('[lab] auto-log error:', e.message); }
}

function loadAlertRules() {
  state.alert_rules = dbAlertRules.getAll();
}

function checkAlertRules(results) {
  if (!state.alert_rules.length) return;
  const today = new Date().toISOString().split("T")[0];
  const tg = state.settings?.telegram;
  let changed = false;
  state.alert_rules.forEach(rule => {
    if (rule.lastTriggered === today) return;
    const r = results.find(x => x.sym === rule.sym);
    if (!r) return;
    let triggered = false;
    if (rule.field === "score" && rule.op === "gte" && r.score >= rule.threshold) triggered = true;
    if (rule.field === "score" && rule.op === "lte" && r.score <= rule.threshold) triggered = true;
    if (rule.field === "rsi"   && rule.op === "gte" && r.rsi   >= rule.threshold) triggered = true;
    if (rule.field === "rsi"   && rule.op === "lte" && r.rsi   <= rule.threshold) triggered = true;
    if (rule.field === "bias"  && rule.op === "is"  && r.bias  === rule.threshold) triggered = true;
    if (!triggered) return;
    rule.lastTriggered = today; changed = true;
    dbAlertRules.upsert(rule);
    broadcastSSE({ type: "alert_rule_triggered", sym: r.sym, name: r.name, ruleName: rule.name, bias: r.bias, score: r.score });
    if (tg?.enabled && tg.token && tg.chat_id) {
      const msg = `📋 <b>Smart Alert: ${rule.name}</b>\n${r.name} (${tickerDisplay(r.sym)})\nScore: ${r.score}/${r.maxScore||8} | ${r.bias} | RSI: ${r.rsi?.toFixed(1)}`;
      sendTelegram(tg.token, tg.chat_id, msg).catch(() => {});
    }
  });
}

function toFinnhubSym(sym) {
  if (sym.startsWith("TADAWUL:")) return sym.replace("TADAWUL:", "") + ".SR";
  return sym.includes(":") ? sym.split(":")[1] : sym;
}

function loadUniverse() {
  if (existsSync(UNIVERSE_PATH)) {
    try { state.universe = JSON.parse(readFileSync(UNIVERSE_PATH, "utf8")); return; } catch (_) {}
  }
  state.universe = JSON.parse(JSON.stringify(DEFAULT_UNIVERSE));
  writeFileSync(UNIVERSE_PATH, JSON.stringify(state.universe, null, 2));
}

function loadCaches() {
  if (existsSync(SCAN_CACHE)) {
    try { const c = JSON.parse(readFileSync(SCAN_CACHE, "utf8")); state.scan.results = c.results || []; state.scan.lastRun = c.scanned_at || null; } catch (_) {}
  }

}
loadCaches();
loadUniverse();
loadSettings();
loadPositions();
loadVirtual();
loadScoreHistory();
loadAlertRules();

// ── Block Deals — Argaam HTML Scraper + Manual Fallback ──────────────────────
let blockDealsCache = { data: [], ts: 0, source: null, error: null };
const BLOCK_DEALS_TTL = 10 * 60 * 1000; // refresh every 10 min
const MANUAL_DEALS_PATH = join(__dirname, "block_deals.json");

// Arabic company name keywords → TADAWUL code
const ARABIC_NAME_MAP = {
  'الراجحي': '1120', 'راجحي': '1120',
  'الأهلي السعودي': '1180', 'البنك الأهلي': '1180', 'الأهلي': '1180',
  'بنك الرياض': '1010', 'الرياض': '1010',
  'ساب': '1030',
  'البنك السعودي الفرنسي': '1050', 'الفرنسي': '1050',
  'البنك العربي الوطني': '1080', 'العربي الوطني': '1080',
  'البلاد': '1140',
  'الإنماء': '1150', 'انماء': '1150',
  'السعودي للاستثمار': '1060',
  'الجزيرة': '1020',
  'أرامكو': '2222', 'ارامكو': '2222', 'أرامكو السعودية': '2222',
  'سابك': '2010',
  'تكنولوجيا': '2060', 'تصنيع': '2060',
  'صحارى': '2310',
  'بترورابغ': '2380', 'بترو رابغ': '2380',
  'كيان': '2350',
  'الاتصالات السعودية': '7010', 'stc': '7010',
  'موبايلي': '7020',
  'زين السعودية': '7030', 'زين': '7030',
  'إلم': '7203',
  'كهرباء': '5110', 'السعودية للكهرباء': '5110',
  'أكوا': '2082', 'اكوا': '2082',
  'المراعي': '2280', 'مراعي': '2280',
  'سافولا': '2050',
  'هرفي': '6002',
  'التنمية الغذائية': '2281',
  'جرير': '4190',
  'فتيحي': '4180',
  'إكسترا': '4003', 'اكسترا': '4003',
  'الدريس': '4200',
  'الحمادي': '4007',
  'دلة': '4004',
  'موواساة': '2160', 'مواساة': '2160',
  'الحبيب': '4013', 'سليمان الحبيب': '4013',
  'النخبة': '4005',
  'فقيه': '4017',
  'دار الأركان': '4300', 'دار أركان': '4300',
  'إعمار': '4310', 'اعمار الاقتصادية': '4310',
  'الرياض التنمية': '4150',
  'أسمنت السعودية': '3010', 'الأسمنت السعودية': '3010',
  'أسمنت ينبع': '3020', 'ينبع للأسمنت': '3020',
  'أسمنت العربية': '3030', 'العربية للأسمنت': '3030',
  'أسمنت المنطقة الجنوبية': '3040', 'الجنوبية للأسمنت': '3040',
  'أسمنت القصيم': '3050',
  'الكابلات السعودية': '2110',
  'صناعات متقدمة': '2120',
  'ألجين': '2170', 'الجين': '2170',
  'الخدمات الأرضية': '4031',
  'التعاونية': '8010', 'تاونية': '8010',
  'بوبا': '8020',
  'الراجحي للتأمين': '8230',
};

// Build a combined lookup: code → English name (for display)
const CODE_TO_NAME = {};
TASI_STOCKS.forEach(s => {
  const code = s.sym.split(':')[1];
  if (code) CODE_TO_NAME[code] = s.name;
});

function resolveArabicName(arabicName) {
  if (!arabicName) return null;
  const normalized = arabicName.trim();
  // Direct match
  if (ARABIC_NAME_MAP[normalized]) return ARABIC_NAME_MAP[normalized];
  // Substring match (longest key that appears in the name wins)
  let best = null, bestLen = 0;
  for (const [kw, code] of Object.entries(ARABIC_NAME_MAP)) {
    if (normalized.includes(kw) && kw.length > bestLen) {
      best = code; bestLen = kw.length;
    }
  }
  return best;
}

// Extract text content from a <td> cell (strip inner HTML tags)
function tdText(tdInner) {
  return tdInner.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').replace(/&nbsp;/g, ' ').trim();
}

// Parse daily summary article: "تاسي: N صفقة خاصة بقيمة X"
// Returns array of deals (one per company, aggregated across all sub-deals)
function parseSummaryArticle(html, pubDate) {
  const cells = [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => tdText(m[1]));

  const byCompany = {};
  let currentCode = null;
  let prevWasQty  = false;

  for (const cell of cells) {
    const num = parseFloat(cell);
    if (isNaN(num) || cell.length === 0) {
      const code = resolveArabicName(cell);
      if (code) {
        currentCode = code;
        prevWasQty  = false;
        if (!byCompany[code]) byCompany[code] = { price: 0, qty: 0, value: 0 };
      } else if (cell.length > 2) {
        // Unrecognized company name — stop accumulating under previous company
        currentCode = null;
        prevWasQty  = false;
      }
    } else if (currentCode) {
      const isInt   = Number.isInteger(num);
      const isLarge = num > 1000;
      if (isLarge && isInt) {
        byCompany[currentCode].qty += num;
        prevWasQty = true;
      } else if (!isLarge && !isInt && prevWasQty) {
        byCompany[currentCode].value += num * 1_000_000;
        prevWasQty = false;
      } else {
        // Small float = price / deal price
        if (!byCompany[currentCode].price) byCompany[currentCode].price = num;
        prevWasQty = false;
      }
    }
  }

  const ts = pubDate ? pubDate.toISOString() : new Date().toISOString();
  return Object.entries(byCompany)
    .filter(([, d]) => d.price > 0 && d.qty > 0 && d.value > 0)
    .map(([code, d]) => ({
      sym: `TADAWUL:${code}`,
      name: CODE_TO_NAME[code] || code,
      price: +d.price.toFixed(4),
      qty: d.qty,
      value: Math.round(d.value),
      time: ts,
      source: 'Argaam',
      arabicCompany: null,
    }));
}

// Parse an individual deal article: "صفقة خاصة على [COMPANY] بقيمة X"
// Returns a single deal object or null
function parseArgaamArticle(html, articleId, todayStr) {
  // Date check — Argaam format: "2026/05/07"
  let pubDate = null;
  const ldMatch = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
  if (ldMatch) pubDate = new Date(ldMatch[1].replace(/\//g, '-'));
  if (pubDate && todayStr && pubDate.toISOString().slice(0, 10) !== todayStr) return null;

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const title = titleMatch ? titleMatch[1].replace(/&[^;]+;/g, ' ').trim() : '';

  // Individual deal articles: "صفقة خاصة على [COMPANY] بقيمة"
  const companyMatch = title.match(/صفقة خاصة على (.+?) بقيمة/);
  if (!companyMatch) return null; // summary article — caller handles separately
  const arabicCompany = companyMatch[1].trim();

  const stockCode = resolveArabicName(arabicCompany);
  if (!stockCode) return null;

  // Value from title
  let value = 0;
  const valMatch = title.match(/بقيمة\s+([\d\.,]+)\s*(مليون|مليار)?/);
  if (valMatch) {
    let v = parseFloat(valMatch[1].replace(/,/g, ''));
    if (valMatch[2] === 'مليون') v *= 1_000_000;
    else if (valMatch[2] === 'مليار') v *= 1_000_000_000;
    value = v;
  }

  // Numbers from deal table: after "كمية الصفقة" heading until "وبحسب تداول"
  let price = 0, qty = 0;
  const tableSection = html.match(/كمية الصفقة[\s\S]{0,3000}?وبحسب تداول/);
  if (tableSection) {
    const nums = [...tableSection[0].matchAll(/>(\d[\d,\.]*)</g)]
      .map(m => parseFloat(m[1].replace(/,/g, '')))
      .filter(v => !isNaN(v) && v > 0);
    const priceCands = nums.filter(v => v <= 2000 && v >= 0.5 && !Number.isInteger(v));
    const qtyCands   = nums.filter(v => Number.isInteger(v) && v >= 100);
    if (priceCands.length) price = priceCands[0];
    if (qtyCands.length)   qty   = qtyCands[0];
    if (value === 0 && nums.length) {
      // last small float × 1M
      const lastSmall = nums.filter(v => v < 10000 && !Number.isInteger(v)).pop();
      if (lastSmall) value = lastSmall * 1_000_000;
    }
  }

  if (qty === 0 && value > 0 && price > 0) qty = Math.round(value / price);
  if (value === 0 && qty > 0 && price > 0) value = price * qty;
  if (price <= 0) return null;

  return {
    sym:  `TADAWUL:${stockCode}`,
    name: CODE_TO_NAME[stockCode] || arabicCompany,
    price: +price.toFixed(4),
    qty:   Math.round(qty),
    value: Math.round(value),
    time:  pubDate ? pubDate.toISOString() : new Date().toISOString(),
    source: 'Argaam',
    articleId,
    arabicCompany,
  };
}

async function fetchArgaamBlockDeals() {
  const BASE    = 'https://www.argaam.com';
  const TAG_URL = `${BASE}/ar/tags/id/24779/1/%D8%A7%D9%84%D8%B5%D9%81%D9%82%D8%A7%D8%AA-%D8%A7%D9%84%D8%AE%D8%A7%D8%B5%D8%A9`;
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ar,en;q=0.8',
    'Referer': 'https://www.argaam.com/',
  };

  // Today in Saudi time (UTC+3)
  const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);

  // Fetch tag page
  let tagHtml;
  try {
    const res = await fetch(TAG_URL, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Tag page HTTP ${res.status}`);
    tagHtml = await res.text();
  } catch (e) {
    return { deals: [], error: `Argaam tag page failed: ${e.message}` };
  }

  // Extract article IDs in page order, with their dates
  const articleIds = [...new Set(
    [...tagHtml.matchAll(/\/ar\/article\/articledetail\/id\/(\d+)/g)].map(m => m[1])
  )];
  if (!articleIds.length) return { deals: [], error: 'No article links found on Argaam tag page' };

  // Build date map: "2026/05/07" appears in a <div class="date"> before each article link
  const articleDateMap = {};
  const tagDatePat = /(\d{4}\/\d{2}\/\d{2})[\s\S]{0,500}?\/ar\/article\/articledetail\/id\/(\d+)/g;
  let dm;
  while ((dm = tagDatePat.exec(tagHtml)) !== null) {
    const [, d, id] = dm;
    if (!articleDateMap[id]) articleDateMap[id] = d.replace(/\//g, '-');
  }

  // Determine target articles (today's or fallback to most recent)
  const hasDates = Object.keys(articleDateMap).length > 0;
  const todayIds = hasDates ? articleIds.filter(id => articleDateMap[id] === todayStr) : [];
  const targetIds = todayIds.length ? todayIds : articleIds.slice(0, 8);

  const deals = [];
  const seenSyms = new Set();

  // Fetch each article and classify by its own <title> tag.
  // "صفقة خاصة على [company] بقيمة" → single-company article → parseArgaamArticle
  // Everything else on this tag page uses a table with multiple companies → parseSummaryArticle
  for (const id of targetIds) {
    try {
      const url = `${BASE}/ar/article/articledetail/id/${id}`;
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
      if (!res.ok) continue;
      const html = await res.text();

      const ldMatch  = html.match(/"datePublished"\s*:\s*"([^"]+)"/);
      const pubDate  = ldMatch ? new Date(ldMatch[1].replace(/\//g, '-')) : null;

      // Date guard: skip old articles when we have today's IDs
      if (pubDate && todayIds.length && pubDate.toISOString().slice(0, 10) !== todayStr) {
        await new Promise(r => setTimeout(r, 200)); continue;
      }

      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : '';

      if (/صفقة خاصة على .+ بقيمة/.test(title)) {
        // Single-company article
        const deal = parseArgaamArticle(html, id, todayStr);
        if (deal && !seenSyms.has(deal.sym)) { deals.push(deal); seenSyms.add(deal.sym); }
      } else {
        // Table-format article (TASI summary, نمو aggregate, etc.)
        const parsed = parseSummaryArticle(html, pubDate);
        parsed.forEach(d => { if (!seenSyms.has(d.sym)) { deals.push(d); seenSyms.add(d.sym); } });
      }
      await new Promise(r => setTimeout(r, 350));
    } catch (_) { /* skip */ }
  }

  return {
    deals,
    error: deals.length ? null : 'No TASI block deals found in today\'s Argaam articles. Market may be closed or no deals reported yet.',
  };
}

function loadManualDeals() {
  try {
    const data = JSON.parse(readFileSync(MANUAL_DEALS_PATH, "utf8"));
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000; // keep 7 days for reference
    return data.filter(d => new Date(d.time).getTime() > cutoff);
  } catch (_) { return []; }
}

function saveManualDeals(deals) {
  writeFileSync(MANUAL_DEALS_PATH, JSON.stringify(deals, null, 2));
}

// Persist the last Argaam fetch that had results so we can show it when market is closed
function loadLastArgaamDeals() {
  return dbBlockDeals.getLastDeals();
}
function saveLastArgaamDeals(deals, date) {
  dbBlockDeals.setLastDeals(deals, date);
}

function loadInsiderBuys() {
  return dbInsiderBuys.getAll();
}
function saveInsiderBuys(data) {
  dbInsiderBuys.syncAll(data);
}

function appendBlockDealLog(deals, dateStr) {
  if (deals && deals.length) dbBlockDeals.appendDeals(deals, dateStr);
  return dbBlockDeals.getFrequency();
}

function getBlockDealFrequency(syms) {
  const log = dbBlockDeals.getFrequency();
  const cutoff7  = new Date(Date.now() -  7 * 86400 * 1000).toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const result = {};
  for (const sym of syms) {
    const all  = (log[sym] || []).filter(d => d >= cutoff30);
    const week = all.filter(d => d >= cutoff7);
    if (all.length > 0) {
      result[sym] = {
        count30: all.length,
        count7:  week.length,
        days:    all,
        label:   week.length > 1 ? `${week.length}× this week` : all.length > 1 ? `${all.length}× in 30d` : null,
      };
    }
  }
  return result;
}

async function refreshBlockDeals() {
  if (Date.now() - blockDealsCache.ts < BLOCK_DEALS_TTL) return blockDealsCache;

  const manual = loadManualDeals();

  // Try Argaam automated fetch
  let argaamDeals = [], argaamError = null;
  try {
    const result = await fetchArgaamBlockDeals();
    argaamDeals = result.deals || [];
    argaamError = result.error || null;
  } catch (e) {
    argaamError = `Argaam fetch error: ${e.message}`;
  }

  // Persist if we got fresh Argaam deals today
  let staleArgaamDeals = [], staleDate = null;
  if (argaamDeals.length) {
    const todayStr = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
    saveLastArgaamDeals(argaamDeals, todayStr);
    appendBlockDealLog(argaamDeals, todayStr);
  } else {
    // No deals today — load last known good
    const last = loadLastArgaamDeals();
    if (last?.deals?.length) {
      staleArgaamDeals = last.deals;
      staleDate = last.date;
    }
  }

  // Use today's Argaam deals if available, otherwise fall back to stale
  const argaamSource = argaamDeals.length ? argaamDeals : staleArgaamDeals;
  const isStale = argaamDeals.length === 0 && staleArgaamDeals.length > 0;

  // Merge with manual (deduplicate)
  const all = [...argaamSource];
  for (const m of manual) {
    const isDup = argaamSource.some(a =>
      a.sym === m.sym && Math.abs(new Date(a.time) - new Date(m.time)) < 3600000
    );
    if (!isDup) all.push(m);
  }

  const sources = [];
  if (argaamDeals.length)  sources.push(`Argaam today (${argaamDeals.length})`);
  else if (isStale)        sources.push(`Argaam ${staleDate} (last available)`);
  if (manual.length)       sources.push(`Manual (${manual.length})`);

  const allSyms = all.map(d => d.sym);
  const frequency = getBlockDealFrequency(allSyms);

  blockDealsCache = {
    data: all.sort((a, b) => b.value - a.value),
    ts: Date.now(),
    source: sources.length ? sources.join(' + ') : null,
    stale: isStale,
    stale_date: isStale ? staleDate : null,
    error: all.length === 0
      ? (argaamError || 'No block deals found. Market may be closed. Enter manually if needed.')
      : (isStale ? null : argaamError),
    frequency,
  };
  return blockDealsCache;
}

// ── Quick-scan: only re-scan stocks worth watching (BUY/WATCH + recent SELL signals) ─
function buildQuickScanList(market) {
  const cached = state.scan.results || [];
  if (!cached.length) return null; // No prior scan — need full scan first

  const universe = state.universe[market] || getUniverseByMarket(market);
  const QUICK_BIASES = new Set(["STRONG BUY", "BUY", "WATCH", "SELL", "STRONG SELL", "AVOID"]);

  // Include: stocks with actionable signals + any with recent score changes
  const quickSyms = new Set();
  cached.forEach(r => {
    if (QUICK_BIASES.has(r.bias)) quickSyms.add(r.sym);
  });
  // Also include ERROR/NO_DATA stocks to retry them
  cached.filter(r => r.bias === "ERROR" || r.bias === "NO_DATA").forEach(r => quickSyms.add(r.sym));
  // Always include at least top-scored SKIP stocks near promotion threshold
  cached.filter(r => r.bias === "SKIP" && r.score >= 4).forEach(r => quickSyms.add(r.sym));

  return universe.filter(s => quickSyms.has(s.sym));
}

// ── Runners ───────────────────────────────────────────────────────────────────
function startScan(symbols, market, mode = 'swing', isQuick = false) {
  if (state.scan.running) return { ok: false, message: "Scan already running" };
  const fullUniverse = state.universe[market || "tasi"] || getUniverseByMarket(market || "tasi");
  if (!symbols && market && market !== "all") {
    symbols = fullUniverse;
  }
  state.scan.running = true;
  state.scan.progress = 0;
  state.scan.results = [];
  state.scan.error = null;
  state.scan.currentMarket = market || "tasi";
  state.scan.mode = mode || 'swing';
  state.scan.investMode = state.scan.mode === 'position';
  state.scan.quickScan = isQuick;
  state.scan.quickSkipped = isQuick ? Math.max(0, fullUniverse.length - (symbols?.length || 0)) : 0;

  // Save previous cache for delta comparison
  if (existsSync(SCAN_CACHE)) {
    try { writeFileSync(PREV_SCAN_CACHE, readFileSync(SCAN_CACHE, "utf8")); } catch (_) {}
  }

  (async () => {
    try {
      const results = await runScreener({
        symbols,
        market: state.scan.currentMarket,
        mode: state.scan.mode,
        investMode: state.scan.investMode,
        onProgress(current, total, result) {
          state.scan.progress = current;
          state.scan.total = total;
          state.scan.results.push(result);
        },
      });
      state.scan.results = results;
      state.scan.lastRun = new Date().toISOString();

      // Stamp freshly scanned results with scan timestamp
      results.forEach(r => { r.scanned_at = state.scan.lastRun; });

      // Merge with existing cache for partial scans
      if (symbols && symbols.length > 0 && existsSync(SCAN_CACHE)) {
        try {
          const scannedSyms = new Set(symbols.map(s => (typeof s === "object" ? s.sym : s)));
          const cached = JSON.parse(readFileSync(SCAN_CACHE, "utf8"));
          // Preserve scanned_at on cached (stale) results so UI can flag them
          const existing = (cached.results || []).filter(r => !scannedSyms.has(r.sym));
          const merged = [...existing, ...results].sort((a, b) => (b.score || 0) - (a.score || 0));
          writeFileSync(SCAN_CACHE, JSON.stringify({ scanned_at: state.scan.lastRun, results: merged }, null, 2));
          state.scan.results = merged;
        } catch (_) {}
      } else {
        writeFileSync(SCAN_CACHE, JSON.stringify({ scanned_at: state.scan.lastRun, results }, null, 2));
      }

      // Broadcast score changes via SSE
      if (sseClients.size > 0 && state.scan.delta?.length > 0) {
        for (const d of state.scan.delta) {
          broadcastSSE({ type: "score_change", sym: d.sym, name: d.name, prev_bias: d.prev_bias, curr_bias: d.curr_bias, score_delta: d.score_delta, direction: d.direction });
        }
      }
      broadcastSSE({ type: "scan_complete", count: results.length, lastRun: state.scan.lastRun, quickScan: state.scan.quickScan, quickSkipped: state.scan.quickSkipped });

      // Refresh CMA filings after each full scan (rate-limited to 4h inside the function)
      if (!state.scan.quickScan) fetchAndStoreCMAFilings().catch(() => {});

      // Compute delta vs previous scan
      try {
        const prev = existsSync(PREV_SCAN_CACHE) ? JSON.parse(readFileSync(PREV_SCAN_CACHE, "utf8")) : null;
        state.scan.delta = computeDelta(results, prev?.results || [], state.score_history);
      } catch (_) { state.scan.delta = []; }

      // Telegram notifications
      const tg = state.settings?.telegram;
      if (tg?.enabled && tg.token && tg.chat_id) {
        const cfg = state.settings.notifications || {};
        const sb = cfg.on_strong_buy  !== false ? results.filter(r => r.bias === "STRONG BUY")  : [];
        const ss = cfg.on_strong_sell !== false ? results.filter(r => r.bias === "STRONG SELL") : [];
        if (sb.length + ss.length > 0) {
          let msg = `🔔 <b>Mawjah Scan Alert</b>\n${new Date().toLocaleString("en-SA")}\n\n`;
          if (sb.length) {
            msg += `🟢 <b>STRONG BUY (${sb.length})</b>\n`;
            sb.slice(0, 8).forEach(r => { msg += `• <b>${tickerDisplay(r.sym)}</b> ${r.name} — ${r.score}/8\n`; });
            msg += "\n";
          }
          if (ss.length) {
            msg += `🔴 <b>STRONG SELL (${ss.length})</b>\n`;
            ss.slice(0, 8).forEach(r => { msg += `• <b>${tickerDisplay(r.sym)}</b> ${r.name} — ${r.score}/8\n`; });
          }
          sendTelegram(tg.token, tg.chat_id, msg).catch(() => {});
        }
      }

      // Score history + smart alert rules
      updateScoreHistory(state.scan.results);
      checkAlertRules(state.scan.results);
      autoLogAccuracySignals(state.scan.results);
      runValidationGradeThrottled().catch(() => {}); // spine: sync + grade, once/day, non-blocking

      // Generate top opportunities analysis (async, non-blocking)
      if (!state.scan.quickScan) generateTopOpportunities(state.scan.results).catch(() => {});

    } catch (err) {
      state.scan.error = err.message;
    } finally {
      state.scan.running = false;
    }
  })();

  return { ok: true, message: symbols ? `Scanning ${symbols.length} stocks` : "Scanning all stocks" };
}

// ── Google OAuth config (set in .env) ─────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const OAUTH_REDIRECT_BASE  = process.env.OAUTH_REDIRECT_BASE || `http://localhost:${process.env.PORT || 3000}`;

// ── Login rate limiter (in-memory, per-IP, 5 attempts / 60s) ─────────────────
const _loginAttempts = new Map();
function loginRateLimited(ip) {
  const now = Date.now(), window = 60_000, limit = 5;
  const rec = _loginAttempts.get(ip) || { count: 0, resetAt: now + window };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + window; }
  rec.count++;
  _loginAttempts.set(ip, rec);
  return rec.count > limit;
}

// ── One-time OAuth code store (code → { jwt, exp }) ─────────────────────────
const _oauthCodes = new Map();
function issueOAuthCode(jwt) {
  const code = crypto.randomUUID();
  _oauthCodes.set(code, { jwt, exp: Date.now() + 30_000 }); // 30-second TTL
  return code;
}
function redeemOAuthCode(code) {
  const entry = _oauthCodes.get(code);
  if (!entry) return null;
  _oauthCodes.delete(code);
  if (Date.now() > entry.exp) return null;
  return entry.jwt;
}

// ── Auth route handler ────────────────────────────────────────────────────────
async function handleAuthRoute(req, res, path, method, url) {
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || `http://localhost:${PORT}`;
  const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': ALLOWED_ORIGIN };

  function ok(data, status = 200) {
    res.writeHead(status, CORS);
    res.end(JSON.stringify(data));
  }
  function fail(msg, status = 400) {
    res.writeHead(status, CORS);
    res.end(JSON.stringify({ error: msg }));
  }
  function redirect(location) {
    res.writeHead(302, { Location: location });
    res.end();
  }

  // POST /auth/register
  if (path === '/auth/register' && method === 'POST') {
    if (!process.env.ALLOW_REGISTRATION) return fail('Registration is disabled. Set ALLOW_REGISTRATION=true in .env to enable.', 403);
    const body = await readBody(req);
    const { email, username, password, display_name } = body;
    if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
    if (!email && !username) return fail('Email or username is required.');
    if (email && authUsers.byEmail(email)) return fail('Email already registered.');
    if (username && authUsers.byUsername(username)) return fail('Username already taken.');
    const password_hash = await hashPassword(password);
    const id = authUsers.create({ email: email || null, username: username || null, password_hash, display_name: display_name || username || email?.split('@')[0] || 'User', provider: 'local' });
    authUsers.touchLogin(id);
    const token = signJWT({ sub: id, email, username });
    return ok({ token, user: authUsers.safeView(authUsers.byId(id)) }, 201);
  }

  // POST /auth/login
  if (path === '/auth/login' && method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (loginRateLimited(ip)) return fail('Too many login attempts. Try again in a minute.', 429);
    const body = await readBody(req);
    const { identifier, password } = body;
    if (!identifier || !password) return fail('Identifier and password are required.');
    const user = authUsers.byIdentifier(identifier);
    if (!user || !user.password_hash) return fail('Invalid credentials.', 401);
    const ok2 = await verifyPassword(password, user.password_hash);
    if (!ok2) return fail('Invalid credentials.', 401);
    authUsers.touchLogin(user.id);
    const token = signJWT({ sub: user.id, email: user.email, username: user.username });
    return ok({ token, user: authUsers.safeView(user) });
  }

  // GET /auth/me
  if (path === '/auth/me' && method === 'GET') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return fail('No token', 401);
    let payload;
    try { payload = verifyJWT(token); } catch { return fail('Token invalid or expired', 401); }
    const user = authUsers.byId(payload.sub);
    if (!user) return fail('User not found', 404);
    return ok({ user: authUsers.safeView(user) });
  }

  // PATCH /auth/profile
  if (path === '/auth/profile' && method === 'PATCH') {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token) return fail('No token', 401);
    let payload;
    try { payload = verifyJWT(token); } catch { return fail('Token invalid or expired', 401); }
    const body = await readBody(req);
    const { display_name, avatar_url, username } = body;
    if (username && username !== authUsers.byId(payload.sub)?.username) {
      if (authUsers.byUsername(username)) return fail('Username already taken.');
    }
    authUsers.updateProfile(payload.sub, { display_name, avatar_url, username });
    return ok({ user: authUsers.safeView(authUsers.byId(payload.sub)) });
  }

  // POST /auth/logout — stateless JWT; client clears token
  if (path === '/auth/logout' && method === 'POST') {
    return ok({ ok: true });
  }

  // GET /auth/google — redirect to Google consent page
  if (path === '/auth/google' && method === 'GET') {
    if (!GOOGLE_CLIENT_ID) return fail('Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env', 503);
    const params = new URLSearchParams({
      client_id:     GOOGLE_CLIENT_ID,
      redirect_uri:  `${OAUTH_REDIRECT_BASE}/auth/google/callback`,
      response_type: 'code',
      scope:         'openid email profile',
      access_type:   'online',
      prompt:        'select_account',
    });
    return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  }

  // GET /auth/google/callback — exchange code, create/find user, issue JWT
  if (path === '/auth/google/callback' && method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) return fail('Missing code from Google', 400);
    try {
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${OAUTH_REDIRECT_BASE}/auth/google/callback`,
          grant_type: 'authorization_code',
        }),
      });
      const tokens = await tokenRes.json();
      if (!tokens.access_token) throw new Error(tokens.error_description || 'Token exchange failed');

      // Get user info
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const gUser = await infoRes.json();
      if (!gUser.sub) throw new Error('Failed to get Google user info');

      // Find or create user
      let user = authUsers.byProvider('google', gUser.sub);
      if (!user) {
        // Check if email already exists (link accounts)
        user = gUser.email ? authUsers.byEmail(gUser.email) : null;
        if (user) {
          // Link Google to existing account
          const { db } = await import('./db.js');
          db.prepare('UPDATE users SET provider=?,provider_id=?,avatar_url=COALESCE(avatar_url,?) WHERE id=?')
            .run('google', gUser.sub, gUser.picture || null, user.id);
          user = authUsers.byId(user.id);
        } else {
          const id = authUsers.create({
            email: gUser.email || null,
            username: null,
            display_name: gUser.name || gUser.email?.split('@')[0] || 'User',
            avatar_url: gUser.picture || null,
            provider: 'google',
            provider_id: gUser.sub,
          });
          user = authUsers.byId(id);
        }
      }
      authUsers.touchLogin(user.id);
      const jwt = signJWT({ sub: user.id, email: user.email, username: user.username });
      // Use a short-lived one-time code so the JWT never appears in logs or browser history
      const code = issueOAuthCode(jwt);
      return redirect(`/?auth_code=${encodeURIComponent(code)}`);
    } catch (e) {
      return redirect(`/?auth_error=${encodeURIComponent(e.message)}`);
    }
  }

  // POST /auth/exchange — redeem a one-time OAuth code for a JWT
  if (path === '/auth/exchange' && method === 'POST') {
    const body = await readBody(req);
    const jwt = redeemOAuthCode(body.code || '');
    if (!jwt) return fail('Invalid or expired code.', 401);
    return ok({ token: jwt });
  }

  return fail('Not found', 404);
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
  const url    = new URL(req.url, `http://localhost:${PORT}`);
  const path   = url.pathname;
  const method = req.method;

  if (method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" });
    return res.end();
  }

  if (path === "/" || path === "/index.html") return html(res, join(__dirname, "index.html"));
  if (path === "/landing" || path === "/landing.html") return html(res, resolve(__dirname, "../landing.html"));

  // ── Auth routes (public — no API key needed) ─────────────────────────────────
  if (path.startsWith('/auth/')) {
    return handleAuthRoute(req, res, path, method, url);
  }

  // ── Protect /api/* routes ────────────────────────────────────────────────────
  if (path.startsWith('/api/')) {
    const authHeader = req.headers['authorization'] || '';
    // EventSource (SSE) can't set headers — accept ?token= for the event stream.
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7)
      : (req.headers['x-api-key'] || url.searchParams.get('token') || '');
    let authorized = false;

    // 1. Accept legacy API key
    if (API_KEY && token === API_KEY) {
      authorized = true;
    }
    // 2. Accept JWT from the new user auth
    if (!authorized && token) {
      try { req.currentUser = verifyJWT(token); authorized = true; } catch {}
    }
    // 3. If no API key is configured and no JWT, allow (dev mode)
    if (!authorized && !API_KEY) {
      authorized = true;
    }

    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
  }

  // Status
  if (path === "/api/status" && method === "GET") {
    return json(res, {
      scan:  { running: state.scan.running, progress: state.scan.progress, total: state.scan.total, count: state.scan.results.length, lastRun: state.scan.lastRun, error: state.scan.error, mode: state.scan.mode || 'swing' },
    });
  }

  // Scan
  if (path === "/api/scan/results" && method === "GET") {
    const results = (state.scan.results || []).map(r => {
      const hist = state.score_history[r.sym] || [];
      return { ...r, velocity: computeVelocity(hist), sector: sectorOf(r.sym) };
    });
    return json(res, { scanned_at: state.scan.lastRun, running: state.scan.running, progress: state.scan.progress, total: state.scan.total, mode: state.scan.mode || 'swing', results });
  }
  if (path === "/api/scan/start" && method === "POST") {
    const body = await readBody(req);
    return json(res, startScan(body.symbols || null, body.market || null, body.mode || (body.investMode ? 'position' : 'swing')));
  }

  if (path === "/api/scan/quick" && method === "POST") {
    const body = await readBody(req);
    const market = body.market || state.scan.currentMarket || "tasi";
    const quickList = buildQuickScanList(market);
    if (!quickList) return json(res, { ok: false, message: "No previous scan — run a full scan first" });
    const fullCount = (state.universe[market] || getUniverseByMarket(market)).length;
    return json(res, { ok: true, scanning: quickList.length, full: fullCount,
      ...startScan(quickList, market, state.scan.mode || 'swing', true) });
  }

  // /api/whale/activity removed Phase 4 — whale_score has no edge (tested -8.9%/yr, t=-1.47)

  if (path === "/api/whale/block-deals" && method === "GET") {
    blockDealsCache.ts = 0; // force refresh to include latest manual deals
    const cache = await refreshBlockDeals();
    return json(res, { deals: cache.data, source: cache.source, error: cache.error, ts: cache.ts, frequency: cache.frequency });
  }

  if (path === "/api/whale/block-deals/add" && method === "POST") {
    const body = await readBody(req);
    const code = (body.sym||'').toString().replace(/[^0-9]/g,'');
    if (!code || !body.price || !body.qty)
      return json(res, { ok: false, error: "sym, price and qty are required" }, 400);
    const existing = loadManualDeals();
    const deal = {
      sym:   `TADAWUL:${code}`,
      name:  body.name || (state.universe?.tasi || []).find(s => s.sym === `TADAWUL:${code}`)?.name || code,
      price: parseFloat(body.price),
      qty:   parseInt(body.qty),
      value: parseFloat(body.price) * parseInt(body.qty),
      time:  body.time || new Date().toISOString(),
      note:  body.note || '',
      source: 'Manual',
    };
    existing.unshift(deal);
    saveManualDeals(existing.slice(0, 100)); // keep last 100
    blockDealsCache.ts = 0; // invalidate cache
    return json(res, { ok: true, deal });
  }

  if (path === "/api/whale/block-deals/delete" && method === "POST") {
    const body = await readBody(req);
    // Match by sym + time (manual deals only — Argaam deals are not persisted)
    const deals = loadManualDeals().filter(d =>
      !(d.sym === body.sym && d.time === body.time)
    );
    saveManualDeals(deals);
    blockDealsCache.ts = 0;
    return json(res, { ok: true });
  }

  // Rules — GET
  if (path === "/api/rules" && method === "GET") {
    try {
      const rules = getRules();
      return json(res, {
        bias_criteria: rules.bias_criteria || {},
        risk_rules:    rules.risk_rules    || [],
      });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Rules — PUT (update bias_criteria and/or risk_rules)
  if (path === "/api/rules" && method === "PUT") {
    const body = await readBody(req);
    try {
      updateRules(body);
      return json(res, { ok: true });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Fundamentals
  if (path === "/api/fundamentals" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (!sym) return json(res, { error: "sym param required" }, 400);
    try {
      const data  = await getFundamentals(sym);
      const _symCode = parseInt((sym.split(':')[1] || sym).replace(/\D/g, '')) || 0;
      const sector = (_symCode >= 1010 && _symCode <= 1080) ? "banking" : "general";
      const score = scoreFundamentals(data, sector);
      return json(res, { success: true, data, score });
    } catch (err) { return json(res, { success: false, error: err.message }, 502); }
  }

  // Market regime
  if (path === "/api/regime" && method === "GET") {
    const market = url.searchParams.get("market") || "tasi";
    try {
      const regime = await computeRegime(market);
      return json(res, regime || { error: "Could not compute regime" });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Seasonality (fetches extra bars for the requested symbol)
  if (path === "/api/seasonality" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (!sym) return json(res, { error: "sym required" }, 400);
    try {
      await chartCore.setSymbol({ symbol: sym });
      await new Promise(r => setTimeout(r, 800));
      const ohlcv = await dataCore.getOhlcv({ count: 750 }); // ~3 years
      const bars = ohlcv.bars || [];
      const closes = bars.map(b => b.close);
      const times  = bars.map(b => b.time);
      const monthly = {};
      for (let i = 1; i < closes.length; i++) {
        const m = new Date((times[i] || 0) * 1000).getMonth() + 1;
        if (!monthly[m]) monthly[m] = [];
        monthly[m].push((closes[i] - closes[i-1]) / closes[i-1] * 100);
      }
      const seasonality = {};
      for (const [m, arr] of Object.entries(monthly)) {
        seasonality[m] = { avg: +(arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2), n: arr.length };
      }
      return json(res, { success: true, seasonality, bars: bars.length });
    } catch (err) { return json(res, { success: false, error: err.message }, 500); }
  }

  // Correlation (computes pairwise correlation from returns_20d in scan results)
  if (path === "/api/correlation" && method === "POST") {
    const body = await readBody(req);
    const syms = body.syms || [];
    const rows = syms.map(s => state.scan.results.find(r => r.sym === s)).filter(Boolean);
    if (rows.length < 2) return json(res, { matrix: [], syms: [] });
    const matrix = rows.map(a => rows.map(b => {
      const ra = a.returns_20d, rb = b.returns_20d;
      if (!ra || !rb || ra.length < 2) return null;
      const n = Math.min(ra.length, rb.length);
      const ma = ra.slice(0,n).reduce((s,v)=>s+v,0)/n;
      const mb = rb.slice(0,n).reduce((s,v)=>s+v,0)/n;
      let num=0, da=0, db=0;
      for (let i=0;i<n;i++){num+=(ra[i]-ma)*(rb[i]-mb);da+=(ra[i]-ma)**2;db+=(rb[i]-mb)**2;}
      const denom = Math.sqrt(da*db);
      return denom ? +(num/denom).toFixed(2) : null;
    }));
    return json(res, { matrix, syms: rows.map(r => r.sym), names: rows.map(r => r.name) });
  }

  // Backtest
  if (path === "/api/backtest" && method === "POST") {
    const body = await readBody(req);
    const { sym, minScore = 7, holdBars = 40 } = body;
    if (!sym) return json(res, { error: "sym required" }, 400);
    try {
      const yahooSym = toYahooSym(sym);
      const bars     = await fetchYahooOHLCV(yahooSym, '1d', 2000);
      if (!bars || bars.length < 210) return json(res, { error: `Not enough data for ${sym} (got ${bars?.length ?? 0} bars)` }, 400);
      const result = runBacktest(bars, { minScore: +minScore, holdBars: +holdBars });
      return json(res, { ...result, barCount: bars.length });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  if (path === "/api/backtest/sweep" && method === "POST") {
    const body = await readBody(req);
    const { sym } = body;
    if (!sym) return json(res, { error: "sym required" }, 400);
    try {
      const yahooSym = toYahooSym(sym);
      const bars     = await fetchYahooOHLCV(yahooSym, '1d', 2000);
      if (!bars || bars.length < 210) return json(res, { error: `Not enough data for ${sym}` }, 400);
      const sweep = sweepParams(bars);
      return json(res, { sweep, barCount: bars.length });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  if (path === "/api/backtest/portfolio" && method === "POST") {
    const body = await readBody(req);
    const { market = 'tasi', minScore = 6, holdBars = 40, maxPositions = 5 } = body;
    try {
      const universe = getUniverseByMarket(market).slice(0, 30); // cap at 30 to limit fetch time
      const allTrades = [];
      let fetched = 0;
      for (const entry of universe) {
        const sym = typeof entry === 'object' ? entry.sym : entry;
        try {
          const yahoo = toYahooSym(sym);
          const bars  = await fetchYahooOHLCV(yahoo, '1d', 2000);
          if (!bars || bars.length < 210) continue;
          const ind    = prepareIndicators(bars);
          const trades = simulateTrades(ind, bars, { minScore: +minScore, holdBars: +holdBars });
          trades.forEach(t => allTrades.push({ sym, ...t }));
          fetched++;
          await new Promise(r => setTimeout(r, 150)); // rate-limit Yahoo
        } catch(_) {}
      }
      const result = simulatePortfolio(allTrades, { capital: 100000, maxPositions: +maxPositions });
      return json(res, { ...result, symbolsFetched: fetched, market });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Economic calendar (Finnhub)
  if (path === "/api/calendar" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (!sym) return json(res, { error: "sym required" }, 400);
    const event = await getEarningsCalendar(sym, state.settings?.finnhub_token);
    return json(res, { event });
  }

  // SSE event stream
  if (path === "/api/events" && method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return; // keep connection open
  }

  // Live mode
  if (path === "/api/live/start" && method === "POST") {
    const body = await readBody(req);
    liveInterval = Math.max(1, parseInt(body.interval) || 10);
    if (liveTimer) clearInterval(liveTimer);
    liveTimer = setInterval(() => {
      if (!state.scan.running) startScan(null, state.scan.currentMarket || "tasi", state.scan.mode || 'swing');
    }, liveInterval * 60 * 1000);
    broadcastSSE({ type: "live_started", interval: liveInterval });
    return json(res, { ok: true, interval: liveInterval });
  }
  if (path === "/api/live/stop" && method === "POST") {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
    broadcastSSE({ type: "live_stopped" });
    return json(res, { ok: true });
  }
  if (path === "/api/live/status" && method === "GET") {
    return json(res, { active: !!liveTimer, interval: liveInterval });
  }

  // Settings
  if (path === "/api/settings" && method === "GET") { return json(res, state.settings); }
  if (path === "/api/settings" && method === "PUT") {
    const body = await readBody(req);
    try {
      state.settings = { ...state.settings, ...body };
      writeFileSync(SETTINGS_PATH, JSON.stringify(state.settings, null, 2));
      return json(res, { ok: true });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Positions
  if (path === "/api/positions" && method === "GET") { return json(res, state.positions); }
  if (path === "/api/positions" && method === "PUT") {
    const body = await readBody(req);
    try {
      state.positions = body;
      dbPositions.setAll(state.positions);
      return json(res, { ok: true });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Telegram test
  if (path === "/api/notify/test" && method === "POST") {
    const tg = state.settings?.telegram;
    if (!tg?.token || !tg?.chat_id) return json(res, { ok: false, error: "Token and chat_id required" }, 400);
    const r = await sendTelegram(tg.token, tg.chat_id, "✅ <b>Mawjah</b> — Notifications connected!");
    return json(res, r);
  }

  // Live quote (sets chart to sym, reads quote)
  if (path === "/api/quote" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (!sym) return json(res, { error: "sym required" }, 400);
    try {
      await chartCore.setSymbol({ symbol: sym });
      await new Promise(r => setTimeout(r, 800));
      const q = await dataCore.getQuote({});
      return json(res, q);
    } catch (err) { return json(res, { success: false, error: err.message }, 502); }
  }

  // OHLCV for native chart (1 year daily by default)
  if (path === "/api/ohlcv" && method === "GET") {
    const sym   = url.searchParams.get("sym");
    const count = Math.min(parseInt(url.searchParams.get("count") || "252"), 500);
    if (!sym) return json(res, { error: "sym required" }, 400);
    const yahooSym = toYahooSym(sym);
    if (!yahooSym) return json(res, { error: "unknown symbol" }, 400);
    try {
      const bars = await fetchYahooOHLCV(yahooSym, '1d', count);
      return json(res, { success: true, sym, bars });
    } catch(err) {
      return json(res, { success: false, error: err.message }, 500);
    }
  }

  // Chart screenshot
  if (path === "/api/chart/screenshot" && method === "POST") {
    const body = await readBody(req);
    try {
      if (body.sym) {
        await chartCore.setSymbol({ symbol: body.sym });
        await new Promise(r => setTimeout(r, 1500));
      }
      const filename = `chart-${Date.now()}.jpg`;
      await captureScreenshot(filename);
      return json(res, { success: true, url: `/screenshots/${filename}` });
    } catch (err) { return json(res, { success: false, error: err.message }, 500); }
  }

  // Serve dashboard static assets (css/js split out of index.html)
  if (path.startsWith("/assets/") && method === "GET") {
    const filename = path.slice("/assets/".length).replace(/[^a-zA-Z0-9._-]/g, ""); // strip path-traversal
    const ext = filename.slice(filename.lastIndexOf("."));
    const TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
    if (!TYPES[ext]) { res.writeHead(404); return res.end("Not found"); }
    const fp = join(__dirname, "assets", filename);
    if (!existsSync(fp)) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": TYPES[ext], "Cache-Control": "no-cache" });
    return res.end(readFileSync(fp));
  }

  // Serve screenshot files
  if (path.startsWith("/screenshots/") && method === "GET") {
    const filename = path.slice("/screenshots/".length).replace(/[^a-zA-Z0-9._-]/g, "");
    const fp = join(SCREENSHOTS_DIR, filename);
    if (existsSync(fp)) {
      res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=3600" });
      return res.end(readFileSync(fp));
    }
    res.writeHead(404); return res.end("Not found");
  }

  // Scan delta
  if (path === "/api/scan/delta" && method === "GET") {
    return json(res, { delta: state.scan.delta || [], lastRun: state.scan.lastRun });
  }

  // Pre-signal: stocks approaching a BUY or SELL signal
  if (path === "/api/scan/presignal" && method === "GET") {
    const results = state.scan.results || [];

    // ── Helpers ────────────────────────────────────────────────────────────────
    // Linear regression slope over score history (positive = improving)
    function histSlope(hist) {
      if (hist.length < 2) return 0;
      const n = hist.length, mx = (n-1)/2;
      const my = hist.reduce((a,b) => a+b.s, 0) / n;
      let num = 0, den = 0;
      hist.forEach(({s}, x) => { num += (x-mx)*(s-my); den += (x-mx)**2; });
      return den === 0 ? 0 : +(num/den).toFixed(2);
    }

    // Consecutive scans with a flag true (most recent first)
    function accumDuration(sym, field) {
      const hist = (state.score_history[sym] || []).slice().reverse();
      let n = 0;
      for (const h of hist) { if (h[field]) n++; else break; }
      return n;
    }

    // Confidence score 0–10 for ranking within a category
    function confidence(r, approaching, slope) {
      let c = 0;
      if (approaching === 'BUY' || approaching === 'EXIT_RISK') {
        c += Math.max(0, 2 - (r.proximity?.pts_to_buy || 2)) * 2;
      } else if (approaching === 'SELL') {
        c += Math.max(0, 2 - (r.proximity?.pts_to_sell || 2)) * 2;
      }
      c += Math.min(3, Math.max(0, Math.abs(slope) * 2));
      if (r.vol_compression?.is_compressed) c += 1;
      if (r.rsi_buildup?.is_building)       c += 1;
      // whale_score removed from conviction — validated as noise (showdown t=-1.47, -8.9%/yr)
      if ((approaching === 'BUY' || approaching === 'ACCUMULATION') && r.market_regime === 'bull') c += 1;
      return Math.min(10, Math.round(c));
    }

    // Is this sym held in real or virtual portfolio?
    function isHeld(sym) {
      return !!(state.positions?.[sym] || state.virtual?.positions?.[sym]);
    }

    // Plain-language description of what to watch for
    function watchFor(approaching, r, slope, vcDur, rbDur) {
      if (approaching === 'BUY') {
        const pts = r.proximity?.pts_to_buy || 0;
        return `${pts} point${pts!==1?'s':''} from BUY — watch for ${r.proximity?.emaStack < 0 ? 'EMA 13 crossing above EMA 34' : 'volume surge above 1.5×'} to confirm`;
      }
      if (approaching === 'SELL') {
        return `${r.proximity?.pts_to_sell || 0} pts from SELL — watch for MACD turning negative and RSI breaking below 48`;
      }
      if (approaching === 'RECOVERY') {
        return `Bear score shrinking — watch for MACD histogram crossing zero as confirmation of reversal`;
      }
      if (approaching === 'EXIT_RISK') {
        return `Score declining ${Math.abs(slope).toFixed(1)} pts/scan — consider reducing if RSI drops below 50 or MACD turns negative`;
      }
      if (approaching === 'ACCUMULATION') {
        const parts = [];
        if (r.vol_compression?.is_compressed) parts.push(`coiling ${vcDur} scan${vcDur!==1?'s':''}`);
        if (r.rsi_buildup?.is_building)       parts.push(`RSI building ${rbDur} scan${rbDur!==1?'s':''}`);
        return `${parts.join(' · ')} — watch for volume spike above 2× average as breakout trigger`;
      }
      return '';
    }

    const presignal = [];

    for (const r of results) {
      if (!r.proximity && !r.vol_compression && !r.rsi_buildup) continue;
      const hist = (state.score_history[r.sym] || []).slice(-7);
      const slope = histSlope(hist);
      const held  = isHeld(r.sym);
      const vcDur = accumDuration(r.sym, 'vc');
      const rbDur = accumDuration(r.sym, 'rb');

      // ── EXIT RISK: bullish stock whose score is declining ─────────────────
      if (held && ['STRONG BUY','BUY','WATCH'].includes(r.bias) && slope < -0.3 && hist.length >= 3) {
        const last3 = hist.slice(-3);
        const decliningTwice = last3[2].s < last3[1].s && last3[1].s < last3[0].s;
        const rsiWeakening   = r.rsi != null && r.rsi < 60;
        if (decliningTwice || (slope < -0.5 && rsiWeakening)) {
          presignal.push({
            sym: r.sym, name: r.name, ar: r.ar||null, bias: r.bias, score: r.score, maxScore: r.maxScore || 8,
            approaching: 'EXIT_RISK', trend: slope, history: hist,
            rsi: r.rsi, macd_hist: r.macd_hist, whale_score: r.whale_score,
            proximity: r.proximity, held: true,
            confidence: confidence(r, 'EXIT_RISK', slope),
            watch_for: watchFor('EXIT_RISK', r, slope, vcDur, rbDur),
            accum_duration: 0,
          });
          continue;
        }
      }

      // ── APPROACHING BUY ───────────────────────────────────────────────────
      // WATCH or SKIP (score ≥ 3) — not AVOID which is bearish territory
      if (['WATCH','SKIP'].includes(r.bias) && r.score >= 3 &&
          r.proximity?.pts_to_buy <= 2 && slope >= 0 && r.proximity?.emaStack > -2) {
        presignal.push({
          sym: r.sym, name: r.name, ar: r.ar||null, bias: r.bias, score: r.score, maxScore: r.maxScore || 8,
          approaching: 'BUY', trend: slope, history: hist,
          rsi: r.rsi, macd_hist: r.macd_hist, whale_score: r.whale_score,
          proximity: r.proximity, held,
          vol_compression: r.vol_compression || null, rsi_buildup: r.rsi_buildup || null,
          confidence: confidence(r, 'BUY', slope),
          watch_for: watchFor('BUY', r, slope, vcDur, rbDur),
          accum_duration: Math.max(vcDur, rbDur),
        });
        continue;
      }

      // ── APPROACHING SELL ──────────────────────────────────────────────────
      if (['WATCH','SKIP'].includes(r.bias) &&
          r.proximity?.pts_to_sell <= 2 && slope <= 0 && r.proximity?.emaStack < 2) {
        presignal.push({
          sym: r.sym, name: r.name, ar: r.ar||null, bias: r.bias, score: r.score, maxScore: r.maxScore || 8,
          approaching: 'SELL', trend: slope, history: hist,
          rsi: r.rsi, macd_hist: r.macd_hist, whale_score: r.whale_score,
          proximity: r.proximity, held,
          confidence: confidence(r, 'SELL', slope),
          watch_for: watchFor('SELL', r, slope, vcDur, rbDur),
          accum_duration: 0,
        });
        continue;
      }

      // ── RECOVERY (bearish stock with shrinking bear score) ─────────────────
      if (['STRONG SELL','SELL','AVOID'].includes(r.bias) && hist.length >= 2 &&
          slope < 0 && r.proximity?.macd != null) {
        // MACD normalised to price — threshold 0.05% of price
        const macdThresh = -(r.price || 10) * 0.0005;
        if (r.proximity.macd > macdThresh) {
          presignal.push({
            sym: r.sym, name: r.name, ar: r.ar||null, bias: r.bias, score: r.score, maxScore: r.maxScore || 8,
            approaching: 'RECOVERY', trend: slope, history: hist,
            rsi: r.rsi, macd_hist: r.macd_hist, whale_score: r.whale_score,
            proximity: r.proximity, held,
            confidence: confidence(r, 'RECOVERY', slope),
            watch_for: watchFor('RECOVERY', r, slope, vcDur, rbDur),
            accum_duration: 0,
          });
          continue;
        }
      }

      // ── ACCUMULATION (compression or RSI buildup, not already captured) ───
      if (r.vol_compression?.is_compressed || r.rsi_buildup?.is_building) {
        // Normalise duration threshold: only show if building for ≥2 scans
        if (vcDur >= 2 || rbDur >= 2) {
          presignal.push({
            sym: r.sym, name: r.name, ar: r.ar||null, bias: r.bias, score: r.score, maxScore: r.maxScore || 8,
            approaching: 'ACCUMULATION', trend: slope, history: hist,
            rsi: r.rsi, macd_hist: r.macd_hist, whale_score: r.whale_score,
            proximity: r.proximity || null, held,
            vol_compression: r.vol_compression || null, rsi_buildup: r.rsi_buildup || null,
            confidence: confidence(r, 'ACCUMULATION', slope),
            watch_for: watchFor('ACCUMULATION', r, slope, vcDur, rbDur),
            accum_duration: Math.max(vcDur, rbDur),
          });
        }
      }
    }

    // Sort: EXIT_RISK first (most urgent), then by category order, then by confidence desc
    const order = { EXIT_RISK:0, BUY:1, RECOVERY:2, ACCUMULATION:3, SELL:4 };
    presignal.sort((a, b) => {
      const catDiff = (order[a.approaching]??5) - (order[b.approaching]??5);
      if (catDiff !== 0) return catDiff;
      return b.confidence - a.confidence; // higher confidence first within category
    });

    return json(res, { presignal, lastRun: state.scan.lastRun, count: presignal.length });
  }

  // Alert creation
  if (path === "/api/alert/create" && method === "POST") {
    const body = await readBody(req);
    try {
      if (body.sym) {
        await chartCore.setSymbol({ symbol: body.sym });
        await new Promise(r => setTimeout(r, 800));
      }
      const result = await createAlert({
        condition: body.condition || "crossing",
        price: body.price,
        message: body.message || `${tickerDisplay(body.sym || "")} @ ${body.price}`,
      });
      return json(res, result);
    } catch (err) { return json(res, { success: false, error: err.message }, 500); }
  }

  // Universe — GET all
  if (path === "/api/universe" && method === "GET") {
    return json(res, state.universe);
  }

  // Universe — PUT (save one market's list)
  if (path === "/api/universe" && method === "PUT") {
    const body = await readBody(req);
    try {
      if (body.market && Array.isArray(body.symbols)) {
        state.universe[body.market] = body.symbols;
        writeFileSync(UNIVERSE_PATH, JSON.stringify(state.universe, null, 2));
        return json(res, { ok: true, count: body.symbols.length });
      }
      return json(res, { error: "market and symbols required" }, 400);
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Universe — reset one market to built-in defaults
  if (path === "/api/universe/reset" && method === "POST") {
    const body = await readBody(req);
    const mkt = body.market;
    if (mkt && DEFAULT_UNIVERSE[mkt]) {
      state.universe[mkt] = DEFAULT_UNIVERSE[mkt];
      writeFileSync(UNIVERSE_PATH, JSON.stringify(state.universe, null, 2));
      return json(res, { ok: true, count: DEFAULT_UNIVERSE[mkt].length });
    }
    return json(res, { error: "Unknown market" }, 400);
  }

  // Score history
  if (path === "/api/score-history" && method === "GET") {
    return json(res, state.score_history);
  }

  // Finnhub News
  if (path === "/api/news" && method === "GET") {
    const sym = url.searchParams.get("sym");
    const token = state.settings?.finnhub_token;
    if (!sym || !token) return json(res, { articles: [] });
    const fSym = toFinnhubSym(sym);
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - 7*864e5).toISOString().split("T")[0];
    try {
      const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${fSym}&from=${from}&to=${to}&token=${token}`);
      const d = await r.json();
      return json(res, { articles: Array.isArray(d) ? d.slice(0,6) : [] });
    } catch (e) { return json(res, { articles: [], error: e.message }); }
  }

  // Finnhub Dividends
  if (path === "/api/dividends" && method === "GET") {
    const sym = url.searchParams.get("sym");
    const token = state.settings?.finnhub_token;
    if (!sym || !token) return json(res, { dividends: [] });
    const fSym = toFinnhubSym(sym);
    try {
      const r = await fetch(`https://finnhub.io/api/v1/stock/dividend2?symbol=${fSym}&token=${token}`);
      const d = await r.json();
      return json(res, { dividends: d?.data?.slice(0,4) || [] });
    } catch (e) { return json(res, { dividends: [], error: e.message }); }
  }

  // Open symbol on TradingView chart
  if (path === "/api/tv/open-symbol" && method === "POST") {
    const body = await readBody(req);
    if (!body.sym) return json(res, { error: "sym required" }, 400);
    try { await chartCore.setSymbol({ symbol: body.sym }); return json(res, { ok: true }); }
    catch (e) { return json(res, { ok: false, error: e.message }); }
  }

  // Multi-timeframe alignment (4H + D + W)
  if (path === "/api/tf-align" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (!sym) return json(res, { error: "sym required" }, 400);
    const result = {};
    const calcTF = (bars) => {
      if (!bars || bars.length < 20) return null;
      const c = bars.map(b => b.close);
      const e13 = emaArray(c,13), e34 = emaArray(c,34), e89 = emaArray(c,89), e200 = emaArray(c,200);
      const rv = rsiSeries(c,14);
      return { ema_stack: e13[e13.length-1] > e34[e34.length-1] && e34[e34.length-1] > e89[e89.length-1], above_200: e200.length ? c[c.length-1] > e200[e200.length-1] : null, rsi: +(rv[rv.length-1]||50).toFixed(1) };
    };
    try {
      await chartCore.setSymbol({ symbol: sym });
      await new Promise(r => setTimeout(r, 700));
      for (const tf of ["240","D","W"]) {
        try {
          await chartCore.setTimeframe({ timeframe: tf });
          await new Promise(r => setTimeout(r, 600));
          const bars = (await dataCore.getOhlcv({ count: 150 })).bars || [];
          result[tf === "240" ? "h4" : tf === "D" ? "d" : "w"] = calcTF(bars);
        } catch (_) {}
      }
      // Restore daily
      try { await chartCore.setTimeframe({ timeframe: "D" }); } catch (_) {}
      return json(res, { success: true, sym, ...result });
    } catch (e) { return json(res, { error: e.message }); }
  }

  // Smart Alert Rules
  if (path === "/api/alert-rules" && method === "GET") { return json(res, state.alert_rules); }

  if (path === "/api/alert-rules" && method === "POST") {
    const body = await readBody(req);
    if (!body.sym || !body.field || !body.op) return json(res, { error: "sym, field, op required" }, 400);
    const rule = { id: Date.now().toString(), ...body, lastTriggered: null };
    state.alert_rules.push(rule);
    dbAlertRules.upsert(rule);
    return json(res, { ok: true, rule });
  }

  if (path.startsWith("/api/alert-rules/") && method === "DELETE") {
    const id = path.split("/").pop();
    state.alert_rules = state.alert_rules.filter(r => r.id !== id);
    dbAlertRules.delete(id);
    return json(res, { ok: true });
  }

  // Global Markets Overview
  if (path === "/api/markets/overview" && method === "GET") {
    const force = url.searchParams.get("force") === "1";
    if (!force && overviewCache.data && Date.now() - overviewCache.ts < OVERVIEW_TTL) {
      return json(res, { success: true, data: overviewCache.data, cached: true, ts: overviewCache.ts });
    }
    try {
      const results = [];
      for (const meta of OVERVIEW_SYMBOLS) {
        try {
          const m = await getSymbolMetrics(meta);
          results.push(m ? { ...m, ...meta } : { ...meta, error: "No data" });
        } catch (e) { results.push({ ...meta, error: e.message }); }
      }
      overviewCache = { data: results, ts: Date.now() };
      return json(res, { success: true, data: results, cached: false, ts: overviewCache.ts });
    } catch (err) { return json(res, { error: err.message }, 500); }
  }

  // Virtual Portfolio
  if (path === "/api/virtual" && method === "GET") {
    return json(res, state.virtual);
  }

  if (path === "/api/virtual/buy" && method === "POST") {
    const body = await readBody(req);
    const { sym, name, shares, price } = body;
    if (!sym || !shares || !price) return json(res, { error: "sym, shares, price required" }, 400);
    const result = dbVirtual.buy({ sym, name, shares, price });
    if (result.error) return json(res, { error: result.error }, 400);
    state.virtual = dbVirtual.get();
    return json(res, { ok: true, virtual: state.virtual });
  }

  if (path === "/api/virtual/sell" && method === "POST") {
    const body = await readBody(req);
    const { sym, shares, price } = body;
    if (!sym || !shares || !price) return json(res, { error: "sym, shares, price required" }, 400);
    const result = dbVirtual.sell({ sym, shares, price });
    if (result.error) return json(res, { error: result.error }, 400);
    state.virtual = dbVirtual.get();
    return json(res, { ok: true, virtual: state.virtual });
  }

  if (path === "/api/virtual/reset" && method === "POST") {
    const body = await readBody(req);
    const balance = parseFloat(body.balance) || 100000;
    dbVirtual.reset(balance);
    state.virtual = dbVirtual.get();
    return json(res, { ok: true, virtual: state.virtual });
  }

  // Sharia compliance
  if (path === "/api/sharia" && method === "GET") {
    const sym = url.searchParams.get("sym");
    if (sym) return json(res, getShariaStatus(sym));
    return json(res, getAllStatuses());
  }

  // Macro calendar
  if (path === "/api/macro/events" && method === "GET") {
    const days = parseInt(url.searchParams.get("days") || "21");
    return json(res, { events: getUpcomingEvents(days) });
  }

  // /api/opportunities (+ /refresh) removed Phase 4 — score-derived ranking; 9-pt score has no edge (t=0.74).
  // detectAndStoreSignals kept (scan-pipeline detector); dbOppSignals/SIGNAL_DEFS kept (used elsewhere).

  // ── Strategy Validation ──────────────────────────────────────────────────────
  if (path === '/api/strategy-validation' && method === 'GET') {
    await refreshAllMilestones();
    const tracks = dbTracked.getAll();
    const allMs  = dbMilestones.getAllForTracks(tracks.map(t => t.id));
    const msMap  = {};
    allMs.forEach(m => { if (!msMap[m.track_id]) msMap[m.track_id] = {}; msMap[m.track_id][m.checkpoint] = m; });
    return json(res, { tracks: tracks.map(t => ({ ...t, milestones: msMap[t.id] || {} })) });
  }

  if (path === '/api/strategy-validation/track' && method === 'POST') {
    const body  = await readBody(req);
    const { sym, name, signal_type, conviction, entry_price, stop, target1, target2, atr_pct,
            rsi, mfi, whale_score, vol_ratio, obv_trend, divergence, weekly_trend,
            market_regime, score, max_score, rs_score, signals_json } = body;
    if (!sym || !entry_price) return json(res, { error: 'sym and entry_price required' }, 400);
    const now    = new Date().toISOString();
    const cap    = 20000;
    const shares = entry_price > 0 ? +(cap / entry_price).toFixed(2) : 0;
    const id     = dbTracked.insert({ sym, name, signal_type, conviction, tracked_at: now,
      entry_price, simulated_capital: cap, shares, stop, target1, target2, atr_pct,
      rsi, mfi, whale_score, vol_ratio, obv_trend, divergence, weekly_trend, market_regime,
      score, max_score, rs_score, signals_json });
    for (const [cp, days] of Object.entries(MILESTONE_DAYS)) {
      const tDate = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
      dbMilestones.insert({ track_id: id, checkpoint: cp, target_date: tDate });
    }
    return json(res, { ok: true, id });
  }

  if (path === '/api/strategy-validation/insights' && method === 'GET') {
    return json(res, computeInsights());
  }

  if (path.startsWith('/api/strategy-validation/') && method === 'POST') {
    const parts = path.split('/');
    const id    = parseInt(parts[3]);
    const action = parts[4];
    const track = dbTracked.get(id);
    if (!track) return json(res, { error: 'not found' }, 404);

    if (action === 'note') {
      const { note } = await readBody(req);
      dbTracked.addNote(id, note);
      return json(res, { ok: true });
    }
    if (action === 'close') {
      const { reason, exit_price } = await readBody(req);
      dbTracked.close(id, reason || 'manual', exit_price ?? null);
      return json(res, { ok: true });
    }
    if (action === 'refresh') {
      await updateMilestonesForTrack(track);
      const ms = dbMilestones.getAll(id);
      return json(res, { ok: true, milestones: ms });
    }
  }

  if (path.startsWith('/api/strategy-validation/') && method === 'DELETE') {
    const id = parseInt(path.split('/')[3]);
    dbTracked.delete(id);
    return json(res, { ok: true });
  }

  // Auto-scan status
  if (path === "/api/auto-scan/status" && method === "GET") {
    const next = getNextAutoScanSlot();
    return json(res, {
      log: autoScanLog,
      schedule: AUTO_SCAN_TIMES,
      next: next ? { slot: next.slot, h: next.h, m: next.m, msUntil: next.msUntil ?? null, daysAhead: next.daysAhead ?? 0 } : null,
    });
  }

  // ── Goals & Objectives ───────────────────────────────────────────────────────
  if (path === '/api/goals/profile' && method === 'GET') {
    try { return json(res, { profile: goalsProfile.get() }); }
    catch(e) { return json(res, { error: e.message, profile: {} }, 500); }
  }

  if (path === '/api/goals/profile' && method === 'PUT') {
    try {
      const body = await readBody(req);
      goalsProfile.save(body);
      return json(res, { ok: true, profile: goalsProfile.get() });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── Multi-asset allocation policy ────────────────────────────────────────────
  // Validated: 50/30/20 quarterly improved Sharpe 0.60→1.05, maxDD −19.5%→−13%,
  // +1.0%/yr rebalance premium (~5y, 2020–2026). See
  // docs/research/2026-06-22-multi-asset-allocation.md.
  if (path === '/api/allocation' && method === 'GET') {
    try {
      const policy = allocationPolicy.get();
      return json(res, {
        policy,
        sleeves: SLEEVES,
        rebalance: computeRebalance({ values: policy.values, weights: policy.weights }),
        validated: {
          sharpe: '1.05 vs 0.60',
          maxDD: '−13% vs −19.5%',
          rebalancePremium: '+1.0%/yr',
          window: '~5y, 2020–2026',
        },
      });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path === '/api/allocation' && method === 'PUT') {
    try {
      const body = await readBody(req);
      const patch = {};
      if (body && body.weights !== undefined) patch.weights = normalizeWeights(body.weights);
      if (body && body.values  !== undefined) patch.values  = body.values;
      if (body && body.cadence !== undefined) patch.cadence = body.cadence;
      const policy = allocationPolicy.set(patch);
      return json(res, {
        policy,
        sleeves: SLEEVES,
        rebalance: computeRebalance({ values: policy.values, weights: policy.weights }),
        validated: {
          sharpe: '1.05 vs 0.60',
          maxDD: '−13% vs −19.5%',
          rebalancePremium: '+1.0%/yr',
          window: '~5y, 2020–2026',
        },
      });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path === '/api/goals/suggested' && method === 'GET') {
    try {
    const profile = goalsProfile.get();
    const SHARIA_MAP = getAllStatuses();

    // Real open positions — used for slot count and scale-in detection.
    const realPositions = state.positions || {};
    const openSyms = new Set(Object.keys(realPositions).filter(k => !k.startsWith('_')));
    const openCount = openSyms.size;
    const maxPos = profile.max_open_positions || 5;
    const slotsLeft = Math.max(0, maxPos - openCount);

    // Suggested positions are drawn from the ONE validated edge: the 6-month
    // momentum × 52-week-high rank combo (gate t 3.38, OOS 9/9 positive years).
    // The old 9-pt score ranker had no edge (~37% win rate) — retired here so
    // "Enter Now" means the actual momentum buy-list, not a noise signal.
    const mom = await getMomentumScreen({ heldSyms: [...openSyms] });
    if (!mom.success) {
      return json(res, { suggested: [], reason: mom.error || 'Momentum screen unavailable',
        note: 'Bars cache may be cold — run: node scripts/bars_cache.mjs warm' });
    }

    // Enrich each momentum holding with live scan context (ATR for stop/target
    // geometry, style tags, indicator notes) when the symbol is in the last scan.
    const scanMap = {};
    for (const s of (state.scan.results || [])) scanMap[s.sym] = s;

    const suggested = (mom.holdings || []).slice(0, 9).map(h => {
      const sc = scanMap[h.sym] || {};
      const price = h.price;
      const alreadyHeld = openSyms.has(h.sym);
      // Momentum holdings ARE the buy-list — every name is an "enter" (held →
      // scale_in for the remaining half). No score-based watch/monitor tiers.
      const tier = alreadyHeld ? 'scale_in' : 'enter';
      const tierRiskMult = alreadyHeld ? 0.5 : 1.0;

      // Stop/target geometry: prefer ATR from the scan; fall back to a fixed %
      // envelope (≈2:1 reward:risk) when ATR isn't available for this name.
      const atr = sc.atr || null;
      const stop = atr ? price - 1.5 * atr : +(price * 0.97).toFixed(2);
      const t1   = atr ? price + 1.5 * atr : +(price * 1.045).toFixed(2);
      const t2   = atr ? price + 3.0 * atr : +(price * 1.09).toFixed(2);

      const riskAmt = profile.capital_sar * (profile.risk_per_trade_pct / 100) * tierRiskMult;
      const shares  = stop && price > stop ? Math.floor(riskAmt / (price - stop)) : null;
      const positionValue = shares ? shares * price : null;
      const t2Gain  = shares && t2 ? Math.round(shares * (t2 - price)) : null;
      const t2Pct   = t2Gain && profile.capital_sar ? +(t2Gain / profile.capital_sar * 100).toFixed(1) : null;
      const targetGain = profile.capital_sar * (profile.target_return_pct / 100);
      const contributionPct = t2Gain && targetGain ? +(t2Gain / targetGain * 100).toFixed(1) : null;

      // Why this name is on the buy-list — momentum-specific, not the 9-pt score.
      const wk52Txt = h.wk52 != null ? `, trading at ${h.wk52}% of its 52-week high` : '';
      const why = `6-month momentum +${h.mom6}%${wk52Txt} — rank #${h.rank} in the validated momentum × 52-week-high combo (the one tested edge). ${alreadyHeld ? 'Already held; signal still in the top quintile.' : 'Buy at the next monthly rebalance.'}`;

      return {
        sym: h.sym, name: h.name, ar: sc.ar,
        // bias drives the trend-state badge; momentum names are uptrends by construction.
        bias: sc.bias || 'STRONG BUY', score: sc.score ?? null, maxScore: sc.maxScore || 9,
        mom6: h.mom6, wk52: h.wk52, momRank: h.rank,
        style_tags: sc.style_tags || ['Momentum'], price,
        stop, t1, t2, shares, positionValue,
        t2Gain, t2Pct, contributionPct,
        rsi: sc.rsi, atr, atr_pct_rank: sc.atr_pct_rank, hurst: sc.hurst,
        above_vwap: sc.above_vwap, weekly: sc.weekly,
        sharia: SHARIA_MAP[h.sym] || (h.sharia ? { status: 'compliant', basis: h.sharia } : null),
        why, primaryStyle: (sc.style_tags || [])[0] || 'Momentum',
        tier, tierRiskMult, alreadyHeld,
      };
    });

    return json(res, { suggested, profile,
      total_candidates: mom.universe?.liquid || (mom.holdings || []).length,
      ranker: 'momentum-combo', asOf: mom.asOf, nextRebalance: mom.nextRebalance,
      open_positions: openCount, slots_left: slotsLeft });
    } catch(e) { return json(res, { error: e.message, suggested: [] }, 500); }
  }

  // ── Accuracy Lab ─────────────────────────────────────────────────────────────
  if (path === '/api/lab/signals' && method === 'GET') {
    try {
      const limit   = parseInt(url.searchParams.get('limit') || '200');
      const outcomeQ = url.searchParams.get('outcome') || null;
      const active  = accuracyLab.getActive();
      const completed = accuracyLab.getAll({ limit, outcome: outcomeQ || undefined });
      const stats   = accuracyLab.getStats();
      const insights = accuracyLab.getInsights();
      return json(res, { active, completed, stats, insights });
    } catch(e) { return json(res, { error: e.message, active: [], completed: [], stats: {}, insights: [] }, 500); }
  }

  if (path === '/api/lab/signal' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { sym, name, price_entry, price_stop, price_t1, price_t2, bias, notes } = body;
      if (!sym || !price_entry) return json(res, { error: 'sym and price_entry required' }, 400);
      const r = state.scan.results?.find(x => x.sym === sym);
      const id = accuracyLab.log({
        sym, name: name || r?.name || sym,
        price_entry, price_stop, price_t1, price_t2, bias: bias || r?.bias,
        score: r?.score, max_score: r?.maxScore,
        composite: r?.composite, scan_mode: state.scan.mode || 'swing',
        style_tags: r?.style_tags || [], market: sym.startsWith('TADAWUL:') ? 'tasi' : 'us',
        hurst: r?.hurst, atr_rank: r?.atr_pct_rank,
        rsi_entry: r?.rsi, vol_ratio_entry: r?.vol_ratio,
      });
      return json(res, { ok: true, id });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path.startsWith('/api/lab/signal/') && method === 'PATCH') {
    try {
      const id = parseInt(path.split('/')[4]);
      const body = await readBody(req);
      const { outcome, price_outcome, r_multiple } = body;
      accuracyLab.updateOutcome(id, { outcome, price_outcome, r_multiple });
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path.startsWith('/api/lab/signal/') && method === 'DELETE') {
    try {
      const id = parseInt(path.split('/')[4]);
      accuracyLab.delete(id);
      return json(res, { ok: true });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── Lab win-rate breakdown by market × style category ─────────────────────
  if (path === '/api/lab/win-rates' && method === 'GET') {
    try {
      const categories = accuracyLab.winRateByCategory();
      const stats      = accuracyLab.getStats();
      return json(res, { categories, stats, ok: true });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // Validation spine: honest edge metric — forward EXCESS vs equal-weight basket, net cost.
  // Headline horizon is 20 sessions (where the backtested edge lives); 5/10 also returned.
  if (path === '/api/lab/validation' && method === 'GET') {
    try {
      const horizons = {};
      for (const h of VAL_HORIZONS) horizons[h] = getValidationStats({ horizon: h });
      return json(res, { ok: true, headline_horizon: 20, horizons });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // Momentum screen: the validated AVENUE 4 monthly buy-list (Sharia-compliant, liquid,
  // ≥2y-listed, top-quintile 6-1 momentum). Returns current picks, not a backtest.
  if (path === '/api/lab/momentum' && method === 'GET') {
    try {
      return json(res, await getMomentumScreen({ heldSyms: Object.keys(state.positions || {}) }));
    } catch(e) { return json(res, { success: false, error: e.message }, 500); }
  }

  // Conditioned-PEAD satellite: EXPERIMENTAL event-driven open-window screen (Q5 earnings
  // reaction ∩ momentum-aligned ∩ volume-confirmed). Returns names whose [+2,+22] drift
  // window is still open. Orthogonal to momentum; size ~10% of risk budget.
  if (path === '/api/lab/pead' && method === 'GET') {
    try { return json(res, await getPeadScreen({ heldSyms: Object.keys(state.positions || {}) })); }
    catch (e) { return json(res, { success: false, error: e.message }, 500); }
  }

  // ── Real fill ledger ──────────────────────────────────────────────────────
  // The actual Derayah book: log buys/sells, project into positions, accrue P&L.
  // MTM uses the latest scan price for each open name (no extra fetch).
  if (path === '/api/fills' && method === 'GET') {
    try {
      const book = realFills.book();
      const scanMap = new Map((state.scan.results || []).map(r => [r.sym, r.price]));
      const priceMap = {};
      for (const p of book.open) { const px = scanMap.get(p.sym); if (px != null) priceMap[p.sym] = px; }
      return json(res, {
        ledger: realFills.getAll(),
        open: book.open,
        realized: book.realized,
        realizedBySym: book.realizedBySym,
        summary: summarizeFills(book, priceMap),
        prices: priceMap,
      });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path === '/api/fills' && method === 'POST') {
    try {
      const body = await readBody(req);
      const r = realFills.log({
        sym: body?.sym, name: body?.name, action: body?.action,
        shares: +body?.shares, price: +body?.price, fees: +(body?.fees || 0),
        date: body?.date, note: body?.note,
      });
      if (r.error) return json(res, { error: r.error }, 400);
      state.positions = dbPositions.getAll();   // keep in-memory book in sync
      return json(res, r);
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  if (path.startsWith('/api/fills/') && method === 'DELETE') {
    try {
      const id = parseInt(path.split('/')[3]);
      const r = realFills.remove(id);
      state.positions = dbPositions.getAll();
      return json(res, { ok: true, ...r });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── Plan vs Actual: the saved decision snapshot vs the live fill book ───────
  if (path === '/api/tracking' && method === 'GET') {
    try {
      const snapshot = decisionSnapshots.getLatest();
      const comparison = snapshot ? compareToSnapshot(snapshot, realFills.book()) : null;
      return json(res, { snapshot, comparison });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // Capture this month's momentum plan as the tracking snapshot (one per period).
  // Server-authoritative: recomputes the screen so the saved plan is the real edge.
  if (path === '/api/decision/snapshot' && method === 'POST') {
    try {
      const body = await readBody(req).catch(() => ({}));
      const account = +(body?.account) || 100000;
      const heldSyms = Object.keys(state.positions || {});
      const screen = await getMomentumScreen({ heldSyms });
      if (!screen.success) return json(res, { error: screen.error || 'Momentum screen unavailable' }, 502);
      const exposurePct = screen.sizing?.breakdown?.finalExposurePct ?? 0;
      const sar = sarPerName({ accountSize: account, exposurePct, nHoldings: screen.holdings.length });
      const snap = buildSnapshot({ screen, account, perNameSAR: sar.perName });
      const saved = decisionSnapshots.save(snap);
      return json(res, { saved, snapshot: snap, comparison: compareToSnapshot(snap, realFills.book()) });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // Block-deal signal: validated "follow big premium trades, ~1mo hold" watch-list.
  if (path === '/api/lab/blockdeals' && method === 'GET') {
    try {
      return json(res, await getBlockDealSignal());
    } catch(e) { return json(res, { success: false, error: e.message }, 500); }
  }

  // Strategy validation — graded per rebalance period (the cross-clustering-robust unit).
  if (path === '/api/lab/strategy' && method === 'GET') {
    try {
      return json(res, await getStrategyValidation());
    } catch(e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  // Manual promotion (user-confirmed up-transition). Re-checks the gate server-side.
  if (path === '/api/lab/strategy/promote' && method === 'POST') {
    try {
      const body = await readBody(req);
      const id = body.id;
      if (!id) return json(res, { ok: false, error: 'id required' }, 400);
      const val = await getStrategyValidation();
      const strat = (val.strategies || []).find(s => s.id === id);
      if (!strat) return json(res, { ok: false, error: 'unknown strategy' }, 404);
      const { promote } = await import('./strategy_state.mjs');
      const result = promote(id, strat.evidence);
      if (result.ok) bustStrategyCache(); // state changed → drop stale validation cache so the Lab reflects it immediately
      return json(res, result);
    } catch (e) { return json(res, { ok: false, error: e.message }, 500); }
  }

  // Calibration: empirical P(profit) and P(beat buy-and-hold) per signal bucket, with
  // Wilson confidence intervals. ?horizon=N (default 20). ?type=&score= for a single lookup.
  if (path === '/api/lab/calibration' && method === 'GET') {
    try {
      const horizon = +url.searchParams.get('horizon') || 20;
      const type = url.searchParams.get('type');
      if (type) {
        const score = url.searchParams.get('score') != null ? +url.searchParams.get('score') : null;
        const regime = url.searchParams.get('regime') || null;
        return json(res, { ok: true, signal: calibrateSignal({ signal_type: type, score, regime, horizon }) });
      }
      return json(res, { ok: true, ...getCalibration({ horizon }) });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // Catalyst risk flags — "don't buy right now" defensive warnings from validated
  // negative catalysts (debt issuance / earnings / management change). Not alpha.
  if (path === '/api/catalyst/risks' && method === 'GET') {
    try { return json(res, { ok: true, flags: getActiveRiskFlags() }); }
    catch(e) { return json(res, { error: e.message }, 500); }
  }
  if (path.startsWith('/api/catalyst/risk/') && method === 'GET') {
    try {
      const sym = decodeURIComponent(path.slice('/api/catalyst/risk/'.length));
      return json(res, { ok: true, sym, flags: getRiskFlags(sym) });
    } catch(e) { return json(res, { error: e.message }, 500); }
  }

  // ── Kelly position sizer ──────────────────────────────────────────────────
  if (path.startsWith('/api/kelly/') && method === 'GET') {
    const sym = decodeURIComponent(path.slice('/api/kelly/'.length));
    const r   = (state.scan.results || []).find(s => s.sym === sym);
    if (!r) return json(res, { ok: false, error: 'Symbol not in last scan' }, 404);

    const market    = r.sym.startsWith('TADAWUL:') ? 'tasi'
                    : r.sym.includes('BTC') || r.sym.includes('ETH') || r.sym.includes('XRP') ? 'crypto'
                    : 'us';
    const styleTag  = (r.style_tags || [])[0] || 'Unknown';
    const labData   = accuracyLab.winRateFor(market, styleTag);

    // ATR-based risk per share (1.5× ATR)
    const atrRisk  = r.atr != null ? +(r.atr * 1.5).toFixed(4) : null;
    const riskPct  = (atrRisk && r.price > 0) ? +((atrRisk / r.price) * 100).toFixed(2) : null;

    // Position sizing given kelly fraction and a default portfolio of 100k
    let sizing = null;
    if (labData && riskPct) {
      const portfolioSAR    = 100000;
      const riskAmountSAR   = portfolioSAR * (labData.kelly_half_pct / 100);
      const sharesRaw       = atrRisk > 0 ? riskAmountSAR / atrRisk : 0;
      const positionValue   = sharesRaw * r.price;
      sizing = {
        portfolio_sar:   portfolioSAR,
        risk_per_trade_sar: +riskAmountSAR.toFixed(2),
        recommended_shares: Math.floor(sharesRaw),
        position_value_sar: +positionValue.toFixed(2),
        position_pct:       +(positionValue / portfolioSAR * 100).toFixed(1),
      };
    }

    return json(res, {
      sym, market, style_tag: styleTag,
      lab: labData,
      atr_risk_per_share: atrRisk, risk_pct_of_price: riskPct,
      sizing,
      note: labData
        ? `Based on ${labData.sample} completed signals in ${market}/${styleTag}`
        : 'Insufficient signal history — use fixed 1-2% risk per trade until data accumulates',
    });
  }

  // Insider buys
  // /api/insider-buys (GET/refresh/add/delete) removed Phase 4 — insider UI cut Phase 1, tables empty, never collected.

  // ── CMA Filing Monitor ─────────────────────────────────────────────────────
  if (path === '/api/cma/filings' && method === 'GET') {
    const sym  = url.searchParams.get('sym');
    const date = url.searchParams.get('date');
    const rows = sym ? dbCMA.forSym(sym, date || null) : dbCMA.recent(100);
    return json(res, { filings: rows, count: rows.length });
  }

  if (path === '/api/cma/cross-reference' && method === 'GET') {
    const sym  = url.searchParams.get('sym');
    const date = url.searchParams.get('date');
    if (!sym) return json(res, { error: 'sym required' }, 400);
    const filings = dbCMA.forSym(sym, date || null, 5);
    const summary = dbCMA.summary(sym, 30);
    return json(res, { filings, summary, confirmed: filings.length > 0 });
  }

  if (path === '/api/cma/filings/add' && method === 'POST') {
    const body = await readBody(req);
    const { sym, institution, direction, prev_pct, new_pct, shares_delta,
            filing_date, source_url, company_ar, notes } = body;
    if (!sym || !direction || !filing_date)
      return json(res, { error: 'sym, direction, filing_date required' }, 400);
    const code  = sym.replace(/^TADAWUL:/i, '');
    const fullSym = sym.includes(':') ? sym : `TADAWUL:${code}`;
    const scanRow = state.scan.results?.find(r => r.sym === fullSym);
    const filing = {
      sym: fullSym,
      company: scanRow?.name || null,
      company_ar: company_ar || null,
      institution: institution || 'Unknown',
      direction: ['buy','sell','unknown'].includes(direction) ? direction : 'unknown',
      prev_pct: prev_pct != null ? parseFloat(prev_pct) : null,
      new_pct:  new_pct  != null ? parseFloat(new_pct)  : null,
      shares_delta: shares_delta ? parseInt(shares_delta) : null,
      filing_date,
      source: 'manual',
      source_url: source_url || null,
      raw_text: notes || null,
      verified: 1,
    };
    if (dbCMA.exists(filing.sym, filing.institution, filing.filing_date))
      return json(res, { ok: false, error: 'Duplicate: same stock + institution + date already exists' });
    dbCMA.insert(filing);
    return json(res, { ok: true, filing });
  }

  if (path === '/api/cma/filings/delete' && method === 'POST') {
    const { id } = await readBody(req);
    if (!id) return json(res, { error: 'id required' }, 400);
    dbCMA.delete(id);
    return json(res, { ok: true });
  }

  if (path === '/api/cma/refresh' && method === 'POST') {
    try {
      const result = await fetchAndStoreCMAFilings();
      return json(res, result);
    } catch (e) {
      return json(res, { ok: false, error: e.message });
    }
  }

  // ── Stock news (Google News RSS, EN + AR, 30-min cache) ──────────────────────
  if (path.startsWith('/api/news/') && method === 'GET') {
    const sym  = decodeURIComponent(path.slice('/api/news/'.length));
    const cached = newsCache.get(sym);
    if (cached && Date.now() - cached.ts < NEWS_TTL) return json(res, { articles: cached.articles });
    const r    = (state.scan.results || []).find(s => s.sym === sym);
    const name = r?.name || (sym.includes(':') ? sym.split(':')[1] : sym);
    const code = sym.includes(':') ? sym.split(':')[1] : sym;
    const [en, ar] = await Promise.all([
      fetchGoogleNews(`"${name}" Saudi`, 'en', 'SA', 'SA:en').catch(() => []),
      fetchGoogleNews(`${code} تداول`, 'ar', 'SA', 'SA:ar').catch(() => []),
    ]);
    const articles = [...en, ...ar].slice(0, 20);
    newsCache.set(sym, { ts: Date.now(), articles });
    return json(res, { articles, name });
  }

  // ── Pre-trade validator: rule-based, no AI API calls ─────────────────────────
  if (path.startsWith('/api/validate/') && method === 'GET') {
    const sym = decodeURIComponent(path.slice('/api/validate/'.length));
    const r = (state.scan.results || []).find(s => s.sym === sym);
    if (!r) return json(res, { ok: false, error: 'Symbol not in last scan' }, 404);

    const hist = state.score_history[sym] || [];
    const vel  = computeVelocity(hist);
    const checks = [];

    // 1. Signal strength
    const signalOk = r.score >= 5;
    checks.push({ name: 'Signal strength', pass: signalOk,
      detail: `Score ${r.score}/${r.maxScore || 9} (${r.bias}) — ${signalOk ? 'sufficient conviction' : 'below BUY threshold (need ≥5)'}` });

    // 2. Score trajectory
    const trajOk = vel.direction !== 'falling';
    checks.push({ name: 'Score trajectory', pass: trajOk,
      detail: `${vel.direction === 'rising' ? '↗ Rising' : vel.direction === 'stable' ? '→ Stable' : '↘ Falling'} (slope ${vel.slope > 0 ? '+' : ''}${vel.slope}/scan) — ${trajOk ? 'momentum intact' : 'score declining — wait for stabilisation'}` });

    // 3. RSI zone
    const isBull = !BEAR_BIASES.has(r.bias);
    const rsiOk = r.rsi != null && (isBull ? r.rsi >= 50 && r.rsi <= 85 : r.rsi >= 15 && r.rsi <= 50);
    checks.push({ name: 'RSI zone', pass: rsiOk,
      detail: r.rsi != null
        ? `RSI ${r.rsi.toFixed(1)} — ${rsiOk ? 'in valid zone' : isBull ? 'out of bullish zone (50–85)' : 'out of bearish zone (15–50)'}`
        : 'RSI unavailable' });

    // 4. MACD direction
    const macdOk = r.macd_hist != null && (isBull ? r.macd_hist > 0 : r.macd_hist < 0);
    checks.push({ name: 'MACD direction', pass: macdOk,
      detail: r.macd_hist != null
        ? `Histogram ${r.macd_hist > 0 ? '+' : ''}${r.macd_hist.toFixed(4)} — ${macdOk ? 'confirms direction' : 'opposes signal direction'}`
        : 'MACD unavailable' });

    // 5. OBV trend
    const obvOk = r.obv_trend === (isBull ? 'rising' : 'falling');
    checks.push({ name: 'OBV trend', pass: obvOk,
      detail: `OBV ${r.obv_trend || 'flat'} — ${obvOk ? 'confirms institutional flow' : 'diverges from signal (caution)'}` });

    // 6. ATR rank (entry timing)
    const atrOk = r.atr_pct_rank != null && r.atr_pct_rank < 80;
    checks.push({ name: 'ATR entry timing', pass: atrOk,
      detail: r.atr_pct_rank != null
        ? `ATR rank ${r.atr_pct_rank}% — ${r.atr_pct_rank <= 25 ? 'coiling (ideal entry)' : r.atr_pct_rank < 80 ? 'moderate volatility' : 'overextended — late entry risk'}`
        : 'ATR rank unavailable' });

    // (whale_score "smart money" check removed — validated as noise, showdown t=-1.47/-8.9%/yr)

    // 8. Extension risk
    const extOk = (r.extension_pct || 0) <= 25;
    checks.push({ name: 'Extension risk', pass: extOk,
      detail: `Price ${(r.extension_pct||0).toFixed(1)}% above 20-day low — ${extOk ? 'acceptable entry zone' : 'overextended from recent base (elevated pullback risk)'}` });

    // 9. Portfolio concentration
    const positions = state.positions || {};
    const posCount  = Object.keys(positions).length;
    const alreadyIn = !!positions[sym];
    const concOk    = posCount < 15;
    checks.push({ name: 'Portfolio capacity', pass: concOk || alreadyIn,
      detail: alreadyIn ? `Already in portfolio — adding would increase concentration`
        : `${posCount} open positions — ${concOk ? 'capacity available' : 'portfolio full (≥15 positions)'}` });

    // 10. CMA filing (institutional accumulation)
    let cmaFiling = null;
    try { cmaFiling = dbCMA.forSym(sym, null, 1)?.[0] || null; } catch (_) {}
    const cmaOk = !!cmaFiling;
    checks.push({ name: 'CMA institutional filing', pass: cmaOk,
      detail: cmaOk
        ? `${cmaFiling.institution} ${cmaFiling.direction} on ${cmaFiling.filing_date} — institutional confirmation`
        : 'No recent CMA filing — no institutional confirmation (not blocking)' });

    // 11. Historical edge (Bayesian win-rate from accuracy lab)
    const labMarket  = sym.startsWith('TADAWUL:') ? 'tasi' : sym.includes('BTC') || sym.includes('ETH') ? 'crypto' : 'us';
    const labStyle   = (r.style_tags || [])[0] || 'Unknown';
    const labData    = (() => { try { return accuracyLab.winRateFor(labMarket, labStyle); } catch { return null; } })();
    const labOk      = labData != null && labData.win_rate_pct >= 55 && labData.expectancy >= 0.5;
    checks.push({ name: 'Historical edge', pass: labOk,
      detail: labData
        ? `${labData.win_rate_pct}% win rate · ${labData.expectancy}R expectancy · ${labData.sample} signals (${labData.confidence} confidence) — ${labData.style || labStyle} setups in ${labMarket}`
        : `No sufficient history for ${labStyle}/${labMarket} — accumulating data (not blocking)`,
      kelly: labData ? { full: labData.kelly_full_pct, half: labData.kelly_half_pct } : null });

    // 12. Earnings proximity (requires Finnhub token; auto-passes if no data)
    let earningsEvent = null;
    try { earningsEvent = await getEarningsCalendar(sym, state.settings?.finnhub_token); } catch (_) {}
    let earningsOk = true, earningsDays = null, earningsDetail = 'No earnings data available (Finnhub token not set or TASI stock) — skipping';
    if (earningsEvent?.date) {
      earningsDays = Math.round((new Date(earningsEvent.date) - Date.now()) / 864e5);
      if (earningsDays >= 0 && earningsDays <= 7) {
        earningsOk = false;
        const when = earningsDays === 0 ? 'today' : earningsDays === 1 ? 'tomorrow' : `in ${earningsDays} days`;
        const session = earningsEvent.hour === 'bmo' ? ' (pre-market)' : earningsEvent.hour === 'amc' ? ' (after-close)' : '';
        earningsDetail = `⚠ Earnings ${when}${session} (${earningsEvent.date}) — high binary risk, entry not recommended`;
      } else if (earningsDays > 7) {
        earningsDetail = `Earnings on ${earningsEvent.date} (${earningsDays} days away) — safe to enter`;
      } else {
        earningsDetail = `Earnings have passed (${earningsEvent.date}) — no upcoming risk`;
      }
    }
    checks.push({ name: 'Earnings proximity', pass: earningsOk, detail: earningsDetail,
      ...(earningsDays != null ? { earnings_date: earningsEvent.date, earnings_days: earningsDays } : {}) });

    const passingCount = checks.filter(c => c.pass).length;
    const scoreVal = Math.round(passingCount / checks.length * 100);
    const verdict = scoreVal >= 78 ? 'STRONG GO' : scoreVal >= 58 ? 'CAUTIOUS GO' : scoreVal >= 38 ? 'WAIT' : 'NO GO';
    const summary = scoreVal >= 78
      ? 'Setup has strong multi-factor confirmation. Entry is well-timed.'
      : scoreVal >= 58
      ? 'Most criteria align. Monitor the failing checks before entering.'
      : scoreVal >= 38
      ? 'Mixed signals. Wait for at least 8/12 checks to pass.'
      : 'Too many red flags. Avoid entry until the setup improves.';

    return json(res, { sym, name: r.name, bias: r.bias, score: r.score, verdict, confidence: scoreVal, summary, checks, velocity: vel,
      conviction_score: r.conviction_score || null, patterns: r.patterns || [], scanned_at: state.scan.lastRun });
  }

  // ── Sector breadth ────────────────────────────────────────────────────────────
  if (path === '/api/sectors/breadth' && method === 'GET') {
    const results = state.scan.results || [];
    const map = {};
    for (const r of results) {
      if (['ERROR','NO_DATA'].includes(r.bias)) continue;
      const sec = sectorOf(r.sym);
      if (!map[sec]) map[sec] = { sector: sec, stocks: [], count_buy: 0, count_watch: 0, count_sell: 0, count_skip: 0, scores: [], rs_scores: [] };
      map[sec].stocks.push(r.sym);
      if (['STRONG BUY','BUY'].includes(r.bias)) map[sec].count_buy++;
      else if (r.bias === 'WATCH') map[sec].count_watch++;
      else if (['STRONG SELL','SELL','AVOID'].includes(r.bias)) map[sec].count_sell++;
      else map[sec].count_skip++;
      if (r.score != null) map[sec].scores.push(r.score);
      if (r.rs_score != null) map[sec].rs_scores.push(r.rs_score);
    }
    const sectors = Object.values(map).map(s => {
      const total = s.stocks.length;
      const avg_score = s.scores.length ? +(s.scores.reduce((a,b)=>a+b,0) / s.scores.length).toFixed(1) : 0;
      const avg_rs    = s.rs_scores.length ? +(s.rs_scores.reduce((a,b)=>a+b,0) / s.rs_scores.length).toFixed(2) : null;
      const bull_pct  = total ? Math.round(s.count_buy / total * 100) : 0;
      const momentum  = bull_pct >= 60 ? 'strong' : bull_pct >= 40 ? 'mixed' : 'weak';
      return { sector: s.sector, total, count_buy: s.count_buy, count_watch: s.count_watch, count_sell: s.count_sell, avg_score, avg_rs, bull_pct, momentum };
    }).sort((a, b) => b.bull_pct - a.bull_pct);
    return json(res, { sectors, total_stocks: results.length, scanned_at: state.scan.lastRun });
  }

  // ── Morning playbook (rule-based, no AI) ─────────────────────────────────────
  if (path === '/api/playbook' && method === 'GET') {
    const results = state.scan.results || [];
    if (!results.length) return json(res, { ok: false, error: 'No scan data — run a scan first' });

    // Market regime from scan results
    const regimeVotes = results.filter(r => r.market_regime).map(r => r.market_regime);
    const regimeCounts = { bull: 0, neutral: 0, bear: 0 };
    for (const v of regimeVotes) regimeCounts[v] = (regimeCounts[v] || 0) + 1;
    const marketRegime = Object.entries(regimeCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || 'neutral';

    // Market mood (from bias distribution)
    const buyCount  = results.filter(r => ['STRONG BUY','BUY'].includes(r.bias)).length;
    const sellCount = results.filter(r => ['STRONG SELL','SELL'].includes(r.bias)).length;
    const total     = results.filter(r => !['ERROR','NO_DATA'].includes(r.bias)).length;
    const bullPct   = total ? Math.round(buyCount / total * 100) : 0;
    const mood      = bullPct >= 55 ? 'Good' : bullPct >= 35 ? 'Cautious' : 'Weak';

    // Top 3 setups: highest composite + rising/stable velocity
    const topSetups = results
      .filter(r => ['STRONG BUY','BUY'].includes(r.bias) && r.composite >= 60)
      .map(r => ({ ...r, vel: computeVelocity(state.score_history[r.sym] || []) }))
      .filter(r => r.vel.direction !== 'falling')
      .sort((a, b) => (b.composite + (b.vel.slope > 0 ? 5 : 0)) - (a.composite + (a.vel.slope > 0 ? 5 : 0)))
      .slice(0, 3)
      .map(r => ({ sym: r.sym, name: r.name, bias: r.bias, score: r.score, composite: r.composite,
        price: r.price, rs_score: r.rs_score, whale_score: r.whale_score, atr_pct_rank: r.atr_pct_rank,
        velocity: r.vel, sector: sectorOf(r.sym) }));

    // Positions needing attention (exit check lite)
    const openPositions = Object.entries(state.positions || {});
    const positionAlerts = openPositions.map(([sym, pos]) => {
      const scan = results.find(r => r.sym === sym);
      if (!scan) return null;
      const vel = computeVelocity(state.score_history[sym] || []);
      const exitSignals = [];
      if (vel.direction === 'falling') exitSignals.push('Score declining');
      if (scan.rsi != null && scan.rsi < 48) exitSignals.push(`RSI ${scan.rsi.toFixed(1)} below 48`);
      if (scan.macd_hist != null && scan.macd_hist < 0) exitSignals.push('MACD turned negative');
      if (scan.emas?.ema34 && scan.price < scan.emas.ema34) exitSignals.push('Price below EMA 34');
      const action = exitSignals.length >= 2 ? 'EXIT' : exitSignals.length === 1 ? 'WATCH' : 'HOLD';
      return { sym, name: scan.name, action, exitSignals, score: scan.score, bias: scan.bias, velocity: vel };
    }).filter(Boolean);

    // Sector breadth snapshot
    const secMap = {};
    for (const r of results) {
      if (['ERROR','NO_DATA'].includes(r.bias)) continue;
      const sec = sectorOf(r.sym);
      if (!secMap[sec]) secMap[sec] = { buy: 0, total: 0 };
      if (['STRONG BUY','BUY'].includes(r.bias)) secMap[sec].buy++;
      secMap[sec].total++;
    }
    const sectorSummary = Object.entries(secMap)
      .map(([sector, d]) => ({ sector, bull_pct: d.total ? Math.round(d.buy/d.total*100) : 0, total: d.total }))
      .sort((a,b) => b.bull_pct - a.bull_pct);

    // Risk posture
    const riskPosture = marketRegime === 'bull' && bullPct >= 55 ? 'Aggressive'
      : marketRegime === 'bear' || bullPct < 30 ? 'Defensive'
      : 'Selective';

    return json(res, {
      date: new Date().toISOString().slice(0,10),
      market_regime: marketRegime,
      market_mood: mood,
      bull_pct: bullPct,
      buy_count: buyCount,
      sell_count: sellCount,
      scanned: total,
      risk_posture: riskPosture,
      top_setups: topSetups,
      position_alerts: positionAlerts,
      sector_summary: sectorSummary.slice(0, 8),
      scanned_at: state.scan.lastRun,
    });
  }

  // ── Exit intelligence: open positions exit check ──────────────────────────────
  if (path === '/api/positions/exit-check' && method === 'GET') {
    const results  = state.scan.results || [];
    const scanMap  = new Map(results.map(r => [r.sym, r]));
    const positions = state.positions || {};

    const checks = Object.entries(positions).map(([sym, pos]) => {
      const r   = scanMap.get(sym);
      const vel = computeVelocity(state.score_history[sym] || []);
      const exitSignals = [];
      const holdSignals = [];

      if (!r) return { sym, name: pos.name || sym, action: 'DATA_MISSING', note: 'Not in last scan — re-scan to update', velocity: vel };

      if (vel.direction === 'falling') exitSignals.push({ reason: 'Score declining', weight: 2 });
      else if (vel.direction === 'rising') holdSignals.push('Score rising — momentum building');

      if (r.rsi != null) {
        if (r.rsi < 48) exitSignals.push({ reason: `RSI ${r.rsi.toFixed(1)} — below momentum zone`, weight: 2 });
        else if (r.rsi >= 52 && r.rsi <= 75) holdSignals.push(`RSI ${r.rsi.toFixed(1)} — healthy momentum`);
        else if (r.rsi > 80) exitSignals.push({ reason: `RSI ${r.rsi.toFixed(1)} — stretched (partial exit consideration)`, weight: 1 });
      }

      if (r.macd_hist != null) {
        if (r.macd_hist < 0) exitSignals.push({ reason: 'MACD histogram negative — trend weakening', weight: 2 });
        else holdSignals.push('MACD positive — uptrend intact');
      }

      if (r.emas?.ema34 && r.price < r.emas.ema34) {
        exitSignals.push({ reason: `Price ${r.price.toFixed(2)} below EMA 34 (${r.emas.ema34.toFixed(2)})`, weight: 3 });
      } else if (r.emas?.ema34) {
        holdSignals.push(`Price above EMA 34 — trend support intact`);
      }

      if (r.obv_trend === 'falling') exitSignals.push({ reason: 'OBV falling — smart money distributing', weight: 1 });

      const exitWeight = exitSignals.reduce((a, e) => a + e.weight, 0);
      const action = exitWeight >= 5 ? 'EXIT' : exitWeight >= 3 ? 'REDUCE' : exitWeight >= 1 ? 'WATCH' : 'HOLD';

      const entryPrice = pos.buy_price || pos.price || null;
      const pl_pct = entryPrice ? +((r.price - entryPrice) / entryPrice * 100).toFixed(2) : null;

      return {
        sym, name: r.name || sym, action,
        score: r.score, bias: r.bias, price: r.price, pl_pct,
        exit_signals: exitSignals.map(e => e.reason),
        hold_signals: holdSignals,
        velocity: vel,
        rsi: r.rsi, macd_hist: r.macd_hist, obv_trend: r.obv_trend,
        ema34: r.emas?.ema34 || null,
      };
    });

    const exitCount   = checks.filter(c => c.action === 'EXIT').length;
    const reduceCount = checks.filter(c => c.action === 'REDUCE').length;
    const watchCount  = checks.filter(c => c.action === 'WATCH').length;
    const holdCount   = checks.filter(c => c.action === 'HOLD').length;
    return json(res, { checks, summary: { exit: exitCount, reduce: reduceCount, watch: watchCount, hold: holdCount }, scanned_at: state.scan.lastRun });
  }

  res.writeHead(404);
  res.end("Not found");
  } catch (err) {
    console.error('[server] Unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// ── Multi-Signal Opportunity Engine ───────────────────────────────────────────
// 9 signal types, conviction scoring (0-100), freshness decay, DB persistence.
// Covers: confirmed breakouts, multi-TF confluence, pre-breakout coils,
// smart money (block deals + CMA + insider), score trajectory projections,
// stealth RS leaders, divergence reversals, insider+technical sync, vol expansion.

const SIGNAL_DEFS = {
  STRONG_BUY_CONFIRMED:     { label: 'Signal Confirmed',    icon: '✅', color: '#00c853', bg: 'rgba(0,200,83,.13)',    base: 55, halfLifeH: 48  },
  MTF_CONFLUENCE:           { label: 'Multi-TF Confluence', icon: '🎯', color: '#16a34a', bg: 'rgba(22,163,74,.13)',   base: 62, halfLifeH: 36  },
  PRE_BREAKOUT_COIL:        { label: 'Pre-Breakout Coil',   icon: '🌀', color: '#7c3aed', bg: 'rgba(124,58,237,.13)', base: 50, halfLifeH: 20  },
  SMART_MONEY_ACCUMULATION: { label: 'Smart Money',         icon: '🐳', color: '#0891b2', bg: 'rgba(8,145,178,.13)',  base: 65, halfLifeH: 72  },
  SCORE_TRAJECTORY:         { label: 'Building Momentum',   icon: '📈', color: '#059669', bg: 'rgba(5,150,105,.13)',  base: 40, halfLifeH: 14  },
  STEALTH_RS_LEADER:        { label: 'Stealth RS Leader',   icon: '⚡', color: '#d97706', bg: 'rgba(217,119,6,.13)',  base: 45, halfLifeH: 48  },
  DIVERGENCE_REVERSAL:      { label: 'Divergence Reversal', icon: '↩',  color: '#dc2626', bg: 'rgba(220,38,38,.13)', base: 48, halfLifeH: 30  },
  INSIDER_TECHNICAL_SYNC:   { label: 'Insider + Setup',     icon: '🔍', color: '#9333ea', bg: 'rgba(147,51,234,.13)', base: 68, halfLifeH: 120 },
  VOLATILITY_EXPANSION:     { label: 'Volatility Breakout', icon: '💥', color: '#ea580c', bg: 'rgba(234,88,12,.13)', base: 52, halfLifeH: 10  },
};

// ── Math helpers ──────────────────────────────────────────────────────────────

function oppFreshness(detectedAt, halfLifeH) {
  const h = (Date.now() - new Date(detectedAt).getTime()) / 3600000;
  return Math.exp(-Math.LN2 * h / halfLifeH);
}

function oppConviction(base, fresh, confluenceN, regime) {
  const conf = Math.min(1.8, 1.0 + (confluenceN - 1) * 0.15);
  const reg  = regime === 'bull' ? 1.15 : regime === 'bear' ? 0.8 : 1.0;
  return Math.min(100, Math.round(base * conf * fresh * reg));
}

function oppLinReg(values) {
  const n = values.length;
  if (n < 2) return { slope: 0, r2: 0 };
  const mx = (n - 1) / 2, my = values.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  values.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
  const slope = den ? num / den : 0;
  const pred  = values.map((_, i) => my + slope * (i - mx));
  const ssr   = values.reduce((a, v, i) => a + (v - pred[i]) ** 2, 0);
  const sst   = values.reduce((a, v) => a + (v - my) ** 2, 0);
  return { slope: +slope.toFixed(3), r2: sst ? +(1 - ssr / sst).toFixed(2) : 0 };
}

function oppATR(r) {
  const atr     = r.atr || (r.atr_pct ? r.price * r.atr_pct / 100 : r.price * 0.02);
  const atr_pct = +(atr / r.price * 100).toFixed(2);
  return { atr, atr_pct, estimated: !r.atr && !r.atr_pct };
}

function oppSetup(r, atrd) {
  const px   = +r.price.toFixed(2);
  const stop = +(r.price - 1.5 * atrd.atr).toFixed(2);
  const t1   = +(r.price + 1.5 * atrd.atr).toFixed(2);
  const t2   = +(r.price + 3   * atrd.atr).toFixed(2);
  const atrNote = atrd.estimated ? ` (ATR ~${atrd.atr_pct}%, est.)` : ` (${atrd.atr_pct}% ATR)`;
  return { stop, target1: t1, target2: t2, str: `Entry ${px}, stop ${stop}${atrNote}, targets ${t1} / ${t2} — R:R 2:1.` };
}

function oppRsPercentile(scanResults) {
  const vals = scanResults.map(r => r.rs_score).filter(v => v != null).sort((a, b) => a - b);
  return (sym) => {
    const r = scanResults.find(s => s.sym === sym);
    if (!r?.rs_score || !vals.length) return null;
    return Math.round(vals.filter(v => v < r.rs_score).length / vals.length * 100);
  };
}

// ── Signal Detectors ──────────────────────────────────────────────────────────

function sigStrongBuy(r) {
  if (!['STRONG BUY', 'BUY'].includes(r.bias) || r.score < 6 || (r.vol_ratio ?? 0) < 1.0) return null;
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const { ema13, ema34, ema89, ema200 } = r.emas || {};
  const parts = [];
  if (ema13 > ema34 && ema34 > ema89 && ema89 > ema200) parts.push('EMA 13>34>89>200 full stack');
  else if (ema13 > ema34 && ema34 > ema89)              parts.push('EMA 13>34>89 aligned');
  if (r.rsi)           parts.push(`RSI ${+r.rsi.toFixed(1)}`);
  if (r.macd_hist > 0) parts.push(`MACD +${r.macd_hist.toFixed(3)}`);
  if (r.vol_ratio >= 1.5) parts.push(`volume ${r.vol_ratio}× avg`);
  else if (r.vol_ratio >= 1.2) parts.push(`vol ${r.vol_ratio}× avg`);
  if (r.mfi >= 65)     parts.push(`MFI ${r.mfi}`);
  if (r.divergence === 'bullish')              parts.push('bullish divergence');
  if (r.weekly?.trend === 'bullish')           parts.push('weekly bullish');
  const risks = [];
  if (r.near_resistance)        risks.push('price at resistance — close above to confirm');
  if ((r.extension_pct ?? 0) > 5) risks.push(`extended ${r.extension_pct}% above EMA13`);
  if (r.market_regime === 'bear') risks.push('bearish regime — size down');
  const note = `${parts.slice(0, 4).join('; ')}. ${setup.str}${risks.length ? ' ⚠ ' + risks[0] + '.' : ''}`;
  const hl   = `${r.score}/${r.maxScore} confirmed` + (r.divergence === 'bullish' ? ' + div' : '');
  return { type: 'STRONG_BUY_CONFIRMED', headline: hl, note, extra: setup };
}

function sigMTF(r) {
  const wBull = r.weekly?.trend === 'bullish' || r.weekly?.bias === 'bullish';
  const { ema13, ema34, ema89 } = r.emas || {};
  if (r.score < 5 || !wBull || !(ema13 > ema34 && ema34 > ema89)) return null;
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const rg    = r.market_regime || 'neutral';
  const note  = `Score ${r.score}/8 with bullish weekly — both timeframes aligned. EMA 13>34>89; RSI ${r.rsi ? +r.rsi.toFixed(1) : '—'}; vol ${r.vol_ratio}×. ${rg === 'bull' ? 'Regime bullish — maximum confluence.' : `Regime ${rg}.`} ${setup.str}`;
  return { type: 'MTF_CONFLUENCE', headline: `Daily+Weekly aligned · regime ${rg}`, note, extra: setup };
}

function sigCoil(r) {
  const compressed = !!r.vol_compression;
  const building   = !!r.rsi_buildup;
  const nearR      = !!r.near_resistance;
  const rsiZone    = r.rsi >= 46 && r.rsi <= 66;
  const obvOk      = r.obv_trend !== 'falling';
  const quietVol   = (r.vol_ratio ?? 1) < 1.0;
  const cnt = [compressed, building, nearR, rsiZone, obvOk, quietVol].filter(Boolean).length;
  if (cnt < 3 || ['SKIP','AVOID','SELL','STRONG SELL'].includes(r.bias)) return null;
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const note  = `Volatility ${compressed ? 'compressed (squeeze confirmed)' : 'tightening'}, RSI ${r.rsi ? +r.rsi.toFixed(1) : '—'} ${building ? 'building from below 52' : 'in neutral zone'}, vol ${r.vol_ratio}× (quiet). ${nearR ? 'Coiling at resistance — breakout imminent on volume surge.' : 'Consolidating — watch for expansion bar.'} ${setup.str}`;
  return { type: 'PRE_BREAKOUT_COIL', headline: `Coiling — ${cnt}/6 conditions`, note, extra: { ...setup, conditionsMet: cnt } };
}

function sigSmartMoney(r, ctx) {
  const code     = r.sym.split(':')[1];
  const recentBD = ctx.recentBlockDeals.filter(d => d.sym === r.sym || (d.sym ?? '').includes(code));
  const cmaBuys  = ctx.allCMA.filter(f => f.sym === r.sym && f.direction === 'buy').slice(0, 3);
  const insiders = ctx.allInsider.filter(b => b.sym === r.sym || (b.sym ?? '').includes(code));
  // Hard evidence = documented institutional action
  const hardEvidence = [recentBD.length >= 1, cmaBuys.length >= 1, insiders.length >= 1].filter(Boolean).length;
  // Stealth: OBV rising + price flat + strong institutional indicators
  const stealthOBV = r.obv_trend === 'rising' && Math.abs(r.change_pct ?? 0) < 1.5
                     && (r.mfi ?? 0) >= 60;
  if (hardEvidence < 1 && !stealthOBV) return null;
  // whale_score gate removed — it's noise (showdown t=-1.47); Smart Money now requires real
  // evidence only (block deals / CMA buys / insider buys, or stealth OBV+MFI accumulation).
  const parts = [];
  if (recentBD.length)  parts.push(`${recentBD.length} block deal${recentBD.length > 1 ? 's' : ''} (${recentBD.slice(0,2).map(d => d.date).join(', ')})`);
  if (cmaBuys.length)   parts.push(`CMA buy: ${cmaBuys[0].institution_en || cmaBuys[0].institution || 'institution'} → ${cmaBuys[0].new_pct || '?'}%`);
  if (insiders.length)  parts.push(`insider buy: ${insiders[0].person || 'director'} (${insiders[0].date})`);
  if (stealthOBV)       parts.push(`OBV rising, price flat (${r.change_pct ?? 0}%)`);
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const note  = `Smart money signals: ${parts.join('; ')}. ${setup.str}`;
  return { type: 'SMART_MONEY_ACCUMULATION', headline: `Smart money: ${parts.slice(0,2).join(' + ')}`, note,
    extra: { ...setup, blockDeals: recentBD.length, cmaBuys: cmaBuys.length, insiders: insiders.length,
      blockDealDates: recentBD.map(d => d.date).slice(0,3),
      cmaSummary: cmaBuys[0] ? `${cmaBuys[0].institution_en || cmaBuys[0].institution} → ${cmaBuys[0].new_pct}%` : null,
      insiderSummary: insiders[0] ? `${insiders[0].person} (${insiders[0].role}) · ${insiders[0].date}` : null } };
}

function sigTrajectory(r, ctx) {
  const hist = ctx.scoreHist[r.sym];
  if (!hist || hist.length < 3) return null;
  const scores = hist.slice(0, 6).reverse().map(e => e.s ?? 0);
  const { slope, r2 } = oppLinReg(scores);
  const current = scores[scores.length - 1];
  if (slope < 0.3 || r2 < 0.4 || current >= 7 || current < 3) return null;
  const scansLeft = Math.ceil((7 - current) / slope);
  const etaH     = scansLeft * 2.4;
  const eta       = etaH < 4 ? 'next 1-2 scans' : etaH < 12 ? 'later today' : etaH < 30 ? 'tomorrow' : `~${Math.round(etaH / 24)} days`;
  const traj  = scores.join('→');
  const driver = r.rsi_buildup ? 'RSI building' : (r.macd_hist ?? 0) > 0 ? 'MACD turning +' : 'momentum building';
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const note  = `Score trajectory ${traj} (+${slope}/session, R²=${r2}). STRONG BUY trigger projected ${eta}. ${driver}. Currently ${current}/8 — not yet actionable but watch closely. ${setup.str}`;
  return { type: 'SCORE_TRAJECTORY', headline: `Score ${traj} → trigger in ${eta}`, note,
    extra: { slope, r2, trajectory: traj, scansLeft, eta, current, ...setup } };
}

function sigStealthRS(r, ctx) {
  const pct = ctx.rsPercentile(r.sym);
  if (pct == null || pct < 85 || r.score > 6 || (r.rs_score ?? 0) < 2.0) return null;
  if ((r.bearFlags || []).length > 0) return null;
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const top   = 100 - pct;
  const note  = `RS score +${r.rs_score}% vs TASI — top ${top}% of universe, yet technical score only ${r.score}/8. Relative strength not yet reflected in chart signals. ${r.weekly?.trend === 'bullish' ? 'Weekly trend improving. ' : ''}One confirming bar closes this gap. ${setup.str}`;
  return { type: 'STEALTH_RS_LEADER', headline: `RS top ${top}% · score lags at ${r.score}/8`, note, extra: { rsPct: pct, rs_score: r.rs_score, ...setup } };
}

function sigDivergence(r) {
  if (r.divergence !== 'bullish') return null;
  const nearSup = !!r.near_support;
  const mfiLow  = r.mfi != null && r.mfi < 40;
  // whale_score dropped from the confirmer count — noise (showdown t=-1.47)
  const cnt = [nearSup, mfiLow, r.rsi > 28 && r.rsi < 55].filter(Boolean).length;
  if (cnt < 2) return null;
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const note  = `Bullish RSI divergence: price made lower low, RSI held higher — momentum not confirming the selloff.${nearSup ? ' Near support.' : ''}${r.mfi != null ? ` MFI ${r.mfi} (${mfiLow ? 'oversold' : 'recovering'}).` : ''} ${setup.str}`;
  return { type: 'DIVERGENCE_REVERSAL', headline: `Bullish divergence + ${cnt}/3 reversal signals`, note, extra: setup };
}

function sigInsider(r, ctx) {
  const code    = r.sym.split(':')[1];
  const recent  = ctx.allInsider.filter(b => {
    if (b.sym !== r.sym && !(b.sym ?? '').includes(code)) return false;
    return (Date.now() - new Date(b.date).getTime()) / 86400000 <= 30;
  });
  if (!recent.length || r.score < 4) return null;
  const best   = recent[0];
  const daysAgo = Math.round((Date.now() - new Date(best.date).getTime()) / 86400000);
  const atrd   = oppATR(r);
  const setup  = oppSetup(r, atrd);
  const note   = `${best.person || 'Director'} (${best.role || 'insider'}) bought ${best.shares ? best.shares.toLocaleString() + ' shares' : 'shares'}${best.price ? ' @ ' + best.price.toFixed(2) + ' SAR' : ''} — ${daysAgo} days ago. Technical score ${r.score}/8 ${r.score >= 6 ? '(confirmed setup)' : '(building)'} — insider buying with the chart. ${setup.str}`;
  return { type: 'INSIDER_TECHNICAL_SYNC', headline: `${best.person || 'Director'} bought · ${daysAgo}d ago · ${r.score}/8`, note,
    extra: { ...setup, insiderName: best.person, insiderRole: best.role, daysAgo, insiderPrice: best.price } };
}

function sigVolExpansion(r) {
  const z = r.vol_zscore ?? 0;
  if (z < 2.0 || !r.vol_compression) return null; // must expand FROM compression
  const atrd  = oppATR(r);
  const setup = oppSetup(r, atrd);
  const note  = `Volume z-score ${z.toFixed(1)}σ above average — ${z >= 3 ? 'extreme' : 'strong'} surge from a compressed base. Coil resolved with force. ATR at ${atrd.atr_pct}%. This is the breakout bar — or the first candle of one. ${setup.str}`;
  return { type: 'VOLATILITY_EXPANSION', headline: `Vol z-score ${z.toFixed(1)}σ — coil resolved`, note, extra: { z, ...setup } };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

function runAllDetectors(scanResults) {
  const regime    = scanResults.find(r => r.market_regime)?.market_regime || 'neutral';
  const calcRsP   = oppRsPercentile(scanResults);
  const allCMA    = dbCMA.recent(200);
  const allInsider = dbInsiderBuys.getAll();
  const recentBlockDeals = dbBlockDeals.recentAll ? dbBlockDeals.recentAll(15) : [];
  const scoreHist = state.score_history || {};
  const ctx = { allCMA, allInsider, recentBlockDeals, scoreHist, rsPercentile: calcRsP };

  const rawSignals = [];
  for (const r of scanResults) {
    if (r.error || !r.sym || !r.price) continue;
    const detected = [
      sigStrongBuy(r), sigMTF(r), sigCoil(r),
      sigSmartMoney(r, ctx), sigTrajectory(r, ctx),
      sigStealthRS(r, ctx), sigDivergence(r),
      sigInsider(r, ctx), sigVolExpansion(r),
    ].filter(Boolean).map(sig => ({ ...sig, sym: r.sym, name: r.name, price: r.price,
      score: r.score, maxScore: r.maxScore, bias: r.bias, regime,
      rsi: r.rsi, vol_ratio: r.vol_ratio, whale_score: r.whale_score, mfi: r.mfi }));
    rawSignals.push(...detected);
  }

  // Confluence: how many signal types fired for each stock
  const confMap = {};
  rawSignals.forEach(s => { confMap[s.sym] = (confMap[s.sym] || 0) + 1; });

  // Assign conviction to each signal
  const now = new Date().toISOString();
  rawSignals.forEach(s => {
    const def = SIGNAL_DEFS[s.type];
    s.conviction = oppConviction(def.base, 1.0, confMap[s.sym] || 1, s.regime);
    s.confluence = confMap[s.sym] || 1;
    s.expires_at = new Date(Date.now() + def.halfLifeH * 3 * 3600000).toISOString();
    s.detectedAt = now;
    s.payload    = {
      name: s.name, price: s.price, score: s.score, maxScore: s.maxScore, bias: s.bias,
      headline: s.headline, note: s.note, conviction: s.conviction, confluence: s.confluence,
      regime: s.regime, expires_at: s.expires_at, rsi: s.rsi, vol_ratio: s.vol_ratio,
      whale_score: s.whale_score, mfi: s.mfi, ...s.extra,
    };
  });

  return rawSignals;
}

async function detectAndStoreSignals(scanResults) {
  if (!scanResults?.length) return;
  try {
    dbOppSignals.expireOld();
    const signals  = runAllDetectors(scanResults);
    const scanTs   = state.scan.lastRun || new Date().toISOString();
    const seen     = new Set();
    for (const sig of signals) {
      const key = `${sig.sym}|${sig.type}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dbOppSignals.upsert(sig.sym, sig.type, sig.payload, scanTs);
    }
    // Invalidate short-lived signals whose conditions are no longer present
    const activeKeys = new Set(signals.map(s => `${s.sym}|${s.type}`));
    const existing   = dbOppSignals.getActive(0, 300);
    for (const e of existing) {
      if (!activeKeys.has(`${e.sym}|${e.signal_type}`)) {
        const def = SIGNAL_DEFS[e.signal_type];
        if (def && def.halfLifeH <= 48) dbOppSignals.invalidate(e.sym, e.signal_type);
      }
    }
  } catch(e) { console.error('[opp-signals]', e.message); }
}

// Alias kept for scan-complete hook
const generateTopOpportunities = detectAndStoreSignals;


// ── Strategy Validation Engine ────────────────────────────────────────────────
// Tracks marked opportunities over time, measures outcomes at 1w/1m/3m/6m,
// computes conviction calibration, signal decay, RSI edge, regime sensitivity.

const MILESTONE_DAYS = { '1w': 7, '1m': 30, '3m': 90, '6m': 180 };

async function updateMilestonesForTrack(track) {
  try {
    const yahooSym = toYahooSym(track.sym);
    const bars     = await fetchYahooOHLCV(yahooSym, '1d', 250);
    if (!bars?.length) return;

    const entryDate  = new Date(track.tracked_at);
    const pending    = dbMilestones.getPending(track.id);
    let   mae = track.mae ?? 0, mfe = track.mfe ?? 0;

    for (const m of pending) {
      const mDate = new Date(m.target_date);
      if (mDate > new Date()) continue; // still in the future

      const periodBars = bars.filter(b => {
        const d = new Date(b.time * 1000);
        return d > entryDate && d <= mDate;
      });
      if (!periodBars.length) continue;

      let status = 'recorded', exitPrice = null;
      let peakPct = 0, drawdownPct = 0;

      for (const bar of periodBars) {
        const hi = (bar.high - track.entry_price) / track.entry_price * 100;
        const lo = (bar.low  - track.entry_price) / track.entry_price * 100;
        if (hi > peakPct)     peakPct     = hi;
        if (lo < drawdownPct) drawdownPct = lo;
        if (!exitPrice && track.stop    && bar.low  <= track.stop)    { exitPrice = track.stop;    status = 'hit_stop'; }
        if (!exitPrice && track.target2 && bar.high >= track.target2)  { exitPrice = track.target2; status = 'hit_t2';   }
        else if (!exitPrice && track.target1 && bar.high >= track.target1) { exitPrice = track.target1; status = 'hit_t1'; }
      }

      mae = Math.min(mae, drawdownPct);
      mfe = Math.max(mfe, peakPct);

      const finalPrice = exitPrice ?? periodBars[periodBars.length - 1].close;
      const pnlPct     = (finalPrice - track.entry_price) / track.entry_price * 100;
      const pnlSAR     = (track.simulated_capital ?? 20000) * pnlPct / 100;

      dbMilestones.update(track.id, m.checkpoint, {
        actual_date: mDate.toISOString().slice(0, 10),
        price: +finalPrice.toFixed(4), pnl_pct: +pnlPct.toFixed(3),
        pnl_sar: +pnlSAR.toFixed(2), drawdown_pct: +drawdownPct.toFixed(3),
        peak_pct: +peakPct.toFixed(3), status,
      });
    }

    dbTracked.updateExcursion(track.id, mae, mfe);

    // Auto-close if stop hit or T2 reached across all milestones
    const allMs = dbMilestones.getAll(track.id);
    const stopped = allMs.find(m => m.status === 'hit_stop');
    const hitT2   = allMs.find(m => m.status === 'hit_t2');
    if ((stopped || hitT2) && track.status === 'tracking') {
      dbTracked.close(track.id, stopped ? 'stopped' : 't2_hit',
        stopped?.price ?? hitT2?.price, stopped?.actual_date ?? hitT2?.actual_date);
    }
  } catch(e) { /* ignore individual update failures */ }
}

async function refreshAllMilestones() {
  const all = dbTracked.getAll().filter(t => t.status === 'tracking');
  for (const t of all) {
    await updateMilestonesForTrack(t);
    await new Promise(r => setTimeout(r, 200));
  }
}

function computeInsights() {
  const all    = dbTracked.getAll();
  const allMs  = dbMilestones.getAllForTracks(all.map(t => t.id));
  const msMap  = {};
  allMs.forEach(m => { if (!msMap[m.track_id]) msMap[m.track_id] = {}; msMap[m.track_id][m.checkpoint] = m; });

  // Trades with ≥1 month data
  const trades = all
    .map(t => ({ ...t, ms: msMap[t.id] || {} }))
    .filter(t => t.ms['1m']?.pnl_pct != null)
    .map(t => ({ ...t, ret: t.ms['1m'].pnl_pct, win: t.ms['1m'].pnl_pct > 0 }));

  if (trades.length < 3) return { insufficient: true, count: trades.length, needed: 3 };

  // Signal type stats
  const byType = {};
  trades.forEach(t => { (byType[t.signal_type] = byType[t.signal_type] || []).push(t); });
  const signalStats = Object.entries(byType).map(([type, ts]) => ({
    type, count: ts.length,
    winRate: Math.round(ts.filter(t => t.win).length / ts.length * 100),
    avgRet:  +(ts.reduce((s, t) => s + t.ret, 0) / ts.length).toFixed(2),
    avgWin:  +(ts.filter(t => t.win).reduce((s, t) => s + t.ret, 0) / Math.max(1, ts.filter(t => t.win).length)).toFixed(2),
    avgLoss: +(ts.filter(t => !t.win).reduce((s, t) => s + t.ret, 0) / Math.max(1, ts.filter(t => !t.win).length)).toFixed(2),
    avgMae:  +(ts.reduce((s, t) => s + (t.mae ?? 0), 0) / ts.length).toFixed(2),
    avgMfe:  +(ts.reduce((s, t) => s + (t.mfe ?? 0), 0) / ts.length).toFixed(2),
  })).sort((a, b) => b.winRate - a.winRate);

  // Conviction calibration (predicted vs actual win rate)
  const convBuckets = [
    { label: '30–50', min: 30, max: 50 }, { label: '50–65', min: 50, max: 65 },
    { label: '65–80', min: 65, max: 80 }, { label: '80+',   min: 80, max: 101 },
  ];
  const convCalibration = convBuckets.map(b => {
    const ts = trades.filter(t => (t.conviction ?? 0) >= b.min && (t.conviction ?? 0) < b.max);
    return { ...b, count: ts.length, actual: ts.length ? Math.round(ts.filter(t=>t.win).length/ts.length*100) : null };
  });

  // RSI edge (where does win rate peak?)
  const rsiBuckets = [
    { label: '<45', min: 0, max: 45 }, { label: '45–52', min: 45, max: 52 },
    { label: '52–62', min: 52, max: 62 }, { label: '62–72', min: 62, max: 72 },
    { label: '>72', min: 72, max: 100 },
  ];
  const rsiEdge = rsiBuckets.map(b => {
    const ts = trades.filter(t => t.rsi != null && t.rsi >= b.min && t.rsi < b.max);
    return { ...b, count: ts.length, winRate: ts.length ? Math.round(ts.filter(t=>t.win).length/ts.length*100) : null };
  }).filter(b => b.count > 0);

  // MFI edge
  const mfiBuckets = [
    { label: '<40', min: 0, max: 40 }, { label: '40–55', min: 40, max: 55 },
    { label: '55–70', min: 55, max: 70 }, { label: '>70', min: 70, max: 101 },
  ];
  const mfiEdge = mfiBuckets.map(b => {
    const ts = trades.filter(t => t.mfi != null && t.mfi >= b.min && t.mfi < b.max);
    return { ...b, count: ts.length, winRate: ts.length ? Math.round(ts.filter(t=>t.win).length/ts.length*100) : null };
  }).filter(b => b.count > 0);

  // Regime sensitivity
  const regimeStats = ['bull', 'bear', 'neutral'].map(regime => {
    const ts = trades.filter(t => t.market_regime === regime);
    return { regime, count: ts.length, winRate: ts.length ? Math.round(ts.filter(t=>t.win).length/ts.length*100) : null,
      avgRet: ts.length ? +(ts.reduce((s,t)=>s+t.ret,0)/ts.length).toFixed(2) : null };
  }).filter(r => r.count > 0);

  // Signal decay (rolling 20-trade window vs lifetime)
  const decayAlerts = [];
  Object.entries(byType).forEach(([type, ts]) => {
    if (ts.length < 8) return;
    const lifetime = ts.filter(t=>t.win).length / ts.length;
    const recent   = ts.slice(-Math.min(20, ts.length));
    const recentWr = recent.filter(t=>t.win).length / recent.length;
    if (lifetime - recentWr > 0.15)
      decayAlerts.push({ type, lifetime: Math.round(lifetime*100), recent: Math.round(recentWr*100), drop: Math.round((lifetime-recentWr)*100) });
  });

  // Time-decay: at what point do winners peak?
  const timeReturn = ['1w','1m','3m','6m'].map(cp => {
    const ts = trades.filter(t => t.ms[cp]?.pnl_pct != null).map(t => t.ms[cp].pnl_pct);
    return { cp, count: ts.length, avg: ts.length ? +(ts.reduce((a,b)=>a+b,0)/ts.length).toFixed(2) : null };
  }).filter(t => t.count > 0);

  return {
    totalTrades: trades.length,
    overallWinRate: Math.round(trades.filter(t=>t.win).length/trades.length*100),
    overallAvgRet: +(trades.reduce((s,t)=>s+t.ret,0)/trades.length).toFixed(2),
    totalCapitalPnl: +trades.reduce((s,t) => s + ((t.simulated_capital??20000)*t.ret/100), 0).toFixed(0),
    signalStats, convCalibration, rsiEdge, mfiEdge, regimeStats, decayAlerts, timeReturn,
  };
}

// Generates a plain-language post-mortem note when a track closes
function generatePostMortem(track, milestones) {
  const m1 = milestones.find(m => m.checkpoint === '1m');
  if (!m1?.pnl_pct) return null;
  const outcome = m1.pnl_pct > 0 ? 'WIN' : 'LOSS';
  const flags = [];
  if (track.rsi > 70)                       flags.push(`RSI ${track.rsi.toFixed(1)} was overbought at entry (>70 underperforms)`);
  if (track.rsi < 52 && outcome === 'LOSS') flags.push(`RSI ${track.rsi?.toFixed(1)} below 52 — bullish threshold not confirmed`);
  if ((track.vol_ratio ?? 0) < 1.0)         flags.push(`Volume ${track.vol_ratio}× below average at entry — weak confirmation`);
  if (track.market_regime === 'bear')        flags.push('Market regime was bearish — this signal underperforms in bear regimes');
  if (m1.drawdown_pct < -8)                 flags.push(`Touched -${Math.abs(m1.drawdown_pct.toFixed(1))}% before recovery — stop was appropriate`);
  const verdict = flags.length
    ? `${flags.length} flag${flags.length>1?'s':''} at entry: ${flags.join('; ')}.`
    : `Entry indicators were aligned — ${outcome === 'LOSS' ? 'market context worked against the setup' : 'all conditions confirmed the move'}.`;
  return `${track.signal_type} on ${track.sym} — ${outcome} (${m1.pnl_pct.toFixed(2)}% / ${m1.pnl_sar?.toFixed(0)} SAR). ${verdict}`;
}

// ── Insider Buy Auto-Fetcher ───────────────────────────────────────────────────
// Scrapes Argaam for news articles about directors/executives buying shares in
// their own company. Uses Arabic keyword matching to distinguish director
// transactions from institutional major-shareholding changes (CMA filings).

const INSIDER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ar,en;q=0.8',
  'Referer': 'https://www.argaam.com/',
};

const DIRECTOR_KW = ['عضو مجلس الإدارة','رئيس مجلس الإدارة','المدير التنفيذي','الرئيس التنفيذي','المدير العام','رئيس تنفيذي','عضو مجلس','رئيس مجلس'];
const BUY_KW      = ['اشترى','اشترت','اقتنى','اقتنت','تملّك','تملك','ابتاع'];

function parseInsiderArticle(html, fallbackDate) {
  const text = html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ');

  // Shares count is mandatory — no shares = not a transaction disclosure
  const sharesPat = /([\d,]{2,})\s*(?:سهم|أسهم)/g;
  const sharesArr = [...text.matchAll(sharesPat)].map(m => parseInt(m[1].replace(/,/g,'')));
  const shares    = sharesArr.length ? Math.max(...sharesArr) : 0;
  if (!shares) return null;  // no share count → skip (it's an interview/opinion)

  // Must contain a buy keyword within 300 chars of the shares figure
  let hasBuyNearShares = false;
  for (const bKw of BUY_KW) {
    const bIdx = text.indexOf(bKw);
    if (bIdx === -1) continue;
    const sIdx = text.search(/([\d,]{2,})\s*(?:سهم|أسهم)/);
    if (Math.abs(bIdx - sIdx) < 400) { hasBuyNearShares = true; break; }
  }
  if (!hasBuyNearShares) return null;

  // Must mention a director/executive role
  const hasDirector = DIRECTOR_KW.some(kw => text.includes(kw));
  if (!hasDirector) return null;

  // TASI 4-digit code
  const codeMatches = [...text.matchAll(/\b(\d{4})\b/g)].map(m => m[1]);
  const tasiCode    = codeMatches.find(c => +c >= 1010 && +c <= 9999);
  if (!tasiCode) return null;

  // Role + person name
  let role = 'Director', person = 'Unknown';
  for (const rKw of DIRECTOR_KW) {
    const idx = text.indexOf(rKw);
    if (idx === -1) continue;
    role = rKw;
    const before = text.slice(Math.max(0, idx - 80), idx).trim();
    const nameM  = before.match(/([^\d،,،]{4,35})\s*$/);
    if (nameM) { person = nameM[1].trim(); break; }
    const after  = text.slice(idx + rKw.length, idx + rKw.length + 80).trim();
    const nameM2 = after.match(/^[\s،,،]*([^\d،,،]{4,35}?)(?:\s+اشترى|\s+اقتنى|\s+في|\s+شركة|$)/);
    if (nameM2) { person = nameM2[1].trim(); break; }
    break;
  }
  if (!person || person.length < 3 || /^\d/.test(person)) person = 'Director';

  // Price
  const pricePat = /(\d{1,3}(?:\.\d{1,3})?)\s*(?:ريال|SAR|ر\.س)/g;
  const priceArr = [...text.matchAll(pricePat)].map(m => parseFloat(m[1]));
  const price    = priceArr.length ? priceArr[0] : 0;

  // Date from JSON-LD or <time>
  const datePat = /"datePublished"\s*:\s*"([^"]+)"|<time[^>]+datetime="([^"]+)"/;
  const dm      = html.match(datePat);
  const date    = dm
    ? (dm[1] || dm[2]).slice(0,10).replace(/\//g,'-')
    : (fallbackDate || new Date().toISOString().slice(0,10));

  // Company Arabic name from <h1>
  const h1M = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const name = h1M ? h1M[1].trim().slice(0,60) : `TADAWUL:${tasiCode}`;

  return {
    sym:    `TADAWUL:${tasiCode}`,
    name,
    person: person.slice(0,60),
    role:   role.slice(0,40),
    shares,
    price,
    value:  shares * price,
    date,
  };
}

// RSS feed slugs that carry company disclosure articles
const ARGAAM_RSS_FEEDS = [
  '/ar/rss/ho-main-news?sectionid=1523',
  '/ar/rss/breaking-news?sectionid=1585',
  '/ar/rss/companies?sectionid=1543',
];

async function fetchArgaamInsiderBuys() {
  const BASE     = 'https://www.argaam.com';
  const todayKSA = new Date(Date.now() + 3*3600000).toISOString().slice(0,10);
  const buys     = [];
  const seen     = new Set();
  const articleIds = new Set();

  // 1. Collect article IDs from RSS feeds
  for (const feed of ARGAAM_RSS_FEEDS) {
    try {
      const res = await fetch(`${BASE}${feed}`, { headers: INSIDER_HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const xml = await res.text();
      for (const m of xml.matchAll(/articledetail\/id\/(\d+)/g)) articleIds.add(m[1]);
    } catch(_) {}
  }

  // 2. Also scan the block-deal tag page since directors sometimes buy the same day
  try {
    const bdRes = await fetch(`${BASE}/ar/tags/id/24779/1/`, { headers: INSIDER_HEADERS, signal: AbortSignal.timeout(10000) });
    if (bdRes.ok) {
      const html = await bdRes.text();
      for (const m of html.matchAll(/articledetail\/id\/(\d+)/g)) articleIds.add(m[1]);
    }
  } catch(_) {}

  // 3. Fetch each article and filter for director buying content
  for (const articleId of [...articleIds].slice(0, 40)) {
    try {
      const aUrl = `${BASE}/ar/article/articledetail/id/${articleId}`;
      const aRes = await fetch(aUrl, { headers: INSIDER_HEADERS, signal: AbortSignal.timeout(12000) });
      if (!aRes.ok) continue;
      const aHtml = await aRes.text();

      const parsed = parseInsiderArticle(aHtml, todayKSA);
      if (!parsed) continue;

      const key = `${parsed.sym}|${parsed.person}|${parsed.date}`;
      if (seen.has(key)) continue;
      seen.add(key);

      buys.push({ ...parsed, source: 'argaam', source_url: aUrl, added: new Date().toISOString() });
      await new Promise(r => setTimeout(r, 300));
    } catch(_) {}
    if (buys.length >= 15) break;
  }
  return buys;
}

async function fetchTadawulInsiderDeals() {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'application/json,text/html',
    'Referer': 'https://www.saudiexchange.com.sa/',
  };
  const URLS = [
    'https://data.saudiexchange.com.sa/api/v1/announcements?type=insider&limit=30',
    'https://data.saudiexchange.com.sa/api/v1/announcements?category=insider_dealing&limit=30',
  ];
  const buys    = [];
  const todayKSA = new Date(Date.now() + 3*3600000).toISOString().slice(0,10);

  for (const url of URLS) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const data = await res.json();
      const rows = data.data || data.announcements || data.results || [];
      for (const row of rows) {
        const sym = row.symbol ? `TADAWUL:${row.symbol}` : null;
        if (!sym) continue;
        const direction = (row.transactionType || '').toLowerCase();
        if (!direction.includes('buy') && !direction.includes('purchase') && !direction.includes('acquire')) continue;
        buys.push({
          sym,
          name:    row.company || row.companyName || sym,
          person:  row.insiderName || row.personName || 'Director',
          role:    row.position || row.role || 'Insider',
          shares:  row.shares || row.quantity || 0,
          price:   row.price || 0,
          value:   (row.shares || 0) * (row.price || 0),
          date:    (row.date || row.filing_date || todayKSA).slice(0,10),
          source:  'tadawul',
          added:   new Date().toISOString(),
        });
      }
      if (buys.length) break;
    } catch(_) {}
  }
  return buys;
}

let insiderRefreshTs = 0;
const INSIDER_TTL = 4 * 3600 * 1000;

async function fetchAndStoreInsiderBuys() {
  const now = Date.now();
  if (now - insiderRefreshTs < INSIDER_TTL) {
    return { ok: true, skipped: true, message: 'Rate-limited — last refresh < 4h ago' };
  }
  insiderRefreshTs = now;

  let newCount = 0;
  const errors = [];
  const sources = [
    { name: 'Tadawul', fn: fetchTadawulInsiderDeals },
    { name: 'Argaam',  fn: fetchArgaamInsiderBuys   },
  ];

  for (const src of sources) {
    try {
      const buys = await src.fn();
      for (const b of buys) {
        try {
          if (!dbInsiderBuys.exists(b.sym, b.person, b.date)) {
            dbInsiderBuys.add(b);
            newCount++;
          }
        } catch(_) {}
      }
      if (newCount > 0) break;
    } catch(e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }

  return {
    ok: true,
    new_buys: newCount,
    errors:   errors.length ? errors : undefined,
    message:  newCount > 0
      ? `${newCount} new insider buy(s) found`
      : 'No new insider buys found — add manually if you have CMA data',
  };
}

// Auto-run at startup
fetchAndStoreInsiderBuys().catch(() => {});

// ── CMA Filing Fetcher ─────────────────────────────────────────────────────────
// Sources tried in order:
//   1. Argaam Arabic ownership-disclosure articles (same scraper pattern as block deals)
//   2. Saudi Exchange announcement search (HTML, non-JS-rendered path)
//   3. Manual entry (always available via POST /api/cma/filings/add)

const KNOWN_INSTITUTIONS = {
  'صندوق الاستثمارات العامة': 'Public Investment Fund (PIF)',
  'صندوق التقاعد': 'General Organization for Social Insurance (GOSI)',
  'مؤسسة التأمينات الاجتماعية': 'General Organization for Social Insurance (GOSI)',
  'بنك الراجحي': 'Al Rajhi Bank',
  'شركة أرامكو': 'Saudi Aramco',
  'بنك الأهلي': 'SNB (Saudi National Bank)',
  'مجموعة سلامة': 'Salama Insurance',
  'صناديق الاستثمار': 'Investment Funds',
  'سنابل': 'Sanabil Investments (PIF)',
  'الشركة الوطنية': 'National Company',
};

function mapInstitution(arabicName) {
  for (const [ar, en] of Object.entries(KNOWN_INSTITUTIONS)) {
    if (arabicName && arabicName.includes(ar)) return en;
  }
  return null;
}

// Resolve a company Arabic name to a TASI sym via the scan universe
function resolveSymFromName(arabicName, scanResults) {
  if (!arabicName || !scanResults?.length) return null;
  const clean = arabicName.replace(/\s+/g,' ').trim();
  for (const r of scanResults) {
    if (r.ar && clean.includes(r.ar.substring(0,6))) return r.sym;
    if (r.name && clean.toLowerCase().includes(r.name.toLowerCase().substring(0,6))) return r.sym;
  }
  return null;
}

// Parse a single CMA filing from Arabic article HTML
function parseCMAFilingHtml(html, fallbackDate) {
  const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g,' ');

  // Direction keywords (Arabic)
  const boughtKw = ['اشترى','اشترت','اقتنى','اقتنت','أضاف','أضافت','ارتفعت','زيادة','رفعت','يمتلك الآن'];
  const soldKw   = ['باع','باعت','تخلص','تخلصت','خفض','خفضت','انخفضت','نقصت','تراجعت'];
  const pledgeKw = ['رهن','رهنت','تعهد'];

  const hasBought = boughtKw.some(kw => text.includes(kw));
  const hasSold   = soldKw.some(kw => text.includes(kw));
  const hasPledge = pledgeKw.some(kw => text.includes(kw));

  let direction = 'unknown';
  if (hasBought && !hasSold)   direction = 'buy';
  else if (hasSold && !hasBought) direction = 'sell';
  else if (hasPledge && !hasBought && !hasSold) direction = 'pledge';
  else if (hasBought) direction = 'buy'; // prefer buy if ambiguous

  // Extract percentages — CMA filings always list prev% and new%
  // Accepts both Arabic ٪ and Latin %
  const pctPat = /(\d{1,2}(?:[.,]\d{1,4})?)\s*(?:%|٪)/g;
  const pcts = [...text.matchAll(pctPat)]
    .map(m => parseFloat(m[1].replace(',','.')))
    .filter(p => p > 0 && p < 100);

  let prev_pct = null, new_pct = null;
  if (pcts.length >= 2) {
    // Direction-based assignment: higher % → result of buy; lower → result of sell
    if (direction === 'buy') {
      prev_pct = Math.min(...pcts.slice(0,3));
      new_pct  = Math.max(...pcts.slice(0,3));
    } else if (direction === 'sell') {
      prev_pct = Math.max(...pcts.slice(0,3));
      new_pct  = Math.min(...pcts.slice(0,3));
    } else {
      [prev_pct, new_pct] = pcts;
    }
  } else if (pcts.length === 1) {
    new_pct = pcts[0];
  }

  // Extract institution name — text before the action verb
  let institution = null;
  for (const kw of [...boughtKw, ...soldKw]) {
    const idx = text.indexOf(kw);
    if (idx > 20) {
      // Take the 40 chars before the verb, clean up
      const before = text.slice(Math.max(0, idx - 60), idx).trim();
      // Find last noun-phrase (after "أن" or "شركة" or at word boundary)
      const m = before.match(/(?:أن\s+|شركة\s+|صندوق\s+|مؤسسة\s+)(.{5,50})$/);
      institution = m ? m[1].trim() : before.slice(-40).trim();
      break;
    }
  }

  // Extract date from article JSON-LD or <time> tag
  const datePat = /"datePublished"\s*:\s*"([^"]+)"|<time[^>]+datetime="([^"]+)"/;
  const dm = html.match(datePat);
  const filing_date = dm
    ? (dm[1]||dm[2]).slice(0,10).replace(/\//g,'-')
    : (fallbackDate || new Date().toISOString().slice(0,10));

  // Extract shares changed (look for numbers followed by سهم/أسهم)
  const sharesPat = /([\d,]+)\s+سهم/g;
  const sharesMatches = [...text.matchAll(sharesPat)].map(m => parseInt(m[1].replace(/,/g,'')));
  const shares_delta = sharesMatches.length > 0
    ? (direction === 'buy' ? 1 : -1) * Math.max(...sharesMatches)
    : null;

  return { direction, institution, institution_en: mapInstitution(institution),
           prev_pct, new_pct, shares_delta, filing_date,
           raw_text: text.slice(0, 500) };
}

async function fetchArgaamCMAFilings() {
  const BASE    = 'https://www.argaam.com';
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'ar,en;q=0.8',
    'Referer': 'https://www.argaam.com/',
  };
  const todayKSA = new Date(Date.now() + 3 * 3600000).toISOString().slice(0,10);

  // Argaam tag IDs for CMA ownership disclosures
  // Tag 24779 = block deals (known). Tag 24780 and nearby cover ownership changes.
  // We try several candidate IDs and use whichever returns relevant articles.
  const CANDIDATE_TAGS = [
    { id: 1055, slug: '%D8%A5%D9%81%D8%B5%D8%A7%D8%AD%D8%A7%D8%AA' },       // إفصاحات
    { id: 24780, slug: '%D9%85%D9%84%D9%83%D9%8A%D8%A9' },                    // ملكية
    { id: 1050, slug: '%D8%A7%D9%84%D9%85%D8%B3%D8%A7%D9%87%D9%85%D9%88%D9%86' }, // المساهمون
  ];

  const filings = [];
  const seenKeys = new Set();

  for (const tag of CANDIDATE_TAGS) {
    try {
      const tagUrl = `${BASE}/ar/tags/id/${tag.id}/1/${tag.slug}`;
      const res = await fetch(tagUrl, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
      if (!res.ok) continue;
      const tagHtml = await res.text();

      // Only proceed if this tag page contains ownership-related Arabic keywords
      const isOwnershipTag = ['ملكية','مساهم','إفصاح','حصة'].some(kw => tagHtml.includes(kw));
      if (!isOwnershipTag) continue;

      // Extract article IDs
      const ids = [...new Set([...tagHtml.matchAll(/\/ar\/article\/articledetail\/id\/(\d+)/g)].map(m=>m[1]))];
      if (!ids.length) continue;

      for (const articleId of ids.slice(0, 10)) {
        try {
          const aUrl = `${BASE}/ar/article/articledetail/id/${articleId}`;
          const aRes = await fetch(aUrl, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
          if (!aRes.ok) continue;
          const aHtml = await aRes.text();

          // Article relevance: must contain ownership-related terms
          const isOwnershipArticle = ['ملكية','إفصاح','حصة','مساهم'].some(kw => aHtml.includes(kw));
          if (!isOwnershipArticle) continue;

          // Extract company sym from article — look for stock codes
          const codeMatches = [...aHtml.matchAll(/\b(\d{4})\b/g)].map(m=>m[1]);
          const tasiCode = codeMatches.find(c => parseInt(c) >= 1010 && parseInt(c) <= 9999);
          const sym = tasiCode ? `TADAWUL:${tasiCode}` : null;
          if (!sym) continue;

          // Extract company Arabic name
          const arNameMatch = aHtml.match(/<h1[^>]*>([^<]+)<\/h1>/i);
          const company_ar = arNameMatch ? arNameMatch[1].trim() : null;

          const parsed = parseCMAFilingHtml(aHtml, todayKSA);
          const key = `${sym}|${parsed.institution}|${parsed.filing_date}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          if (parsed.direction !== 'unknown' && parsed.filing_date) {
            filings.push({
              sym, company_ar, ...parsed,
              source: 'argaam', source_url: aUrl, verified: 0,
            });
          }
          await new Promise(r => setTimeout(r, 300));
        } catch (_) {}
      }
      if (filings.length >= 10) break;
      await new Promise(r => setTimeout(r, 500));
    } catch (_) {}
  }

  return filings;
}

// Saudi Exchange announcement scraper for "Major Shareholding" disclosures
async function fetchTadawulCMAFilings() {
  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/json',
    'Accept-Language': 'en,ar;q=0.8',
    'Referer': 'https://www.saudiexchange.com.sa/',
  };
  // Saudi Exchange announcement search for Major Shareholding type (type code varies by year)
  // Try their open data endpoint
  const URLS = [
    'https://www.saudiexchange.com.sa/wps/portal/tadawul/market-participants/investors/shareholding-disclosure/',
    'https://data.saudiexchange.com.sa/api/v1/announcements?type=shareholding&limit=20',
  ];

  const filings = [];
  const todayKSA = new Date(Date.now() + 3 * 3600000).toISOString().slice(0,10);

  for (const url of URLS) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      const body = await res.text();

      // Try JSON parse first
      try {
        const data = JSON.parse(body);
        const rows = data.data || data.announcements || data.results || [];
        for (const row of rows) {
          const sym = row.symbol ? `TADAWUL:${row.symbol}` : null;
          if (!sym) continue;
          const direction = row.change > 0 ? 'buy' : row.change < 0 ? 'sell' : 'unknown';
          filings.push({
            sym,
            company: row.company || row.name || null,
            institution: row.shareholder || row.holder || 'Unknown',
            prev_pct: row.previousPercentage ?? null,
            new_pct:  row.newPercentage ?? null,
            direction,
            filing_date: (row.date||row.filing_date||todayKSA).slice(0,10),
            source: 'tadawul', source_url: url, verified: 1,
          });
        }
        if (filings.length) break;
      } catch (_) {
        // Not JSON — try HTML parsing
        // Look for table rows with stock codes and ownership percentages
        const rowPat = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
        let m;
        while ((m = rowPat.exec(body)) !== null) {
          const cells = [...m[1].matchAll(/<td[^>]*>([^<]+)<\/td>/g)].map(c=>c[1].trim());
          if (cells.length < 4) continue;
          const codeCell = cells.find(c => /^\d{4}$/.test(c));
          if (!codeCell) continue;
          const pcts = cells.filter(c => /^\d{1,2}\.\d+$/.test(c)).map(Number);
          if (pcts.length < 2) continue;
          const direction = pcts[1] > pcts[0] ? 'buy' : 'sell';
          filings.push({
            sym: `TADAWUL:${codeCell}`,
            institution: cells[1] || 'Unknown',
            prev_pct: pcts[0], new_pct: pcts[1], direction,
            filing_date: todayKSA, source: 'tadawul', source_url: url, verified: 0,
          });
        }
        if (filings.length) break;
      }
    } catch (_) {}
  }
  return filings;
}

let cmaRefreshTs = 0;
const CMA_REFRESH_TTL = 4 * 3600 * 1000; // refresh at most every 4 hours

async function fetchAndStoreCMAFilings() {
  const now = Date.now();
  if (now - cmaRefreshTs < CMA_REFRESH_TTL) {
    return { ok: true, skipped: true, message: 'Rate-limited — last refresh < 4h ago' };
  }
  cmaRefreshTs = now;

  let newCount = 0;
  const errors = [];

  // Try Tadawul first (structured), then Argaam (NLP scraping)
  const sources = [
    { name: 'Tadawul', fn: fetchTadawulCMAFilings },
    { name: 'Argaam',  fn: fetchArgaamCMAFilings  },
  ];

  for (const src of sources) {
    try {
      const filings = await src.fn();
      for (const f of filings) {
        try {
          if (!dbCMA.exists(f.sym, f.institution||'Unknown', f.filing_date)) {
            dbCMA.insert(f);
            newCount++;
          }
        } catch (_) {}
      }
      if (newCount > 0) break; // first source that yields data wins
    } catch (e) {
      errors.push(`${src.name}: ${e.message}`);
    }
  }

  return {
    ok: true, new_filings: newCount,
    errors: errors.length ? errors : undefined,
    message: newCount > 0 ? `${newCount} new CMA filings stored` : 'No new filings found — use manual entry if you have CMA data',
  };
}

// Auto-refresh CMA filings once per day at startup and after each scan
fetchAndStoreCMAFilings().catch(() => {});

server.listen(PORT, () => {
  console.log(`\n  TASI Strategy Dashboard`);
  console.log(`  http://localhost:${PORT}\n`);
});
