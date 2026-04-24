/**
 * Signal Grader — Multi-Factor Voting System.
 *
 * KhanSaab is ONE voice among many, not a gatekeeper.
 * Every indicator votes independently with a weighted score.
 * Direction is determined by majority vote, grade by total conviction.
 */

import { getVolatilityRegime, computeEffectiveSLMultiplier, getCategorySLBoost, findStructuralSL } from './calculators.js';
import { loadWeights } from './learning/weight-adjuster.js';
import { isDegradedMode } from './learning/anomaly-detector.js';
import { pickRegimeWeights } from './learning/regime-detector.js';
import { resolveLeague } from './learning/ladder-engine.js';
import { checkBlackout } from './blackout.js';
import { checkSessionFilter } from './session-filter.js';
import { applyAlignmentFilters } from './alignment-filters.js';
import { detectVolumeReaction } from './volume-reaction-detector.js';
import { detectPumpTop, pumpPullbackLevel } from './pump-guard.js';
import { loadFibCache } from './fib-engine.js';
import {
  resolveCategory,
  getVolTier,
  getThresholdMultiplier,
  getCategoryWeightMultiplier,
  updateSymbolMeta,
  computeAtrPct,
} from './learning/category-tier.js';

// --- TP mesafe politikasi -----------------------------------------------------
// Backtest (scanner/scripts/simulate-tp1.js, 2026-04) ile dogrulandi:
//   TP1=1.0R ile hit rate +%33, sl_hit rescue orani 3.6% -> 12.0%.
// Dusuk volatilite (ATR 20-bar ort. %70 alti): TP3 = null (2-TP modu),
// sinyal TP1/TP2 ile kapanir. Yuksek vol (%140 ustu): TP'ler hafif genisler.
// Kaliteye gore TP2/TP3 R katsayilari. TP1 her kalitede 1.0R — pozisyonu hizla
// BE'ye almak icin sabit. TP2/TP3 sinyal kalitesine gore cok siki -> orta ->
// agresif ayarlanir; runner yuksek kalitede daha fazla nefes alir.
// Executor tarafi ayrica aciklanan pozisyonda yeni same/reverse sinyallere gore
// TP2/TP3 tier'ini dinamik kaydirir (okx-executor/src/executor/tp-tier.ts).
const TP_R_BY_QUALITY = {
  // 2026-04-22: A icin TP1 1.5R — A sinyalin tarihsel SL hit oranini dusurmek
  // icin BE'ye daha gec ama daha guvenli geciyoruz; trailing TP1 sonrasi aktif.
  A: { tp1: 1.5, tp2: 2.8, tp3: 4.5 },
  B: { tp1: 1.0, tp2: 2.2, tp3: 3.5 }, // orta — varsayilan
  C: { tp1: 1.0, tp2: 1.6, tp3: 2.4 }, // cok siki — erken realize
};
const TP_R_MAX = 4.5; // tier shift'te TP3 ust siniri
const SQUEEZE_RATIO_TWO_TP = 0.70;
const SQUEEZE_RATIO_HIGHVOL = 1.40;

/**
 * EMA9/EMA21 ayirma yuzdesi son kapali bar bazinda. Dusuk ayirma = cross taze/zayif,
 * yuksek ayirma = cross oturmus. chop'tan ayirmak icin kullanilir.
 */
function computeEmaSeparation(bars) {
  if (!Array.isArray(bars) || bars.length < 22) return null;
  const calcEma = (period) => {
    const k = 2 / (period + 1);
    let ema = bars[0].close;
    for (let i = 1; i < bars.length; i++) ema = bars[i].close * k + ema * (1 - k);
    return ema;
  };
  const ema9 = calcEma(9);
  const ema21 = calcEma(21);
  const price = bars[bars.length - 1].close;
  if (!price) return null;
  return Math.abs(ema9 - ema21) / price;
}

/**
 * Premium/Discount: son 50 barin high/low aralikta fiyat konumu.
 *   > %75 → premium (upper quartile, short bias)
 *   < %25 → discount (lower quartile, long bias)
 *   aksi → equilibrium, vote yok
 */
function computePremiumDiscount(bars, lookback = 50) {
  if (!Array.isArray(bars) || bars.length < lookback) return null;
  const slice = bars.slice(-lookback);
  let hi = -Infinity, lo = Infinity;
  for (const b of slice) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  const range = hi - lo;
  if (range <= 0) return null;
  const last = slice[slice.length - 1].close;
  const pct = (last - lo) / range;
  if (pct > 0.75) return { zone: 'premium', direction: 'short', pct, hi, lo };
  if (pct < 0.25) return { zone: 'discount', direction: 'long', pct, hi, lo };
  return null;
}

/**
 * Likidite sweep-and-reclaim: son bar onceki swing high/low'u kirmis ama icinde
 * kapanmis — stop hunt + reclaim. SMC'nin en guvenilir reversal setup'i.
 *   - bearish sweep: son bar.high > prev_swing_high VE close < prev_swing_high
 *   - bullish sweep: son bar.low  < prev_swing_low  VE close > prev_swing_low
 */
function detectLiquiditySweep(bars, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback + 2) return null;
  const last = bars[bars.length - 1];
  const prev = bars.slice(-(lookback + 1), -1); // son barin oncesi
  let prevHi = -Infinity, prevLo = Infinity;
  for (const b of prev) { if (b.high > prevHi) prevHi = b.high; if (b.low < prevLo) prevLo = b.low; }
  // Bearish sweep: sweep upward, close back below
  if (last.high > prevHi && last.close < prevHi) {
    return { direction: 'short', level: prevHi, sweepBy: last.high - prevHi, close: last.close };
  }
  if (last.low < prevLo && last.close > prevLo) {
    return { direction: 'long', level: prevLo, sweepBy: prevLo - last.low, close: last.close };
  }
  return null;
}

function computeSqueezeRatio(bars, period = 14, lookback = 20) {
  if (!bars || bars.length < period + lookback) return null;
  const samples = [];
  for (let i = lookback; i >= 1; i--) {
    const end = bars.length - (i - 1);
    const slice = bars.slice(end - (period + 1), end);
    if (slice.length < period + 1) continue;
    let sum = 0;
    for (let j = 1; j < slice.length; j++) {
      const tr = Math.max(
        slice[j].high - slice[j].low,
        Math.abs(slice[j].high - slice[j - 1].close),
        Math.abs(slice[j].low - slice[j - 1].close)
      );
      sum += tr;
    }
    samples.push(sum / period);
  }
  if (samples.length === 0) return null;
  const current = samples[samples.length - 1];
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  return { current, avg, ratio: avg > 0 ? current / avg : 1 };
}

function resolveTpPolicy(squeezeRatio, grade) {
  const g = (grade === 'A' || grade === 'B' || grade === 'C') ? grade : 'B';
  const base = TP_R_BY_QUALITY[g];
  // Yuksek volatilite ek +0.3R genislet (TP1 sabit kalir, TP3 cap'li).
  const wide = (tpR) => ({
    tp1: tpR.tp1,
    tp2: Math.min(tpR.tp2 + 0.3, TP_R_MAX),
    tp3: Math.min(tpR.tp3 + 0.3, TP_R_MAX),
  });
  if (squeezeRatio == null) return { tpR: base, tpCount: 3, regime: 'unknown', grade: g };
  if (squeezeRatio < SQUEEZE_RATIO_TWO_TP) return { tpR: base, tpCount: 2, regime: 'low_vol', grade: g };
  if (squeezeRatio > SQUEEZE_RATIO_HIGHVOL) return { tpR: wide(base), tpCount: 3, regime: 'high_vol', grade: g };
  return { tpR: base, tpCount: 3, regime: 'normal', grade: g };
}

function applyTpLevels(result, entryPrice, finalSL, direction, tpR, tpCount) {
  const sign = direction === 'long' ? 1 : -1;
  result.sl = entryPrice - sign * finalSL;
  result.tp1 = entryPrice + sign * finalSL * tpR.tp1;
  result.tp2 = entryPrice + sign * finalSL * tpR.tp2;
  result.tp3 = tpCount === 3 ? entryPrice + sign * finalSL * tpR.tp3 : null;
}

function getWeights(regime = null) {
  let base;
  try {
    base = loadWeights();
  } catch {
    base = {
      gradeThresholds: { A_min: 7, B_min: 5, C_min: 3, minRR: 2.0 },
      indicatorWeights: {},
      timeframeReliability: {},
      symbolAdjustments: {},
      slMultiplierOverrides: {},
    };
  }
  if (regime) {
    const picked = pickRegimeWeights(base, regime);
    return { ...base, indicatorWeights: picked.indicatorWeights, slMultiplierOverrides: picked.slMultiplierOverrides, activeRegime: picked.regime };
  }
  return { ...base, activeRegime: 'default' };
}

// Default vote weights — BACKTEST-OPTIMIZED (2026-04-08)
// Based on 12-strategy comparison across BTC/ETH/AAPL on 1H/4H
// Top performers: EMA Cross + RSI + Volume (PF 5.17), EMA Cross (PF 4.27)
// Bottom performers: RSI Mean Reversion, BB+RSI, Supertrend alone
const DEFAULT_VOTE_WEIGHTS = {
  ema_cross: 1.8,      // EMA 9/21 cross — guclu ama dominant olmamali (korelasyon decay ile birlikte)
  khanSaab: 1.5,       // KhanSaab is EMA-based internally, useful but not dominant
  smc_choch: 2.0,      // CHoCH = structural reversal — strong for entries
  smc_bos: 1.5,        // BOS = structure continuation — good confirmation
  smc_ob: 1.0,         // Order blocks — support/resistance zones
  smc_fvg: 0.5,        // FVG — less reliable as standalone
  formation: 0.0,      // DISABLED 2026-04-18: canli 57 outcome'da lift -17.46%, en zararli indikator
                       // (WR %11.11). Raporlarda "informational" kalsin, skora katkisi sifir.
  rsi_divergence: 1.0, // Divergence — downgraded, needs strict detection (2 swings minimum)
  rsi_level: 0.5,      // Oversold/overbought — WEAK alone, only as filter (backtest: RSI mean reversion PF 0.98)
  macd: 1.5,           // MACD + trend filter — strong (PF 1.90 in backtest)
  cdv: 0.8,            // Volume direction — moderate
  volume_confirm: 1.2, // Volume spike confirmation — crucial for EMA cross validation
  adx_trend: 1.5,      // ADX > 20 = MANDATORY trend filter (EMA+ADX: PF 2.16-2.21)
  macro_filter: 0.5,   // Macro — penalty only
  squeeze_filter: 1.0, // Squeeze — penalty only (negative weight)
  stoch_rsi: 1.2,     // StochRSI crossover/divergence — RSI level'dan guclu, EMA cross'tan zayif
  volume_reaction: 2.2, // Hacimli bar uclarinda kontra tepki setup (5-teyit >=3) — counter-trend, yuksek gudum
  liquidity_sweep: 1.8, // Swing high/low sweep-and-reclaim — SMC'nin en guvenilir reversal setup'i
  premium_discount: 1.0, // Fiyat aralik icinde premium/discount konumu — mean-reversion bias
};

