/**
 * Scanner Engine — the core scanning workflow.
 *
 * KhanSaab Sniper best-practice (from indicator author):
 *   1. Check trend on higher TFs first (4H → 1H → 30m → 15m)
 *   2. Execute on asset-specific lower TFs:
 *      - Crypto/Gold scalp: 1m/3m/5m | Intraday: 5m/15m
 *      - Stocks intraday: 5m (with 15/30/1H/4H trend confirmation)
 *      - Commodities: 5m primary
 *      - Conservative: 15m
 *   3. Always use SMC indicator alongside for S&R / order blocks
 *   4. VWAP is key magnet/S&R for liquid instruments
 */

import * as bridge from './tv-bridge.js';
import { detectFormations, checkVolumeConfirmation } from './formation-detector.js';
import { detectRSIDivergence, detectSqueeze, analyzeCDV, parseSMCLabels, getVolatilityRegime, calculateStochRSI, getCategorySLBoost, parseSMCBoxes, parseSMCLines, calcTechnicals } from './calculators.js';
import { gradeShortTermSignal, gradeLongTermSignal } from './signal-grader.js';
import { getMacroState, applyMacroFilter, formatMacroSummary } from './macro-filter.js';
import { classifyRegime } from './learning/regime-detector.js';
// Faz 1 İter 2 — shadow-only rejim modülü (sinyal akışına bağlı DEĞİL)
import { computeRegime as _shadowComputeRegime } from './learning/compute-regime.js';
import { logRegime as _shadowLogRegime } from './learning/regime-shadow-logger.js';
import { categoryToMarketType as _shadowCategoryToMarketType } from './learning/regime-profiles.js';
// Risk #5 — Parser kirilma korumasi (sema validation + alarm counter)
import { gateTechnicals, gateSMC } from './parser-validator.js';
import { recordSignal } from './learning/signal-tracker.js';
import { loadWeights } from './learning/weight-adjuster.js';
import { resolveSymbol, inferCategory } from './symbol-resolver.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Global chart mutex — only ONE process can use TradingView chart at a time ---
// This prevents scheduler, manual scans, macro checks, and learning loop from
// interfering with each other on the single TradingView chart window.
let _scanActive = false;
let _lockHolder = null;
let _lockQueue = [];

export function isScanActive() { return _scanActive; }
export function getLockHolder() { return _lockHolder; }

/**
 * Acquire the chart mutex. Only ONE holder can have it at a time.
 * Others wait in a FIFO queue until the current holder releases.
 * Optional timeout (ms) — rejects if lock not acquired within timeout.
 */
export function acquireScanLock(holder = 'unknown', timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let timer = null;

    const tryAcquire = () => {
      if (timedOut) return; // Already timed out, don't acquire
      if (!_scanActive) {
        if (timer) clearTimeout(timer);
        _scanActive = true;
        _lockHolder = holder;
        console.log(`[Lock] Chart kilidi alindi: ${holder}`);
        resolve();
      } else {
        console.log(`[Lock] Chart mesgul (${_lockHolder}), kuyrukta bekliyor: ${holder}`);
        _lockQueue.push({ tryAcquire, reject });
      }
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        const idx = _lockQueue.findIndex(w => w.tryAcquire === tryAcquire);
        if (idx >= 0) _lockQueue.splice(idx, 1);
        reject(new Error(`[Lock] Timeout: ${holder} ${timeoutMs}ms bekledikten sonra kilidi alamadi (mevcut: ${_lockHolder})`));
      }, timeoutMs);
    }

    tryAcquire();
  });
}

export function releaseScanLock() {
  const prev = _lockHolder;
  _scanActive = false;
  _lockHolder = null;
  console.log(`[Lock] Chart kilidi birakildi: ${prev || 'unknown'}`);
  // Wake up next in queue
  if (_lockQueue.length > 0) {
    const waiter = _lockQueue.shift();
    setTimeout(waiter.tryAcquire, 50);
  }
}

/**
 * Drain the lock queue — reject all waiting lock requests.
 * Called when scheduler is fully stopped to prevent orphaned waiters.
 */
export function drainLockQueue() {
  const drained = _lockQueue.length;
  const queue = _lockQueue.splice(0);
  for (const waiter of queue) {
    try { waiter.reject(new Error('[Lock] Kuyruk temizlendi — scheduler durduruldu')); } catch {}
  }
  if (drained > 0) {
    console.log(`[Lock] Kuyruk temizlendi: ${drained} bekleyen istek iptal/reject edildi`);
  }
  return drained;
}
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

// --- Timeframe presets by asset class ---
//
// KISA VADE:
//   EXEC_TFS  = giris yeri tespiti (tam veri toplama + grading): 15m, 30m, 45m
//   TREND_TFS = trend tespiti (study values + yon): 1H, 4H, 1D, 3D
//   1m/3m/5m kaldirildi — gurultu cok, sinyal kalitesi dusuk.
//
// UZUN VADE:
//   LONG_ENTRY_TF = giris yeri tespiti: 1D
//   LONG_TERM_TFS = trend tespiti: 1D, 3D, 1W, 1M
//   Trend yonu disinda trade onerilmez.
// HTF alignment: 1D sert kapi, 1W bilgilendirici (2026-04-23).
// 1h/4h trend teyidi EXEC_TFS icinde dogal olarak gerceklesiyor.
const TREND_TFS = {
  crypto:    ['1D', '1W'],
  kripto:    ['1D', '1W'],
  emtia:     ['1D', '1W'],
  abd_hisse: ['1D', '1W'],
  forex:     ['1D', '1W'],
  bist:      ['1D', '1W'],
  default:   ['1D', '1W'],
};

