/**
 * Calculation-based filters — no extra indicators needed.
 * RSI Divergence, Squeeze/Volatility, CDV/Volume Direction, StochRSI
 */

/**
 * Detect RSI divergence from price and RSI data.
 * Uses last 20+ bars of OHLCV. RSI array is calculated internally via calcRSIArray.
 * Compares RSI values AT THE ACTUAL SWING POINTS — not just the current bar.
 *
 * @param {Array} bars - OHLCV bars (en az 34 bar: 14 RSI warmup + 20 analiz)
 * @param {number|string} rsiValue - KhanSaab'dan gelen mevcut RSI (fallback/ek kontrol)
 */
export function detectRSIDivergence(bars, rsiValue) {
  if (!bars || bars.length < 34) return null;

  // RSI array hesapla — her bar icin RSI degeri (ilk 14 null)
  const closes = bars.map(b => b.close);
  const rsiArr = calcRSIArray(closes, 14);
  if (rsiArr.length === 0) return null;

  // Son 20 bari al (RSI warmup sonrasi)
  const analysisLen = 20;
  const startIdx = bars.length - analysisLen;
  if (startIdx < 0) return null;
  const recent = bars.slice(startIdx);
  const recentRSI = rsiArr.slice(startIdx);

  // Swing low/high bul (5-bar pivot: 2 bar solda + 2 bar sagda)
  const priceLows = [];
  const priceHighs = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].low < recent[i - 1].low && recent[i].low < recent[i - 2].low &&
        recent[i].low < recent[i + 1].low && recent[i].low < recent[i + 2].low) {
      const rsiAtSwing = recentRSI[i];
      if (rsiAtSwing != null) priceLows.push({ index: i, price: recent[i].low, rsi: rsiAtSwing });
    }
    if (recent[i].high > recent[i - 1].high && recent[i].high > recent[i - 2].high &&
        recent[i].high > recent[i + 1].high && recent[i].high > recent[i + 2].high) {
      const rsiAtSwing = recentRSI[i];
      if (rsiAtSwing != null) priceHighs.push({ index: i, price: recent[i].high, rsi: rsiAtSwing });
    }
  }

  let divergence = null;

  // Fiyat farki esigi: ATR-normalize (0.25 × ATR). Sabit %0.2 esigi forex'te
  // cok gevsek, kriptoda cok sikiydi. ATR yoksa fallback olarak %0.2 kullan.
  const atrEst = computeSimpleATR(recent, 14);
  const minPriceDelta = atrEst != null ? atrEst * 0.25 : null;
  // RSI farki esigi: divergence anlamli olsun diye min 2 puan.
  const minRSIDelta = 2;

  // Bullish divergence: fiyat daha dusuk dip + RSI daha yuksek dip
  if (priceLows.length >= 2) {
    const prevLow = priceLows[priceLows.length - 2];
    const lastLow = priceLows[priceLows.length - 1];
    const priceDrop = prevLow.price - lastLow.price;
    const priceOK = minPriceDelta != null
      ? priceDrop >= minPriceDelta
      : lastLow.price < prevLow.price * 0.998;
    if (priceOK && lastLow.rsi - prevLow.rsi >= minRSIDelta) {
      divergence = {
        type: 'bullish',
        description: `Bullish Divergence: fiyat ${prevLow.price.toFixed(2)} → ${lastLow.price.toFixed(2)} (dusuk), RSI ${prevLow.rsi.toFixed(1)} → ${lastLow.rsi.toFixed(1)} (yuksek)`,
        priceLevel: lastLow.price,
        rsi: lastLow.rsi,
      };
    }
  }

  // Bearish divergence: fiyat daha yuksek tepe + RSI daha dusuk tepe
  if (!divergence && priceHighs.length >= 2) {
    const prevHigh = priceHighs[priceHighs.length - 2];
    const lastHigh = priceHighs[priceHighs.length - 1];
    const priceRise = lastHigh.price - prevHigh.price;
    const priceOK = minPriceDelta != null
      ? priceRise >= minPriceDelta
      : lastHigh.price > prevHigh.price * 1.002;
    if (priceOK && prevHigh.rsi - lastHigh.rsi >= minRSIDelta) {
      divergence = {
        type: 'bearish',
        description: `Bearish Divergence: fiyat ${prevHigh.price.toFixed(2)} → ${lastHigh.price.toFixed(2)} (yuksek), RSI ${prevHigh.rsi.toFixed(1)} → ${lastHigh.rsi.toFixed(1)} (dusuk)`,
        priceLevel: lastHigh.price,
        rsi: lastHigh.rsi,
      };
    }
  }

  return divergence;
}

/**
 * Squeeze / Volatility detection from ATR values.
 * Uses KhanSaab ATR(14) + last 20 bars OHLCV.
 */