// KhanSaab-turevli oylar (hepsi KhanSaab dashboard'undan + ayni trend'den turer):
// ayni yonde uzlastiklarinda conviction sisirmesini engellemek icin diminishing
// return uygulanir — 1. oy tam, 2. %60, 3. %40, 4.+ %25 agirlikla sayilir.
const KHANSAAB_CORRELATED_GROUP = new Set(['khanSaab', 'ema_cross', 'macd', 'vwap_position']);
const KHANSAAB_DECAY = [1.0, 0.6, 0.4, 0.25];

// Export for learning-reporter: raporlarda baz agirlik + learned + efektif gostermek icin
export { DEFAULT_VOTE_WEIGHTS };

/**
 * Collect votes from all available indicators.
 * Each vote: { source, direction: 'long'|'short'|null, weight, reasoning }
 */
function collectVotes({ khanSaab, smc, studyValues, ohlcv, formation, squeeze, divergence, cdv, macroFilter, stochRSI, regime, symbol }) {
  const votes = [];
  const w = getWeights(regime);
  const iw = w.indicatorWeights || {};

  // Kategori-bazli carpan: weights.voteWeightsByCategory[cat][key] varsa global
  // learned weight'in UZERINE carpilir. Tablo yoksa 1.0 (no-op) — mevcut global
  // learning bozulmadan "kripto'da macd daha onemli, forex'te daha az" gibi
  // kategori-spesifik ayarlarin hook'u kurulur. Weight-adjuster bir sonraki
  // iterasyonda bu tabloyu per-category sample gruplamasi ile doldurur.
  function voteWeight(key) {
    const learned = iw[key] != null ? iw[key] : 1.0;
    const base = DEFAULT_VOTE_WEIGHTS[key] || 1.0;
    const catMult = getCategoryWeightMultiplier(w, symbol, key);
    return base * learned * catMult;
  }

  // --- 1. KhanSaab (one vote, not a veto) ---
  if (khanSaab) {
    const ksWeight = voteWeight('khanSaab');
    if (khanSaab.signalStatus === 'BUY' || khanSaab.signalStatus === 'SELL') {
      const dir = khanSaab.signalStatus === 'BUY' ? 'long' : 'short';
      const score = dir === 'long' ? khanSaab.bullScore : khanSaab.bearScore;
      const scoreMult = score != null ? Math.min(score / 71, 1.0) : 0.7;
      if (ksWeight > 0) {
        votes.push({
          source: 'khanSaab',
          direction: dir,
          weight: ksWeight * scoreMult,
          reasoning: `KhanSaab ${khanSaab.signalStatus} (skor: ${score}%, bias: ${khanSaab.bias})`,
        });
      }
    } else {
      // WAIT — still vote based on bias direction with reduced weight
      if (khanSaab.bias && ksWeight > 0) {
        const biasLower = khanSaab.bias.toLowerCase();
        if (biasLower.includes('bull')) {
          const biasStrength = biasLower.includes('strong') ? 0.6 : 0.3;
          votes.push({
            source: 'khanSaab',
            direction: 'long',
            weight: ksWeight * biasStrength,
            reasoning: `KhanSaab WAIT ama bias: ${khanSaab.bias} (Bull: ${khanSaab.bullScore}%)`,
          });
        } else if (biasLower.includes('bear')) {
          const biasStrength = biasLower.includes('strong') ? 0.6 : 0.3;
          votes.push({
            source: 'khanSaab',
            direction: 'short',
            weight: ksWeight * biasStrength,
            reasoning: `KhanSaab WAIT ama bias: ${khanSaab.bias} (Bear: ${khanSaab.bearScore}%)`,
          });
        }
      }
    }

    // RSI level vote — ADX>30 trendli ortamda RSI 70/30 sik sahte sinyal uretir
    // (RSI guclu trendde 20 bar asiri alim/satimda kalabilir). Trend gucu yuksekse
    // mean-reversion oyu atlanir.
    if (khanSaab.rsi != null) {
      const adxForRsiGate = khanSaab.adx != null ? Number(khanSaab.adx) : null;
      const strongTrend = adxForRsiGate != null && adxForRsiGate > 30;
      if (!strongTrend) {
        if (khanSaab.rsi < 30) {
          votes.push({ source: 'rsi_level', direction: 'long', weight: voteWeight('rsi_level'), reasoning: `RSI ${khanSaab.rsi} asiri satim — long potansiyeli` });
        } else if (khanSaab.rsi > 70) {
          votes.push({ source: 'rsi_level', direction: 'short', weight: voteWeight('rsi_level'), reasoning: `RSI ${khanSaab.rsi} asiri alim — short potansiyeli` });
        }
      }
    }

    // MACD vote
    if (khanSaab.macd) {
      const macdDir = khanSaab.macd === 'BULL' ? 'long' : khanSaab.macd === 'BEAR' ? 'short' : null;
      if (macdDir) {
        votes.push({ source: 'macd', direction: macdDir, weight: voteWeight('macd'), reasoning: `MACD Trend: ${khanSaab.macd}` });
      }
    }

    // EMA cross vote — separation kontrolu: ohlcv son barlardan EMA9/EMA21
    // hesapla, ayirma < %0.2 ise "zayif cross" (chop'ta flipleme riski) — 0.5x carpan
    if (khanSaab.emaStatus) {
      const emaDir = khanSaab.emaStatus === 'BULL' ? 'long' : khanSaab.emaStatus === 'BEAR' ? 'short' : null;
      if (emaDir) {
        const volBonus = khanSaab.volume === 'HIGH' ? 1.3 : 1.0;
        const sep = computeEmaSeparation(ohlcv?.bars);
        const sepMult = sep != null && sep < 0.002 ? 0.5 : 1.0;
        const sepTag = sepMult < 1 ? ` (ZAYIF cross: sep ${(sep*100).toFixed(3)}%)` : '';
        votes.push({ source: 'ema_cross', direction: emaDir, weight: voteWeight('ema_cross') * volBonus * sepMult, reasoning: `EMA Cross: ${khanSaab.emaStatus}${volBonus > 1 ? ' + HIGH VOLUME' : ''}${sepTag}` });
      }
    }

    // VWAP position — key S&R for liquid instruments (KhanSaab: "VWAP acts as magnet and S&R")
    if (khanSaab.vwap) {
      if (khanSaab.vwap === 'ABOVE') {
        votes.push({ source: 'vwap_position', direction: 'long', weight: 0.8, reasoning: `Fiyat VWAP uzerinde — long destekli` });
      } else if (khanSaab.vwap === 'BELOW') {
        votes.push({ source: 'vwap_position', direction: 'short', weight: 0.8, reasoning: `Fiyat VWAP altinda — short destekli` });
      }
    }

    // ADX trend strength — CRITICAL filter (backtest: EMA+ADX PF 2.16-2.21)
    if (khanSaab.adx != null) {
      if (khanSaab.adx > 25) {
        // Strong trend — amplify all momentum signals
        votes.push({ source: 'adx_trend', direction: null, weight: voteWeight('adx_trend'), reasoning: `ADX ${khanSaab.adx} — guclu trend, momentum sinyalleri guvenilir` });
      } else if (khanSaab.adx < 20) {
        // No trend — PENALIZE momentum signals (backtest: mean reversion PF < 1.0 in range)
        votes.push({ source: 'adx_trend', direction: null, weight: -voteWeight('adx_trend') * 0.8, reasoning: `ADX ${khanSaab.adx} — trend yok, momentum sinyalleri ZAYIF` });
      }
    }
  }

  // --- 2. Smart Money Concepts (independent votes) ---
  if (smc) {
    if (smc.lastBOS) {
      const bosDir = smc.lastBOS.direction === 'bullish' ? 'long' : 'short';
      votes.push({ source: 'smc_bos', direction: bosDir, weight: voteWeight('smc_bos'), reasoning: `SMC BOS: ${smc.lastBOS.direction}` });
    }

    if (smc.lastCHoCH) {
      const chochDir = smc.lastCHoCH.direction === 'bullish' ? 'long' : 'short';
      votes.push({ source: 'smc_choch', direction: chochDir, weight: voteWeight('smc_choch'), reasoning: `SMC CHoCH: ${smc.lastCHoCH.direction} — yapisal degisim` });
    }

    if (smc.orderBlocks && smc.orderBlocks.length > 0) {
      votes.push({ source: 'smc_ob', direction: null, weight: voteWeight('smc_ob') * 0.5, reasoning: `SMC Order Block mevcut (${smc.orderBlocks.length} adet)` });
    }

    if (smc.fvgZones && smc.fvgZones.length > 0) {
      votes.push({ source: 'smc_fvg', direction: null, weight: voteWeight('smc_fvg') * 0.5, reasoning: `SMC FVG bolgesi mevcut (${smc.fvgZones.length} adet)` });
    }
  }

  // --- 3. Formations (critical — user emphasized this) ---
  if (formation && formation.formations && formation.formations.length > 0) {
    for (const f of formation.formations) {
      if (f.direction === 'bullish' || f.direction === 'bearish') {
        const dir = f.direction === 'bullish' ? 'long' : 'short';
        // Maturity scales the weight: 100% = full, 60% = reduced
        const maturityMult = f.maturity ? Math.min(f.maturity / 100, 1.0) : 0.7;
        // Broken formations (confirmed breakout) get extra weight
        const breakoutMult = f.broken ? 1.5 : 1.0;
        votes.push({
          source: 'formation',
          direction: dir,
          weight: voteWeight('formation') * maturityMult * breakoutMult,
          reasoning: `Formasyon: ${f.name} (${f.direction}, olgunluk: %${f.maturity || '?'}${f.broken ? ', KIRILIM TEYITLI' : ''})`,
        });
      }
    }
  }

  // --- 4. Candlestick patterns ---
  if (formation && formation.candles && formation.candles.length > 0) {
    for (const c of formation.candles) {
      if (c.direction === 'bullish' || c.direction === 'bearish') {
        const dir = c.direction === 'bullish' ? 'long' : 'short';
        votes.push({
          source: 'formation',
          direction: dir,
          weight: 0, // DISABLED 2026-04-18: formation lift -17.46% (canli veri). Bilgi amacli kalir.
          reasoning: `Mum formasyonu: ${c.name} (${c.direction}) [informational, skora katki yok]`,
        });
      }
    }
  }

  // --- 5. RSI Divergence ---
  if (divergence && divergence.type) {
    const divDir = divergence.type === 'bullish' ? 'long' : 'short';
    votes.push({ source: 'rsi_divergence', direction: divDir, weight: voteWeight('rsi_divergence'), reasoning: `RSI Divergence: ${divergence.type}` });
  }

  // --- 5b. StochRSI (%K/%D crossover + divergence) ---
  if (stochRSI && stochRSI.signal) {
    const dir = stochRSI.signal === 'BUY' ? 'long' : 'short';
    let w = voteWeight('stoch_rsi');
    // Divergence bonus: +0.5 ek agirlik
    if (stochRSI.divergence) {
      const divMatch = (stochRSI.divergence === 'bullish' && dir === 'long') ||
                        (stochRSI.divergence === 'bearish' && dir === 'short');
      if (divMatch) w += 0.5;
    }
    // Hacim teyidi: KhanSaab Vol Status = HIGH ise 1.3x carpan
    if (stochRSI.volumeHigh) w *= 1.3;
    const reasonParts = stochRSI.reasoning || [];
    votes.push({
      source: 'stoch_rsi',
      direction: dir,
      weight: w,
      reasoning: `StochRSI ${stochRSI.signal} (%K=${stochRSI.k} %D=${stochRSI.d})${reasonParts.length ? ' — ' + reasonParts.join('; ') : ''}`,
    });
  } else if (stochRSI && stochRSI.reasoning && stochRSI.reasoning.length > 0) {
    // Sinyal yok ama reasoning var (trend filtresi iptal etti vs.)
    // Oy verme ama reasoning'i kaydet
    for (const r of stochRSI.reasoning) {
      votes.push({ source: 'stoch_rsi', direction: null, weight: 0, reasoning: r });
    }
  }

  // --- 6. CDV (volume direction) ---
  if (cdv && cdv.direction) {
    if (cdv.direction === 'BUY' || cdv.direction === 'STRONG_BUY') {
      votes.push({ source: 'cdv', direction: 'long', weight: voteWeight('cdv'), reasoning: `CDV: ${cdv.direction} (alis baskisi %${cdv.buyRatio || '?'})` });
    } else if (cdv.direction === 'SELL' || cdv.direction === 'STRONG_SELL') {
      votes.push({ source: 'cdv', direction: 'short', weight: voteWeight('cdv'), reasoning: `CDV: ${cdv.direction} (satis baskisi)` });
    }
  }

  // --- 7. Squeeze (penalty only) ---
  if (squeeze && squeeze.status === 'squeeze') {
    // Squeeze reduces ALL directional votes
    votes.push({ source: 'squeeze_filter', direction: null, weight: -voteWeight('squeeze_filter'), reasoning: `Squeeze aktif — volatilite dusuk, sinyal guvenilirligi azaldi` });
  }

  // --- 8. Macro filter ---
  if (macroFilter && macroFilter.downgrade) {
    votes.push({ source: 'macro_filter', direction: null, weight: -voteWeight('macro_filter'), reasoning: `Makro filtre uyarisi — sinyal gucunu azaltti` });
  }

  // --- 9. Support/Resistance Awareness ---
  // Don't short at support, don't long at resistance. Penalize signals that enter
  // at the tip of high-volume candles (retail trap).
  const srPenalty = evaluateSRPosition({ smc, ohlcv, khanSaab });
  if (srPenalty) {
    votes.push(srPenalty);
  }

  // --- 10. High-Volume Candle Tip Filter ---
  // Don't enter long at top of a big green candle, don't enter short at bottom of big red candle.
  const hvPenalty = evaluateHighVolumeCandleTrap(ohlcv);
  if (hvPenalty) {
    votes.push(hvPenalty);
  }

  // --- 11. Liquidity Sweep (SMC reclaim) ---
  const sweep = detectLiquiditySweep(ohlcv?.bars);
  if (sweep) {
    votes.push({
      source: 'liquidity_sweep',
      direction: sweep.direction,
      weight: voteWeight('liquidity_sweep'),
      reasoning: `Likidite sweep: son bar ${sweep.direction === 'short' ? `${sweep.level.toFixed(4)} ust swing'i kirdi, altinda kapandi` : `${sweep.level.toFixed(4)} alt swing'i kirdi, ustunde kapandi`} — stop hunt + reclaim`,
    });
  }

  // --- 12. Premium / Discount (range location bias) ---
  const pd = computePremiumDiscount(ohlcv?.bars);
  if (pd) {
    votes.push({
      source: 'premium_discount',
      direction: pd.direction,
      weight: voteWeight('premium_discount'),
      reasoning: `${pd.zone === 'premium' ? 'Premium' : 'Discount'} bolgesi (%${(pd.pct*100).toFixed(0)} konumu) — ${pd.direction} bias`,
    });
  }

  // --- Korelasyon decay: KhanSaab-turevli ayni-yonde oylari azalt ---
  // khanSaab, ema_cross, macd, vwap_position hepsi ayni trend kaynagindan turer;
  // uzlastiklarinda cift-sayim olur. Ayni yonde sayilan N. oy [1.0, 0.6, 0.4, 0.25]
  // ile carpanlanir. Gucluden zayifa siralanir.
  const groupLong = votes.filter(v => KHANSAAB_CORRELATED_GROUP.has(v.source) && v.direction === 'long');
  const groupShort = votes.filter(v => KHANSAAB_CORRELATED_GROUP.has(v.source) && v.direction === 'short');
  const applyDecay = (group) => {
    group.sort((a, b) => b.weight - a.weight);
    group.forEach((v, i) => {
      const mult = KHANSAAB_DECAY[Math.min(i, KHANSAAB_DECAY.length - 1)];
      if (mult < 1) {
        v.weight = v.weight * mult;
        v.reasoning += ` [korelasyon decay ×${mult}]`;
      }
    });
  };
  applyDecay(groupLong);
  applyDecay(groupShort);

  return votes;
}

