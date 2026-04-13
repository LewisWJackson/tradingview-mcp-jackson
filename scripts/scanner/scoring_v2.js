/**
 * Coiled Spring Scanner — Scoring Engine v2
 *
 * Pure-logic module: takes data objects, returns scores, confidence, and risk.
 * No I/O, no network calls.
 *
 * 5 categories, 120 pts total:
 *   Trend Health (30), Contraction Quality (40), Volume Signature (20),
 *   Pivot Structure (15), Catalyst Awareness (15)
 */

// ---------------------------------------------------------------------------
// 1. Trend Health (0-30 pts)
// ---------------------------------------------------------------------------

/**
 * 50-day MA slope over a short lookback window.
 * @param {Array} bars - OHLCV array
 * @param {number} maPeriod - MA period (default 50)
 * @param {number} lookback - Slope window (default 5)
 * @returns {{ ma50Slope: number, ma50SlopePositive: boolean }}
 */
export function calc50MASlope(bars, maPeriod = 50, lookback = 5) {
  if (bars.length < maPeriod + lookback) return { ma50Slope: 0, ma50SlopePositive: false };

  function sma(arr, end, period) {
    const slice = arr.slice(end - period, end);
    return slice.reduce((s, b) => s + b.close, 0) / period;
  }

  const maCurrent = sma(bars, bars.length, maPeriod);
  const maPast = sma(bars, bars.length - lookback, maPeriod);

  const ma50Slope = maPast > 0 ? Math.round(((maCurrent - maPast) / maPast) * 10000) / 10000 : 0;
  const ma50SlopePositive = ma50Slope > 0;

  return { ma50Slope, ma50SlopePositive };
}

/**
 * @param {{ price: number, ma50: number, ma150: number, ma200: number, high52w: number, relStrengthPctile: number, ohlcv: Array<{high:number, low:number}> }} d
 * @param {{ spyOhlcv?: Array, qqqOhlcv?: Array }} context
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', rsSubtotal: number, trendSubtotal: number, ma50Slope: number }}
 */
export function scoreTrendHealth(d, context = {}) {
  const bars = d.ohlcv || [];
  if (bars.length < 5) return { score: 0, confidence: 'low', rsSubtotal: 0, trendSubtotal: 0, ma50Slope: 0 };

  const confidence = bars.length >= 20 ? 'high' : 'medium';
  let trendSubtotal = 0;
  let rsSubtotal = 0;

  // --- Trend signals (21 pts max) ---
  // MA stacking: 8 pts
  if (d.ma50 > d.ma150 && d.ma150 > d.ma200) trendSubtotal += 8;

  // Price above 50-day MA: 5 pts
  if (d.price > d.ma50) trendSubtotal += 5;

  // Within 25% of 52-week high: 2 pts (reduced from 4 in v3.1)
  if (d.high52w > 0 && d.price >= d.high52w * 0.75) trendSubtotal += 2;

  // Higher highs + higher lows over last 20 days: 4 pts
  const recent = bars.slice(-20);
  if (recent.length >= 10) {
    const firstHalf = recent.slice(0, Math.floor(recent.length / 2));
    const secondHalf = recent.slice(Math.floor(recent.length / 2));
    const fhHigh = Math.max(...firstHalf.map(b => b.high));
    const shHigh = Math.max(...secondHalf.map(b => b.high));
    const fhLow = Math.min(...firstHalf.map(b => b.low));
    const shLow = Math.min(...secondHalf.map(b => b.low));
    if (shHigh > fhHigh && shLow > fhLow) trendSubtotal += 4;
  }

  // 50 MA slope positive: 2 pts (v3.1)
  const { ma50Slope, ma50SlopePositive } = calc50MASlope(bars);
  if (ma50SlopePositive) trendSubtotal += 2;

  // --- RS signals (9 pts max) ---
  if (context.spyOhlcv && context.qqqOhlcv) {
    const rs = calcRSvsIndex(bars, context.spyOhlcv, context.qqqOhlcv);

    // RS vs index ratio > 1.0: 4 pts
    if (rs.rsRatio20d > 1.05) rsSubtotal += 4;
    else if (rs.rsRatio20d > 1.0) rsSubtotal += 2;

    // RS trending upward: 3 pts
    if (rs.rsTrending) rsSubtotal += 3;

    // Outperforming on pullbacks: 2 pts
    if (rs.outperformingOnPullbacks) rsSubtotal += 2;

    // Penalty: underperforming both windows by > 10%
    if (rs.rsRatio20d < 0.9 && rs.rsRatio40d < 0.9) {
      rsSubtotal = Math.max(0, rsSubtotal - 3);
    }
  } else {
    // Fallback: use Yahoo relStrengthPctile when no index data available
    if ((d.relStrengthPctile || 0) >= 70) rsSubtotal += 5;
    else if ((d.relStrengthPctile || 0) >= 50) rsSubtotal += 3;
  }

  const score = Math.max(0, trendSubtotal + rsSubtotal);

  return { score, confidence, rsSubtotal, trendSubtotal, ma50Slope };
}

// ---------------------------------------------------------------------------
// 2. Contraction Quality (0-40 pts)
// ---------------------------------------------------------------------------

/**
 * Calculate ATR (Average True Range) from OHLCV bars.
 * @param {Array<{high:number, low:number, close:number}>} bars
 * @param {number} period
 * @returns {number}
 */
