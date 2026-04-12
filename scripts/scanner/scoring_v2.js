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
 * @param {{ price: number, ma50: number, ma150: number, ma200: number, high52w: number, relStrengthPctile: number, ohlcv: Array<{high:number, low:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low' }}
 */
export function scoreTrendHealth(d) {
  let pts = 0;
  let hasProxy = false;

  // 50 MA > 150 MA > 200 MA alignment (8 pts)
  if (d.ma50 > d.ma150 && d.ma150 > d.ma200 && d.ma200 > 0) {
    pts += 8;
  }

  // Price above 50-day MA (5 pts)
  if (d.ma50 > 0 && d.price > d.ma50) {
    pts += 5;
  }

  // Within 25% of 52-week high (5 pts)
  if (d.high52w > 0 && d.price >= d.high52w * 0.75) {
    pts += 5;
  }

  // Relative strength vs SPY (7 pts)
  if (d.relStrengthPctile >= 70) {
    pts += 7;
  } else if (d.relStrengthPctile >= 50) {
    pts += 4;
  }

  // Higher highs + higher lows over 20 days (5 pts)
  const bars = d.ohlcv || [];
  if (bars.length >= 20) {
    const recent10 = bars.slice(-10);
    const prior10 = bars.slice(-20, -10);
    const recentHigh = Math.max(...recent10.map((b) => b.high));
    const priorHigh = Math.max(...prior10.map((b) => b.high));
    const recentLow = Math.min(...recent10.map((b) => b.low));
    const priorLow = Math.min(...prior10.map((b) => b.low));
    if (recentHigh > priorHigh && recentLow > priorLow) {
      pts += 5;
    }
  } else {
    hasProxy = true; // insufficient data for HH/HL check
  }

  const confidence = hasProxy ? 'medium' : 'high';
  return { score: pts, confidence };
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
 * Detect VCP tightening: successive pullback depths from swing pivots.
 * Uses 3-bar pivot detection (simplified).
 * @param {Array<{high:number, low:number}>} bars
 * @returns {{ contractions: number, depths: number[] }}
 */
function detectVCP(bars) {
  if (bars.length < 15) return { contractions: 0, depths: [] };

  // Find swing highs and lows using 3-bar pivots
  const swingHighs = [];
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].high > bars[i - 1].high && bars[i].high > bars[i - 2].high &&
        bars[i].high > bars[i + 1].high && bars[i].high > bars[i + 2].high) {
      swingHighs.push({ idx: i, price: bars[i].high });
    }
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
        bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
      swingLows.push({ idx: i, price: bars[i].low });
    }
  }

  // Calculate pullback depths: from each swing high to the next swing low
  const depths = [];
  for (let i = 0; i < swingHighs.length; i++) {
    const nextLow = swingLows.find((sl) => sl.idx > swingHighs[i].idx);
    if (nextLow && swingHighs[i].price > 0) {
      const depth = ((swingHighs[i].price - nextLow.price) / swingHighs[i].price) * 100;
      depths.push(+depth.toFixed(1));
    }
  }

  // Count tightening contractions (each shallower than previous)
  let contractions = 0;
  for (let i = 1; i < depths.length; i++) {
    if (depths[i] < depths[i - 1]) {
      contractions++;
    } else {
      break; // must be monotonic
    }
  }

  return { contractions, depths };
}

/**
 * @param {{ ohlcv: Array<{open:number, high:number, low:number, close:number, volume:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', bbWidthPctile: number, atrRatio: number, vcpContractions: number, vcpDepths: number[], dailyRangePct: number }}
 */
