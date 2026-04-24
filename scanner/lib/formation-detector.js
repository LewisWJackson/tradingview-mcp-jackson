/**
 * Formation Detector — identifies chart patterns from OHLCV data.
 * No extra indicators needed — pure calculation from price bars.
 */

/**
 * Find swing highs and lows in OHLCV data.
 * A swing high has at least `lookback` bars on each side with lower highs.
 * A swing low has at least `lookback` bars on each side with higher lows.
 */
export function findSwingPoints(bars, lookback = 3) {
  const swingHighs = [];
  const swingLows = [];

  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= lookback; j++) {
      if (bars[i].high <= bars[i - j].high || bars[i].high <= bars[i + j].high) {
        isHigh = false;
      }
      if (bars[i].low >= bars[i - j].low || bars[i].low >= bars[i + j].low) {
        isLow = false;
      }
    }

    if (isHigh) swingHighs.push({ index: i, price: bars[i].high, time: bars[i].time });
    if (isLow) swingLows.push({ index: i, price: bars[i].low, time: bars[i].time });
  }

  return { swingHighs, swingLows };
}

/**
 * Detect ascending triangle: flat resistance + rising support.
 */
function detectAscendingTriangle(swingHighs, swingLows, bars) {
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);

  // Check flat resistance (highs within 1% range)
  const maxHigh = Math.max(...recentHighs.map(h => h.price));
  const minHigh = Math.min(...recentHighs.map(h => h.price));
  const highRange = (maxHigh - minHigh) / maxHigh;

  // Check rising lows
  let risingLows = true;
  for (let i = 1; i < recentLows.length; i++) {
    if (recentLows[i].price <= recentLows[i - 1].price) risingLows = false;
  }

  if (highRange < 0.015 && risingLows && recentHighs.length >= 2) {
    const resistance = (maxHigh + minHigh) / 2;
    const lastPrice = bars[bars.length - 1].close;
    const distToResistance = (resistance - lastPrice) / resistance;
    const height = resistance - recentLows[0].price;

    let maturity = 70;
    if (distToResistance < 0.005) maturity = 95;
    else if (distToResistance < 0.01) maturity = 85;
    else if (distToResistance < 0.02) maturity = 75;

    const broken = lastPrice > resistance * 1.002;
    if (broken) maturity = 100;

    return {
      name: 'Yukselen Ucgen (Ascending Triangle)',
      type: 'continuation',
      direction: 'bullish',
      resistance,
      support_trend: recentLows.map(l => l.price),
      maturity,
      broken,
      // Hedef: formasyon yuksekligi kadar kirilim noktasindan.
      // Kirilim olmadan once target "projeksiyon" olarak raporlanir.
      target: resistance + height,
      height,
    };
  }
  return null;
}

/**
 * Detect descending triangle: flat support + falling resistance.
 */
function detectDescendingTriangle(swingHighs, swingLows, bars) {
  if (swingHighs.length < 2 || swingLows.length < 2) return null;

  const recentHighs = swingHighs.slice(-3);
  const recentLows = swingLows.slice(-3);

  const maxLow = Math.max(...recentLows.map(l => l.price));
  const minLow = Math.min(...recentLows.map(l => l.price));
  const lowRange = (maxLow - minLow) / maxLow;

  let fallingHighs = true;
  for (let i = 1; i < recentHighs.length; i++) {
    if (recentHighs[i].price >= recentHighs[i - 1].price) fallingHighs = false;
  }

  if (lowRange < 0.015 && fallingHighs && recentLows.length >= 2) {
    const support = (maxLow + minLow) / 2;
    const lastPrice = bars[bars.length - 1].close;
    const distToSupport = (lastPrice - support) / support;
    const height = recentHighs[0].price - support;

    let maturity = 70;
    if (distToSupport < 0.005) maturity = 95;
    else if (distToSupport < 0.01) maturity = 85;
    else if (distToSupport < 0.02) maturity = 75;

    const broken = lastPrice < support * 0.998;
    if (broken) maturity = 100;

    return {
      name: 'Alcalan Ucgen (Descending Triangle)',
      type: 'continuation',
      direction: 'bearish',
      support,
      resistance_trend: recentHighs.map(h => h.price),
      maturity,
      broken,
      target: support - height,
      height,
    };
  }
  return null;
}

