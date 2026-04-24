/**
 * Fib Engine — HTF (4H / 1D / 1W) Fibonacci retracement + extension seviyeleri
 * ve yapisal trend tespiti. Scanner her 24 saatte bir (veya startup tazelik
 * kontrolu ile) bu job'u calistirir; cikti `data/fib/<symbol>.json` +
 * `data/fib/_meta.json` dosyalarina yazilir.
 *
 * CLAUDE.md "HTF Fibonacci Cercevesi" bolumuyle uyumludur.
 */

import * as bridge from './tv-bridge.js';
import { findSwingPoints } from './formation-detector.js';
import { readJSON, writeJSON, dataPath } from './learning/persistence.js';
import { acquireScanLock, releaseScanLock } from './scanner-engine.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

const RETRACEMENT_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.705, 0.786, 0.886];
const EXTENSION_LEVELS = [1.272, 1.414, 1.618, 2.0, 2.618];

// HTF TF listesi — TradingView resolution notasyonu
// 24h refresh periyoduyla uyumlu olmak icin sadece 1D ve 1W. 4H swing'ler 24h'te
// guncelligini yitiriyordu; LTF sinyali zaten 15m/30m/1h'da kendi trend'ini okuyor.
const HTF_TFS = ['1D', '1W'];
const BAR_COUNT = 200; // swing tespiti icin yeterli

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Wilder ADX(14). Bars: [{open, high, low, close, volume}, ...]
 * Returns last ADX value (number) or null if insufficient data.
 */
function computeADX(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 1) return null;
  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    const ph = bars[i - 1].high, pl = bars[i - 1].low;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
  }
  // Wilder smoothing
  const smooth = (arr) => {
    let s = arr.slice(0, period).reduce((a, b) => a + b, 0);
    const out = [s];
    for (let i = period; i < arr.length; i++) {
      s = s - s / period + arr[i];
      out.push(s);
    }
    return out;
  };
  const trS = smooth(tr), pS = smooth(plusDM), mS = smooth(minusDM);
  const dx = [];
  for (let i = 0; i < trS.length; i++) {
    const pdi = (pS[i] / trS[i]) * 100;
    const mdi = (mS[i] / trS[i]) * 100;
    const denom = pdi + mdi;
    dx.push(denom === 0 ? 0 : (Math.abs(pdi - mdi) / denom) * 100);
  }
  if (dx.length < period) return null;
  // ADX = Wilder smoothed DX
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }
  return Math.round(adx * 10) / 10;
}

/**
 * ATR(14) — son deger.
 */
function computeATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
  }
  return atr;
}

/**
 * Dominant swing secimi: son N barin en yuksek swing-high ve en dusuk
 * swing-low noktalari. Zaman sirasi yonu belirler:
 *   low.time < high.time => "up" swing (fib retracement long)
 *   low.time > high.time => "down" swing (fib retracement short)
 */
function pickDominantSwing(bars) {
  const { swingHighs, swingLows } = findSwingPoints(bars, 5);
  if (!swingHighs.length || !swingLows.length) {
    // Fallback: kullan absolute high/low
    let hi = bars[0], lo = bars[0];
    for (const b of bars) {
      if (b.high > hi.high) hi = b;
      if (b.low < lo.low) lo = b;
    }
    return {
      high: { price: hi.high, time: hi.time },
      low: { price: lo.low, time: lo.time },
      direction: hi.time > lo.time ? 'up' : 'down',
      source: 'absolute',
    };
  }
  const hi = swingHighs.reduce((a, b) => (b.price > a.price ? b : a), swingHighs[0]);
  const lo = swingLows.reduce((a, b) => (b.price < a.price ? b : a), swingLows[0]);
  return {
    high: { price: hi.price, time: hi.time, index: hi.index },
    low: { price: lo.price, time: lo.time, index: lo.index },
    direction: hi.time > lo.time ? 'up' : 'down',
    source: 'swing',
  };
}

/**
 * Bir bar setinden fib retracement + extension seviyeleri.
 * Up swing: entry low, target high; fib retracement low → high (0=low, 1=high).
 * Down swing: entry high, target low; fib retracement high → low (0=high, 1=low).
 */