function calcATR(bars, period) {
  if (bars.length < period + 1) return 0;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * ATR percentile rank vs historical ATR values.
 * @param {Array} bars - OHLCV array
 * @param {number} period - ATR period (default 14)
 * @param {number} lookback - Historical window to rank against (default 252)
 * @returns {{ atrPercentile: number }}
 */
export function calcATRPercentile(bars, period = 14, lookback = 252) {
  if (bars.length < period + 1) return { atrPercentile: 50 };

  const usableBars = Math.min(bars.length, lookback);
  const atrValues = [];
  for (let end = period + 1; end <= usableBars; end++) {
    const slice = bars.slice(end - period - 1, end);
    atrValues.push(calcATR(slice, period));
  }

  const currentATR = atrValues[atrValues.length - 1];
  const belowCount = atrValues.filter(v => v < currentATR).length;
  const atrPercentile = Math.round((belowCount / atrValues.length) * 100);

  return { atrPercentile };
}

/**
 * Standard deviation contraction rate across 3 time windows.
 * @param {Array} bars - OHLCV array
 * @param {number[]} windows - Time windows to compare (default [10, 20, 40])
 * @returns {{ ratio: number, isContracting: boolean }}
 */
export function calcStdDevContractionRate(bars, windows = [10, 20, 40]) {
  const maxWindow = Math.max(...windows);
  if (bars.length < maxWindow) return { ratio: 1, isContracting: false };

  function stddev(arr) {
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
  }

  const closes = bars.map(b => b.close);
  const stds = windows.map(w => stddev(closes.slice(-w)));

  const isContracting = stds[0] < stds[1] && stds[1] < stds[2];
  const ratio = stds[2] > 0 ? Math.round((stds[0] / stds[2]) * 100) / 100 : 1;

  return { ratio, isContracting };
}

/**
 * Parkinson volatility using high-low range. More sensitive to intraday compression
 * than close-to-close measures.
 * Returns ratio of rolling 10-bar mean PV to 20-bar mean PV.
 * @param {Array} bars - OHLCV array
 * @param {number} period - Full lookback period (default 20)
 * @returns {{ parkinsonVol: number, parkinsonRatio: number }}
 */
export function calcParkinsonVolatility(bars, period = 20) {
  if (bars.length < period) return { parkinsonVol: 0, parkinsonRatio: 1 };

  const LN2x4 = 4 * Math.LN2;
  function pvBar(bar) {
    if (bar.low <= 0 || bar.high <= 0) return 0;
    const logHL = Math.log(bar.high / bar.low);
    return (logHL * logHL) / LN2x4;
  }

  const recent = bars.slice(-period);
  const pvValues = recent.map(pvBar);

  const avgPV20 = pvValues.reduce((s, v) => s + v, 0) / pvValues.length;
  const avgPV10 = pvValues.slice(-10).reduce((s, v) => s + v, 0) / 10;

  const parkinsonVol = Math.round(Math.sqrt(avgPV20) * 10000) / 10000;
  const parkinsonRatio = avgPV20 > 0 ? Math.round((avgPV10 / avgPV20) * 1000) / 1000 : 1;

  return { parkinsonVol, parkinsonRatio };
}

/**
 * Calculate Bollinger Band width from OHLCV bars.
 * @param {Array<{close:number}>} bars
 * @param {number} period
 * @returns {number} BB width as percentage of basis
 */
function calcBBWidth(bars, period) {
  if (bars.length < period) return 0;
  const closes = bars.slice(-period).map((b) => b.close);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + (b - mean) ** 2, 0) / closes.length;
  const stddev = Math.sqrt(variance);
  return mean > 0 ? (stddev * 2 * 2) / mean * 100 : 0; // 2 std devs * 2 bands / basis
}

/**
 * Enhanced VCP (Volatility Contraction Pattern) detection.
 * Uses 5-bar pivots and allows one non-declining depth.
 * @param {Array} bars - OHLCV array
 * @returns {{ contractions: number, depths: number[], vcpQuality: number }}
 */
export function detectVCP(bars) {
  if (bars.length < 15) return { contractions: 0, depths: [], vcpQuality: 0 };

  // Find 5-bar swing highs (high > 2 bars on each side)
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].high > bars[i-1].high && bars[i].high > bars[i-2].high &&
        bars[i].high > bars[i+1].high && bars[i].high > bars[i+2].high) {
      swingHighs.push({ idx: i, price: bars[i].high });
    }
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push({ idx: i, price: bars[i].low });
    }
  }

  // Calculate pullback depths: from each swing high to the next swing low after it
  const depths = [];
  for (const sh of swingHighs) {
    const nextLow = swingLows.find(sl => sl.idx > sh.idx);
    if (nextLow) {
      const depth = ((sh.price - nextLow.price) / sh.price) * 100;
      depths.push(Math.round(depth * 10) / 10);
    }
  }

  if (depths.length < 2) return { contractions: 0, depths, vcpQuality: 0 };

  // Count contractions allowing one non-declining depth
  let contractions = 0;
  let wobbles = 0;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i] < depths[i - 1]) {
      contractions++;
    } else if (wobbles === 0) {
      wobbles++;
      contractions++;
    } else {
      break;
    }
  }

  // vcpQuality: 0-1 based on how clean the tightening is
  const avgDeclineRate = depths.length >= 2
    ? depths.slice(0, -1).reduce((sum, d, i) => sum + (d - depths[i + 1]), 0) / (depths.length - 1)
    : 0;
  const vcpQuality = Math.min(1, Math.max(0, (contractions / 5) * (1 - wobbles * 0.2) * Math.min(1, avgDeclineRate / 3)));

  return { contractions, depths, vcpQuality };
}

/**
 * Relative strength vs SPY and QQQ benchmarks.
 * Takes the stronger (higher) reading of the two indices.
 * @param {Array} candidateBars - Candidate OHLCV
 * @param {Array} spyBars - SPY OHLCV
 * @param {Array} qqqBars - QQQ OHLCV
 * @param {number[]} windows - Rolling return windows (default [20, 40])
 * @returns {{ rsRatio20d: number, rsRatio40d: number, rsTrending: boolean, rsNearHigh: boolean, outperformingOnPullbacks: boolean }}
 */
export function calcRSvsIndex(candidateBars, spyBars, qqqBars, windows = [20, 40]) {
  if (candidateBars.length < windows[1] || spyBars.length < windows[1] || qqqBars.length < windows[1]) {
    return { rsRatio20d: 1, rsRatio40d: 1, rsTrending: false, rsNearHigh: false, outperformingOnPullbacks: false };
  }

  function rollingReturn(bars, w) {
    const end = bars[bars.length - 1].close;
    const start = bars[bars.length - 1 - w].close;
    return start > 0 ? (end - start) / start : 0;
  }

  function rsRatio(candidateReturn, indexReturn) {
    if (Math.abs(indexReturn) < 0.001) return 1 + candidateReturn;
    return (1 + candidateReturn) / (1 + indexReturn);
  }

  const ratios = {};
  for (const w of windows) {
    const candRet = rollingReturn(candidateBars, w);
    const spyRet = rollingReturn(spyBars, w);
    const qqqRet = rollingReturn(qqqBars, w);
    const vsSpy = rsRatio(candRet, spyRet);
    const vsQqq = rsRatio(candRet, qqqRet);
    ratios[w] = Math.max(vsSpy, vsQqq);
  }

  const rsRatio20d = Math.round(ratios[windows[0]] * 1000) / 1000;
  const rsRatio40d = Math.round(ratios[windows[1]] * 1000) / 1000;
  const rsTrending = rsRatio20d > rsRatio40d;

  // RS near high: current 20d ratio within 5% of max ratio computed at several points
  const rsNearHigh = true; // simplified: if trending, near high

  // Outperforming on pullbacks
  const minLen = Math.min(candidateBars.length, spyBars.length, 40);
  let candPullbackReturn = 0;
  let pullbackDays = 0;
  for (let i = candidateBars.length - minLen + 1; i < candidateBars.length; i++) {
    const spyIdx = spyBars.length - (candidateBars.length - i);
    if (spyIdx > 0 && spyBars[spyIdx].close < spyBars[spyIdx - 1].close) {
      const candDayReturn = (candidateBars[i].close - candidateBars[i - 1].close) / candidateBars[i - 1].close;
      candPullbackReturn += candDayReturn;
      pullbackDays++;
    }
  }
  const outperformingOnPullbacks = pullbackDays > 0 ? (candPullbackReturn / pullbackDays) > -0.005 : false;

  return { rsRatio20d, rsRatio40d, rsTrending, rsNearHigh, outperformingOnPullbacks };
}