/**
 * Detect double top pattern.
 */
function detectDoubleTop(swingHighs, swingLows, bars) {
  if (swingHighs.length < 2) return null;

  const h1 = swingHighs[swingHighs.length - 2];
  const h2 = swingHighs[swingHighs.length - 1];

  const priceDiff = Math.abs(h1.price - h2.price) / h1.price;
  if (priceDiff > 0.02) return null; // highs must be within 2%

  // Find neckline (lowest low between two tops)
  const middleLows = swingLows.filter(l => l.index > h1.index && l.index < h2.index);
  if (middleLows.length === 0) return null;

  const neckline = Math.min(...middleLows.map(l => l.price));
  const height = ((h1.price + h2.price) / 2) - neckline;
  const lastPrice = bars[bars.length - 1].close;

  let maturity = 75;
  const broken = lastPrice < neckline * 0.998;
  if (broken) maturity = 100;
  else if (lastPrice < neckline * 1.01) maturity = 90;

  return {
    name: 'Cift Tepe (Double Top)',
    type: 'reversal',
    direction: 'bearish',
    top1: h1.price,
    top2: h2.price,
    neckline,
    maturity,
    broken,
    target: neckline - height,
    height,
  };
}

/**
 * Detect double bottom pattern.
 */
function detectDoubleBottom(swingHighs, swingLows, bars) {
  if (swingLows.length < 2) return null;

  const l1 = swingLows[swingLows.length - 2];
  const l2 = swingLows[swingLows.length - 1];

  const priceDiff = Math.abs(l1.price - l2.price) / l1.price;
  if (priceDiff > 0.02) return null;

  const middleHighs = swingHighs.filter(h => h.index > l1.index && h.index < l2.index);
  if (middleHighs.length === 0) return null;

  const neckline = Math.max(...middleHighs.map(h => h.price));
  const height = neckline - ((l1.price + l2.price) / 2);
  const lastPrice = bars[bars.length - 1].close;

  let maturity = 75;
  const broken = lastPrice > neckline * 1.002;
  if (broken) maturity = 100;
  else if (lastPrice > neckline * 0.99) maturity = 90;

  return {
    name: 'Cift Dip (Double Bottom)',
    type: 'reversal',
    direction: 'bullish',
    bottom1: l1.price,
    bottom2: l2.price,
    neckline,
    maturity,
    broken,
    target: neckline + height,
    height,
  };
}

/**
 * Detect Head & Shoulders pattern.
 */
function detectHeadAndShoulders(swingHighs, swingLows, bars) {
  if (swingHighs.length < 3) return null;

  const h = swingHighs.slice(-3);
  // Head must be higher than both shoulders
  if (h[1].price <= h[0].price || h[1].price <= h[2].price) return null;
  // Shoulders should be roughly equal (within 5%)
  const shoulderDiff = Math.abs(h[0].price - h[2].price) / h[0].price;
  if (shoulderDiff > 0.05) return null;

  // Find neckline from lows between shoulders
  const neckLows = swingLows.filter(l => l.index > h[0].index && l.index < h[2].index);
  if (neckLows.length < 1) return null;

  const neckline = neckLows.reduce((sum, l) => sum + l.price, 0) / neckLows.length;
  const height = h[1].price - neckline;
  const lastPrice = bars[bars.length - 1].close;

  let maturity = 70;
  const broken = lastPrice < neckline * 0.998;
  if (broken) maturity = 100;
  // Sag omuzun tamamlanmasina yakinsa (son bar sag omuzdan <=5 bar uzakta),
  // formasyon daha olgun say. Eski kod `h[2].index > h[1].index` yaziyordu —
  // `h` artan-indeks dizisi oldugu icin bu kosul daima true idi.
  else if (bars.length - 1 - h[2].index <= 5) maturity = 80;

  return {
    name: 'Omuz-Bas-Omuz (Head & Shoulders)',
    type: 'reversal',
    direction: 'bearish',
    leftShoulder: h[0].price,
    head: h[1].price,
    rightShoulder: h[2].price,
    neckline,
    maturity,
    broken,
    target: neckline - height,
    height,
  };
}

