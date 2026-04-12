/**
 * Explosion Potential — Scoring Engine
 *
 * Pure-logic module: takes data objects, returns scores and tags.
 * No I/O, no network calls, no TradingView dependency.
 *
 * Methodology credits:
 *   - Trend Template: Mark Minervini (SEPA)
 *   - Volume/Momentum: Kristjan Qullamaggie + William O'Neil (CANSLIM)
 *   - VCP: Minervini Volatility Contraction Pattern
 *   - Catalyst Premium: tastytrade (IV Rank) + Qullamaggie (Episodic Pivots)
 */

// ---------------------------------------------------------------------------
// scoreTrendStructure (0-25 pts) — Minervini Trend Template
// ---------------------------------------------------------------------------
/**
 * @param {{ price: number, ma50: number, ma150: number, ma200: number, ma200rising: boolean, high52w: number }} d
 * @returns {number}
 */
export function scoreTrendStructure(d) {
  let pts = 0;

  // Price > 50-day AND 150-day AND 200-day MA = 10pts
  if (d.price > d.ma50 && d.price > d.ma150 && d.price > d.ma200) {
    pts += 10;
  }

  // 200-day MA rising for 1+ month = 5pts
  if (d.ma200rising) {
    pts += 5;
  }

  // Within 25% of 52-week high = 5pts
  if (d.high52w > 0 && d.price >= d.high52w * 0.75) {
    pts += 5;
  }

  // Price > 150-day > 200-day (stacked MAs) = 5pts
  if (d.price > d.ma150 && d.ma150 > d.ma200) {
    pts += 5;
  }

  return pts;
}

// ---------------------------------------------------------------------------
// scoreVolumeMomentum (0-30 pts) — Qullamaggie + O'Neil
// ---------------------------------------------------------------------------
/**
 * @param {{ volumeRatio: number, relStrengthTop20: boolean }} d
 * @returns {number}
 */
export function scoreVolumeMomentum(d) {
  let pts = 0;

  // Volume ratio tiers (highest match wins)
  if (d.volumeRatio >= 5) {
    pts += 30;
  } else if (d.volumeRatio >= 3) {
    pts += 20;
  } else if (d.volumeRatio >= 2) {
    pts += 10;
  }

  // Relative strength bonus
  if (d.relStrengthTop20) {
    pts += 5;
  }

  // Cap at 30
  return Math.min(pts, 30);
}

// ---------------------------------------------------------------------------
// scoreVolatilityContraction (0-25 pts) — Minervini VCP
// ---------------------------------------------------------------------------
/**
 * @param {{ bbWidthPctile: number, atrContracting: boolean, nearPivot: boolean }} d
 * @returns {number}
 */
export function scoreVolatilityContraction(d) {
  let pts = 0;

  // BB width in bottom 25% of 6-month range = 10pts
  if (d.bbWidthPctile <= 25) {
    pts += 10;
  }

  // ATR contracting (current < 50% of avg) = 10pts
  if (d.atrContracting) {
    pts += 10;
  }

  // Price within 5% of pivot after tight consolidation = 5pts
  if (d.nearPivot) {
    pts += 5;
  }

  return pts;
}

// ---------------------------------------------------------------------------
// scoreCatalystPremium (0-20 pts) — tastytrade + Qullamaggie EP
// ---------------------------------------------------------------------------
/**
 * @param {{ earningsWithin14d: boolean, ivRank: number, gapPct: number, gapVolumeRatio: number }} d
 * @returns {number}
 */
export function scoreCatalystPremium(d) {
  let pts = 0;

  // Earnings within 14 days = 5pts
  if (d.earningsWithin14d) {
    pts += 5;
  }

  // IV Rank tiers (higher replaces lower, not additive)
  if (d.ivRank > 75) {
    pts += 10;
  } else if (d.ivRank > 50) {
    pts += 5;
  }

  // Gap 5%+ on 2x volume = 5pts
  if (d.gapPct >= 5 && d.gapVolumeRatio >= 2) {
    pts += 5;
  }

  // Cap at 20
  return Math.min(pts, 20);
}

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------
/**
 * @param {{ trend: number, volume: number, vcp: number, catalyst: number }} sub
 * @returns {{ score: number, signals: { trendStructure: number, volumeMomentum: number, volatilityContraction: number, catalystPremium: number } }}
 */
export function computeCompositeScore({ trend, volume, vcp, catalyst }) {
  return {
    score: trend + volume + vcp + catalyst,
    signals: {
      trendStructure: trend,
      volumeMomentum: volume,
      volatilityContraction: vcp,
      catalystPremium: catalyst,
    },
  };
}

// ---------------------------------------------------------------------------
// classifyCandidate
// ---------------------------------------------------------------------------
/**
 * @param {{ score: number, signals: { trendStructure: number }, details: { emaStacked: boolean, ivRank: number, earningsWithin14d: boolean, gapPct: number, gapVolumeRatio: number } }} candidate
 * @returns {string[]}
 */
export function classifyCandidate(candidate) {
  const { score, details } = candidate;
  const tags = [];

  // accumulate: score >= 60, emaStacked, ivRank < 40
  if (score >= 60 && details.emaStacked && details.ivRank < 40) {
    tags.push('accumulate');
  }

  // harvest: score >= 50, ivRank > 50, earningsWithin14d
  if (score >= 50 && details.ivRank > 50 && details.earningsWithin14d) {
    tags.push('harvest');
  }

  // episodic_pivot: gapPct >= 10, gapVolumeRatio >= 3
  if (details.gapPct >= 10 && details.gapVolumeRatio >= 3) {
    tags.push('episodic_pivot');
  }

  // Fallback: score >= 50 but no tags matched
  if (score >= 50 && tags.length === 0) {
    if (details.ivRank > 50) {
      tags.push('harvest');
    } else {
      tags.push('accumulate');
    }
  }

  return tags;
}

// ---------------------------------------------------------------------------
// generatePlay
// ---------------------------------------------------------------------------
/**
 * @param {string} symbol
 * @param {string[]} tags
 * @param {object} details
 * @returns {string}
 */
export function generatePlay(symbol, tags, details) {
  if (tags.length === 0) {
    return `${symbol}: Score below threshold — watchlist only, no active play.`;
  }

  const plays = [];

  if (tags.includes('episodic_pivot')) {
    plays.push(
      `Episodic pivot detected (gap ${details.gapPct ?? '?'}%, vol ${details.gapVolumeRatio ?? '?'}x). ` +
      `Buy the breakout; stop below gap-day low.`
    );
  }

  if (tags.includes('harvest')) {
    const ivNote = details.ivRank ? ` (IV rank ${details.ivRank})` : '';
    plays.push(
      `Sell premium into elevated IV${ivNote}. ` +
      (details.earningsWithin14d
        ? 'Consider earnings straddle/strangle or iron condor.'
        : 'Covered call or cash-secured put on pullback.')
    );
  }

  if (tags.includes('accumulate')) {
    plays.push(
      `Accumulate shares on pullbacks to rising MAs. ` +
      `Low IV — buy calls or sell cash-secured puts for entry.`
    );
  }

  return `${symbol}: ${plays.join(' | ')}`;
}
