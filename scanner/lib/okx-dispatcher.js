/**
 * OKX Executor dispatcher — retry queue'li.
 *
 * Fire-and-forget yerine: executor kapaliyken veya ag hatasinda sinyal
 * `data/okx-queue.json`'a yazilir. Her yeni dispatch'te ve periyodik drain
 * timer'inda kuyruk bosaltilmaya calisilir. Bu sayede executor'in yeniden
 * basladigi zaman kaybolan A/B/C sinyaller otomatik olarak iletilir.
 *
 * Idempotency executor tarafinda `reason.id` ile zaten saglaniyor; ayni
 * sinyali birden cok kez gondermek zararsiz.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isHalted, recordCancelAllAttempt } from './halt-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_PATH = path.resolve(__dirname, '..', 'data', 'okx-queue.json');
const SL_AMEND_QUEUE_PATH = path.resolve(__dirname, '..', 'data', 'okx-sl-amend-queue.json');
const MAX_QUEUE = 500;
const DRAIN_INTERVAL_MS = 30_000;

let drainTimer = null;
let slAmendDrainTimer = null;

function readQueue() {
  try {
    if (!fs.existsSync(QUEUE_PATH)) return [];
    const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeQueue(items) {
  try {
    fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
    fs.writeFileSync(QUEUE_PATH, JSON.stringify(items.slice(-MAX_QUEUE), null, 2));
  } catch (err) {
    console.error('[okx-dispatcher] queue write failed:', err.message);
  }
}

function enqueue(payload) {
  const q = readQueue();
  // Ayni id zaten kuyruktaysa sakla sadece bir kopya
  const id = payload?.reason?.id;
  const existing = id ? q.findIndex(x => x?.reason?.id === id) : -1;
  if (existing >= 0) q[existing] = { ...payload, queuedAt: Date.now() };
  else q.push({ ...payload, queuedAt: Date.now() });
  writeQueue(q);
}

async function tryPost(url, payload) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    // @ts-ignore — Node 22 fetch supports AbortSignal.timeout
    signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined,
  });
  if (!r.ok) throw new Error(`http_${r.status}`);
  return r.json().catch(() => ({}));
}

async function drain(url) {
  const q = readQueue();
  if (!q.length) return { drained: 0, remaining: 0 };
  const remaining = [];
  let drained = 0;
  for (const item of q) {
    try {
      await tryPost(url, item);
      drained++;
    } catch {
      remaining.push(item);
    }
  }
  writeQueue(remaining);
  return { drained, remaining: remaining.length };
}

function ensureDrainTimer(url) {
  if (drainTimer) return;
  drainTimer = setInterval(() => {
    drain(url).catch(() => {});
  }, DRAIN_INTERVAL_MS);
  if (drainTimer.unref) drainTimer.unref();
}

/**
 * Sinyali executor'a ilet. Basarisiz olursa kuyruga ekler.
 * Kripto + A/B/C filtresi disardaki kaynak tarafinda (scheduler/tracker) yapilir.
 */
export function dispatchToOkxExecutor(payload) {
  const id = payload?.reason?.id || payload?.symbol_tv || '?';
  if (process.env.OKX_EXECUTOR_ENABLED !== '1') {
    // Sessizce duserse "OKX'e neden gitmedi?" sorusu cevapsiz kaliyor.
    console.log(`[okx-dispatcher] skip (${id}): OKX_EXECUTOR_ENABLED!=1`);
    return;
  }
  // Risk #3 — Kill switch: halt aktifse yeni trade dispatch'i kesinlikle gitmez.
  // Kuyruga da yazmiyoruz — halt release'te eski sinyallerin ortaya cikmamasi icin.
  if (isHalted()) {
    console.warn('[okx-dispatcher] HALT aktif — dispatch bloke edildi:', id);
    return;
  }
  const url = process.env.OKX_EXECUTOR_URL || 'http://127.0.0.1:3939/api/signals/new';

  ensureDrainTimer(url);

  // Once eski kuyrugu drain etmeye calis, sonra yeni payload'i gonder.
  (async () => {
    try { await drain(url); } catch {}
    try {
      await tryPost(url, payload);
    } catch {
      enqueue(payload);
    }
  })();
}