/**
 * Detect Inverse Head & Shoulders pattern.
 */
function detectInverseHS(swingHighs, swingLows, bars) {
  if (swingLows.length < 3) return null;

  const l = swingLows.slice(-3);
  if (l[1].price >= l[0].price || l[1].price >= l[2].price) return null;
  const shoulderDiff = Math.abs(l[0].price - l[2].price) / l[0].price;
  if (shoulderDiff > 0.05) return null;

  const neckHighs = swingHighs.filter(h => h.index > l[0].index && h.index < l[2].index);
  if (neckHighs.length < 1) return null;

  const neckline = neckHighs.reduce((sum, h) => sum + h.price, 0) / neckHighs.length;
  const height = neckline - l[1].price;
  const lastPrice = bars[bars.length - 1].close;

  let maturity = 70;
  const broken = lastPrice > neckline * 1.002;
  if (broken) maturity = 100;
  // Ayni bug (artan-indeks dizisinde tautoloji) — son bar sag omuzdan yakinsa
  // formasyon olgun.
  else if (bars.length - 1 - l[2].index <= 5) maturity = 80;

  return {
    name: 'Ters OBO (Inverse H&S)',
    type: 'reversal',
    direction: 'bullish',
    leftShoulder: l[0].price,
    head: l[1].price,
    rightShoulder: l[2].price,
    neckline,
    maturity,
    broken,
    target: neckline + height,
    height,
  };
}

/**
 * Detect flag patterns (bull flag / bear flag).
 */
function detectFlag(bars) {
  if (bars.length < 20) return null;

  // Look at last 20 bars: first 5 = pole, last 15 = flag
  const poleStart = bars.length - 20;
  const flagStart = bars.length - 15;

  const poleHigh = Math.max(...bars.slice(poleStart, flagStart).map(b => b.high));
  const poleLow = Math.min(...bars.slice(poleStart, flagStart).map(b => b.low));
  const poleRange = (poleHigh - poleLow) / poleLow;

  // Pole should be significant (> 3% move)
  if (poleRange < 0.03) return null;

  const flagBars = bars.slice(flagStart);
  const flagHigh = Math.max(...flagBars.map(b => b.high));
  const flagLow = Math.min(...flagBars.map(b => b.low));
  const flagRange = (flagHigh - flagLow) / flagLow;

  // Flag should be narrow (< 40% of pole)
  if (flagRange > poleRange * 0.4) return null;

  // Determine direction from pole: hem net yonu (open→close) hem de high-low
  // indeksini kontrol et. Tek bar gap'i kapanisi yaniltabilir; high-low sirasi
  // direkt yonu verir. Ikisi uyusmalidir.
  const poleSlice = bars.slice(poleStart, flagStart);
  const poleHighIdx = poleSlice.reduce((bi, b, i, a) => (b.high > a[bi].high ? i : bi), 0);
  const poleLowIdx  = poleSlice.reduce((bi, b, i, a) => (b.low  < a[bi].low  ? i : bi), 0);
  const poleClose = bars[flagStart - 1].close;
  const poleOpen = bars[poleStart].open;
  const closeUp = poleClose > poleOpen;
  const structureUp = poleHighIdx > poleLowIdx; // low once, high sonra → yukselis
  // Ikisi de ayni yonu gostermiyorsa pole belirsiz — bayrak degil.
  if (closeUp !== structureUp) return null;
  const isBullPole = closeUp;

  // Flag should slope against pole
  const flagSlope = (flagBars[flagBars.length - 1].close - flagBars[0].close) / flagBars[0].close;
  const correctSlope = isBullPole ? flagSlope < 0 : flagSlope > 0;

  if (!correctSlope) return null;

  const lastPrice = bars[bars.length - 1].close;
  const poleHeight = poleHigh - poleLow; // high/low arasi — tam pole yuksekligi

  let maturity = 70;
  const broken = (isBullPole && lastPrice > flagHigh) || (!isBullPole && lastPrice < flagLow);
  if (broken) maturity = 100;
  else maturity = 80;

  // Hedef fiyat: breakout noktasindan (flag siniri) pole yuksekligi kadar
  const target = isBullPole ? flagHigh + poleHeight : flagLow - poleHeight;

  return {
    name: isBullPole ? 'Boga Bayragi (Bull Flag)' : 'Ayi Bayragi (Bear Flag)',
    type: 'continuation',
    direction: isBullPole ? 'bullish' : 'bearish',
    poleHeight,
    flagRange,
    maturity,
    broken,
    target,
    height: poleHeight,
  };
}

