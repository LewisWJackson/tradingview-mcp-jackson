#!/usr/bin/env node
/**
 * Migration: reconciliation fields (Risk #2 — broker state desync).
 *
 * open.json icindeki her kayita eksikse su alanlari ekler:
 *   - brokerVenue: null
 *   - brokerOrderIds: []
 *   - reconciliationState: { state:'unknown', lastCheckedAt:null, desyncCount:0,
 *                            lastMismatch:null, expectedPosition:null,
 *                            brokerPosition:null, haltedAt:null, haltReason:null }
 *
 * Idempotent: zaten alanlari olan kayitlara dokunmaz.
 * Yedek: open.json.pre-reconciliation.bak
 *
 * Calistirma:  node scanner/scripts/migrate-reconciliation.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OPEN_PATH = path.resolve(__dirname, '..', 'data', 'signals', 'open.json');

const read = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const write = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));

const data = read(OPEN_PATH, { signals: [] });
if (!Array.isArray(data.signals)) {
  console.error('open.json format beklenmedik — signals array yok');
  process.exit(1);
}

fs.copyFileSync(OPEN_PATH, OPEN_PATH + '.pre-reconciliation.bak');

let patched = 0;
let alreadyHad = 0;
for (const s of data.signals) {
  let changed = false;
  if (!('brokerVenue' in s)) { s.brokerVenue = null; changed = true; }
  if (!Array.isArray(s.brokerOrderIds)) { s.brokerOrderIds = []; changed = true; }
  if (!s.reconciliationState || typeof s.reconciliationState !== 'object') {
    s.reconciliationState = {
      state: 'unknown',
      lastCheckedAt: null,
      desyncCount: 0,
      lastMismatch: null,
      expectedPosition: null,
      brokerPosition: null,
      haltedAt: null,
      haltReason: null,
      currentStage: 'pending',
      monotonicSeq: 0,
      lastMonotonicTs: 0,
    };
    changed = true;
  } else {
    // v1.1 upgrade: A/C alanlari
    const rs = s.reconciliationState;
    if (!('currentStage' in rs))    { rs.currentStage = 'pending';  changed = true; }
    if (!('monotonicSeq' in rs))    { rs.monotonicSeq = 0;          changed = true; }
    if (!('lastMonotonicTs' in rs)) { rs.lastMonotonicTs = 0;       changed = true; }
  }
  // B + D: mevcut brokerOrderIds kayitlarina fills[] ve source alanlarini ekle (backfill).
  if (Array.isArray(s.brokerOrderIds)) {
    for (const o of s.brokerOrderIds) {
      if (!o || typeof o !== 'object') continue;
      if (!Array.isArray(o.fills)) { o.fills = []; changed = true; }
      if (!('source' in o))        { o.source = 'api'; changed = true; }
      if (!('monotonicSeq' in o))  { o.monotonicSeq = 0; changed = true; }
    }
  }
  if (changed) patched++; else alreadyHad++;
}

write(OPEN_PATH, data);
console.log(`Reconciliation migration tamamlandi.`);
console.log(`  Patched : ${patched}`);
console.log(`  Skipped : ${alreadyHad} (zaten vardi)`);
console.log(`  Backup  : ${OPEN_PATH}.pre-reconciliation.bak`);
