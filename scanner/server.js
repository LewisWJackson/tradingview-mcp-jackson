/**
 * TV Scanner Server — Express + WebSocket
 * Autonomous trading analysis system.
 *
 * Start: node scanner/server.js
 * Open: http://localhost:3838
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { scheduler } from './lib/scheduler.js';
import { getHaltState, engageHalt, releaseHalt, refreshHaltState } from './lib/halt-state.js';
import { cancelAllAndFlatten } from './lib/okx-dispatcher.js';
import { getParserAlarmStats } from './lib/parser-validator.js';
import { getWrapperMode, setWrapperMode } from './lib/learning/wrapper-mode.js';
import { scanShortTerm, scanLongTerm, batchScan, customScan, isScanActive, getLockHolder, drainLockQueue, acquireScanLock, releaseScanLock } from './lib/scanner-engine.js';
import { runBacktest, getAvailableStrategies } from './lib/backtest.js';
import { getMacroState, formatMacroSummary, setMacroLockFunctions } from './lib/macro-filter.js';
import { ensureConnection, getIndicators, addIndicator, removeIndicator, ensureIndicators, setupIndicatorsForScan, INDICATOR_PRESETS, readWithTempIndicator } from './lib/tv-bridge.js';
import { startLearningLoop, stopLearningLoop, getLearningStatus, getLearningSummary, setIntegration as setLearningIntegration, forceAdjustment, forceOutcomeCheck } from './lib/learning/learning-loop.js';
import { generateFullReport, generateQuickSummary, generate24hChangesReport, generateDigest } from './lib/learning/learning-reporter.js';
import { getOpenSignals, getSignalHistory, cleanupDuplicateSignals, refreshHTFBarrierLevelsForOpenSignals, sanitizeReverseAttemptsForDashboard } from './lib/learning/signal-tracker.js';
import { getAllCachedStats, recomputeAllStats } from './lib/learning/stats-engine.js';
import { scoreAllIndicators, generateIndicatorReport } from './lib/learning/indicator-scorer.js';
import { loadWeights, resetWeights } from './lib/learning/weight-adjuster.js';
import { ensureDataDirs, readAllArchives } from './lib/learning/persistence.js';
import { getAnomalyState, clearAnomalyState, evaluateAnomaly } from './lib/learning/anomaly-detector.js';
import { getCheckpointHistory } from './lib/learning/shadow-guard.js';
import { getLadderSummary, getRecentTransitions, rebuildAndPersist, LADDER_CONSTANTS } from './lib/learning/ladder-engine.js';
import { discoverExchange, lookupExchange, getCacheSnapshot as getExchangeCacheSnapshot } from './lib/exchange-cache.js';
import { runHTFFibJob, ensureHTFFibCache, isFibCacheStale, loadFibCache, HTF_FIB_CONFIG } from './lib/fib-engine.js';
import { formatBarrierFibBasis } from './lib/alignment-filters.js';
import { startLivePriceFeed, getLivePrice, getAllLivePrices, getFeedStats, getFeedHealth, registerSymbols as registerLiveSymbols } from './lib/live-price-feed.js';
import { wrapBroadcast as wrapLiveOutcome } from './lib/learning/live-outcome-processor.js';
import { startYahooPriceFeed, getAllYahooPrices, getYahooFeedStats, registerSymbolsByCategory as registerYahooByCategory, registerSymbols as registerYahooSymbols } from './lib/yahoo-price-feed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3838;

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- WebSocket connections ---
const wsClients = new Set();

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client baglandi (${wsClients.size} aktif)`);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client ayrildi (${wsClients.size} aktif)`);
  });

  // Send initial status
  ws.send(JSON.stringify({
    type: 'status',
    data: scheduler.getStatus(),
  }));
});

function broadcastWS(data) {
  const msg = JSON.stringify(data);
  for (const ws of wsClients) {
    try { ws.send(msg); } catch {}
  }
}

function findFibBasisForBarrierWarning(symbol, warning) {
  if (!symbol || typeof warning !== 'string') return null;
  if (!warning.includes('[HTF-Barrier]') || warning.includes('Fib dayanak:')) return null;
  // Bariyer kaynagi smc_*, htf_fib_* veya kombinasyon olabilir; lookup hepsini kontrol etmeli.
  if (!warning.includes('htf_fib') && !warning.includes('smc_')) return null;
  const match = warning.match(/\((1[DW]) @ ([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const [, tf, rawPrice] = match;
  const barrierPrice = Number(rawPrice);
  if (!Number.isFinite(barrierPrice)) return null;

  const cache = loadFibCache(symbol);
  const tfData = cache?.timeframes?.[tf];
  if (!tfData) return null;
  const fib = tfData.fib || null;

  // smcLines (yazilan price) tipik olarak 4 ondalikta yuvarlanmis (orn. 40.7),
  // bariyer fiyati ise tam (40.7000). Tolerans hem fib (yuksek presizyon) hem smc
  // (yuvarlanmis) eslesmeyi yakalamali.
  const tolerance = Math.max(Math.abs(barrierPrice) * 0.0005, 0.001);
  const details = [];

  const collectFib = (items, kind) => {
    for (const item of items || []) {
      if (!item || typeof item.price !== 'number') continue;
      if (Math.abs(item.price - barrierPrice) > tolerance) continue;
      details.push({
        tf, kind,
        level: item.level,
        price: item.price,
        direction: fib?.direction || null,
        swing: fib?.swing || null,
      });
    }
  };
  if (fib) {
    collectFib(fib.retracement, 'retracement');
    collectFib(fib.extensions || fib.extension, 'extension');
  }

  // SMC indikatoru tarafindan cizilen yatay S/R cizgileri — barrier-detector
  // bunlari smc_1D / smc_1W kaynagi olarak rapor eder. Cache yapisi:
  //   tfData.smcLines: number[]                 (legacy: fiyat listesi)
  //   tfData.smc_lines / tfData.lines: number[] | object[]
  const smcRaw = tfData.smcLines || tfData.smc_lines || tfData.lines || [];
  for (const lv of smcRaw) {
    const price = typeof lv === 'number' ? lv : (lv && typeof lv.price === 'number' ? lv.price : null);
    if (price == null) continue;
    if (Math.abs(price - barrierPrice) > tolerance) continue;
    details.push({ tf, kind: 'smc_line', price });
  }

  if (!details.length) return null;
  return formatBarrierFibBasis({ fibDetails: details });
}

function enrichDashboardWarnings(signal) {
  if (!Array.isArray(signal?.warnings)) return signal?.warnings || [];
  return signal.warnings.map(w => {
    const basis = findFibBasisForBarrierWarning(signal.symbol, w);
    if (basis) return `${w} | Bariyer dayanak: ${basis}`;
    // Sadece SMC veya fib kaynaginin hicbir cache kaydiyla eslesmedigi durumda stale uyarisi
    if (typeof w === 'string' && w.includes('[HTF-Barrier]') &&
        (w.includes('htf_fib') || w.includes('smc_'))) {
      return `${w} | Bariyer dayanak: HTF cache icinde bu seviye bulunamadi (fib retracement/extension veya smcLines hicbiriyle eslesmedi); sinyal kaydi stale olabilir, rescan/migration gerekli.`;
    }
    return w;
  });
}

// Forward scheduler events to WebSocket
scheduler.onResult((event) => {
  broadcastWS(event);
  console.log(`[Scanner] ${event.type}: ${event.category || ''} ${event.timestamp}`);
});

// --- REST API ---

// Health check
app.get('/api/health', async (req, res) => {
  const conn = await ensureConnection();
  res.json({
    server: 'online',
    tradingview: conn.connected !== false,
    scheduler: scheduler.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

// Get scheduler status
// Risk #5 — Parser alarm sayaclarinin gunluk gorunurlugu (gunluk review icin)
app.get('/api/parser-alarms', (_req, res) => {
  res.json({ success: true, ...getParserAlarmStats() });
});

// Risk #17 — Veri feed sagligi (Binance WS heartbeat + zombi tespit)
// Severity: ok = mesaj akiyor, warning = >30sn idle, critical = >60sn veya disconnected
app.get('/api/feed-health', (_req, res) => {
  res.json({ success: true, ...getFeedHealth() });
});

// Faz 2 — Wrapper mode (rejim-aware sinyal wrapper'i shadow/live geçişi)
// Default: shadow (signal'ler üretilir + log'lanır ama dispatch yok)
// 24 saat shadow log incelendikten sonra operator live'a geçer.
app.get('/api/wrapper/mode', (_req, res) => {
  res.json({ success: true, ...getWrapperMode() });
});

app.post('/api/wrapper/mode', (req, res) => {
  const { mode, by, reason = 'manual_change', confirm } = req.body || {};
  if (!by || !mode) {
    return res.status(400).json({ success: false, error: '`mode` ve `by` gerekli' });
  }
  // Live'a geçiş için onay zorunlu (shadow log incelenmeden açılmasın diye)
  if (mode === 'live' && confirm !== 'I_REVIEWED_SHADOW_LOG') {
    return res.status(400).json({
      success: false,
      error: 'live moduna geçiş için confirm: "I_REVIEWED_SHADOW_LOG" zorunlu (24h shadow log review garantisi)',
    });
  }
  try {
    const state = setWrapperMode({ mode, by, reason });
    broadcastWS({ type: 'wrapper_mode_changed', mode: state.mode, by, reason });
    res.json({ success: true, ...state });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/scheduler/status', (req, res) => {
  res.json(scheduler.getStatus());
});

// Start scheduler
app.post('/api/scheduler/start', (req, res) => {
  scheduler.start();
  res.json({ success: true, status: 'started' });
});

// Stop scheduler — immediately aborts all in-progress scans and drains the lock queue
app.post('/api/scheduler/stop', (req, res) => {
  scheduler.stop();
  drainLockQueue(); // Clear any waiting lock requests from the scheduler
  broadcastWS({ type: 'scheduler_status', status: 'stopped' });
  res.json({ success: true, status: 'stopped', message: 'Tum taramalar aninda durduruldu' });
});

// =========================================================================
// EMERGENCY HALT (Risk #3 — Kill switch, Layer A)
// =========================================================================
// Uc katmanli acil durdurma sisteminin "API" katmani. Engage ettiginde:
//   1) halt-state.json'a yazilir (persistent — restart sonrasi unutulmaz)
//   2) scheduler.stop() cagrilir
//   3) opsiyonel cancelOrders=true ise Layer C (exchange-native cancel-all)
//      tetiklenir (timeout+retry+audit)
// Release icin manuel body {by, reason} gerekir — sessiz unhalt yok.
// =========================================================================

app.get('/api/emergency/status', (_req, res) => {
  res.json({
    success: true,
    halt: refreshHaltState(),
    scheduler: scheduler.getStatus(),
  });
});

app.post('/api/emergency/halt', async (req, res) => {
  const { reason = 'manual_halt', by = 'operator', cancelOrders = false } = req.body || {};
  try {
    const state = engageHalt({ reason, source: 'api', layer: 'A', by });
    // Scheduler'i tamamen durdur — mid-cycle halt check zaten var, ama
    // kesin garanti icin timerlari temizle.
    try { scheduler.stop(); drainLockQueue(); } catch (err) {
      console.error('[emergency/halt] scheduler.stop() failed:', err.message);
    }
    broadcastWS({ type: 'emergency_halt', reason, haltedAt: state.haltedAt, by });

    let cancelResult = null;
    if (cancelOrders) {
      cancelResult = await cancelAllAndFlatten({ attempts: 3, timeoutMs: 5000 });
      broadcastWS({ type: 'emergency_cancel_all', ...cancelResult });
    }

    res.json({
      success: true,
      halt: state,
      cancelOrders: cancelResult,
      message: cancelOrders
        ? (cancelResult?.success ? 'HALT engaged + orders cancelled' : 'HALT engaged — CANCEL-ALL FAILED, MANUAL INTERVENTION')
        : 'HALT engaged (orders NOT cancelled — pass cancelOrders:true to flatten)',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/emergency/release', (req, res) => {
  const { by, reason = 'manual_release', confirm } = req.body || {};
  if (!by || confirm !== 'I_CONFIRM_RELEASE') {
    return res.status(400).json({
      success: false,
      error: 'release icin `by` ve `confirm: "I_CONFIRM_RELEASE"` gerekli (yanlislikla release korumasi)',
    });
  }
  try {
    const state = releaseHalt({ by, reason });
    broadcastWS({ type: 'emergency_released', by, reason, at: new Date().toISOString() });
    res.json({ success: true, halt: state, message: 'HALT released — scheduler manuel start ile yeniden baslatilmali' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manuel Layer C tetikleyicisi (halt olmadan test/drill icin)
app.post('/api/emergency/cancel-all', async (_req, res) => {
  try {
    const result = await cancelAllAndFlatten({ attempts: 3, timeoutMs: 5000 });
    broadcastWS({ type: 'emergency_cancel_all', ...result });
    res.json({ success: result.success, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Live Price Feed (Binance WS + Yahoo REST) ---
app.get('/api/live-prices', (req, res) => {
  const binance = getAllLivePrices();
  const yahoo = getAllYahooPrices();
  // Birlestir — kripto ile Yahoo tv-sembolleri cakismaz (MON vs MONUSDT gibi degil)
  const prices = Object.assign({}, yahoo, binance);
  res.json({
    prices,
    stats: { binance: getFeedStats(), yahoo: getYahooFeedStats() },
  });
});

app.get('/api/live-prices/:symbol', (req, res) => {
  const sym = req.params.symbol;
  const price = getLivePrice(sym);
  res.json({ symbol: sym, price, ts: Date.now() });
});

// Acik sinyallerden + watchlist'ten sembolleri topla ve feed'lere kaydet
function refreshLiveSymbols() {
  try {
    const cryptoSyms = new Set();
    const rulesPath = path.join(__dirname, '..', 'rules.json');
    let rulesWatch = {};
    try {
      if (fs.existsSync(rulesPath)) {
        const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf-8'));
        rulesWatch = rules.watchlist || {};
      }
    } catch (e) { console.log('[LiveFeed] rules.json okunamadi:', e.message); }

    // Binance feed: tum watchlist + acik sinyaller (dahili filtre kripto olmayani atar)
    for (const cat of Object.keys(rulesWatch)) {
      for (const sym of (rulesWatch[cat] || [])) cryptoSyms.add(sym);
    }
    try {
      const open = getOpenSignals() || [];
      for (const s of open) if (s.symbol) cryptoSyms.add(s.symbol);
    } catch {}
    registerLiveSymbols(Array.from(cryptoSyms));

    // Yahoo feed: abd_hisse + emtia + bist (kategori bilgili)
    registerYahooByCategory({
      abd_hisse: rulesWatch.abd_hisse || [],
      emtia: rulesWatch.emtia || [],
      bist: rulesWatch.bist || [],
    });
    // Acik sinyaller arasindaki ilgili kategorileri de ekle
    try {
      const open = getOpenSignals() || [];
      const extra = [];
      for (const s of open) {
        if (!s.symbol) continue;
        if (s.category === 'abd_hisse' || s.category === 'emtia' || s.category === 'bist') extra.push(s.symbol);
      }
      if (extra.length > 0) registerYahooSymbols(extra);
    } catch {}
  } catch (e) { console.log('[LiveFeed] refreshLiveSymbols hatasi:', e.message); }
}
refreshLiveSymbols();
setInterval(refreshLiveSymbols, 60000); // dakikada bir

const liveBroadcast = wrapLiveOutcome(broadcastWS);
startLivePriceFeed({ broadcast: liveBroadcast, symbols: [] });
startYahooPriceFeed({ broadcast: liveBroadcast });

// Force-release stuck chart lock (emergency use)
app.post('/api/scanner/force-release-lock', (req, res) => {
  const wasActive = isScanActive();
  const holder = getLockHolder();
  if (wasActive) {
    releaseScanLock();
    drainLockQueue();
    console.log(`[Lock] Force-release: ${holder || 'unknown'} kilidi zorla birakildi`);
    res.json({ success: true, wasActive, previousHolder: holder, message: 'Kilit zorla birakildi' });
  } else {
    res.json({ success: false, wasActive: false, message: 'Kilit zaten serbest' });
  }
});

// Pause category
app.post('/api/scheduler/pause/:category', (req, res) => {
  scheduler.pause(req.params.category);
  res.json({ success: true, paused: req.params.category });
});

// Resume category
app.post('/api/scheduler/resume/:category', (req, res) => {
  scheduler.resume(req.params.category);
  res.json({ success: true, resumed: req.params.category });
});

// --- HTF Fibonacci cache endpoints ---
// GET  /api/fib/status         → cache meta + stale durumu
// GET  /api/fib/:symbol        → o sembol icin kaydedilmis fib + trend
// POST /api/fib/refresh        → manuel tam refresh (scheduler duraklar)
app.get('/api/fib/status', (req, res) => {
  const stale = isFibCacheStale();
  res.json({
    config: HTF_FIB_CONFIG,
    cache: stale,
    inProgress: _htfFibInProgress,
  });
});

app.get('/api/fib/:symbol', (req, res) => {
  const data = loadFibCache(req.params.symbol);
  if (!data) return res.status(404).json({ error: 'fib cache bulunamadi', symbol: req.params.symbol });
  res.json(data);
});

app.post('/api/fib/refresh', async (req, res) => {
  if (_htfFibInProgress) return res.status(409).json({ error: 'HTF fib refresh zaten calisiyor' });
  const wasRunning = scheduler.running;
  if (wasRunning) {
    scheduler.stop();
    drainLockQueue();
    let waited = 0;
    while (isScanActive() && waited < 30000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }
  }
  _htfFibInProgress = true;
  res.json({ success: true, status: 'started', note: 'Sonucu WebSocket htf_fib_status eventleriyle izle' });
  (async () => {
    try {
      const result = await runHTFFibJob({
        onProgress: (p) => broadcastWS({ type: 'htf_fib_progress', ...p }),
      });
      broadcastWS({ type: 'htf_fib_status', phase: 'manual_done', result: { ok: result.ok, meta: result.meta } });
    } catch (e) {
      broadcastWS({ type: 'htf_fib_status', phase: 'manual_error', error: e.message });
    } finally {
      _htfFibInProgress = false;
      if (wasRunning) scheduler.start();
    }
  })();
});

// Manual scan — single symbol short-term (multi-TF by default)
// Chart mutex ensures no other scan runs simultaneously
app.post('/api/scan/short', async (req, res) => {
  const { symbol, timeframes, singleTF } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol gerekli' });

  try {
    const tfInfo = singleTF ? singleTF : 'multi-TF';
    broadcastWS({ type: 'scan_start', category: 'manual', symbol, mode: 'short', timeframe: tfInfo });
    // scanShortTerm internally acquires the chart mutex — will wait if scheduler is scanning
    const result = await scanShortTerm(symbol, { timeframes, singleTF });
    broadcastWS({ type: 'scan_complete', category: 'manual', result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual scan — single symbol long-term (multi-TF by default)
app.post('/api/scan/long', async (req, res) => {
  const { symbol, timeframes, singleTF } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol gerekli' });

  try {
    const tfInfo = singleTF ? singleTF : 'multi-TF';
    broadcastWS({ type: 'scan_start', category: 'manual', symbol, mode: 'long', timeframe: tfInfo });
    const result = await scanLongTerm(symbol, { timeframes, singleTF });
    broadcastWS({ type: 'scan_complete', category: 'manual', result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Batch scan — whole category
// FULLY STOPS scheduler before manual scan. User must restart scheduler manually.
app.post('/api/scan/batch', async (req, res) => {
  const { category, mode } = req.body;
  if (!category) return res.status(400).json({ error: 'category gerekli' });

  // FULLY stop scheduler to prevent ANY chart interference
  const wasRunning = scheduler.running;
  if (wasRunning) {
    scheduler.stop();
    drainLockQueue();
    console.log('[Manual Batch] Scheduler tamamen durduruldu — manual tarama basliyor');
    // Wait for any in-flight scan to fully release the lock
    let waited = 0;
    while (isScanActive() && waited < 15000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }
    if (isScanActive()) {
      console.log('[Manual Batch] UYARI: Lock hala aktif, yine de devam ediliyor');
    }
  }

  try {
    broadcastWS({ type: 'scan_start', category, mode: mode || 'short' });
    const result = await batchScan(category, mode || 'short');
    broadcastWS({ type: 'scan_complete', category, result });
    // Inform user that scheduler is stopped — they must restart manually
    result.schedulerStopped = wasRunning;
    if (wasRunning) {
      result.note = 'Otomatik tarama durduruldu. Yeniden baslatmak icin /api/scheduler/start kullanin.';
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Custom scan — any symbol, optional single TF or auto multi-TF
app.post('/api/scan/custom', async (req, res) => {
  const { symbol, timeframe, mode } = req.body;
  if (!symbol) return res.status(400).json({ error: 'symbol gerekli' });

  try {
    const result = await customScan(symbol, { mode: mode || 'short', singleTF: timeframe || null });
    broadcastWS({ type: 'scan_complete', category: 'custom', result });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Macro state — getMacroState internally acquires/releases chart lock
app.get('/api/macro', async (req, res) => {
  try {
    // getMacroState handles lock internally:
    //   - If lock can't be acquired within 15s, returns cached data
    //   - If cached data is fresh (< 15 min), returns immediately without lock
    const forceRefresh = req.query.refresh === 'true';
    const state = await getMacroState(forceRefresh);
    res.json({
      state,
      summary: formatMacroSummary(state),
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backtest
// Backtest — single strategy
app.post('/api/backtest', async (req, res) => {
  const { symbol, timeframe, bars, strategy, slMultiplier, compareAll, compareSL } = req.body;
  if (!symbol || !timeframe) return res.status(400).json({ error: 'symbol ve timeframe gerekli' });

  try {
    const result = await runBacktest(symbol, timeframe, {
      bars: bars || 500,
      strategy: strategy || 'EMA_Cross_9_21',
      slMultiplier: slMultiplier || 2.5,
      compareAll: compareAll || false,
      compareSL: compareSL || false,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backtest — compare ALL strategies
app.post('/api/backtest/compare', async (req, res) => {
  const { symbol, timeframe, bars, slMultiplier } = req.body;
  if (!symbol || !timeframe) return res.status(400).json({ error: 'symbol ve timeframe gerekli' });

  try {
    const result = await runBacktest(symbol, timeframe, {
      bars: bars || 500,
      slMultiplier: slMultiplier || 2.5,
      compareAll: true,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Backtest — compare SL multipliers
app.post('/api/backtest/compare-sl', async (req, res) => {
  const { symbol, timeframe, strategy, bars } = req.body;
  if (!symbol || !timeframe) return res.status(400).json({ error: 'symbol ve timeframe gerekli' });

  try {
    const result = await runBacktest(symbol, timeframe, {
      bars: bars || 500,
      strategy: strategy || 'EMA_Cross_RSI_Volume',
      compareSL: true,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Available strategies list
app.get('/api/backtest/strategies', (req, res) => {
  res.json(getAvailableStrategies());
});

// Symbol search — uses TradingView public API
app.get('/api/search', async (req, res) => {
  const query = req.query.q;
  if (!query || query.length < 1) return res.json([]);

  try {
    const params = new URLSearchParams({
      text: query, hl: '1', exchange: '', lang: 'en', search_type: '', domain: 'production',
    });
    const resp = await fetch(`https://symbol-search.tradingview.com/symbol_search/v3/?${params}`, {
      headers: { 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/' },
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return res.json([]);
    const data = await resp.json();
    const strip = s => (s || '').replace(/<\/?em>/g, '');
    const results = (data.symbols || data || []).slice(0, 12).map(r => ({
      symbol: strip(r.symbol),
      description: strip(r.description),
      exchange: r.exchange || r.prefix || '',
      type: r.type || '',
      full_name: r.exchange ? `${r.exchange}:${strip(r.symbol)}` : strip(r.symbol),
    }));
    res.json(results);
  } catch {
    res.json([]);
  }
});

// Indicator management
app.get('/api/indicators', async (req, res) => {
  try {
    const indicators = await getIndicators();
    res.json({ indicators, presets: Object.keys(INDICATOR_PRESETS.extras) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/indicators/setup', async (req, res) => {
  const { mode } = req.body;
  try {
    const result = await setupIndicatorsForScan(mode || 'short');
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/indicators/add', async (req, res) => {
  const { name, inputs } = req.body;
  if (!name) return res.status(400).json({ error: 'name gerekli' });
  try {
    const result = await addIndicator(name, inputs);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/indicators/remove', async (req, res) => {
  const { entityId } = req.body;
  if (!entityId) return res.status(400).json({ error: 'entityId gerekli' });
  try {
    const result = await removeIndicator(entityId);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/indicators/temp-read', async (req, res) => {
  const { indicator } = req.body;
  if (!indicator) return res.status(400).json({ error: 'indicator gerekli (rsi, macd, bb, adx, vwap, atr, ema9, ema21)' });
  try {
    const result = await readWithTempIndicator(indicator);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get watchlists
const RULES_PATH = path.resolve(__dirname, '../rules.json');
const VALID_CATEGORIES = ['kripto', 'forex', 'abd_hisse', 'bist', 'emtia'];

function readRulesSync() {
  return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
}
function writeRulesAtomic(rules) {
  const tmp = RULES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rules, null, 2));
  fs.renameSync(tmp, RULES_PATH);
}

app.get('/api/watchlists', (req, res) => {
  try {
    const rules = readRulesSync();
    res.json(rules.watchlist);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Watchlist'e sembol ekle — body: { category, symbol }
// ABD hissesi eklenirse arka planda dogru borsayi kesfeder (cache'e yazar).
app.post('/api/watchlists', async (req, res) => {
  try {
    const { category, symbol } = req.body || {};
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Gecersiz kategori. Izin verilen: ${VALID_CATEGORIES.join(', ')}` });
    }
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return res.status(400).json({ error: 'Sembol bos olamaz' });
    if (!/^[A-Z0-9.]{1,15}$/.test(sym)) {
      return res.status(400).json({ error: 'Sembol formati gecersiz (sadece A-Z, 0-9, nokta)' });
    }

    const rules = readRulesSync();
    rules.watchlist = rules.watchlist || {};
    rules.watchlist[category] = rules.watchlist[category] || [];
    const list = rules.watchlist[category];
    if (list.map(s => s.toUpperCase()).includes(sym)) {
      return res.status(409).json({ error: `${sym} zaten ${category} listesinde` });
    }
    list.push(sym);
    writeRulesAtomic(rules);

    let discoveredExchange = null;
    if (category === 'abd_hisse' && !lookupExchange(sym)) {
      // Arka planda dogrula — yanit kullaniciya hemen donsun
      discoveredExchange = await discoverExchange(sym).catch(() => null);
    }

    res.json({ ok: true, category, symbol: sym, exchange: discoveredExchange || lookupExchange(sym) || null });
  } catch (e) {
    console.error('[API] POST /api/watchlists hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

// Watchlist'ten sembol sil — body: { category, symbol }
app.delete('/api/watchlists', (req, res) => {
  try {
    const { category, symbol } = req.body || {};
    if (!category || !VALID_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Gecersiz kategori' });
    }
    const sym = String(symbol || '').trim().toUpperCase();
    if (!sym) return res.status(400).json({ error: 'Sembol bos olamaz' });

    const rules = readRulesSync();
    const list = rules.watchlist?.[category] || [];
    const before = list.length;
    rules.watchlist[category] = list.filter(s => s.toUpperCase() !== sym);
    if (rules.watchlist[category].length === before) {
      return res.status(404).json({ error: `${sym} ${category} listesinde bulunamadi` });
    }
    writeRulesAtomic(rules);
    res.json({ ok: true, category, symbol: sym });
  } catch (e) {
    console.error('[API] DELETE /api/watchlists hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

// Sembol bazli toplu istatistik — UI watchlist panelinde gosterilir.
// Arsiv ve acik sinyalleri birlestirip A/B/C dagilimi, TP/SL hit oranlari,
// kazanan/kaybeden sayisi, ortalama R ve son 10 sinyali doner.
app.get('/api/watchlists/stats/:symbol', (req, res) => {
  try {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const days = parseInt(req.query.days) || 90;
    const signals = getSignalHistory(symbol, days);

    const total = signals.length;
    const byGrade = { A: 0, B: 0, C: 0 };
    let wins = 0, losses = 0, tp1Hits = 0, slHits = 0, pending = 0;
    let sumR = 0, countR = 0;

    for (const s of signals) {
      if (s.grade && byGrade[s.grade] != null) byGrade[s.grade]++;
      if (s.tp1Hit) tp1Hits++;
      if (s.slHit) slHits++;
      if (s.status === 'open' && !s.entryHit) pending++;
      if (s.win === true) wins++;
      else if (s.win === false) losses++;
      const r = parseFloat(s.actualRR);
      if (Number.isFinite(r)) { sumR += r; countR++; }
    }

    const resolved = wins + losses;
    const winRate = resolved > 0 ? (wins / resolved) * 100 : null;
    const tp1Rate = total > 0 ? (tp1Hits / total) * 100 : null;
    const slRate = total > 0 ? (slHits / total) * 100 : null;
    const avgR = countR > 0 ? sumR / countR : null;

    const last = signals.slice(0, 10).map(s => ({
      id: s.id,
      createdAt: s.createdAt,
      timeframe: s.timeframe,
      grade: s.grade,
      direction: s.direction,
      entry: s.entry,
      status: s.status,
      outcome: s.outcome || null,
      win: s.win != null ? s.win : null,
      actualRR: s.actualRR || null,
    }));

    res.json({
      symbol,
      days,
      total,
      byGrade,
      wins,
      losses,
      pending,
      resolved,
      winRate,
      tp1Rate,
      slRate,
      avgR,
      last,
    });
  } catch (e) {
    console.error('[API] /api/watchlists/stats hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

// Exchange cache snapshot — UI'da ABD hisse rozetleri icin kullanilabilir
app.get('/api/watchlists/exchange-map', (req, res) => {
  try {
    const snap = getExchangeCacheSnapshot();
    res.json(snap?.tickers || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Scan history
app.get('/api/history', (req, res) => {
  res.json(scheduler.scanHistory || []);
});

// === Learning System API ===

// Learning status
app.get('/api/learning/status', (req, res) => {
  res.json(getLearningStatus());
});

// Learning summary (comprehensive)
app.get('/api/learning/summary', (req, res) => {
  res.json(getLearningSummary());
});

// Quick dashboard summary
app.get('/api/learning/quick', (req, res) => {
  res.json(generateQuickSummary());
});

// Full text report
app.get('/api/learning/report', (req, res) => {
  const report = generateFullReport();
  res.type('text/plain').send(report);
});

// 24h changes report — what the learning system changed and its impact
app.get('/api/learning/changes', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const report = generate24hChangesReport(hours);
  res.type('text/plain').send(report);
});

// Anomaly state — okx-executor bot yeni poz acma karari verirken bunu kontrol eder
app.get('/api/learning/anomaly', (req, res) => {
  res.json(getAnomalyState());
});

// Manuel olarak anomaly mode'u temizle
app.post('/api/learning/anomaly/clear', (req, res) => {
  const reason = req.body?.reason || 'manual_clear_api';
  clearAnomalyState(reason);
  res.json({ ok: true, state: getAnomalyState() });
});

// Manuel anomaly degerlendirme (test icin)
app.post('/api/learning/anomaly/evaluate', (req, res) => {
  const result = evaluateAnomaly();
  res.json(result);
});

// Shadow-guard checkpoint gecmisi
app.get('/api/learning/checkpoints', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json({ checkpoints: getCheckpointHistory(limit) });
});

// Gunluk/haftalik digest — dashboard widget'i icin
app.get('/api/learning/digest', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  res.json(generateDigest(hours));
});

// Statistics
app.get('/api/learning/stats', (req, res) => {
  const stats = recomputeAllStats();
  res.json(stats);
});

app.get('/api/learning/stats/:dimension', (req, res) => {
  const stats = getAllCachedStats();
  const dim = req.params.dimension;
  const dimMap = {
    grade: 'byGrade',
    timeframe: 'byTimeframe',
    symbol: 'bySymbol',
    category: 'byCategory',
    'faulty-trades': 'faultyTrades',
    faulty: 'faultyTrades',
  };
  res.json(stats[dimMap[dim]] || stats[dim] || {});
});

// Indicator scores and ranking
app.get('/api/learning/indicators', (req, res) => {
  const result = scoreAllIndicators();
  res.json(result);
});

app.get('/api/learning/indicators/report', (req, res) => {
  const report = generateIndicatorReport();
  res.type('text/plain').send(report);
});

// Open signals being tracked
app.get('/api/learning/signals/open', (req, res) => {
  res.json(getOpenSignals());
});

// --- 3-Tier Ladder API ---
app.get('/api/ladder/state', (req, res) => {
  try {
    res.json({ ...getLadderSummary(), rules: LADDER_CONSTANTS });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/ladder/transitions', (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
    res.json({ transitions: getRecentTransitions(limit) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/ladder/rebuild', (req, res) => {
  try {
    const all = readAllArchives();
    const fresh = rebuildAndPersist(all);
    res.json({
      ok: true,
      signalsProcessed: all.length,
      entries: Object.entries(fresh.entries).reduce((acc, [, g]) => acc + Object.keys(g).length, 0),
      transitions: fresh.transitions.length,
      updatedAt: fresh.updatedAt,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Ladder kalite ozeti — learning-loop'un transition'lardan derledigi
// sembol/grade bazli promosyon/duse sayaclari ve gecmisi.
app.get('/api/ladder/quality', (req, res) => {
  try {
    const qualityPath = path.resolve(__dirname, 'data/ladder-quality.json');
    if (!fs.existsSync(qualityPath)) {
      return res.json({ updatedAt: null, bySymbol: {} });
    }
    const data = JSON.parse(fs.readFileSync(qualityPath, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Open signals dashboard with P&L calculations
const TERMINAL_STATUSES = new Set([
  'sl_hit', 'tp3_hit', 'invalid_data',
  'superseded', 'superseded_by_tf', 'superseded_by_cleanup', 'superseded_by_cap',
  'manual_close', 'entry_expired',
]);
app.get('/api/signals/open-dashboard', (req, res) => {
  try {
    const allSignals = getOpenSignals();
    // "Acik" = terminal olmayan: status 'open', 'tp1_hit' (trailing SL aktif),
    // 'tp2_hit' (trailing SL aktif) hepsi canli takipte.
    const openOnly = allSignals.filter(s => !TERMINAL_STATUSES.has(s.status));

    const enriched = openOnly.map(s => {
      const price = s.lastCheckedPrice || s.entry;
      const entry = s.entry;
      let pnlPct = 0;
      let pnlR = 0;

      // Entry hit olmadiysa pozisyon henuz acilmamis sayilir — P&L hesaplanmaz.
      const entryActive = s.entryHit !== false;
      if (entry && price && entryActive) {
        if (s.direction === 'long') {
          pnlPct = ((price - entry) / entry) * 100;
        } else {
          pnlPct = ((entry - price) / entry) * 100;
        }
        // P&L in R units (risk = entry-SL distance)
        const risk = Math.abs(entry - (s.sl || entry));
        if (risk > 0) {
          const rawPnl = s.direction === 'long' ? (price - entry) : (entry - price);
          pnlR = rawPnl / risk;
        }
      }

      // TP progress — canli fiyat TP'yi gectiyse (outcome checker henuz yazmadiysa) hit inferansı yap
      const tpHit = (tpLevel) => {
        if (!tpLevel || !isFinite(tpLevel)) return false;
        if (s.direction === 'long') return price != null && price >= tpLevel;
        return price != null && price <= tpLevel;
      };
      const tpProgress = [];
      if (s.tp1) tpProgress.push({ level: 'TP1', price: s.tp1, hit: !!s.tp1Hit || tpHit(s.tp1), hitAt: s.tp1HitAt || null, inferred: !s.tp1Hit && tpHit(s.tp1) });
      if (s.tp2) tpProgress.push({ level: 'TP2', price: s.tp2, hit: !!s.tp2Hit || tpHit(s.tp2), hitAt: s.tp2HitAt || null, inferred: !s.tp2Hit && tpHit(s.tp2) });
      if (s.tp3) tpProgress.push({ level: 'TP3', price: s.tp3, hit: !!s.tp3Hit || tpHit(s.tp3), hitAt: s.tp3HitAt || null, inferred: !s.tp3Hit && tpHit(s.tp3) });

      // Distance to SL and next TP (percentage)
      const slDist = entry && s.sl ? Math.abs(price - s.sl) / price * 100 : null;
      const nextTP = tpProgress.find(tp => !tp.hit);
      const tpDist = nextTP && price ? Math.abs(nextTP.price - price) / price * 100 : null;

      // Age in minutes
      const ageMinutes = s.createdAt ? Math.round((Date.now() - new Date(s.createdAt).getTime()) / 60000) : null;

      const reverseAttempts = sanitizeReverseAttemptsForDashboard(s.reverseAttempts);

      return {
        id: s.id,
        symbol: s.symbol,
        category: s.category,
        direction: s.direction,
        grade: s.grade,
        positionPct: s.position_pct,
        timeframe: s.timeframe,
        entry,
        entrySource: s.entrySource || 'lastbar_close',
        entryHit: s.entryHit !== false,
        entryHitAt: s.entryHitAt || null,
        quotePrice: s.quotePrice,
        sl: s.sl,
        currentPrice: price,
        pnlPct: Math.round(pnlPct * 100) / 100,
        pnlR: Math.round(pnlR * 100) / 100,
        slDistance: slDist ? Math.round(slDist * 100) / 100 : null,
        nextTPDistance: tpDist ? Math.round(tpDist * 100) / 100 : null,
        tpProgress,
        slHit: !!s.slHit,
        highestFavorable: s.highestFavorable,
        lowestAdverse: s.lowestAdverse,
        rr: s.rr,
        ageMinutes,
        createdAt: s.createdAt,
        lastCheckedAt: s.lastCheckedAt,
        warnings: enrichDashboardWarnings(s),
        // Reasoning ve oylama (sinyal kart detayi icin) — 2026-05-04
        reasoning: Array.isArray(s.reasoning) ? s.reasoning : [],
        voteBreakdown: Array.isArray(s.voteBreakdown) ? s.voteBreakdown : null,
        tally: s.tally || null,
        tp1Source: s.tp1Source || null,
        tp2Source: s.tp2Source || null,
        tp3Source: s.tp3Source || null,
        slReason: s.slReason || null,
        slSource: s.slSource || null,
        strategicCandidates: Array.isArray(s.strategicCandidates) ? s.strategicCandidates : null,
        breakevenAt: s.breakevenAt || null,
        // Tek-poz + reverse-yok alanlari
        reverseAttempts,
        reverseAttemptCount: reverseAttempts.length,
        trailingStopActive: !!s.trailingStopActive,
        trailingStopLevel: s.trailingStopLevel || null,
        refreshCount: s.refreshCount || 0,
        lastRefreshedAt: s.lastRefreshedAt || null,
      };
    });

    // Sort: A > B > C, then by pnlR desc
    const gradeOrder = { A: 0, B: 1, C: 2, BEKLE: 3, IPTAL: 4 };
    enriched.sort((a, b) => {
      const gd = (gradeOrder[a.grade] || 9) - (gradeOrder[b.grade] || 9);
      if (gd !== 0) return gd;
      return (b.pnlR || 0) - (a.pnlR || 0);
    });

    // Summary stats
    const totalOpen = enriched.length;
    const profitable = enriched.filter(s => s.pnlPct > 0).length;
    const losing = enriched.filter(s => s.pnlPct < 0).length;
    const avgPnlPct = totalOpen > 0 ? Math.round(enriched.reduce((s, x) => s + x.pnlPct, 0) / totalOpen * 100) / 100 : 0;
    const avgPnlR = totalOpen > 0 ? Math.round(enriched.reduce((s, x) => s + x.pnlR, 0) / totalOpen * 100) / 100 : 0;
    const byGrade = {};
    enriched.forEach(s => { byGrade[s.grade] = (byGrade[s.grade] || 0) + 1; });
    const byCategory = {};
    enriched.forEach(s => { byCategory[s.category] = (byCategory[s.category] || 0) + 1; });

    res.json({
      summary: { totalOpen, profitable, losing, avgPnlPct, avgPnlR, byGrade, byCategory },
      signals: enriched,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Son 24 saatte kapanan sinyaller — kart bazli, reasoning + oylama dahil.
app.get('/api/signals/closed-24h', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(168, parseInt(req.query.hours || '24', 10)));
    const cutoff = Date.now() - hours * 60 * 60 * 1000;
    const archived = readAllArchives();
    const recent = archived.filter(s => {
      const ts = new Date(s.resolvedAt || s.entryExpiredAt || s.updatedAt || s.createdAt || 0).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
    recent.sort((a, b) => {
      const ta = new Date(a.resolvedAt || a.entryExpiredAt || a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.resolvedAt || b.entryExpiredAt || b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    const enriched = recent.map(s => ({
      id: s.id,
      symbol: s.symbol,
      category: s.category,
      timeframe: s.timeframe,
      grade: s.grade,
      league: s.league || null,
      direction: s.direction,
      entry: s.entry,
      sl: s.sl,
      tp1: s.tp1, tp2: s.tp2, tp3: s.tp3,
      tp1Hit: !!s.tp1Hit, tp2Hit: !!s.tp2Hit, tp3Hit: !!s.tp3Hit,
      tp1HitPrice: s.tp1HitPrice || null,
      tp2HitPrice: s.tp2HitPrice || null,
      tp3HitPrice: s.tp3HitPrice || null,
      slHit: !!s.slHit,
      slHitPrice: s.slHitPrice || null,
      status: s.status,
      outcome: s.outcome || s.status,
      win: s.win != null ? !!s.win : null,
      actualRR: s.actualRR != null ? s.actualRR : null,
      rr: s.rr || null,
      entrySource: s.entrySource || null,
      entryHit: s.entryHit !== false,
      tp1Source: s.tp1Source || null,
      tp2Source: s.tp2Source || null,
      tp3Source: s.tp3Source || null,
      slSource: s.slSource || null,
      slReason: s.slReason || null,
      strategicCandidates: Array.isArray(s.strategicCandidates) ? s.strategicCandidates : null,
      reasoning: Array.isArray(s.reasoning) ? s.reasoning : [],
      warnings: Array.isArray(s.warnings) ? s.warnings : [],
      voteBreakdown: Array.isArray(s.voteBreakdown) ? s.voteBreakdown : null,
      tally: s.tally || null,
      breakevenAt: s.breakevenAt || null,
      faultyTrade: !!s.faultyTrade,
      faultyTradeReason: s.faultyTradeReason || null,
      createdAt: s.createdAt,
      resolvedAt: s.resolvedAt || s.entryExpiredAt || null,
      holdingPeriodMinutes: s.holdingPeriodMinutes || null,
    }));
    // Outcome class özet
    const wins = enriched.filter(x => x.outcome === 'tp3_hit' || x.outcome === 'tp2_hit' || x.outcome === 'tp1_hit' || x.outcome === 'trailing_stop_exit').length;
    const losses = enriched.filter(x => x.outcome === 'sl_hit').length;
    const neutral = enriched.length - wins - losses;
    res.json({
      hours,
      generatedAt: new Date().toISOString(),
      summary: { total: enriched.length, wins, losses, neutral },
      signals: enriched,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Signal history for a specific symbol (last N days)
app.get('/api/signals/history/:symbol', (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const days = parseInt(req.query.days) || 3;
  try {
    const signals = getSignalHistory(symbol, days);
    res.json({
      symbol,
      days,
      count: signals.length,
      signals: signals.map(s => ({
        id: s.id,
        symbol: s.symbol,
        timeframe: s.timeframe,
        grade: s.grade,
        direction: s.direction,
        entry: s.entry,
        sl: s.sl,
        tp1: s.tp1,
        tp2: s.tp2,
        tp3: s.tp3,
        rr: s.rr,
        status: s.status,
        outcome: s.outcome || null,
        win: s.win != null ? s.win : null,
        actualRR: s.actualRR || null,
        reasoning: s.reasoning || [],
        warnings: s.warnings || [],
        transitionDirective: s.transitionDirective || null,
        createdAt: s.createdAt,
        resolvedAt: s.resolvedAt || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Patch 2 (2026-05-02) — Shadow snapshot for a single signal id.
// Read-only gozlem datasi; canli karar mantigi bu alanlari okumaz. Karar
// aliminda kullanilmadan once 24-72h gozlem ve backtest karsilastirmasi gerekli.
app.get('/api/signals/:id/shadow', async (req, res) => {
  const { id } = req.params;
  try {
    const persistence = await import('./lib/learning/persistence.js');
    const { readJSON, dataPath, readAllArchives } = persistence;
    const OPEN_PATH = dataPath('signals', 'open.json');
    const open = readJSON(OPEN_PATH, { signals: [] });
    let signal = open.signals.find(s => s.id === id);
    if (!signal) {
      // Try archives
      try {
        const archived = readAllArchives();
        signal = archived.find(s => s.id === id);
      } catch { /* ignore */ }
    }
    if (!signal) return res.status(404).json({ error: 'Sinyal bulunamadi' });
    res.json({
      id: signal.id,
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      grade: signal.grade,
      direction: signal.direction,
      createdAt: signal.createdAt,
      shadowMetrics: signal.shadowMetrics || null,
      shadowVotes: signal.shadowVotes || null,
      shadowMtfScore: signal.shadowMtfScore || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manually close an open signal — used by UI "Kapat" button.
// Signal is archived with status=manual_close and removed from open.json.
app.post('/api/signals/:id/close', async (req, res) => {
  const { id } = req.params;
  const { reason = 'manual', note = '' } = req.body || {};
  try {
    const persistence = await import('./lib/learning/persistence.js');
    const { readJSON, writeJSON, dataPath, appendToArchive } = persistence;
    const OPEN_PATH = dataPath('signals', 'open.json');
    const data = readJSON(OPEN_PATH, { signals: [] });
    const signal = data.signals.find(s => s.id === id);
    if (!signal) return res.status(404).json({ error: 'Sinyal bulunamadi' });
    if (signal.status !== 'open') return res.status(400).json({ error: `Sinyal zaten ${signal.status} durumunda` });

    const nowIso = new Date().toISOString();
    signal.status = 'manual_close';
    signal.manualClose = true;
    signal.manualCloseAt = nowIso;
    signal.manualCloseReason = reason;
    signal.manualCloseNote = note;
    signal.resolvedAt = nowIso;

    // Arsive at (win hesaplamasini outcome-checker gibi yapalim)
    const holdingMs = new Date(nowIso) - new Date(signal.createdAt);
    const archiveRecord = {
      ...signal,
      outcome: 'manual_close',
      holdingPeriodMinutes: Math.round(holdingMs / 60000),
      maxFavorableExcursion: signal.highestFavorable,
      maxAdverseExcursion: signal.lowestAdverse,
      win: signal.tp1Hit || false,
    };
    const yearMonth = nowIso.slice(0, 7);
    appendToArchive(yearMonth, archiveRecord);

    data.signals = data.signals.filter(s => s.id !== id);
    writeJSON(OPEN_PATH, data);

    broadcastWS({ type: 'signal_closed', data: { id, reason } });
    res.json({ ok: true, signal: archiveRecord });
  } catch (e) {
    console.error('[API] /api/signals/:id/close hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

// Cleanup duplicate open signals (one-time migration endpoint).
// Groups by symbol+direction, keeps the best grade + newest, supersedes the rest.
app.post('/api/signals/cleanup-duplicates', (req, res) => {
  try {
    const result = cleanupDuplicateSignals();
    broadcastWS({ type: 'duplicates_cleaned', data: result });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[API] /api/signals/cleanup-duplicates hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/refresh-htf-barrier-levels', (req, res) => {
  try {
    const result = refreshHTFBarrierLevelsForOpenSignals({ symbol: req.body?.symbol || null });
    res.json({ ok: true, ...result });
  } catch (e) {
    console.error('[API] /api/admin/refresh-htf-barrier-levels hatasi:', e);
    res.status(500).json({ error: e.message });
  }
});

// Current weights
app.get('/api/learning/weights', (req, res) => {
  res.json(loadWeights());
});

// Reset weights to defaults
app.post('/api/learning/weights/reset', (req, res) => {
  const result = resetWeights();
  broadcastWS({ type: 'weights_updated', data: { state: 'reset', message: 'Agirliklar sifirlandi' } });
  res.json({ success: true, weights: result });
});

// Force weight adjustment cycle
app.post('/api/learning/adjust', (req, res) => {
  const result = forceAdjustment();
  res.json(result);
});

// Force outcome check
app.post('/api/learning/check-outcomes', async (req, res) => {
  try {
    const result = await forceOutcomeCheck();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Start/stop learning loop
app.post('/api/learning/start', (req, res) => {
  startLearningLoop();
  broadcastWS({ type: 'learning_status', data: getLearningStatus() });
  res.json({ success: true, status: 'started' });
});

app.post('/api/learning/stop', (req, res) => {
  stopLearningLoop();
  broadcastWS({ type: 'learning_status', data: getLearningStatus() });
  res.json({ success: true, status: 'stopped' });
});

// Admin: acik sinyalleri TV ile retroaktif olarak yeniden degerlendir.
// Outcome-checker'in 15 dk pencere sinirindan dolayi kaybolmus fitilleri kurtarir.
app.post('/api/admin/backfill-missed-tps', async (req, res) => {
  try {
    const dryRun = req.query.dry === '1' || req.body?.dryRun === true;
    const { runBackfill } = await import('./scripts/backfill-missed-tps.mjs');
    const result = await runBackfill({ dryRun });
    const summary = {
      total: result.reports.length,
      changed: result.reports.filter(r => !r.error && r.changes?.length > 0).length,
      terminal: result.reports.filter(r => !r.error && r.terminal).length,
      skipped: result.reports.filter(r => r.error).length,
      outPath: result.outPath,
    };
    res.json({ success: true, summary, reports: result.reports });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// --- Initialize macro lock functions (avoids circular dependency) ---
setMacroLockFunctions({ acquireScanLock, releaseScanLock });

// --- Initialize learning system ---
ensureDataDirs();
setLearningIntegration({
  isScanInProgress: () => scheduler.getStatus().scanInProgress || isScanActive(),
  broadcast: broadcastWS,
});
// Auto-start learning loop (runs while server is online)
startLearningLoop();

// --- HTF Fib cache: startup freshness + 24h refresh timer ---
// Kural: scheduler.start() CAGRISINDAN ONCE cache tazelik kontrolu yap.
// Cache < 24h: scheduler hemen basla.
// Cache >= 24h veya yok: once HTF fib refresh calistir, bitince scheduler basla.
const FIB_REFRESH_MS = 24 * 60 * 60 * 1000;
let _htfFibInProgress = false;
let _htfFibTimer = null;

async function startupHTFFibAndScheduler() {
  const status = isFibCacheStale();
  try {
    if (process.env.HTF_FIB_SKIP_STARTUP === '1') {
      console.log('[Startup] HTF fib startup refresh env ile atlandi');
      broadcastWS({ type: 'htf_fib_status', phase: 'startup_skipped_env', status });
    } else if (status.stale) {
      console.log(`[Startup] HTF fib cache STALE (${status.reason || status.ageHours + 'h'}) — scheduler BEKLIYOR, once refresh calisacak`);
      broadcastWS({ type: 'htf_fib_status', phase: 'startup_refresh_start', status });
      _htfFibInProgress = true;
      try {
        const result = await runHTFFibJob({
          onProgress: (p) => broadcastWS({ type: 'htf_fib_progress', ...p }),
        });
        broadcastWS({ type: 'htf_fib_status', phase: 'startup_refresh_done', result: { ok: result.ok, meta: result.meta } });
      } finally {
        _htfFibInProgress = false;
      }
    } else {
      console.log(`[Startup] HTF fib cache taze (${status.ageHours}h) — scheduler direkt basliyor`);
      broadcastWS({ type: 'htf_fib_status', phase: 'startup_skipped', status });
    }
  } catch (e) {
    console.log(`[Startup] HTF fib refresh HATA: ${e.message} — scheduler yine de basliyor`);
    broadcastWS({ type: 'htf_fib_status', phase: 'startup_error', error: e.message });
  }

  // Scheduler her durumda basla (fib refresh hata alsa bile)
  scheduler.start();

  // 24 saatte bir otomatik refresh timer
  _htfFibTimer = setInterval(async () => {
    if (_htfFibInProgress) {
      console.log('[HTF-Fib] Timer tetiklendi ama zaten calisiyor — atlandi');
      return;
    }
    console.log('[HTF-Fib] 24h timer tetiklendi — scheduler duraklatilip refresh calisacak');
    broadcastWS({ type: 'htf_fib_status', phase: 'periodic_start' });
    // Scheduler'i duraklat: drain ile devam eden scan bittikten sonra fib calisir
    const wasRunning = scheduler.running;
    if (wasRunning) {
      scheduler.stop();
      drainLockQueue();
      // Aktif scan bitene kadar kisa bekle
      let waited = 0;
      while (isScanActive() && waited < 30000) {
        await new Promise(r => setTimeout(r, 500));
        waited += 500;
      }
    }
    _htfFibInProgress = true;
    try {
      const result = await runHTFFibJob({
        onProgress: (p) => broadcastWS({ type: 'htf_fib_progress', ...p }),
      });
      broadcastWS({ type: 'htf_fib_status', phase: 'periodic_done', result: { ok: result.ok, meta: result.meta } });
    } catch (e) {
      broadcastWS({ type: 'htf_fib_status', phase: 'periodic_error', error: e.message });
    } finally {
      _htfFibInProgress = false;
      if (wasRunning) scheduler.start();
    }
  }, FIB_REFRESH_MS);
}

// Fire-and-forget startup orchestration. setImmediate: izin ver server.listen
// callback'i logu bassin, sonra agir is basla.
setImmediate(() => { startupHTFFibAndScheduler().catch(e => console.error('[Startup]', e)); });

// --- Start server ---
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     TV Scanner — Otonom Trading Analiz Sistemi       ║
║                                                      ║
║  Web UI:  http://localhost:${PORT}                     ║
║  API:     http://localhost:${PORT}/api/health           ║
║                                                      ║
║  Komutlar:                                           ║
║  POST /api/scheduler/start   → Otomatik tarama baslat║
║  POST /api/scheduler/stop    → Durdur                ║
║  POST /api/scan/short        → Tekli kisa vade       ║
║  POST /api/scan/long         → Tekli uzun vade       ║
║  POST /api/scan/batch        → Toplu tarama          ║
║  POST /api/scan/custom       → Ozel TF tarama        ║
║  POST /api/backtest          → Backtest              ║
║                                                      ║
║  TradingView Desktop CDP modunda acik olmali!        ║
╚══════════════════════════════════════════════════════╝
  `);
});