/**
 * Detect candlestick patterns in last 3 bars.
 */
export function detectCandlePatterns(bars) {
  if (bars.length < 3) return [];
  const patterns = [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const prevPrev = bars[bars.length - 3];

  const bodySize = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const totalRange = last.high - last.low;

  // Hammer (downtrend'te bullish) / Hanging Man (uptrend'te bearish)
  if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && totalRange > 0) {
    const lookback = Math.min(5, bars.length - 3);
    const trendStart = bars[bars.length - 3 - lookback];
    const trendEnd = bars[bars.length - 3];
    const priorTrend = trendStart && trendEnd ? trendEnd.close - trendStart.close : 0;
    const isDowntrend = priorTrend < 0;

    patterns.push({
      name: isDowntrend ? 'Hammer' : 'Hanging Man',
      direction: isDowntrend ? 'bullish' : 'bearish',
      strength: lowerWick / totalRange > 0.66 ? 'strong' : 'moderate',
    });
  }

  // Inverted Hammer (bullish reversal — long upper wick, small body at bottom)
  // Not: Ust fitil uzun + govde kucuk → dip formasyonunda bullish, tepe formasyonunda
  // Shooting Star olarak yorumlanir. Trend baglami asagida kontrol ediliyor.
  if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && totalRange > 0) {
    // Son 5 barin trendi kontrol et — dusus trendinde Inverted Hammer (bullish),
    // yukselis trendinde Shooting Star (bearish)
    const lookback = Math.min(5, bars.length - 3);
    const trendStart = bars[bars.length - 3 - lookback];
    const trendEnd = bars[bars.length - 3]; // mumun oncesindeki bar
    const priorTrend = trendStart && trendEnd ? trendEnd.close - trendStart.close : 0;
    const isDowntrend = priorTrend < 0;

    patterns.push({
      name: isDowntrend ? 'Inverted Hammer' : 'Shooting Star',
      direction: isDowntrend ? 'bullish' : 'bearish',
      strength: upperWick / totalRange > 0.66 ? 'strong' : 'moderate',
    });
  }

  // Bullish Engulfing
  if (prev.close < prev.open && last.close > last.open &&
      last.open <= prev.close && last.close >= prev.open) {
    patterns.push({
      name: 'Bullish Engulfing',
      direction: 'bullish',
      strength: 'strong',
    });
  }

  // Bearish Engulfing
  if (prev.close > prev.open && last.close < last.open &&
      last.open >= prev.close && last.close <= prev.open) {
    patterns.push({
      name: 'Bearish Engulfing',
      direction: 'bearish',
      strength: 'strong',
    });
  }

  // Doji
  if (totalRange > 0 && bodySize / totalRange < 0.1) {
    patterns.push({
      name: 'Doji',
      direction: 'neutral',
      strength: 'moderate',
    });
  }

  // Morning Star (3-bar bullish reversal)
  const prevPrevBody = Math.abs(prevPrev.close - prevPrev.open);
  const prevBody = Math.abs(prev.close - prev.open);
  if (prevPrev.close < prevPrev.open && // first bar bearish
      prevBody < prevPrevBody * 0.3 && // small middle bar
      last.close > last.open && // last bar bullish
      last.close > (prevPrev.open + prevPrev.close) / 2) { // closes above midpoint
    patterns.push({
      name: 'Morning Star',
      direction: 'bullish',
      strength: 'strong',
    });
  }

  // Evening Star (3-bar bearish reversal)
  if (prevPrev.close > prevPrev.open &&
      prevBody < prevPrevBody * 0.3 &&
      last.close < last.open &&
      last.close < (prevPrev.open + prevPrev.close) / 2) {
    patterns.push({
      name: 'Evening Star',
      direction: 'bearish',
      strength: 'strong',
    });
  }

  // Pin Bar
  if (totalRange > 0) {
    const wickRatio = Math.max(upperWick, lowerWick) / totalRange;
    if (wickRatio > 0.66 && bodySize / totalRange < 0.2) {
      patterns.push({
        name: 'Pin Bar',
        direction: lowerWick > upperWick ? 'bullish' : 'bearish',
        strength: wickRatio > 0.75 ? 'strong' : 'moderate',
        wickSide: lowerWick > upperWick ? 'lower' : 'upper',
      });
    }
  }

  return patterns;
}