/**
 * Evaluate if price is at a key S/R level that conflicts with signal direction.
 * Uses SMC order blocks, EQH/EQL, and Strong/Weak levels.
 * - Price at bullish OB (support) → penalize short signals
 * - Price at bearish OB (resistance) → penalize long signals
 */
function evaluateSRPosition({ smc, ohlcv, khanSaab }) {
  if (!smc || !ohlcv?.bars?.length) return null;

  const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
  const price = lastBar.close;
  const atr = calculateATR(ohlcv.bars, 14);
  if (!atr || atr <= 0) return null;

  // Check Order Blocks — critical S/R zones
  if (smc.orderBlocks && smc.orderBlocks.length > 0) {
    for (const ob of smc.orderBlocks) {
      const obHigh = ob.high || ob.top || ob.resistance;
      const obLow = ob.low || ob.bottom || ob.support;
      if (!obHigh || !obLow) continue;

      const obMid = (obHigh + obLow) / 2;
      const distFromOB = Math.abs(price - obMid) / atr;

      // Price is within or very near the OB (within 0.5 ATR)
      if (distFromOB < 0.5) {
        const obType = ob.type || ob.direction || '';
        const isBullishOB = obType.toLowerCase().includes('bull') || obType.toLowerCase().includes('up');
        const isBearishOB = obType.toLowerCase().includes('bear') || obType.toLowerCase().includes('down');

        // Bullish OB gercek destek sayilmasi icin fiyat OB'nin ICINDE olmali
        // (obLow <= price <= obHigh). Sadece `price <= obHigh` degil, aksi halde
        // destegin altinda kirilmis OB de "destek" sayilir.
        if (isBullishOB && price >= obLow && price <= obHigh) {
          return {
            source: 'sr_awareness',
            direction: 'long', // Support favors long, not short
            weight: 1.5,
            reasoning: `DESTEK: Fiyat bullish OB icinde (${obLow.toFixed(2)}-${obHigh.toFixed(2)}) — SHORT RISKLI, destekte short acilmaz`,
          };
        }
        if (isBearishOB && price >= obLow && price <= obHigh) {
          return {
            source: 'sr_awareness',
            direction: 'short', // Resistance favors short, not long
            weight: 1.5,
            reasoning: `DIRENC: Fiyat bearish OB icinde (${obLow.toFixed(2)}-${obHigh.toFixed(2)}) — LONG RISKLI, direncte long acilmaz`,
          };
        }
      }
    }
  }

  // Check VWAP as S/R magnet — if price is very close to VWAP, be cautious
  if (khanSaab?.vwapPrice) {
    const distFromVWAP = Math.abs(price - khanSaab.vwapPrice) / atr;
    if (distFromVWAP < 0.3) {
      return {
        source: 'sr_awareness',
        direction: null,
        weight: -0.5,
        reasoning: `Fiyat VWAP'a cok yakin (${distFromVWAP.toFixed(2)} ATR) — VWAP magnet etkisi, net yon zor`,
      };
    }
  }

  return null;
}

/**
 * Detect if we're at the tip of a high-volume candle — classic retail trap.
 * The signal should have been given BEFORE the big move, not after.
 * - Big green candle with high volume → don't go long at the top
 * - Big red candle with high volume → don't go short at the bottom
 */
function evaluateHighVolumeCandleTrap(ohlcv) {
  if (!ohlcv?.bars || ohlcv.bars.length < 21) return null;

  const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
  const recentBars = ohlcv.bars.slice(-21, -1);

  // Calculate average volume and average body size
  const avgVol = recentBars.reduce((s, b) => s + (b.volume || 0), 0) / recentBars.length;
  const avgBody = recentBars.reduce((s, b) => s + Math.abs(b.close - b.open), 0) / recentBars.length;

  if (!avgVol || avgVol <= 0 || !avgBody || avgBody <= 0) return null;

  const lastBody = Math.abs(lastBar.close - lastBar.open);
  const lastVol = lastBar.volume || 0;
  const isBullish = lastBar.close > lastBar.open;

  // High volume = 1.5x average, Big body = 2x average body
  const isHighVolume = lastVol > avgVol * 1.5;
  const isBigBody = lastBody > avgBody * 2;

  if (isHighVolume && isBigBody) {
    if (isBullish) {
      // Big green candle — NEVER go LONG at the top (hard block)
      return {
        source: 'candle_trap_filter',
        direction: 'short',
        weight: 1.0,
        hardBlock: 'long', // SERT BLOK: bu yonde sinyal verilmez
        reasoning: `SERT BLOK: Hacimli buyuk yesil mum — ustten long KESINLIKLE onerilmez (hacim: ${(lastVol/avgVol).toFixed(1)}x ort, govde: ${(lastBody/avgBody).toFixed(1)}x ort)`,
      };
    } else {
      // Big red candle — NEVER go SHORT at the bottom (hard block)
      return {
        source: 'candle_trap_filter',
        direction: 'long',
        weight: 1.0,
        hardBlock: 'short', // SERT BLOK: bu yonde sinyal verilmez
        reasoning: `SERT BLOK: Hacimli buyuk kirmizi mum — alttan short KESINLIKLE onerilmez (hacim: ${(lastVol/avgVol).toFixed(1)}x ort, govde: ${(lastBody/avgBody).toFixed(1)}x ort)`,
      };
    }
  }

  return null;
}

