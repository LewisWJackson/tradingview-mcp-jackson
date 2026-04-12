#!/usr/bin/env node
/**
 * Explosion Potential Scanner — Main Orchestrator
 *
 * Ties Stage 1 (Yahoo screen) + scoring together, with optional Stage 2
 * (TradingView deep scan), and writes results to JSON.
 *
 * Usage:
 *   node scripts/scanner/explosion_scanner.js [--no-tv] [--top=N]
 *
 *   --no-tv   Skip TradingView deep scan (Yahoo-only scores)
 *   --top=N   Max candidates to output (default 20)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runStage1 } from './yahoo_screen.js';
import {
  scoreTrendStructure,
  scoreVolumeMomentum,
  scoreVolatilityContraction,
  scoreCatalystPremium,
  computeCompositeScore,
  classifyCandidate,
  generatePlay,
} from './scoring.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const noTv = args.includes('--no-tv');
const topArg = args.find((a) => a.startsWith('--top='));
const topN = topArg ? parseInt(topArg.split('=')[1], 10) || 20 : 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime() {
  return new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Scoring bridge — maps Yahoo candidate data to scoring inputs
// ---------------------------------------------------------------------------

function scoreCandidate(c) {
  // Trend structure
  const trendData = {
    price: c.price,
    ma50: c.ma50,
    ma150: c.ma150,
    ma200: c.ma200,
    ma200rising: c.ma200rising,
    high52w: c.high52w,
  };
  const trend = scoreTrendStructure(trendData);

  // Volume momentum
  const volumeData = {
    volumeRatio: c.volumeRatio,
    relStrengthTop20: c.relStrengthTop20,
  };
  const volume = scoreVolumeMomentum(volumeData);

  // VCP approximation: use price tightness vs 52-week range
  const priceRange = c.high52w - c.low52w;
  const recentRange = Math.abs(c.price - c.ma50);
  const bbWidthPctile = priceRange > 0 ? (recentRange / priceRange) * 100 : 50;
  const vcpData = {
    bbWidthPctile,
    atrContracting: bbWidthPctile < 25,
    nearPivot: c.distFrom52wkHigh > -5, // within 5% of 52-week high
  };
  const vcp = scoreVolatilityContraction(vcpData);

  // Catalyst premium
  const catalystData = {
    earningsWithin14d: false, // no earnings calendar in Stage 1
    ivRank: c.ivRank ?? 0,
    gapPct: Math.max(0, c.gapPct),
    gapVolumeRatio: c.gapVolumeRatio,
  };
  const catalyst = scoreCatalystPremium(catalystData);

  // Composite
  const { score, signals } = computeCompositeScore({ trend, volume, vcp, catalyst });

  // Build details object
  const details = {
    volumeRatio: c.volumeRatio,
    ivRank: c.ivRank,
    distFrom52wkHigh: c.distFrom52wkHigh,
    bbWidthPctile: +bbWidthPctile.toFixed(1),
    emaStacked: c.emaStacked,
    ma50: c.ma50,
    ma150: c.ma150,
    ma200: c.ma200,
    rsi: null,            // only available via TradingView Stage 2
    atrContracting: vcpData.atrContracting,
    earningsDays: null,   // no earnings calendar in Stage 1
    gapPct: c.gapPct,
    gapVolumeRatio: c.gapVolumeRatio,
  };

  // Classify and generate play
  const tags = classifyCandidate({ score, signals, details });
  const play = generatePlay(c.symbol, tags, details);

  return {
    symbol: c.symbol,
    name: c.name,
    price: c.price,
    changePct: c.changePct,
    score,
    tags,
    signals,
    details,
    play,
    screenshotPath: null,
    news: c.news || [],
  };
}

// ---------------------------------------------------------------------------
// Stage 2 — TradingView deep scan (optional)
// ---------------------------------------------------------------------------

async function runStage2(results) {
  let setSymbol, getStudyValues, captureScreenshot;

  try {
    const chartMod = await import('../../src/core/chart.js');
    const dataMod = await import('../../src/core/data.js');
    const captureMod = await import('../../src/core/capture.js');
    setSymbol = chartMod.setSymbol;
    getStudyValues = dataMod.getStudyValues;
    captureScreenshot = captureMod.captureScreenshot;
  } catch (err) {
    console.log(`[stage2] TradingView modules not available: ${err.message}`);
    console.log('[stage2] Skipping deep scan.');
    return false;
  }

  // Ensure screenshot directory exists
  const ssDir = resolve(__dirname, '../../screenshots/explosion');
  mkdirSync(ssDir, { recursive: true });

  console.log(`[stage2] Deep scanning ${results.length} candidates via TradingView...`);

  for (const r of results) {
    try {
      // Switch chart to symbol
      await setSymbol({ symbol: r.symbol });
      await sleep(2000); // wait for chart to load

      // Read study values (RSI, BB, ATR if indicators are loaded)
      const studies = await getStudyValues();
      if (studies?.success && studies.data) {
        // Try to extract RSI from study values
        for (const [, vals] of Object.entries(studies.data)) {
          if (vals?.RSI !== undefined) r.details.rsi = +vals.RSI.toFixed(1);
        }
      }

      // Capture screenshot
      const ss = await captureScreenshot({
        region: 'chart',
        filename: `explosion_${r.symbol}_${today()}`,
      });
      if (ss?.success && ss.path) {
        r.screenshotPath = ss.path;
      }

      console.log(`  [stage2] ${r.symbol} — done`);
    } catch (err) {
      console.log(`  [stage2] ${r.symbol} — error: ${err.message}`);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Explosion Potential Scanner ===');
  console.log(`Time: ${fmtTime()}`);

  // 1. Load universe
  const universeFile = resolve(__dirname, 'universe.json');
  const universe = JSON.parse(readFileSync(universeFile, 'utf-8'));
  const symbols = universe.symbols;
  console.log(`Universe: ${symbols.length} symbols (S&P 500 + Nasdaq 100 + Russell mid-cap)`);

  // 2. Run Stage 1
  const { candidates, stats } = await runStage1(symbols);

  // 3. Score each candidate
  console.log('');
  const scored = candidates.map(scoreCandidate);

  // 4. Filter >= 50, sort descending, take top N
  const qualified = scored
    .filter((r) => r.score >= 50)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  console.log(`[scoring] ${candidates.length} scored → ${qualified.length} qualified (score >= 50)`);

  // 5. Optional Stage 2
  let tvDeepScan = false;
  if (!noTv && qualified.length > 0) {
    tvDeepScan = await runStage2(qualified);
  } else if (noTv) {
    console.log('[stage2] Skipped (--no-tv flag)');
  }

  // 6. Build output
  const output = {
    scanDate: today(),
    scannedAt: new Date().toISOString(),
    universe: stats.universe,
    stage1Passed: stats.passed,
    tvDeepScan,
    results: qualified,
  };

  // 7. Write results
  const outPath = resolve(__dirname, 'explosion_results.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  // 8. Print summary
  console.log('');
  console.log(`Results written to scripts/scanner/explosion_results.json`);
  console.log(`  ${stats.universe} scanned → ${stats.passed} Stage 1 → ${qualified.length} qualified`);

  if (qualified.length > 0) {
    const show = Math.min(5, qualified.length);
    console.log('');
    console.log(`=== Top ${show} ===`);
    for (let i = 0; i < show; i++) {
      const r = qualified[i];
      const tagStr = r.tags.join(', ');
      const playShort = r.play.length > 60
        ? r.play.slice(0, 60) + '...'
        : r.play;
      console.log(`  ${r.symbol.padEnd(6)} ${String(r.score).padStart(3)}/100  ${tagStr.padEnd(18)}  ${playShort}`);
    }
  } else {
    console.log('');
    console.log('No candidates scored >= 50. Try on a higher-volume trading day.');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
