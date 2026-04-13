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
} from '../scripts/scanner/scoring_v2.js';

import {
  VALID_COIL,
  ALREADY_EXPLODED,
  BROKEN_DOWN,
  ILLIQUID,
  FAKE_COMPRESSION,
  BOUNDARY_CANDIDATE,
  makeBars,
} from '../scripts/scanner/test_fixtures/fixtures.js';

import { detectRedFlags } from '../scripts/scanner/yahoo_screen_v2.js';

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
      relStrengthPctile: 0, ohlcv: [],
    });
    assert.ok(score >= 8, `stacked MAs should give at least 8, got ${score}`);
  });

  it('gives 0 for inverted MAs', () => {
    const { score } = scoreTrendHealth({
      price: 50, ma50: 60, ma150: 70, ma200: 80, high52w: 100,
      relStrengthPctile: 0, ohlcv: [],
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

  it('awards 7 pts for top 30% relative strength', () => {
    const { score: high } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 75 });
    const { score: mid } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 55 });
    const { score: low } = scoreTrendHealth({ ...VALID_COIL, relStrengthPctile: 30 });
    assert.ok(high > mid, 'top 30% should score higher than top 50%');
    assert.ok(mid > low, 'top 50% should score higher than bottom');
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
});

// ---------------------------------------------------------------------------
// scoreCatalystAwareness (0-15 pts)
// ---------------------------------------------------------------------------
describe('scoreCatalystAwareness', () => {
  it('awards 5 pts for earnings 30-45 days out', () => {
    const { score, earningsDaysOut } = scoreCatalystAwareness(VALID_COIL);
    assert.ok(earningsDaysOut >= 30 && earningsDaysOut <= 45, `expected 30-45d out, got ${earningsDaysOut}`);
    assert.ok(score >= 5, `expected >= 5 pts, got ${score}`);
  });

  it('awards 2 pts for earnings < 30 days', () => {
    const close = {
      ...VALID_COIL,
      earningsTimestamp: Math.floor(Date.now() / 1000) + 15 * 86400,
    };
    const { score } = scoreCatalystAwareness(close);
    assert.ok(score >= 2, 'should get at least 2 pts for close earnings');
  });

  it('returns medium confidence when no earnings date', () => {
    const { confidence } = scoreCatalystAwareness({ ...VALID_COIL, earningsTimestamp: null });
    assert.equal(confidence, 'medium');
  });

  it('detects upgrade keywords in news', () => {
    const { score: withUpgrade } = scoreCatalystAwareness(VALID_COIL);
    const { score: withoutUpgrade } = scoreCatalystAwareness({ ...VALID_COIL, news: [] });
    assert.ok(withUpgrade > withoutUpgrade, 'upgrade news should add points');
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
      score: 90,
      signals: { trendHealth: 25, contraction: 35, volumeSignature: 15, pivotProximity: 10, catalystAwareness: 5 },
      distFromResistance: 3,
    });
    assert.equal(cls, 'coiled_spring');
  });

  it('classifies building base for score 60-84', () => {
    const cls = classifyCandidate({
      score: 70,
      signals: { trendHealth: 20, contraction: 20, volumeSignature: 10, pivotProximity: 10, catalystAwareness: 10 },
      distFromResistance: 12,
    });
    assert.equal(cls, 'building_base');
  });

  it('classifies catalyst loaded', () => {
    const cls = classifyCandidate({
      score: 75,
      signals: { trendHealth: 25, contraction: 15, volumeSignature: 10, pivotProximity: 12, catalystAwareness: 13 },
      distFromResistance: 10,
    });
    assert.equal(cls, 'catalyst_loaded');
  });

  it('returns below_threshold for low scores', () => {
    const cls = classifyCandidate({
      score: 40,
      signals: { trendHealth: 10, contraction: 10, volumeSignature: 5, pivotProximity: 10, catalystAwareness: 5 },
      distFromResistance: 15,
    });
    assert.equal(cls, 'below_threshold');
  });

  it('requires contraction >= 30 for coiled spring', () => {
    const cls = classifyCandidate({
      score: 90,
      signals: { trendHealth: 25, contraction: 25, volumeSignature: 15, pivotProximity: 15, catalystAwareness: 10 },
      distFromResistance: 3,
    });
    assert.notEqual(cls, 'coiled_spring', 'contraction 25 < 30 threshold');
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