/**
 * Volume veto filter — context-aware (Option C, 2026-04-19).
 *
 * Onceki davranis: sinyal mumunda hacim 20-bar ortalamasinin %80'inin
 * altindaysa sart siz IPTAL. Bu cok agresifti: trend ortasinda dusuk hacim
 * normaldir (retracement fazinda hacim duser), sadece kirilim barlarinda
 * hacim teyidi kritiktir.
 *
 * Yeni mantik:
 *   - Kirilim bari (formasyon.broken = true, ayni yonde):
 *       ratio < 0.8  → IPTAL (klasik sahte kirilim filtresi)
 *       ratio < 1.2  → warn (teyit zayif, grade degismez)
 *       ratio >= 1.2 → temiz
 *   - Kirilim dısı (trend devami / mean-reversion):
 *       ratio < 0.4  → downgrade (1 kademe dusur)
 *       ratio >= 0.4 → temiz
 *   - Override: ADX >= 30 + en az 3 kaynak + uyum %70+ → IPTAL yerine
 *     downgrade (guclu teyit dusuk hacmin sinyal degerini kismen telafi eder).
 *
 * Donen: null | { action: 'iptal'|'downgrade'|'warn', reasoning, ratio, isBreakoutBar }
 */
function evaluateVolumeVeto(ohlcv, ctx = {}) {
  if (!ohlcv?.bars || ohlcv.bars.length < 21) return null;
  const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
  const prev20 = ohlcv.bars.slice(-21, -1);
  const avgVol = prev20.reduce((s, b) => s + (b.volume || 0), 0) / prev20.length;
  if (!avgVol || avgVol <= 0) return null; // volume verisi yoksa veto etme (ornegin bazi FX feedleri)
  const lastVol = lastBar.volume || 0;
  const ratio = lastVol / avgVol;
  const pct = (ratio * 100).toFixed(0);

  const { formation, tally, adx, direction } = ctx;

  // Kirilim bari tespiti: dominant yonde kirilimi teyit edilmis formasyon var mi?
  const isBreakoutBar = !!(formation?.formations?.some(f => {
    if (!f.broken) return false;
    const fDir = f.direction === 'bullish' ? 'long' : f.direction === 'bearish' ? 'short' : null;
    return fDir && fDir === direction;
  }));

  // Guclu teyit override'i
  const strongConfirm = (adx || 0) >= 30
    && (tally?.voterCount || 0) >= 3
    && (tally?.agreement || 0) >= 70;

  if (isBreakoutBar) {
    if (ratio < 0.8) {
      if (strongConfirm) {
        return {
          action: 'downgrade',
          reasoning: `Kirilim barinda hacim %${pct} (esik %80) — ADX ${(adx || 0).toFixed(0)}, ${tally.voterCount} kaynak, uyum %${tally.agreement} oldugu icin IPTAL yerine 1 kademe dusuruldu`,
          ratio, isBreakoutBar,
        };
      }
      return {
        action: 'iptal',
        reasoning: `Kirilim barinda hacim 20-bar ortalamasinin %${pct}'i (esik %80). Sahte kirilim riski yuksek.`,
        ratio, isBreakoutBar,
      };
    }
    if (ratio < 1.2) {
      return {
        action: 'warn',
        reasoning: `Kirilim barinda hacim %${pct} (ideal >= %120) — teyit zayif, dikkat`,
        ratio, isBreakoutBar,
      };
    }
    return null;
  }

  // Trend ortasi / kirilim disi: sadece cok olu hacimde downgrade
  if (ratio < 0.4) {
    return {
      action: 'downgrade',
      reasoning: `Hacim 20-bar ortalamasinin %${pct}'i — cok dusuk, kalite 1 kademe dusuruldu (kirilim bari degil, IPTAL degil)`,
      ratio, isBreakoutBar,
    };
  }
  return null;
}

/**
 * Tally votes to determine direction and conviction score.
 */
function tallyVotes(votes) {
  let longScore = 0;
  let shortScore = 0;
  let amplifier = 0; // Non-directional boosts
  let penalty = 0;   // Negative weights (squeeze, macro)

  for (const v of votes) {
    if (v.weight < 0) {
      penalty += Math.abs(v.weight);
    } else if (v.direction === 'long') {
      longScore += v.weight;
    } else if (v.direction === 'short') {
      shortScore += v.weight;
    } else {
      amplifier += v.weight;
    }
  }

  // Apply amplifier to the dominant direction.
  // Berabere (longScore === shortScore, 0-0 dahil) → belirsiz, null dön.
  // Aksi halde eşitlik her zaman long'a gidiyor ve yön sinyali yanıltıcı oluyor.
  let dominant = null;
  if (longScore > shortScore) dominant = 'long';
  else if (shortScore > longScore) dominant = 'short';
  const dominantScore = Math.max(longScore, shortScore);
  const minorityScore = Math.min(longScore, shortScore);

  // Net conviction = dominant votes + amplifiers - penalties - opposing votes
  const conviction = dominantScore + amplifier - penalty - minorityScore * 0.5;

  // Agreement ratio: how one-sided is the vote?
  const totalDirectional = longScore + shortScore;
  const agreement = totalDirectional > 0 ? dominantScore / totalDirectional : 0;

  return {
    direction: dominant,
    longScore: Math.round(longScore * 100) / 100,
    shortScore: Math.round(shortScore * 100) / 100,
    amplifier: Math.round(amplifier * 100) / 100,
    penalty: Math.round(penalty * 100) / 100,
    conviction: Math.round(conviction * 100) / 100,
    agreement: Math.round(agreement * 100),
    voterCount: votes.filter(v => v.direction != null).length,
  };
}

/**
 * Grade a short-term signal using multi-factor voting.
 */
