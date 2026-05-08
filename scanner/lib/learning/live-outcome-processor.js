/**
 * Live Outcome Processor
 *
 * Live price feed'den (Binance WS / Yahoo REST) gelen her tick icin acik
 * sinyalleri degerlendirir ve entry/SL/TP hit durumlarini ANINDA isler.
 * TV tabanli outcome-checker'in periyodik cycle'ini beklemez.
 *
 * Senkronizasyon: tek process icinde calistigi icin basit re-entrancy guard
 * yeterli. signal-tracker read/modify/write atomik (tek dosya, tek event-loop).
 */

import {
  getOpenSignals,
  updateSignal,
  removeOpenSignal,
} from './signal-tracker.js';
import { appendToArchive } from './persistence.js';
import { recordOutcome as recordLadderOutcome, isLadderEligibleTF } from './ladder-engine.js';
import { evaluateSignalOutcome, isTerminal, buildArchiveRecord } from './outcome-checker.js';
import { isMarketTradeable } from '../market-hours.js';
import { inferCategory } from '../symbol-resolver.js';

let _broadcast = null;
const _inflight = new Set(); // signalId -> tick processing flag

export function setBroadcast(fn) { _broadcast = fn; }

/**
 * Process a single live price tick against all matching open signals.
 * @param {{tvSymbol: string, price: number, ts?: number}} update
 */
export function processLivePriceUpdate(update) {
  if (!update || !update.tvSymbol || !isFinite(update.price)) return;
  const { tvSymbol, price } = update;

  const signals = getOpenSignals();
  if (!signals || signals.length === 0) return;

  const matches = signals.filter(s => s && s.symbol === tvSymbol);
  if (matches.length === 0) return;

  // Her tick icin sentetik bar (tick = high=low=close=open)
  const bar = { high: price, low: price, close: price, open: price, time: update.ts || Date.now() };

  for (const sig of matches) {
    if (_inflight.has(sig.id)) continue;
    if (isTerminal(sig.status, sig)) continue;
    // Market-hours gate: kapali piyasalarda (hafta sonu hisse vb.) Yahoo/Binance
    // tick'leri stale veri uretebilir; outcome update tetiklenmesin.
    const cat = sig.category || inferCategory(sig.symbol);
    if (cat && cat !== 'kripto' && !isMarketTradeable(cat)) continue;
    _inflight.add(sig.id);
    try {
      const updates = evaluateSignalOutcome(sig, bar);
      if (!updates) continue;

      // Sapma uyarisi geldiyse degisiklik yok — sessiz gec
      if (updates.warnings && !updates.status && !updates.entryHit
          && !updates.slHit && !updates.tp1Hit && !updates.tp2Hit && !updates.tp3Hit) {
        continue;
      }

      const updated = updateSignal(sig.id, updates);
      if (!updated) continue;

      const becameTerminal = isTerminal(updated.status, updated);
      if (becameTerminal) {
        const archiveRecord = buildArchiveRecord(updated);
        const yearMonth = new Date().toISOString().slice(0, 7);
        try { appendToArchive(yearMonth, archiveRecord); }
        catch (e) { console.log(`[LiveOutcome] archive hatasi (${sig.id}): ${e.message}`); }
        if (isLadderEligibleTF(sig.timeframe)) {
          try {
            recordLadderOutcome(sig.symbol, sig.grade, {
              status: updated.status,
              resolvedAt: archiveRecord.resolvedAt || updated.lastCheckedAt,
              signalId: sig.id,
            });
          } catch (e) { console.log(`[LiveOutcome] ladder hatasi (${sig.id}): ${e.message}`); }
        } else {
          console.log(`[LiveOutcome] ${sig.symbol} TF${sig.timeframe} ladder'a yazilmadi (1H league'dan haric)`);
        }
        removeOpenSignal(sig.id);
        console.log(`[LiveOutcome] ${sig.symbol} ${sig.direction.toUpperCase()} → ${updated.status} @ ${price} (live tick)`);
        if (_broadcast) {
          try { _broadcast({ type: 'signal_closed', signalId: sig.id, symbol: sig.symbol, status: updated.status, price }); } catch {}
        }
      } else if (updates.entryHit || updates.tp1Hit || updates.tp2Hit || updates.tp3Hit) {
        const hit = updates.tp3Hit ? 'tp3'
          : updates.tp2Hit ? 'tp2'
          : updates.tp1Hit ? 'tp1'
          : updates.entryHit ? 'entry' : null;
        console.log(`[LiveOutcome] ${sig.symbol} ${sig.direction.toUpperCase()} ${hit}_hit @ ${price} (live tick)`);
        if (_broadcast) {
          try { _broadcast({ type: 'signal_update', signalId: sig.id, symbol: sig.symbol, hit, price }); } catch {}
          if (updates.breakevenAt) {
            try { _broadcast({ type: 'signal_sl_breakeven', signalId: sig.id, symbol: sig.symbol, sl: updated.sl, price }); } catch {}
          }
        }
      }
    } catch (e) {
      console.log(`[LiveOutcome] ${sig.id} hata: ${e.message}`);
    } finally {
      _inflight.delete(sig.id);
    }
  }
}

/**
 * Handler'i server.js'den broadcast callback'ine sarmalamak icin yardimci.
 */
export function wrapBroadcast(originalBroadcast) {
  setBroadcast(originalBroadcast);
  return function broadcastWithLiveOutcome(msg) {
    try {
      if (msg && msg.type === 'live_prices' && Array.isArray(msg.updates)) {
        for (const u of msg.updates) {
          try { processLivePriceUpdate(u); } catch (e) { console.log('[LiveOutcome]', e.message); }
        }
      }
    } catch (e) { console.log('[LiveOutcome] wrap hatasi:', e.message); }
    return originalBroadcast(msg);
  };
}