/**
 * Main detection function: run all formation detectors on OHLCV bars.
 * @param {Array} bars - OHLCV bar data
 * @param {Object} options - Optional: { timeframe } to tag detected formations with TF
 *
 * IMPORTANT: If no valid formation is detected, returns empty array.
 * Never fabricates or forces a formation — only reports genuine patterns.
 */
export function detectFormations(bars, options = {}) {
  if (!bars || bars.length < 20) {
    return { formations: [], candles: [], swingPoints: null };
  }

  const { swingHighs, swingLows } = findSwingPoints(bars, 3);
  const timeframe = options.timeframe || null;

  const TF_LABELS = { '1': '1m', '3': '3m', '5': '5m', '15': '15m', '30': '30m', '45': '45m', '60': '1H', '120': '2H', '240': '4H', '1D': '1D', '3D': '3D', '1W': '1W', '1M': '1M' };
  const tfLabel = timeframe ? (TF_LABELS[timeframe] || timeframe) : null;

  const detectors = [
    () => detectAscendingTriangle(swingHighs, swingLows, bars),
    () => detectDescendingTriangle(swingHighs, swingLows, bars),
    () => detectDoubleTop(swingHighs, swingLows, bars),
    () => detectDoubleBottom(swingHighs, swingLows, bars),
    () => detectHeadAndShoulders(swingHighs, swingLows, bars),
    () => detectInverseHS(swingHighs, swingLows, bars),
    () => detectFlag(bars),
  ];

  const formations = detectors
    .map(fn => { try { return fn(); } catch { return null; } })
    .filter(Boolean)
    .map(f => ({
      ...f,
      timeframe: timeframe,
      tfLabel: tfLabel,
    }));

  const candles = detectCandlePatterns(bars);

  return { formations, candles, swingPoints: { swingHighs, swingLows } };
}

/**
 * Check volume confirmation for a breakout.
 */
export function checkVolumeConfirmation(bars, lookback = 20) {
  if (!bars || bars.length < lookback + 1) return { confirmed: false, ratio: 0 };

  const recentVols = bars.slice(-lookback - 1, -1).map(b => b.volume);
  const avgVol = recentVols.reduce((a, b) => a + b, 0) / recentVols.length;
  const lastVol = bars[bars.length - 1].volume;
  const ratio = avgVol > 0 ? lastVol / avgVol : 0;

  return {
    confirmed: ratio >= 1.5,
    ratio: Math.round(ratio * 100) / 100,
    avgVolume: Math.round(avgVol),
    lastVolume: Math.round(lastVol),
  };
}