export function scoreContractionQuality(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  if (bars.length < 20) {
    return { score: 0, confidence: 'low', bbWidthPctile: 0, atrRatio: 1, vcpContractions: 0, vcpDepths: [], dailyRangePct: 99 };
  }

  // BB Width percentile (12 pts)
  // Compare current BB width to range over all available bars
  const currentBBW = calcBBWidth(bars.slice(-20), 20);
  const allBBWs = [];
  for (let i = 20; i <= bars.length; i++) {
    allBBWs.push(calcBBWidth(bars.slice(i - 20, i), 20));
  }
  allBBWs.sort((a, b) => a - b);
  const bbRank = allBBWs.findIndex((w) => w >= currentBBW);
  const bbWidthPctile = allBBWs.length > 0 ? +(bbRank / allBBWs.length * 100).toFixed(1) : 50;

  if (bbWidthPctile <= 20) pts += 12;
  else if (bbWidthPctile <= 30) pts += 7;

  // ATR contraction ratio (10 pts)
  const atrFast = calcATR(bars, 5);
  const atrSlow = calcATR(bars, 20);
  const atrRatio = atrSlow > 0 ? +(atrFast / atrSlow).toFixed(2) : 1;

  if (atrRatio < 0.5) pts += 10;
  else if (atrRatio < 0.7) pts += 6;

  // VCP tightening (10 pts)
  const vcp = detectVCP(bars);
  if (vcp.contractions >= 3) pts += 10;
  else if (vcp.contractions >= 2) pts += 6;

  if (bars.length < 40) confidence = 'medium'; // less data for VCP detection

  // Tight daily range (8 pts)
  const recent5 = bars.slice(-5);
  const avgRange = recent5.reduce((sum, b) => sum + (b.high - b.low) / b.close * 100, 0) / recent5.length;
  const dailyRangePct = +avgRange.toFixed(2);

  if (dailyRangePct < 3) pts += 8;
  else if (dailyRangePct < 5) pts += 4;

  return {
    score: pts,
    confidence,
    bbWidthPctile,
    atrRatio,
    vcpContractions: vcp.contractions,
    vcpDepths: vcp.depths,
    dailyRangePct,
  };
}

// ---------------------------------------------------------------------------
// 3. Volume Signature (0-20 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ avgVol10d: number, avgVol3mo: number, ohlcv: Array<{open:number, close:number, volume:number, low:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', volDroughtRatio: number, accumulationDays: number, upDownVolRatio: number, volOnHigherLows: boolean }}
 */
export function scoreVolumeSignature(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  // Volume drought (6 pts)
  const droughtRatio = d.avgVol3mo > 0 ? +(d.avgVol10d / d.avgVol3mo).toFixed(2) : 1;
  if (droughtRatio < 0.7) pts += 6;
  else if (droughtRatio < 0.85) pts += 3;

  // Accumulation days in last 10 sessions (5 pts)
  const recent10 = bars.slice(-10);
  const avgVol = d.avgVol3mo || 0;
  let accumDays = 0;
  for (const b of recent10) {
    if (b.close > b.open && b.volume > avgVol) accumDays++;
  }
  if (accumDays >= 3) pts += 5;
  else if (accumDays >= 2) pts += 3;

  // Up-volume vs down-volume ratio over 20 sessions (5 pts)
  const recent20 = bars.slice(-20);
  let upVol = 0;
  let downVol = 0;
  for (const b of recent20) {
    if (b.close > b.open) upVol += b.volume;
    else downVol += b.volume;
  }
  const udRatio = downVol > 0 ? +(upVol / downVol).toFixed(2) : 0;
  if (udRatio > 1.5) pts += 5;
  else if (udRatio > 1.2) pts += 3;

  // Volume increases on higher lows (4 pts)
  // Find last 3 swing lows, check if volume increases at each
  let volOnHigherLows = false;
  if (bars.length >= 20) {
    const swingLows = [];
    for (let i = 2; i < bars.length - 2; i++) {
      if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
          bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
        swingLows.push({ price: bars[i].low, vol: bars[i].volume });
      }
    }
    const lastThree = swingLows.slice(-3);
    if (lastThree.length >= 2) {
      const pricesRising = lastThree.every((sl, i) => i === 0 || sl.price > lastThree[i - 1].price);
      const volRising = lastThree.every((sl, i) => i === 0 || sl.vol > lastThree[i - 1].vol);
      if (pricesRising && volRising) {
        volOnHigherLows = true;
        pts += 4;
      }
    }
  }

  if (bars.length < 20) confidence = 'medium';
  if (bars.length < 10) confidence = 'low';

  return {
    score: pts,
    confidence,
    volDroughtRatio: droughtRatio,
    accumulationDays: accumDays,
    upDownVolRatio: udRatio,
    volOnHigherLows,
  };
}

// ---------------------------------------------------------------------------
// 4. Pivot Structure (0-15 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ price: number, ma50: number, ohlcv: Array<{high:number, low:number, close:number}> }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', distFromResistance: number, resistanceTouches: number, closePosAvg: number, extendedAbove50ma: boolean }}
 */
