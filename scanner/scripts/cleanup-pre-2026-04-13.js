#!/usr/bin/env node
/**
 * cleanup-pre-2026-04-13.js
 *
 * Bir kerelik temizlik scripti: 2026-04-13'ten once olusturulmus arsiv sinyallerini
 * tamamen kaldirir ve stats dosyalarini yeniden hesaplar.
 *
 * Kapsam:
 *   - data/signals/archive/*.json  → .bak yedek + createdAt >= 2026-04-13 filtresi
 *   - data/stats/*.json            → .bak yedek + silinir
 *   - Ardindan recomputeAllStats() ile yeni iki-katmanli (real/virtual) sema yazilir.
 *
 * Weights (data/weights/current.json) ve open signals (data/signals/open.json)
 * DOKUNULMAZ — learning state korunur, yeni veri ile dogal kalibrasyon olacak.
 *
 * Kullanim:
 *   cd scanner && node scripts/cleanup-pre-2026-04-13.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { recomputeAllStats } from '../lib/learning/stats-engine.js';
import { clearCache, dataPath, ensureDataDirs } from '../lib/learning/persistence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CUTOFF_ISO = '2026-04-13T00:00:00Z';
const CUTOFF_MS = new Date(CUTOFF_ISO).getTime();

function log(msg) { console.log(`[cleanup] ${msg}`); }
function err(msg) { console.error(`[cleanup] HATA: ${msg}`); }

function backupFile(filePath) {
  const bakPath = filePath + '.bak';
  fs.copyFileSync(filePath, bakPath);
  return bakPath;
}

function shouldKeep(signal) {
  if (!signal) return false;
  // createdAt yoksa muhtemelen eski/bozuk kayit — guvenli secim: sil
  if (!signal.createdAt) return false;
  const t = new Date(signal.createdAt).getTime();
  if (!Number.isFinite(t)) return false;
  if (t < CUTOFF_MS) return false;

  // Ayrica expired_profit / expired_loss / entry_missed status'ine sahip eski
  // kayitlari da filtrele — bu sistemde artik uretilmiyor, learning'i kirletir.
  if (signal.status === 'expired_profit' || signal.status === 'expired_loss' ||
      signal.status === 'entry_missed') {
    return false;
  }

  return true;
}

function cleanArchives() {
  const archiveDir = dataPath('signals', 'archive');
  if (!fs.existsSync(archiveDir)) {
    log('Arsiv dizini yok — temizlenecek veri yok.');
    return { files: 0, removed: 0, kept: 0 };
  }

  const files = fs.readdirSync(archiveDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.bak'));
  let totalRemoved = 0;
  let totalKept = 0;

  for (const file of files) {
    const filePath = path.join(archiveDir, file);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      err(`${file} okunamadi: ${e.message} — atlaniyor`);
      continue;
    }

    const signals = Array.isArray(raw?.signals) ? raw.signals : [];
    backupFile(filePath);

    const kept = signals.filter(shouldKeep);
    const removed = signals.length - kept.length;
    totalRemoved += removed;
    totalKept += kept.length;

    const newData = { signals: kept };
    fs.writeFileSync(filePath, JSON.stringify(newData, null, 2), 'utf-8');
    log(`${file}: ${signals.length} → ${kept.length} (silinen: ${removed})`);
  }

  return { files: files.length, removed: totalRemoved, kept: totalKept };
}

function cleanStats() {
  const statsDir = dataPath('stats');
  if (!fs.existsSync(statsDir)) return { files: 0 };

  const files = fs.readdirSync(statsDir)
    .filter(f => f.endsWith('.json') && !f.endsWith('.bak'));

  for (const file of files) {
    const filePath = path.join(statsDir, file);
    backupFile(filePath);
    fs.unlinkSync(filePath);
    log(`stats/${file} silindi (backup: ${file}.bak)`);
  }

  return { files: files.length };
}

async function main() {
  log(`Baslangic: cutoff = ${CUTOFF_ISO}`);
  ensureDataDirs();

  // Cache'i temizle — eski okumalarin dogru yeniden yuklenmesini sagla
  clearCache();

  const archiveResult = cleanArchives();
  log(`Arsiv: ${archiveResult.files} dosya | kalan: ${archiveResult.kept} | silinen: ${archiveResult.removed}`);

  const statsResult = cleanStats();
  log(`Stats: ${statsResult.files} dosya silindi`);

  clearCache();

  log('recomputeAllStats() calistiriliyor...');
  try {
    const res = recomputeAllStats();
    log(`Yeni stats: real=${res.realSignals} | virtual=${res.virtualSignals} | toplam=${res.totalSignals}`);
    log(`overall.real.winRate=${res.overall?.real?.winRate ?? 'N/A'}%`);
    log(`overall.virtual.winRate=${res.overall?.virtual?.winRate ?? 'N/A'}%`);
  } catch (e) {
    err(`recomputeAllStats basarisiz: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  log('Tamamlandi.');
  log('Geri alma icin: ls data/signals/archive/*.bak && for f in *.bak; do mv "$f" "${f%.bak}"; done');
}

main().catch(e => {
  err(`Beklenmeyen hata: ${e.stack || e.message}`);
  process.exitCode = 1;
});