// NOT: 45m TF, COINBASE / BINANCE / TVC gibi feedlerde sik sik bos / contaminated
// bar dondurdugu icin kripto/emtia/forex/default icin kapali. Sonuc: signal-grader
// entry deviation > 50% kontrolunden gecemiyor ve HATA grade'iyle dusuyordu.
// Spec (CLAUDE.md "kisa vadeli trade tarama") "15m, 30m ve 1h" diyor — 60m zaten
// TREND_TFS icinde.
//
// abd_hisse + bist (2026-04-18 guncellemesi): 30m TF kapatildi.
// Canli veride 30m WR %17 / PF 0.34 / exp -0.53R — kategori ne olursa olsun
// 30m hisse sinyalleri zarar ettiriyor. Hisse feedleri (NASDAQ/NYSE/BIST) kripto
// feedleri gibi bar contamination sorunu yasamadigi icin 45m guvenli, ayrica
// 45m real WR %12.5 olsa bile PF 2.2 (kazananlar buyuk). Trend teyidi TREND_TFS
// tarafindan saglaniyor (60m/4H/1D) — degismedi.
// 2026-04-23: 15m/30m/45m kapatildi. Canli gozlemde kisa TF'lerde seviyeler
// birbirine cok yakin, kucuk sarsilmalar SL tetikliyor ve net zarar birikiyor.
// 1h + 4h sinyalleri daha az ama daha kaliteli pozisyon uretmek icin tercih edildi.
const EXEC_TFS = {
  crypto:    ['60', '240'],
  kripto:    ['60', '240'],
  emtia:     ['60', '240'],
  abd_hisse: ['60', '240'],
  forex:     ['60', '240'],
  bist:      ['60', '240'],
  default:   ['60', '240'],
};

const LONG_TERM_TFS = ['1D', '3D', '1W', '1M'];
const LONG_ENTRY_TF = '1D';

/**
 * Determine asset category from symbol name.
 */
function getAssetCategory(symbol) {
  const s = symbol.toUpperCase();
  // Strip exchange prefix
  const bare = s.includes(':') ? s.split(':')[1] : s;

  if (['XAUUSD', 'XAGUSD', 'COPPER'].some(c => bare.includes(c))) return 'emtia';
  if (['EURUSD', 'EURCHF', 'GBPUSD', 'USDJPY', 'AUDUSD'].some(f => bare.includes(f))) return 'forex';
  if (['BTC', 'ETH', 'XRP', 'SOL', 'SUI', 'LINK', 'HYPE', 'DOGE', 'ADA', 'AVAX', 'DOT', 'MON', 'PEPE', 'RENDER', 'USDT.D', 'BTC.D'].some(c => bare.includes(c))) return 'crypto';

  // Check rules.json watchlist membership (exact match — substring match yanlis kategoriler
  // veriyordu: 'PGSUS'.includes('PG') BIST tickerini 'abd_hisse'ye dusuruyordu).
  try {
    const rules = loadRules();
    for (const [cat, syms] of Object.entries(rules.watchlist || {})) {
      if (syms.some(ws => String(ws).toUpperCase() === bare)) return cat;
    }
  } catch {}

  return 'default';
}

/**
 * Scanner-engine'in dahili getAssetCategory ciktisini ('crypto'|'emtia'|'forex'|'abd_hisse'|...)
 * symbol-resolver'in bekledigi kategori adlarina ('kripto'|'emtia'|'forex'|'abd_hisse'|...)
 * cevirir. Bilinmeyen kategorilerde rules.json watchlist'inden inferCategory kullanilir.
 */
function resolveChartSymbol(symbol) {
  if (!symbol) return symbol;
  if (String(symbol).includes(':')) return symbol; // Zaten prefix'li

  const bare = String(symbol).toUpperCase();
  let cat = getAssetCategory(bare);
  // 'crypto' → 'kripto', 'default' → watchlist'ten infer
  if (cat === 'crypto') cat = 'kripto';
  if (cat === 'default' || !cat) {
    try {
      const rules = loadRules();
      cat = inferCategory(bare, rules?.watchlist) || null;
    } catch {
      cat = null;
    }
  }
  return resolveSymbol(bare, cat);
}

/**
 * Get execution TFs for a symbol based on its asset class.
 */
function getExecTFs(symbol) {
  const cat = getAssetCategory(symbol);
  return EXEC_TFS[cat] || EXEC_TFS.default;
}

/**
 * Get trend confirmation TFs for a symbol based on its asset class.
 */
function getTrendTFs(symbol) {
  const cat = getAssetCategory(symbol);
  return TREND_TFS[cat] || TREND_TFS.default;
}

function loadRules() {
  return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function tfLabel(tf) {
  const labels = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '45': '45m', '60': '1H', '120': '2H', '240': '4H', '1D': '1D', '3D': '3D', '1W': '1W', '1M': '1M' };
  return labels[tf] || tf;
}

/**
 * Scan a single timeframe for short-term data (KhanSaab + SMC).
 * Returns raw collected data for that TF.
 */