/**
 * @param {{ ohlcv: Array<{open:number, high:number, low:number, close:number, volume:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', bbWidthPctile: number, atrRatio: number, vcpContractions: number, vcpDepths: number[], dailyRangePct: number, atrPercentile: number, confirmingSignals: number, vcpQuality: number }}
 */
export function scoreContractionQuality(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 20) return { score: 0, confidence: 'low', bbWidthPctile: 0, atrRatio: 1, vcpContractions: 0, vcpDepths: [], dailyRangePct: 0, atrPercentile: 50, confirmingSignals: 0, vcpQuality: 0 };

  let score = 0;
  const confidence = bars.length >= 40 ? 'high' : 'medium';

  // 1. BB Width Percentile (0-10 pts)
  const bbw = calcBBWidth(bars, 20);
  const bbWindows = [];
  for (let i = 20; i <= bars.length; i++) {
    bbWindows.push(calcBBWidth(bars.slice(i - 20, i), 20));
  }
  const bbBelow = bbWindows.filter(w => w < bbw).length;
  const bbWidthPctile = bbWindows.length > 0 ? Math.round((bbBelow / bbWindows.length) * 100) : 50;
  let bbPts = 0;
  if (bbWidthPctile <= 20) bbPts = 10;
  else if (bbWidthPctile <= 30) bbPts = 6;

  // 2. ATR Ratio fast/slow (0-8 pts)
  const atrFast = calcATR(bars.slice(-5), 5);
  const atrSlow = calcATR(bars.slice(-20), 20);
  const atrRatio = atrSlow > 0 ? Math.round((atrFast / atrSlow) * 100) / 100 : 1;
  let atrRatioPts = 0;
  if (atrRatio < 0.5) atrRatioPts = 8;
  else if (atrRatio < 0.7) atrRatioPts = 5;

  // 3. VCP Tightening (0-10 pts)
  const vcp = detectVCP(bars);
  let vcpPts = 0;
  if (vcp.contractions >= 3) vcpPts = 10;
  else if (vcp.contractions >= 2) vcpPts = 6;

  // 4. Tight Daily Range (0-6 pts)
  const last5 = bars.slice(-5);
  const avgRange = last5.reduce((s, b) => s + (b.high - b.low) / b.close * 100, 0) / last5.length;
  const dailyRangePct = Math.round(avgRange * 100) / 100;
  let rangePts = 0;
  if (dailyRangePct < 3) rangePts = 6;
  else if (dailyRangePct < 5) rangePts = 3;

  // 5. ATR Percentile vs 1yr (0-6 pts)
  const { atrPercentile } = calcATRPercentile(bars);
  let atrPctilePts = 0;
  if (atrPercentile <= 15) atrPctilePts = 6;
  else if (atrPercentile <= 25) atrPctilePts = 4;

  // 6. StdDev Contraction (gate only, no points)
  const { isContracting } = calcStdDevContractionRate(bars);

  // 7. Parkinson volatility (gate only, no points)
  const { parkinsonRatio } = calcParkinsonVolatility(bars);

  // --- Tiered confirmation gate ---
  // Primary: direct volatility compression measures
  let primaryConfirming = 0;
  if (atrPercentile <= 25) primaryConfirming++;
  if (bbWidthPctile <= 30) primaryConfirming++;
  if (atrRatio < 0.7) primaryConfirming++;
  if (parkinsonRatio < 0.75) primaryConfirming++;

  // Secondary: structural confirmation
  let secondaryConfirming = 0;
  if (isContracting) secondaryConfirming++;
  if (vcp.contractions >= 2) secondaryConfirming++;

  const totalConfirming = primaryConfirming + secondaryConfirming;

  score = bbPts + atrRatioPts + vcpPts + rangePts + atrPctilePts;

  // Unlock: 2+ primary OR 3+ total with at least 1 primary
  const gateUnlocked = primaryConfirming >= 2 || (totalConfirming >= 3 && primaryConfirming >= 1);
  if (!gateUnlocked) {
    score = Math.min(score, 15);
  }

  return {
    score,
    confidence,
    bbWidthPctile,
    atrRatio,
    vcpContractions: vcp.contractions,
    vcpDepths: vcp.depths,
    vcpQuality: vcp.vcpQuality,
    dailyRangePct,
    atrPercentile,
    confirmingSignals: totalConfirming,  // backward compat
    primaryConfirming,
    totalConfirming,
    parkinsonRatio
  };
}

// ---------------------------------------------------------------------------
// 3. Volume Signature (0-20 pts) — helpers
// ---------------------------------------------------------------------------

/**
 * Accumulation/Distribution score — measures whether up-days on above-avg
 * volume dominate down-days on below-avg volume (classic institutional footprint).
 * @param {Array<{open:number, close:number, volume:number}>} bars
 * @param {number} [period] — defaults to bars.length (use full history)
 * @returns {{ accDistScore: number }}
 */
export function calcAccumulationScore(bars, period) {
  const lookback = period || bars.length;
  if (bars.length < lookback) return { accDistScore: 0 };

  const recent = bars.slice(-lookback);
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;

  let weightedUp = 0;
  let weightedDown = 0;

  for (const bar of recent) {
    if (bar.close > bar.open && bar.volume > avgVol * 1.2) {
      weightedUp += bar.volume / avgVol;
    } else if (bar.close < bar.open && bar.volume < avgVol * 0.8) {
      weightedDown += bar.volume / avgVol;
    }
  }

  const accDistScore = weightedDown > 0
    ? Math.round((weightedUp / weightedDown) * 100) / 100
    : weightedUp > 0 ? 3 : 0;

  return { accDistScore };
}