export function detectSqueeze(bars, currentATR) {
  if (!bars || bars.length < 20 || !currentATR) return null;

  const atr = parseFloat(currentATR);
  if (isNaN(atr) || atr <= 0) return null;

  // Calculate Wilder-smoothed ATR(14) from bars, then take 20-bar average
  const period = 14;
  // Son 60 bar (>= 14 warmup + 20 analiz). Eski kod Math.max kullanip
  // tum diziyi aliyordu → seed cok eski TR'lerden hesaplaniyordu.
  const recent = bars.slice(-Math.min(bars.length, 60));
  if (recent.length < period + 1) return null;

  const trValues = [];
  for (let i = 1; i < recent.length; i++) {
    trValues.push(Math.max(
      recent[i].high - recent[i].low,
      Math.abs(recent[i].high - recent[i - 1].close),
      Math.abs(recent[i].low - recent[i - 1].close)
    ));
  }

  // Wilder smoothing (RMA) — same as KhanSaab ATR
  const atrSeries = [];
  let rma = trValues.slice(0, period).reduce((s, v) => s + v, 0) / period;
  atrSeries.push(rma);
  for (let i = period; i < trValues.length; i++) {
    rma = (rma * (period - 1) + trValues[i]) / period;
    atrSeries.push(rma);
  }

  // 20 barlık ortalama ATR (Wilder smoothed)
  const last20 = atrSeries.slice(-20);
  const avgATR = last20.reduce((s, v) => s + v, 0) / last20.length;
  const ratio = avgATR > 0 ? atr / avgATR : 1;

  if (ratio < 0.6) {
    return {
      status: 'squeeze',
      description: 'ATR dusuk — Squeeze aktif, giris YAPMA',
      ratio: Math.round(ratio * 100),
      action: 'BEKLE',
    };
  } else if (ratio > 1.4) {
    return {
      status: 'high_volatility',
      description: 'ATR yuksek — Yuksek volatilite, SL genislet',
      ratio: Math.round(ratio * 100),
      action: 'SL_CARPANI_2',
    };
  } else {
    return {
      status: 'normal',
      description: 'Normal volatilite',
      ratio: Math.round(ratio * 100),
      action: 'STANDART',
    };
  }
}

/**
 * CDV approximation — volume direction estimation from OHLCV.
 * Uses last 5 bars close vs open + volume.
 */
export function analyzeCDV(bars) {
  if (!bars || bars.length < 5) return null;

  const last5 = bars.slice(-5);
  let buyPressure = 0;
  let sellPressure = 0;
  let totalVolume = 0;

  for (const bar of last5) {
    const isBullish = bar.close > bar.open;
    totalVolume += bar.volume;

    if (isBullish) {
      buyPressure += bar.volume;
    } else {
      sellPressure += bar.volume;
    }
  }

  const buyRatio = totalVolume > 0 ? buyPressure / totalVolume : 0.5;
  const bullishBars = last5.filter(b => b.close > b.open).length;

  let direction;
  if (buyRatio > 0.65 && bullishBars >= 4) {
    direction = 'STRONG_BUY';
  } else if (buyRatio > 0.55 && bullishBars >= 3) {
    direction = 'BUY';
  } else if (buyRatio < 0.35 && bullishBars <= 1) {
    direction = 'STRONG_SELL';
  } else if (buyRatio < 0.45 && bullishBars <= 2) {
    direction = 'SELL';
  } else {
    direction = 'NEUTRAL';
  }

  return {
    direction,
    buyRatio: Math.round(buyRatio * 100),
    sellRatio: Math.round((1 - buyRatio) * 100),
    bullishBars,
    bearishBars: 5 - bullishBars,
    description: `Son 5 bar: ${bullishBars} alis / ${5 - bullishBars} satis, Alis baskisi %${Math.round(buyRatio * 100)}`,
  };
}

/**
 * Parse KhanSaab dashboard table data to extract structured values.
 * Input: array of studies, each with { name, tables: [{ rows: ["col1 | col2 | ...", ...] }] }
 * (unwrapped by tv-bridge.js — raw studies array from getPineTables)
 */
