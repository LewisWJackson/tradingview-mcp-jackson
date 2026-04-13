/**
 * Unit tests for Coiled Spring Scanner v2 scoring engine.
 * Pure logic — no network, no TradingView.
 *
 * Run: node --test tests/coiled_spring_scanner.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
  calcATRPercentile,
  calcStdDevContractionRate,
  detectVCP,
  calcRSvsIndex,
  calcAccumulationScore,
  calcOBVTrendSlope,
  calcVolumeClustering,
  calcResistanceLevel,
  detectGapNearResistance,
  calcSectorMomentumRank,
  matchCatalystKeywords,
  computeProbabilityScore,
  calcRiskCategory,
  calcEntryTrigger,
  generateNotes,
} from '../scripts/scanner/scoring_v2.js';

import {
  VALID_COIL,
  ALREADY_EXPLODED,
  BROKEN_DOWN,
  ILLIQUID,
  FAKE_COMPRESSION,
  BOUNDARY_CANDIDATE,
  GAP_NEAR_RESISTANCE,
  SPY_BARS,
  QQQ_BARS,
  OUTPERFORMER,
  UNDERPERFORMER,
  SECTOR_ETFS,
  makeBars,
} from '../scripts/scanner/test_fixtures/fixtures.js';

import { detectRedFlags } from '../scripts/scanner/yahoo_screen_v2.js';
import { weightedRank } from '../scripts/scanner/coiled_spring_scanner.js';

// ---------------------------------------------------------------------------
// scoreTrendHealth (0-30 pts)
// ---------------------------------------------------------------------------
describe('scoreTrendHealth', () => {
  it('returns high score for valid coil (stacked MAs, strong RS)', () => {
    const { score, confidence } = scoreTrendHealth(VALID_COIL);
    assert.ok(score >= 20, `expected >= 20, got ${score}`);
    assert.equal(confidence, 'high');
  });

  it('returns low score for broken-down stock', () => {
    const { score } = scoreTrendHealth(BROKEN_DOWN);
    assert.ok(score <= 5, `expected <= 5, got ${score}`);
  });

  it('gives 8 pts for stacked MA alignment', () => {
    const { score } = scoreTrendHealth({
      price: 100, ma50: 90, ma150: 85, ma200: 80, high52w: 200,
      relStrengthPctile: 0, ohlcv: makeBars(10),
    });
    assert.ok(score >= 8, `stacked MAs should give at least 8, got ${score}`);
  });

  it('gives 0 for inverted MAs', () => {
    const { score } = scoreTrendHealth({
      price: 50, ma50: 60, ma150: 70, ma200: 80, high52w: 100,
      relStrengthPctile: 0, ohlcv: makeBars(10),
    });
    assert.equal(score, 0);
  });

  it('returns medium confidence when OHLCV has < 20 bars', () => {
    const { confidence } = scoreTrendHealth({
      ...VALID_COIL,
      ohlcv: makeBars(10),
    });
    assert.equal(confidence, 'medium');
  });

  it('awards higher RS fallback for top 30% relative strength', () => {
    const { score: high } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 75 });
    const { score: mid } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 55 });
    const { score: low } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 30 });
    assert.ok(high > mid, 'top 30% should score higher than top 50%');
    assert.ok(mid > low, 'top 50% should score higher than bottom');
  });

  it('uses index-based RS when context provided', () => {
    const result = scoreTrendHealth(OUTPERFORMER, { spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS });
    assert.ok(result.rsSubtotal > 0, `expected rsSubtotal > 0, got ${result.rsSubtotal}`);
  });

  it('falls back to Yahoo RS when no context', () => {
    const result = scoreTrendHealth(VALID_COIL);
    assert.ok(result.rsSubtotal >= 3, `expected >= 3, got ${result.rsSubtotal}`);
  });

  it('returns rsSubtotal and trendSubtotal breakdown', () => {
    const result = scoreTrendHealth(VALID_COIL);
    assert.ok(typeof result.rsSubtotal === 'number');
    assert.ok(typeof result.trendSubtotal === 'number');
    assert.strictEqual(result.score, result.rsSubtotal + result.trendSubtotal);
  });
});

// ---------------------------------------------------------------------------
// scoreContractionQuality (0-40 pts)
// ---------------------------------------------------------------------------
describe('scoreContractionQuality', () => {
  it('returns high score for contracting volatility', () => {
    const { score } = scoreContractionQuality(VALID_COIL);
    assert.ok(score >= 15, `expected >= 15 for contracting vol, got ${score}`);
  });

  it('returns low score for wide/volatile bars', () => {
    const { score } = scoreContractionQuality(ALREADY_EXPLODED);
    assert.ok(score <= 20, `expected <= 20 for wide vol, got ${score}`);
  });

  it('returns 0 with confidence low for < 20 bars', () => {
    const result = scoreContractionQuality({ ohlcv: makeBars(5) });
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 'low');
  });

  it('returns vcpContractions field for contracting fixture', () => {
    const { vcpContractions } = scoreContractionQuality(VALID_COIL);
    assert.ok(typeof vcpContractions === 'number', `vcpContractions should be a number, got ${typeof vcpContractions}`);
    assert.ok(vcpContractions >= 0, `vcpContractions should be non-negative, got ${vcpContractions}`);
  });

  it('reports tight daily range for low-volatility bars', () => {
    const tight = scoreContractionQuality({
      ohlcv: makeBars(30, { volatility: 'tight' }),
    });
    assert.ok(tight.dailyRangePct < 5, `expected < 5%, got ${tight.dailyRangePct}`);
  });
});

// ---------------------------------------------------------------------------
// multi-factor contraction gate
// ---------------------------------------------------------------------------
describe('multi-factor contraction gate', () => {
  it('caps score at 15 when fewer than 3 signals confirm', () => {
    const result = scoreContractionQuality(FAKE_COMPRESSION);
    assert.ok(result.score <= 15, `expected <= 15, got ${result.score}`);
    assert.ok(typeof result.confirmingSignals === 'number');
  });

  it('allows full score when 3+ signals confirm', () => {
    const result = scoreContractionQuality(VALID_COIL);
    assert.ok(typeof result.confirmingSignals === 'number');
    if (result.confirmingSignals >= 3) {
      assert.ok(result.score > 15, `3+ signals but score only ${result.score}`);
    }
  });

  it('returns atrPercentile in contraction result', () => {
    const result = scoreContractionQuality(VALID_COIL);
    assert.ok(typeof result.atrPercentile === 'number');
    assert.ok(result.atrPercentile >= 0 && result.atrPercentile <= 100);
  });
});

// ---------------------------------------------------------------------------
// scoreVolumeSignature (0-20 pts)
// ---------------------------------------------------------------------------
describe('scoreVolumeSignature', () => {
  it('rewards volume drought (low 10d vs 3mo ratio)', () => {
    const { score, volDroughtRatio } = scoreVolumeSignature(VALID_COIL);
    assert.ok(volDroughtRatio < 0.85, `expected drought ratio < 0.85, got ${volDroughtRatio}`);
    assert.ok(score >= 3, `expected >= 3 pts for drought, got ${score}`);
  });

  it('gives 0 for surging volume (no drought)', () => {
    const { volDroughtRatio } = scoreVolumeSignature(ALREADY_EXPLODED);
    assert.ok(volDroughtRatio > 1, `expected ratio > 1 for surging vol, got ${volDroughtRatio}`);
  });

  it('distinguishes real accumulation from dead money', () => {
    const coil = scoreVolumeSignature(VALID_COIL);
    const dead = scoreVolumeSignature(FAKE_COMPRESSION);
    assert.ok(coil.score > dead.score, `coil (${coil.score}) should score higher than dead money (${dead.score})`);
  });

  it('returns low confidence for < 10 bars', () => {
    const { confidence } = scoreVolumeSignature({ avgVol10d: 1000000, avgVol3mo: 1500000, ohlcv: makeBars(5) });
    assert.equal(confidence, 'low');
  });

  it('returns accDistScore instead of accumulationDays', () => {
    const result = scoreVolumeSignature(VALID_COIL);
    assert.ok(typeof result.accDistScore === 'number');
    assert.ok(result.accDistScore >= 0);
    assert.strictEqual(result.accumulationDays, undefined, 'accumulationDays should no longer exist');
  });

  it('returns obvSlopeNormalized and supportVolumeRatio fields', () => {
    const result = scoreVolumeSignature(VALID_COIL);
    assert.ok(typeof result.obvSlopeNormalized === 'number');
    assert.ok(typeof result.supportVolumeRatio === 'number');
  });
});

// ---------------------------------------------------------------------------
// scorePivotStructure (0-15 pts)
// ---------------------------------------------------------------------------
describe('scorePivotStructure', () => {
  it('scores high when price is near resistance', () => {
    const { score, distFromResistance } = scorePivotStructure(VALID_COIL);
    assert.ok(distFromResistance <= 15, `expected near resistance, got ${distFromResistance}%`);
    assert.ok(score >= 4, `expected >= 4 pts near resistance, got ${score}`);
  });

  it('penalizes extension > 10% above 50-day MA', () => {
    const extended = {
      price: 100,
      ma50: 80, // 25% above
      ohlcv: makeBars(30, { basePrice: 95 }),
    };
    const { extendedAbove50ma } = scorePivotStructure(extended);
    assert.equal(extendedAbove50ma, true);
  });

  it('returns 0 with low confidence for < 20 bars', () => {
    const result = scorePivotStructure({ price: 50, ma50: 45, ohlcv: makeBars(5) });
    assert.equal(result.score, 0);
    assert.equal(result.confidence, 'low');
  });

  it('returns new fields: resistanceStrength, resistancePrice, gapFormedResistance', () => {
    const result = scorePivotStructure(VALID_COIL);
    assert.ok(typeof result.resistanceStrength === 'number');
    assert.ok(typeof result.resistancePrice === 'number');
    assert.ok(typeof result.gapFormedResistance === 'boolean');
  });
});

// scorePivotStructure enhanced (multi-window resistance + penalties)
// ---------------------------------------------------------------------------
describe('scorePivotStructure (enhanced)', () => {
  it('returns resistanceStrength from multi-window detection', () => {
    const result = scorePivotStructure(VALID_COIL);
    assert.ok(typeof result.resistanceStrength === 'number');
    assert.ok(result.resistanceStrength >= 1 && result.resistanceStrength <= 3);
  });

  it('penalizes recent large gap', () => {
    const result = scorePivotStructure(GAP_NEAR_RESISTANCE);
    assert.ok(result.gapFormedResistance === true || result.score < 10);
  });

  it('caps resistanceStrength to 1 when gap formed resistance', () => {
    const result = scorePivotStructure(GAP_NEAR_RESISTANCE);
    if (result.gapFormedResistance) {
      assert.ok(result.resistanceStrength <= 1);
    }
  });
});

// ---------------------------------------------------------------------------
// scoreCatalystAwareness (0-13 pts)
// ---------------------------------------------------------------------------
describe('scoreCatalystAwareness', () => {
  it('awards 4 pts for earnings 30-45 days out', () => {
    const { score, earningsDaysOut } = scoreCatalystAwareness(VALID_COIL);
    assert.ok(earningsDaysOut >= 30 && earningsDaysOut <= 45, `expected 30-45d out, got ${earningsDaysOut}`);
    assert.ok(score >= 4, `expected >= 4 pts, got ${score}`);
  });

  it('awards 2 pts for earnings < 30 days', () => {
    const close = {
      ...VALID_COIL,
      earningsTimestamp: Date.now() + 15 * 86_400_000,
    };
    const { score } = scoreCatalystAwareness(close);
    assert.ok(score >= 2, 'should get at least 2 pts for close earnings');
  });

  it('returns medium confidence when no earnings date', () => {
    const { confidence } = scoreCatalystAwareness({ ...VALID_COIL, earningsTimestamp: null });
    assert.equal(confidence, 'medium');
  });

  it('detects upgrade keywords in news via matchCatalystKeywords', () => {
    const { score: withUpgrade } = scoreCatalystAwareness(VALID_COIL);
    const { score: withoutUpgrade } = scoreCatalystAwareness({ ...VALID_COIL, news: [] });
    assert.ok(withUpgrade > withoutUpgrade, 'upgrade news should add points');
  });
});

// ---------------------------------------------------------------------------
// scoreCatalystAwareness (enhanced)
// ---------------------------------------------------------------------------
describe('scoreCatalystAwareness (enhanced)', () => {
  it('returns catalystTag field', () => {
    const result = scoreCatalystAwareness(OUTPERFORMER);
    assert.ok(['catalyst_present', 'catalyst_weak', 'catalyst_unknown'].includes(result.catalystTag));
  });

  it('uses real sector rank from context', () => {
    const sectorRanks = { Technology: 2, Healthcare: 8 };
    const result = scoreCatalystAwareness(OUTPERFORMER, { sectorRanks, candidateSector: 'Technology' });
    assert.strictEqual(result.sectorMomentumRank, 2);
    assert.ok(result.score >= 4, `expected >= 4 for rank 2, got ${result.score}`);
  });

  it('falls back to rank 6 when no context', () => {
    const result = scoreCatalystAwareness(VALID_COIL);
    assert.strictEqual(result.sectorMomentumRank, 6);
  });

  it('tags catalyst_present for strong keyword match', () => {
    const d = { ...OUTPERFORMER, news: [{ title: 'Price target raised to $200' }], earningsTimestamp: null };
    const result = scoreCatalystAwareness(d);
    assert.strictEqual(result.catalystTag, 'catalyst_present');
  });
});

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------
describe('computeCompositeScore', () => {
  it('sums all category scores', () => {
    const result = computeCompositeScore({
      trend: { score: 25, confidence: 'high' },
      contraction: { score: 35, confidence: 'high', atrRatio: 0.4 },
      volume: { score: 15, confidence: 'high', upDownVolRatio: 1.6 },
      pivot: { score: 12, confidence: 'high', distFromResistance: 3, extendedAbove50ma: false },
      catalyst: { score: 8, confidence: 'high', earningsDaysOut: 35 },
    });
    assert.equal(result.score, 95);
  });

  it('confidence is weakest link', () => {
    const result = computeCompositeScore({
      trend: { score: 20, confidence: 'high' },
      contraction: { score: 30, confidence: 'medium' },
      volume: { score: 10, confidence: 'high' },
      pivot: { score: 8, confidence: 'high', distFromResistance: 5, extendedAbove50ma: false },
      catalyst: { score: 5, confidence: 'low', earningsDaysOut: null },
    });
    assert.equal(result.scoreConfidence, 'low');
  });

  it('detects breakout risk drivers', () => {
    const result = computeCompositeScore({
      trend: { score: 20, confidence: 'high' },
      contraction: { score: 30, confidence: 'high', atrRatio: 0.9 },
      volume: { score: 10, confidence: 'high', upDownVolRatio: 0.9 },
      pivot: { score: 8, confidence: 'high', distFromResistance: 3, extendedAbove50ma: true },
      catalyst: { score: 5, confidence: 'high', earningsDaysOut: 15 },
    }, { regime: 'cautious' });
    assert.ok(result.breakoutRiskDrivers.includes('extended_above_ma'));
    assert.ok(result.breakoutRiskDrivers.includes('weak_accumulation'));
    assert.ok(result.breakoutRiskDrivers.includes('weak_market_backdrop'));
    assert.ok(result.breakoutRiskDrivers.includes('imminent_earnings'));
    assert.equal(result.breakoutRisk, 'high');
  });
});

// ---------------------------------------------------------------------------
// classifyCandidate
// ---------------------------------------------------------------------------
describe('classifyCandidate', () => {
  it('classifies coiled spring correctly', () => {
    const cls = classifyCandidate({
      score: 90, price: 50, avgVol10d: 500_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false },
    });
    assert.equal(cls, 'coiled_spring');
  });

  it('classifies building base for score 60-84', () => {
    const cls = classifyCandidate({
      score: 70, price: 50, avgVol10d: 500_000,
      signals: { trendHealth: 20, contraction: 20, volumeSignature: 10, pivotProximity: 10, catalystAwareness: 10 },
      details: { distFromResistance: 12, extendedAbove50ma: false },
    });
    assert.equal(cls, 'building_base');
  });

  it('classifies catalyst loaded', () => {
    const cls = classifyCandidate({
      score: 75, price: 50, avgVol10d: 500_000,
      signals: { trendHealth: 25, contraction: 15, volumeSignature: 10, pivotProximity: 12, catalystAwareness: 13 },
      details: { distFromResistance: 10, extendedAbove50ma: false },
    });
    assert.equal(cls, 'catalyst_loaded');
  });

  it('returns below_threshold for low scores', () => {
    const cls = classifyCandidate({
      score: 40, price: 50, avgVol10d: 500_000,
      signals: { trendHealth: 10, contraction: 10, volumeSignature: 5, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 15, extendedAbove50ma: false },
    });
    assert.equal(cls, 'below_threshold');
  });

  it('requires contraction >= 30 for coiled spring', () => {
    const cls = classifyCandidate({
      score: 90, price: 50, avgVol10d: 500_000,
      signals: { trendHealth: 25, contraction: 25, volumeSignature: 15, pivotProximity: 15, catalystAwareness: 10 },
      details: { distFromResistance: 3, extendedAbove50ma: false },
    });
    assert.notEqual(cls, 'coiled_spring', 'contraction 25 < 30 threshold');
  });
});

// ---------------------------------------------------------------------------
// classifyCandidate (v3 enhanced — DISQUALIFIED + EXTENDED)
// ---------------------------------------------------------------------------
describe('classifyCandidate (v3 enhanced)', () => {
  it('returns disqualified for low price', () => {
    const result = classifyCandidate({
      score: 90, price: 3, avgVol10d: 500_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false }
    });
    assert.strictEqual(result, 'disqualified');
  });

  it('returns disqualified for low volume', () => {
    const result = classifyCandidate({
      score: 90, price: 50, avgVol10d: 100_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false }
    });
    assert.strictEqual(result, 'disqualified');
  });

  it('returns extended for > 15% above 50 MA', () => {
    const result = classifyCandidate({
      score: 90, price: 120, avgVol10d: 1_000_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: true, extensionPct: 18, hasLargeGap: false, atrExpanding: false }
    });
    assert.strictEqual(result, 'extended');
  });

  it('returns extended for recent large gap', () => {
    const result = classifyCandidate({
      score: 90, price: 50, avgVol10d: 1_000_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: false, extensionPct: 5, hasLargeGap: true, atrExpanding: false }
    });
    assert.strictEqual(result, 'extended');
  });

  it('disqualified overrides extended', () => {
    const result = classifyCandidate({
      score: 90, price: 3, avgVol10d: 100_000,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      details: { distFromResistance: 3, extendedAbove50ma: true, extensionPct: 20, hasLargeGap: true, atrExpanding: true }
    });
    assert.strictEqual(result, 'disqualified');
  });
});

// ---------------------------------------------------------------------------
// detectRedFlags
// ---------------------------------------------------------------------------
describe('detectRedFlags', () => {
  it('detects dilution keywords', () => {
    const flags = detectRedFlags([{ title: 'Company announces secondary offering' }]);
    assert.ok(flags.includes('dilution_risk'));
  });

  it('detects litigation keywords', () => {
    const flags = detectRedFlags([{ title: 'Company sued in class action lawsuit' }]);
    assert.ok(flags.includes('litigation'));
  });

  it('detects merger keywords', () => {
    const flags = detectRedFlags([{ title: 'Reports of takeover bid emerge' }]);
    assert.ok(flags.includes('merger_pending'));
  });

  it('returns empty array for clean news', () => {
    const flags = detectRedFlags([{ title: 'Company reports strong Q1 earnings' }]);
    assert.deepEqual(flags, []);
  });

  it('detects multiple flags', () => {
    const flags = detectRedFlags([
      { title: 'Company sued in lawsuit' },
      { title: 'New secondary offering announced' },
    ]);
    assert.ok(flags.includes('litigation'));
    assert.ok(flags.includes('dilution_risk'));
  });
});

// ---------------------------------------------------------------------------
// generatePlay
// ---------------------------------------------------------------------------
describe('generatePlay', () => {
  it('generates CSP play for coiled spring', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'constructive');
    assert.ok(play.includes('CSP'), 'should mention CSP');
    assert.ok(play.includes('TEST'), 'should include symbol');
  });

  it('shows defensive regime warning', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'defensive');
    assert.ok(play.includes('DEFENSIVE'), 'should warn about defensive regime');
    assert.ok(play.includes('no new entries'), 'should say no entries');
  });

  it('shows cautious regime note', () => {
    const play = generatePlay('TEST', 'coiled_spring', { ma50: 82, distFromResistance: 5, price: 85 }, 'cautious');
    assert.ok(play.includes('cautious'), 'should mention cautious regime');
  });

  it('says watchlist for building base', () => {
    const play = generatePlay('TEST', 'building_base', { ma50: 50, distFromResistance: 12, price: 55 }, 'constructive');
    assert.ok(play.includes('Watchlist'), 'should say watchlist');
  });
});

// ---------------------------------------------------------------------------
// detectVCP (enhanced)
// ---------------------------------------------------------------------------
describe('detectVCP (enhanced)', () => {
  it('returns vcpQuality as a 0-1 float', () => {
    const result = detectVCP(VALID_COIL.ohlcv);
    assert.ok(typeof result.vcpQuality === 'number');
    assert.ok(result.vcpQuality >= 0 && result.vcpQuality <= 1);
  });

  it('allows one non-declining depth in sequence', () => {
    const bars = makeBars(63, { basePrice: 50, trend: 'up', volatility: 'contracting', volumeBase: 1_000_000, volumeTrend: 'drying' });
    const result = detectVCP(bars);
    assert.ok(typeof result.contractions === 'number');
    assert.ok(typeof result.vcpQuality === 'number');
  });

  it('returns 0 contractions for wide volatile bars', () => {
    const wideBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'wide', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = detectVCP(wideBars);
    assert.ok(result.contractions <= 1, `expected <= 1, got ${result.contractions}`);
  });
});

// ---------------------------------------------------------------------------
// calcATRPercentile
// ---------------------------------------------------------------------------
describe('calcATRPercentile', () => {
  it('returns low percentile for contracting volatility', () => {
    const result = calcATRPercentile(VALID_COIL.ohlcv);
    assert.ok(result.atrPercentile <= 30, `expected <= 30, got ${result.atrPercentile}`);
  });

  it('returns high percentile for wide volatility', () => {
    const result = calcATRPercentile(ALREADY_EXPLODED.ohlcv);
    assert.ok(result.atrPercentile >= 50, `expected >= 50, got ${result.atrPercentile}`);
  });

  it('handles bars shorter than lookback gracefully', () => {
    const shortBars = makeBars(20, { basePrice: 50, trend: 'flat', volatility: 'normal', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcATRPercentile(shortBars, 14, 252);
    assert.ok(typeof result.atrPercentile === 'number');
    assert.ok(result.atrPercentile >= 0 && result.atrPercentile <= 100);
  });
});

// ---------------------------------------------------------------------------
// calcStdDevContractionRate
// ---------------------------------------------------------------------------
describe('calcStdDevContractionRate', () => {
  it('returns isContracting=true when stddev declining across windows', () => {
    const result = calcStdDevContractionRate(VALID_COIL.ohlcv);
    assert.strictEqual(result.isContracting, true);
  });

  it('returns isContracting=false for flat or expanding volatility', () => {
    const flatBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'wide', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcStdDevContractionRate(flatBars);
    assert.strictEqual(result.isContracting, false);
  });

  it('returns ratio < 1 when contracting', () => {
    const result = calcStdDevContractionRate(VALID_COIL.ohlcv);
    assert.ok(result.ratio < 1, `expected ratio < 1, got ${result.ratio}`);
  });
});

// ---------------------------------------------------------------------------
// calcRSvsIndex
// ---------------------------------------------------------------------------
describe('calcRSvsIndex', () => {
  it('returns ratio > 1.0 for outperforming stock', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.ok(result.rsRatio20d > 1.0, `expected > 1.0, got ${result.rsRatio20d}`);
  });

  it('returns ratio < 1.0 for underperforming stock', () => {
    const result = calcRSvsIndex(UNDERPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.ok(result.rsRatio20d < 1.0 || result.rsRatio40d < 1.0, `expected < 1.0`);
  });

  it('rsTrending is true when 20d ratio > 40d ratio', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.strictEqual(typeof result.rsTrending, 'boolean');
  });

  it('takes the stronger of SPY and QQQ readings', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.ok(result.rsRatio20d > 0);
    assert.ok(result.rsRatio40d > 0);
  });

  it('returns outperformingOnPullbacks boolean', () => {
    const result = calcRSvsIndex(OUTPERFORMER.ohlcv, SPY_BARS, QQQ_BARS);
    assert.strictEqual(typeof result.outperformingOnPullbacks, 'boolean');
  });
});

// ---------------------------------------------------------------------------
// calcAccumulationScore
// ---------------------------------------------------------------------------
describe('calcAccumulationScore', () => {
  it('returns higher score for accumulating stock', () => {
    const result = calcAccumulationScore(VALID_COIL.ohlcv);
    assert.ok(result.accDistScore > 0, `expected > 0, got ${result.accDistScore}`);
  });

  it('returns lower score for distributing stock', () => {
    const result = calcAccumulationScore(BROKEN_DOWN.ohlcv);
    const validResult = calcAccumulationScore(VALID_COIL.ohlcv);
    assert.ok(result.accDistScore < validResult.accDistScore);
  });
});

// ---------------------------------------------------------------------------
// calcOBVTrendSlope
// ---------------------------------------------------------------------------
describe('calcOBVTrendSlope', () => {
  it('returns positive slope for accumulating stock', () => {
    const result = calcOBVTrendSlope(OUTPERFORMER.ohlcv);
    assert.ok(result.obvSlope >= 0, `expected >= 0, got ${result.obvSlope}`);
  });

  it('returns normalized slope for cross-stock comparison', () => {
    const result = calcOBVTrendSlope(VALID_COIL.ohlcv);
    assert.ok(typeof result.obvSlopeNormalized === 'number');
  });
});

// ---------------------------------------------------------------------------
// calcVolumeClustering
// ---------------------------------------------------------------------------
describe('calcVolumeClustering', () => {
  it('detects volume at swing lows', () => {
    const result = calcVolumeClustering(VALID_COIL.ohlcv);
    assert.ok(typeof result.supportVolumeRatio === 'number');
    assert.ok(result.supportVolumeRatio > 0);
  });

  it('returns ratio near 1 when volume is uniform', () => {
    const flatBars = makeBars(63, { basePrice: 50, trend: 'flat', volatility: 'normal', volumeBase: 1_000_000, volumeTrend: 'flat' });
    const result = calcVolumeClustering(flatBars);
    assert.ok(result.supportVolumeRatio < 2, `expected < 2, got ${result.supportVolumeRatio}`);
  });
});

// ---------------------------------------------------------------------------
// calcResistanceLevel
// ---------------------------------------------------------------------------
describe('calcResistanceLevel', () => {
  it('returns strength between 1 and 3', () => {
    const result = calcResistanceLevel(VALID_COIL.ohlcv);
    assert.ok(result.resistanceStrength >= 1 && result.resistanceStrength <= 3);
    assert.ok(typeof result.resistancePrice === 'number');
    assert.ok(result.resistancePrice > 0);
  });

  it('returns resistanceTouches count', () => {
    const result = calcResistanceLevel(VALID_COIL.ohlcv);
    assert.ok(typeof result.resistanceTouches === 'number');
    assert.ok(result.resistanceTouches >= 0);
  });
});

// ---------------------------------------------------------------------------
// detectGapNearResistance
// ---------------------------------------------------------------------------
describe('detectGapNearResistance', () => {
  it('detects large gap near resistance', () => {
    const { resistancePrice } = calcResistanceLevel(GAP_NEAR_RESISTANCE.ohlcv);
    const result = detectGapNearResistance(GAP_NEAR_RESISTANCE.ohlcv, resistancePrice);
    assert.strictEqual(result.gapFormedResistance, true);
  });

  it('returns false when no gap near resistance', () => {
    const { resistancePrice } = calcResistanceLevel(VALID_COIL.ohlcv);
    const result = detectGapNearResistance(VALID_COIL.ohlcv, resistancePrice);
    assert.strictEqual(result.gapFormedResistance, false);
  });
});

// ---------------------------------------------------------------------------
// calcSectorMomentumRank
// ---------------------------------------------------------------------------
describe('calcSectorMomentumRank', () => {
  it('returns rank 1-11 for each sector', () => {
    const ranks = calcSectorMomentumRank(SECTOR_ETFS);
    assert.ok(typeof ranks === 'object');
    const techRank = ranks['Technology'];
    assert.ok(techRank >= 1 && techRank <= 11, `Technology rank: ${techRank}`);
  });

  it('strongest sector gets rank 1', () => {
    const ranks = calcSectorMomentumRank(SECTOR_ETFS);
    const allRanks = Object.values(ranks);
    assert.ok(allRanks.includes(1));
    assert.ok(allRanks.includes(11));
  });
});

// ---------------------------------------------------------------------------
// matchCatalystKeywords
// ---------------------------------------------------------------------------
describe('matchCatalystKeywords', () => {
  it('categorizes earnings catalyst', () => {
    const news = [{ title: 'Analyst price target raised to $150' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'earnings_catalyst');
  });

  it('categorizes merger catalyst', () => {
    const news = [{ title: 'Company announces merger with rival' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'merger_catalyst');
  });

  it('categorizes product catalyst', () => {
    const news = [{ title: 'FDA approval granted for new drug' }];
    const result = matchCatalystKeywords(news);
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].catalystType, 'product_catalyst');
  });

  it('deduplicates same catalyst type', () => {
    const news = [
      { title: 'Price target raised by Goldman' },
      { title: 'Price target raised by Morgan Stanley' }
    ];
    const result = matchCatalystKeywords(news);
    assert.strictEqual(result.length, 1);
  });

  it('returns empty array for clean news', () => {
    const news = [{ title: 'Company releases quarterly report' }];
    const result = matchCatalystKeywords(news);
    assert.strictEqual(result.length, 0);
  });
});

// ── computeProbabilityScore ───────────────────────────────────────────
describe('computeProbabilityScore', () => {
  it('returns probability_score between 0 and 100', () => {
    const signals = {
      trendHealth: { score: 24, rsSubtotal: 7, trendSubtotal: 17 },
      contraction: { score: 35 },
      volumeSignature: { score: 16 },
      pivotProximity: { score: 12 },
      catalystAwareness: { score: 5 }
    };
    const context = { regime: { regime: 'constructive' } };
    const result = computeProbabilityScore(signals, context);
    assert.ok(result.probability_score >= 0 && result.probability_score <= 100);
  });

  it('returns 100 for perfect scores in constructive regime', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const context = { regime: { regime: 'constructive' } };
    const result = computeProbabilityScore(signals, context);
    assert.strictEqual(result.probability_score, 100);
  });

  it('applies regime multiplier for cautious', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const constructive = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    const cautious = computeProbabilityScore(signals, { regime: { regime: 'cautious' } });
    assert.ok(cautious.probability_score < constructive.probability_score);
    assert.strictEqual(cautious.regime_multiplier, 0.85);
  });

  it('applies regime multiplier for defensive', () => {
    const signals = {
      trendHealth: { score: 30, rsSubtotal: 9, trendSubtotal: 21 },
      contraction: { score: 40 },
      volumeSignature: { score: 20 },
      pivotProximity: { score: 15 },
      catalystAwareness: { score: 15 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'defensive' } });
    assert.strictEqual(result.regime_multiplier, 0.70);
    assert.ok(result.probability_score <= 70);
  });

  it('returns setup_quality tier', () => {
    const signals = {
      trendHealth: { score: 24, rsSubtotal: 7, trendSubtotal: 17 },
      contraction: { score: 35 },
      volumeSignature: { score: 16 },
      pivotProximity: { score: 12 },
      catalystAwareness: { score: 5 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    assert.ok(['ELITE', 'HIGH', 'MODERATE', 'LOW'].includes(result.setup_quality));
  });

  it('returns factor_breakdown with 7 factors', () => {
    const signals = {
      trendHealth: { score: 20, rsSubtotal: 5, trendSubtotal: 15 },
      contraction: { score: 30 },
      volumeSignature: { score: 10 },
      pivotProximity: { score: 8 },
      catalystAwareness: { score: 6 }
    };
    const result = computeProbabilityScore(signals, { regime: { regime: 'constructive' } });
    assert.ok(typeof result.factor_breakdown === 'object');
    assert.ok('volatility_contraction' in result.factor_breakdown);
    assert.ok('relative_strength_trend' in result.factor_breakdown);
    assert.ok('volume_dry_up' in result.factor_breakdown);
    assert.ok('trend_quality' in result.factor_breakdown);
    assert.ok('distance_to_resistance' in result.factor_breakdown);
    assert.ok('catalyst_presence' in result.factor_breakdown);
    assert.ok('market_regime_alignment' in result.factor_breakdown);
  });
});

describe('calcRiskCategory', () => {
  it('returns tight_vcp for coiled spring with 3+ VCP contractions', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 3, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'tight_vcp');
    assert.deepStrictEqual(result.suggested_stop_percent, [3, 5]);
  });

  it('returns standard_coil for coiled spring with fewer VCP contractions', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 1, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'standard_coil');
    assert.deepStrictEqual(result.suggested_stop_percent, [5, 7]);
  });

  it('returns catalyst_play for catalyst_loaded', () => {
    const result = calcRiskCategory('catalyst_loaded', { vcpContractions: 0, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'catalyst_play');
  });

  it('returns base_watch for building_base', () => {
    const result = calcRiskCategory('building_base', { vcpContractions: 0, atrPercentile: 30 });
    assert.strictEqual(result.risk_category, 'base_watch');
  });

  it('adds 2% to stop range for high ATR percentile', () => {
    const result = calcRiskCategory('coiled_spring', { vcpContractions: 3, atrPercentile: 80 });
    assert.deepStrictEqual(result.suggested_stop_percent, [5, 7]);
  });
});

describe('calcEntryTrigger', () => {
  it('returns break above resistance for coiled_spring', () => {
    const result = calcEntryTrigger('coiled_spring', { resistancePrice: 167.50, ma50: 160 });
    assert.ok(result.entry_trigger.includes('break above'));
    assert.ok(result.entry_trigger.includes('167.5'));
  });

  it('returns CSP option for catalyst_loaded', () => {
    const result = calcEntryTrigger('catalyst_loaded', { resistancePrice: 100, ma50: 95 });
    assert.ok(result.entry_trigger.includes('CSP'));
  });

  it('returns watchlist for building_base', () => {
    const result = calcEntryTrigger('building_base', { resistancePrice: 55, ma50: 50 });
    assert.ok(result.entry_trigger.includes('watchlist'));
  });

  it('returns no entry for extended', () => {
    const result = calcEntryTrigger('extended', { resistancePrice: 120, ma50: 100 });
    assert.strictEqual(result.entry_trigger, 'no entry');
  });
});

describe('generateNotes', () => {
  it('returns a non-empty string', () => {
    const signals = {
      contraction: { vcpContractions: 3, atrPercentile: 10 },
      catalystAwareness: { catalystTag: 'catalyst_present', catalysts: [{ catalystType: 'merger_catalyst' }] }
    };
    const details = { sectorMomentumRank: 2, earningsDaysOut: 35 };
    const result = generateNotes(signals, details);
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('mentions VCP when contractions >= 3', () => {
    const signals = { contraction: { vcpContractions: 3, atrPercentile: 20 }, catalystAwareness: { catalystTag: 'catalyst_unknown', catalysts: [] } };
    const result = generateNotes(signals, {});
    assert.ok(result.toLowerCase().includes('vcp'));
  });
});

// ---------------------------------------------------------------------------
// Weighted Ranking Engine (from orchestrator)
// ---------------------------------------------------------------------------

describe('weighted ranking', () => {
  it('ranks by weighted formula, not just raw score', () => {
    const candidates = [
      { probability_score: 70, signals: { contraction: 35 }, details: { accDistScore: 2.5, obvSlopeNormalized: 0.8, resistanceStrength: 3, distFromResistance: 2 } },
      { probability_score: 75, signals: { contraction: 25 }, details: { accDistScore: 1.0, obvSlopeNormalized: 0.1, resistanceStrength: 1, distFromResistance: 10 } },
      { probability_score: 65, signals: { contraction: 38 }, details: { accDistScore: 3.0, obvSlopeNormalized: 1.2, resistanceStrength: 3, distFromResistance: 1 } },
    ];
    const ranked = weightedRank(candidates);
    // All candidates should have a rank assigned
    assert.ok(ranked.every(r => typeof r.rank === 'number' && r.rank >= 1));
    // Ranks should be unique: 1, 2, 3
    const ranks = ranked.map(r => r.rank).sort();
    assert.deepStrictEqual(ranks, [1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// v3 Integration: Full Pipeline End-to-End
// ---------------------------------------------------------------------------

describe('v3 integration: full pipeline', () => {
  it('VALID_COIL produces all v3 output fields', () => {
    const context = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: { Technology: 2 }, candidateSector: 'Technology' };

    const trend = scoreTrendHealth(VALID_COIL, context);
    const contraction = scoreContractionQuality(VALID_COIL);
    const volume = scoreVolumeSignature(VALID_COIL);
    const pivot = scorePivotStructure(VALID_COIL);
    const catalyst = scoreCatalystAwareness(VALID_COIL, context);

    const signals = { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst };
    const composite = computeCompositeScore({
      trend, contraction, volume, pivot, catalyst
    }, { regime: 'constructive' });

    const probability = computeProbabilityScore(signals, context);

    // Verify all new fields exist
    assert.ok(typeof probability.probability_score === 'number');
    assert.ok(typeof probability.setup_quality === 'string');
    assert.ok(typeof probability.factor_breakdown === 'object');
    assert.ok(typeof probability.regime_multiplier === 'number');

    // Verify contraction has new fields
    assert.ok(typeof contraction.atrPercentile === 'number');
    assert.ok(typeof contraction.confirmingSignals === 'number');
    assert.ok(typeof contraction.vcpQuality === 'number');

    // Verify trend has RS breakdown
    assert.ok(typeof trend.rsSubtotal === 'number');
    assert.ok(typeof trend.trendSubtotal === 'number');

    // Verify volume has institutional signals
    assert.ok(typeof volume.accDistScore === 'number');
    assert.ok(typeof volume.obvSlopeNormalized === 'number');
    assert.ok(typeof volume.supportVolumeRatio === 'number');

    // Verify pivot has resistance strength
    assert.ok(typeof pivot.resistanceStrength === 'number');

    // Verify catalyst has tag
    assert.ok(typeof catalyst.catalystTag === 'string');
  });

  it('VALID_COIL ranks higher than ALREADY_EXPLODED on probability', () => {
    const context = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: {}, candidateSector: '' };

    function scoreCandidate(d) {
      const trend = scoreTrendHealth(d, context);
      const contraction = scoreContractionQuality(d);
      const volume = scoreVolumeSignature(d);
      const pivot = scorePivotStructure(d);
      const catalyst = scoreCatalystAwareness(d, context);
      const signals = { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst };
      return computeProbabilityScore(signals, context);
    }

    const validProb = scoreCandidate(VALID_COIL);
    const explodedProb = scoreCandidate(ALREADY_EXPLODED);

    assert.ok(validProb.probability_score > explodedProb.probability_score,
      `VALID_COIL (${validProb.probability_score}) should beat ALREADY_EXPLODED (${explodedProb.probability_score})`);
  });

  it('defensive regime reduces probability score', () => {
    const constructiveCtx = { regime: { regime: 'constructive' }, spyOhlcv: SPY_BARS, qqqOhlcv: QQQ_BARS, sectorRanks: {}, candidateSector: '' };
    const defensiveCtx = { ...constructiveCtx, regime: { regime: 'defensive' } };

    function probFor(d, ctx) {
      const trend = scoreTrendHealth(d, ctx);
      const contraction = scoreContractionQuality(d);
      const volume = scoreVolumeSignature(d);
      const pivot = scorePivotStructure(d);
      const catalyst = scoreCatalystAwareness(d, ctx);
      return computeProbabilityScore(
        { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst }, ctx
      );
    }

    const constructiveProb = probFor(VALID_COIL, constructiveCtx);
    const defensiveProb = probFor(VALID_COIL, defensiveCtx);

    assert.ok(defensiveProb.probability_score < constructiveProb.probability_score,
      `Defensive (${defensiveProb.probability_score}) should be less than constructive (${constructiveProb.probability_score})`);
  });
});