/**
 * On-Balance Volume trend slope — linear regression of OBV over the period,
 * plus a normalised version for cross-stock comparison.
 * @param {Array<{close:number, volume:number}>} bars
 * @param {number} [period=20]
 * @returns {{ obvSlope: number, obvSlopeNormalized: number }}
 */
export function calcOBVTrendSlope(bars, period = 20) {
  if (bars.length < period) return { obvSlope: 0, obvSlopeNormalized: 0 };

  const recent = bars.slice(-period);
  const obv = [0];
  for (let i = 1; i < recent.length; i++) {
    const change = recent[i].close > recent[i - 1].close ? recent[i].volume
      : recent[i].close < recent[i - 1].close ? -recent[i].volume : 0;
    obv.push(obv[obv.length - 1] + change);
  }

  const n = obv.length;
  const xMean = (n - 1) / 2;
  const yMean = obv.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (obv[i] - yMean);
    den += (i - xMean) ** 2;
  }
  const obvSlope = den > 0 ? Math.round(num / den) : 0;

  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / n;
  const obvSlopeNormalized = avgVol > 0 ? Math.round((obvSlope / avgVol) * 10000) / 10000 : 0;

  return { obvSlope, obvSlopeNormalized };
}

/**
 * Volume clustering at support — compares average volume on bars near
 * rolling lows vs overall average volume. Ratio > 1 means institutions
 * are buying the dips.
 * @param {Array<{low:number, volume:number}>} bars
 * @param {number} [period=20]
 * @returns {{ supportVolumeRatio: number }}
 */
export function calcVolumeClustering(bars, period = 20) {
  if (bars.length < period) return { supportVolumeRatio: 1 };

  const recent = bars.slice(-period);
  const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;

  const supportBars = [];
  for (let i = 10; i < recent.length; i++) {
    const rollingLow = Math.min(...recent.slice(i - 10, i).map(b => b.low));
    if (recent[i].low <= rollingLow * 1.02) {
      supportBars.push(recent[i]);
    }
  }

  if (supportBars.length === 0) return { supportVolumeRatio: 1 };

  const supportAvgVol = supportBars.reduce((s, b) => s + b.volume, 0) / supportBars.length;
  const supportVolumeRatio = avgVol > 0 ? Math.round((supportAvgVol / avgVol) * 100) / 100 : 1;

  return { supportVolumeRatio };
}

// ---------------------------------------------------------------------------
// 3. Volume Signature (0-20 pts) — scorer
// ---------------------------------------------------------------------------

/**
 * @param {{ avgVol10d?: number, avgVol3mo?: number, ohlcv: Array<{open:number, close:number, volume:number, low:number, high:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', volDroughtRatio: number, accDistScore: number, upDownVolRatio: number, obvSlopeNormalized: number, supportVolumeRatio: number }}
 */
export function scoreVolumeSignature(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 10) return { score: 0, confidence: 'low', volDroughtRatio: 1, accDistScore: 0, upDownVolRatio: 1, obvSlopeNormalized: 0, supportVolumeRatio: 1 };

  const confidence = bars.length >= 20 ? 'high' : 'medium';
  let score = 0;

  // 1. Volume drought (0-5 pts)
  const avg10d = (d.avgVol10d || bars.slice(-10).reduce((s, b) => s + b.volume, 0) / 10);
  const avg3mo = (d.avgVol3mo || bars.reduce((s, b) => s + b.volume, 0) / bars.length);
  const volDroughtRatio = avg3mo > 0 ? Math.round((avg10d / avg3mo) * 100) / 100 : 1;
  if (volDroughtRatio < 0.7) score += 5;
  else if (volDroughtRatio < 0.85) score += 3;

  // 2. Accumulation/Distribution score (0-5 pts)
  const { accDistScore } = calcAccumulationScore(bars);
  if (accDistScore >= 2.0) score += 5;
  else if (accDistScore >= 1.3) score += 3;

  // 3. Up/down volume ratio (0-3 pts)
  const recent20 = bars.slice(-20);
  let upVol = 0, downVol = 0;
  for (const b of recent20) {
    if (b.close > b.open) upVol += b.volume;
    else downVol += b.volume;
  }
  const upDownVolRatio = downVol > 0 ? Math.round((upVol / downVol) * 100) / 100 : upVol > 0 ? 3 : 1;
  if (upDownVolRatio > 1.5) score += 3;
  else if (upDownVolRatio > 1.2) score += 2;

  // 4. Volume on higher lows (0-3 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push({ idx: i, low: bars[i].low, vol: bars[i].volume });
    }
  }
  if (swingLows.length >= 2) {
    const last2 = swingLows.slice(-2);
    if (last2[1].low > last2[0].low && last2[1].vol > last2[0].vol) score += 3;
  }

  // 5. OBV trend slope (0-2 pts)
  const { obvSlopeNormalized } = calcOBVTrendSlope(bars);
  if (obvSlopeNormalized > 0.5) score += 2;
  else if (obvSlopeNormalized > 0.1) score += 1;

  // 6. Volume clustering at support (0-2 pts)
  const { supportVolumeRatio } = calcVolumeClustering(bars);
  if (supportVolumeRatio > 1.3) score += 2;
  else if (supportVolumeRatio > 1.1) score += 1;

  return {
    score,
    confidence,
    volDroughtRatio,
    accDistScore,
    upDownVolRatio,
    obvSlopeNormalized,
    supportVolumeRatio
  };
}

// ---------------------------------------------------------------------------
// Resistance helpers
// ---------------------------------------------------------------------------

/**
 * Multi-window resistance detection.
 * Finds the highest close across 20/40/60-day windows, clusters nearby levels,
 * and counts how many times price touched that zone.
 *
 * @param {Array<{close:number}>} bars
 * @param {number[]} windows
 * @returns {{ resistancePrice: number, resistanceStrength: number, resistanceTouches: number }}
 */
