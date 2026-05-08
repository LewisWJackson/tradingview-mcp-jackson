#!/usr/bin/env node
/**
 * 2026-05-08 — Acik sinyallerin sagligi icin tek seferlik temizlik.
 *
 *  A) Terminal status'lu sinyalleri arsivle + open.json'dan kaldir.
 *     `superseded_by_reverse` outcome-checker isTerminal listesinde eksikti
 *     (yeni eklendi); ama mevcut 6 lingering sinyal manuel arsivlenmesi gerek.
 *
 *  B) open.json'da entryHit=true iken negatif highestFavorable / lowestAdverse
 *     varsa 0'a clamp (cleanup-mfe-tp1-bugs script'i sadece arsivi temizledi).
 *
 * Calistirma:
 *   node scanner/scripts/cleanup-open-signals-20260508.mjs --dry-run
 *   node scanner/scripts/cleanup-open-signals-20260508.mjs
 *
 * Idempotent: yeniden calistirilirsa zaten temiz olanlar atlanir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const OPEN = path.join(ROOT, 'data/signals/open.json');

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, v) {
  if (DRY) return;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
function backup(p) {
  if (DRY || !fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, `${p}.pre-open-cleanup-${stamp}.bak`);
}

const TERMINAL = new Set([
  'sl_hit', 'sl_hit_high_mfe', 'tp3_hit', 'invalid_data',
  'superseded', 'superseded_by_tf', 'superseded_by_cleanup', 'superseded_by_cap',
  'superseded_by_reverse',
  'manual_close', 'trailing_stop_exit', 'entry_expired', 'entry_missed_tp',
]);

function isLearningEligibleTF(tf) {
  if (tf == null) return true;
  const t = String(tf).toLowerCase();
  return t === '240' || t === '1d' || t === '1w';
}

function classifyOutcome(status) {
  if (!status) return 'neutral';
  if (status === 'sl_hit') return 'loss';
  if (status === 'tp1_hit' || status === 'tp2_hit' || status === 'tp3_hit') return 'win';
  if (status === 'trailing_stop_exit') return 'win';
  return 'neutral';
}

function recomputeActualRR(s) {
  if (!s.entry) return null;
  const isSmart = !!(s.entrySource && s.entrySource !== 'quote_price' && s.entrySource !== 'lastbar_close');
  const noFill = isSmart && !s.entryHit && !s.tp1Hit && !s.tp2Hit && !s.tp3Hit && !s.slHit;
  if (noFill) return null;
  const riskSl = s.slOriginal ?? s.initialSl ?? s.originalSl ?? s.sl;
  if (!riskSl) return null;
  const risk = Math.abs(s.entry - riskSl);
  if (risk === 0) return null;
  let reward = 0;
  if (s.status === 'trailing_stop_exit' && s.slHitPrice != null) {
    reward = s.direction === 'long' ? (s.slHitPrice - s.entry) : (s.entry - s.slHitPrice);
  } else if (s.tp3Hit && s.tp3) reward = Math.abs(s.tp3 - s.entry);
  else if (s.tp2Hit && s.tp2) reward = Math.abs(s.tp2 - s.entry);
  else if (s.tp1Hit && s.tp1) reward = Math.abs(s.tp1 - s.entry);
  else if (s.slHit) reward = -risk;
  return Math.round((reward / risk) * 100) / 100;
}

function buildArchiveRecord(signal) {
  const resolvedAt = new Date().toISOString();
  const holdingMs = new Date(resolvedAt) - new Date(signal.createdAt);
  const holdingMinutes = Math.round(holdingMs / 60000);
  const actualRR = recomputeActualRR(signal);
  const win = classifyOutcome(signal.status) === 'win';
  // Invariant: entryHit=false iken hicbir hit flag'i true olamaz
  const flagOverrides = {};
  if (!signal.entryHit) {
    if (signal.tp1Hit) flagOverrides.tp1Hit = false;
    if (signal.tp2Hit) flagOverrides.tp2Hit = false;
    if (signal.tp3Hit) flagOverrides.tp3Hit = false;
    if (signal.slHit) flagOverrides.slHit = false;
  }
  return {
    ...signal,
    ...flagOverrides,
    resolvedAt,
    outcome: signal.status,
    actualRR,
    holdingPeriodMinutes: holdingMinutes,
    maxFavorableExcursion: signal.highestFavorable,
    maxAdverseExcursion: signal.lowestAdverse,
    win,
  };
}

function appendToArchiveFile(yearMonth, record) {
  const eligible = isLearningEligibleTF(record?.timeframe);
  const subdir = eligible ? 'archive' : 'archive_legacy';
  const filePath = path.join(ROOT, 'data/signals', subdir, `${yearMonth}.json`);
  const archive = fs.existsSync(filePath) ? readJSON(filePath) : { signals: [] };
  if (record?.id && archive.signals.some(s => s?.id === record.id)) {
    return { skipped: true, file: filePath };
  }
  archive.signals.push(record);
  if (!DRY) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(archive, null, 2));
    fs.renameSync(tmp, filePath);
  }
  return { skipped: false, file: filePath };
}

const open = readJSON(OPEN);
const before = open.signals.length;

backup(OPEN);

const archived = [];
const clamped = [];
const remaining = [];

for (const s of open.signals) {
  // A) Terminal status — arsivle
  if (s.status && TERMINAL.has(s.status)) {
    const record = buildArchiveRecord(s);
    const ym = (record.resolvedAt || new Date().toISOString()).slice(0, 7);
    const r = appendToArchiveFile(ym, record);
    archived.push({ id: s.id, sym: s.symbol, status: s.status, file: path.basename(r.file), skipped: r.skipped });
    continue; // open'dan kaldir
  }

  // B) MFE/MAE clamp (acik sinyal kalir)
  let dirty = false;
  if (s.entryHit && typeof s.highestFavorable === 'number' && s.highestFavorable < 0) {
    clamped.push({ id: s.id, sym: s.symbol, field: 'hf', was: s.highestFavorable });
    s.highestFavorable = 0;
    dirty = true;
  }
  if (s.entryHit && typeof s.lowestAdverse === 'number' && s.lowestAdverse < 0) {
    clamped.push({ id: s.id, sym: s.symbol, field: 'la', was: s.lowestAdverse });
    s.lowestAdverse = 0;
    dirty = true;
  }
  remaining.push(s);
}

open.signals = remaining;
writeJSON(OPEN, open);

console.log('=== Acik sinyal temizligi ===');
console.log(`Onceki acik sayisi: ${before}`);
console.log(`Arsivlenen: ${archived.length}`);
for (const a of archived) console.log(`  ${a.id} (${a.sym}) → ${a.file}${a.skipped ? ' [DUPLICATE skip]' : ''} status=${a.status}`);
console.log(`MFE/MAE clamp: ${clamped.length}`);
for (const c of clamped) console.log(`  ${c.id} (${c.sym}) ${c.field}: ${c.was.toFixed(3)} → 0`);
console.log(`Kalan acik: ${remaining.length}`);
console.log(DRY ? '\n[DRY-RUN — degisiklik yazilmadi]' : '\n[Yazildi]');