export function gradeShortTermSignal({
  khanSaab, smc, studyValues, ohlcv, formation, squeeze, divergence, cdv, stochRSI, macroFilter, symbol, timeframe,
  quotePrice, parsedBoxes, khanSaabLabels, regime, smcSRLines,
}) {
  const result = {
    symbol, timeframe,
    grade: 'IPTAL',
    position_pct: 0,
    direction: null,
    reasoning: [],
    warnings: [],
    entry: null, sl: null, tp1: null, tp2: null, tp3: null, rr: null,
    khanSaabBias: khanSaab?.bias || null,
    khanSaab: khanSaab || null,
    smcStructure: smc || null,
    formationInfo: null,
    volatilityRegime: null,
    votes: null,
    tally: null,
  };

  // --- YATAY + TRANSITION REJIM: KhanSaab bypass ---
  // CLAUDE.md "Volatilite & Trend Rejimi": net trend_up/trend_down DISINDA tum
  // rejimlerde (sideways, transition, ADX<25) KhanSaab skoru ve TUM KhanSaab-
  // turevi oylar (ema_cross, macd, vwap, rsi_level, adx_trend) gurultu uretir —
  // YOKSAY. Sadece SMC yapisi, formasyon, cdv, volume_confirm, divergence,
  // squeeze, stochRSI gibi bagimsiz oylar sayilir.
  const adxForRegime = khanSaab?.adx != null ? Number(khanSaab.adx) : null;
  const sidewaysByAdx = adxForRegime != null && adxForRegime < 25; // <25: transition + sideways kapsar
  const regimeStr = typeof regime === 'string' ? regime : regime?.regime;
  const nonTrendRegime = regimeStr === 'sideways' || regimeStr === 'transition';
  const khanSaabDisabledFlag = sidewaysByAdx || nonTrendRegime;
  let khanSaabForVotes = khanSaab;
  if (khanSaabDisabledFlag) {
    khanSaabForVotes = null;
    result.khanSaabDisabled = true;
    result.khanSaabDisabledReason = sidewaysByAdx
      ? `ADX ${adxForRegime} < 25 (trend zayif/transition) — KhanSaab oylari devre disi`
      : `${regimeStr.toUpperCase()} rejim — KhanSaab oylari devre disi`;
    result.reasoning.push(`TREND-DISI REJIM: ${result.khanSaabDisabledReason}. Sadece SMC + yapisal bounce/reaction setuplari kullanilir.`);
  }

  // Sembol-spesifik ATR% medianini guncelle (vol tier cache'i besler) — fresh
  // olcum her grade'de EWMA ile entegre olur; tier rejim degisince kayar.
  try {
    const atrPct = computeAtrPct(ohlcv?.bars, 14);
    if (atrPct != null) updateSymbolMeta(symbol, atrPct);
  } catch { /* best-effort */ }
  result.category = resolveCategory(symbol);
  result.volTier = getVolTier(symbol);

  // Collect votes from ALL indicators (KhanSaab yoklugunda yatay modda)
  const votes = collectVotes({ khanSaab: khanSaabForVotes, smc, studyValues, ohlcv, formation, squeeze, divergence, cdv, macroFilter, stochRSI, regime, symbol });
  result.regime = regime || null;

  // --- Volume Reaction setup (CLAUDE.md: hacimli bar uclarinda kontra tepki) ---
  // Detektor ORIJINAL khanSaab + ohlcv bars ister; yatay modda bile calisir
  // cunku reaction setup'lari tam da exhaust/range donemlerinde degerlidir.
  let volumeReaction = null;
  try {
    const bars = ohlcv?.bars || [];
    volumeReaction = detectVolumeReaction({
      bars,
      smc,
      // Faz 0 patch (b): FULL BYPASS. KhanSaab devre disiysa reaction detektoru de
      // KhanSaab RSI/vol/bias field'larini gormesin — aksi halde ADX<25 rejimde
      // momentum kaynakli "sahte teyit" olusturabilir.
      khanSaab: khanSaabForVotes,
      stochRSI,
      divergence,
    });
  } catch (err) {
    result.warnings.push(`volume_reaction detector hata: ${err.message}`);
  }
  if (volumeReaction) {
    const baseW = DEFAULT_VOTE_WEIGHTS.volume_reaction || 2.0;
    const learned = getWeights(regime).indicatorWeights?.volume_reaction ?? 1.0;
    const zoneBonus = volumeReaction.smcZoneOk ? 1.2 : 1.0;
    votes.push({
      source: 'volume_reaction',
      direction: volumeReaction.direction,
      weight: baseW * learned * zoneBonus,
      reasoning: volumeReaction.reasoning,
    });
    result.volumeReaction = volumeReaction;
    result.reasoning.push(`Volume Reaction setup: ${volumeReaction.direction.toUpperCase()} (${volumeReaction.count}/5 teyit${volumeReaction.smcZoneOk ? ', SMC zone ✓' : ', SMC zone yok — kalite 1 kademe dusecek'})`);
  }

  // No data at all
  if (votes.length === 0) {
    result.reasoning.push('Hicbir indikatordan veri alinamadi');
    return result;
  }

  // Tally the votes
  const tally = tallyVotes(votes);
  result.direction = tally.direction;
  result.votes = votes;
  result.tally = tally;

  // Add all vote reasonings
  for (const v of votes) {
    result.reasoning.push(v.reasoning);
  }

  // Berabere veya hiç direktif oy yoksa → yön belirsiz, BEKLE.
  // Aksi halde asagidaki SL/TP hesabi null direction ile uydurulmus long
  // uretir (eski davranış: tie → long).
  if (!tally.direction) {
    result.grade = 'BEKLE';
    result.reasoning.push('Yon belirsiz: long/short oy esit veya direktif oy yok');
    return result;
  }

  // Volatility regime
  // Faz 0 patch (b): KhanSaab bypass modunda khanSaab.adx'i kullanma,
  // extractADX(studyValues) uzerinden ADX oku — volRegime dogru tier'a dussun.
  const adxVal = (khanSaabDisabledFlag ? null : khanSaab?.adx) || extractADX(studyValues);
  const volRegime = getVolatilityRegime(adxVal);
  result.volatilityRegime = volRegime;

  // Formations info
  if (formation && formation.formations && formation.formations.length > 0) {
    result.formationInfo = formation.formations[0];
  }

  // --- Hard block: hacimli mum tuzagi kontrolu ---
  // Hacimli yesil mumun ustunden long veya hacimli kirmizi mumun altindan short
  // KESINLIKLE onerilmez — diger indikatörler ne derse desin.
  const hvTrap = votes.find(v => v.hardBlock);
  if (hvTrap && tally.direction === hvTrap.hardBlock) {
    result.grade = 'IPTAL';
    result.direction = tally.direction;
    result.position_pct = 0;
    result.warnings.push(`SERT BLOK: Hacimli mum tuzagi — ${hvTrap.hardBlock} yonunde sinyal iptal edildi`);
    result.reasoning.push(`--- SERT BLOK IPTAL: ${hvTrap.reasoning}`);
    return result;
  }

  // --- Volume Veto DEVRE DISI (2026-04-20) ---
  // Hacim teyidi zaten oylamada `volume_confirm` (1.2) ve `ema_cross` HIGH-vol
  // bonusu (×1.3) ile ciddi agirlikla sayiliyor. Ayri bir veto/downgrade katmani
  // cift sayim olusturuyor ve kaliteyi bastiriyor. Oylama sonucu ne diyorsa o.

  // --- Economic calendar blackout (Hafta 3-12) ---
  // FOMC / NFP / CPI / buyuk merkez bankasi aciklamalarinda volatilite sicrayisi
  // teknik sinyalleri gecersiz kilar. Operatör `data/blackout.json` dosyasına pencere
  // yazar; pencere icinde sinyal BEKLE'ye dusurulur, uygulanmaz.
  const blackout = checkBlackout(symbol);
  if (blackout) {
    result.grade = 'BEKLE';
    result.position_pct = 0;
    result.direction = tally.direction;
    const endsIn = Math.max(0, Math.round((blackout.endsAt - Date.now()) / 60000));
    result.warnings.push(`BLACKOUT: ${blackout.name} (${blackout.scope}) — ${endsIn}dk daha. Sinyal ertelendi.`);
    result.reasoning.push(`--- BLACKOUT BEKLE: ${blackout.name}`);
    return result;
  }

  // --- Session-of-day filter (Hafta 3-14) ---
  // Asya dusuk likidite saatlerinde (22:00 UTC - 06:00 UTC arasi FX/emtia) sinyal
  // kalitesi dusuyor. BIST/ABD hisse icin piyasa kapali iken sinyal uretmiyoruz
  // (market-hours zaten kapatır), ama crypto 7/24 oldugundan session filtresi
  // Asya sessizligini BEKLE olarak isaretler.
  const sessionBlock = checkSessionFilter(symbol);
  if (sessionBlock) {
    result.grade = 'BEKLE';
    result.position_pct = 0;
    result.direction = tally.direction;
    result.warnings.push(`SESSION FILTER: ${sessionBlock.reason}`);
    result.reasoning.push(`--- SESSION BEKLE: ${sessionBlock.reason}`);
    return result;
  }

  // --- Learned weights & thresholds ---
  const w = getWeights(regime);
  const gt = w.gradeThresholds;

  // Per-symbol vol-tier threshold carpani: yuksek-vol sembollerde (ornegin
  // memecoin) ayni conviction puani daha az bilgi tasir — agreement esigi sabit
  // kalir (oy birligi metriksel olarak vol-invariant), sadece conviction alt
  // sinirlari olcektenir. Low-vol sembollerde (BTC, EURUSD, SPX) esigi hafifce
  // gevseterek yanlisiz sinyallerin bosa kaydirilmasini engelleriz.
  const thrMult = getThresholdMultiplier(symbol);
  const A_min = (gt.A_min || 7) * thrMult;
  const A_agr = gt.A_minAgreement || 70;
  const B_min = (gt.B_min || 5) * thrMult;
  const B_agr = gt.B_minAgreement || 60;
  const C_min = (gt.C_min || 3) * thrMult;
  const C_agr = gt.C_minAgreement || 50;
  const BEKLE_min = (gt.BEKLE_min || 1.5) * thrMult;
  if (thrMult !== 1.0) {
    result.reasoning.push(`Vol tier ${getVolTier(symbol)} — threshold carpani ×${thrMult.toFixed(2)} (A_min=${A_min.toFixed(2)}, B_min=${B_min.toFixed(2)}, C_min=${C_min.toFixed(2)})`);
  }

  let grade;
  if (tally.conviction >= A_min && tally.agreement >= A_agr) {
    grade = 'A';
  } else if (tally.conviction >= B_min && tally.agreement >= B_agr) {
    grade = 'B';
  } else if (tally.conviction >= C_min && tally.agreement >= C_agr) {
    grade = 'C';
  } else if (tally.conviction >= BEKLE_min) {
    grade = 'BEKLE';
  } else {
    grade = 'IPTAL';
  }

  // --- MTF Confluence: HTF fib cache'inden 1D/1W trend yonunu oku.
  // Herhangi bir HTF sinyal yonune ters bir trend_up/trend_down veriyorsa 1
  // kademe asagi (≥2 HTF celiski alignment-filters tarafinda zaten iptal).
  try {
    const fibCache = loadFibCache(symbol);
    if (fibCache && fibCache.timeframes && tally.direction) {
      const oppositeTFs = [];
      for (const [tf, data] of Object.entries(fibCache.timeframes)) {
        const reg = data?.trend?.regime;
        if (!reg) continue;
        if (tally.direction === 'long' && reg === 'trend_down') oppositeTFs.push(tf);
        if (tally.direction === 'short' && reg === 'trend_up') oppositeTFs.push(tf);
      }
      if (oppositeTFs.length === 1) {
        const mtfDowngrade = { 'A': 'B', 'B': 'C', 'C': 'BEKLE', 'BEKLE': 'BEKLE', 'IPTAL': 'IPTAL' };
        const before = grade;
        grade = mtfDowngrade[grade] || grade;
        if (before !== grade) {
          result.warnings.push(`MTF celiski: ${oppositeTFs[0]} ters trend — ${before} → ${grade}`);
        }
        result.mtfConflict = { oppositeTFs };
      }
    }
  } catch (err) {
    result.warnings.push(`MTF confluence kontrol hata: ${err.message}`);
  }

  // --- Volume Reaction quality penalty (SMC zone yoksa 1 kademe dusur) ---
  // CLAUDE.md: reaction setup SMC bolgesinde degilse kalite bir kademe asagi.
  if (volumeReaction && volumeReaction.qualityPenalty > 0 && tally.direction === volumeReaction.direction) {
    const reactionDowngrade = { 'A': 'B', 'B': 'C', 'C': 'BEKLE', 'BEKLE': 'BEKLE', 'IPTAL': 'IPTAL' };
    const before = grade;
    grade = reactionDowngrade[grade] || grade;
    if (before !== grade) {
      result.warnings.push(`Volume Reaction: SMC zone teyidi yok — ${before} → ${grade}`);
    }
  }

  // --- TF reliability downgrade DEVRE DISI (2026-04-20) ---
  // Zayif TF agirligi zaten weight-adjuster kanaliyla indikator agirliklarina
  // yansiyor; ek kademe dusurme uygulamiyoruz. Ileride tekrar acilabilir.

  // Symbol-specific adjustment — sadece PROMOTION (2026-04-20)
  // Demotion kaldirildi: ladder-engine zaten sembol/grade bazli lig atamasi
  // yapiyor (real / ara / virtual). Ikinci bir "flagged symbol → BEKLE"
  // katmani lig sisteminiyle cakisiyordu.
  const symAdj = w.symbolAdjustments[symbol];
  if (symAdj && symAdj.gradeShift > 0 && grade !== 'IPTAL') {
    result.warnings.push(`${symbol}: ${symAdj.reason}`);
    // Promotion: BEKLE ligasinda tutarli kazanc saglayan semboller
    if (grade === 'BEKLE') grade = 'C';
    else if (grade === 'C') grade = 'B';
    else if (grade === 'B') grade = 'A';
  }

  // --- Degraded-mode grade dusurme DEVRE DISI 2026-04-27'YE KADAR ---
  // Yeni strateji/matematik sonrasi sistemi 1 hafta boyunca kendi mantigiyla
  // calistirip ogrenmesi icin savunma moduna gecisi askiya aldik. Tarih
  // gecince blok otomatik geri aktiflesir. Bkz. anomaly-detector.js (evaluate
  // tarafi da ayni tarihe kadar mod degisimi yapmiyor).
  const DEGRADED_MODE_DISABLED_UNTIL = Date.UTC(2026, 3, 27); // 2026-04-27 00:00 UTC
  if (Date.now() >= DEGRADED_MODE_DISABLED_UNTIL) {
    try {
      if (isDegradedMode() && grade !== 'IPTAL' && grade !== 'HATA') {
        const downgradeMap = { 'A': 'B', 'B': 'C', 'C': 'BEKLE', 'BEKLE': 'BEKLE' };
        const originalGrade = grade;
        grade = downgradeMap[grade] || grade;
        if (grade !== originalGrade) {
          result.warnings = result.warnings || [];
          result.warnings.push(`DEGRADED MODE: grade ${originalGrade} → ${grade} (sistem savunma modunda)`);
          result.reasoning.push(`Anomali dedektoru aktif — grade bir kademe dusuruldu`);
        }
      }
    } catch { /* anomaly module okunamazsa normal grade kullan */ }
  }

  // 3-kademe lig sistemi (2026-04-23 guncel): TUM tradable gradeler (A/B/C/BEKLE)
  // sembol bazli ladder ile GERCEK / ARA / SANAL kovalarina atanir. Grade analytics
  // icin sabit kalir; dispatch filtresi league === 'real' uzerinden calisir.
  // A/B varsayilan 'real' (yuksek conviction) — 3 ardisik kayipla ARA/SANAL'a duser.
  // Bkz. scanner/lib/learning/ladder-engine.js
  const positionMap = { 'A': 100, 'B': 70, 'C': 50, 'BEKLE': 0, 'IPTAL': 0 };
  result.grade = grade;
  let league = 'virtual';
  try {
    league = resolveLeague(symbol, grade);
  } catch { league = (grade === 'A' || grade === 'B') ? 'real' : (grade === 'C' ? 'ara' : 'virtual'); }
  result.league = league;
  const basePct = positionMap[grade] || 0;
  result.position_pct = league === 'real' ? basePct : 0;
  if (league !== 'real' && (grade === 'A' || grade === 'B' || grade === 'C')) {
    result.reasoning.push(`Ladder: ${grade} sinyal '${league}' liginde — analitik takip, gercek trade yok`);
  }

  // Summary line
  result.reasoning.push(`--- Oylama: ${tally.voterCount} kaynak | Long: ${tally.longScore} | Short: ${tally.shortScore} | Kanaat: ${tally.conviction} | Uyum: %${tally.agreement} → ${grade}`);

  // --- Calculate entry/SL/TP ---
  // BEKLE dahil — kullanici SL/TP seviyelerini gormek istiyor (sadece IPTAL haric)
  if (grade !== 'IPTAL' && ohlcv && ohlcv.bars && ohlcv.bars.length > 0) {
    const lastBar = ohlcv.bars[ohlcv.bars.length - 1];
    const atr = calculateATR(ohlcv.bars, 14);

    // Use quote price (real-time) as baseline, fallback to lastBar.close
    const currentPrice = quotePrice && quotePrice > 0 ? quotePrice : lastBar.close;

    // Entry sanity check: verify current price is reasonable
    const medianPrice = ohlcv.bars.slice(-20).reduce((s, b) => s + b.close, 0) / Math.min(20, ohlcv.bars.length);
    const priceDeviation = medianPrice > 0 ? Math.abs(currentPrice - medianPrice) / medianPrice : 0;

    if (priceDeviation > 0.5 || currentPrice <= 0 || !isFinite(currentPrice)) {
      result.warnings.push(`Entry fiyati guvenilmez: ${currentPrice} (median: ${medianPrice.toFixed(2)}, sapma: %${(priceDeviation * 100).toFixed(1)})`);
      result.grade = 'HATA';
      result.reasoning.push('Entry fiyati dogrulanamadi — veri yuklenmemis olabilir');
      return result;
    }

    // Momentum Market-Entry bypass: guclu trend + yuksek skor varsa pullback
    // beklemeden anlik fiyattan gir — aksi halde hareket kacirilir.
    // Koşul: ADX >= 28 VE (yön skoru >= %71 VEYA MTF guclu uyum)
    // Faz 0 patch (b): KhanSaab bypass modunda bull/bearScore'u momentum
    // market-entry karari icin kullanma — ADX<25 rejimde yuksek score aldatici.
    const _dirScore = khanSaabDisabledFlag
      ? 0
      : (tally.direction === 'long' ? (khanSaab?.bullScore || 0) : (khanSaab?.bearScore || 0));
    const _mtfStrong = !!(result.mtfConfirmation && result.mtfConfirmation.confidence >= 85
      && result.mtfConfirmation.direction === tally.direction);
    const _adxStrong = (adxVal || 0) >= 28;
    const momentumMarket = _adxStrong && (_dirScore >= 71 || _mtfStrong);

    // Pump-top / dip-short guard: hacimli yesil mum tepesinde long veya
    // hacimli kirmizi mum dibinde short uretmeyi engelle. Tespit edilirse
    // momentum bypass devre disi, smart-entry zorunlu, gerekirse pullback
    // bekle (pendingEntry).
    const pump = detectPumpTop(ohlcv.bars, tally.direction, atr);
    if (pump.isPumpTop) {
      result.pumpGuard = pump;
      result.warnings.push(`PUMP-TOP guard (${pump.severity}): ${pump.reason}`);
    }

    let smartEntry;
    if (momentumMarket && !pump.isPumpTop) {
      smartEntry = {
        entry: currentPrice,
        entrySource: 'quote_price',
        entryZone: null,
        reasoning: [
          `Momentum market-entry: ADX ${(adxVal || 0).toFixed(1)}, ${tally.direction} skoru %${_dirScore}` +
            (_mtfStrong ? `, MTF uyum %${result.mtfConfirmation.confidence}` : '') +
            ' — pullback beklenmedi'
        ],
      };
    } else {
      if (momentumMarket && pump.isPumpTop) {
        result.reasoning.push('Momentum bypass iptal edildi (pump-top guard) — smart-entry zorunlu');
      }
      smartEntry = calculateSmartEntry({
        direction: tally.direction,
        currentPrice,
        atr,
        parsedBoxes: parsedBoxes || null,
        // Faz 0 patch (b): KhanSaab label entry'sini bypass modunda null gecir.
        // ADX<25 / transition rejimde KhanSaab label'lari gurultu — SMC yapisi
        // (OB/FVG/boxes) tek basina entry seciyor olmali.
        khanSaabEntry: khanSaabDisabledFlag ? null : (khanSaabLabels?.entryPrice || null),
      });

      // Pump-top tespit edildi ve smart-entry yapisal zone bulamadi (fallback
      // quote_price). Anlik fiyattan girmek yerine spike mumun govde ortasini
      // pullback hedefi olarak isaretle, sinyal pendingEntry'ye dussun.
      if (pump.isPumpTop && smartEntry.entrySource === 'quote_price') {
        const pullbackTarget = pumpPullbackLevel(pump.spikeBar);
        if (pullbackTarget && Number.isFinite(pullbackTarget)) {
          const dist = Math.abs(currentPrice - pullbackTarget);
          // Pullback fiyatin uzakligi 1.5×ATR'yi gecerse hard reject (cok uzak)
          if (pump.severity === 'hard' && dist > atr * 1.5) {
            result.warnings.push(`PUMP-TOP hard + pullback hedefi ${pullbackTarget.toFixed(4)} cok uzak (${(dist / atr).toFixed(2)}xATR) — sinyal IPTAL`);
            result.pumpRejected = true;
            result.grade = 'IPTAL';
            result.action = 'BEKLE';
            return result;
          }
          smartEntry = {
            entry: pullbackTarget,
            entrySource: 'pump_pullback',
            entryZone: { high: Math.max(pump.spikeBar.open, pump.spikeBar.close), low: Math.min(pump.spikeBar.open, pump.spikeBar.close) },
            reasoning: [`Pump-top tespit edildi (${pump.severity}) — spike mumun govde ortasi (${pullbackTarget.toFixed(4)}) pullback hedefi olarak set edildi, BEKLE_PULLBACK durumuna gecer`],
          };
          result.pendingPullback = {
            target: pullbackTarget,
            direction: tally.direction,
            severity: pump.severity,
            spikeBarTime: pump.spikeBar.time || pump.spikeBar.timestamp || null,
            atrAtTrigger: atr,
          };
          result.action = 'BEKLE_PULLBACK';
        }
      }
    }

    let entryPrice = smartEntry.entry;
    result.entrySource = smartEntry.entrySource;
    result.entryZone = smartEntry.entryZone;
    result.entryReasoning = smartEntry.reasoning;
    result.quotePrice = currentPrice;

    // Compute effective SL multiplier: base regime × category × TF adjustments
    const effectiveSLMult = computeEffectiveSLMultiplier(volRegime, symbol, timeframe);

    // Apply learned TF-level SL override ONLY if wider than computed (never tighter)
    const learnedTFMult = w.slMultiplierOverrides?.[timeframe];
    // Apply per-symbol SL override: object form { low, normal, high } keyed by bare symbol
    const _bareSym = ((symbol || '').includes(':') ? symbol.split(':')[1] : symbol || '').toUpperCase();
    const _symOverride = Object.entries(w.slMultiplierOverrides || {})
      .find(([k, v]) => typeof v === 'object' && v && (v.low != null || v.normal != null || v.high != null) && (_bareSym === k || _bareSym.startsWith(k)));
    let symSLMult = null;
    if (_symOverride) {
      const rule = _symOverride[1];
      // volRegime is the OBJECT returned by getVolatilityRegime ({regime, slMultiplier, ...}).
      // Map the regime name to the {low, normal, high} buckets used by per-symbol overrides.
      const regimeName = volRegime?.regime || null;
      const volBucket = regimeName === 'STRONG_TREND' ? 'high'
                      : regimeName === 'RANGE'        ? 'low'
                      :                                 'normal';
      symSLMult = volBucket === 'high' ? (rule.high ?? null)
                : volBucket === 'low'  ? (rule.low  ?? null)
                :                         (rule.normal ?? null);
    }
    // Final multiplier: max of all three (effective, TF-learned, per-symbol) — widest wins
    let slMultiplier = effectiveSLMult;
    if (typeof learnedTFMult === 'number' && learnedTFMult > slMultiplier) slMultiplier = learnedTFMult;
    if (typeof symSLMult === 'number' && symSLMult > slMultiplier) slMultiplier = symSLMult;

    result.entry = entryPrice;
    result.slMultiplier = slMultiplier;
    result.atr = atr;

    // Minimum SL distance as percentage of price (safety floor)
    const categoryBoost = getCategorySLBoost(symbol);
    const minSLPct = categoryBoost >= 1.3 ? 0.015   // Crypto: 1.5% min
                   : categoryBoost >= 1.15 ? 0.012   // Commodities: 1.2% min
                   : 0.01;                            // Stocks/Forex: 1.0% min
    const atrSL = atr * slMultiplier;
    const minSL = entryPrice * minSLPct;
    let finalSL = Math.max(atrSL, minSL);
    let slSource = 'atr_based';

    // Yapisal SL: crypto + abd_hisse + bist icin son 20 bardaki swing low/high'a
    // 0.2×ATR buffer ile baglar. ATR-bazli SL'den DAHA SIKI ise tercih edilir
    // (rastgele atr×k yerine gerçek pivot). Daha gevsekse yine ATR kullanilir
    // — yapisal SL hicbir zaman gevsetmez, sadece sikilastirir.
    const _structCats = new Set(['kripto', 'crypto', 'abd_hisse', 'bist']);
    if (_structCats.has(result.category)) {
      const struct = findStructuralSL(ohlcv.bars, tally.direction, entryPrice, atr, 20);
      if (struct && struct.slDistance >= minSL && struct.slDistance < finalSL) {
        finalSL = struct.slDistance;
        slSource = 'structural_swing';
        result.structuralSL = {
          swingPrice: Number(struct.swingPrice.toFixed(6)),
          swingIndex: struct.swingIndex,
          distance: Number(struct.slDistance.toFixed(6)),
        };
        result.reasoning.push(`SL: yapisal swing ${tally.direction === 'long' ? 'low' : 'high'} @ ${struct.swingPrice.toFixed(4)} (0.2×ATR buffer)`);
      }
    }

    // OB-based SL optimization: if entry is at OB, use OB boundary as tighter SL
    if (smartEntry.entrySource === 'smc_ob' && smartEntry.entryZone) {
      const obSL = tally.direction === 'long'
        ? smartEntry.entryZone.low - (atr * 0.2) // Just below OB low
        : smartEntry.entryZone.high + (atr * 0.2); // Just above OB high
      const obSLDist = Math.abs(entryPrice - obSL);
      // Use OB SL only if tighter than ATR-based but wider than minimum
      if (obSLDist >= minSL && obSLDist < finalSL) {
        finalSL = obSLDist;
        slSource = 'ob_boundary';
      }
    }

    result.slSource = slSource;

    const squeeze = computeSqueezeRatio(ohlcv.bars, 14, 20);
    const tpPolicy = resolveTpPolicy(squeeze ? squeeze.ratio : null, result.grade);
    result.squeezeRatio = squeeze ? Number(squeeze.ratio.toFixed(3)) : null;
    result.volRegimeTP = tpPolicy.regime;
    result.tpCount = tpPolicy.tpCount;
    result.tpRMultipliers = tpPolicy.tpR;
    result.tpQualityTier = tpPolicy.grade;
    applyTpLevels(result, entryPrice, finalSL, tally.direction, tpPolicy.tpR, tpPolicy.tpCount);

    // Safety: entry must not be beyond SL (would make no sense)
    // Entry quote_price'a duserse SL/TP mesafesini yeni entry uzerinden
    // yeniden hesapla — yoksa SL/TP eski (smart) entry'e baglı kalır ve
    // R:R, risk% ve TP hedefleri tutarsız olur.
    const entryFellBack = (tally.direction === 'long' && entryPrice < result.sl) ||
                          (tally.direction === 'short' && entryPrice > result.sl);
    if (entryFellBack) {
      entryPrice = currentPrice;
      result.entry = entryPrice;
      result.entrySource = 'quote_price';
      result.entryReasoning = ['Entry OB SL otesinde, anlik fiyata geri donuldu'];
      // Fallback: OB tabanli SL artik gecersiz, sadece ATR bazli SL kullan.
      finalSL = Math.max(atrSL, entryPrice * minSLPct);
      slSource = 'atr_based';
      result.slSource = slSource;
      applyTpLevels(result, entryPrice, finalSL, tally.direction, tpPolicy.tpR, tpPolicy.tpCount);
    }

    // --- Faz 0 patch (d): smart-entry SL sanity validation ---
    // Alignment filters'dan ONCE cagrilir — boylece bozuk SL/TP filter'a
    // gitmeden yakalanir ve tani (entry/sl/tp + source) log'a dusurulur.
    // Validation kriterleri:
    //   (1) entry, sl, tp1 sonlu sayi > 0
    //   (2) SL entry'nin dogru tarafinda (long: sl<entry, short: sl>entry)
    //   (3) SL mesafesi entry'nin %20'sini asmasin (absurd SL)
    //   (4) SL mesafesi minSL'den kucuk olmasin (cok sikisik)
    //   (5) TP'ler entry'nin dogru tarafinda ve progresif
    //       (long: tp1<tp2<tp3 ve hepsi entry'nin ustunde; short tersi)
    {
      const _fail = (code, msg) => {
        const diag = {
          symbol, timeframe, direction: tally.direction,
          entry: result.entry, sl: result.sl,
          tp1: result.tp1, tp2: result.tp2, tp3: result.tp3,
          entrySource: result.entrySource, slSource: result.slSource,
          atr, slMultiplier,
          code,
        };
        console.warn(`[SmartEntry][SL_SANITY_FAIL] ${code}: ${msg}`, JSON.stringify(diag));
        result.warnings.push(`SL_SANITY_FAIL:${code} — ${msg}`);
        result.reasoning.push(`IPTAL: SL/TP sanity ${code}`);
        result.filterRejected = true;
        result.filterReasons = [`SL_SANITY:${code}`, msg];
        result.grade = null;
        result.action = 'BEKLE';
      };

      const _e = Number(result.entry);
      const _s = Number(result.sl);
      const _t1 = Number(result.tp1);
      const dir = tally.direction;

      if (!Number.isFinite(_e) || _e <= 0 || !Number.isFinite(_s) || _s <= 0 || !Number.isFinite(_t1) || _t1 <= 0) {
        _fail('nonfinite', `entry=${result.entry}, sl=${result.sl}, tp1=${result.tp1}`);
        return result;
      }
      if (dir === 'long' && _s >= _e) {
        _fail('sl_wrong_side', `long ama SL(${_s}) >= entry(${_e})`); return result;
      }
      if (dir === 'short' && _s <= _e) {
        _fail('sl_wrong_side', `short ama SL(${_s}) <= entry(${_e})`); return result;
      }
      const _slDist = Math.abs(_e - _s);
      if (_slDist > _e * 0.20) {
        _fail('sl_absurd_distance', `SL mesafesi ${(_slDist / _e * 100).toFixed(2)}% > %20 cap`); return result;
      }
      const _minSLAbs = _e * (result.category === 'kripto' || result.category === 'crypto' ? 0.005 : 0.003);
      if (_slDist < _minSLAbs) {
        _fail('sl_too_tight', `SL mesafesi ${(_slDist / _e * 100).toFixed(3)}% < floor`); return result;
      }

      // TP'ler: yon tutarli + progresif. Null TP'lere dokunma (tpCount < 3 olabilir).
      const _tps = [result.tp1, result.tp2, result.tp3].map(v => (v == null ? null : Number(v)));
      for (let i = 0; i < _tps.length; i++) {
        const tp = _tps[i];
        if (tp == null) continue;
        if (!Number.isFinite(tp) || tp <= 0) { _fail('tp_nonfinite', `tp${i+1}=${tp}`); return result; }
        if (dir === 'long' && tp <= _e)  { _fail('tp_wrong_side', `long ama tp${i+1}(${tp}) <= entry(${_e})`); return result; }
        if (dir === 'short' && tp >= _e) { _fail('tp_wrong_side', `short ama tp${i+1}(${tp}) >= entry(${_e})`); return result; }
      }
      for (let i = 1; i < _tps.length; i++) {
        const a = _tps[i - 1], b = _tps[i];
        if (a == null || b == null) continue;
        if (dir === 'long'  && !(b > a)) { _fail('tp_not_progressive', `long tp${i+1}(${b}) <= tp${i}(${a})`); return result; }
        if (dir === 'short' && !(b < a)) { _fail('tp_not_progressive', `short tp${i+1}(${b}) >= tp${i}(${a})`); return result; }
      }
    }

    // --- Alignment Filters: SL ↔ OB catismasi + HTF Fibonacci hizalama ---
    // TP/SL set edildikten sonra, R:R hesaplanmadan once uygulanir. Eger HTF
    // trend iki+ TF'de zit yondeyse sinyal IPTAL edilir. TP'ler HTF fib direnci/
    // desteginin otesine gecerse fib'in hemen onune capped. SL baska bir OB'nin
    // icinde/kenarindaysa OB disina tasinir.
    try {
      const align = applyAlignmentFilters({
        symbol,
        direction: tally.direction,
        entry: result.entry,
        sl: result.sl,
        tp1: result.tp1,
        tp2: result.tp2,
        tp3: result.tp3,
        atr,
        smc,
        srLines: Array.isArray(smcSRLines) ? smcSRLines : [],
        entryOBZone: smartEntry?.entryZone || null,
        currentTF: timeframe,
      });

      if (align.rejected) {
        result.grade = null;
        result.action = 'BEKLE';
        result.reasoning.push(...align.reasons);
        result.warnings.push(...align.reasons);
        result.filterRejected = true;
        result.filterReasons = align.reasons;
        return result;
      }

      // SL/TP ayar edildiyse uygula
      if (align.slMoved) {
        result.sl = align.adjusted.sl;
        result.slSource = 'ob_conflict_adjusted';
      }
      if (align.adjusted.tp1 !== result.tp1) result.tp1 = align.adjusted.tp1;
      if (align.adjusted.tp2 !== result.tp2) result.tp2 = align.adjusted.tp2;
      if (align.adjusted.tp3 !== result.tp3) result.tp3 = align.adjusted.tp3;

      if (align.warnings.length) result.warnings.push(...align.warnings);
      if (align.htfSummary) {
        result.htfFibSummary = align.htfSummary;
        // CLAUDE.md zorunlulugu: her sinyalde HTF Fib satiri olmali.
        // Short'lar icin support (below), long'lar icin resistance (above) gosteririz —
        // TP yolundaki ilk HTF engel. Entry'ye yuzde mesafe konum bilgisi verir.
        const nearest = tally.direction === 'short' ? align.htfSummary.nearestBelow : align.htfSummary.nearestAbove;
        if (nearest?.price != null && Number.isFinite(nearest.price)) {
          const distPct = entryPrice > 0 ? ((nearest.price - entryPrice) / entryPrice) * 100 : 0;
          const relText = distPct >= 0
            ? `entry bu seviyenin %${distPct.toFixed(2)} altinda`
            : `entry bu seviyenin %${Math.abs(distPct).toFixed(2)} ustunde`;
          const roleText = tally.direction === 'short' ? 'destek (TP yolu)' : 'direnc (TP yolu)';
          result.reasoning.push(`HTF Fib: ${nearest.tf} ${nearest.level} @ ${Number(nearest.price).toFixed(4)} ${roleText} / ${relText}`);
        } else {
          const trendTFs = Array.isArray(align.htfSummary.htfTrends) ? align.htfSummary.htfTrends.map(t => `${t.tf}:${t.regime}`).join(', ') : '';
          result.reasoning.push(`HTF Fib: yakin TP-yonu seviyesi yok${trendTFs ? ` (HTF trend: ${trendTFs})` : ''}`);
        }
      } else {
        result.reasoning.push(`HTF Fib: cache bulunamadi veya 30h+ eski — fib refresh gerekli`);
      }

      if (align.barrierSummary) {
        result.barrierSummary = align.barrierSummary;
        const above = align.barrierSummary.above || [];
        const below = align.barrierSummary.below || [];
        if (above.length || below.length) {
          const fmt = (z) => `${z.tf}@${Number(z.price).toFixed(4)}(s=${Number(z.strength).toFixed(1)})`;
          result.reasoning.push(`Barrier: ust=[${above.slice(0, 3).map(fmt).join(', ') || '-'}] alt=[${below.slice(0, 3).map(fmt).join(', ') || '-'}]`);
        }
      }
      if (align.entryZoneClass?.inZone) {
        result.entryZoneClass = align.entryZoneClass;
      }
    } catch (e) {
      // Filter hatasi sinyali kirmasin — uyari olarak dusur.
      result.warnings.push(`[AlignFilter] hata: ${e.message}`);
    }

    const risk = Math.abs(result.entry - result.sl);
    const reward = Math.abs(result.tp2 - result.entry);
    result.rr = risk > 0 ? `1:${(reward / risk).toFixed(1)}` : 'N/A';
    result.slDistancePct = ((risk / entryPrice) * 100).toFixed(2) + '%';

    const minRR = gt.minRR || 2;
    if (risk > 0 && reward / risk < minRR) {
      result.warnings.push(`R:R ${result.rr} < 1:${minRR} minimum`);
      result.grade = 'IPTAL';
      const rrNum = (reward / risk).toFixed(2);
      result.reasoning.push(`--- SERT BLOK IPTAL: R:R 1:${rrNum} < 1:${minRR} minimum — pozisyon acilmaz`);
    }
  }

  return result;
}

