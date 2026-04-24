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
    dataPath('stats'),
    dataPath('weights', 'history'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }
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

export function appendToArchive(yearMonth, record) {
  const filePath = dataPath('signals', 'archive', `${yearMonth}.json`);
  const archive = readJSON(filePath, { signals: [] });
  archive.signals.push(record);
  writeJSON(filePath, archive);
}

export function readAllArchives() {
  const archiveDir = dataPath('signals', 'archive');
  const allSignals = [];

  try {
    const files = fs.readdirSync(archiveDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      const data = readJSON(path.join(archiveDir, file), { signals: [] });
      allSignals.push(...data.signals);
    }
  } catch { /* no archives yet */ }

  return allSignals;
}

// Invalidate cache for a specific file
export function invalidateCache(filePath) {
  cache.delete(filePath);
}

// Clear entire cache
export function clearCache() {
  cache.clear();
}
