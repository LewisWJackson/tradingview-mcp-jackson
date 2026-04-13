#!/usr/bin/env node
/**
 * Coiled Spring Scanner v3 — Main Orchestrator
 *
 * Ties Stage 1/1b (Yahoo screen) + scoring engine + benchmark data together.
 * Writes coiled_spring_results.json.
 *
 * Usage:
 *   node scripts/scanner/coiled_spring_scanner.js [--top=N]
 *
 *   --top=N   Max candidates to output (default 15)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runStage1, fetchOHLCV, getCrumb } from './yahoo_screen_v2.js';
import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  computeProbabilityScore,
  classifyCandidate,
  generatePlay,
  calcSectorMomentumRank,
  calcRiskCategory,
  calcEntryTrigger,
  generateNotes,
  calcConfidenceBand,
  REGIME_MULTIPLIERS,
} from './scoring_v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const topArg = args.find((a) => a.startsWith('--top='));
const topN = topArg ? parseInt(topArg.split('=')[1], 10) || 15 : 15;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Weighted multi-factor ranking.
 * @param {Array} results - Scored candidate results
 * @returns {Array} - Same array with .rank field set, sorted by weighted rank
 */
export function weightedRank(results) {
  if (results.length === 0) return results;

  const factors = [
    { key: 'probability', weight: 0.40, extract: r => r.probability_score || 0 },
    { key: 'contraction', weight: 0.25, extract: r => r.signals?.contraction || r.details?.contraction || 0 },
    { key: 'institutional', weight: 0.20, extract: r => (r.details?.accDistScore || 0) + (r.details?.obvSlopeNormalized || 0) },
    { key: 'resistance', weight: 0.15, extract: r => {
      const strength = r.details?.resistanceStrength || r.resistance_strength || 0;
      const dist = r.details?.distFromResistance || r.distance_to_resistance || 100;
      return dist > 0 ? strength / dist : 0;
    }}
  ];

  // Rank per factor (higher value = better = rank 1)
  for (const factor of factors) {
    const sorted = [...results].sort((a, b) => factor.extract(b) - factor.extract(a));
    sorted.forEach((item, idx) => {
      if (!item._factorRanks) item._factorRanks = {};
      item._factorRanks[factor.key] = idx + 1;
    });
  }

  // Weighted average rank
  for (const r of results) {
    r._weightedRank = factors.reduce((sum, f) => sum + (r._factorRanks[f.key] * f.weight), 0);
  }

  // Sort by weighted rank (lower = better), break ties by probability
  results.sort((a, b) => a._weightedRank - b._weightedRank || (b.probability_score || 0) - (a.probability_score || 0));

  // Assign final rank and clean up temp fields
  results.forEach((r, idx) => {
    r.rank = idx + 1;
    delete r._factorRanks;
    delete r._weightedRank;
  });

  return results;
}

