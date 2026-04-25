/**
 * Scheduler — manages automatic scan cycles.
 * Her 1 saatte bir tum "acik" kategorileri sirayla tarar.
 * Acik/kapali karari scanner/lib/market-hours.js icinde tanimli.
 *   kripto   : 24/7
 *   forex    : Pazar 22:00 UTC -> Cuma 22:00 UTC
 *   abd_hisse: hafta ici UTC 13:30-20:00
 *   bist     : hafta ici UTC 07:00-15:00
 *   emtia    : Pazar 23:00 UTC -> Cuma 22:00 UTC, gunluk 22:00-23:00 mola
 *
 * Manuel REST uclari (server.js icindeki /api/scan/*) bu filtreden gecmez —
 * kullanici localhost uzerinden istedigi zaman tarama yapabilir.
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

import { batchScan } from './scanner-engine.js';
import { ensureConnection } from './tv-bridge.js';
import { dispatchToOkxExecutor as dispatchToOkxExecutorShared } from './okx-dispatcher.js';
import { isHalted, getHaltState } from './halt-state.js';
import { isLive as isWrapperLive, getWrapperMode } from './learning/wrapper-mode.js';
import {
  ALL_CATEGORIES,
  openMarkets,
  marketStatusMap,
  isMarketOpen,
  isUSEquityOpen,
  isBISTOpen,
  isWeekday,
} from './market-hours.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTIFY_SCRIPT = path.resolve(__dirname, '../../scripts/notify-signal.sh');

/** Otomatik tarama donguleri arasi bekleme suresi. */
const SCAN_INTERVAL_MS = 60 * 60 * 1000; // 1 saat

/**
 * Fire-and-forget: A veya B kalite sinyal icin `scripts/notify-signal.sh`
 * cagir. Cevap bekleme, hata olsa bile scheduler akisini bozma.
 * SIGNAL_NOTIFY_ENABLED=1 olmadikca script zaten hicbir sey yapmaz.
 */