export function scorePivotStructure(d) {
  const bars = d.ohlcv || [];
  let pts = 0;
  let confidence = 'high';

  if (bars.length < 20) {
    return { score: 0, confidence: 'low', distFromResistance: 99, resistanceTouches: 0, closePosAvg: 0, extendedAbove50ma: false };
  }

  const recent20 = bars.slice(-20);
  const resistance = Math.max(...recent20.map((b) => b.high));

  // Distance from resistance (6 pts)
  const distPct = resistance > 0 ? +((resistance - d.price) / resistance * 100).toFixed(1) : 99;
  if (distPct <= 3) pts += 6;
  else if (distPct <= 5) pts += 4;
  else if (distPct <= 8) pts += 2;

  // Resistance tested at least twice (4 pts)
  const touchZone = resistance * 0.99;
  let touches = 0;
  for (const b of recent20) {
    if (b.high >= touchZone) touches++;
  }
  if (touches >= 2) pts += 4;

  // Tight closes near highs of range (3 pts)
  const recent5 = bars.slice(-5);
  const closePosAvg = recent5.reduce((sum, b) => {
    const range = b.high - b.low;
    return sum + (range > 0.01 ? (b.close - b.low) / range : 0.5);
  }, 0) / recent5.length;

  if (closePosAvg > 0.7) pts += 3;

  // Higher lows structure (2 pts)
  const swingLows = [];
  for (let i = 2; i < bars.length - 2; i++) {
    if (bars[i].low < bars[i - 1].low && bars[i].low < bars[i - 2].low &&
        bars[i].low < bars[i + 1].low && bars[i].low < bars[i + 2].low) {
      swingLows.push(bars[i].low);
    }
  }
  const lastThreeLows = swingLows.slice(-3);
  if (lastThreeLows.length >= 2 && lastThreeLows.every((l, i) => i === 0 || l > lastThreeLows[i - 1])) {
    pts += 2;
  }

  // Penalty: extended > 10% above 50-day MA
  const extendedAbove50ma = d.ma50 > 0 && ((d.price - d.ma50) / d.ma50 * 100) > 10;
  if (extendedAbove50ma) pts = Math.max(pts - 5, 0);

  return {
    score: pts,
    confidence: bars.length < 40 ? 'medium' : confidence,
    distFromResistance: distPct,
    resistanceTouches: touches,
    closePosAvg: +closePosAvg.toFixed(2),
    extendedAbove50ma,
  };
}

// ---------------------------------------------------------------------------
// 5. Catalyst Awareness (0-15 pts)
// ---------------------------------------------------------------------------

/**
 * @param {{ earningsTimestamp: number|null, news: Array<{title:string}>, sectorRank: number, shortPercentOfFloat: number|null }} d
 * @returns {{ score: number, confidence: 'high'|'medium'|'low', earningsDaysOut: number|null, sectorMomentumRank: number, shortFloat: number|null }}
 */
export function scoreCatalystAwareness(d) {
  let pts = 0;
  let confidence = 'high';
  let earningsDaysOut = null;

  // Earnings within 30-45 days (5 pts)
  if (d.earningsTimestamp) {
    const now = Date.now() / 1000;
    const daysOut = Math.round((d.earningsTimestamp - now) / 86400);
    earningsDaysOut = daysOut;
    if (daysOut >= 30 && daysOut <= 45) pts += 5;
    else if (daysOut > 0 && daysOut < 30) pts += 2;
  } else {
    confidence = 'medium'; // no earnings date available
  }

  // Analyst upgrades or estimate revisions (3 pts)
  const upgradeKeywords = ['upgrade', 'buy rating', 'price target raised', 'guidance', 'estimate'];
  const newsText = (d.news || []).map((n) => n.title.toLowerCase()).join(' ');
  if (upgradeKeywords.some((kw) => newsText.includes(kw))) {
    pts += 3;
  }

  // Sector momentum tailwind (4 pts)
  const rank = d.sectorRank ?? 99;
  if (rank <= 3) pts += 4;
  else if (rank <= 5) pts += 2;

  // Elevated short interest (3 pts)
  const sf = d.shortPercentOfFloat;
  if (sf != null) {
    if (sf > 15) pts += 3;
    else if (sf > 10) pts += 2;
  } else {
    if (confidence === 'high') confidence = 'medium'; // missing data
  }

  return {
    score: pts,
    confidence,
    earningsDaysOut,
    sectorMomentumRank: rank,
    shortFloat: d.shortPercentOfFloat ?? null,
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
  const { score, signals } = candidate;

  // Coiled Spring: score >= 85, contraction >= 30, volume >= 10, pivot distance <= 8%
  if (score >= 85 && signals.contraction >= 30 && signals.volumeSignature >= 10 && candidate.distFromResistance <= 8) {
    return 'coiled_spring';
  }

  // Catalyst Loaded: catalyst >= 12, trend >= 20
  if (signals.catalystAwareness >= 12 && signals.trendHealth >= 20) {
    return 'catalyst_loaded';
  }

  // Building Base: score 60-84, trend >= 15
  if (score >= 60 && signals.trendHealth >= 15) {
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