export function getQueueStats() {
  const q = readQueue();
  return { size: q.length, oldestQueuedAt: q[0]?.queuedAt ?? null };
}

// =============================================================================
// SL Amend dispatcher — TP1 hit aninda native trailing-stop kurulumu icin.
// =============================================================================
// Yeni-sinyal akisindan ayri queue + ayri dedup anahtari (signalId+action).
// Last-write-wins: ayni (signalId, action) icin son payload eskisini ezer
// — drain sirasi bozulsa bile en guncel SL/callback degeri gonderilir.
//
// Tasarim notu: bu fonksiyon sadece TP1-hit gibi DISCRETE olaylarda cagrilir
// (her tick degil). Sureli trailing OKX native algo-order'a teslim edilir.

function readSlAmendQueue() {
  try {
    if (!fs.existsSync(SL_AMEND_QUEUE_PATH)) return [];
    const raw = fs.readFileSync(SL_AMEND_QUEUE_PATH, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function writeSlAmendQueue(items) {
  try {
    fs.mkdirSync(path.dirname(SL_AMEND_QUEUE_PATH), { recursive: true });
    fs.writeFileSync(SL_AMEND_QUEUE_PATH, JSON.stringify(items.slice(-MAX_QUEUE), null, 2));
  } catch (err) {
    console.error('[sl-amend] queue write failed:', err.message);
  }
}

function enqueueSlAmend(payload) {
  const q = readSlAmendQueue();
  const key = `${payload?.signalId}::${payload?.action}`;
  const existing = q.findIndex(x => `${x?.signalId}::${x?.action}` === key);
  if (existing >= 0) q[existing] = { ...payload, queuedAt: Date.now() };
  else q.push({ ...payload, queuedAt: Date.now() });
  writeSlAmendQueue(q);
}

function slAmendUrl() {
  return (process.env.OKX_EXECUTOR_URL || 'http://127.0.0.1:3939/api/signals/new')
    .replace(/\/api\/signals\/new\/?$/, '/api/signals/sl-amend');
}

async function drainSlAmend(url) {
  const q = readSlAmendQueue();
  if (!q.length) return { drained: 0, remaining: 0 };
  const remaining = [];
  let drained = 0;
  for (const item of q) {
    try {
      await tryPost(url, item);
      drained++;
    } catch {
      remaining.push(item);
    }
  }
  writeSlAmendQueue(remaining);
  return { drained, remaining: remaining.length };
}

function ensureSlAmendDrainTimer(url) {
  if (slAmendDrainTimer) return;
  slAmendDrainTimer = setInterval(() => {
    drainSlAmend(url).catch(() => {});
  }, DRAIN_INTERVAL_MS);
  if (slAmendDrainTimer.unref) slAmendDrainTimer.unref();
}

/**
 * Discrete SL amend dispatch — executor'a native trailing kurulumu icin.
 * Cagiran taraf transition kontrolunu (TP1 ilk hit, slAmendDispatchedAt yok)
 * yapmis olmali; bu fonksiyon idempotency garantisi vermez.
 *
 * Payload alani:
 *   signalId      — target acik pozisyonun id'si
 *   symbol_tv     — TV sembolu (executor'in mapping'i icin)
 *   side          — 'long' | 'short'
 *   action        — 'tp1_trail_setup' (sonraki: 'aggressive_tighten')
 *   initialStop   — halfway+ATR ile hesaplanan ilk SL (numeric)
 *   callbackSpread— absolute mesafe (peak ± callback) (numeric)
 *   seq           — monotonic, executor eski seq'i drop eder
 *   reason        — audit: tp1, entry, slOriginal, breakevenAt
 *
 * Executor erisilemez/hata: payload kuyruga (data/okx-sl-amend-queue.json)
 * yazilir, executor ayaga kalkinca otomatik drain edilir.
 */
export function dispatchSlAmend(payload) {
  const id = payload?.signalId || '?';
  const action = payload?.action || '?';
  if (process.env.OKX_SL_AMEND_ENABLED !== '1') {
    console.log(`[sl-amend] skip (${id}/${action}): OKX_SL_AMEND_ENABLED!=1`);
    return;
  }
  if (process.env.OKX_EXECUTOR_ENABLED !== '1') {
    console.log(`[sl-amend] skip (${id}/${action}): OKX_EXECUTOR_ENABLED!=1`);
    return;
  }
  if (isHalted()) {
    // Halt sirasinda da SL amend devam etsin — koruyucu bir islem, yeni
    // pozisyon acmiyor. Trader manuel mudahaleye guveniyor olabilir.
    // Yine de log ile gorunur birak.
    console.warn(`[sl-amend] HALT aktif ama SL amend gonderiliyor: ${id}/${action}`);
  }

  const url = slAmendUrl();
  ensureSlAmendDrainTimer(url);

  (async () => {
    try { await drainSlAmend(url); } catch {}
    try {
      await tryPost(url, payload);
      console.log(`[sl-amend] dispatched ${id}/${action} seq=${payload.seq}`);
    } catch (err) {
      console.warn(`[sl-amend] post failed (${id}/${action}): ${err.message} — queued`);
      enqueueSlAmend(payload);
    }
  })();
}

export function getSlAmendQueueStats() {
  const q = readSlAmendQueue();
  return { size: q.length, oldestQueuedAt: q[0]?.queuedAt ?? null };
}

/**
 * Layer C — Exchange-native cancel-all + flatten.
 * DeepSeek uyarisi: Exchange API'si chaos aninda cokmus olabilir; sessiz
 * basarisizlik KABUL EDILMEZ. Timeout + retry + audit + alarm log zorunlu.
 *
 * Executor tarafinda `/api/emergency/cancel-all` endpoint'inin tum acik
 * order'lari iptal edip pozisyonlari market ile kapatmasi beklenir.
 * Endpoint henuz implement degilse bu fonksiyon "best-effort alarm" modunda
 * calisir — halt-state'e kayit dusurur, asla sessiz basarili donmez.
 *
 * @param {{attempts?: number, timeoutMs?: number}} opts
 * @returns {Promise<{success: boolean, detail: string, durationMs: number}>}
 */
export async function cancelAllAndFlatten({ attempts = 3, timeoutMs = 5000 } = {}) {
  const startedAt = Date.now();
  const url = (process.env.OKX_EXECUTOR_URL || 'http://127.0.0.1:3939/api/signals/new')
    .replace(/\/api\/signals\/new\/?$/, '/api/emergency/cancel-all');

  if (process.env.OKX_EXECUTOR_ENABLED !== '1') {
    const result = { success: false, detail: 'executor_disabled (OKX_EXECUTOR_ENABLED!=1)', durationMs: 0 };
    recordCancelAllAttempt(result);
    console.warn('[cancelAll] SKIP — executor disabled');
    return result;
  }

  let lastErr = 'no_attempt';
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'kill_switch', source: 'scanner' }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      });
      if (!r.ok) throw new Error(`http_${r.status}`);
      const body = await r.json().catch(() => ({}));
      const durationMs = Date.now() - startedAt;
      const result = { success: true, detail: `attempt_${i}: ${JSON.stringify(body).slice(0, 200)}`, durationMs };
      recordCancelAllAttempt(result);
      console.warn(`[cancelAll] SUCCESS on attempt ${i} (${durationMs}ms)`);
      return result;
    } catch (err) {
      lastErr = err?.message || String(err);
      console.warn(`[cancelAll] attempt ${i}/${attempts} FAILED: ${lastErr}`);
      if (i < attempts) await new Promise(r => setTimeout(r, 1000 * i)); // linear backoff
    }
  }

  const durationMs = Date.now() - startedAt;
  const result = {
    success: false,
    detail: `ALL_ATTEMPTS_FAILED (${attempts}x): ${lastErr} — MANUAL INTERVENTION REQUIRED`,
    durationMs,
  };
  recordCancelAllAttempt(result);
  console.error(`[cancelAll] CRITICAL — ${result.detail}`);
  return result;
}