export function calcResistanceLevel(bars, windows = [20, 40, 60]) {
  if (bars.length < 20) return { resistancePrice: 0, resistanceStrength: 0, resistanceTouches: 0 };

  const levels = [];
  for (const w of windows) {
    const slice = bars.slice(-Math.min(w, bars.length));
    const highClose = Math.max(...slice.map(b => b.close));
    levels.push(highClose);
  }

  const primary = levels[0];
  let strength = 1;
  for (let i = 1; i < levels.length; i++) {
    if (Math.abs(levels[i] - primary) / primary <= 0.015) {
      strength++;
    }
  }

  const clustered = levels.filter(l => Math.abs(l - primary) / primary <= 0.015);
  const resistancePrice = Math.round((clustered.reduce((s, v) => s + v, 0) / clustered.length) * 100) / 100;

  const lookback = bars.slice(-Math.min(60, bars.length));
  const resistanceTouches = lookback.filter(b => Math.abs(b.close - resistancePrice) / resistancePrice <= 0.015).length;

  return { resistancePrice, resistanceStrength: Math.min(strength, 3), resistanceTouches };
}

/**
 * Detect whether a large gap (>5%) formed near the resistance price.
 *
 * @param {Array<{open:number, close:number}>} bars
 * @param {number} resistancePrice
 * @returns {{ gapFormedResistance: boolean }}
 */
export function detectGapNearResistance(bars, resistancePrice) {
  if (bars.length < 2 || resistancePrice <= 0) return { gapFormedResistance: false };

  const recent = bars.slice(-20);
  for (let i = 1; i < recent.length; i++) {
    const gapPct = Math.abs(recent[i].open - recent[i - 1].close) / recent[i - 1].close * 100;
    const nearResistance = Math.abs(recent[i].close - resistancePrice) / resistancePrice <= 0.03;
    if (gapPct > 5 && nearResistance) {
      return { gapFormedResistance: true };
    }
  }
  return { gapFormedResistance: false };
}

// ---------------------------------------------------------------------------
// 4. Pivot Structure (0-15 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ price: number, ma50: number, ohlcv: Array<{high:number, low:number, close:number, open:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', distFromResistance: number, resistanceTouches: number, resistanceStrength: number, resistancePrice: number, closePosAvg: number, extendedAbove50ma: boolean, gapFormedResistance: boolean }}
 */
export function scorePivotStructure(d) {
  const bars = d.ohlcv || [];
  if (bars.length < 20) return { score: 0, confidence: 'low', distFromResistance: 100, resistanceTouches: 0, resistanceStrength: 0, extendedAbove50ma: false, gapFormedResistance: false, resistancePrice: 0, closePosAvg: 0 };

  const confidence = bars.length >= 40 ? 'high' : 'medium';
  let score = 0;

  // Multi-window resistance detection
  const res = calcResistanceLevel(bars);
  const { resistancePrice, resistanceTouches } = res;
  let { resistanceStrength } = res;

  // Gap-formed resistance check
  const { gapFormedResistance } = detectGapNearResistance(bars, resistancePrice);
  if (gapFormedResistance) resistanceStrength = Math.min(resistanceStrength, 1);

  // 1. Distance from confirmed resistance (max 6 pts, penalty for >12%)
  const distFromResistance = resistancePrice > 0
    ? Math.round((resistancePrice - d.price) / resistancePrice * 100 * 10) / 10
    : 100;
  if (distFromResistance >= 2 && distFromResistance <= 5) score += 6;       // ideal pre-breakout zone
  else if (distFromResistance >= 0 && distFromResistance < 2) score += 4;   // too close
  else if (distFromResistance > 5 && distFromResistance <= 8) score += 4;   // constructive
  else if (distFromResistance > 8 && distFromResistance <= 12) score += 1;  // far
  else if (distFromResistance > 12) score -= 2;                             // penalty

  // 2. Resistance strength (0-4 pts)
  if (resistanceStrength >= 3) score += 4;
  else if (resistanceStrength >= 2) score += 3;
  else if (resistanceStrength >= 1) score += 1;

  // 3. Tight closes near highs (0-3 pts)
  const last5 = bars.slice(-5);
  const closePositions = last5.map(b => {
    const range = b.high - b.low;
    return range > 0 ? (b.close - b.low) / range : 0.5;
  });
  const closePosAvg = closePositions.reduce((s, v) => s + v, 0) / closePositions.length;
  if (closePosAvg > 0.7) score += 3;

  // 4. Higher swing lows (0-2 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i-1].low && bars[i].low < bars[i-2].low &&
        bars[i].low < bars[i+1].low && bars[i].low < bars[i+2].low) {
      swingLows.push(bars[i].low);
    }
  }
  const last3Lows = swingLows.slice(-3);
  if (last3Lows.length >= 3 && last3Lows[2] > last3Lows[1] && last3Lows[1] > last3Lows[0]) score += 2;

  // --- Penalties (stacking, floor at 0) ---
  const extendedAbove50ma = d.ma50 > 0 && ((d.price - d.ma50) / d.ma50 * 100) > 10;
  if (extendedAbove50ma) score -= 5;

  // Recent gap > 8% in last 10 bars
  const last10 = bars.slice(-10);
  let hasLargeGap = false;
  for (let i = 1; i < last10.length; i++) {
    if (Math.abs(last10[i].open - last10[i-1].close) / last10[i-1].close * 100 > 8) {
      hasLargeGap = true;
      break;
    }
  }
  if (hasLargeGap) score -= 3;

  // ATR expanding rapidly
  if (bars.length >= 20) {
    const currentATR = calcATR(bars.slice(-5), 5);
    const avgATR = calcATR(bars.slice(-20), 20);
    if (avgATR > 0 && currentATR > avgATR * 1.5) score -= 2;
  }

  score = Math.max(0, score);

  return {
    score,
    confidence,
    distFromResistance,
    resistanceTouches,
    resistanceStrength,
    resistancePrice,
    closePosAvg: Math.round(closePosAvg * 100) / 100,
    extendedAbove50ma,
    gapFormedResistance
  };
}

// ---------------------------------------------------------------------------
// 5. Catalyst Awareness (0-15 pts)
// ---------------------------------------------------------------------------

const SECTOR_ETF_MAP = {
  XLK: 'Technology', XLF: 'Financial Services', XLV: 'Healthcare',
  XLE: 'Energy', XLI: 'Industrials', XLY: 'Consumer Cyclical',
  XLP: 'Consumer Defensive', XLU: 'Utilities', XLB: 'Basic Materials',
  XLRE: 'Real Estate', XLC: 'Communication Services'
};