export function parseKhanSaabDashboard(tableData) {
  if (!tableData || !Array.isArray(tableData) || tableData.length === 0) return null;

  const result = {
    bullScore: null,
    bearScore: null,
    bias: null,
    rsi: null,
    macd: null,
    adx: null,
    vwap: null,
    volume: null,
    emaStatus: null,
    signalStatus: null,
    atr: null,
  };

  // Iterate through studies → tables → rows
  // Each row format: "LABEL | VALUE" (pipe-delimited)
  for (const study of tableData) {
    if (!study.tables) continue;
    for (const table of study.tables) {
      if (!table.rows) continue;
      for (const row of table.rows) {
        const cells = String(row).split('|').map(c => c.trim());
        const label = (cells[0] || '').toLowerCase();
        const value = cells[1] || '';
        const valueLower = value.toLowerCase();

        // Bull/Bear scores: "BULL SCORE | 14%"
        if (label.includes('bull') && label.includes('score')) {
          const m = value.match(/(\d+)/);
          if (m) result.bullScore = parseInt(m[1]);
        }
        if (label.includes('bear') && label.includes('score')) {
          const m = value.match(/(\d+)/);
          if (m) result.bearScore = parseInt(m[1]);
        }

        // Bias: "MARKET BIAS | STRONG BEAR"
        if (label.includes('bias')) {
          if (valueLower.includes('strong bull')) result.bias = 'STRONG BULL';
          else if (valueLower.includes('mild bull') || valueLower.includes('moderate bull')) result.bias = 'MILD BULL';
          else if (valueLower.includes('strong bear')) result.bias = 'STRONG BEAR';
          else if (valueLower.includes('mild bear') || valueLower.includes('moderate bear')) result.bias = 'MILD BEAR';
          else if (valueLower.includes('bull')) result.bias = 'MILD BULL';
          else if (valueLower.includes('bear')) result.bias = 'MILD BEAR';
          else result.bias = value.trim();
        }

        // Signal status: "Status | WAIT" or "Status | NEW BUY" etc.
        if (label === 'status' || label.includes('signal')) {
          if (valueLower.includes('buy')) result.signalStatus = 'BUY';
          else if (valueLower.includes('sell')) result.signalStatus = 'SELL';
          else if (valueLower.includes('wait')) result.signalStatus = 'WAIT';
        }

        // RSI: "RSI (14) | 33.4" — use value column, NOT label.
        // Stoch RSI / RSI MA / RSI Div gibi satirlari haric tut (rsi'yi ezerlerdi).
        if (label.includes('rsi') && !label.includes('5m')
            && !label.includes('stoch') && !label.includes('ma')
            && !label.includes('div')) {
          const m = value.match(/(\d+\.?\d*)/);
          if (m) result.rsi = parseFloat(m[1]);
        }
        // 5m RSI: "5m RSI | 72.5"
        if (label.includes('5m') && label.includes('rsi')) {
          const m = value.match(/(\d+\.?\d*)/);
          if (m) result.rsi5m = parseFloat(m[1]);
        }

        // ADX: "ADX Power | 29.3" — matematiksel olarak 0-100 araliginda
        // Bazi Pine indicator'lar kumulatif/sum ADX yayiyor (246.8 gibi bozuk deger).
        // Clamp et, panel hatasi olsa bile sagliksiz deger score'u bozmasin.
        if (label.includes('adx') && !label.includes('+di') && !label.includes('-di')) {
          const m = value.match(/(\d+\.?\d*)/);
          if (m) {
            const raw = parseFloat(m[1]);
            if (isFinite(raw)) {
              result.adx = Math.min(100, Math.max(0, raw));
            }
          }
        }

        // ATR: "ATR 14 | 2.61" — value is the actual ATR value
        if (label.includes('atr')) {
          const m = value.match(/(\d+\.?\d*)/);
          if (m) result.atr = parseFloat(m[1]);
        }

        // MACD: "MACD Trend | BEAR", "MACD Main | -3.25", "MACD Sig | -3.13"
        if (label.includes('macd') && label.includes('trend')) {
          result.macd = valueLower.includes('bull') ? 'BULL' : valueLower.includes('bear') ? 'BEAR' : value.trim();
        }
        if (label.includes('macd') && label.includes('main')) {
          const m = value.match(/-?\d+\.?\d*/);
          if (m) result.macdMain = parseFloat(m[0]);
        }
        if (label.includes('macd') && label.includes('sig')) {
          const m = value.match(/-?\d+\.?\d*/);
          if (m) result.macdSignal = parseFloat(m[0]);
        }

        // Volume: "Vol Status | LOW"
        if (label.includes('vol') && label.includes('status')) {
          result.volume = valueLower.includes('high') ? 'HIGH' : 'LOW';
        }

        // VWAP: "Price/VWAP | BELOW" — sadece acik above/below isaretlerini kabul et.
        // Aksi halde null birak (eski kod her bilinmeyen degeri BELOW yapip bias'i bozuyordu).
        if (label.includes('vwap')) {
          if (valueLower.includes('above') || valueLower.includes('over')) result.vwap = 'ABOVE';
          else if (valueLower.includes('below') || valueLower.includes('under')) result.vwap = 'BELOW';
        }

        // EMA Cross: "EMA Cross | BEAR" — sadece cross/status satirini parse et.
        // "EMA 9 | 152.34", "EMA 200 | ..." gibi salt-sayisal satirlar emaStatus'u bozuyordu.
        if (label.includes('ema') && (label.includes('cross') || label.includes('status') || label.includes('trend'))) {
          if (valueLower.includes('bull')) result.emaStatus = 'BULL';
          else if (valueLower.includes('bear')) result.emaStatus = 'BEAR';
        }

        // Trend Strength: "Trend Str | STRONG"
        if (label.includes('trend') && label.includes('str')) {
          result.trendStrength = value.trim();
        }
      }
    }
  }

  return result;
}

/**
 * Parse SMC labels to extract BOS/CHoCH structures.
 * Input: array of studies, each with { name, total_labels, showing, labels: [{ text, price }] }
 * (unwrapped by tv-bridge.js — raw studies array from getPineLabels)
 */