async function collectShortTermData(symbol, tf) {
  const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const chartSymbol = resolveChartSymbol(symbol);

  // Take bar snapshot BEFORE switching symbol/TF — used to detect data change
  const prevSnapshot = await bridge.getBarSnapshot().catch(() => null);

  const symResult = await bridge.setSymbol(chartSymbol);
  if (symResult.success === false) {
    throw new Error(`Sembol degistirilemedi: ${chartSymbol} — ${symResult.warning || 'bilinmeyen hata'}`);
  }
  await bridge.setTimeframe(tf);

  // DATA-LEVEL wait: wait for bars collection to actually change (replaces fixed sleep(3000))
  const dataChangeResult = await bridge.waitForDataChange(prevSnapshot, 10000);
  if (!dataChangeResult.changed) {
    console.log(`[Scanner] ${symbol} TF${tf}: Bar verisi degismedi (10s timeout) — yeniden deneniyor`);
    await sleep(2000);
  }

  // CRITICAL: Verify chart is ACTUALLY showing our symbol BEFORE reading any data.
  // EXACT bare-symbol match (no .includes) — "BA" must not pass as "BABA" / "BA.L" / "BIST:BA".
  const bareExpected = bareSymbol.toUpperCase();
  const preBare = await bridge.getCurrentBareSymbol().catch(() => null);
  if (preBare && preBare !== bareExpected) {
    console.log(`[Scanner] ${symbol} TF${tf}: Chart yanlis sembolde (${preBare}) — yeniden degistiriliyor`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    await sleep(4000);
    const recheck = await bridge.getCurrentBareSymbol().catch(() => null);
    if (recheck && recheck !== bareExpected) {
      throw new Error(`Sembol dogrulanamadi: istenen=${bareExpected}, chart=${recheck} — veri GUVENILMEZ, atlaniyor`);
    }
  }

  // Get quote price first for validation (independent of TF) — guard with expectedSymbol
  const quotePrice = await bridge.getQuote(chartSymbol).then(q => (q && !q._symbolMismatch ? q.close : null)).catch(() => null);

  let [ohlcvData, studyValues, smc] = await Promise.all([
    bridge.getOhlcvValidated(100, tf, chartSymbol).catch(() => null),
    bridge.getStudyValues().catch(() => null),
    bridge.readSMC().catch(() => ({ labels: null, boxes: null, lines: null })),
  ]);

  // Guard: if OHLCV reported a symbol mismatch, abort — do NOT use contaminated bars
  if (ohlcvData && ohlcvData.symbolMismatch) {
    throw new Error(`${symbol} TF${tf}: OHLCV okuma aninda chart sembolu ${ohlcvData._got}, beklenen ${ohlcvData._expected} — veri CONTAMINATED`);
  }

  // If OHLCV is stale (last bar too old for this TF), retry once
  if (ohlcvData?.stale) {
    console.log(`[Scanner] ${symbol} TF${tf}: Bar verisi stale (yas: ${ohlcvData.lastBarAge}s) — 3s bekleyip yeniden yukluyor`);
    await sleep(3000);
    ohlcvData = await bridge.getOhlcvValidated(100, tf).catch(() => ohlcvData);
    if (ohlcvData?.stale) {
      console.log(`[Scanner] ${symbol} TF${tf}: UYARI — bar verisi hala stale (yas: ${ohlcvData.lastBarAge}s), devam ediliyor`);
    }
  }

  // POST-READ: Verify chart symbol AGAIN — exact match (not includes).
  const postBare = await bridge.getCurrentBareSymbol().catch(() => null);
  if (postBare && postBare !== bareExpected) {
    throw new Error(`Veri okuma sirasinda sembol degismis: istenen=${bareExpected}, simdi=${postBare} — veri CONTAMINATED`);
  }

  // Validate OHLCV matches current symbol (compare against quote price)
  // Category-based deviation threshold: crypto/commodities %8, stocks/forex %5
  const _catBoost = getCategorySLBoost(symbol);
  const maxDeviation = _catBoost >= 1.15 ? 0.08 : 0.05;

  if (ohlcvData && ohlcvData.bars && ohlcvData.bars.length > 0 && quotePrice && quotePrice > 0) {
    const lastClose = ohlcvData.bars[ohlcvData.bars.length - 1].close;
    const deviation = Math.abs(lastClose - quotePrice) / quotePrice;
    if (deviation > maxDeviation) {
      // OHLCV data likely stale or for wrong symbol — retry with validated fetch
      console.log(`[Scanner] ${symbol} TF${tf}: OHLCV sapma %${(deviation * 100).toFixed(1)} > esik %${(maxDeviation * 100).toFixed(0)} (bar: ${lastClose}, quote: ${quotePrice}) — yeniden yukluyor`);
      await sleep(4000);
      const retryOhlcv = await bridge.getOhlcvValidated(100, tf).catch(() => null);
      if (retryOhlcv?.bars?.length > 0) {
        const retryClose = retryOhlcv.bars[retryOhlcv.bars.length - 1].close;
        const retryDev = Math.abs(retryClose - quotePrice) / quotePrice;
        if (retryDev < maxDeviation) {
          ohlcvData.bars = retryOhlcv.bars;
          ohlcvData.total_bars = retryOhlcv.total_bars;
        } else if (retryOhlcv.stale) {
          throw new Error(`${symbol} TF${tf}: Bar verisi stale (yas: ${retryOhlcv.lastBarAge}s) ve sapma %${(retryDev * 100).toFixed(1)} — veri GUVENILMEZ`);
        } else {
          throw new Error(`${symbol} TF${tf}: Fiyat dogrulanamadi (bar=${retryClose}, quote=${quotePrice}, sapma=%${(retryDev * 100).toFixed(1)}) — veri GUVENILMEZ`);
        }
      }
    }
  }

  const bars = ohlcvData?.bars || [];
  // Risk #5 — Parser kirilma korumasi: parse sonrasi sema dogrulamasi.
  // 'broken' (>=50% required eksik) → null doner, mevcut akis BEKLE'ye duser.
  // 'partial' → veri gecer ama parser_alarm log dusturulur.
  const parsedKS = gateTechnicals(calcTechnicals(bars), { symbol, timeframe: tf });
  const parsedSMC = gateSMC(parseSMCLabels(smc.labels), { symbol, timeframe: tf });
  // ATR-aware FVG/OB ayrimi icin atr ge geçir (parsedKS.atr veya KhanSaab study).
  const _atrForBoxes = parsedKS?.atr != null ? parsedKS.atr : parseFloat(extractATRFromStudy(studyValues));
  const parsedBoxes = parseSMCBoxes(smc.boxes, { atr: isFinite(_atrForBoxes) ? _atrForBoxes : null });
  const parsedSRLines = parseSMCLines(smc.lines);

  const formation = detectFormations(bars, { timeframe: tf });
  const volConfirm = checkVolumeConfirmation(bars);
  const rsiVal = parsedKS?.rsi || extractRSIFromStudy(studyValues);
  const divergence = detectRSIDivergence(bars, rsiVal);
  const atrVal = extractATRFromStudy(studyValues);
  const squeeze = detectSqueeze(bars, atrVal);
  const cdv = analyzeCDV(bars);

  const emaValue = parsedKS?.ema21 || extractEMAFromStudy(studyValues) || null;
  const stochRSI = calculateStochRSI(bars, { emaValue });

  return {
    tf,
    ohlcv: ohlcvData,
    studyValues,
    khanSaab: parsedKS,
    smc: parsedSMC,
    rawSMC: smc,
    parsedBoxes,
    smcSRLines: parsedSRLines,
    khanSaabLabels: null,
    quotePrice,
    formation,
    volConfirm,
    divergence,
    squeeze,
    cdv,
    stochRSI,
    bars,
  };
}

/**
 * Scan a single timeframe for long-term data (Supertrend + IFCCI).
 */
async function collectLongTermData(symbol, tf) {
  const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const chartSymbol = resolveChartSymbol(symbol);

  const symResult = await bridge.setSymbol(chartSymbol);
  if (symResult.success === false) {
    throw new Error(`Sembol degistirilemedi: ${chartSymbol}`);
  }
  await bridge.setTimeframe(tf);
  await sleep(3000);

  // Exact bare-symbol verification
  const bareExpected = bareSymbol.toUpperCase();
  const preBare = await bridge.getCurrentBareSymbol().catch(() => null);
  if (preBare && preBare !== bareExpected) {
    console.log(`[Scanner] ${symbol} TF${tf}: Chart yanlis sembolde (${preBare}) — retry`);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    await sleep(4000);
    const recheck = await bridge.getCurrentBareSymbol().catch(() => null);
    if (recheck && recheck !== bareExpected) {
      throw new Error(`Sembol dogrulanamadi (LTF): istenen=${bareExpected}, chart=${recheck}`);
    }
  }

  const [ohlcvData, studyValues] = await Promise.all([
    bridge.getOhlcv(100, false, chartSymbol).catch(() => null),
    bridge.getStudyValues().catch(() => null),
  ]);

  if (ohlcvData && ohlcvData._symbolMismatch) {
    throw new Error(`${symbol} TF${tf} (LTF): OHLCV symbol mismatch, beklenen ${ohlcvData._expected}, alinan ${ohlcvData._got}`);
  }

  // Post-read verification — exact match
  const postBare = await bridge.getCurrentBareSymbol().catch(() => null);
  if (postBare && postBare !== bareExpected) {
    throw new Error(`Veri okuma sirasinda sembol degismis: istenen=${bareExpected}, simdi=${postBare}`);
  }

  const bars = ohlcvData?.bars || [];
  const formation = detectFormations(bars, { timeframe: tf });

  return { tf, ohlcv: ohlcvData, studyValues, formation, bars };
}

/**
 * Quick trend check on a higher TF — only reads study values + EMA direction.
 * Returns { direction: 'long'|'short'|'neutral', confidence, reasoning }
 */
async function quickTrendCheck(symbol, tf) {
  try {
    const bareSymbol = symbol.includes(':') ? symbol.split(':')[1] : symbol;
    const chartSymbol = resolveChartSymbol(symbol);
    await bridge.setSymbol(chartSymbol);
    await bridge.setTimeframe(tf);
    await sleep(2500);

    // Verify symbol before reading
    const currentSym = await bridge.getChartState().then(s => s?.symbol).catch(() => null);
    if (currentSym && !currentSym.toUpperCase().includes(bareSymbol.toUpperCase())) {
      return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} sembol dogrulanamadi (${currentSym})`] };
    }

    const ohlcvData = await bridge.getOhlcv(100, false).catch(() => null);
    const bars = ohlcvData?.bars || [];
    const parsedKS = calcTechnicals(bars);
    let longVotes = 0, shortVotes = 0;
    const reasons = [];

    // EMA direction
    if (parsedKS?.emaStatus === 'BULL') { longVotes += 2; reasons.push(`${tfLabel(tf)} EMA BULL`); }
    else if (parsedKS?.emaStatus === 'BEAR') { shortVotes += 2; reasons.push(`${tfLabel(tf)} EMA BEAR`); }

    // MACD direction
    if (parsedKS?.macd === 'BULL') { longVotes += 1; reasons.push(`${tfLabel(tf)} MACD BULL`); }
    else if (parsedKS?.macd === 'BEAR') { shortVotes += 1; reasons.push(`${tfLabel(tf)} MACD BEAR`); }

    const total = longVotes + shortVotes;
    if (total === 0) return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} trend belirsiz`] };

    const direction = longVotes > shortVotes ? 'long' : longVotes < shortVotes ? 'short' : 'neutral';
    const confidence = total > 0 ? Math.max(longVotes, shortVotes) / total : 0;
    return { direction, confidence: Math.round(confidence * 100), reasoning: reasons };
  } catch {
    return { direction: 'neutral', confidence: 0, reasoning: [`${tfLabel(tf)} trend okunamadi`] };
  }
}

