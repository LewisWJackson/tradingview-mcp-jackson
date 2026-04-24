/**
 * Macro Correlation Filter — Step 0 before any scan.
 * Checks USDT.D, BTC.D, DXY, VIX, US10Y
 *
 * Trend detection: Supertrend study → EMA 9/21 cross fallback → unknown
 */

import * as bridge from './tv-bridge.js';

// Lock functions injected via setMacroLockFunctions to avoid circular dependency with scanner-engine
let _acquireLock = null;
let _releaseLock = null;

/**
 * Inject chart lock functions from scanner-engine (called from server.js at startup).
 * This avoids circular dependency: scanner-engine → macro-filter → scanner-engine
 */
export function setMacroLockFunctions({ acquireScanLock, releaseScanLock }) {
  _acquireLock = acquireScanLock;
  _releaseLock = releaseScanLock;
}

const MACRO_SYMBOLS = {
  'CRYPTOCAP:USDT.D':  { type: 'supertrend', label: 'USDT.D', affects: 'crypto', rule: 'ST yesil → kripto long sinyallerini 1 kademe dusur' },
  'CRYPTOCAP:BTC.D':   { type: 'supertrend', label: 'BTC.D', affects: 'crypto', rule: 'ST yesil → altcoin long dikkat, BTC daha guçlu' },
  'TVC:DXY':           { type: 'supertrend', label: 'DXY', affects: 'forex_gold', rule: 'ST yesil → major forex short guclu, altin long dikkat' },
  'CBOE:VIX':          { type: 'price', label: 'VIX', affects: 'stocks', rule: '>25 dikkat, >35 sadece hedge' },
  'TVC:US10Y':         { type: 'supertrend', label: 'US10Y', affects: 'gold_bonds', rule: 'ST kirmizi + DXY kirmizi → altin long cok guclu' },
};

let cachedMacroState = null;
let cacheTimestamp = 0;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes

/**
 * Calculate EMA from price array.
 */
function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

/**
 * Determine trend from OHLCV using EMA 9/21 cross.
 * Returns 'bullish' | 'bearish' | 'unknown'
 */