/**
 * Grade a long-term signal based on Supertrend + IFCCI + formations.
 */
export function gradeLongTermSignal({ studyValues, ohlcv, formation, symbol, timeframe }) {
  const result = {
    symbol, timeframe,
    supertrend: null, ifcci: null,
    combination: null, action: 'BEKLE',
    reasoning: [], formationInfo: null,
  };

  if (!studyValues) {
    result.reasoning.push('Indikator verisi okunamadi');
    return result;
  }

  const stDirection = extractSupertrendDirection(studyValues);
  const ifcciValue = extractIFCCI(studyValues);
  result.supertrend = stDirection;
  result.ifcci = ifcciValue;

  let longVotes = 0;
  let shortVotes = 0;

  // Supertrend vote
  if (stDirection === 'bullish') { longVotes += 2; result.reasoning.push('Supertrend yesil (LONG +2)'); }
  else if (stDirection === 'bearish') { shortVotes += 2; result.reasoning.push('Supertrend kirmizi (SHORT +2)'); }

  // IFCCI vote — trend takip: pozitif = bullish momentum, negatif = bearish momentum
  // Asiri bolgeler (>0.5 / <-0.5) trend gucunu gosterir, donus sinyali DEGILDIR.
  // Donus sinyali icin IFCCI yonunu (yukselme/dusme) kullan, seviye degil.
  if (ifcciValue != null) {
    if (ifcciValue > 0.5) { longVotes += 1; result.reasoning.push(`IFCCI ${ifcciValue.toFixed(2)} guclu pozitif momentum`); }
    else if (ifcciValue > 0) { longVotes += 0.5; result.reasoning.push(`IFCCI ${ifcciValue.toFixed(2)} pozitif`); }
    else if (ifcciValue < -0.5) { shortVotes += 1; result.reasoning.push(`IFCCI ${ifcciValue.toFixed(2)} guclu negatif momentum`); }
    else if (ifcciValue < 0) { shortVotes += 0.5; result.reasoning.push(`IFCCI ${ifcciValue.toFixed(2)} negatif`); }
  }

  // Formation vote (same weight as Supertrend)
  if (formation && formation.formations && formation.formations.length > 0) {
    const f = formation.formations[0];
    result.formationInfo = f;
    if (f.direction === 'bullish') {
      const w = f.broken ? 2 : 1;
      longVotes += w;
      result.reasoning.push(`Formasyon: ${f.name} bullish${f.broken ? ' — KIRILIM TEYITLI (+2)' : ' (+1)'}`);
    } else if (f.direction === 'bearish') {
      const w = f.broken ? 2 : 1;
      shortVotes += w;
      result.reasoning.push(`Formasyon: ${f.name} bearish${f.broken ? ' — KIRILIM TEYITLI (+2)' : ' (+1)'}`);
    }
  }

  // Determine action
  const totalVotes = longVotes + shortVotes;
  if (longVotes > shortVotes && longVotes >= 2) {
    result.combination = longVotes >= 4 ? 'GUCLU LONG' : 'LONG';
    result.action = longVotes >= 4 ? 'GUCLU LONG' : 'LONG';
  } else if (shortVotes > longVotes && shortVotes >= 2) {
    result.combination = shortVotes >= 4 ? 'GUCLU SHORT' : 'SHORT';
    result.action = shortVotes >= 4 ? 'GUCLU SHORT' : 'SHORT';
  } else {
    result.combination = 'CELISKILI';
    result.action = 'BEKLE';
  }

  result.reasoning.push(`Long: ${longVotes} | Short: ${shortVotes} → ${result.action}`);

  return result;
}