const CATALYST_PATTERNS = {
  earnings_catalyst: [
    /upgrade/i, /beat/i, /raised guidance/i, /above estimates/i,
    /price target raised/i, /revenue growth/i
  ],
  merger_catalyst: [
    /merger/i, /acquisition/i, /buyout/i, /spin-off/i,
    /activist/i, /strategic review/i
  ],
  product_catalyst: [
    /FDA approval/i, /phase 3/i, /\blaunch\b/i, /patent/i,
    /contract win/i, /new product/i
  ]
};

/**
 * Rank sectors 1-N by 20-day return using sector ETF bar data.
 * @param {Record<string, Array<{close: number}>>} sectorETFData — keyed by ETF ticker (e.g. XLK)
 * @returns {Record<string, number>} — sector name → rank (1 = strongest)
 */
export function calcSectorMomentumRank(sectorETFData) {
  const returns = [];
  for (const [etf, bars] of Object.entries(sectorETFData)) {
    if (bars.length < 20) continue;
    const ret = (bars[bars.length - 1].close - bars[bars.length - 21].close) / bars[bars.length - 21].close;
    const sector = SECTOR_ETF_MAP[etf] || etf;
    returns.push({ sector, ret });
  }

  returns.sort((a, b) => b.ret - a.ret);

  const ranks = {};
  returns.forEach((item, idx) => {
    ranks[item.sector] = idx + 1;
  });

  return ranks;
}

/**
 * Match news headlines against categorized catalyst patterns.
 * Deduplicates by catalyst type — returns at most one entry per type.
 * @param {Array<{title: string, description?: string}>} news
 * @returns {Array<{catalystType: string, confidence: string, headline: string}>}
 */
export function matchCatalystKeywords(news) {
  if (!news || news.length === 0) return [];

  const found = new Map();

  for (const item of news) {
    const title = item.title || '';
    const description = item.description || '';
    const text = `${title} ${description}`;

    for (const [type, patterns] of Object.entries(CATALYST_PATTERNS)) {
      if (found.has(type)) continue;
      for (const pattern of patterns) {
        if (pattern.test(text)) {
          const confidence = pattern.test(title) ? 'strong' : 'weak';
          found.set(type, { catalystType: type, confidence, headline: title });
          break;
        }
      }
    }
  }

  return Array.from(found.values());
}

/**
 * @param {{ earningsTimestamp: number|null, news: Array<{title:string}>, shortPercentOfFloat: number|null }} d
 * @param {{ sectorRanks?: Record<string, number>, candidateSector?: string }} context
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', earningsDaysOut: number|null, sectorMomentumRank: number, shortFloat: number|null, catalystTag: string, catalysts: Array }}
 */
export function scoreCatalystAwareness(d, context = {}) {
  let score = 0;
  let confidence = 'high';

  // 1. Earnings timing (0-4 pts)
  let earningsDaysOut = null;
  if (d.earningsTimestamp) {
    earningsDaysOut = Math.round((d.earningsTimestamp - Date.now()) / 86_400_000);
    if (earningsDaysOut >= 30 && earningsDaysOut <= 45) score += 4;
    else if (earningsDaysOut > 0 && earningsDaysOut < 30) score += 2;
  } else {
    confidence = 'medium';
  }

  // 2. Categorized catalyst match (0-3 pts)
  const catalysts = matchCatalystKeywords(d.news || []);
  if (catalysts.some(c => c.confidence === 'strong')) score += 3;
  else if (catalysts.length > 0) score += 2;

  // Catalyst tag for output
  const catalystTag = catalysts.some(c => c.confidence === 'strong') || (earningsDaysOut && earningsDaysOut > 0 && earningsDaysOut <= 45)
    ? 'catalyst_present'
    : catalysts.length > 0 || (d.shortPercentOfFloat && d.shortPercentOfFloat > 10)
      ? 'catalyst_weak'
      : 'catalyst_unknown';

  // 3. Sector rank (0-4 pts)
  let sectorMomentumRank = 6; // default fallback
  if (context.sectorRanks && context.candidateSector) {
    sectorMomentumRank = context.sectorRanks[context.candidateSector] || 6;
  }
  if (sectorMomentumRank <= 3) score += 4;
  else if (sectorMomentumRank <= 5) score += 2;

  // 4. Short interest (0-2 pts)
  const shortFloat = d.shortPercentOfFloat || 0;
  if (shortFloat > 15) score += 2;
  else if (shortFloat > 10) score += 1;
  if (!d.shortPercentOfFloat) confidence = 'medium';

  return {
    score,
    confidence,
    earningsDaysOut,
    sectorMomentumRank,
    shortFloat,
    catalystTag,
    catalysts
  };
}

// ---------------------------------------------------------------------------
// Composite Score + Confidence + Breakout Risk + Classification
// ---------------------------------------------------------------------------

/**
 * Compute the composite score from all 5 category results.
 * @param {{ trend: {score:number, confidence:string}, contraction: {score:number, confidence:string, atrRatio:number, distFromResistance?:number}, volume: {score:number, confidence:string, upDownVolRatio:number}, pivot: {score:number, confidence:string, distFromResistance:number, extendedAbove50ma:boolean}, catalyst: {score:number, confidence:string, earningsDaysOut:number|null} }} cats
 * @param {{ regime: string, sectorRank: number }} context
 * @returns {{ score: number, signals: object, scoreConfidence: string, breakoutRisk: string, breakoutRiskDrivers: string[] }}
 */
export function computeCompositeScore(cats, context = {}) {
  const score = cats.trend.score + cats.contraction.score + cats.volume.score + cats.pivot.score + cats.catalyst.score;

  const signals = {
    trendHealth: cats.trend.score,
    contraction: cats.contraction.score,
    volumeSignature: cats.volume.score,
    pivotProximity: cats.pivot.score,
    catalystAwareness: cats.catalyst.score,
  };

  // Score confidence: weakest link
  const confidences = [cats.trend.confidence, cats.contraction.confidence, cats.volume.confidence, cats.pivot.confidence, cats.catalyst.confidence];
  let scoreConfidence = 'high';
  if (confidences.includes('low')) scoreConfidence = 'low';
  else if (confidences.includes('medium')) scoreConfidence = 'medium';

  // Breakout risk assessment (0-5 drivers)
  const breakoutRiskDrivers = [];
  if (cats.pivot.extendedAbove50ma) breakoutRiskDrivers.push('extended_above_ma');
  if (cats.contraction.atrRatio > 0.8 && cats.pivot.distFromResistance < 5) breakoutRiskDrivers.push('volatile_near_resistance');
  if (cats.volume.upDownVolRatio < 1.1) breakoutRiskDrivers.push('weak_accumulation');
  if (context.regime === 'cautious' || context.regime === 'defensive') breakoutRiskDrivers.push('weak_market_backdrop');
  if (cats.catalyst.earningsDaysOut != null && cats.catalyst.earningsDaysOut < 20 && cats.catalyst.earningsDaysOut > 0) breakoutRiskDrivers.push('imminent_earnings');

  const driverCount = breakoutRiskDrivers.length;
  const breakoutRisk = driverCount <= 1 ? 'low' : driverCount <= 3 ? 'medium' : 'high';

  return { score, signals, scoreConfidence, breakoutRisk, breakoutRiskDrivers };
}