function trendFromOHLCV(bars) {
  if (!bars || bars.length < 25) return 'unknown';
  const closes = bars.map(b => b.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  if (ema9 == null || ema21 == null) return 'unknown';
  if (ema9 > ema21) return 'bullish';
  if (ema9 < ema21) return 'bearish';
  return 'unknown';
}

/**
 * Read macro state from TradingView.
 * Caches results for 15 minutes.
 */
/**
 * Read macro state from TradingView.
 * Caches results for 15 minutes.
 * @param {boolean} forceRefresh - Force re-read from chart
 * @param {boolean} alreadyLocked - If true, caller already holds the chart lock (e.g. from batchScan)
 */
export async function getMacroState(forceRefresh = false, alreadyLocked = false) {
  if (!forceRefresh && cachedMacroState && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    return cachedMacroState;
  }

  // Acquire chart lock if we don't already have it
  let weAcquiredLock = false;
  if (!alreadyLocked && _acquireLock && _releaseLock) {
    try {
      await _acquireLock('macro-filter', 15000);
      weAcquiredLock = true;
    } catch (e) {
      console.log(`[Macro] Chart kilidi alinamadi, cached veri donuyor: ${e.message}`);
      return cachedMacroState; // Return stale cache rather than fighting for chart
    }
  } else if (!alreadyLocked && !_acquireLock) {
    console.log('[Macro] UYARI: Lock fonksiyonlari henuz ayarlanmamis, kilitsiz devam ediliyor');
  }

  try {
    return await _getMacroStateInner(forceRefresh);
  } finally {
    if (weAcquiredLock && _releaseLock) {
      _releaseLock();
    }
  }
}

async function _getMacroStateInner(forceRefresh) {
  const state = {};

  for (const [symbol, config] of Object.entries(MACRO_SYMBOLS)) {
    const label = config.label;
    try {
      const symResult = await bridge.setSymbol(symbol);
      if (symResult.success === false) {
        console.log(`[Macro] ${symbol} sembol degistirilemedi: ${symResult.warning || 'bilinmeyen hata'}`);
      }
      await bridge.setTimeframe('1D');
      // Extra settle for macro symbols — cross-asset switches need more time
      // VIX and other indices need longer because chart reloads data from different exchange
      await new Promise(r => setTimeout(r, 3000));

      if (config.type === 'price') {
        // VIX — read price with retry to ensure correct symbol data loaded
        let lastPrice = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          // Try quote first
          const quote = await bridge.getQuote().catch(() => null);
          const price = quote?.close ?? null;
          console.log(`[Macro] ${label} attempt ${attempt + 1}: quote=${price}`);
          // VIX sanity check: must be between 5 and 100
          if (price != null && price >= 5 && price <= 100) {
            lastPrice = price;
            break;
          }
          // OHLCV fallback — get more bars for reliability
          const ohlcv = await bridge.getOhlcv(10, false).catch(() => null);
          const bars = ohlcv?.bars;
          if (bars && bars.length > 0) {
            const oPrice = bars[bars.length - 1].close;
            console.log(`[Macro] ${label} OHLCV fallback: close=${oPrice}`);
            if (oPrice != null && oPrice >= 5 && oPrice <= 100) {
              lastPrice = oPrice;
              break;
            }
          }
          // Data not ready — wait and retry with longer delay
          await new Promise(r => setTimeout(r, 3000));
        }
        if (lastPrice == null) {
          console.log(`[Macro] UYARI: ${label} fiyati 3 denemede alinamadi`);
        }
        state[label] = {
          type: 'price',
          value: lastPrice,
          level: lastPrice == null ? 'BILINMIYOR' :
                 lastPrice > 35 ? 'PANIK' : lastPrice > 25 ? 'DIKKAT' : 'NORMAL',
        };
      } else {
        // Supertrend-based symbols — try study values first
        let direction = 'unknown';
        const studyValues = await bridge.getStudyValues();

        if (studyValues && Array.isArray(studyValues)) {
          for (const study of studyValues) {
            const name = (study.name || '').toLowerCase();
            if (name.includes('supertrend')) {
              const up = study.values?.['Up Trend'] || study.values?.['up'] || study.values?.['Up'];
              const down = study.values?.['Down Trend'] || study.values?.['down'] || study.values?.['Down'];
              if (up && !down) direction = 'bullish';
              else if (down && !up) direction = 'bearish';
              else if (up && down) {
                // Both present — compare with price
                const ohlcv = await bridge.getOhlcv(1, false);
                const price = ohlcv?.bars?.[ohlcv.bars.length - 1]?.close;
                if (price) {
                  const upNum = typeof up === 'string' ? parseFloat(up) : up;
                  const downNum = typeof down === 'string' ? parseFloat(down) : down;
                  if (!isNaN(upNum) && price > upNum) direction = 'bullish';
                  else if (!isNaN(downNum) && price < downNum) direction = 'bearish';
                }
              }
            }
          }
        }

        // Fallback: EMA 9/21 cross from OHLCV data (no indicator needed)
        if (direction === 'unknown') {
          const ohlcv = await bridge.getOhlcv(30, false);
          if (ohlcv?.bars) {
            direction = trendFromOHLCV(ohlcv.bars);
            if (direction !== 'unknown') {
              direction += '_ema'; // mark as EMA-based (less reliable than Supertrend)
            }
          }
        }

        state[label] = {
          type: 'supertrend',
          direction: direction.replace('_ema', ''), // clean label
          method: direction.includes('_ema') ? 'EMA 9/21' : 'Supertrend',
          rule: config.rule,
        };
      }
    } catch (e) {
      state[label] = { type: config.type, error: e.message };
    }
  }

  cachedMacroState = state;
  cacheTimestamp = Date.now();

  return state;
}

/**
 * Apply macro filters to a signal based on asset class.
 */