export function computeFibLevels(bars, tf) {
  if (!bars || bars.length < 20) return null;
  const swing = pickDominantSwing(bars);
  const { high, low, direction } = swing;
  const range = high.price - low.price;
  if (range <= 0) return null;

  const retracement = RETRACEMENT_LEVELS.map(level => {
    const price = direction === 'up'
      ? high.price - range * level       // Up swing: retracement asagi
      : low.price + range * level;       // Down swing: retracement yukari
    return { level, price: Number(price.toFixed(6)), tf };
  });

  const extensions = EXTENSION_LEVELS.map(level => {
    const price = direction === 'up'
      ? low.price + range * level        // Up swing: extension hedefleri yukari
      : high.price - range * level;      // Down swing: extension hedefleri asagi
    return { level, price: Number(price.toFixed(6)), tf };
  });

  const goldenZone = {
    from: retracement.find(r => r.level === 0.618)?.price ?? null,
    to: retracement.find(r => r.level === 0.786)?.price ?? null,
  };

  return {
    tf,
    direction,
    swing: {
      high: { price: high.price, time: high.time },
      low: { price: low.price, time: low.time },
    },
    range: Number(range.toFixed(6)),
    retracement,
    extensions,
    goldenZone,
  };
}

/**
 * Yapisal trend tespiti: son 30 barda HH/HL vs LH/LL vs yatay.
 */
function detectStructuralTrend(bars) {
  if (!bars || bars.length < 20) return { structural: 'insufficient', reason: 'az bar' };
  const { swingHighs, swingLows } = findSwingPoints(bars, 3);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { structural: 'sideways', reason: 'swing sayisi yetersiz' };
  }
  const lastHs = swingHighs.slice(-3);
  const lastLs = swingLows.slice(-3);
  const hhOk = lastHs.every((h, i) => i === 0 || h.price > lastHs[i - 1].price);
  const hlOk = lastLs.every((l, i) => i === 0 || l.price > lastLs[i - 1].price);
  const lhOk = lastHs.every((h, i) => i === 0 || h.price < lastHs[i - 1].price);
  const llOk = lastLs.every((l, i) => i === 0 || l.price < lastLs[i - 1].price);

  if (hhOk && hlOk) return { structural: 'up', reason: 'HH + HL' };
  if (lhOk && llOk) return { structural: 'down', reason: 'LH + LL' };

  // Yatay kanal: son 30 bar range / ATR orani
  const last30 = bars.slice(-30);
  const rangeAbs = Math.max(...last30.map(b => b.high)) - Math.min(...last30.map(b => b.low));
  const atr = computeATR(bars);
  if (atr && rangeAbs < atr * 3.5) {
    return { structural: 'sideways', reason: `dar kanal (range=${rangeAbs.toFixed(2)}, ATR*3.5=${(atr * 3.5).toFixed(2)})` };
  }
  return { structural: 'mixed', reason: 'swing yapisi karisik' };
}

/**
 * Trend rejimi: ADX + yapisal birlesik.
 *   TREND-UP/DOWN: ADX>25 + yapisal up/down
 *   GECIS: ADX 20-25 veya yapi karisik
 *   YATAY: ADX<20 veya yapisal sideways
 */
export function classifyHTFTrend(bars) {
  const adx = computeADX(bars);
  const struct = detectStructuralTrend(bars);
  let regime = 'transition';
  if (adx != null && adx < 20) regime = 'sideways';
  else if (struct.structural === 'sideways') regime = 'sideways';
  else if (adx != null && adx > 25 && struct.structural === 'up') regime = 'trend_up';
  else if (adx != null && adx > 25 && struct.structural === 'down') regime = 'trend_down';
  else if (adx != null && adx >= 20 && adx <= 25) regime = 'transition';
  return {
    regime,
    adx,
    structural: struct.structural,
    structuralReason: struct.reason,
  };
}

/**
 * Bir sembol icin TUM HTF TF'lerde fib ve trend ciktilari.
 * ONEMLI: bu fonksiyon chart kilidini KENDI ALMAZ — caller (runHTFFibJob)
 * kilidi bir kez alir ve butun sembolleri sirayla isler.
 */
