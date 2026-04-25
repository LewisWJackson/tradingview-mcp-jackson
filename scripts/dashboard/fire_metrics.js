#!/usr/bin/env node
/**
 * Compute daily + rolling metrics from the fire audit logs, separated by
 * Fire Level (2 vs 3) so we can answer: does Level 3 outperform Level 2?
 *
 * Tagged outcomes (continued/faded/whipsaw/...) and MFE/MAE come from
 * outcome_tagger.js (Task 19).
 *
 * Usage:
 *   node scripts/dashboard/fire_metrics.js                   # all dates
 *   node scripts/dashboard/fire_metrics.js --date=YYYY-MM-DD
 *   node scripts/dashboard/fire_metrics.js --since=YYYY-MM-DD
 *   node scripts/dashboard/fire_metrics.js --json            # machine-readable
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRES_DIR = path.resolve(__dirname, '..', '..', 'data');

function parseArgs(argv) {
  const args = { date: null, since: null, json: false };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) args.date = a.split('=')[1];
    else if (a.startsWith('--since=')) args.since = a.split('=')[1];
    else if (a === '--json') args.json = true;
  }
  return args;
}

export function loadFiresFromDir(firesDir, { date = null, since = null } = {}) {
  if (!fs.existsSync(firesDir)) return [];
  const all = [];
  const files = fs.readdirSync(firesDir)
    .filter(f => /^coiled_spring_fires_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => ({ filename: f, date: f.match(/\d{4}-\d{2}-\d{2}/)[0] }))
    .filter(f => !date || f.date === date)
    .filter(f => !since || f.date >= since)
    .sort((a, b) => a.date.localeCompare(b.date));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(firesDir, f.filename), 'utf8'));
      for (const fire of (data.fires || [])) {
        all.push({ ...fire, date: data.date });
      }
    } catch (e) {
      // skip corrupted files; metrics are best-effort over the audit corpus
    }
  }
  return all;
}

function avg(arr) {
  if (!arr.length) return null;
  return +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2);
}

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pure metrics computation. Given an array of fire objects, returns a fully
 * structured metrics report. Used by the CLI and the test harness.
 */
export function computeMetrics(fires) {
  const total = fires.length;
  if (total === 0) {
    return { total: 0, byLevel: { 2: emptyLevelStats(), 3: emptyLevelStats() }, comparison: null };
  }

  // Group fires by level (2 or 3) and "other" (level 1 or unknown)
  const byLevel = { 2: groupedFires(fires.filter(f => f.fireStrength === 2)), 3: groupedFires(fires.filter(f => f.fireStrength === 3)) };

  // Days covered (unique date strings)
  const days = new Set(fires.map(f => f.date)).size;

  // Risk band distribution (overall, not split by level)
  const riskBand = countBy(fires, f => f.riskFlags?.overallRiskBand || 'unknown');

  // Latency: median in ms
  const latencies = fires.map(f => f.debounce?.latencyFromFirstCrossMs).filter(v => typeof v === 'number');
  const medianLatencyMs = latencies.length ? median(latencies) : null;

  // Degraded source count (anything other than 'yahoo')
  const degraded = fires.filter(f => f.audit?.activeSource && f.audit.activeSource !== 'yahoo').length;

  // Comparison verdict
  const comparison = makeComparison(byLevel[2], byLevel[3]);

  return {
    total,
    days,
    firesPerDay: days ? +(total / days).toFixed(2) : null,
    byLevel,
    riskBand,
    medianLatencyMs,
    degradedSourceFires: degraded,
    comparison,
  };
}

function emptyLevelStats() {
  return {
    count: 0,
    tagged: 0,
    winRate: null,
    falseBreakoutRate: null,
    avgMFE: null,
    avgMAE: null,
    hindsightPlanDistribution: { STOCK_ONLY: 0, CSP_ONLY: 0, BOTH: 0, AVOID: 0, untagged: 0 },
  };
}

function groupedFires(fires) {
  const tagged = fires.filter(f => f.outcome);
  const wins = tagged.filter(f => f.outcome === 'continued').length;
  const false_ = tagged.filter(f => f.outcome === 'faded' || f.outcome === 'whipsaw').length;

  const mfes = fires.map(f => f.maxFavorableExcursionPct).filter(v => typeof v === 'number');
  const maes = fires.map(f => f.maxAdverseExcursionPct).filter(v => typeof v === 'number');

  const hindsight = { STOCK_ONLY: 0, CSP_ONLY: 0, BOTH: 0, AVOID: 0, untagged: 0 };
  for (const f of fires) {
    const h = f.hindsightPlan;
    if (h && hindsight.hasOwnProperty(h)) hindsight[h]++;
    else hindsight.untagged++;
  }

  return {
    count: fires.length,
    tagged: tagged.length,
    winRate: tagged.length ? +(wins / tagged.length).toFixed(3) : null,
    falseBreakoutRate: tagged.length ? +(false_ / tagged.length).toFixed(3) : null,
    avgMFE: avg(mfes),
    avgMAE: avg(maes),
    hindsightPlanDistribution: hindsight,
  };
}