/**
 * Short-term MULTI-TIMEFRAME scan for a single symbol.
 *
 * KhanSaab approach:
 *   Phase 1: Quick trend check on 4H + 1H (establish direction)
 *   Phase 2: Full scan on asset-specific execution TFs (5m/15m/30m)
 *   Phase 3: Grade each TF, apply trend filter, pick best signal
 */
export async function scanShortTerm(symbol, options = {}) {
  await acquireScanLock(`short:${symbol}`);
  try {
    return await _scanShortTermInner(symbol, options);
  } finally {
    releaseScanLock();
  }
}

async function _scanShortTermInner(symbol, options = {}) {
  const singleTF = options.singleTF;
  const execTFs = options.timeframes || getExecTFs(symbol);
  const tfsToScan = singleTF ? [singleTF] : execTFs;
  const category = getAssetCategory(symbol);
  const abortCheck = options.abortCheck || (() => false);

  const tfResults = {};
  const tfSignals = [];

  // Setup indicators (check KhanSaab + SMC are present)
  let indicatorSetup;
  try {
    indicatorSetup = await bridge.setupIndicatorsForScan('short');
  } catch { indicatorSetup = { warnings: [] }; }

  // --- Phase 1: Quick trend check on higher TFs (asset-specific) ---
  const assetTrendTFs = getTrendTFs(symbol);
  let higherTFTrend = null;
  if (!singleTF) {
    const trendResults = [];
    for (const trendTF of assetTrendTFs) {
      if (abortCheck()) { console.log(`[Scanner] ${symbol} trend taramasi iptal edildi`); break; }
      const trend = await quickTrendCheck(symbol, trendTF);
      trendResults.push({ tf: trendTF, ...trend });
    }

    // Aggregate trend direction from higher TFs
    const longTrend = trendResults.filter(t => t.direction === 'long').length;
    const shortTrend = trendResults.filter(t => t.direction === 'short').length;
    const avgConfidence = trendResults.length > 0 ? trendResults.reduce((s, t) => s + t.confidence, 0) / trendResults.length : 0;

    if (longTrend > shortTrend) {
      higherTFTrend = { direction: 'long', confidence: Math.round(avgConfidence), details: trendResults };
    } else if (shortTrend > longTrend) {
      higherTFTrend = { direction: 'short', confidence: Math.round(avgConfidence), details: trendResults };
    } else {
      higherTFTrend = { direction: 'neutral', confidence: 0, details: trendResults };
    }
  }

  // --- Phase 2: Full scan on execution TFs ---
  for (const tf of tfsToScan) {
    if (abortCheck()) { console.log(`[Scanner] ${symbol} exec taramasi iptal edildi`); break; }
    try {
      const data = await collectShortTermData(symbol, tf);
      tfResults[tf] = data;
    } catch (e) {
      tfResults[tf] = { tf, error: e.message };
    }
  }

  // Get macro filter (once for all TFs) — alreadyLocked: scanShortTerm holds the chart lock
  let macroState;
  try { macroState = await getMacroState(false, true); } catch { macroState = null; }

  // --- Phase 3: Grade each execution TF ---
  for (const tf of tfsToScan) {
    const data = tfResults[tf];
    if (!data || data.error) {
      tfSignals.push({ tf, grade: 'HATA', error: data?.error || 'Veri alinamadi' });
      continue;
    }

    const ks = data.khanSaab;
    const direction = (ks?.emaStatus === 'BULL' && ks?.macd === 'BULL') ? 'long'
      : (ks?.emaStatus === 'BEAR' && ks?.macd === 'BEAR') ? 'short'
      : 'long';
    const macroFilter = macroState ? applyMacroFilter(macroState, symbol, direction) : null;
    const adxForRegime = Number(data.khanSaab?.adx) || null;
    const regimeResult = classifyRegime(macroState || {}, adxForRegime);
    const regime = regimeResult?.regime || 'neutral';

    // ====================================================================
    // computeRegime() — Faz 1 shadow logger + Faz 2 wrapper kaynagı.
    // Sonuc:
    //   1. JSONL'e log dusurulur (Faz 1 ara rapor icin)
    //   2. regimeContext olarak gradeShortTermSignal'a verilir (Faz 2 wrapper)
    // Hata olursa shadowComputeOk=false, ana akis null regimeContext ile
    // devam eder (eski davranis korunur).
    // ====================================================================
    let shadowResult = null;
    let shadowMarketType = null;
    try {
      // Faz 2 v2.2 — ADX slope hesabı (3-bar fark, normalize edilmemiş).
      // Pozitif = ADX yükseliyor (trend güçleniyor), negatif = düşüyor (zayıflıyor).
      // computeRegime trending teşhisinde `adxSlope >= 0` koşulu kullanır.
      const adxSeries = data.khanSaab?.adxSeries;
      let adxSlope = 0;
      if (Array.isArray(adxSeries) && adxSeries.length >= 3) {
        const a = adxSeries[adxSeries.length - 1];
        const b = adxSeries[adxSeries.length - 3];
        if (Number.isFinite(a) && Number.isFinite(b)) adxSlope = (a - b) / 3;
      }
      const studyValuesForRegime = {
        adx: adxForRegime,
        adxSlope,
        ema20: Number(data.studyValues?.ema20) || null,
        bbUpper: Number(data.studyValues?.bbUpper) || null,
        bbLower: Number(data.studyValues?.bbLower) || null,
        bbBasis: Number(data.studyValues?.bbBasis) || null,
      };
      const macroForRegime = {
        vix: Number(macroState?.['VIX']?.value) || null,
        funding_rate: data.funding ?? null,
        usdtry_realized_sigma_5d: macroState?.usdtry_sigma_5d ?? null,
        usdtry_bist_rho_5d: macroState?.usdtry_bist_rho_5d ?? null,
        usdtry_return_1d: macroState?.usdtry_return_1d ?? null,
      };
      shadowMarketType = _shadowCategoryToMarketType(category);
      shadowResult = _shadowComputeRegime({
        symbol, timeframe: String(tf), marketType: shadowMarketType,
        ohlcv: Array.isArray(data.ohlcv) ? data.ohlcv : [],
        studyValues: studyValuesForRegime,
        macro: macroForRegime,
        chaosWindows: {},
        events: [],
        session: null,
        now: Date.now(),
      });
      _shadowLogRegime({
        symbol, timeframe: String(tf), marketType: shadowMarketType,
        result: shadowResult, now: Date.now(),
      });
    } catch (shadowErr) {
      shadowResult = null;
      console.warn(`[shadow-regime] ${symbol}/${tf} hesaplama/log hatasi: ${shadowErr?.message || shadowErr}`);
    }

    // Faz 2 wrapper icin regimeContext sozlesmesi
    const regimeContextForGrader = shadowResult ? {
      regime: shadowResult.regime,
      subRegime: shadowResult.subRegime,
      strategyHint: shadowResult.strategyHint,
      confidence: shadowResult.confidence,
      newPositionAllowed: shadowResult.newPositionAllowed,
      unstable: shadowResult.unstable,
      stableBars: shadowResult.stableBars,
      transitioned: shadowResult.transitioned,
    } : null;

    const signal = gradeShortTermSignal({
      khanSaab: data.khanSaab,
      smc: data.smc,
      studyValues: data.studyValues,
      ohlcv: data.ohlcv,
      formation: data.formation,
      squeeze: data.squeeze,
      divergence: data.divergence,
      cdv: data.cdv,
      stochRSI: data.stochRSI,
      macroFilter,
      symbol,
      timeframe: tf,
      // Smart entry support
      quotePrice: data.quotePrice,
      parsedBoxes: data.parsedBoxes,
      smcSRLines: data.smcSRLines,
      khanSaabLabels: data.khanSaabLabels,
      regime,
      // Faz 2 Commit 3 — wrapper'a regimeContext + marketType geçir
      regimeContext: regimeContextForGrader,
      marketType: shadowMarketType,
      htfConfidence: higherTFTrend?.confidence ?? null,
      // mtfAlignment Faz 2 Commit 4'te alignment-filters'tan beslenecek; şimdilik null
      mtfAlignment: null,
    });
    signal.regime = regime;

    // Apply higher-TF trend filter (KhanSaab: "First check trend on big TF")
    // HARD VETO: counter-trend + HTF confidence >= 60 → BEKLE (no entry)
    if (higherTFTrend && higherTFTrend.direction !== 'neutral' && signal.direction) {
      if (signal.direction === higherTFTrend.direction) {
        signal.reasoning = signal.reasoning || [];
        signal.reasoning.push(`Yuksek TF trend UYUMLU (${higherTFTrend.direction.toUpperCase()}, guven: %${higherTFTrend.confidence}) — sinyal guclendi`);
        if (signal.tally) signal.tally.conviction = Math.round(signal.tally.conviction * 1.15 * 100) / 100;
      } else {
        signal.reasoning = signal.reasoning || [];
        signal.reasoning.push(`UYARI: Sinyal yuksek TF trendine KARSI (trend: ${higherTFTrend.direction.toUpperCase()}, guven: %${higherTFTrend.confidence})`);
        signal.warnings = signal.warnings || [];
        signal.warnings.push(`Yuksek TF trend ${higherTFTrend.direction.toUpperCase()}, sinyal ${signal.direction.toUpperCase()} — celiskili`);
        if ((higherTFTrend.confidence || 0) >= 60) {
          signal.grade = 'BEKLE';
          signal.reasoning.push('HTF VETO: counter-trend + HTF guveni ≥%60 → giris yok');
        } else if (signal.tally) {
          signal.tally.conviction = Math.round(signal.tally.conviction * 0.60 * 100) / 100;
        }
      }
    }

    // --- HTF Gate (2026-04-23): 1D zorunlu, 1W bilgilendirici ---
    // 15m/30m kaldirildi. Sinyal uretimi 1h+4h'e tasindi; HTF uyumu 1D sert
    // kapi olarak, 1W ise uyari olarak kullaniliyor. 1W cok yavas dondugu
    // icin sert filtre yapilmadi (aylarca tek yonlu bias'a kilitlenmemek icin).
    if (signal.direction && signal.grade && !['IPTAL', 'HATA', 'BEKLE'].includes(signal.grade)) {
      const details = higherTFTrend?.details || [];
      const t1d = details.find(t => String(t.tf) === '1D');
      const t1w = details.find(t => String(t.tf) === '1W');
      const dir = signal.direction;
      const t1dOk = t1d && t1d.direction === dir && (t1d.confidence || 0) >= 50;

      signal.reasoning = signal.reasoning || [];
      signal.warnings = signal.warnings || [];

      if (!t1dOk) {
        signal.grade = 'BEKLE';
        signal.reasoning.push(`${dir.toUpperCase()} HTF GATE: 1D=${t1d?.direction || '?'}(%${t1d?.confidence || 0}) — 1D ${dir} teyidi yok, BEKLE`);
        signal.warnings.push(`HTF gate: 1D ${dir} teyidi eksik`);
      } else if (t1w && t1w.direction !== dir) {
        // 1W uyumsuz: reddetme, sadece uyar
        signal.warnings.push(`1W trend ${t1w.direction} (${dir} sinyale karsi) — dikkat`);
        signal.reasoning.push(`1W=${t1w.direction}(%${t1w.confidence || 0}) uyumsuz ama 1D teyit etti — gecti`);
      }
    }

    signal.tf = tf;
    signal.tfLabel = tfLabel(tf);
    signal.formations = data.formation?.formations || [];
    signal.candles = data.formation?.candles || [];
    signal.cdv = data.cdv;
    signal.squeeze = data.squeeze;
    signal.divergence = data.divergence;
    signal.volConfirm = data.volConfirm;
    // Ham indikator verisini signal'a iliştir — learning katmanı
    // (signal-tracker.extractIndicatorSnapshot) bu alanları okur.
    // Ilistirilmezse snapshot'taki khanSaab/smc/macro/mtf alanlari null kalir.
    signal.khanSaab = data.khanSaab;
    signal.khanSaabBias = data.khanSaab?.bias || null;
    signal.smc = data.smc;
    signal.macroFilter = macroFilter;
    tfSignals.push(signal);
  }

  // Multi-TF confirmation: count how many TFs agree on direction
  const gradeOrder = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4, 'HATA': 5 };
  const validSignals = tfSignals.filter(s => s.grade && s.grade !== 'IPTAL' && s.grade !== 'HATA' && s.grade !== 'BEKLE');

  let mtfConfirmation = null;
  if (validSignals.length > 1) {
    const longCount = validSignals.filter(s => s.direction === 'long').length;
    const shortCount = validSignals.filter(s => s.direction === 'short').length;
    const total = validSignals.length;

    if (longCount >= total * 0.75) {
      mtfConfirmation = { direction: 'long', agreement: Math.round(longCount / total * 100), count: longCount, total };
    } else if (shortCount >= total * 0.75) {
      mtfConfirmation = { direction: 'short', agreement: Math.round(shortCount / total * 100), count: shortCount, total };
    } else {
      mtfConfirmation = { direction: 'mixed', agreement: Math.round(Math.max(longCount, shortCount) / total * 100), count: Math.max(longCount, shortCount), total };
    }
  }

  // Pick best signal (lowest grade order = best, conviction as tiebreaker)
  tfSignals.sort((a, b) => {
    const gDiff = (gradeOrder[a.grade] ?? 9) - (gradeOrder[b.grade] ?? 9);
    if (gDiff !== 0) return gDiff;
    // Same grade → prefer higher conviction
    return (b.tally?.conviction || 0) - (a.tally?.conviction || 0);
  });
  const bestSignal = tfSignals[0] || { grade: 'IPTAL', symbol, error: 'Sinyal yok' };

  // Apply MTF confirmation: aligned = note, mixed = downgrade, opposed = BEKLE
  if (mtfConfirmation && bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
    bestSignal.reasoning = bestSignal.reasoning || [];
    if (mtfConfirmation.direction === 'mixed') {
      bestSignal.reasoning.push(`MTF uyumu %75 altinda (${mtfConfirmation.count}/${mtfConfirmation.total}) — grade 1 kademe dusuruldu`);
      if (bestSignal.grade === 'A') bestSignal.grade = 'B';
      else if (bestSignal.grade === 'B') bestSignal.grade = 'C';
      else if (bestSignal.grade === 'C') bestSignal.grade = 'BEKLE';
    } else if (mtfConfirmation.direction !== bestSignal.direction) {
      bestSignal.reasoning.push(`MTF ${mtfConfirmation.direction.toUpperCase()} ile celiskili (sinyal ${bestSignal.direction?.toUpperCase()}) — BEKLE`);
      bestSignal.grade = 'BEKLE';
    } else {
      bestSignal.reasoning.push(
        `Multi-TF dogrulama: ${mtfConfirmation.count}/${mtfConfirmation.total} TF ${mtfConfirmation.direction.toUpperCase()} yonunde (%${mtfConfirmation.agreement} uyum)`
      );
    }
  }

  // Per-symbol rules override (manual, from current.json symbolRules)
  try {
    const _w = loadWeights();
    const bareSym = ((symbol || '').includes(':') ? symbol.split(':')[1] : symbol || '').toUpperCase();
    // Find matching rule: exact match or prefix match (BTCUSDT matches BTCUSD rule)
    const rules = _w?.symbolRules || {};
    const ruleKey = Object.keys(rules).find(k => bareSym === k || bareSym.startsWith(k));
    const symRule = ruleKey ? rules[ruleKey] : null;
    if (symRule && bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
      bestSignal.reasoning = bestSignal.reasoning || [];
      // Ozel kural: minGrade='BEKLE' → sembol tamamen demote edilmis, tum sinyaller BEKLE'ye zorlanir
      if (symRule.minGrade === 'BEKLE' && bestSignal.grade !== 'BEKLE') {
        bestSignal.reasoning.push(`[${bareSym}] demoted: sembol BEKLE listesinde (otomatik demotion)`);
        bestSignal.grade = 'BEKLE';
      }
      const gradeOrder2 = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3 };
      if (symRule.minGrade && symRule.minGrade !== 'BEKLE' && gradeOrder2[bestSignal.grade] > gradeOrder2[symRule.minGrade]) {
        bestSignal.reasoning.push(`[${bareSym}] per-symbol: ${bestSignal.grade} < minGrade ${symRule.minGrade} → BEKLE`);
        bestSignal.grade = 'BEKLE';
      }
      if (symRule.minHtfConfidence != null &&
          (!higherTFTrend || (higherTFTrend.confidence || 0) < symRule.minHtfConfidence)) {
        bestSignal.reasoning.push(`[${bareSym}] per-symbol: HTF guveni ${higherTFTrend?.confidence || 0} < ${symRule.minHtfConfidence} → BEKLE`);
        bestSignal.grade = 'BEKLE';
      }
      if (symRule.requireMtfAgreement != null &&
          (!mtfConfirmation ||
           mtfConfirmation.direction === 'mixed' ||
           mtfConfirmation.direction !== bestSignal.direction ||
           (mtfConfirmation.agreement || 0) < symRule.requireMtfAgreement)) {
        bestSignal.reasoning.push(`[${bareSym}] per-symbol: MTF uyumu yetersiz (${mtfConfirmation?.agreement || 0} < ${symRule.requireMtfAgreement}) → BEKLE`);
        bestSignal.grade = 'BEKLE';
      }
    }
  } catch (e) {
    // Non-fatal: per-symbol rule loading failed
    console.log(`[Scanner] per-symbol rule okuma hatasi: ${e.message}`);
  }

  // Record signal for learning (only non-IPTAL best signal)
  let transitionDirective = null;
  if (bestSignal.grade && bestSignal.grade !== 'IPTAL' && bestSignal.grade !== 'HATA') {
    try {
      const recorded = recordSignal({ ...bestSignal, mode: 'short', mtfConfirmation });
      if (recorded?.transitionDirective) {
        transitionDirective = recorded.transitionDirective;
      }
    } catch { /* learning recording failure should not block scanning */ }
  }

  // Build the comprehensive result
  return {
    symbol,
    mode: 'short',
    category,
    // Best signal fields (for backward compatibility)
    ...bestSignal,
    // Multi-TF data
    multiTF: true,
    higherTFTrend,
    scannedTimeframes: tfsToScan.map(tfLabel),
    trendTimeframes: singleTF ? [] : assetTrendTFs.map(tfLabel),
    tfSignals: tfSignals.map(s => ({
      tf: s.tf,
      tfLabel: s.tfLabel || tfLabel(s.tf),
      grade: s.grade,
      direction: s.direction,
      khanSaabBias: s.khanSaabBias,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1,
      tp2: s.tp2,
      tp3: s.tp3,
      rr: s.rr,
      slDistancePct: s.slDistancePct,
      error: s.error,
    })),
    mtfConfirmation,
    macroState,
    transitionDirective,
    indicatorWarnings: indicatorSetup?.warnings || [],
    timestamp: new Date().toISOString(),
  };
}