/**
 * Classify a scored candidate.
 * @param {{ score: number, signals: object, distFromResistance: number }} candidate
 * @returns {string} 'coiled_spring' | 'building_base' | 'catalyst_loaded' | 'below_threshold'
 */
export function classifyCandidate(candidate) {
  const { score, signals, details } = candidate;
  const price = candidate.price || 0;
  const avgVol10d = candidate.avgVol10d || 0;

  // Priority 1: DISQUALIFIED
  if (price < 5 || avgVol10d < 200_000 || score < 30) return 'disqualified';

  // Priority 2: EXTENDED
  const extensionPct = details?.extensionPct || (details?.extendedAbove50ma ? 16 : 0);
  if (extensionPct > 15 || details?.hasLargeGap || details?.atrExpanding) return 'extended';

  // Priority 3: COILED_SPRING
  if (score >= 85 &&
      (signals?.contraction || 0) >= 30 &&
      (signals?.volumeSignature || 0) >= 10 &&
      (details?.distFromResistance || 100) <= 8) {
    return 'coiled_spring';
  }

  // Priority 4: CATALYST_LOADED
  if ((signals?.catalystAwareness || 0) >= 12 && (signals?.trendHealth || 0) >= 20) {
    return 'catalyst_loaded';
  }

  // Priority 5: BUILDING_BASE
  if (score >= 60 && (signals?.trendHealth || 0) >= 15) {
    return 'building_base';
  }

  return 'below_threshold';
}

/**
 * Generate a play recommendation.
 * @param {string} symbol
 * @param {string} classification
 * @param {{ ma50: number, distFromResistance: number, price: number }} details
 * @param {string} regime — market regime
 * @returns {string}
 */
export function generatePlay(symbol, classification, details, regime) {
  if (regime === 'defensive') {
    return `${symbol}: DEFENSIVE REGIME — no new entries. Watchlist only.`;
  }

  const watchOnly = regime === 'cautious' ? ' (reduced conviction — cautious regime)' : '';

  if (classification === 'coiled_spring') {
    const support = details.ma50 > 0 ? `$${details.ma50.toFixed(0)}` : 'rising 50-day MA';
    const resist = details.price > 0 && details.distFromResistance > 0
      ? `$${(details.price * (1 + details.distFromResistance / 100)).toFixed(0)}`
      : 'resistance';
    return `${symbol}: Sell CSP at support (${support}). If assigned, hold for breakout, sell CC at ${resist}.${watchOnly}`;
  }

  if (classification === 'catalyst_loaded') {
    return `${symbol}: Sell CSP 30-45 DTE into rising IV. Premium play — if assigned, own a trending stock at a discount.${watchOnly}`;
  }

  if (classification === 'building_base') {
    return `${symbol}: Watchlist. Set alert at 20-day high for breakout trigger. Do not enter yet.`;
  }

  return `${symbol}: Below threshold — no active play.`;
}

// ── Probability scoring layer ─────────────────────────────────────────

export const REGIME_MULTIPLIERS = { constructive: 1.0, cautious: 0.85, defensive: 0.70 };
const REGIME_ALIGNMENT = { constructive: 1.0, cautious: 0.5, defensive: 0.0 };

const CALM_WEIGHTS = {
  volatility_contraction: 0.22,
  relative_strength_trend: 0.22,
  volume_dry_up: 0.15,
  trend_quality: 0.14,
  distance_to_resistance: 0.10,
  catalyst_presence: 0.10,
  market_regime_alignment: 0.07
};

const STRESSED_WEIGHTS = {
  volatility_contraction: 0.28,
  relative_strength_trend: 0.18,
  volume_dry_up: 0.15,
  trend_quality: 0.16,
  distance_to_resistance: 0.10,
  catalyst_presence: 0.08,
  market_regime_alignment: 0.05
};

/**
 * Compute regime-adaptive factor weights via linear interpolation on VIX.
 * @param {number} vixLevel - Current VIX value
 * @returns {Object} - Factor weights summing to 1.0
 */
export function calcRegimeWeights(vixLevel) {
  const t = Math.max(0, Math.min(1, (vixLevel - 18) / (30 - 18)));

  const weights = {};
  for (const key of Object.keys(CALM_WEIGHTS)) {
    weights[key] = Math.round((CALM_WEIGHTS[key] + (STRESSED_WEIGHTS[key] - CALM_WEIGHTS[key]) * t) * 100) / 100;
  }

  return weights;
}

/**
 * Compute weighted probability score (0-100) from category signals.
 * @param {Object} signals - { trendHealth, contraction, volumeSignature, pivotProximity, catalystAwareness }
 * @param {Object} context - { regime: { regime: 'constructive'|'cautious'|'defensive', vixLevel: number } }
 * @returns {{ probability_score, setup_quality, trade_readiness, regime_multiplier, factor_breakdown }}
 */
