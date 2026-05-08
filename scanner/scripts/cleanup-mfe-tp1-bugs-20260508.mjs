#!/usr/bin/env node
/**
 * 2026-05-08 — Outcome-checker bug aileleri temizligi.
 *
 * 3 ayri bug pattern'i icin geriye donuk arsiv temizligi:
 *
 *  A) Negatif MFE/MAE: entryHit=true iken highestFavorable<0 veya
 *     lowestAdverse<0. Tanim geregi imkansiz. 0'a clamp.
 *
 *  B) sl_hit_high_mfe ama hf >= tp1Dist (TAM): 1m tie-break basarisiz olunca
 *     SL-onceligi pesimist sonuc verdi. TP1 fiilen dolmustu. Yeni davranisla
 *     bu kayitlar trailing_stop_exit'e cevrilir + tp1Hit=true + BE migration
 *     uygulanir + actualRR yeniden hesaplanir + win=true.
 *
 *  C) entryHit=false iken tp1Hit/slHit/tp2Hit/tp3Hit=true: invariant ihlali
 *     (FSLR-tipi pre-entry gap senaryosu). Flag'leri false'a normalize et.
 *
 * Calistirma:
 *   node scanner/scripts/cleanup-mfe-tp1-bugs-20260508.mjs --dry-run
 *   node scanner/scripts/cleanup-mfe-tp1-bugs-20260508.mjs
 *
 * Idempotent: tekrar calistirilirsa zaten temiz olanlar atlanir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const ARCHIVE_FILES = [
  path.join(ROOT, 'data/signals/archive/2026-04.json'),
  path.join(ROOT, 'data/signals/archive/2026-05.json'),
  path.join(ROOT, 'data/signals/archive_legacy/2026-04.json'),
  path.join(ROOT, 'data/signals/archive_legacy/2026-05.json'),
];

function readJSON(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, v) {
  if (DRY) return;
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}
function backup(p) {
  if (DRY || !fs.existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(p, `${p}.pre-mfe-tp1-cleanup-${stamp}.bak`);
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

const report = {
  negMfe: [],   // hf<0 → 0
  negMae: [],   // la<0 → 0
  retroTp1: [], // sl_hit_high_mfe with hf>=tp1Dist → trailing_stop_exit
  flagFix: [],  // entryHit=false ile birlikte hit flag'leri true
};

for (const file of ARCHIVE_FILES) {
  const data = readJSON(file);
  if (!data || !Array.isArray(data.signals)) continue;
  let dirty = false;

  for (const s of data.signals) {
    // A) Negatif MFE/MAE clamp
    if (s.entryHit && typeof s.highestFavorable === 'number' && s.highestFavorable < 0) {
      report.negMfe.push({ file, id: s.id, was: s.highestFavorable });
      s.highestFavorable = 0;
      if (typeof s.maxFavorableExcursion === 'number') s.maxFavorableExcursion = 0;
      dirty = true;
    }
    if (s.entryHit && typeof s.lowestAdverse === 'number' && s.lowestAdverse < 0) {
      report.negMae.push({ file, id: s.id, was: s.lowestAdverse });
      s.lowestAdverse = 0;
      if (typeof s.maxAdverseExcursion === 'number') s.maxAdverseExcursion = 0;
      dirty = true;
    }

    // B) sl_hit_high_mfe ama hf >= tp1Dist → retroaktif TP1 + trailing_stop_exit
    const tp1Dist = (s.tp1 != null && s.entry != null) ? Math.abs(s.tp1 - s.entry) : 0;
    if (s.status === 'sl_hit_high_mfe'
        && tp1Dist > 0
        && typeof s.highestFavorable === 'number'
        && s.highestFavorable >= tp1Dist
        && !s.tp1Hit) {
      const dir = s.direction;
      const slOrigForBE = s.slOriginal != null ? s.slOriginal : s.sl;
      const atrVal = Number(s.atr);
      const halfwayBE = (slOrigForBE + s.entry) / 2;
      let newSLBE;
      if (Number.isFinite(atrVal) && atrVal > 0) {
        const atrBufferBE = dir === 'long' ? s.entry - 0.5 * atrVal : s.entry + 0.5 * atrVal;
        newSLBE = dir === 'long' ? Math.min(halfwayBE, atrBufferBE) : Math.max(halfwayBE, atrBufferBE);
      } else {
        newSLBE = halfwayBE;
      }
      if (dir === 'long' && newSLBE < slOrigForBE) newSLBE = slOrigForBE;
      if (dir === 'short' && newSLBE > slOrigForBE) newSLBE = slOrigForBE;

      const before = { status: s.status, win: s.win, actualRR: s.actualRR };
      s.tp1Hit = true;
      s.tp1HitAt = s.tp1HitAt || s.slHitAt;
      s.tp1HitPrice = s.tp1;
      if (s.slOriginal == null) s.slOriginal = s.sl;
      s.trailingStopActive = true;
      s.trailingStopLevel = newSLBE;
      s.slHitPrice = newSLBE;
      s.breakevenAt = s.breakevenAt || s.slHitAt;
      s.status = 'trailing_stop_exit';
      s.outcome = 'trailing_stop_exit';
      s.trailingStopExit = true;
      s.trailingExitTier = 'tp1';
      s.retroTp1FromMfe = true;
      s.highMfeFlag = false;
      s.actualRR = recomputeActualRR(s);
      s.win = classifyOutcome(s.status) === 'win';
      report.retroTp1.push({ file, id: s.id, sym: s.symbol, before, after: { status: s.status, win: s.win, actualRR: s.actualRR, slHitPrice: newSLBE } });
      dirty = true;
    }

    // C) entryHit=false ama hit flag'leri true → flag'leri sifirla + actualRR/win
    //    yeniden hesapla (pre-entry pozisyonun kayip/kazanc anlami yoktur).
    if (!s.entryHit && (s.tp1Hit || s.tp2Hit || s.tp3Hit || s.slHit)) {
      const before = { tp1Hit: s.tp1Hit, tp2Hit: s.tp2Hit, tp3Hit: s.tp3Hit, slHit: s.slHit, actualRR: s.actualRR, win: s.win };
      s.tp1Hit = false; s.tp2Hit = false; s.tp3Hit = false; s.slHit = false;
      const newRR = recomputeActualRR(s);
      s.actualRR = newRR; // smart-entry + entryHit=false → null
      s.win = classifyOutcome(s.status) === 'win';
      report.flagFix.push({ file, id: s.id, sym: s.symbol, before, after: { actualRR: s.actualRR, win: s.win } });
      dirty = true;
    }
  }

  // D) duplicate id dedupe — son kaydi tut (en taze outcome tipik olarak daha bilgi verici)
  const seen = new Map();
  for (let i = 0; i < data.signals.length; i++) {
    const s = data.signals[i];
    if (!s?.id) continue;
    if (seen.has(s.id)) {
      const prevIdx = seen.get(s.id);
      data.signals[prevIdx] = null; // mark to drop
    }
    seen.set(s.id, i);
  }
  const before = data.signals.length;
  data.signals = data.signals.filter(Boolean);
  const removed = before - data.signals.length;
  if (removed > 0) { dirty = true; console.log(`[dedupe] ${path.basename(file)}: ${removed} duplicate kaldirildi`); }

  if (dirty) {
    backup(file);
    writeJSON(file, data);
    console.log(`[write] ${path.basename(file)} guncellendi`);
  }
}

console.log('\n=== Rapor ===');
console.log(`Negatif MFE clamp: ${report.negMfe.length}`);
for (const r of report.negMfe) console.log(`  ${r.id}: ${r.was.toFixed(3)} → 0`);
console.log(`Negatif MAE clamp: ${report.negMae.length}`);
for (const r of report.negMae) console.log(`  ${r.id}: ${r.was.toFixed(3)} → 0`);
console.log(`Retro TP1 (sl_hit_high_mfe → trailing_stop_exit): ${report.retroTp1.length}`);
for (const r of report.retroTp1) console.log(`  ${r.id} (${r.sym}): ${r.before.status}/win=${r.before.win}/RR=${r.before.actualRR} → ${r.after.status}/win=${r.after.win}/RR=${r.after.actualRR}`);
console.log(`Flag normalize (entryHit=false): ${report.flagFix.length}`);
for (const r of report.flagFix) console.log(`  ${r.id} (${r.sym}): ${JSON.stringify(r.before)}`);
console.log(DRY ? '\n[DRY-RUN — degisiklik yazilmadi]' : '\n[Yazildi]');