// Re-export for use in server API
export { getSignalHistory } from './learning/signal-tracker.js';

/**
 * Long-term MULTI-TIMEFRAME scan for a single symbol.
 * Scans 4H, 1D, 3D, 1W, 1M with Supertrend + IFCCI.
 */
export async function scanLongTerm(symbol, options = {}) {
  await acquireScanLock(`long:${symbol}`);
  try {
    return await _scanLongTermInner(symbol, options);
  } finally {
    releaseScanLock();
  }
}

async function _scanLongTermInner(symbol, options = {}) {
  const timeframes = options.timeframes || LONG_TERM_TFS;
  const singleTF = options.singleTF;

  const tfsToScan = singleTF ? [singleTF] : timeframes;
  const tfResults = {};
  const tfSignals = [];

  // Setup indicators (ensure Supertrend + IFCCI)
  let indicatorSetup;
  try {
    indicatorSetup = await bridge.setupIndicatorsForScan('long');
  } catch { indicatorSetup = { warnings: [] }; }

  for (const tf of tfsToScan) {
    try {
      const data = await collectLongTermData(symbol, tf);

      const signal = gradeLongTermSignal({
        studyValues: data.studyValues,
        ohlcv: data.ohlcv,
        formation: data.formation,
        symbol,
        timeframe: tf,
      });

      signal.tf = tf;
      signal.tfLabel = tfLabel(tf);
      tfResults[tf] = signal;
      tfSignals.push(signal);
    } catch (e) {
      const errSignal = { tf, tfLabel: tfLabel(tf), error: e.message, grade: 'HATA' };
      tfResults[tf] = errSignal;
      tfSignals.push(errSignal);
    }
  }

  // Multi-TF trend agreement
  const validSignals = tfSignals.filter(s => s.action && s.action !== 'BEKLE' && !s.error);
  let trendAgreement = null;

  if (validSignals.length > 1) {
    const longCount = validSignals.filter(s => s.action?.includes('LONG')).length;
    const shortCount = validSignals.filter(s => s.action?.includes('SHORT')).length;
    const total = validSignals.length;

    if (longCount > shortCount) {
      trendAgreement = { direction: 'LONG', agreement: Math.round(longCount / total * 100), count: longCount, total };
    } else if (shortCount > longCount) {
      trendAgreement = { direction: 'SHORT', agreement: Math.round(shortCount / total * 100), count: shortCount, total };
    } else {
      trendAgreement = { direction: 'KARISIK', agreement: 0, count: 0, total };
    }
  }

  // Trend yonu disinda trade onerilmez (uzun vade kural).
  // Entry TF (1D) sinyali, ust TF'lerin (3D/1W/1M) coklu trend yonuyle uyumsuzsa IPTAL edilir.
  if (trendAgreement && trendAgreement.direction !== 'KARISIK') {
    const entryTfResult = tfResults[LONG_ENTRY_TF];
    if (entryTfResult && entryTfResult.action && entryTfResult.action !== 'BEKLE') {
      const entryIsLong = entryTfResult.action.includes('LONG');
      const trendIsLong = trendAgreement.direction === 'LONG';
      if (entryIsLong !== trendIsLong) {
        entryTfResult.action = 'BEKLE';
        entryTfResult.combination = 'TREND UYUMSUZ';
        entryTfResult.reasoning.push(
          `IPTAL: Giris yonu (${entryIsLong ? 'LONG' : 'SHORT'}) trend yonuyle (${trendAgreement.direction}) uyumsuz — uzun vadede trend disinda trade onerilmez`
        );
      }
    }
  }

  return {
    symbol,
    mode: 'long',
    multiTF: true,
    scannedTimeframes: tfsToScan.map(tfLabel),
    timeframes: tfResults,
    tfSignals: tfSignals.map(s => ({
      tf: s.tf,
      tfLabel: s.tfLabel,
      supertrend: s.supertrend,
      ifcci: s.ifcci,
      action: s.action,
      formation: s.formation,
      error: s.error,
    })),
    trendAgreement,
    indicatorWarnings: indicatorSetup?.warnings || [],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Full batch scan — iterates all symbols in a watchlist category.
 */
// Per-symbol scheduler cooldown: prevents scheduler from re-scanning the same
// symbol within SYMBOL_COOLDOWN_MS. Manual /api/scan/batch calls bypass this.
const _lastScheduledScanAt = new Map(); // symbol -> timestamp ms
const SYMBOL_COOLDOWN_MS = 15 * 60 * 1000;

export function canScheduleSymbol(symbol) {
  const last = _lastScheduledScanAt.get(symbol);
  if (!last) return true;
  return (Date.now() - last) >= SYMBOL_COOLDOWN_MS;
}
export function markSymbolScheduled(symbol) {
  _lastScheduledScanAt.set(symbol, Date.now());
}

export async function batchScan(category, mode = 'short', options = {}) {
  await acquireScanLock(`batch:${category}:${mode}`);
  try {
    return await _batchScanInner(category, mode, options);
  } finally {
    releaseScanLock();
  }
}

async function _batchScanInner(category, mode = 'short', options = {}) {
  const rules = loadRules();
  const watchlist = rules.watchlist[category];
  const abortCheck = options.abortCheck || (() => false);

  if (!watchlist) {
    return { error: `Watchlist bulunamadi: ${category}` };
  }

  const skipSymbols = ['USDT.D', 'BTC.D', 'DXY', 'VIX', 'US10Y'];
  let symbols = watchlist.filter(s => !skipSymbols.includes(s));

  // Per-symbol cooldown: if scheduler is calling (respectCooldown=true),
  // skip symbols scanned within the last 15 minutes. Manual batch calls bypass.
  if (options.respectCooldown) {
    const before = symbols.length;
    symbols = symbols.filter(s => {
      if (canScheduleSymbol(s)) return true;
      console.log(`[Scheduler] ${s} — 15dk cooldown, atlaniyor`);
      return false;
    });
    if (before !== symbols.length) {
      console.log(`[Scheduler] ${category}: ${before - symbols.length}/${before} sembol cooldown ile atlanti`);
    }
  }

  const results = [];
  const scanFn = mode === 'short' ? _scanShortTermInner : _scanLongTermInner;

  let macroState;
  try { macroState = await getMacroState(true, true); } catch { macroState = null; } // alreadyLocked=true: batchScan holds the lock

  const scanStartTime = Date.now();
  let aborted = false;

  for (const symbol of symbols) {
    // Check abort between each symbol
    if (abortCheck()) {
      aborted = true;
      console.log(`[Scanner] ${category} taramasi iptal edildi (${results.length}/${symbols.length} sembol tarandi)`);
      break;
    }

    try {
      const result = await scanFn(symbol, options);
      result.timestamp = new Date().toISOString();
      results.push(result);
      if (options.respectCooldown) markSymbolScheduled(symbol);
    } catch (e) {
      results.push({
        symbol,
        error: e.message,
        grade: 'HATA',
        timestamp: new Date().toISOString(),
      });
    }
  }

  const scanDuration = Math.round((Date.now() - scanStartTime) / 1000);

  return {
    category,
    mode,
    symbolCount: symbols.length,
    scannedCount: results.length,
    scanDuration: `${scanDuration}s`,
    aborted,
    macroState,
    macroSummary: formatMacroSummary(macroState),
    results,
    signals: results.filter(r => r.grade && r.grade !== 'HATA'),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Custom single symbol analysis.
 * - With singleTF: scans only that timeframe
 * - Without singleTF: runs full multi-TF scan for the mode
 */
export async function customScan(symbol, options = {}) {
  const { mode = 'short', singleTF } = options;

  if (mode === 'short') {
    return scanShortTerm(symbol, { singleTF });
  } else {
    return scanLongTerm(symbol, { singleTF });
  }
}

// --- Helper extractors ---

function extractRSIFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    if (!study.values) continue;
    for (const [key, val] of Object.entries(study.values)) {
      if (key.toLowerCase().includes('rsi') && typeof val === 'number') {
        return val;
      }
    }
  }
  return null;
}

function extractATRFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    if (!study.values) continue;
    for (const [key, val] of Object.entries(study.values)) {
      if (key.toLowerCase().includes('atr') && typeof val === 'number') {
        return val;
      }
    }
  }
  return null;
}

function extractEMAFromStudy(studyValues) {
  if (!studyValues || !Array.isArray(studyValues)) return null;
  for (const study of studyValues) {
    const name = (study.name || '').toLowerCase();
    if (!name.includes('ema') && !name.includes('moving average exp')) continue;
    if (study.values) {
      const val = Object.values(study.values).find(v => typeof v === 'number');
      if (val) return val;
    }
  }
  return null;
}