export function parseSMCLabels(labelData) {
  if (!labelData || !Array.isArray(labelData) || labelData.length === 0) return null;

  const result = {
    lastBOS: null,
    lastCHoCH: null,
    eqh: [],
    eql: [],
    strongHigh: null,
    weakHigh: null,
    strongLow: null,
    weakLow: null,
  };

  // RGB kanal karsilastirmasi: belirgin yesil → bullish, belirgin kirmizi/turuncu → bearish.
  // LuxAlgo gibi indikatorler ozel hex paleti (#819908, #f23645, #4536f2 ...) kullanabilir;
  // sabit hex listesi tutmak yerine kanallari karsilastirmak daha guvenilir.
  const colorDirection = (label) => {
    const hint = `${label.color ?? ''} ${label.textColor ?? ''}`;
    if (/\b(green|lime|teal)\b/i.test(hint)) return 'bullish';
    if (/\b(red|orange|crimson|maroon)\b/i.test(hint)) return 'bearish';
    const matches = hint.match(/#([0-9a-f]{6})/gi) || [];
    let bull = 0, bear = 0;
    for (const m of matches) {
      const n = parseInt(m.slice(1), 16);
      const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
      if (r === g && g === b) continue; // gri/siyah/beyaz: bilgi yok
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      // Bullish: G dominant kanal (yesil/teal/olive aileleri).
      // Bearish: G en zayif kanal (kirmizi/turuncu/pembe/mor/magenta).
      if (g === max && max - min > 10) bull++;
      else if ((r === max || (b === max && g === min)) && max - min > 10) bear++;
    }
    if (bull > bear) return 'bullish';
    if (bear > bull) return 'bearish';
    return null;
  };

  for (const study of labelData) {
    if (!study.labels) continue;
    for (const label of study.labels) {
      const labelText = label.text || '';
      const textStr = String(labelText).toUpperCase();
      const price = label.price;
      const colDir = colorDirection(label);

      if (textStr.includes('BOS')) {
        // Yon tespiti: 1) Text'te acik yon, 2) ok isareti, 3) renk kanalindan tahmin.
        const isBullish = textStr.includes('BULL') || textStr.includes('↑') || textStr.includes('UP')
          || colDir === 'bullish';
        const isBearish = textStr.includes('BEAR') || textStr.includes('↓') || textStr.includes('DOWN')
          || colDir === 'bearish';
        const direction = isBullish ? 'bullish' : isBearish ? 'bearish' : null;
        result.lastBOS = { direction, raw: textStr, price };
      }
      if (textStr.includes('CHOCH')) {
        const isBullish = textStr.includes('BULL') || textStr.includes('↑') || textStr.includes('UP')
          || colDir === 'bullish';
        const isBearish = textStr.includes('BEAR') || textStr.includes('↓') || textStr.includes('DOWN')
          || colDir === 'bearish';
        const direction = isBullish ? 'bullish' : isBearish ? 'bearish' : null;
        result.lastCHoCH = { direction, raw: textStr, price };
      }
      if (textStr.includes('EQH')) result.eqh.push({ text: textStr, price });
      if (textStr.includes('EQL')) result.eql.push({ text: textStr, price });
      if (textStr.includes('STRONG') && textStr.includes('HIGH')) result.strongHigh = { text: textStr, price };
      if (textStr.includes('WEAK') && textStr.includes('HIGH')) result.weakHigh = { text: textStr, price };
      if (textStr.includes('STRONG') && textStr.includes('LOW')) result.strongLow = { text: textStr, price };
      if (textStr.includes('WEAK') && textStr.includes('LOW')) result.weakLow = { text: textStr, price };
    }
  }

  return result;
}

/**
 * Determine volatility regime from ADX value.
 */
export function getVolatilityRegime(adxValue) {
  const adx = parseFloat(adxValue);
  if (isNaN(adx)) return { regime: 'unknown', adx: null, slMultiplier: 2.5, strategy: 'Veri yok — varsayilan genis SL' };

  if (adx > 35) {
    return {
      regime: 'STRONG_TREND',
      adx,
      slMultiplier: 3.5,
      strategy: 'Guclu trend — momentum sinyalleri cok guvenilir, genis SL',
    };
  } else if (adx > 25) {
    return {
      regime: 'TREND',
      adx,
      slMultiplier: 2.5,
      strategy: 'Trend var — KhanSaab + SMC sinyalleri guvenilir',
    };
  } else if (adx > 20) {
    return {
      regime: 'TRANSITION',
      adx,
      slMultiplier: 2.0,
      strategy: 'Gecis bolgesi — sinyalleri dikkatli degerlendir',
    };
  } else {
    return {
      regime: 'RANGE',
      adx,
      slMultiplier: 1.5,
      strategy: 'Range — momentum sinyallerini YOKSAY, sadece OB bounce',
    };
  }
}

/**
 * Get category-specific SL multiplier boost.
 * Crypto is much more volatile than stocks.
 */
export function getCategorySLBoost(symbol) {
  if (!symbol) return 1.0;
  const s = symbol.toUpperCase();
  const bare = s.includes(':') ? s.split(':')[1] : s;
  // Crypto tespiti: bilinen token + USDT/USDC suffix (USDCHF gibi forex ciftlerini haric tut)
  const CRYPTO_TOKENS = ['BTC', 'ETH', 'SOL', 'XRP', 'SUI', 'DOGE', 'AVAX', 'ADA', 'LINK', 'HYPE', 'DOT'];
  if (CRYPTO_TOKENS.some(t => bare.includes(t)) || bare.endsWith('USDT') || bare.endsWith('USDC')) return 1.4;
  if (bare.includes('XAU') || bare.includes('GOLD') || bare.includes('OIL') || bare.includes('WTI')) return 1.2;
  return 1.0; // Forex + Stocks: standard
}

/**
 * Get timeframe-specific SL adjustment.
 * Lower TFs have more noise, need wider SL relative to ATR.
 */
export function getTFSLBoost(tf) {
  const tfStr = String(tf);
  switch (tfStr) {
    case '1': case '3': case '5': return 1.5;
    case '15': return 1.3;
    case '30': return 1.2;
    case '45': return 1.1;
    case '60': return 1.0;
    case '120': case '240': return 0.95;
    case '1D': case '3D': case '1W': case '1M': return 0.9;
    default: return 1.0;
  }
}

/**
 * Find a structural SL distance based on recent swing low (long) or swing
 * high (short). Returns the SL DISTANCE (not the absolute price level) so the
 * caller can plug it into the same `Math.max(atrSL, minSL)` flow.
 *
 *   - Long: en yakin swing low (entry'nin altinda, 0.5..3 ATR mesafede),
 *     buffer = swingLow − 0.2×ATR. SL distance = entry − (swingLow − 0.2×ATR).
 *   - Short: simetrik (en yakin swing high, +0.2×ATR buffer).
 *   - Swing pivot: 5-bar (i ± 2). lookback varsayilan 20 bar.
 *   - Bulamazsa veya distance minSLPct'in altina duserse null doner; caller
 *     mevcut ATR formuluna duser.
 *
 * @param {Array} bars - OHLCV bars (kronolojik, son element en son kapali bar)
 * @param {'long'|'short'} direction
 * @param {number} entry
 * @param {number} atr
 * @param {number} [lookback=20]
 * @returns {{ slDistance: number, swingPrice: number, swingIndex: number } | null}
 */
export function findStructuralSL(bars, direction, entry, atr, lookback = 20) {
  if (!Array.isArray(bars) || bars.length < lookback + 4) return null;
  if (!entry || !atr || atr <= 0) return null;
  if (direction !== 'long' && direction !== 'short') return null;

  const slice = bars.slice(-lookback);
  const minDist = atr * 0.5;
  const maxDist = atr * 3.0;
  let best = null; // {price, index}

  for (let i = 2; i < slice.length - 2; i++) {
    if (direction === 'long') {
      const isPivotLow = slice[i].low < slice[i - 1].low && slice[i].low < slice[i - 2].low &&
                         slice[i].low < slice[i + 1].low && slice[i].low < slice[i + 2].low;
      if (!isPivotLow) continue;
      const dist = entry - slice[i].low;
      if (dist < minDist || dist > maxDist) continue;
      // En yakin (en yuksek) swing low'u tercih et — entry'ye en yakin destek
      if (!best || slice[i].low > best.price) best = { price: slice[i].low, index: i };
    } else {
      const isPivotHigh = slice[i].high > slice[i - 1].high && slice[i].high > slice[i - 2].high &&
                          slice[i].high > slice[i + 1].high && slice[i].high > slice[i + 2].high;
      if (!isPivotHigh) continue;
      const dist = slice[i].high - entry;
      if (dist < minDist || dist > maxDist) continue;
      if (!best || slice[i].high < best.price) best = { price: slice[i].high, index: i };
    }
  }

  if (!best) return null;
  const buffer = atr * 0.2;
  const slPrice = direction === 'long' ? best.price - buffer : best.price + buffer;
  const slDistance = Math.abs(entry - slPrice);
  return { slDistance, swingPrice: best.price, swingIndex: best.index };
}

/**
 * Compute the effective SL multiplier combining all factors.
 */
export function computeEffectiveSLMultiplier(volRegime, symbol, tf) {
  const base = volRegime?.slMultiplier || 2.5;
  const catBoost = getCategorySLBoost(symbol);
  const tfBoost = getTFSLBoost(tf);
  // Final = base × category boost × TF boost, clamped between 1.5 and 5.0
  return Math.min(Math.max(Math.round(base * catBoost * tfBoost * 100) / 100, 1.5), 5.0);
}

/**
 * Basit ATR hesabi (Wilder yerine SMA-of-TR). Divergence/box gibi yardimci
 * fonksiyonlarda esik normalizasyonu icin yeterli.
 */
function computeSimpleATR(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    trs.push(Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    ));
  }
  const tail = trs.slice(-period);
  if (tail.length < period) return null;
  const atr = tail.reduce((s, v) => s + v, 0) / tail.length;
  return atr > 0 ? atr : null;
}

