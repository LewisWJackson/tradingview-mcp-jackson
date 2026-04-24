/**
 * Regime Detector — macro ve volatilite durumundan tek bir rejim etiketi
 * ureterek rejim-spesifik agirlik setlerini secer.
 *
 * Rejimler:
 *   - risk_on: USDT.D + BTC.D dustu + VIX < 20 → boga uyumlu
 *   - risk_off: USDT.D yukseliyor veya VIX > 25 → savunma
 *   - high_vol: VIX > 30 veya ADX-avg > 40 → yuksek volatilite
 *   - range: ADX-avg < 20 → sikisma/range
 *   - neutral: diger durumlar
 *
 * Kullanim: sinyal uretiminde `getCurrentRegime()` ile okunur; weights icinde
 * `byRegime[currentRegime]` varsa default yerine o set uygulanir.
 */

import { getMacroState } from '../macro-filter.js';

let cached = { regime: 'neutral', at: 0, signals: {} };
const CACHE_TTL = 60_000; // 1 dakika

export function classifyRegime(macroState, adxSample) {
  const signals = {};
  const usdtD = macroState?.['USDT.D']?.direction; // 'bullish' | 'bearish'
  const btcD = macroState?.['BTC.D']?.direction;
  const vix = Number(macroState?.['VIX']?.value);
  const dxy = macroState?.['DXY']?.direction;

  signals.usdtD = usdtD;
  signals.btcD = btcD;
  signals.vix = Number.isFinite(vix) ? vix : null;
  signals.dxy = dxy;
  signals.adxAvg = adxSample != null ? adxSample : null;

  // Oncelik: high_vol > risk_off > range > risk_on > neutral
  if ((Number.isFinite(vix) && vix > 30) || (adxSample != null && adxSample > 40)) {
    return { regime: 'high_vol', signals };
  }
  if (usdtD === 'bullish' || (Number.isFinite(vix) && vix > 25)) {
    return { regime: 'risk_off', signals };
  }
  if (adxSample != null && adxSample < 20) {
    return { regime: 'range', signals };
  }
  if (usdtD === 'bearish' && btcD === 'bearish' && (!Number.isFinite(vix) || vix < 20)) {
    return { regime: 'risk_on', signals };
  }
  return { regime: 'neutral', signals };
}

/**
 * Cached lookup — sinyal uretiminde sik cagrilir, macro state agir operasyon.
 */
export async function getCurrentRegime(adxSample = null) {
  const now = Date.now();
  if (now - cached.at < CACHE_TTL && cached.regime) {
    return cached;
  }
  try {
    const macroState = await getMacroState(false, false);
    const result = classifyRegime(macroState || {}, adxSample);
    cached = { ...result, at: now };
    return cached;
  } catch {
    return cached; // stale returns OK during transient errors
  }
}

/**
 * Verilen weights objesinden rejim-specifik indicatorWeights/slMultiplier
 * setini cozumle. byRegime yoksa default donulur.
 */
export function pickRegimeWeights(weights, regime) {
  if (!weights?.byRegime || !regime || !weights.byRegime[regime]) {
    return {
      indicatorWeights: weights?.indicatorWeights || {},
      slMultiplierOverrides: weights?.slMultiplierOverrides || {},
      regime: 'default',
    };
  }
  const regimeSet = weights.byRegime[regime];
  return {
    indicatorWeights: { ...(weights.indicatorWeights || {}), ...(regimeSet.indicatorWeights || {}) },
    slMultiplierOverrides: { ...(weights.slMultiplierOverrides || {}), ...(regimeSet.slMultiplierOverrides || {}) },
    regime,
  };
}
