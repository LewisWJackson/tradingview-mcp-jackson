#!/usr/bin/env node
/**
 * Coiled Spring Scanner v2 — Main Orchestrator
 *
 * Ties Stage 1/1b (Yahoo screen) + scoring engine together.
 * Writes coiled_spring_results.json.
 *
 * Usage:
 *   node scripts/scanner/coiled_spring_scanner.js [--top=N]
 *
 *   --top=N   Max candidates to output (default 20)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runStage1 } from './yahoo_screen_v2.js';
import {
  scoreTrendHealth,
  scoreContractionQuality,
  scoreVolumeSignature,
  scorePivotStructure,
  scoreCatalystAwareness,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
} from './scoring_v2.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const topArg = args.find((a) => a.startsWith('--top='));
const topN = topArg ? parseInt(topArg.split('=')[1], 10) || 20 : 20;

// ---------------------------------------------------------------------------
// Sector mapping (symbol → sector ETF)
// ---------------------------------------------------------------------------

const SECTOR_MAP = {
  // This is a simplified mapping. For full accuracy, use Yahoo's sector field.
  // The scanner uses sectorRankings from fetchMarketRegime instead.
};

function getSectorRank(symbol, quote, sectorRankings) {
  // Use Yahoo sector field if available, map to ETF, find rank
  // Fallback: return 6 (middle of pack)
  return 6;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Coiled Spring Scanner v2 ===\n');

  // 1. Load universe
  const universeFile = resolve(__dirname, 'universe.json');
  const universe = JSON.parse(readFileSync(universeFile, 'utf-8'));
  const symbols = universe.symbols || universe;

  // 2. Run Stage 1 + 1b
  const { candidates, marketRegime, sectorRankings, stats } = await runStage1(symbols);

  console.log(`\n[scoring] scoring ${candidates.length} candidates...\n`);

  // 3. Score each candidate
  const scored = [];
  for (const c of candidates) {
    const sectorRank = getSectorRank(c.symbol, c, sectorRankings);

    const trend = scoreTrendHealth(c);
    const contraction = scoreContractionQuality(c);
    const volume = scoreVolumeSignature(c);
    const pivot = scorePivotStructure(c);
    const catalyst = scoreCatalystAwareness({
      ...c,
      sectorRank,
    });

    const composite = computeCompositeScore(
      { trend, contraction, volume, pivot, catalyst },
      { regime: marketRegime.regime, sectorRank },
    );

    const classification = classifyCandidate({
      score: composite.score,
      signals: composite.signals,
      distFromResistance: pivot.distFromResistance,
    });

    if (classification === 'below_threshold') continue;

    const play = generatePlay(c.symbol, classification, {
      ma50: c.ma50,
      distFromResistance: pivot.distFromResistance,
      price: c.price,
    }, marketRegime.regime);

    scored.push({
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      changePct: c.changePct,
      score: composite.score,
      scoreConfidence: composite.scoreConfidence,
      classification,
      breakoutRisk: composite.breakoutRisk,
      breakoutRiskDrivers: composite.breakoutRiskDrivers,
      redFlags: c.redFlags,
      signals: composite.signals,
      details: {
        ma50: c.ma50,
        ma150: c.ma150,
        ma200: c.ma200,
        maStacked: c.ma50 > c.ma150 && c.ma150 > c.ma200,
        relStrengthPctile: c.relStrengthPctile || 0,
        bbWidthPctile: contraction.bbWidthPctile,
        atrRatio: contraction.atrRatio,
        vcpContractions: contraction.vcpContractions,
        vcpDepths: contraction.vcpDepths,
        dailyRangePct: contraction.dailyRangePct,
        volDroughtRatio: volume.volDroughtRatio,
        accumulationDays: volume.accumulationDays,
        upDownVolRatio: volume.upDownVolRatio,
        distFromResistance: pivot.distFromResistance,
        resistanceTouches: pivot.resistanceTouches,
        extendedAbove50ma: pivot.extendedAbove50ma,
        earningsDaysOut: catalyst.earningsDaysOut,
        sectorMomentumRank: catalyst.sectorMomentumRank,
        shortFloat: catalyst.shortFloat,
        ivContext: c.ivContext,
        ivLabel: c.ivLabel,
      },
      play,
      news: c.news,
    });
  }

  // 4. Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, topN);

  // 5. Write output
  const output = {
    scanDate: new Date().toISOString().slice(0, 10),
    scannedAt: new Date().toISOString(),
    universe: stats.universe,
    stage1Passed: stats.passedFilter,
    marketRegime,
    results,
  };

  const outFile = resolve(__dirname, 'coiled_spring_results.json');
  writeFileSync(outFile, JSON.stringify(output, null, 2));

  // 6. Summary
  console.log(`\n=== Results ===`);
  console.log(`Market regime: ${marketRegime.regime} (VIX ${marketRegime.vixLevel})`);
  console.log(`Universe: ${stats.universe} → Stage 1: ${stats.passedFilter} → Scored: ${scored.length} → Top ${results.length}`);

  for (const r of results) {
    const conf = r.scoreConfidence === 'high' ? '' : ` [${r.scoreConfidence} confidence]`;
    const risk = r.breakoutRisk !== 'low' ? ` ⚠${r.breakoutRisk} risk` : '';
    const flags = r.redFlags.length > 0 ? ` 🚩${r.redFlags.join(',')}` : '';
    console.log(`  ${r.score} ${r.classification.padEnd(16)} ${r.symbol.padEnd(6)} $${r.price}${conf}${risk}${flags}`);
  }

  console.log(`\nOutput: ${outFile}`);
}

main().catch((err) => {
  console.error('Scanner failed:', err);
  process.exit(1);
});
