/**
 * SL Amend Trigger — TP1 hit anında native trailing-stop kurulumu için
 * executor'a discrete amend dispatch eder.
 *
 * Tasarim ilkesi: scanner sürekli amend GÖNDERMEZ. OKX native trailing
 * (algo-order, ordType=move_order_stop) ile takip işini borsaya teslim eder;
 * scanner sadece "TP1 vurdu, trailing'i şu callback ile kur" gibi olay-bazlı
 * tek-amend gönderir. Risklerin ezici çoğunluğu (rate limit, race, stale
 * tick) bu sayede elenmiş olur.
 *
 * Idempotency: signal kaydında slAmendDispatchedAt + slAmendSeq tutulur.
 * Helper bir kez tetiklendiğinde aynı sinyal için tekrar dispatch etmez.
 */

import { dispatchSlAmend } from '../okx-dispatcher.js';
import { updateSignal } from './signal-tracker.js';

/**
 * Eğer signal TP1-trailing transition'ında ise executor'a tek seferlik
 * SL amend gönder. Aksi halde sessizce çıkar.
 *
 * @param {object} prevSignal     updateSignal'dan ÖNCEKİ kayıt
 * @param {object} updatedSignal  updateSignal'dan SONRAKI kayıt
 */
export function maybeDispatchSlAmend(prevSignal, updatedSignal) {
  if (!prevSignal || !updatedSignal) return;

  // Sadece kripto pozisyonları executor'a gider (mevcut dispatch politikasıyla
  // tutarlı — bkz. signal-tracker.js#dispatchToOkxExecutor).
  const cat = updatedSignal.category || prevSignal.category;
  if (cat && cat !== 'kripto' && cat !== 'crypto') return;

  // Transition guard: trailing aktif ve breakevenAt set OLMUŞ olmalı.
  if (!updatedSignal.trailingStopActive) return;
  if (!updatedSignal.breakevenAt) return;

  // Idempotency: bir kez dispatch edildiyse tekrar atlama.
  if (updatedSignal.slAmendDispatchedAt) return;

  // tp1 mesafesi geçerli mi?
  const tp1 = Number(updatedSignal.tp1);
  const entry = Number(updatedSignal.entry);
  const sl = Number(updatedSignal.sl);
  if (!Number.isFinite(tp1) || !Number.isFinite(entry) || !Number.isFinite(sl)) return;
  const tp1Distance = Math.abs(tp1 - entry);
  if (tp1Distance <= 0) return;

  const seq = (Number(updatedSignal.slAmendSeq) || 0) + 1;
  const payload = {
    signalId: updatedSignal.id,
    symbol_tv: updatedSignal.symbol,
    side: updatedSignal.direction === 'short' ? 'short' : 'long',
    action: 'tp1_trail_setup',
    initialStop: sl,                       // halfway+ATR (outcome-checker hesapladı)
    callbackSpread: tp1Distance * 0.5,     // 0.5R — peak'ten geri çekilme mesafesi
    seq,
    reason: {
      id: updatedSignal.id,
      tp1,
      entry,
      slOriginal: Number.isFinite(Number(updatedSignal.slOriginal))
        ? Number(updatedSignal.slOriginal) : null,
      breakevenAt: updatedSignal.breakevenAt,
      slReason: updatedSignal.slReason ?? null,
    },
  };

  dispatchSlAmend(payload);

  // Idempotency state'ini kalıcılaştır. Dispatch fire-and-forget; ack gelmese
  // bile bir daha denenmez (executor seq guard'ı zaten duplicate'i drop eder).
  try {
    updateSignal(updatedSignal.id, {
      slAmendDispatchedAt: new Date().toISOString(),
      slAmendSeq: seq,
      slAmendAction: 'tp1_trail_setup',
    });
  } catch (e) {
    console.log(`[sl-amend-trigger] persist hatası (${updatedSignal.id}): ${e.message}`);
  }
}