function dispatchSignalNotify(signal) {
  if (process.env.SIGNAL_NOTIFY_ENABLED !== '1') return;
  try {
    const child = spawn(NOTIFY_SCRIPT, [], {
      env: { ...process.env, SIGNAL_JSON: JSON.stringify(signal) },
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Sessiz gec — notify opsiyonel
  }
}

/**
 * OKX Executor'a (localhost:3939) gercek trade icin POST.
 * Sadece `kripto` kategorisinde, A/B/C kaliteli sinyaller iletilir.
 * A/B → otonom trade. C → dashboard'da manuel onay bekler.
 * Executor kapali/erisilemez ise sinyal `data/okx-queue.json`'a yazilir ve
 * executor ayaga kalkinca otomatik drain edilir (bkz. lib/okx-dispatcher.js).
 */
function dispatchToOkxExecutor(signal) {
  if (signal.category !== 'kripto') return;
  if (!['A', 'B', 'C'].includes(signal.grade)) return;
  // Ladder filtresi: yalnizca league='real' sinyaller executor'a gider.
  if (signal.league && signal.league !== 'real') return;
  // Faz 2 wrapper shadow mode: dispatch yok (operator /api/wrapper/mode ile live'a geçer)
  if (!isWrapperLive()) {
    const m = getWrapperMode();
    console.log(`[scheduler] dispatch SHADOW MODE (${m.mode}) → ${signal.symbol}/${signal.timeframe} ${signal.grade} log'landı, executor'a gönderilmedi`);
    return;
  }

  const payload = {
    symbol_tv: signal.symbol,
    tf: String(signal.timeframe ?? ''),
    side: signal.direction === 'short' ? 'short' : 'long',
    quality: signal.grade,
    entry: Number(signal.entry),
    sl: Number(signal.sl),
    tp1: signal.tp1 != null ? Number(signal.tp1) : undefined,
    tp2: signal.tp2 != null ? Number(signal.tp2) : undefined,
    tp3: signal.tp3 != null ? Number(signal.tp3) : undefined,
    reason: {
      id: signal.id,
      rr: signal.rr,
      indicators: signal.indicators,
      reasoning: signal.reasoning,
      warnings: signal.warnings,
    },
  };
  dispatchToOkxExecutorShared(payload);
}

class ScanScheduler {
  constructor() {
    this.timers = {};
    this.running = false;
    this.scanHistory = [];
    this.maxHistory = 100;
    this.listeners = new Set();
    this.scanInProgress = false;
    this.pausedCategories = new Set();
    this._abortRequested = false;
    this._currentCategory = null;
    this._scanQueue = [];
    this._queueTimer = null;
  }

  /**
   * Register a listener for scan results.
   */
  onResult(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Broadcast result to all listeners.
   */
  broadcast(event) {
    for (const cb of this.listeners) {
      try { cb(event); } catch {}
    }
  }

  /**
   * Request abort — immediately stops the current and queued scans.
   */
  requestAbort() {
    this._abortRequested = true;
    this._scanQueue = [];
  }

  /**
   * Check if abort was requested (called by scanner-engine between symbols).
   */
  isAbortRequested() {
    return this._abortRequested;
  }

  /**
   * Clear abort flag (after stop completes).
   */
  clearAbort() {
    this._abortRequested = false;
  }

  /** Geri uyumluluk — market-hours.js'e delege. */
  isUSMarketHours() { return isUSEquityOpen(); }
  isBISTMarketHours() { return isBISTOpen(); }
  isWeekday() { return isWeekday(); }

  /**
   * Start all scheduled scans (default behavior — runs on startup).
   */
  start() {
    if (this.running) return;
    this.running = true;
    this._abortRequested = false;

    this.broadcast({
      type: 'scheduler_status',
      status: 'started',
      timestamp: new Date().toISOString(),
    });

    // Start the rotation cycle — scans all categories sequentially then waits
    this._startRotationCycle();

    console.log('[Scheduler] Baslatildi — TUM kategoriler taranacak (kripto, forex, abd_hisse, bist, emtia)');
  }

  /**
   * Stop all scheduled scans IMMEDIATELY.
   * Aborts any in-progress scan and clears all timers.
   */
  stop() {
    this.running = false;
    this.requestAbort();

    // Clear all timers
    for (const [key, timer] of Object.entries(this.timers)) {
      clearInterval(timer);
      clearTimeout(timer);
      delete this.timers[key];
    }
    if (this._queueTimer) {
      clearTimeout(this._queueTimer);
      this._queueTimer = null;
    }
    this._scanQueue = [];

    this.broadcast({
      type: 'scheduler_status',
      status: 'stopped',
      timestamp: new Date().toISOString(),
    });

    console.log('[Scheduler] Durduruldu — tum taramalar iptal edildi');
  }

  /**
   * Pause a specific category.
   */
  pause(category) {
    this.pausedCategories.add(category);
    this.broadcast({ type: 'category_paused', category });
  }

  /**
   * Resume a specific category.
   */
  resume(category) {
    this.pausedCategories.delete(category);
    this.broadcast({ type: 'category_resumed', category });
  }

  /**
   * Start the rotation cycle: scan all eligible categories, then wait 1 hour, repeat.
   */
  _startRotationCycle() {
    // Run first cycle after 5 seconds
    setTimeout(() => this._runFullCycle(), 5000);
  }

  /**
   * Run a full scan cycle through all eligible categories.
   */
  async _runFullCycle() {
    if (!this.running || this._abortRequested) return;

    // Risk #3 — Kill switch aktifse cycle baslatma
    if (isHalted()) {
      const s = getHaltState();
      this.broadcast({
        type: 'scheduler_halted',
        reason: s.reason,
        haltedAt: s.haltedAt,
        timestamp: new Date().toISOString(),
      });
      console.warn(`[Scheduler] HALT aktif (${s.reason}) — cycle atlaniyor, 60sn sonra tekrar kontrol`);
      this.timers.nextCycle = setTimeout(() => this._runFullCycle(), 60_000);
      return;
    }

    const categories = this._getEligibleCategories();

    if (categories.length === 0) {
      this.broadcast({
        type: 'scheduler_idle',
        reason: 'Tum piyasalar kapali — 1 saat sonra tekrar kontrol',
        marketsOpen: [],
        timestamp: new Date().toISOString(),
      });
      console.log('[Scheduler] Tum piyasalar kapali — 1 saat sonra tekrar kontrol edilecek');
      this.timers.nextCycle = setTimeout(() => this._runFullCycle(), SCAN_INTERVAL_MS);
      return;
    }

    console.log(`[Scheduler] Acik piyasalar: ${categories.join(', ')}`);

    for (const category of categories) {
      if (!this.running || this._abortRequested) break;
      if (isHalted()) { console.warn('[Scheduler] HALT mid-cycle — ara veriliyor'); break; }
      if (this.pausedCategories.has(category)) continue;

      await this._runCategoryScan(category);

      // Brief pause between categories to let chart settle
      if (this.running && !this._abortRequested) {
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Schedule next cycle in 1 hour
    if (this.running && !this._abortRequested) {
      this.timers.nextCycle = setTimeout(() => this._runFullCycle(), SCAN_INTERVAL_MS);
      console.log('[Scheduler] Tur tamamlandi — sonraki tur 1 saat sonra');
    }
  }

  /**
   * Get categories eligible for scanning right now.
   * Kapali olan piyasalar (hafta sonu forex, emtia molasi, US/BIST kapanisi vs.)
   * otomatik taramadan haric tutulur.
   */
  _getEligibleCategories() {
    return openMarkets();
  }

  /**
   * Run scan for a single category.
   */
  async _runCategoryScan(category) {
    if (!this.running || this._abortRequested || this.scanInProgress) return;

    this.scanInProgress = true;
    this._currentCategory = category;

    this.broadcast({
      type: 'scan_start',
      category,
      mode: 'short',
      timestamp: new Date().toISOString(),
    });

    try {
      const conn = await ensureConnection();
      if (!conn.connected && conn.error) {
        throw new Error(`TradingView baglantisi yok: ${conn.error}`);
      }

      // Check abort before starting
      if (this._abortRequested) {
        this.broadcast({
          type: 'scan_complete',
          category,
          result: { signals: [], symbolCount: 0, scanDuration: '0s', aborted: true },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const result = await batchScan(category, 'short', {
        abortCheck: () => this._abortRequested,
        respectCooldown: true, // Scheduler honors per-symbol 15dk cooldown
      });

      if (this._abortRequested) {
        result.aborted = true;
      }

      this.addToHistory(category, result);
      this.broadcast({
        type: 'scan_complete',
        category,
        mode: 'short',
        result,
        timestamp: new Date().toISOString(),
      });

      // Alert on actionable signals (A and B grade)
      const strongSignals = (result.signals || []).filter(s => s.grade === 'A' || s.grade === 'B');
      if (strongSignals.length > 0) {
        this.broadcast({
          type: 'signal_alert',
          category,
          signals: strongSignals,
          timestamp: new Date().toISOString(),
        });
        // Otonom pipeline: SIGNAL_NOTIFY_ENABLED=1 ise her guclu sinyal icin
        // arka planda `claude -p` ile kisa analiz uretilir, log + Telegram.
        for (const s of strongSignals) {
          dispatchSignalNotify(s);
        }
      }

      // OKX Executor: A/B otonom, C manuel onay. Sadece kripto kategorisi.
      const tradable = (result.signals || []).filter(s => ['A', 'B', 'C'].includes(s.grade));
      for (const s of tradable) {
        dispatchToOkxExecutor(s);
      }
    } catch (e) {
      this.broadcast({
        type: 'scan_error',
        category,
        error: e.message,
        timestamp: new Date().toISOString(),
      });
    } finally {
      this.scanInProgress = false;
      this._currentCategory = null;
    }
  }

  /**
   * Add scan result to history.
   */
  addToHistory(category, result) {
    this.scanHistory.unshift({
      category,
      timestamp: new Date().toISOString(),
      signalCount: result.signals?.length || 0,
      symbolCount: result.symbolCount || 0,
      duration: result.scanDuration,
      aborted: result.aborted || false,
    });

    if (this.scanHistory.length > this.maxHistory) {
      this.scanHistory = this.scanHistory.slice(0, this.maxHistory);
    }
  }

  /**
   * Get scheduler status.
   */
  getStatus() {
    const openNow = openMarkets();
    const eligible = this.running ? this._getEligibleCategories() : [];
    return {
      running: this.running,
      scanInProgress: this.scanInProgress,
      currentCategory: this._currentCategory,
      pausedCategories: Array.from(this.pausedCategories),
      eligibleCategories: eligible,
      marketsOpen: openNow,
      marketStatus: marketStatusMap(),
      usMarketOpen: this.isUSMarketHours(),
      bistMarketOpen: this.isBISTMarketHours(),
      nextCycleScan: this.running ? '~1 saat aralikla acik piyasalar' : 'Durduruldu',
      recentScans: this.scanHistory.slice(0, 10),
    };
  }
}

export const scheduler = new ScanScheduler();
