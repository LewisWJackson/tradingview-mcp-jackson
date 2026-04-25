/**
 * Wrapper Mode — Faz 2 dispatch kontrol bayrağı.
 *
 * DeepSeek tavsiyesi: Faz 2 wrapper canlıya girdiğinde ilk 24 saat "shadow"
 * modunda — sinyal üretilir, A/B/C grade verilir, ama dispatch EDILMEZ.
 * Her karar wrapper-shadow-decisions.jsonl'a yazılır. 24 saat sonra
 * operatör /api/wrapper/mode ile "live" yapar.
 *
 * Persist: scanner/data/wrapper-mode.json (restart-safe)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.resolve(__dirname, '..', '..', 'data', 'wrapper-mode.json');

const VALID_MODES = ['shadow', 'live', 'disabled'];

function defaultState() {
  return {
    mode: 'shadow',          // ilk açılışta default shadow
    since: new Date().toISOString(),
    history: [],
  };
}

function readState() {
  try {
    if (!fs.existsSync(STATE_PATH)) {
      const s = defaultState();
      writeState(s);
      return s;
    }
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch (err) {
    console.error('[wrapper-mode] read failed, defaulting to shadow:', err.message);
    return defaultState();
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[wrapper-mode] write failed:', err.message);
  }
}

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 1000;

export function getWrapperMode() {
  if (!_cache || Date.now() - _cacheAt > CACHE_TTL_MS) {
    _cache = readState();
    _cacheAt = Date.now();
  }
  return _cache;
}

export function isLive() { return getWrapperMode().mode === 'live'; }
export function isShadow() { return getWrapperMode().mode === 'shadow'; }
export function isDisabled() { return getWrapperMode().mode === 'disabled'; }

/**
 * @param {{mode:'shadow'|'live'|'disabled', by:string, reason?:string}} opts
 */
export function setWrapperMode({ mode, by, reason = '' }) {
  if (!VALID_MODES.includes(mode)) throw new Error(`invalid mode: ${mode}`);
  const current = readState();
  const now = new Date().toISOString();
  const next = {
    mode,
    since: now,
    history: [...(current.history || []), {
      from: current.mode, to: mode, at: now, by, reason,
    }].slice(-100),
  };
  writeState(next);
  _cache = next;
  _cacheAt = Date.now();
  console.warn(`[wrapper-mode] ${current.mode} → ${mode} by ${by}: ${reason}`);
  return next;
}

export function _resetWrapperMode() {
  try { fs.unlinkSync(STATE_PATH); } catch {}
  _cache = null;
}

export const __internals = { STATE_PATH, VALID_MODES };