export async function computeHTFFibsForSymbol(symbol) {
  const setRes = await bridge.setSymbol(symbol);
  if (!setRes?.success) {
    return { symbol, error: `setSymbol basarisiz: ${setRes?.warning || 'unknown'}`, timeframes: {} };
  }
  await sleep(800);

  const perTF = {};
  for (const tf of HTF_TFS) {
    try {
      await bridge.setTimeframe(tf);
      await sleep(1500);
      const ohlcv = await bridge.getOhlcv(BAR_COUNT, false, symbol);
      if (ohlcv && ohlcv._symbolMismatch) {
        perTF[tf] = { error: `symbol mismatch: beklenen ${ohlcv._expected}, alinan ${ohlcv._got}` };
        continue;
      }
      const bars = ohlcv?.bars || [];
      if (bars.length < 30) {
        perTF[tf] = { error: `yetersiz bar (${bars.length})` };
        continue;
      }
      const fib = computeFibLevels(bars, tf);
      const trend = classifyHTFTrend(bars);
      const lastPrice = bars[bars.length - 1].close;

      // SMC yatay seviyelerini de bu TF'de iken oku — piggyback, ek chart
      // switch maliyeti yok. Bos liste/hata durumunda [] dusurur. Dedupli,
      // siralanmis fiyat listesi olarak saklanir (parseSMCLines mantigi).
      let smcLines = [];
      try {
        const smc = await bridge.readSMC();
        if (smc && Array.isArray(smc.lines)) {
          const set = new Set();
          for (const study of smc.lines) {
            for (const lv of (study?.horizontal_levels || [])) {
              if (typeof lv === 'number' && isFinite(lv) && lv > 0) set.add(Number(lv));
            }
          }
          smcLines = Array.from(set).sort((a, b) => b - a);
        }
      } catch (e) {
        // readSMC hatasi fib'i bozmasin — sadece bos dizi birak
        smcLines = [];
      }

      perTF[tf] = {
        fib,
        trend,
        lastPrice: Number(lastPrice.toFixed(6)),
        smcLines,
      };
    } catch (e) {
      perTF[tf] = { error: String(e?.message || e) };
    }
  }

  return {
    symbol,
    refreshed_at: new Date().toISOString(),
    timeframes: perTF,
  };
}

function loadWatchlist() {
  try {
    const raw = fs.readFileSync(RULES_PATH, 'utf-8');
    const rules = JSON.parse(raw);
    const all = [];
    for (const [cat, syms] of Object.entries(rules.watchlist || {})) {
      for (const s of syms) all.push({ symbol: s, category: cat });
    }
    return all;
  } catch {
    return [];
  }
}

/**
 * Tam HTF tarama: watchlist'teki tum sembolleri 4H/1D/1W icin fib + trend.
 * Chart kilidini alir, siralanmis olarak isler, bitince birakir.
 * Her sembol icin data/fib/<symbol>.json yazilir; son _meta.json guncellenir.
 */
export async function runHTFFibJob({ onProgress = null } = {}) {
  const startedAt = new Date().toISOString();
  const watchlist = loadWatchlist();
  if (!watchlist.length) {
    console.log('[HTF-Fib] Watchlist bos — iptal');
    return { ok: false, reason: 'empty_watchlist' };
  }
  console.log(`[HTF-Fib] Baslatildi — ${watchlist.length} sembol x ${HTF_TFS.length} TF`);

  await acquireScanLock('htf-fib-job', 120000);
  const conn = await bridge.ensureConnection();
  if (!conn.connected) {
    releaseScanLock();
    console.log(`[HTF-Fib] TradingView baglantisi yok: ${conn.error}`);
    return { ok: false, reason: 'no_tv_connection', error: conn.error };
  }

  const results = [];
  const errors = [];

  try {
    for (let i = 0; i < watchlist.length; i++) {
      const { symbol, category } = watchlist[i];
      const label = `${i + 1}/${watchlist.length} ${symbol}`;
      try {
        const res = await computeHTFFibsForSymbol(symbol);
        res.category = category;
        const outFile = dataPath('fib', `${sanitizeSymbol(symbol)}.json`);
        writeJSON(outFile, res);
        results.push({ symbol, ok: true, file: outFile });
        console.log(`[HTF-Fib] ${label} ✓`);
      } catch (e) {
        const msg = String(e?.message || e);
        errors.push({ symbol, error: msg });
        console.log(`[HTF-Fib] ${label} ✗ ${msg}`);
      }
      if (onProgress) {
        try { onProgress({ current: i + 1, total: watchlist.length, symbol }); } catch {}
      }
      await sleep(400);
    }
  } finally {
    releaseScanLock();
  }

  const finishedAt = new Date().toISOString();
  const meta = {
    last_full_refresh_at: finishedAt,
    started_at: startedAt,
    symbol_count: results.length,
    error_count: errors.length,
    htf_tfs: HTF_TFS,
    errors: errors.slice(0, 20),
  };
  writeJSON(dataPath('fib', '_meta.json'), meta);
  console.log(`[HTF-Fib] Tamamlandi — ok:${results.length} err:${errors.length}`);
  return { ok: true, meta, results, errors };
}

