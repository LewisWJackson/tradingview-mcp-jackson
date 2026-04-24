#!/usr/bin/env node
/**
 * Migration: retroactively apply BE/trailing stop + win-on-TP1-SL fix.
 *
 * 1) open.json: tp1Hit=true ama trailingStopActive olmayan pozisyonlara
 *    BE (SL=entry) uygula; tp2Hit varsa SL=tp1 seviyesine kilitle.
 * 2) archive/*.json: status='sl_hit'|'sl_hit_high_mfe' ama tp1Hit=true olan
 *    kayitlari basarili (tp1_hit veya tp2_hit) olarak yeniden sinifla.
 *    win=true, faultyTrade=false, outcome guncelle.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const OPEN_PATH = path.join(DATA_DIR, 'signals', 'open.json');
const ARCHIVE_DIR = path.join(DATA_DIR, 'signals', 'archive');

const readJSON = (p, def) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
};
const writeJSON = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2));
const now = new Date().toISOString();

// ---------- 1) open.json ----------
const openData = readJSON(OPEN_PATH, { signals: [] });
fs.copyFileSync(OPEN_PATH, OPEN_PATH + '.pre-be-migration.bak');

let openPatched = 0;
for (const s of openData.signals) {
  if (!s.tp1Hit) continue;
  if (s.trailingStopActive) continue; // already migrated
  if (!s.entry || !s.tp1) continue;

  const dir = s.direction;
  const lockLevel = s.tp2Hit ? s.tp1 : s.entry;
  const prevSl = s.sl;
  const improves = dir === 'long'
    ? (prevSl == null || lockLevel > prevSl)
    : (prevSl == null || lockLevel < prevSl);
  if (improves) s.sl = lockLevel;
  s.trailingStopActive = true;
  s.trailingStopLevel = s.sl;
  s.beMigratedAt = now;
  s.beMigrationNote = `Retroaktif BE: prevSl=${prevSl} → ${s.sl} (${s.tp2Hit ? 'tp1-lock' : 'break-even'})`;
  openPatched++;
  console.log(`[open] ${s.symbol} ${dir}: SL ${prevSl} → ${s.sl}  (${s.status})`);
}
writeJSON(OPEN_PATH, openData);

// ---------- 2) archive reclassification ----------
let archivePatched = 0;
const archiveFiles = fs.readdirSync(ARCHIVE_DIR)
  .filter(f => /^\d{4}-\d{2}\.json$/.test(f));

for (const fname of archiveFiles) {
  const fpath = path.join(ARCHIVE_DIR, fname);
  const raw = readJSON(fpath, null);
  if (!raw) continue;
  const signals = Array.isArray(raw) ? raw : raw.signals;
  if (!Array.isArray(signals)) continue;

  fs.copyFileSync(fpath, fpath + '.pre-be-migration.bak');

  let fileChanged = 0;
  for (const s of signals) {
    const hadTp1 = s.tp1Hit === true;
    const isSlStatus = s.status === 'sl_hit' || s.status === 'sl_hit_high_mfe' || s.outcome === 'sl_hit' || s.outcome === 'sl_hit_high_mfe';
    if (!hadTp1 || !isSlStatus) continue;

    const newStatus = s.tp2Hit ? 'tp2_hit' : 'tp1_hit';
    s.reclassifiedFromSlHit = { previousStatus: s.status, previousOutcome: s.outcome, at: now };
    s.status = newStatus;
    s.outcome = newStatus;
    s.win = true;
    if (s.faultyTrade) {
      s.faultyTradeOverride = { reason: 'TP1 zaten vurulmustu — SL moved BE eksikligi sistemsel hataydi', at: now };
      s.faultyTrade = false;
    }
    fileChanged++;
    archivePatched++;
  }
  if (fileChanged > 0) writeJSON(fpath, raw);
  console.log(`[archive] ${fname}: ${fileChanged} kayit yeniden siniflandi`);
}

console.log(`\nMigration tamamlandi: ${openPatched} acik pozisyon, ${archivePatched} arsiv kayit.`);
