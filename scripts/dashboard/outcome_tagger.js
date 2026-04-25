#!/usr/bin/env node
/**
 * Outcome tagger: interactively label each fire in a given day's audit log
 * with its post-hoc outcome, MFE, MAE, and hindsight trade-plan recommendation.
 *
 * These review fields feed Task 20's metrics CLI which compares Level 2 vs
 * Level 3 fire performance.
 *
 * Usage:
 *   node scripts/dashboard/outcome_tagger.js [--date=YYYY-MM-DD]
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tradingDate } from '../../src/lib/market_hours.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIRES_DIR = path.resolve(__dirname, '..', '..', 'data');

const VALID_OUTCOMES = ['continued', 'faded', 'whipsaw', 'earnings_gap', 'unknown'];
const VALID_HINDSIGHT_PLANS = ['STOCK_ONLY', 'CSP_ONLY', 'BOTH', 'AVOID'];

function parseArgs(argv) {
  const args = { date: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--date=')) args.date = a.split('=')[1];
  }
  return args;
}

function loadFires(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function saveFires(filePath, log) {
  fs.writeFileSync(filePath, JSON.stringify(log, null, 2));
}

function parseFloatOrNull(input) {
  const trimmed = String(input || '').trim();
  if (trimmed === '' || trimmed === '-') return null;
  const n = parseFloat(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Apply tagging to a single fire entry. Pure function — no I/O — so it's testable.
 *
 * Returns the updated fire object. Inputs that don't match the validation rules
 * are passed through (no overwrite) and returned with `_skip: true`.
 */
export function applyTagging(fire, input, now = new Date()) {
  const updated = { ...fire };
  if (!input) return { ...updated, _skip: true };

  // Outcome
  const o = String(input.outcome || '').trim().toLowerCase();
  if (!o) return { ...updated, _skip: true };
  if (!VALID_OUTCOMES.includes(o)) return { ...updated, _skip: true };
  updated.outcome = o;

  // MFE / MAE — number or null
  updated.maxFavorableExcursionPct = parseFloatOrNull(input.mfe);
  updated.maxAdverseExcursionPct = parseFloatOrNull(input.mae);

  // Hindsight plan
  const h = String(input.hindsightPlan || '').trim().toUpperCase();
  if (h === '' || h === '-') {
    updated.hindsightPlan = null;
  } else if (VALID_HINDSIGHT_PLANS.includes(h)) {
    updated.hindsightPlan = h;
  } else {
    updated.hindsightPlan = null;
  }

  updated.outcomeTaggedAt = now.toISOString();
  return updated;
}

/**
 * Pure function for the CLI's main loop, factored out for testing.
 * Given a list of fires, the tagging input from the user (a Map or function),
 * returns the updated fires list and a summary.
 */
export function tagAll(fires, getInput, now = new Date()) {
  const updated = [];
  let tagged = 0, skipped = 0, alreadyTagged = 0;
  for (const f of fires) {
    if (f.outcome) {
      updated.push(f);
      alreadyTagged++;
      continue;
    }
    const input = getInput(f);
    const result = applyTagging(f, input, now);
    if (result._skip) {
      delete result._skip;
      updated.push(result);
      skipped++;
    } else {
      updated.push(result);
      tagged++;
    }
  }
  return { fires: updated, summary: { tagged, skipped, alreadyTagged, total: fires.length } };
}

// ─── CLI entry point ──────────────────────────────────────────────────────
async function runCli() {
  const args = parseArgs(process.argv);
  const date = args.date || tradingDate(new Date());
  const filePath = path.join(FIRES_DIR, `coiled_spring_fires_${date}.json`);

  const log = loadFires(filePath);
  if (!log) {
    console.error(`No fires file for ${date} at ${filePath}`);
    process.exit(1);
  }
  if (!log.fires || !log.fires.length) {
    console.log(`No fires recorded on ${date}.`);
    process.exit(0);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(r => rl.question(q, r));

  console.log(`Tagging ${log.fires.length} fires on ${date}.`);
  console.log(`Outcome options: ${VALID_OUTCOMES.join(' / ')}`);
  console.log(`Hindsight plan options: ${VALID_HINDSIGHT_PLANS.join(' / ')} (or - to skip)`);
  console.log('Press <enter> on outcome to skip a fire entirely.');
  console.log('');

  let idx = 0, tagged = 0, skipped = 0, alreadyTagged = 0;
  for (const fire of log.fires) {
    idx++;
    if (fire.outcome) {
      console.log(`  [${idx}/${log.fires.length}] ${fire.ticker} L${fire.fireStrength} — already tagged: ${fire.outcome}`);
      alreadyTagged++;
      continue;
    }
    console.log('');
    console.log(`  [${idx}/${log.fires.length}] ${fire.ticker} L${fire.fireStrength} fired @ $${fire.price.firedPrice} (trigger $${fire.trigger.level})`);
    console.log(`    ${fire.firedAtET || fire.firedAt} | ${fire.setup.confidence} | risk: ${fire.riskFlags.overallRiskBand}`);

    const outcomeInput = (await ask(`    Outcome? [${VALID_OUTCOMES.join('/')}] (enter=skip): `)).trim().toLowerCase();
    if (!outcomeInput) { skipped++; continue; }
    if (!VALID_OUTCOMES.includes(outcomeInput)) {
      console.log(`    Invalid outcome — skipping.`);
      skipped++;
      continue;
    }

    const mfeInput = (await ask(`    Max favorable excursion %? (e.g. 3.5, or - for unknown): `)).trim();
    const maeInput = (await ask(`    Max adverse excursion %? (e.g. 1.2, or - for unknown): `)).trim();
    const hindsightInput = (await ask(`    Hindsight plan? [${VALID_HINDSIGHT_PLANS.join('/')}] (- to skip): `)).trim().toUpperCase();

    Object.assign(fire, applyTagging(fire, {
      outcome: outcomeInput,
      mfe: mfeInput,
      mae: maeInput,
      hindsightPlan: hindsightInput,
    }));
    tagged++;
  }

  saveFires(filePath, log);
  rl.close();
  console.log('');
  console.log(`Saved. ${tagged} tagged, ${skipped} skipped, ${alreadyTagged} already tagged of ${log.fires.length} total.`);
}

// Only run the CLI when this file is the entry point
const entry = process.argv[1];
if (entry && import.meta.url === `file://${entry.replace(/\\/g, '/')}`) {
  runCli().catch(e => { console.error(e); process.exit(1); });
}