// --- Helper functions ---

/**
 * Calculate the ideal entry price based on signal context (SMC zones, KhanSaab ENTRY).
 * Instead of blindly using lastBar.close, finds the best pullback zone for entry.
 */
function calculateSmartEntry({ direction, currentPrice, atr, parsedBoxes, khanSaabEntry }) {
  const result = {
    entry: currentPrice,
    entrySource: 'quote_price',
    entryZone: null,
    reasoning: [],
  };

  if (!currentPrice || !atr || atr <= 0) return result;

  const maxPullbackDistance = atr * 2.0; // Don't look for zones beyond 2 ATR

  if (direction === 'long') {
    // Look for bullish OB below current price (pullback to institutional buy zone)
    let bestOB = null;
    if (parsedBoxes?.orderBlocks?.length) {
      for (const ob of parsedBoxes.orderBlocks) {
        if (ob.high < currentPrice && (currentPrice - ob.high) <= maxPullbackDistance) {
          if (!bestOB || ob.high > bestOB.high) bestOB = ob; // Nearest OB below
        }
      }
    }

    // Look for FVG below current price (gap fill zone)
    let bestFVG = null;
    if (parsedBoxes?.fvgZones?.length) {
      for (const fvg of parsedBoxes.fvgZones) {
        if (fvg.high < currentPrice && (currentPrice - fvg.high) <= maxPullbackDistance) {
          if (!bestFVG || fvg.high > bestFVG.high) bestFVG = fvg; // Nearest FVG below
        }
      }
    }

    // KhanSaab ENTRY label below current price
    let ksEntry = null;
    if (khanSaabEntry && khanSaabEntry > 0 && khanSaabEntry < currentPrice
        && (currentPrice - khanSaabEntry) <= maxPullbackDistance) {
      ksEntry = khanSaabEntry;
    }

    // Priority: OB > FVG > KhanSaab ENTRY > quote price
    if (bestOB) {
      result.entry = bestOB.high;
      result.entrySource = 'smc_ob';
      result.entryZone = bestOB;
      result.reasoning.push(`Bullish OB zonu (${bestOB.low.toFixed(2)}-${bestOB.high.toFixed(2)}), pullback bekleniyor`);
    } else if (bestFVG) {
      result.entry = bestFVG.high;
      result.entrySource = 'smc_fvg';
      result.entryZone = bestFVG;
      result.reasoning.push(`FVG zonu (${bestFVG.low.toFixed(2)}-${bestFVG.high.toFixed(2)}), gap dolumu bekleniyor`);
    } else if (ksEntry) {
      result.entry = ksEntry;
      result.entrySource = 'khansaab_entry';
      result.reasoning.push(`KhanSaab ENTRY etiketi (${ksEntry.toFixed(2)})`);
    } else {
      result.reasoning.push(`Pullback bolgesi bulunamadi, anlik fiyat kullaniliyor (${currentPrice.toFixed(2)})`);
    }
  } else if (direction === 'short') {
    // Look for bearish OB above current price
    let bestOB = null;
    if (parsedBoxes?.orderBlocks?.length) {
      for (const ob of parsedBoxes.orderBlocks) {
        if (ob.low > currentPrice && (ob.low - currentPrice) <= maxPullbackDistance) {
          if (!bestOB || ob.low < bestOB.low) bestOB = ob; // Nearest OB above
        }
      }
    }

    // Look for FVG above current price
    let bestFVG = null;
    if (parsedBoxes?.fvgZones?.length) {
      for (const fvg of parsedBoxes.fvgZones) {
        if (fvg.low > currentPrice && (fvg.low - currentPrice) <= maxPullbackDistance) {
          if (!bestFVG || fvg.low < bestFVG.low) bestFVG = fvg; // Nearest FVG above
        }
      }
    }

    // KhanSaab ENTRY label above current price
    let ksEntry = null;
    if (khanSaabEntry && khanSaabEntry > 0 && khanSaabEntry > currentPrice
        && (khanSaabEntry - currentPrice) <= maxPullbackDistance) {
      ksEntry = khanSaabEntry;
    }

    if (bestOB) {
      result.entry = bestOB.low;
      result.entrySource = 'smc_ob';
      result.entryZone = bestOB;
      result.reasoning.push(`Bearish OB zonu (${bestOB.low.toFixed(2)}-${bestOB.high.toFixed(2)}), pullback bekleniyor`);
    } else if (bestFVG) {
      result.entry = bestFVG.low;
      result.entrySource = 'smc_fvg';
      result.entryZone = bestFVG;
      result.reasoning.push(`FVG zonu (${bestFVG.low.toFixed(2)}-${bestFVG.high.toFixed(2)}), gap dolumu bekleniyor`);
    } else if (ksEntry) {
      result.entry = ksEntry;
      result.entrySource = 'khansaab_entry';
      result.reasoning.push(`KhanSaab ENTRY etiketi (${ksEntry.toFixed(2)})`);
    } else {
      result.reasoning.push(`Pullback bolgesi bulunamadi, anlik fiyat kullaniliyor (${currentPrice.toFixed(2)})`);
    }
  }

  return result;
}

