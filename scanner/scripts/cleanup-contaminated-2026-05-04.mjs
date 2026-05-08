#!/usr/bin/env node
/**
 * 2026-05-04 — Trailing SL "wrong-side repair" bug temizligi.
 *
 * Bu script:
 *  1. data/signals/open.json — kontamine sinyalleri tespit eder, duzeltir veya
 *     archive'a `dataContaminated:true` ile gonderir.
 *  2. data/signals/archive/2026-05.json — son 24h'te MFE/MAE plausibility
 *     check'inden gecemeyen sinyalleri `dataContaminated:true` ile flagler.
 *  3. data/stats/faulty-trades.json — kontamine ID'leri kaldirir.
 *  4. data/ladder.json — kontamine ID'lerin recordedOutcome etkisini gerigekarir
 *     (mumkunse).
 *
 * Idempotent: tekrar calistirilirsa zaten flag'lenmis kayitlar atlanir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const OPEN = path.join(ROOT, 'data/signals/open.json');
const ARCH_2026_05 = path.join(ROOT, 'data/signals/archive/2026-05.json');
const FAULTY = path.join(ROOT, 'data/stats/faulty-trades.json');
const LADDER = path.join(ROOT, 'data/ladder.json');

const DRY = process.argv.includes('--dry-run');
const REPORT = { open: { fixed: [], archived: [], skipped: [] }, archive: { flagged: [] }, faulty: { removed: [] }, ladder: { reverted: [] } };

function readJSON(p) {
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}
function writeJSON(p, v) {
  if (DRY) return;
  fs.writeFileSync(p, JSON.stringify(v, null, 2));
}

// ---- 1. OPEN.JSON ----
function cleanupOpen() {
  const data = readJSON(OPEN);
  if (!data) return;
  const sigs = data.signals || [];
  const keep = [];
  const archiveOut = [];

  for (const s of sigs) {
    // Case A: tp1Hit + entryHit=false (smart entry) — tutarsiz, archive'a gonder.
    const isSmart = s.entrySource && s.entrySource !== 'quote_price' && s.entrySource !== 'lastbar_close';
    if (s.tp1Hit && !s.entryHit && isSmart) {
      const arch = {
        ...s,
        status: 'invalid_data',
        outcome: 'invalid_data',
        dataContaminated: true,
        contaminationReason: 'tp1Hit=true ama entryHit=false (smart entry); 2026-05-04 SL-repair bug etkilemis olabilir',
        resolvedAt: new Date().toISOString(),
        actualRR: null,
        win: false,
      };
      archiveOut.push(arch);
      REPORT.open.archived.push({ id: s.id, symbol: s.symbol, reason: arch.contaminationReason });
      continue;
    }

    // Case B: trailing SL'in slOriginal'a geri yazildigi izleri olan tp1_hit/tp2_hit pozisyonlar
    // — SL'i korumak gerekiyor ama burada AKBNK/THYAO ornekleri icin sl=slOriginal olmus.
    // Trailing seviyesini break-even'a (entry) cek ki en azindan kar kilitlensin.
    if ((s.status === 'tp1_hit' || s.status === 'tp2_hit') && s.entry != null) {
      const dir = s.direction;
      const slWrongSideForFresh = (dir === 'long' && s.sl >= s.entry) || (dir === 'short' && s.sl <= s.entry);
      const repairWarning = (s.warnings || []).some(w => typeof w === 'string' && w.includes('[SL-Repair]'));
      if (slWrongSideForFresh && repairWarning) {
        const fixedSl = s.entry; // BE — minimal kar kilidi
        REPORT.open.fixed.push({
          id: s.id, symbol: s.symbol, direction: dir,
          oldSl: s.sl, newSl: fixedSl,
          entry: s.entry, tp1: s.tp1,
          note: 'Trailing SL slOriginal yerine BE (entry) seviyesine yeniden kuruldu'
        });
        s.sl = fixedSl;
        s.trailingStopActive = true;
        s.trailingStopLevel = fixedSl;
        s.warnings = [...(s.warnings || []), `[Cleanup-2026-05-04] SL ${dir==='long'?'<':'>'}entry'a tasinacakti, BE'ye kuruldu (eski yanlis: ${(s.warnings||[]).find(w=>w.includes('SL-Repair'))||'-'})`]
          .filter(w => !w.startsWith('[SL-Repair]')); // eski repair warning'i kaldir
      }
    }

    keep.push(s);
  }

  data.signals = keep;
  writeJSON(OPEN, data);

  // Append archived ones
  if (archiveOut.length) {
    const arch = readJSON(ARCH_2026_05) || { signals: [] };
    arch.signals = [...(arch.signals || []), ...archiveOut];
    writeJSON(ARCH_2026_05, arch);
  }
}

// ---- 2. ARCHIVE 2026-05 contamination flag ----
function flagArchiveContamination() {
  const arch = readJSON(ARCH_2026_05);
  if (!arch) return;
  const sigs = arch.signals || [];

  for (const s of sigs) {
    if (s.dataContaminated) continue;
    let bug = null;

    if (s.tp1Hit && s.entry && s.tp1) {
      const need = Math.abs(s.tp1 - s.entry);
      const mfe = Number(s.maxFavorableExcursion ?? s.highestFavorable ?? 0);
      if (mfe < need * 0.95) bug = `TP1_HIT_BUT_MFE_LOW (need=${need.toFixed(4)}, mfe=${mfe.toFixed(4)})`;
    }
    if (!bug && s.slHit && s.entry && s.sl) {
      const need = Math.abs(s.sl - s.entry);
      const mae = Number(s.maxAdverseExcursion ?? s.lowestAdverse ?? 0);
      if (mae < need * 0.5) bug = `SL_HIT_BUT_MAE_LOW (need=${need.toFixed(4)}, mae=${mae.toFixed(4)})`;
    }
    const isSmart = s.entrySource && s.entrySource !== 'quote_price' && s.entrySource !== 'lastbar_close';
    if (!bug && s.entryHit && isSmart && s.entryHitPrice == null) {
      bug = `ENTRY_HIT_NO_PRICE (entrySource=${s.entrySource})`;
    }

    if (bug) {
      s.dataContaminated = true;
      s.contaminationReason = `2026-05-04 cleanup: ${bug}`;
      REPORT.archive.flagged.push({ id: s.id, symbol: s.symbol, reason: bug });
    }
  }

  writeJSON(ARCH_2026_05, arch);
}

// ---- 3. FAULTY-TRADES temizligi ----
function cleanupFaulty() {
  const data = readJSON(FAULTY);
  if (!data) return;
  const flaggedIds = new Set(REPORT.archive.flagged.map(x => x.id).concat(REPORT.open.archived.map(x => x.id)));
  if (!flaggedIds.size) return;

  // faulty-trades.json yapisi: { trades: [...] } veya { byId: {...} } veya array
  // Once en olasi sekli dene
  let removedCount = 0;
  if (Array.isArray(data)) {
    const filtered = data.filter(t => !flaggedIds.has(t.id || t.signalId));
    removedCount = data.length - filtered.length;
    if (removedCount) writeJSON(FAULTY, filtered);
  } else if (data && Array.isArray(data.trades)) {
    const filtered = data.trades.filter(t => !flaggedIds.has(t.id || t.signalId));
    removedCount = data.trades.length - filtered.length;
    if (removedCount) {
      data.trades = filtered;
      writeJSON(FAULTY, data);
    }
  }
  REPORT.faulty.removed.push({ count: removedCount });
}

// ---- 4. LADDER ----
function noteLadderContamination() {
  // Ladder contamination'i geri almak ladder-engine API'si gerektiriyor; risksiz olarak
  // sadece kontamine ID listesi rapora yazilir, manuel inceleme icin.
  REPORT.ladder.reverted.push({ note: 'Ladder geri alma manuel — flagged ID listesi raporda' });
}

// ---- RUN ----
console.log(`[Cleanup] DRY_RUN=${DRY}`);
cleanupOpen();
flagArchiveContamination();
cleanupFaulty();
noteLadderContamination();

console.log('=== RAPOR ===');
console.log(JSON.stringify(REPORT, null, 2));
console.log(`Toplam: open.fixed=${REPORT.open.fixed.length}, open.archived=${REPORT.open.archived.length}, archive.flagged=${REPORT.archive.flagged.length}`);