export function applyMacroFilter(macroState, symbol, direction) {
  const result = {
    warnings: [],
    downgrade: false,
  };

  if (!macroState) return result;

  // Kategori tespiti — crypto token'lari onceden kontrol edilerek forex false-positive onlenir
  const s = symbol.toUpperCase();
  const bare = s.includes(':') ? s.split(':')[1] : s;
  const CRYPTO_TOKENS = ['BTC', 'ETH', 'XRP', 'SOL', 'SUI', 'LINK', 'HYPE', 'DOGE', 'ADA', 'AVAX', 'DOT'];
  const isCrypto = CRYPTO_TOKENS.some(t => bare.includes(t)) || bare.endsWith('USDT') || bare.endsWith('USDC');
  const isGold = bare.includes('XAU') || bare.includes('GOLD');
  const isForex = !isCrypto && !isGold && ['EURUSD', 'EURCHF', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCHF', 'USDCAD', 'NZDUSD', 'GBPJPY', 'EURJPY'].some(f => bare.includes(f));
  // Emtia genis liste — gold disindaki ham madde sembolleri. Eski kod
  // sadece COPPER'i disliyordu, WTI/BRENT/XAG vb. VIX filtresine takiliyordu.
  const COMMODITY_TOKENS = ['COPPER', 'WTI', 'BRENT', 'CL1', 'CL2', 'NG1', 'HG1', 'XAG', 'XPT', 'XPD', 'SILVER', 'PLATIN', 'OIL', 'NATGAS', 'COCOA', 'COFFEE', 'SUGAR', 'WHEAT', 'CORN'];
  const isCommodity = !isCrypto && !isForex && !isGold && COMMODITY_TOKENS.some(t => bare.includes(t));
  const isStock = !isCrypto && !isForex && !isGold && !isCommodity;

  if (isCrypto) {
    // USDT.D rising = risk-off for crypto
    if (macroState['USDT.D']?.direction === 'bullish' && direction === 'long') {
      result.warnings.push('USDT.D yesil (yukseliyor) — kripto long sinyali 1 kademe dusuruldu');
      result.downgrade = true;
    }
    // BTC.D rising = altcoins underperform
    if (macroState['BTC.D']?.direction === 'bullish' && !symbol.includes('BTC')) {
      result.warnings.push('BTC.D yesil — altcoin long dikkat, BTC daha guclu');
    }
  }

  if (isForex || isGold) {
    // DXY strong = pressure on EUR/GBP long and gold long
    if (macroState['DXY']?.direction === 'bullish') {
      if (isForex && direction === 'long') {
        result.warnings.push('DXY guclu — major forex long sinyal zayifliyor');
        result.downgrade = true;
      }
      if (isGold && direction === 'long') {
        result.warnings.push('DXY guclu — altin long dikkat');
      }
    }
    // DXY weak + US10Y weak = gold strong
    if (macroState['DXY']?.direction === 'bearish' && macroState['US10Y']?.direction === 'bearish' && isGold) {
      result.warnings.push('DXY + US10Y kirmizi — altin long COK GUCLU');
    }
  }

  if (isStock) {
    // VIX check
    const vix = macroState['VIX'];
    if (vix && vix.type === 'price' && vix.value != null) {
      if (vix.value > 35) {
        // VIX > 35 panik — sadece long'lari downgrade et, short'lar gecerli
        if (direction === 'long') {
          result.warnings.push(`VIX ${vix.value} > 35 — PANIK, long sinyalleri iptal, sadece hedge`);
          result.downgrade = true;
        } else {
          result.warnings.push(`VIX ${vix.value} > 35 — yuksek volatilite, short gecerli ama SL genislet`);
        }
      } else if (vix.value > 25 && direction === 'long') {
        result.warnings.push(`VIX ${vix.value} > 25 — ABD hisse long dikkat`);
      }
    } else if (vix && vix.value == null) {
      result.warnings.push('VIX verisi alinamadi — risk degerlendirmesi eksik');
    }
  }

  return result;
}

/**
 * Format macro state as readable summary.
 */
export function formatMacroSummary(macroState) {
  if (!macroState) return 'Makro veri yok';

  const lines = ['=== MAKRO DURUM ==='];
  for (const [symbol, data] of Object.entries(macroState)) {
    if (data.error) {
      lines.push(`${symbol}: HATA (${data.error})`);
    } else if (data.type === 'price') {
      lines.push(`${symbol}: ${data.value?.toFixed(2) ?? '?'} (${data.level})`);
    } else {
      const arrow = data.direction === 'bullish' ? '🟢 Yukari' :
                    data.direction === 'bearish' ? '🔴 Asagi' : '⚪ Belirsiz';
      const method = data.method && data.method !== 'Supertrend' ? ` [${data.method}]` : '';
      lines.push(`${symbol}: ${arrow}${method}`);
    }
  }
  return lines.join('\n');
}