function sanitizeSymbol(symbol) {
  return String(symbol).replace(/[:/\\]/g, '_');
}

/**
 * Fib cache tazelik kontrolu. >= 24h ise true (stale).
 */
export function isFibCacheStale(maxAgeMs = 24 * 60 * 60 * 1000) {
  const meta = readJSON(dataPath('fib', '_meta.json'), null);
  if (!meta || !meta.last_full_refresh_at) return { stale: true, reason: 'meta yok', lastRefreshAt: null };
  const last = new Date(meta.last_full_refresh_at);
  const ageMs = Date.now() - last.getTime();
  return {
    stale: ageMs >= maxAgeMs,
    ageMs,
    ageHours: Number((ageMs / 3600000).toFixed(2)),
    lastRefreshAt: meta.last_full_refresh_at,
  };
}

/**
 * Bir sembolun kayitli fib cache'ini okur. Bulunamazsa null.
 */
export function loadFibCache(symbol) {
  const file = dataPath('fib', `${sanitizeSymbol(symbol)}.json`);
  return readJSON(file, null);
}

/**
 * Faz 0 patch (f) — Risk #6 (HTF fib cache stale).
 * Per-sembol cache yas kontrolu. `refreshed_at` uzerinden yaslilik hesaplar.
 *
 * @param {object|null} cache — loadFibCache() ciktisi
 * @param {number} [warnMs=24h] — warn esigi
 * @returns {{ missing:boolean, stale:boolean, ageMs:number|null, ageHours:number|null, refreshedAt:string|null }}
 */
export function checkFibCacheAge(cache, warnMs = 24 * 60 * 60 * 1000) {
  if (!cache || !cache.refreshed_at) {
    return { missing: true, stale: true, ageMs: null, ageHours: null, refreshedAt: null };
  }
  const t = Date.parse(cache.refreshed_at);
  if (!Number.isFinite(t)) {
    return { missing: false, stale: true, ageMs: null, ageHours: null, refreshedAt: cache.refreshed_at };
  }
  const ageMs = Date.now() - t;
  return {
    missing: false,
    stale: ageMs >= warnMs,
    ageMs,
    ageHours: Number((ageMs / 3600000).toFixed(2)),
    refreshedAt: cache.refreshed_at,
  };
}

/**
 * Stale cache kullanim sayacini artirir. Gunluk bucket — `stale_used_24h`
 * metrigini dashboard'dan izleyebilmek icin. Faz 0 patch (f).
 *
 * Dosya: data/fib/_stale-counter.json
 *   { date: 'YYYY-MM-DD', total: N, bySymbol: { BTCUSDT: 3, ... }, missingCount: N }
 * Tarih degisince bucket sifirlanir (onceki gunun toplami `yesterday` anahtarina
 * tasinir — dashboard son 24h'i okur).
 */
export function recordStaleFibUsage(symbol, { missing = false } = {}) {
  const counterPath = dataPath('fib', '_stale-counter.json');
  const today = new Date().toISOString().slice(0, 10);
  let c = readJSON(counterPath, null);
  if (!c || typeof c !== 'object') c = { date: today, total: 0, missingCount: 0, bySymbol: {}, yesterday: null };
  if (c.date !== today) {
    c = { date: today, total: 0, missingCount: 0, bySymbol: {}, yesterday: { date: c.date, total: c.total, missingCount: c.missingCount } };
  }
  c.total = (c.total || 0) + 1;
  if (missing) c.missingCount = (c.missingCount || 0) + 1;
  const key = String(symbol || 'UNKNOWN').toUpperCase();
  c.bySymbol[key] = (c.bySymbol[key] || 0) + 1;
  try { writeJSON(counterPath, c); } catch (e) { console.warn('[HTF-Fib] stale counter yazim hatasi:', e.message); }
  return c;
}

/**
 * Startup akisi: cache stale ise HTF fib refresh'i calistir; degilse atla.
 */
export async function ensureHTFFibCache() {
  const status = isFibCacheStale();
  if (!status.stale) {
    console.log(`[HTF-Fib] Cache taze (yas: ${status.ageHours}h) — refresh atlanacak`);
    return { ran: false, status };
  }
  console.log(`[HTF-Fib] Cache stale (${status.reason || status.ageHours + 'h'}) — refresh calisiyor…`);
  const result = await runHTFFibJob();
  return { ran: true, status, result };
}

export const HTF_FIB_CONFIG = {
  HTF_TFS,
  BAR_COUNT,
  RETRACEMENT_LEVELS,
  EXTENSION_LEVELS,
};