export function computeProbabilityScore(signals, context = {}) {
  const regimeName = (context.regime && context.regime.regime) || 'constructive';
  const vixLevel = (context.regime && context.regime.vixLevel) || 20;

  // Normalize each category to 0-1
  const contractionNorm = (signals.contraction?.score || 0) / 40;
  const rsNorm = (signals.trendHealth?.rsSubtotal || 0) / 9;
  const volumeNorm = (signals.volumeSignature?.score || 0) / 20;
  const trendNorm = (signals.trendHealth?.trendSubtotal || 0) / 21;
  const resistanceNorm = (signals.pivotProximity?.score || 0) / 15;
  const catalystNorm = (signals.catalystAwareness?.score || 0) / 15;
  const regimeAlignment = REGIME_ALIGNMENT[regimeName] || 1.0;

  // Dynamic weights based on VIX
  const w = calcRegimeWeights(vixLevel);

  // Weighted raw probability
  const rawProb =
    (contractionNorm * w.volatility_contraction) +
    (rsNorm * w.relative_strength_trend) +
    (volumeNorm * w.volume_dry_up) +
    (trendNorm * w.trend_quality) +
    (resistanceNorm * w.distance_to_resistance) +
    (catalystNorm * w.catalyst_presence) +
    (regimeAlignment * w.market_regime_alignment);

  // Apply regime multiplier
  const regime_multiplier = REGIME_MULTIPLIERS[regimeName] || 1.0;
  const probability_score = Math.min(100, Math.round(rawProb * 100 * regime_multiplier));

  // Setup quality tier
  let setup_quality;
  if (probability_score >= 80) setup_quality = 'ELITE';
  else if (probability_score >= 65) setup_quality = 'HIGH';
  else if (probability_score >= 50) setup_quality = 'MODERATE';
  else setup_quality = 'LOW';

  const trade_readiness = probability_score >= 65;

  const factor_breakdown = {
    volatility_contraction: Math.round(contractionNorm * 1000) / 1000,
    relative_strength_trend: Math.round(rsNorm * 1000) / 1000,
    volume_dry_up: Math.round(volumeNorm * 1000) / 1000,
    trend_quality: Math.round(trendNorm * 1000) / 1000,
    distance_to_resistance: Math.round(resistanceNorm * 1000) / 1000,
    catalyst_presence: Math.round(catalystNorm * 1000) / 1000,
    market_regime_alignment: regimeAlignment
  };

  return { probability_score, setup_quality, trade_readiness, regime_multiplier, factor_breakdown };
}

/**
 * Calculate confidence band around probability score.
 * Band width adapts based on signal quality and market volatility.
 * Purely informational — does not affect ranking or classification.
 * @param {number} probabilityScore - The point estimate (0-100)
 * @param {Object} signals - Category signal objects with confidence fields
 * @param {Object} context - { regime: { vixLevel } }
 * @returns {{ low: number, mid: number, high: number }}
 */
export function calcConfidenceBand(probabilityScore, signals, context = {}) {
  let halfWidth = 5;

  // Collect confidence levels from all categories
  const categories = [
    signals.trendHealth,
    signals.contraction,
    signals.volumeSignature,
    signals.pivotProximity,
    signals.catalystAwareness
  ].filter(Boolean);

  const confidences = categories.map(c => c.confidence || 'medium');

  // All high confidence: narrow band
  if (confidences.length > 0 && confidences.every(c => c === 'high')) {
    halfWidth -= 2;
  }

  // Any low confidence: widen band
  if (confidences.some(c => c === 'low')) {
    halfWidth += 3;
  }

  // Few confirming signals: widen
  const confirmingSignals = signals.contraction?.totalConfirming || signals.contraction?.confirmingSignals || 0;
  if (confirmingSignals < 3) {
    halfWidth += 2;
  }

  // High confirming signals: narrow slightly
  if (confirmingSignals >= 5) {
    halfWidth -= 1;
  }

  // Elevated VIX: widen
  const vixLevel = (context.regime && context.regime.vixLevel) || 20;
  if (vixLevel >= 25) {
    halfWidth += 2;
  }

  // Clamp half-width to [3, 12]
  halfWidth = Math.max(3, Math.min(12, halfWidth));

  return {
    low: Math.max(0, Math.round(probabilityScore - halfWidth)),
    mid: Math.round(probabilityScore),
    high: Math.min(100, Math.round(probabilityScore + halfWidth))
  };
}

/**
 * Determine risk category and suggested stop-loss range based on classification.
 * High-ATR stocks get wider stops (+2% each side).
 */
export function calcRiskCategory(classification, details) {
  let risk_category, suggested_stop_percent;

  if (classification === 'coiled_spring' && (details.vcpContractions || 0) >= 3) {
    risk_category = 'tight_vcp';
    suggested_stop_percent = [3, 5];
  } else if (classification === 'coiled_spring') {
    risk_category = 'standard_coil';
    suggested_stop_percent = [5, 7];
  } else if (classification === 'catalyst_loaded') {
    risk_category = 'catalyst_play';
    suggested_stop_percent = [5, 8];
  } else if (classification === 'building_base') {
    risk_category = 'base_watch';
    suggested_stop_percent = [7, 10];
  } else {
    risk_category = 'no_trade';
    suggested_stop_percent = [0, 0];
  }

  if ((details.atrPercentile || 0) > 75) {
    suggested_stop_percent = [suggested_stop_percent[0] + 2, suggested_stop_percent[1] + 2];
  }

  return { risk_category, suggested_stop_percent };
}

/**
 * Generate a human-readable entry trigger string based on classification.
 */
export function calcEntryTrigger(classification, details) {
  const resistance = details.resistancePrice || 0;
  const ma50 = details.ma50 || 0;

  switch (classification) {
    case 'coiled_spring':
      return { entry_trigger: `break above ${resistance}` };
    case 'catalyst_loaded':
      return { entry_trigger: `break above ${resistance} or sell CSP at ${ma50}` };
    case 'building_base':
      return { entry_trigger: `watchlist — alert at ${resistance}` };
    default:
      return { entry_trigger: 'no entry' };
  }
}

/**
 * Auto-generate human-readable notes from signals and details.
 */
export function generateNotes(signals, details) {
  const notes = [];

  const contraction = signals.contraction || {};
  if ((contraction.vcpContractions || 0) >= 3) notes.push(`${contraction.vcpContractions}-stage VCP`);
  else if ((contraction.vcpContractions || 0) >= 2) notes.push('emerging VCP');
  if ((contraction.atrPercentile || 50) <= 15) notes.push('extreme contraction');

  if ((details.sectorMomentumRank || 6) <= 3) notes.push(`sector rank #${details.sectorMomentumRank}`);

  const catalyst = signals.catalystAwareness || {};
  if (catalyst.catalystTag === 'catalyst_present') {
    const types = (catalyst.catalysts || []).map(c => c.catalystType.replace('_catalyst', '')).join(', ');
    if (types) notes.push(`${types} catalyst present`);
  }

  if (details.earningsDaysOut && details.earningsDaysOut > 0 && details.earningsDaysOut <= 45) {
    notes.push(`earnings in ${details.earningsDaysOut} days`);
  }

  return notes.join(', ') || 'standard setup';
}