function calculateATR(bars, period = 14) {
  if (!bars || bars.length < period + 1) return 0;
  const recent = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < recent.length; i++) {
    const tr = Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function extractADX(studyValues) {
  if (!studyValues) return null;
  for (const study of (Array.isArray(studyValues) ? studyValues : [])) {
    if (!study.values) continue;
    for (const [key, val] of Object.entries(study.values)) {
      const k = key.toLowerCase();
      if (!k.includes('adx') || k.includes('+di') || k.includes('-di')) continue;
      if (typeof val !== 'number' || !isFinite(val)) continue;
      // ADX 0-100 araliginda — disi degerler indicator bug'i, clamp et.
      return Math.min(100, Math.max(0, val));
    }
  }
  return null;
}

function extractSupertrendDirection(studyValues) {
  if (!studyValues) return null;
  for (const study of (Array.isArray(studyValues) ? studyValues : [])) {
    const name = (study.name || '').toLowerCase();
    if (name.includes('supertrend')) {
      if (study.values) {
        const upVal = study.values['Up Trend'] || study.values['up'] || study.values['Up'];
        const downVal = study.values['Down Trend'] || study.values['down'] || study.values['Down'];
        if (upVal && !downVal) return 'bullish';
        if (downVal && !upVal) return 'bearish';
        // Both truthy: Supertrend aktif çizgi tek olduğundan burası belirsiz.
        // Fiyatı bilmeden tahmin etmek yerine null dön — çağıran taraf
        // "Supertrend okunamadı" olarak işler, yanlış yön vermez.
      }
    }
  }
  return null;
}

function extractIFCCI(studyValues) {
  if (!studyValues) return null;
  for (const study of (Array.isArray(studyValues) ? studyValues : [])) {
    const name = (study.name || '').toLowerCase();
    if (name.includes('fisher') || name.includes('ifcci') || name.includes('cci')) {
      if (study.values) {
        const val = Object.values(study.values).find(v => typeof v === 'number');
        return val || null;
      }
    }
  }
  return null;
}