async function main() {
  console.log('=== Coiled Spring Scanner v3 ===\n');

  // 1. Load universe
  const universeFile = resolve(__dirname, 'universe.json');
  const universe = JSON.parse(readFileSync(universeFile, 'utf-8'));
  const symbols = universe.symbols || universe;

  // 2. Run Stage 1 + 1b
  const { candidates, marketRegime, sectorRankings, stats } = await runStage1(symbols);

  // 3. Fetch benchmark data (SPY, QQQ, sector ETFs)
  console.log('  Fetching benchmark data (SPY, QQQ, sector ETFs)...');
  const SECTOR_ETF_LIST = ['XLK', 'XLF', 'XLV', 'XLE', 'XLI', 'XLY', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC'];
  const benchmarkSymbols = ['SPY', 'QQQ', ...SECTOR_ETF_LIST];

  const { crumb, cookies } = await getCrumb();
  const benchmarkData = {};
  for (const sym of benchmarkSymbols) {
    const result = await fetchOHLCV(sym, crumb, cookies);
    benchmarkData[sym] = result.bars || [];
  }

  const spyOhlcv = benchmarkData['SPY'] || [];
  const qqqOhlcv = benchmarkData['QQQ'] || [];
  const sectorETFData = {};
  for (const etf of SECTOR_ETF_LIST) {
    sectorETFData[etf] = benchmarkData[etf] || [];
  }
  const sectorRanks = calcSectorMomentumRank(sectorETFData);
  console.log(`  Benchmarks loaded. Top sectors: ${JSON.stringify(Object.entries(sectorRanks).sort((a, b) => a[1] - b[1]).slice(0, 3).map(([s, r]) => `${s}=#${r}`))}`);

  console.log(`\n[scoring] scoring ${candidates.length} candidates...\n`);

  // 4. Score each candidate
  const scored = [];
  for (const c of candidates) {
    const scoringContext = {
      regime: marketRegime,
      spyOhlcv,
      qqqOhlcv,
      sectorRanks,
      candidateSector: c.sector || '',
    };

    const trend = scoreTrendHealth(c, scoringContext);
    const contraction = scoreContractionQuality(c);
    const volume = scoreVolumeSignature(c);
    const pivot = scorePivotStructure(c);
    const catalyst = scoreCatalystAwareness(c, scoringContext);

    const composite = computeCompositeScore(
      { trend, contraction, volume, pivot, catalyst },
      { regime: marketRegime.regime },
    );

    const signals = { trendHealth: trend, contraction, volumeSignature: volume, pivotProximity: pivot, catalystAwareness: catalyst };
    const probability = computeProbabilityScore(signals, scoringContext);
    const confidence_band = calcConfidenceBand(probability.probability_score, signals, scoringContext);

    const classification = classifyCandidate({
      score: composite.score,
      price: c.price,
      avgVol10d: c.avgVol10d,
      signals: composite.signals,
      details: {
        distFromResistance: pivot.distFromResistance,
        extendedAbove50ma: pivot.extendedAbove50ma,
        extensionPct: c.ma50 > 0 ? ((c.price - c.ma50) / c.ma50 * 100) : 0,
        hasLargeGap: pivot.gapFormedResistance || false,
        atrExpanding: false,
      },
    });

    if (classification === 'below_threshold' || classification === 'disqualified') continue;

    const { risk_category, suggested_stop_percent } = calcRiskCategory(classification, {
      vcpContractions: contraction.vcpContractions,
      atrPercentile: contraction.atrPercentile || 50,
    });

    const { entry_trigger } = calcEntryTrigger(classification, {
      resistancePrice: pivot.resistancePrice || 0,
      ma50: c.ma50,
    });

    const notes = generateNotes(
      { contraction, catalystAwareness: catalyst },
      { sectorMomentumRank: catalyst.sectorMomentumRank, earningsDaysOut: catalyst.earningsDaysOut },
    );

    const trade_readiness = probability.trade_readiness &&
      (classification === 'coiled_spring' || classification === 'catalyst_loaded') &&
      composite.breakoutRisk !== 'high';

    const play = generatePlay(c.symbol, classification, {
      ma50: c.ma50,
      distFromResistance: pivot.distFromResistance,
      price: c.price,
    }, marketRegime.regime);

    scored.push({
      rank: 0,
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      changePct: c.changePct,
      probability_score: probability.probability_score,
      setup_quality: probability.setup_quality,
      trade_readiness,
      setup_type: classification,
      composite_score: composite.score,
      composite_confidence: composite.scoreConfidence,
      distance_to_resistance: pivot.distFromResistance,
      resistance_strength: pivot.resistanceStrength || 1,
      risk_level: composite.breakoutRisk,
      risk_category,
      suggested_stop_percent,
      entry_trigger,
      catalyst_tag: catalyst.catalystTag || 'catalyst_unknown',
      regime_multiplier: probability.regime_multiplier,
      confidence_band,
      factor_breakdown: probability.factor_breakdown,
      signals: composite.signals,
      details: {
        ma50: c.ma50, ma150: c.ma150, ma200: c.ma200,
        maStacked: c.ma50 > c.ma150 && c.ma150 > c.ma200,
        relStrengthPctile: c.relStrengthPctile || 0,
        bbWidthPctile: contraction.bbWidthPctile,
        atrRatio: contraction.atrRatio,
        atrPercentile: contraction.atrPercentile,
        vcpContractions: contraction.vcpContractions,
        vcpDepths: contraction.vcpDepths,
        vcpQuality: contraction.vcpQuality,
        dailyRangePct: contraction.dailyRangePct,
        confirmingSignals: contraction.confirmingSignals,
        volDroughtRatio: volume.volDroughtRatio,
        accDistScore: volume.accDistScore,
        upDownVolRatio: volume.upDownVolRatio,
        obvSlopeNormalized: volume.obvSlopeNormalized,
        supportVolumeRatio: volume.supportVolumeRatio,
        distFromResistance: pivot.distFromResistance,
        resistanceTouches: pivot.resistanceTouches,
        resistanceStrength: pivot.resistanceStrength,
        extendedAbove50ma: pivot.extendedAbove50ma,
        gapFormedResistance: pivot.gapFormedResistance,
        earningsDaysOut: catalyst.earningsDaysOut,
        sectorMomentumRank: catalyst.sectorMomentumRank,
        shortFloat: catalyst.shortFloat,
        ivContext: c.ivContext, ivLabel: c.ivLabel,
      },
      breakout_risk: composite.breakoutRisk,
      breakout_risk_drivers: composite.breakoutRiskDrivers,
      red_flags: c.redFlags || [],
      play,
      notes,
      news: c.news || [],
    });
  }

  // 5. Weighted multi-factor ranking, take top N
  weightedRank(scored);
  const results = scored.slice(0, topN);

  const regimeMultiplier = REGIME_MULTIPLIERS[marketRegime.regime] || 1.0;

  // 6. Write output
  const output = {
    scanDate: new Date().toISOString().slice(0, 10),
    scannedAt: new Date().toISOString(),
    universe: stats.universe,
    stage1Passed: stats.passedFilter,
    marketRegime,
    regimeMultiplier,
    benchmarks: {
      spy20dReturn: spyOhlcv.length >= 21 ? Math.round(((spyOhlcv[spyOhlcv.length - 1].close - spyOhlcv[spyOhlcv.length - 21].close) / spyOhlcv[spyOhlcv.length - 21].close) * 10000) / 10000 : null,
      qqq20dReturn: qqqOhlcv.length >= 21 ? Math.round(((qqqOhlcv[qqqOhlcv.length - 1].close - qqqOhlcv[qqqOhlcv.length - 21].close) / qqqOhlcv[qqqOhlcv.length - 21].close) * 10000) / 10000 : null,
    },
    sectorRanks,
    results,
  };

  const outFile = resolve(__dirname, 'coiled_spring_results.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  // 7. Summary
  console.log(`\n=== Results ===`);
  console.log(`Market regime: ${marketRegime.regime} (VIX ${marketRegime.vixLevel}) | Multiplier: ${regimeMultiplier}`);
  console.log(`Universe: ${stats.universe} → Stage 1: ${stats.passedFilter} → Scored: ${scored.length} → Top ${results.length}`);

  for (const r of results) {
    const quality = r.setup_quality.padEnd(8);
    const risk = r.risk_level !== 'low' ? ` ⚠${r.risk_level}` : '';
    const flags = (r.red_flags || []).length > 0 ? ` 🚩${r.red_flags.join(',')}` : '';
    const band = r.confidence_band ? `${r.confidence_band.low}-${r.confidence_band.mid}-${r.confidence_band.high}%` : `${r.probability_score}%`;
    console.log(`  #${r.rank} ${band.padEnd(12)} ${quality} ${r.setup_type.padEnd(16)} ${r.symbol.padEnd(6)} $${r.price} | ${r.entry_trigger}${risk}${flags}`);
  }

  console.log(`\nOutput: ${outFile}`);
}

// Only run main() when executed directly, not when imported for testing
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMainModule) {
  main().catch((err) => {
    console.error('Scanner failed:', err);
    process.exit(1);
  });
}
