/**
 * Halt State — sistemin "acil durdurma" anahtari.
 *
 * Risk #3 (Kill switch) icin merkezi state. Dosya-tabanli olmasinin nedeni:
 * (a) Harici script (scripts/kill-all.sh) sunucu cokmus olsa bile flag'i
 *     direkt dosyaya yazabilsin,
 * (b) Sunucu restart sonrasi halt durumu unutulmasin — manuel release
 *     olmadan otonom trade baslamasin.
 *
 * Hot path (scheduler, okx-dispatcher) `isHalted()` cagirir — in-memory
 * cache ile dosya okuma maliyeti minimuma indirilir, 1sn'de bir dosyayi
 * polling ile tazeler.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', 'data', 'halt-state.json');
const CACHE_TTL_MS = 1000; // hot-path cache refresh

let _cache = null;
let _cacheAt = 0;

/**
 * @typedef {Object} HaltState
 * @property {boolean} halted
 * @property {string|null} reason
 * @property {string|null} haltedAt            ISO timestamp
 * @property {string|null} haltedBy            operator / system id
 * @property {'api'|'script'|'internal'|null} source  which layer engaged it
 * @property {string|null} layer               'A'|'B'|'C' audit tag
 * @property {Array<Object>} history           audit log (append-only)
 * @property {Object} cancelAll                Layer C audit
 */

/** @returns {HaltState} */
function emptyState() {
  return {
    halted: false,
    reason: null,
    haltedAt: null,
    haltedBy: null,
    source: null,
    layer: null,
    history: [],
    cancelAll: { attempts: [], lastAttemptAt: null, lastSuccessAt: null },
  };
}

function readFromDisk() {
  try {
    if (!fs.existsSync(STATE_PATH)) return emptyState();
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return { ...emptyState(), ...parsed };
  } catch (err) {
    console.error('[halt-state] read failed, defaulting to unhalted:', err.message);
    return emptyState();
  }
}

function writeToDisk(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    _cache = state;
    _cacheAt = Date.now();
  } catch (err) {
    console.error('[halt-state] write failed:', err.message);
    throw err;
  }
}

/** Force re-read from disk, bypassing cache. */
export function refreshHaltState() {
  _cache = readFromDisk();
  _cacheAt = Date.now();
  return _cache;
}

/** Cached state read (polls disk at most once per CACHE_TTL_MS). */
export function getHaltState() {
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) {
    _cache = readFromDisk();
    _cacheAt = Date.now();
  }
  return _cache;
}

/** Hot-path boolean check. */
export function isHalted() {
  return getHaltState().halted === true;
}

/**
 * Engage halt. Idempotent — zaten halted ise history'ye not dusup cikar.
 * @param {{reason: string, source: 'api'|'script'|'internal', layer?: string, by?: string}} opts
 */
export function engageHalt({ reason, source, layer = 'A', by = 'system' }) {
  const now = new Date().toISOString();
  const current = readFromDisk();
  const entry = { event: 'engage', at: now, reason, source, layer, by };
  const next = {
    ...current,
    halted: true,
    reason: current.halted ? current.reason : reason,
    haltedAt: current.halted ? current.haltedAt : now,
    haltedBy: current.halted ? current.haltedBy : by,
    source: current.halted ? current.source : source,
    layer: current.halted ? current.layer : layer,
    history: [...(current.history || []), entry].slice(-200),
  };
  writeToDisk(next);
  console.warn(`[halt-state] HALT ENGAGED (source=${source}, layer=${layer}): ${reason}`);
  return next;
}

/**
 * Release halt — manuel (operator onayi varsayilir). Audit'e yazilir.
 * @param {{by: string, reason?: string}} opts
 */
export function releaseHalt({ by, reason = 'manual_release' }) {
  const now = new Date().toISOString();
  const current = readFromDisk();
  if (!current.halted) return current;
  const entry = { event: 'release', at: now, by, reason };
  const next = {
    ...current,
    halted: false,
    reason: null,
    haltedAt: null,
    haltedBy: null,
    source: null,
    layer: null,
    history: [...(current.history || []), entry].slice(-200),
  };
  writeToDisk(next);
  console.warn(`[halt-state] HALT RELEASED by ${by}: ${reason}`);
  return next;
}

/**
 * Layer C audit — cancel-all deneme kaydi.
 * @param {{success: boolean, detail?: string, durationMs?: number}} attempt
 */
export function recordCancelAllAttempt({ success, detail = '', durationMs = 0 }) {
  const now = new Date().toISOString();
  const current = readFromDisk();
  const attempt = { at: now, success, detail, durationMs };
  const cancelAll = current.cancelAll || { attempts: [], lastAttemptAt: null, lastSuccessAt: null };
  const next = {
    ...current,
    cancelAll: {
      attempts: [...(cancelAll.attempts || []), attempt].slice(-50),
      lastAttemptAt: now,
      lastSuccessAt: success ? now : cancelAll.lastSuccessAt,
    },
  };
  writeToDisk(next);
  return next;
}