// --- StochRSI ---

/**
 * Calculate RSI from close prices.
 * Returns array of RSI values (same length as input, first `period` values null).
 */
function calcRSIArray(closes, period = 14) {
  if (closes.length < period + 1) return [];

  const rsi = new Array(closes.length).fill(null);
  let avgGain = 0;
  let avgLoss = 0;

  // Seed: average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;

  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Smoothed (Wilder)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

/**
 * Simple Moving Average of last `len` non-null values from array.
 */
function sma(arr, len) {
  const vals = arr.filter(v => v != null);
  if (vals.length < len) return null;
  const slice = vals.slice(-len);
  return slice.reduce((s, v) => s + v, 0) / len;
}

/**
 * Calculate Stochastic RSI from OHLCV bars.
 *
 * Formula:
 *   RSI(14) → StochRSI %K = (RSI - min(RSI, lookback)) / (max(RSI, lookback) - min(RSI, lookback)) × 100
 *   %D = SMA(%K, dPeriod)
 *
 * @param {Array} bars - OHLCV bar objects with .close
 * @param {Object} [opts]
 * @param {number} [opts.rsiPeriod=14]
 * @param {number} [opts.stochPeriod=14] - lookback window for stochastic
 * @param {number} [opts.kSmooth=3] - %K smoothing
 * @param {number} [opts.dSmooth=3] - %D smoothing (SMA of %K)
 * @param {number|null} [opts.emaValue] - EMA value for trend filter (null = no filter)
 * @param {boolean} [opts.volumeHigh] - KhanSaab Vol Status = HIGH
 *
 * @returns {{ k, d, signal, divergence, reasoning }|null}
 */
export function calculateStochRSI(bars, opts = {}) {
  const rsiPeriod = opts.rsiPeriod || 14;
  const stochPeriod = opts.stochPeriod || 14;
  const kSmooth = opts.kSmooth || 3;
  const dSmooth = opts.dSmooth || 3;
  const emaValue = opts.emaValue ?? null;
  const volumeHigh = opts.volumeHigh || false;

  // Need enough bars: rsiPeriod + stochPeriod + kSmooth + dSmooth + margin
  const minBars = rsiPeriod + stochPeriod + kSmooth + dSmooth + 5;
  if (!bars || bars.length < minBars) return null;

  const closes = bars.map(b => b.close);
  const rsiArr = calcRSIArray(closes, rsiPeriod);

  // Filter to valid RSI values (skip initial nulls)
  const validStart = rsiArr.findIndex(v => v != null);
  if (validStart < 0) return null;
  const validRSI = rsiArr.slice(validStart);

  if (validRSI.length < stochPeriod + kSmooth + dSmooth) return null;

  // Raw StochRSI: apply stochastic formula over rolling window
  const rawStoch = [];
  for (let i = stochPeriod - 1; i < validRSI.length; i++) {
    const window = validRSI.slice(i - stochPeriod + 1, i + 1);
    const min = Math.min(...window);
    const max = Math.max(...window);
    rawStoch.push(max === min ? 50 : ((validRSI[i] - min) / (max - min)) * 100);
  }

  if (rawStoch.length < kSmooth + dSmooth) return null;

  // %K = SMA of raw stochastic (smoothing)
  const kValues = [];
  for (let i = kSmooth - 1; i < rawStoch.length; i++) {
    const window = rawStoch.slice(i - kSmooth + 1, i + 1);
    kValues.push(window.reduce((s, v) => s + v, 0) / kSmooth);
  }

  if (kValues.length < dSmooth) return null;

  // %D = SMA of %K
  const dValues = [];
  for (let i = dSmooth - 1; i < kValues.length; i++) {
    const window = kValues.slice(i - dSmooth + 1, i + 1);
    dValues.push(window.reduce((s, v) => s + v, 0) / dSmooth);
  }

  const k = kValues[kValues.length - 1];
  const d = dValues[dValues.length - 1];
  const prevK = kValues.length >= 2 ? kValues[kValues.length - 2] : null;
  const prevD = dValues.length >= 2 ? dValues[dValues.length - 2] : null;

  const lastClose = closes[closes.length - 1];
  const reasoning = [];

  // --- Signal detection ---
  let signal = null;

  // Crossover detection (requires previous values)
  if (prevK != null && prevD != null) {
    const crossUp = prevK <= prevD && k > d;     // %K crosses above %D
    const crossDown = prevK >= prevD && k < d;    // %K crosses below %D

    if (crossUp && (prevK < 20 || k < 20)) {
      // Oversold crossover → potential BUY (prevK veya k oversold bolgede)
      signal = 'BUY';
      reasoning.push(`StochRSI alindan yukari kesisim: %K=${k.toFixed(1)} %D=${d.toFixed(1)} (asiri satim bolgesi)`);
    } else if (crossDown && (prevK > 80 || k > 80)) {
      // Overbought crossunder → potential SELL (prevK veya k overbought bolgede)
      signal = 'SELL';
      reasoning.push(`StochRSI ustten asagi kesisim: %K=${k.toFixed(1)} %D=${d.toFixed(1)} (asiri alim bolgesi)`);
    }
  }

  // --- HARD RULE: Trend filtresi zorunlu ---
  // Fiyat EMA uzerindeyse SADECE BUY, altindaysa SADECE SELL.
  // Karsi yon gormezden gelinir.
  if (signal && emaValue != null) {
    if (signal === 'BUY' && lastClose < emaValue) {
      reasoning.push(`StochRSI BUY sinyali IPTAL: fiyat (${lastClose.toFixed(2)}) EMA (${emaValue.toFixed(2)}) altinda — trend filtresi`);
      signal = null;
    } else if (signal === 'SELL' && lastClose > emaValue) {
      reasoning.push(`StochRSI SELL sinyali IPTAL: fiyat (${lastClose.toFixed(2)}) EMA (${emaValue.toFixed(2)}) uzerinde — trend filtresi`);
      signal = null;
    }
  }

  // --- Divergence detection (son 20 bar) ---
  let divergence = null;
  const divBars = Math.min(20, kValues.length);
  if (divBars >= 10) {
    const recentKs = kValues.slice(-divBars);
    const recentCloses = closes.slice(-divBars);

    // Find swing lows/highs in %K
    const kLows = [];
    const kHighs = [];
    for (let i = 2; i < recentKs.length - 2; i++) {
      if (recentKs[i] < recentKs[i - 1] && recentKs[i] < recentKs[i - 2] &&
          recentKs[i] < recentKs[i + 1] && recentKs[i] < recentKs[i + 2]) {
        kLows.push({ idx: i, k: recentKs[i], price: recentCloses[i] });
      }
      if (recentKs[i] > recentKs[i - 1] && recentKs[i] > recentKs[i - 2] &&
          recentKs[i] > recentKs[i + 1] && recentKs[i] > recentKs[i + 2]) {
        kHighs.push({ idx: i, k: recentKs[i], price: recentCloses[i] });
      }
    }

    // Bullish divergence: price lower low but StochRSI higher low
    if (kLows.length >= 2) {
      const prev = kLows[kLows.length - 2];
      const last = kLows[kLows.length - 1];
      if (last.price < prev.price * 0.998 && last.k > prev.k + 2) {
        divergence = 'bullish';
        reasoning.push(`StochRSI Bullish Divergence: fiyat dusuk dip yaparken StochRSI yukseliyor`);
      }
    }

    // Bearish divergence: price higher high but StochRSI lower high
    if (!divergence && kHighs.length >= 2) {
      const prev = kHighs[kHighs.length - 2];
      const last = kHighs[kHighs.length - 1];
      if (last.price > prev.price * 1.002 && last.k < prev.k - 2) {
        divergence = 'bearish';
        reasoning.push(`StochRSI Bearish Divergence: fiyat yuksek tepe yaparken StochRSI dusuyor`);
      }
    }
  }

  return {
    k: Math.round(k * 100) / 100,
    d: Math.round(d * 100) / 100,
    signal,
    divergence,
    volumeHigh,
    reasoning,
  };
}

// --- Independent Technical Indicator Calculations ---

function calcEMA(values, period) {
  if (!values || values.length < period) return [];
  const k = 2 / (period + 1);
  const result = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

export function calcEMACross(bars) {
  if (!bars || bars.length < 22) return null;
  const closes = bars.map(b => b.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const last = closes.length - 1;
  const e9 = ema9[last], e21 = ema21[last];
  if (e9 == null || e21 == null) return null;
  return { emaStatus: e9 > e21 ? 'BULL' : 'BEAR', ema9: e9, ema21: e21 };
}

export function calcMACD(bars, fast = 12, slow = 26, signal = 9) {
  if (!bars || bars.length < slow + signal + 5) return null;
  const closes = bars.map(b => b.close);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (emaFast[i] == null || emaSlow[i] == null) continue;
    macdLine.push(emaFast[i] - emaSlow[i]);
  }
  if (macdLine.length < signal + 2) return null;
  const signalLine = calcEMA(macdLine, signal);
  const lastM = macdLine[macdLine.length - 1];
  const lastS = signalLine[signalLine.length - 1];
  if (lastM == null || lastS == null) return null;
  return { macd: lastM > lastS ? 'BULL' : 'BEAR', macdMain: lastM, macdSignal: lastS };
}

export function calcADX(bars, period = 14) {
  if (!bars || bars.length < period * 2 + 5) return null;
  const trArr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < bars.length; i++) {
    const { high, low } = bars[i];
    const prevClose = bars[i - 1].close;
    const prevHigh = bars[i - 1].high, prevLow = bars[i - 1].low;
    trArr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const up = high - prevHigh, down = prevLow - low;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
  }
  // Risk #18 fix: Wilder RMA klasik formul.
  // Onceki kod baslangic olarak TOPLAM aliyor (ortalama yerine), recurrence'ta
  // arr[i]/p yerine arr[i] kullaniyor → cikis ~p kat sisirilmis (ADX 14x hata).
  // Dogru formul: RMA[i] = (RMA[i-1] * (p-1) + arr[i]) / p, baslangic ortalama.
  function wilderRMA(arr, p) {
    if (arr.length < p) return [];
    const out = new Array(arr.length).fill(null);
    out[p - 1] = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
    for (let i = p; i < arr.length; i++) out[i] = (out[i - 1] * (p - 1) + arr[i]) / p;
    return out;
  }
  const smoothTR = wilderRMA(trArr, period);
  const smoothPlus = wilderRMA(plusDM, period);
  const smoothMinus = wilderRMA(minusDM, period);
  const dxArr = [];
  for (let i = period - 1; i < trArr.length; i++) {
    const tr = smoothTR[i], sp = smoothPlus[i], sm = smoothMinus[i];
    if (!tr || tr === 0) continue;
    const diPlus = (sp / tr) * 100, diMinus = (sm / tr) * 100;
    const dsum = diPlus + diMinus;
    if (dsum === 0) continue;
    dxArr.push(Math.abs(diPlus - diMinus) / dsum * 100);
  }
  if (dxArr.length < period) return null;
  const adxArr = wilderRMA(dxArr, period);
  const last = adxArr[adxArr.length - 1];
  if (last == null) return null;

  // Faz 2 v2.2 — ADX serisi (son 5 değer) eklendi → slope hesaplamaya yarıyor.
  // Yalnız null olmayan tail değerleri al; round 1 ondalık hane.
  const tail = [];
  for (let i = adxArr.length - 1; i >= 0 && tail.length < 5; i--) {
    if (adxArr[i] != null) tail.unshift(Math.round(adxArr[i] * 10) / 10);
  }

  return {
    adx: Math.round(last * 10) / 10,
    adxSeries: tail,  // son 5 ADX değeri (en eski → en yeni)
  };
}

/**
 * Compute EMA cross, MACD, ADX, RSI from raw OHLCV bars.
 * Returns an object compatible with the parsedKS shape used in signal-grader.
 * VWAP, bias, signalStatus, bullScore, bearScore are not computable here → null.
 */
export function calcTechnicals(bars) {
  if (!bars || bars.length < 50) return null;
  const closes = bars.map(b => b.close);
  const rsiArr = calcRSIArray(closes, 14);
  const currentRSI = rsiArr[rsiArr.length - 1];
  const emaCross = calcEMACross(bars);
  const macdResult = calcMACD(bars);
  const adxResult = calcADX(bars);
  return {
    rsi: currentRSI != null ? Math.round(currentRSI * 10) / 10 : null,
    emaStatus: emaCross?.emaStatus ?? null,
    ema9: emaCross?.ema9 ?? null,
    ema21: emaCross?.ema21 ?? null,
    macd: macdResult?.macd ?? null,
    macdMain: macdResult?.macdMain ?? null,
    macdSignal: macdResult?.macdSignal ?? null,
    adx: adxResult?.adx ?? null,
    adxSeries: adxResult?.adxSeries ?? null,  // Faz 2 v2.2 — slope için son 5 ADX
    vwap: null,
    bias: null,
    signalStatus: null,
    bullScore: null,
    bearScore: null,
    volume: null,
    atr: null,
  };
}

// --- Smart Entry Support: SMC Box Parsing & KhanSaab Label Parsing ---

/**
 * Parse SMC boxes into Order Blocks and FVG zones.
 * OB/FVG distinction: zone height < 0.3% of mid price → FVG, else → OB.
 *
 * @param {Array} boxData - Raw box data from readSMC().boxes (getPineBoxes result)
 * @returns {{ orderBlocks: Array<{high, low, mid}>, fvgZones: Array<{high, low, mid}> }}
 */
export function parseSMCBoxes(boxData, opts = {}) {
  if (!boxData || !Array.isArray(boxData) || boxData.length === 0) {
    return { orderBlocks: [], fvgZones: [] };
  }

  // ATR-normalize esik: zone yuksekligi < 0.5×ATR ise FVG, aksi halde OB.
  // ATR yoksa eski %0.3 fallback'ine dus (instrument-bagimsiz olmasa da
  // veri yoksa baska secenek yok).
  const atr = typeof opts.atr === 'number' && opts.atr > 0 ? opts.atr : null;
  const fvgAtrMult = 0.5;
  const fvgPctFallback = 0.003;

  const orderBlocks = [];
  const fvgZones = [];

  for (const study of boxData) {
    if (!study.zones && !study.boxes) continue;
    const zones = study.zones || study.boxes || [];

    for (const zone of zones) {
      if (!zone.high || !zone.low || zone.high <= zone.low) continue;

      const mid = (zone.high + zone.low) / 2;
      const height = zone.high - zone.low;

      const entry = {
        high: zone.high,
        low: zone.low,
        mid,
        color: zone.color || zone.bgcolor || null,
      };

      const isFVG = atr != null
        ? height < atr * fvgAtrMult
        : (mid > 0 && height / mid < fvgPctFallback);

      if (isFVG) fvgZones.push(entry);
      else orderBlocks.push(entry);
    }
  }

  return { orderBlocks, fvgZones };
}

/**
 * SMC indikatorunun cizdigi yatay destek/direnc cizgilerini parse eder.
 * readSMC().lines her study icin { name, horizontal_levels:[prices] } doner.
 * Burada tum studylerden yatay seviyeleri tek bir listeye flatten ederiz.
 *
 * @param {Array} lineData - readSMC().lines (getPineLines ciktisi)
 * @returns {Array<number>} Dedupli, sirali yatay seviye fiyatlari (yuksek→dusuk)
 */
export function parseSMCLines(lineData) {
  if (!Array.isArray(lineData) || lineData.length === 0) return [];
  const levels = new Set();
  for (const study of lineData) {
    const hl = study?.horizontal_levels || [];
    for (const lv of hl) {
      if (typeof lv === 'number' && isFinite(lv) && lv > 0) levels.add(Number(lv));
    }
  }
  return Array.from(levels).sort((a, b) => b - a);
}

/**
 * Parse KhanSaab pine labels to extract ENTRY price and signal labels.
 *
 * @param {Array} labelData - Raw label data from readKhanSaab().labels (getPineLabels result)
 * @returns {{ entryPrice: number|null, signals: Array<{text, price}> }}
 */
export function parseKhanSaabLabels(labelData) {
  if (!labelData || !Array.isArray(labelData) || labelData.length === 0) {
    return { entryPrice: null, signals: [] };
  }

  const result = { entryPrice: null, signals: [] };

  for (const study of labelData) {
    if (!study.labels) continue;
    for (const label of study.labels) {
      const text = String(label.text || '').toUpperCase().trim();
      const price = label.price;

      if (text.includes('ENTRY') && price != null && price > 0) {
        result.entryPrice = price;
      }
      if (text.includes('BUY') || text.includes('SELL') || text.includes('LONG') || text.includes('SHORT')) {
        result.signals.push({ text: label.text, price });
      }
    }
  }

  return result;
}