function countBy(arr, keyFn) {
  const out = {};
  for (const x of arr) {
    const k = keyFn(x);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/**
 * Compares Level 2 vs Level 3 stats and returns a verdict:
 *   { l3OutperformsOnWinRate, l3OutperformsOnMFE, l3OutperformsOnMAE, verdict }
 *
 * verdict in {'level_3_better', 'level_2_better', 'mixed', 'insufficient_data'}
 */
export function makeComparison(l2, l3) {
  // Insufficient data: at least one level has no tagged fires
  if (l2.tagged === 0 || l3.tagged === 0) {
    return {
      l3OutperformsOnWinRate: null,
      l3OutperformsOnMFE: null,
      l3OutperformsOnMAE: null,
      verdict: 'insufficient_data',
      note: `L2 tagged: ${l2.tagged}, L3 tagged: ${l3.tagged}. Need at least one tagged fire at each level.`,
    };
  }

  const winBetter = l3.winRate > l2.winRate;
  const winWorse = l3.winRate < l2.winRate;
  // Ternary signals: true = L3 wins, false = L2 wins, null = tie / undefined
  const mfeBetter = (l3.avgMFE != null && l2.avgMFE != null)
    ? (l3.avgMFE === l2.avgMFE ? null : l3.avgMFE > l2.avgMFE)
    : null;
  const maeBetter = (l3.avgMAE != null && l2.avgMAE != null)
    ? (l3.avgMAE === l2.avgMAE ? null : l3.avgMAE < l2.avgMAE) // less adverse excursion is better
    : null;

  let verdict;
  const goodSignals = [winBetter === true, mfeBetter === true, maeBetter === true].filter(Boolean).length;
  const badSignals = [winWorse === true, mfeBetter === false, maeBetter === false].filter(Boolean).length;
  if (goodSignals > badSignals) verdict = 'level_3_better';
  else if (badSignals > goodSignals) verdict = 'level_2_better';
  else verdict = 'mixed';

  return {
    l3OutperformsOnWinRate: winBetter,
    l3OutperformsOnMFE: mfeBetter,
    l3OutperformsOnMAE: maeBetter,
    verdict,
  };
}

// --- CLI rendering -------------------------------------------------------
function renderText(report) {
  const lines = [];
  lines.push(`=== Fire metrics ===`);
  lines.push(`Total fires: ${report.total}    Days covered: ${report.days}    Fires/day: ${report.firesPerDay ?? 'n/a'}`);
  lines.push(``);
  lines.push(`By level:`);
  for (const lvl of [2, 3]) {
    const s = report.byLevel[lvl];
    lines.push(`  Level ${lvl} (${lvl === 2 ? 'CONFIRMED' : 'HIGH CONVICTION'}):`);
    lines.push(`    count=${s.count}, tagged=${s.tagged}`);
    lines.push(`    win rate:          ${s.winRate != null ? (s.winRate * 100).toFixed(1) + '%' : 'n/a'}`);
    lines.push(`    false breakout:    ${s.falseBreakoutRate != null ? (s.falseBreakoutRate * 100).toFixed(1) + '%' : 'n/a'}`);
    lines.push(`    avg MFE:           ${s.avgMFE != null ? s.avgMFE + '%' : 'n/a'}`);
    lines.push(`    avg MAE:           ${s.avgMAE != null ? s.avgMAE + '%' : 'n/a'}`);
    lines.push(`    hindsight plan:    STOCK_ONLY=${s.hindsightPlanDistribution.STOCK_ONLY}  CSP_ONLY=${s.hindsightPlanDistribution.CSP_ONLY}  BOTH=${s.hindsightPlanDistribution.BOTH}  AVOID=${s.hindsightPlanDistribution.AVOID}  untagged=${s.hindsightPlanDistribution.untagged}`);
  }
  lines.push(``);
  lines.push(`Comparison (does Level 3 outperform Level 2?):`);
  if (report.comparison) {
    lines.push(`  Verdict:           ${report.comparison.verdict}`);
    lines.push(`  L3 win > L2 win:   ${stringifyTri(report.comparison.l3OutperformsOnWinRate)}`);
    lines.push(`  L3 MFE > L2 MFE:   ${stringifyTri(report.comparison.l3OutperformsOnMFE)}`);
    lines.push(`  L3 MAE < L2 MAE:   ${stringifyTri(report.comparison.l3OutperformsOnMAE)}`);
    if (report.comparison.note) lines.push(`  ${report.comparison.note}`);
  } else {
    lines.push(`  No fires.`);
  }
  lines.push(``);
  lines.push(`Risk band distribution: ${JSON.stringify(report.riskBand)}`);
  lines.push(`Median fire latency: ${report.medianLatencyMs != null ? (report.medianLatencyMs / 1000).toFixed(2) + 's' : 'n/a'}`);
  lines.push(`Degraded-source fires: ${report.degradedSourceFires}`);
  return lines.join('\n');
}

function stringifyTri(v) {
  if (v === true) return 'YES';
  if (v === false) return 'no';
  return 'n/a';
}

// --- CLI entry point -----------------------------------------------------
function runCli() {
  const args = parseArgs(process.argv);
  const fires = loadFiresFromDir(FIRES_DIR, { date: args.date, since: args.since });
  if (!fires.length) {
    if (args.json) {
      console.log(JSON.stringify({ total: 0, message: 'No fires in requested range.' }));
    } else {
      console.log('No fires in requested range.');
    }
    process.exit(0);
  }
  const report = computeMetrics(fires);
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderText(report));
  }
}

// Cross-platform CLI entry guard. On Windows, argv[1] is "C:\path\file.js" while
// import.meta.url is "file:///C:/path/file.js" — pathToFileURL normalizes both.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  runCli();
}
