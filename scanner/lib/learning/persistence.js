/**
 * Persistence layer — atomic JSON file I/O with in-memory caching.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

// In-memory cache (LRU) — arsiv dosyalari buyudukce sinirsiz cache RSS'i sisirirdi.
const CACHE_MAX = 32;
const cache = new Map(); // insertion order = LRU order
const dirty = {};

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key);
  cache.set(key, v); // move to MRU
  return v;
}

function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

export function dataPath(...segments) {
  return path.join(DATA_DIR, ...segments);
}

export function ensureDataDirs() {
  const dirs = [
    dataPath('signals', 'archive'),
    dataPath('signals', 'archive_legacy'),  // 2026-05-02: 15m/30m/45m/1h cozulen sinyaller
    dataPath('stats'),
    dataPath('weights', 'history'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * 2026-05-02 — Otonom ogrenme motoru sadece 4H, 1D, 1W cozumlerinden besleniyor.
 * Daha kucuk TF'lerin (15m/30m/45m/1h) cozumleri `archive_legacy/` dizinine
 * yazilir; learning consumer'lari (weight-adjuster, indicator-scorer,
 * anomaly-detector, learning-reporter, shadow-guard, stats-engine, ladder-engine)
 * `readAllArchives()` cagirir → sadece eligible TF'ler okunur, learning
 * otomatik olarak TF-temiz hale gelir. Tarihsel sorgular icin
 * `readAllLegacyArchives()` veya `readAllArchivesIncludingLegacy()` kullanilir.
 */
export function isLearningEligibleTF(timeframe) {
  if (timeframe == null) return true; // bilinmiyorsa eski davranis
  const tf = String(timeframe).toLowerCase();
  return tf === '240' || tf === '1d' || tf === '1w';
}

export function readJSON(filePath, defaultValue = null) {
  const key = filePath;
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    cacheSet(key, data);
    return data;
  } catch {
    if (defaultValue !== null) {
      cacheSet(key, defaultValue);
      return defaultValue;
    }
    return null;
  }
}

export function writeJSON(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Atomic write: write to temp, then rename
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);

  cacheSet(filePath, data);
  delete dirty[filePath];
}

export function updateJSON(filePath, updater, defaultValue = {}) {
  const current = readJSON(filePath, defaultValue);
  const updated = updater(current);
  writeJSON(filePath, updated);
  return updated;
}

/**
 * Cozumlenen sinyali archive'a yaz. TF eligible degilse (15m/30m/45m/1h) ana
 * `archive/` dizini yerine `archive_legacy/` dizinine yazilir; learning
 * pipeline otomatik olarak bu sinyalleri gormez. Acik sinyaller, dashboard
 * ve genel istatistik raporlari (gerekirse) `archive_legacy/`'i de okuyabilir.
 */
export function appendToArchive(yearMonth, record) {
  const eligible = isLearningEligibleTF(record?.timeframe);
  const subdir = eligible ? 'archive' : 'archive_legacy';
  const filePath = dataPath('signals', subdir, `${yearMonth}.json`);
  const archive = readJSON(filePath, { signals: [] });
  // Idempotent: ayni id daha once arsivlenmisse yeniden yazma. removeOpenSignal
  // bir kere fail edince open.json'da kalan sinyal sonradan tekrar resolve edilip
  // duplicate kayit yaratabiliyordu (FSLR_60_1777654081 olayi).
  if (record?.id && archive.signals.some(s => s?.id === record.id)) return;
  archive.signals.push(record);
  writeJSON(filePath, archive);
}

function readArchiveDir(subdir) {
  const archiveDir = dataPath('signals', subdir);
  const allSignals = [];
  try {
    const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = readJSON(path.join(archiveDir, file), { signals: [] });
      allSignals.push(...data.signals);
    }
  } catch { /* dir not present yet */ }
  return allSignals;
}

/** Sadece learning-eligible (4H/1D/1W) cozumler. Bu fonksiyonu otonom ogrenme
 *  motoru ve onun tum tureven raporlama/anomaly modulleri okur.
 *  2026-05-04: `dataContaminated:true` kayitlar varsayilan olarak filtrelenir
 *  (kontamine MFE/MAE veya yanlis SL/TP hit'leri ogrenmeyi zehirlemesin).
 *  Tarihsel sorgular ham listeye `{includeContaminated:true}` ile ulasabilir. */
export function readAllArchives({ includeContaminated = false } = {}) {
  const all = readArchiveDir('archive');
  return includeContaminated ? all : all.filter(s => !s?.dataContaminated);
}

/** 2026-05-02 oncesi alt-TF cozumler. Sadece tarihsel sorgu icin. */
export function readAllLegacyArchives({ includeContaminated = false } = {}) {
  const all = readArchiveDir('archive_legacy');
  return includeContaminated ? all : all.filter(s => !s?.dataContaminated);
}

/** Hepsi (eligible + legacy) — sembol-bazli history sorgulari icin. */
export function readAllArchivesIncludingLegacy({ includeContaminated = false } = {}) {
  const all = [...readArchiveDir('archive'), ...readArchiveDir('archive_legacy')];
  return includeContaminated ? all : all.filter(s => !s?.dataContaminated);
}

// Invalidate cache for a specific file
export function invalidateCache(filePath) {
  cache.delete(filePath);
}

// Clear entire cache
export function clearCache() {
  cache.clear();
}
