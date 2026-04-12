/**
 * Unit tests for the Explosion Potential scoring engine.
 * Pure logic — no TradingView connection needed.
 *
 * Run: node --test tests/explosion_scanner.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreTrendStructure,
  scoreVolumeMomentum,
  scoreVolatilityContraction,
  scoreCatalystPremium,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
} from '../scripts/scanner/scoring.js';

// ---------------------------------------------------------------------------
// scoreTrendStructure (0-25 pts)
// ---------------------------------------------------------------------------
describe('scoreTrendStructure', () => {
  it('returns max 25 when all conditions met', () => {
    const score = scoreTrendStructure({
      price: 100, ma50: 90, ma150: 85, ma200: 80,
      ma200rising: true, high52w: 105,
    });
    assert.equal(score, 25);
  });

  it('returns 0 when no conditions met', () => {
    const score = scoreTrendStructure({
      price: 50, ma50: 60, ma150: 55, ma200: 70,
      ma200rising: false, high52w: 200,
    });
    assert.equal(score, 0);
  });

  it('gives 10 pts when price > all three MAs but nothing else', () => {
    // price > ma50, ma150, ma200 => 10
    // ma200rising false => 0
    // price 100 vs high52w 200 => 50% away => 0
    // ma150 > ma200 but price < ma150? No, price > ma150 here. Stacked: price > ma150 > ma200 => 5
    // Actually let me be precise: price=100 > ma50=90, ma150=95, ma200=99
    // stacked: ma150(95) < ma200(99)? No. So no stacked points.
    const score = scoreTrendStructure({
      price: 100, ma50: 90, ma150: 95, ma200: 99,
      ma200rising: false, high52w: 200,
    });
    // price > all 3 MAs = 10, 200 not rising = 0, 50% from high = 0, ma150 < ma200 = 0
    assert.equal(score, 10);
  });

  it('gives 5 pts for 200-day MA rising alone', () => {
    const score = scoreTrendStructure({
      price: 50, ma50: 60, ma150: 55, ma200: 70,
      ma200rising: true, high52w: 200,
    });
    assert.equal(score, 5);
  });

  it('gives 5 pts for within 25% of 52-week high', () => {
    // price 80, high52w 100 => 20% away => within 25% => 5
    // but price < ma50 etc so no other points
    const score = scoreTrendStructure({
      price: 80, ma50: 90, ma150: 85, ma200: 95,
      ma200rising: false, high52w: 100,
    });
    assert.equal(score, 5);
  });

  it('gives 5 pts for stacked MAs (price > 150 > 200)', () => {
    // price > ma150 > ma200 => 5 for stacked
    // but price < ma50 => no "above all 3"
    const score = scoreTrendStructure({
      price: 100, ma50: 110, ma150: 90, ma200: 80,
      ma200rising: false, high52w: 200,
    });
    assert.equal(score, 5);
  });

  it('handles edge case: price exactly equals MA (not above)', () => {
    const score = scoreTrendStructure({
      price: 100, ma50: 100, ma150: 100, ma200: 100,
      ma200rising: false, high52w: 100,
    });
    // price not strictly > any MA => 0 for above-all
    // price == high52w => within 0% => 5 for near high
    // ma150 == ma200 => not strictly > => 0 stacked
    assert.equal(score, 5);
  });
});

// ---------------------------------------------------------------------------
// scoreVolumeMomentum (0-30 pts)
// ---------------------------------------------------------------------------
describe('scoreVolumeMomentum', () => {
  it('returns 30 for 5x+ volume ratio', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 5, relStrengthTop20: false });
    assert.equal(score, 30);
  });

  it('returns 20 for 3x volume ratio', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 3, relStrengthTop20: false });
    assert.equal(score, 20);
  });

  it('returns 10 for 2x volume ratio', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 2, relStrengthTop20: false });
    assert.equal(score, 10);
  });

  it('returns 0 for low volume ratio', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 1.5, relStrengthTop20: false });
    assert.equal(score, 0);
  });

  it('adds 5 for relative strength top 20% but caps at 30', () => {
    // 5x volume = 30 + 5 RS = 35, capped to 30
    const score = scoreVolumeMomentum({ volumeRatio: 5, relStrengthTop20: true });
    assert.equal(score, 30);
  });

  it('adds 5 for RS on top of 2x volume (uncapped)', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 2, relStrengthTop20: true });
    assert.equal(score, 15);
  });

  it('gives 5 for RS alone with no volume spike', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 1, relStrengthTop20: true });
    assert.equal(score, 5);
  });

  it('handles exactly 5x boundary', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 5.0, relStrengthTop20: false });
    assert.equal(score, 30);
  });

  it('handles between 3x and 5x (should give 20)', () => {
    const score = scoreVolumeMomentum({ volumeRatio: 4, relStrengthTop20: false });
    assert.equal(score, 20);
  });
});

// ---------------------------------------------------------------------------
// scoreVolatilityContraction (0-25 pts)
// ---------------------------------------------------------------------------
describe('scoreVolatilityContraction', () => {
  it('returns max 25 when all conditions met', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 20, atrContracting: true, nearPivot: true,
    });
    assert.equal(score, 25);
  });

  it('returns 0 when no conditions met', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 50, atrContracting: false, nearPivot: false,
    });
    assert.equal(score, 0);
  });

  it('gives 10 for BB width in bottom 25%', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 25, atrContracting: false, nearPivot: false,
    });
    assert.equal(score, 10);
  });

  it('gives 10 for ATR contracting', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 50, atrContracting: true, nearPivot: false,
    });
    assert.equal(score, 10);
  });

  it('gives 5 for near pivot', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 50, atrContracting: false, nearPivot: true,
    });
    assert.equal(score, 5);
  });

  it('handles edge: bbWidthPctile exactly 25 (in bottom 25%)', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 25, atrContracting: false, nearPivot: false,
    });
    assert.equal(score, 10);
  });

  it('bbWidthPctile 26 does not qualify', () => {
    const score = scoreVolatilityContraction({
      bbWidthPctile: 26, atrContracting: false, nearPivot: false,
    });
    assert.equal(score, 0);
  });
});

// ---------------------------------------------------------------------------
// scoreCatalystPremium (0-20 pts)
// ---------------------------------------------------------------------------
describe('scoreCatalystPremium', () => {
  it('returns max 20 with all conditions met', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: true, ivRank: 80, gapPct: 6, gapVolumeRatio: 2.5,
    });
    // earnings 5 + ivRank>75 10 + gap 5 = 20
    assert.equal(score, 20);
  });

  it('returns 0 with no catalysts', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 30, gapPct: 1, gapVolumeRatio: 1,
    });
    assert.equal(score, 0);
  });

  it('gives 5 for earnings within 14 days', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: true, ivRank: 30, gapPct: 0, gapVolumeRatio: 0,
    });
    assert.equal(score, 5);
  });

  it('gives 10 for IV rank > 75', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 76, gapPct: 0, gapVolumeRatio: 0,
    });
    assert.equal(score, 10);
  });

  it('gives 5 for IV rank > 50 (but not > 75)', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 60, gapPct: 0, gapVolumeRatio: 0,
    });
    assert.equal(score, 5);
  });

  it('IV rank > 75 replaces the > 50 tier (not additive)', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 80, gapPct: 0, gapVolumeRatio: 0,
    });
    assert.equal(score, 10);
  });

  it('gives 5 for gap >= 5% on 2x+ volume', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 0, gapPct: 5, gapVolumeRatio: 2,
    });
    assert.equal(score, 5);
  });

  it('no gap points if volume ratio < 2', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 0, gapPct: 10, gapVolumeRatio: 1.5,
    });
    assert.equal(score, 0);
  });

  it('no gap points if gap < 5%', () => {
    const score = scoreCatalystPremium({
      earningsWithin14d: false, ivRank: 0, gapPct: 4.9, gapVolumeRatio: 3,
    });
    assert.equal(score, 0);
  });

  it('caps at 20 even if all sub-scores exceed', () => {
    // earnings 5 + ivRank>75 10 + gap 5 = 20 (exactly at cap)
    const score = scoreCatalystPremium({
      earningsWithin14d: true, ivRank: 80, gapPct: 10, gapVolumeRatio: 5,
    });
    assert.equal(score, 20);
  });
});

// ---------------------------------------------------------------------------
// computeCompositeScore
// ---------------------------------------------------------------------------
describe('computeCompositeScore', () => {
  it('sums all four sub-scores', () => {
    const result = computeCompositeScore({
      trend: 20, volume: 25, vcp: 15, catalyst: 10,
    });
    assert.equal(result.score, 70);
    assert.deepEqual(result.signals, {
      trendStructure: 20,
      volumeMomentum: 25,
      volatilityContraction: 15,
      catalystPremium: 10,
    });
  });

  it('handles all zeros', () => {
    const result = computeCompositeScore({
      trend: 0, volume: 0, vcp: 0, catalyst: 0,
    });
    assert.equal(result.score, 0);
  });

  it('handles max scores (25+30+25+20 = 100)', () => {
    const result = computeCompositeScore({
      trend: 25, volume: 30, vcp: 25, catalyst: 20,
    });
    assert.equal(result.score, 100);
  });
});

// ---------------------------------------------------------------------------
// classifyCandidate
// ---------------------------------------------------------------------------
describe('classifyCandidate', () => {
  it('returns accumulate when score >= 60, emaStacked, ivRank < 40', () => {
    const tags = classifyCandidate({
      score: 65,
      signals: { trendStructure: 20 },
      details: { emaStacked: true, ivRank: 30, earningsWithin14d: false, gapPct: 2, gapVolumeRatio: 1 },
    });
    assert.ok(tags.includes('accumulate'));
  });

  it('returns harvest when score >= 50, ivRank > 50, earningsWithin14d', () => {
    const tags = classifyCandidate({
      score: 55,
      signals: { trendStructure: 15 },
      details: { emaStacked: false, ivRank: 60, earningsWithin14d: true, gapPct: 0, gapVolumeRatio: 0 },
    });
    assert.ok(tags.includes('harvest'));
  });

  it('returns episodic_pivot for gap >= 10% on 3x volume', () => {
    const tags = classifyCandidate({
      score: 40,
      signals: { trendStructure: 10 },
      details: { emaStacked: false, ivRank: 30, earningsWithin14d: false, gapPct: 12, gapVolumeRatio: 4 },
    });
    assert.ok(tags.includes('episodic_pivot'));
  });

  it('returns multiple tags when conditions overlap', () => {
    const tags = classifyCandidate({
      score: 65,
      signals: { trendStructure: 20 },
      details: { emaStacked: true, ivRank: 60, earningsWithin14d: true, gapPct: 15, gapVolumeRatio: 5 },
    });
    // accumulate: score>=60, emaStacked, but ivRank 60 >= 40 => NO accumulate
    // harvest: score>=50, ivRank>50, earnings => YES
    // episodic_pivot: gap>=10, volRatio>=3 => YES
    assert.ok(tags.includes('harvest'));
    assert.ok(tags.includes('episodic_pivot'));
    assert.ok(!tags.includes('accumulate')); // ivRank too high
  });

  it('falls back to harvest if score >= 50, no tag, ivRank > 50', () => {
    const tags = classifyCandidate({
      score: 55,
      signals: { trendStructure: 15 },
      details: { emaStacked: false, ivRank: 55, earningsWithin14d: false, gapPct: 0, gapVolumeRatio: 0 },
    });
    assert.ok(tags.includes('harvest'));
  });

  it('falls back to accumulate if score >= 50, no tag, ivRank <= 50', () => {
    const tags = classifyCandidate({
      score: 55,
      signals: { trendStructure: 15 },
      details: { emaStacked: false, ivRank: 40, earningsWithin14d: false, gapPct: 0, gapVolumeRatio: 0 },
    });
    assert.ok(tags.includes('accumulate'));
  });

  it('returns empty array if score < 50 and no episodic pivot', () => {
    const tags = classifyCandidate({
      score: 30,
      signals: { trendStructure: 5 },
      details: { emaStacked: false, ivRank: 20, earningsWithin14d: false, gapPct: 2, gapVolumeRatio: 1 },
    });
    assert.deepEqual(tags, []);
  });
});

// ---------------------------------------------------------------------------
// generatePlay
// ---------------------------------------------------------------------------
describe('generatePlay', () => {
  it('returns a non-empty string', () => {
    const play = generatePlay('AAPL', ['accumulate'], { ivRank: 30, earningsWithin14d: false });
    assert.equal(typeof play, 'string');
    assert.ok(play.length > 0);
  });

  it('mentions the symbol in the output', () => {
    const play = generatePlay('TSLA', ['harvest'], { ivRank: 70, earningsWithin14d: true });
    assert.ok(play.includes('TSLA'));
  });

  it('handles episodic_pivot tag', () => {
    const play = generatePlay('NVDA', ['episodic_pivot'], { gapPct: 12, gapVolumeRatio: 4 });
    assert.equal(typeof play, 'string');
    assert.ok(play.length > 0);
  });

  it('handles multiple tags', () => {
    const play = generatePlay('AMD', ['harvest', 'episodic_pivot'], { ivRank: 80, gapPct: 10, gapVolumeRatio: 3 });
    assert.equal(typeof play, 'string');
    assert.ok(play.length > 0);
  });

  it('handles empty tags array', () => {
    const play = generatePlay('XYZ', [], { ivRank: 20 });
    assert.equal(typeof play, 'string');
    assert.ok(play.length > 0);
  });
});
