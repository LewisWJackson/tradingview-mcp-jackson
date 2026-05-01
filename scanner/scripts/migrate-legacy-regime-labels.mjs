#!/usr/bin/env node
/**
 * Faz 2 Commit 4 follow-up — legacy regime label migration.
 *
 * Background: until 2026-05-01 the canonical `regime` field on signal
 * records was the legacy 5-regime taxonomy (risk_on / risk_off / range /
 * high_vol / neutral). The new 6-regime taxonomy (REGIMES_TRACKED in
 * weight-adjuster.js) cannot match these labels, so adjustRegimeSpecificWeights
 * skipped every archived signal silently.
 *
 * This migration prefixes every legacy regime value with `legacy_` in:
 *   - scanner/data/signals/archived.json
 *   - scanner/data/signals/archive/*.json (skips *.bak)
 *   - scanner/data/signals/open.json
 *   - scanner/data/weights/current.json (byRegime keys)
 *
 * After migration the weight-adjuster sees no records that match
 * REGIMES_TRACKED, so byRegime learning starts cleanly from new (post-fix)
 * signals only. Idempotent — running twice is a no-op.
 *
 * Usage: node scanner/scripts/migrate-legacy-regime-labels.mjs [--dry-run]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const LEGACY = new Set(['neutral', 'risk_on', 'risk_off', 'range', 'high_vol']);
const DRY = process.argv.includes('--dry-run');

function isAlreadyMigrated(v) {
  return typeof v === 'string' && v.startsWith('legacy_');
}

function migrateValue(v) {
  if (v == null) return { value: v, changed: false };
  if (isAlreadyMigrated(v)) return { value: v, changed: false };
  if (LEGACY.has(v)) return { value: `legacy_${v}`, changed: true };
  return { value: v, changed: false };
}

function loadJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJSONAtomic(p, data) {
  if (DRY) return;
  const tmp = `${p}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

function backup(p) {
  if (DRY) return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, `${p}.pre-legacy-regime-migration.${ts}.bak`);
}

function migrateSignalArray(arr) {
  let changed = 0;
  const counts = {};
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const r = migrateValue(s.regime);
    if (r.changed) {
      counts[s.regime] = (counts[s.regime] || 0) + 1;
      s.regime = r.value;
      changed++;
    }
  }
  return { changed, counts };
}

function migrateSignalFile(p) {
  if (!fs.existsSync(p)) return null;
  const data = loadJSON(p);
  const arr = Array.isArray(data) ? data : (data.signals || data.archived || null);
  if (!arr || !Array.isArray(arr)) {
    console.log(`  ${path.basename(p)}: no signal array (skipped)`);
    return null;
  }
  const result = migrateSignalArray(arr);
  if (result.changed > 0) {
    backup(p);
    writeJSONAtomic(p, data);
  }
  console.log(`  ${path.basename(p)}: ${result.changed} migrated`,
    result.changed ? JSON.stringify(result.counts) : '');
  return result;
}

function migrateWeights() {
  const p = path.join(ROOT, 'data/weights/current.json');
  if (!fs.existsSync(p)) return;
  const w = loadJSON(p);
  const br = w.byRegime || {};
  const remap = {};
  let changed = 0;
  for (const key of Object.keys(br)) {
    if (LEGACY.has(key)) {
      remap[`legacy_${key}`] = br[key];
      changed++;
    } else {
      remap[key] = br[key];
    }
  }
  if (changed > 0) {
    backup(p);
    w.byRegime = remap;
    writeJSONAtomic(p, w);
  }
  console.log(`  weights/current.json byRegime: ${changed} keys remapped`);
}

console.log(`[migrate-legacy-regime-labels] ${DRY ? 'DRY RUN' : 'WRITING'}`);
const archiveDir = path.join(ROOT, 'data/signals/archive');
let totalSignals = 0;

if (fs.existsSync(archiveDir)) {
  for (const f of fs.readdirSync(archiveDir)) {
    if (!f.endsWith('.json') || f.includes('.bak')) continue;
    const r = migrateSignalFile(path.join(archiveDir, f));
    if (r) totalSignals += r.changed;
  }
}

for (const rel of ['data/signals/archived.json', 'data/signals/open.json']) {
  const r = migrateSignalFile(path.join(ROOT, rel));
  if (r) totalSignals += r.changed;
}

migrateWeights();

console.log(`\nTotal signal records migrated: ${totalSignals}`);
console.log(DRY ? '\n(no files written — re-run without --dry-run)' : '\nDone.');
