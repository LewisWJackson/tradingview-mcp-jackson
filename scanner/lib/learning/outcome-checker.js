/**
 * Outcome Checker — tracks open signals against current prices.
 * Determines if SL/TP levels were hit, computes MFE/MAE.
 *
 * FIXED: Sets correct timeframe per signal, validates prices,
 * uses getQuote for reliable current price.
 */

import { getOpenSignals, updateSignal, removeOpenSignal, diffIndicators, validateSignalPriceLevels } from './signal-tracker.js';
import { appendToArchive } from './persistence.js';
import { classifyOutcome, recordOutcome as recordLadderOutcome, isLadderEligibleTF } from './ladder-engine.js';
import * as bridge from '../tv-bridge.js';
import { acquireScanLock, releaseScanLock } from '../scanner-engine.js';
import { resolveSymbol, inferCategory } from '../symbol-resolver.js';
import { isMarketTradeable } from '../market-hours.js';
import { getLivePrice } from '../live-price-feed.js';

/**
 * Ayni 5m bar icinde hem SL hem TP1 dokundu mu? — tie-break 1m gerekir.
 * Sadece entry aktif ve henuz SL/TP kapanmamis sinyaller icin.
 */
export function detectBothHitOnBar(signal, bar) {
  if (!signal || !bar) return false;
  if (signal.slHit || signal.tp1Hit) return false;
  if (!signal.sl || !signal.tp1 || !signal.entry) return false;
  const isSmartEntry = signal.entrySource && signal.entrySource !== 'quote_price' && signal.entrySource !== 'lastbar_close';
  const entryActive = signal.entryHit || !isSmartEntry;
  if (!entryActive) return false;
  const { high, low } = bar;
  const dir = signal.direction;
  const slHit = (dir === 'long' && low <= signal.sl) || (dir === 'short' && high >= signal.sl);
  const tpHit = (dir === 'long' && high >= signal.tp1) || (dir === 'short' && low <= signal.tp1);
  return slHit && tpHit;
}

function appendWarning(signal, warning) {
  const warnings = Array.isArray(signal?.warnings) ? signal.warnings : [];
  return warnings.includes(warning) ? warnings : [...warnings, warning];
}

function signalForLevelValidation(signal) {
  if (!signal || typeof signal !== 'object') return signal;
  const sl = signal.slOriginal ?? signal.initialSl ?? signal.originalSl ?? signal.sl;
  return { ...signal, sl };
}

/**
 * Check a single signal against a current price bar.
 * Returns outcome updates (pure function, no side effects).
 */
export function evaluateSignalOutcome(signal, currentBar) {
  if (!signal || !currentBar) return null;

  const { high, low, close } = currentBar;
  const dir = signal.direction;
  const now = new Date().toISOString();

  const levelError = validateSignalPriceLevels(signalForLevelValidation(signal));
  if (levelError) {
    const warning = `[InvalidLevels] ${levelError}`;
    return {
      status: 'invalid_data',
      lastCheckedPrice: close,
      lastCheckedAt: now,
      checkCount: (signal.checkCount || 0) + 1,
      warnings: appendWarning(signal, warning),
    };
  }

  // 2026-05-04: Mevcut signal.sl entry'ye gore yon-ters ise (trailing/upsert
  // sirasinda entry kaydirildi, sl eski seviyede kaldi) slOriginal'a geri al;
  // aksi halde SL hit yanlislikla tetiklenir (PG olayi).
  // 2026-05-04 (REV): TP1 sonrasi BE/trailing SL entry'nin diger tarafina gecer
  // ve bu DOGRU davranistir — kar kilitleme. Boyle durumlarda repair yapma.
  const trailingActiveOrPostTp1 = !!(signal.tp1Hit || signal.tp2Hit || signal.tp3Hit
    || signal.trailingStopActive || signal.breakevenAt);
  if (!trailingActiveOrPostTp1
      && signal.entry != null && signal.sl != null
      && Number.isFinite(signal.sl) && Number.isFinite(signal.entry)) {
    const slWrongSide = (dir === 'long' && signal.sl >= signal.entry)
      || (dir === 'short' && signal.sl <= signal.entry);
    if (slWrongSide) {
      const fallback = Number.isFinite(signal.slOriginal) ? signal.slOriginal : null;
      const fallbackOk = fallback != null && (
        (dir === 'long' && fallback < signal.entry) ||
        (dir === 'short' && fallback > signal.entry)
      );
      if (fallbackOk) {
        const oldSl = signal.sl;
        const repairWarning = `[SL-Repair] ${dir} sinyalde sl yon-ters (${oldSl}→${fallback}); slOriginal'a geri alindi`;
        return {
          sl: fallback,
          trailingStopLevel: null,
          trailingStopActive: false,
          slReason: 'SL-Repair: yon-ters seviyeden slOriginal\'a geri alindi',
          lastCheckedPrice: close,
          lastCheckedAt: now,
          checkCount: (signal.checkCount || 0) + 1,
          warnings: appendWarning(signal, repairWarning),
        };
      } else {
        return {
          status: 'invalid_data',
          lastCheckedPrice: close,
          lastCheckedAt: now,
          checkCount: (signal.checkCount || 0) + 1,
          warnings: appendWarning(signal, `[SL-Wrong-Side] ${dir} ama sl=${signal.sl} entry=${signal.entry} (slOriginal yok/gecersiz)`),
        };
      }
    }
  }

  // Migration: eski kodla slHit=true + trailingStopExit=true isaretlenmis ama
  // status 'tp1_hit'/'tp2_hit' kaldigi icin open listesinde takili kalan
  // sinyalleri yakala ve terminal status'a yukselt.
  if (signal.slHit && signal.trailingStopExit && signal.status !== 'trailing_stop_exit') {
    return {
      status: 'trailing_stop_exit',
      trailingExitTier: signal.tp2Hit ? 'tp2' : 'tp1',
      lastCheckedAt: now,
      lastCheckedPrice: close,
      checkCount: (signal.checkCount || 0) + 1,
    };
  }

  // Sanity check: current price should be in the same ballpark as entry
  if (signal.entry && close) {
    const deviation = Math.abs(close - signal.entry) / signal.entry;
    if (deviation > 0.10) {
      // Price is 50%+ away from entry — likely wrong symbol/data
      return {
        lastCheckedAt: now,
        checkCount: (signal.checkCount || 0) + 1,
        warnings: [`Fiyat sapmasi cok yuksek: entry=${signal.entry}, current=${close}, sapma=%${(deviation * 100).toFixed(1)}`],
      };
    }
  }

  const updates = {
    lastCheckedPrice: close,
    lastCheckedAt: now,
    checkCount: (signal.checkCount || 0) + 1,
  };

  // Determine if entry needs to be "reached" before tracking SL/TP
  // Legacy signals (no entrySource) or quote_price entries are always considered reached
  // 2026-05-05: entryZone tanimli + entrySource=quote_price (smart→market downgrade)
  // durumunda da smart muamele yap — fiyat zone'a gercekten dokunmadan entryHit
  // atanmasin (AVGO/FLNC olayi).
  const isSmartEntry = (signal.entrySource && signal.entrySource !== 'quote_price' && signal.entrySource !== 'lastbar_close')
    || (signal.entryZone && signal.entrySource === 'quote_price' && signal.entryZone.high != null && signal.entryZone.low != null);
  const alreadyReached = signal.entryHit || !isSmartEntry;

  // Normalize: market (quote_price/lastbar_close) veya legacy entry ise
  // entryHit=true olmali. Upsert/refresh yollarindan smart→market gecisi
  // entryHit'i gerigide birakabiliyor; burada retroaktif duzelt.
  if (!isSmartEntry && !signal.entryHit) {
    updates.entryHit = true;
    updates.entryHitAt = signal.entryHitAt || signal.createdAt || now;
  }

  // Track whether smart entry price was actually reached.
  // Smart/limit entry icin fill ancak fiyat entry seviyesine dokunursa gercektir;
  // ATR toleransi entry'ye dokunmayan islemleri sahte fill'e cevirebilir.
  const entryTouched = (dir === 'long' && low <= signal.entry)
    || (dir === 'short' && high >= signal.entry);
  if (isSmartEntry && signal.entryHit && signal.entryHitPrice == null) {
    if (entryTouched) {
      updates.entryHit = true;
      updates.entryHitAt = now;
      updates.entryHitPrice = signal.entry;
    } else {
      updates.entryHit = false;
      updates.entryHitAt = null;
      updates.highestFavorable = 0;
      updates.lowestAdverse = 0;
    }
  }
  if (isSmartEntry && !signal.entryHit) {
    if (entryTouched) {
      updates.entryHit = true;
      updates.entryHitAt = now;
      updates.entryHitPrice = signal.entry;
    } else {
      // Pre-entry MFE: sinyal yonunde ama entry dolmadan ne kadar kacirdik?
      // entry_expired sonrasi "bu sinyal hakliymis ama giremedik" istatistigi.
      if (dir === 'long' && signal.entry) {
        const missed = high - signal.entry; // + = fiyat yukari gitti, pullback olmadi
        if (missed > (signal.preEntryMFE || 0)) updates.preEntryMFE = missed;
      } else if (dir === 'short' && signal.entry) {
        const missed = signal.entry - low;
        if (missed > (signal.preEntryMFE || 0)) updates.preEntryMFE = missed;
      }

      // Entry gelmeden TP hit kontrolu (2026-05-04 revize):
      //   TP1 hit tek basina entry_missed sayilmaz — TP1 yakin hedef, fiyat
      //   sıkça entry'ye geri donebilir. TP2 hit ise fırsat tamamen kacmistir.
      //   Istisna: TP1 hit ettikten sonra 48 saat icinde fiyat entry'ye donmezse
      //   yine entry_missed_tp olarak kapatilir (sinyal yasını uzatma onlemı).
      if (signal.tp2 != null && isFinite(signal.tp2)) {
        const tp2Crossed = (dir === 'long' && high >= signal.tp2)
          || (dir === 'short' && low <= signal.tp2);
        if (tp2Crossed) {
          updates.status = 'entry_missed_tp';
          updates.entryExpiredAt = now;
          return updates;
        }
      }
      if (signal.tp1 != null && isFinite(signal.tp1)) {
        const tp1Crossed = (dir === 'long' && high >= signal.tp1)
          || (dir === 'short' && low <= signal.tp1);
        if (tp1Crossed && !signal.tp1CrossedWhilePendingAt) {
          // İlk TP1 dokunusunu işaretle — 48 saatlik geri dönüş penceresi başlar.
          updates.tp1CrossedWhilePendingAt = now;
        } else if (signal.tp1CrossedWhilePendingAt) {
          const PULLBACK_WINDOW_MS = 48 * 60 * 60 * 1000;
          const elapsed = new Date(now) - new Date(signal.tp1CrossedWhilePendingAt);
          if (elapsed >= PULLBACK_WINDOW_MS) {
            updates.status = 'entry_missed_tp';
            updates.entryExpiredAt = now;
            return updates;
          }
        }
      }

      // Entry deadline dolduysa sinyali kapat
      if (signal.entryDeadline && new Date(now) >= new Date(signal.entryDeadline)) {
        updates.status = 'entry_expired';
        updates.entryExpiredAt = now;
        return updates;
      }
    }
  }

  const entryActive = alreadyReached || updates.entryHit;

  // Compute favorable/adverse excursion (only after entry is reached).
  // 0'a clamp: MFE/MAE tanim geregi negatif olamaz (hareket olmamissa 0).
  // null-handling olmadan ilk kayit negatif yazilabiliyordu — ISCTR/MIATK
  // bug'i (entry sonrasi ilk bar high<entry geldiginde -3.22 vb).
  if (entryActive && dir === 'long' && signal.entry) {
    const fav = Math.max(0, high - signal.entry);
    const adv = Math.max(0, signal.entry - low);
    if (signal.highestFavorable == null || fav > signal.highestFavorable) updates.highestFavorable = fav;
    if (signal.lowestAdverse == null || adv > signal.lowestAdverse) updates.lowestAdverse = adv;
  } else if (entryActive && dir === 'short' && signal.entry) {
    const fav = Math.max(0, signal.entry - low);
    const adv = Math.max(0, high - signal.entry);
    if (signal.highestFavorable == null || fav > signal.highestFavorable) updates.highestFavorable = fav;
    if (signal.lowestAdverse == null || adv > signal.lowestAdverse) updates.lowestAdverse = adv;
  }

  // Check SL/TP only if entry has been reached (or not a smart entry)
  if (entryActive) {
    // Check SL hit (priority over TP on same bar — conservative).
    // Ayni bar icinde hem SL hem TP dokunmasi durumunda caller 1m barlarla
    // tie-break yapar; burada SL-priority default olarak kalir.
    if (signal.sl && !signal.slHit) {
      if ((dir === 'long' && low <= signal.sl) || (dir === 'short' && high >= signal.sl)) {
        updates.slHit = true;
        updates.slHitAt = now;
        updates.slHitPrice = signal.sl;
        // "sl_hit_high_mfe": TP1 hic dolmadi ama yon dogruydu — fiyat TP1
        // mesafesinin en az %70'ine kadar gitti. Ladder bunu loss saymaz
        // (nötr), aksi halde 1.5R TP ile haksiz demote tetiklenir.
        const tp1Dist = (signal.tp1 != null && signal.entry != null)
          ? Math.abs(signal.tp1 - signal.entry) : null;
        const mfeSoFar = Math.max(
          Number(signal.highestFavorable) || 0,
          Number(updates.highestFavorable) || 0
        );
        if (signal.tp1Hit) {
          // TP1 zaten vurulmus → SL artik en kotu BE/trailing seviyesidir.
          // Bu bir kayip degil, kilitlenmis kazancin cikisi. Terminal status
          // olarak 'trailing_stop_exit' kullan — 'tp1_hit'/'tp2_hit' terminal
          // degil, pozisyonu acik listede birakir (SL badge + acik pozisyon
          // tutarsizligi).
          updates.status = 'trailing_stop_exit';
          updates.trailingStopExit = true;
          updates.trailingExitTier = signal.tp2Hit ? 'tp2' : 'tp1';
        } else if (tp1Dist != null && tp1Dist > 0 && mfeSoFar >= tp1Dist) {
          // MFE TP1 mesafesini TAM gectigi halde TP1 hit isaretlenmemis →
          // ayni barda hem TP1 hem SL dokunup 1m tie-break basarisiz olmus
          // demektir (default SL-onceligi pesimist sonuc). Fiyat TP1 kadar
          // veya daha fazla lehte gittigi icin TP1-once varsayimi daha az
          // hatali. Geriye donuk TP1-hit + BE migration uygula, sonra
          // trailing-stop-exit ile kapat. Reward = newSL - entry (BE+ATR
          // halfway) — hafif negatif veya sifira yakindir, full SL kayip
          // degildir.
          updates.tp1Hit = true;
          updates.tp1HitAt = signal.tp1HitAt || now;
          updates.tp1HitPrice = signal.tp1;
          if (signal.slOriginal == null) updates.slOriginal = signal.sl;
          // Retro durumda kesin BE kullan: TP1 doldu varsayimi + BE migration
          // varsayimi → exit entry'de gerceklesti say. Reward = 0, RR = 0.
          // Boylece PF hesabinda yalanci negatif-RR win uretmiyoruz.
          updates.trailingStopActive = true;
          updates.trailingStopLevel = signal.entry;
          updates.slHitPrice = signal.entry;
          updates.breakevenAt = signal.breakevenAt || now;
          updates.status = 'trailing_stop_exit';
          updates.trailingStopExit = true;
          updates.trailingExitTier = 'tp1';
          updates.retroTp1FromMfe = true;
          updates.slReason = `MFE>=TP1 retroaktif: TP1 hit + BE exit (RR=0)`;
        } else if (tp1Dist != null && tp1Dist > 0 && mfeSoFar >= tp1Dist * 0.7) {
          updates.status = 'sl_hit_high_mfe';
          updates.highMfeFlag = true;
        } else {
          updates.status = 'sl_hit';
        }

        // --- Faulty trade analizi ---
        // SL tetiklendiginde acikken gelen zit yon sinyalleri (reverseAttempts)
        // hakli cikmis demektir. Bu sinyali "hatali trade" olarak isaretle ki
        // otonom ogrenme indikator agirliklarini ayarlayabilsin.
        // NOT: TP1 zaten vurulmussa "faulty" degil — reverse sinyal dogruydu ama
        // pozisyon zaten kazanc kilitlemisti, o yuzden bu blok atlanir.
        const reverseAttempts = Array.isArray(signal.reverseAttempts) ? signal.reverseAttempts : [];
        if (reverseAttempts.length > 0 && !signal.tp1Hit) {
          updates.faultyTrade = true;
          updates.faultyTradeReason = `${reverseAttempts.length} zit yon sinyal acikken geldi, SL tetiklendi`;
          const first = reverseAttempts[0];
          updates.faultyTradeAnalysis = {
            openedWithGrade: signal.grade,
            openedWithTF: signal.timeframe,
            openedWithIndicators: signal.indicators || null,
            ignoredReverseCount: reverseAttempts.length,
            ignoredReverseGrades: reverseAttempts.map(r => r.grade),
            ignoredReverseTFs: reverseAttempts.map(r => r.timeframe),
            firstReverseAt: first.at,
            firstReverseLagMinutes: Math.round(
              (new Date(first.at) - new Date(signal.createdAt)) / 60000
            ),
            indicatorDrift: diffIndicators(signal.indicators, first.indicatorSnapshot),
          };
          console.log(`[Outcome] FAULTY TRADE: ${signal.symbol} ${signal.direction} ${signal.grade} — ${reverseAttempts.length} ignored reverse, SL hit`);
        }
        return updates;
      }
    }

    // Check TP levels (highest first)
    if (signal.tp3 && !signal.tp3Hit) {
      if ((dir === 'long' && high >= signal.tp3) || (dir === 'short' && low <= signal.tp3)) {
        updates.tp3Hit = true;
        updates.tp3HitAt = now;
        updates.tp3HitPrice = signal.tp3;
        updates.tp2Hit = true;
        updates.tp2HitAt = updates.tp2HitAt || now;
        updates.tp2HitPrice = signal.tp2 || null;
        updates.tp1Hit = true;
        updates.tp1HitAt = updates.tp1HitAt || now;
        updates.tp1HitPrice = signal.tp1 || null;
        updates.status = 'tp3_hit';
        return updates;
      }
    }

    if (signal.tp2 && !signal.tp2Hit) {
      if ((dir === 'long' && high >= signal.tp2) || (dir === 'short' && low <= signal.tp2)) {
        updates.tp2Hit = true;
        updates.tp2HitAt = now;
        updates.tp2HitPrice = signal.tp2;
        updates.tp1Hit = true;
        updates.tp1HitAt = updates.tp1HitAt || now;
        updates.tp1HitPrice = signal.tp1 || null;
        updates.status = 'tp2_hit';
        // 2-TP modu (signal.tp3 == null): TP2 terminal, TP3 beklenmez.
        if (signal.tp3 == null) return updates;
        // Don't return — continue tracking for TP3
      }
    }

    if (signal.tp1 && !signal.tp1Hit) {
      if ((dir === 'long' && high >= signal.tp1) || (dir === 'short' && low <= signal.tp1)) {
        updates.tp1Hit = true;
        updates.tp1HitAt = now;
        updates.tp1HitPrice = signal.tp1;
        // Status sadece daha ilerlemis bir TP yoksa tp1_hit olmalidir —
        // ayni barda TP2/TP3 de vurulduysa onceki blok zaten tp2_hit/tp3_hit
        // atamistir; burada ezmeyelim.
        if (!updates.tp2Hit && !updates.tp3Hit && !signal.tp2Hit && !signal.tp3Hit) {
          updates.status = 'tp1_hit';
        }
        // Trailing stop aktiflestir.
        // A+B karma: SL'yi break-even'e cekmek yerine entry ile orijinal SL
        // arasinda makul bir ara seviyeye tasi. Bu sayede TP1 sonrasi normal
        // pullback'lerde 0R'da knockout olunmaz; gercek reversal'da hala
        // koruma vardir.
        //   halfway   = (slOriginal + entry) / 2
        //   atrBuffer = entry ± 0.5 × ATR
        //   newSL     = ikisinden hangisi daha fazla nefes aliyorsa o
        //               (long: dusuk olan, short: yuksek olan)
        // Clamp: orijinal SL'den daha kotu olamaz (long'da > slOrig, short'ta < slOrig).
        const slOrig = signal.slOriginal != null ? signal.slOriginal : signal.sl;
        const atrVal = Number(signal.atr);
        const halfway = (slOrig + signal.entry) / 2;
        let newSL;
        if (Number.isFinite(atrVal) && atrVal > 0) {
          const atrBuffer = dir === 'long'
            ? signal.entry - 0.5 * atrVal
            : signal.entry + 0.5 * atrVal;
          newSL = dir === 'long' ? Math.min(halfway, atrBuffer) : Math.max(halfway, atrBuffer);
        } else {
          newSL = halfway;
        }
        // Improvement clamp: orijinal SL'den daha kotu olmasin.
        if (dir === 'long' && newSL < slOrig) newSL = slOrig;
        if (dir === 'short' && newSL > slOrig) newSL = slOrig;
        updates.trailingStopActive = true;
        updates.trailingStopLevel = newSL;
        if (signal.slOriginal == null) updates.slOriginal = signal.sl;
        updates.sl = newSL;
        updates.breakevenAt = now;
        const halfwayLabel = halfway.toFixed(4);
        const buffNote = Number.isFinite(atrVal) && atrVal > 0
          ? `, ATR buf=${(signal.entry + (dir === 'long' ? -0.5 : 0.5) * atrVal).toFixed(4)}`
          : '';
        updates.slReason = `TP1 hit → SL halfway+ATR'ye cekildi (${newSL.toFixed(4)}; halfway=${halfwayLabel}${buffNote})`;
        // Continue tracking for TP2/TP3
      }
    }

    // --- Retroaktif BE: tp1Hit zaten true ama trailing aktiflestirilmemis ---
    // Eski koddan kalma acik pozisyonlar (COPPER gibi) icin: TP1 vurulmus ama
    // SL hala orijinal seviyedeyse, en azindan BE'ye cek. tp2Hit varsa TP1
    // seviyesine kilitle (1R kazanc korumasi).
    if (signal.tp1Hit && !signal.trailingStopActive && !updates.trailingStopActive) {
      const lockLevel = signal.tp2Hit ? signal.tp1 : signal.entry;
      const currentSl = updates.sl ?? signal.sl;
      const improved = dir === 'long'
        ? (currentSl == null || lockLevel > currentSl)
        : (currentSl == null || lockLevel < currentSl);
      if (improved) {
        updates.sl = lockLevel;
      }
      updates.trailingStopActive = true;
      updates.trailingStopLevel = updates.sl ?? lockLevel;
      updates.beMigratedAt = now;
    }

    // --- Aggressive-trail tetigi: TP1 sonrasi 2+ A/B/C zit yon sinyal geldiyse ---
    // Trend yorulmasi/donus emaresi: kâri maksimize etmek için SL'yi daha sıkı trail et.
    // 0.5×TP1 yerine 0.25×TP1 mesafede kilitle.
    {
      const ra = Array.isArray(signal.reverseAttempts) ? signal.reverseAttempts : [];
      const realReverses = ra.filter(r => r && (r.grade === 'A' || r.grade === 'B' || r.grade === 'C'));
      if ((signal.tp1Hit || updates.tp1Hit) && realReverses.length >= 2 && !signal.aggressiveTrailActive) {
        updates.aggressiveTrailActive = true;
        updates.aggressiveTrailReason = `${realReverses.length} adet A/B/C zit yon sinyali → SL daha sıkı trail moduna alındı (kâr koruma)`;
      }
    }

    // --- Trailing stop ilerletme (zaten aktifse) ---
    // TP1 hit olmus ve trailing aktif. Karda ilerledikce SL'yi yukari (long) /
    // asagi (short) tasi. Zararda ASLA trailing yapilmaz — tp1Hit olmadan blok
    // calismaz.
    if ((signal.trailingStopActive || updates.trailingStopActive) && (signal.tp1Hit || updates.tp1Hit)) {
      const currentTrail = updates.trailingStopLevel ?? signal.trailingStopLevel ?? signal.entry;
      const tp1Distance = Math.abs(signal.tp1 - signal.entry);
      const aggressive = signal.aggressiveTrailActive || updates.aggressiveTrailActive;
      const lockDistance = tp1Distance * (aggressive ? 0.25 : 0.5); // aggressive: 0.25, normal: 0.5
      if (dir === 'long') {
        const newTrail = high - lockDistance;
        if (newTrail > currentTrail) {
          updates.trailingStopLevel = newTrail;
          updates.sl = newTrail;
        }
      } else {
        const newTrail = low + lockDistance;
        if (newTrail < currentTrail) {
          updates.trailingStopLevel = newTrail;
          updates.sl = newTrail;
        }
      }
    }
  }

  // NOT: Expiry kontrolu kaldirildi. Pozisyonlar sadece SL/TP/manuel/supersede ile kapanir.
  // BEKLE (sanal) sinyaller icin symbol bazli cap (signal-tracker.js) balloning'i engeller.

  return updates;
}

/**
 * Determine if a signal is fully resolved (terminal state).
 */
export function isTerminal(status, signal = null) {
  const alwaysTerminal = [
    'sl_hit', 'sl_hit_high_mfe', 'tp3_hit', 'invalid_data',
    'superseded', 'superseded_by_tf', 'superseded_by_cleanup', 'superseded_by_cap',
    'superseded_by_reverse',
    'manual_close', 'trailing_stop_exit', 'entry_expired', 'entry_missed_tp',
  ];
  if (alwaysTerminal.includes(status)) return true;
  // 2-TP modu: TP2 terminal kabul edilir (signal.tp3 == null).
  if (status === 'tp2_hit' && signal && signal.tp3 == null) return true;
  return false;
}

function isSmartEntrySignal(signal) {
  return !!(signal?.entrySource && signal.entrySource !== 'quote_price' && signal.entrySource !== 'lastbar_close');
}

function hasNoExecutedEntry(signal) {
  return isSmartEntrySignal(signal) && !signal.entryHit
    && !signal.tp1Hit && !signal.tp2Hit && !signal.tp3Hit && !signal.slHit;
}

/**
 * Compute the actual R:R for a resolved signal.
 */
function computeActualRR(signal) {
  if (!signal.entry) return null;
  if (hasNoExecutedEntry(signal)) return null;

  const riskSl = signal.slOriginal ?? signal.initialSl ?? signal.originalSl ?? signal.sl;
  if (!riskSl) return null;
  const risk = Math.abs(signal.entry - riskSl);
  if (risk === 0) return null;

  let reward = 0;
  if (signal.status === 'trailing_stop_exit' && signal.slHitPrice != null) {
    // Trailing stop cikisi: kazanc kilidi. Reward = trailing seviyesi - entry
    // (yon isaretli). Negatif olamaz cunku trailing TP1 sonrasi BE+ seviyededir.
    reward = signal.direction === 'long'
      ? (signal.slHitPrice - signal.entry)
      : (signal.entry - signal.slHitPrice);
  }
  else if (signal.tp3Hit && signal.tp3) reward = Math.abs(signal.tp3 - signal.entry);
  else if (signal.tp2Hit && signal.tp2) reward = Math.abs(signal.tp2 - signal.entry);
  else if (signal.tp1Hit && signal.tp1) reward = Math.abs(signal.tp1 - signal.entry);
  else if (signal.slHit) reward = -risk;
  else if (signal.lastCheckedPrice) reward = signal.direction === 'long'
    ? signal.lastCheckedPrice - signal.entry
    : signal.entry - signal.lastCheckedPrice;

  return Math.round((reward / risk) * 100) / 100;
}

/**
 * Build an archive record from a resolved signal.
 */
export function buildArchiveRecord(signal) {
  const resolvedAt = new Date().toISOString();
  const holdingMs = new Date(resolvedAt) - new Date(signal.createdAt);
  const holdingMinutes = Math.round(holdingMs / 60000);
  const actualRR = computeActualRR(signal);
  // win uc-durumlu: true (TP/trailing), false (sl_hit), null (neutral —
  // entry_expired, superseded_*, sl_hit_high_mfe, manual_close, invalid_data).
  // anomaly-detector `s.win != null` filtresiyle neutral'lari dislar; boylece
  // entry-not-filled veya yon-dogru-TP-yetersiz sinyaller PF'yi zehirlemez.
  const _cls = classifyOutcome(signal.status);
  const win = _cls === 'win' ? true : (_cls === 'loss' ? false : null);

  // Invariant: entryHit=false iken hicbir SL/TP "hit" flag'i true olamaz —
  // entry dolmadan pozisyon yok, dolayisiyla SL/TP fiilen tetiklenemez.
  // FSLR-tipi gap-up senaryosunda fiyat tp1 seviyesini gecse de bu pre-entry
  // bir gozlemdir; tp1Hit flag'i sadece fiilen acik pozisyon icin anlamlidir.
  const flagOverrides = {};
  if (!signal.entryHit) {
    if (signal.tp1Hit) flagOverrides.tp1Hit = false;
    if (signal.tp2Hit) flagOverrides.tp2Hit = false;
    if (signal.tp3Hit) flagOverrides.tp3Hit = false;
    if (signal.slHit) flagOverrides.slHit = false;
  }

  return {
    ...signal,
    ...flagOverrides,
    resolvedAt,
    outcome: signal.status,
    actualRR,
    holdingPeriodMinutes: holdingMinutes,
    maxFavorableExcursion: signal.highestFavorable,
    maxAdverseExcursion: signal.lowestAdverse,
    win,
  };
}

/**
 * Get the timeframe for OHLCV that best covers the check interval.
 * We use 5m bars to capture intra-check price extremes.
 */
function getCheckTimeframe(signalTF) {
  // Use 5m for most signals to catch wicks between 5-min checks
  // For daily/weekly signals, 1h is sufficient
  const tf = String(signalTF);
  if (['1D', '3D', '1W', '1M'].includes(tf)) return '60';
  if (['240'].includes(tf)) return '15';
  return '5'; // Use 5m for all short-term signals
}

/**
 * Check all open signals against current prices.
 * FIXED: Sets correct timeframe per signal, validates prices.
 * Groups by symbol to minimize chart switching.
 * Returns { checked, resolved, errors }.
 */
export async function checkAllOpenSignals(options = {}) {
  const signals = getOpenSignals();
  if (signals.length === 0) return { checked: 0, resolved: 0, errors: 0 };

  // Stale detection: 12h+ kontrol edilmemis acik sinyaller polling kaybi
  // belirtisidir. Operator gorunurlugu icin warning at.
  const STALE_THRESHOLD_MS = 12 * 3600 * 1000;
  const nowTs = Date.now();
  const stale = signals.filter(s => s.lastCheckedAt && (nowTs - new Date(s.lastCheckedAt).getTime() > STALE_THRESHOLD_MS));
  if (stale.length > 0) {
    const sample = stale.slice(0, 5).map(s => `${s.symbol}/${s.timeframe} (${((nowTs - new Date(s.lastCheckedAt).getTime())/3600000).toFixed(0)}h)`).join(', ');
    console.warn(`[Outcome] STALE WARNING: ${stale.length} acik sinyal 12h+ kontrol edilmemis. Ornek: ${sample}`);
  }

  // Acquire chart lock with 30s timeout — if a scan is running, skip this cycle
  try {
    await acquireScanLock('outcome-checker', 30000);
  } catch (e) {
    console.log(`[Outcome] Chart kilidi alinamadi, bu tur atlaniyor: ${e.message}`);
    return { checked: 0, resolved: 0, errors: 0, skipped: true };
  }

  try {
    return await _checkAllOpenSignalsInner(signals);
  } finally {
    releaseScanLock();
  }
}

async function _checkAllOpenSignalsInner(signals) {
  // Group signals by symbol
  const bySymbol = {};
  for (const sig of signals) {
    if (!bySymbol[sig.symbol]) bySymbol[sig.symbol] = [];
    bySymbol[sig.symbol].push(sig);
  }

  let checked = 0;
  let resolved = 0;
  let errors = 0;
  const resolvedSignals = [];

  for (const [symbol, symbolSignals] of Object.entries(bySymbol)) {
    try {
      // Market-hours gate: kapali piyasalarda (hafta sonu hisse, BIST gece, vb.)
      // outcome-checker stale (donmus) Cuma kapanis barlarini yeniden islemesin.
      // 2026-05-03: CRCL hafta sonu trailing_stop_exit bug'i icin eklendi.
      const cat = symbolSignals[0]?.category || inferCategory(symbol);
      if (cat && cat !== 'kripto' && !isMarketTradeable(cat)) {
        continue;
      }
      // Switch chart to this symbol (borsa prefix'i ile cozumle)
      const chartSymbol = symbol.includes(':') ? symbol : resolveSymbol(symbol, inferCategory(symbol));
      const setRes = await bridge.setSymbol(chartSymbol);
      if (setRes?.success === false) {
        console.log(`[Outcome] ${chartSymbol} setSymbol dogrulanamadi — bu sembol icin kontrol atlaniyor`);
        errors++;
        continue;
      }

      // For each signal, set the appropriate check TF and get bars
      for (const sig of symbolSignals) {
        try {
          // Validate signal has required data
          const levelError = validateSignalPriceLevels(signalForLevelValidation(sig));
          if (levelError) {
            const warning = `[InvalidLevels] ${levelError}`;
            const updates = {
              status: 'invalid_data',
              lastCheckedAt: new Date().toISOString(),
              warnings: appendWarning(sig, warning),
            };
            const updated = updateSignal(sig.id, updates);
            if (updated) {
              const archiveRecord = buildArchiveRecord({ ...updated, win: false });
              const yearMonth = new Date().toISOString().slice(0, 7);
              appendToArchive(yearMonth, archiveRecord);
              if (isLadderEligibleTF(sig.timeframe)) {
                try {
                  recordLadderOutcome(sig.symbol, sig.grade, {
                    status: updated.status,
                    resolvedAt: archiveRecord.resolvedAt || updates.lastCheckedAt,
                    signalId: sig.id,
                  });
                } catch (e) { console.log(`[Outcome] ladder.recordOutcome hatasi (${sig.id}): ${e.message}`); }
              } else {
                console.log(`[Outcome] ${sig.symbol} TF${sig.timeframe} ladder'a yazilmadi (1H league'dan haric)`);
              }
              removeOpenSignal(sig.id);
              resolved++;
            }
            continue;
          }

          // Set appropriate check timeframe
          const checkTF = getCheckTimeframe(sig.timeframe);
          await bridge.setTimeframe(checkTF);
          await new Promise(r => setTimeout(r, 1500));

          // Adaptif bar penceresi: son kontrolden bu yana gecen sureyi kapsayacak
          // kadar bar cek. Chart-lock contention yuzunden cycle'lar atlanabildiginden
          // sabit 3 bar (~15 dk) penceresi wick'leri kaciriyordu (ornegin COPPER TP3
          // fitili 45+dk gap'te kayboldu). En az 12 bar (guvenlik payi), en fazla 500.
          const checkTFMinutes = parseInt(checkTF, 10) || (checkTF === '60' ? 60 : 5);
          const lastCheckedMs = sig.lastCheckedAt ? new Date(sig.lastCheckedAt).getTime() : 0;
          const gapMs = lastCheckedMs ? (Date.now() - lastCheckedMs) : 0;
          const gapBars = lastCheckedMs ? Math.ceil(gapMs / (checkTFMinutes * 60000)) : 12;
          const barsToGet = Math.max(12, Math.min(500, gapBars + 4));
          const ohlcv = await bridge.getOhlcv(barsToGet, false, chartSymbol);
          if (ohlcv && ohlcv._symbolMismatch) {
            console.log(`[Outcome] ${sig.id}: chart symbol kaymasi (beklenen ${ohlcv._expected}, alinan ${ohlcv._got}) — atlandi`);
            errors++;
            continue;
          }
          const bars = ohlcv?.bars || [];
          if (bars.length === 0) { errors++; continue; }

          const lastClose = bars[bars.length - 1].close;

          // 2026-05-04: SUIUSDC tp3_hit hatasi sonrasi sıkılaştırıldı (50% → 10%).
          // Ek olarak crypto sinyallerinde Binance live feed ile çapraz doğrulama:
          // TV bar'ı Binance'den >%5 sapıyorsa kontamine veri, sinyali atla.
          const priceDeviation = Math.abs(lastClose - sig.entry) / sig.entry;
          if (priceDeviation > 0.10) {
            console.log(`[Outcome] ${symbol}: fiyat sapmasi cok yuksek (entry=${sig.entry}, current=${lastClose}, sapma=%${(priceDeviation * 100).toFixed(1)}) — atlaniyor`);
            errors++;
            continue;
          }
          if ((sig.category === 'kripto' || sig.category === 'crypto')) {
            const livePx = getLivePrice(sig.symbol);
            if (livePx && Number.isFinite(livePx) && livePx > 0) {
              const tvVsBinance = Math.abs(lastClose - livePx) / livePx;
              if (tvVsBinance > 0.05) {
                console.log(`[Outcome] ${symbol}: TV bar (${lastClose}) ile Binance (${livePx}) arasında %${(tvVsBinance*100).toFixed(1)} sapma — kontamine veri, atlandi`);
                errors++;
                continue;
              }
            }
          }

          // Barlari SIRAYLA degerlendir — bir syntetic barda birlestirmek
          // SL'yi TP'den once kontrol edildigi icin yanli sonuc verirdi (ornegin
          // bar1'de TP1, bar2'de SL olsa bile evaluateSignalOutcome tek bakista
          // SL hit diyordu). Artik her bar ayri asamalidir ve terminale erisen
          // ilk bar kesin sonucu belirler.
          let updated = sig;
          let anyUpdate = false;
          for (const bar of bars) {
            // Tie-break: ayni barda hem SL hem TP dokunduysa 1m barlarla sirayi
            // kesin olarak cozumle. Aksi halde SL-onceligi pesimist onyargi
            // yaratir. Cozumleme sirasinda TF 1m'e alinir ve bar penceresi
            // kadar 1m bar okunur; sonrasinda TF check TF'sine geri donulur.
            if (detectBothHitOnBar(updated, bar)) {
              try {
                await bridge.setTimeframe('1');
                await new Promise(r => setTimeout(r, 1200));
                const tfMinutes = parseInt(checkTF, 10) || 5;
                const oneMin = await bridge.getOhlcv(tfMinutes + 5, false);
                const oneBars = (oneMin?.bars || []).filter(b => {
                  const t = typeof b.time === 'number' ? b.time * (b.time < 1e12 ? 1000 : 1) : new Date(b.time).getTime();
                  const barT = typeof bar.time === 'number' ? bar.time * (bar.time < 1e12 ? 1000 : 1) : new Date(bar.time).getTime();
                  return t >= barT && t < barT + tfMinutes * 60000;
                });
                for (const m of oneBars) {
                  const updates = evaluateSignalOutcome(updated, m);
                  if (!updates) continue;
                  const afterUpdate = updateSignal(updated.id, updates);
                  if (afterUpdate) {
                    updated = afterUpdate;
                    anyUpdate = true;
                    if (isTerminal(afterUpdate.status, afterUpdate)) break;
                  }
                }
                // TF'yi 5m check TF'sine geri al
                await bridge.setTimeframe(checkTF);
                await new Promise(r => setTimeout(r, 800));
                if (isTerminal(updated.status, updated)) break;
                continue;
              } catch (e) {
                console.log(`[Outcome] ${sig.symbol} 1m tie-break hatasi: ${e.message} — 5m bar ile SL-onceligi fallback`);
                // 1m tie-break basarisiz — sonuc pesimist (SL-once) cikabilir.
                // Ogrenme zehirlenmesin diye dataContaminated isaretle; readAllArchives
                // varsayilan olarak bu kayitlari filtreler.
                const contam = updateSignal(updated.id, {
                  dataContaminated: true,
                  contaminationReason: `tie_break_1m_failed: ${e.message}`,
                });
                if (contam) updated = contam;
                // fall through: eski 5m davranis
              }
            }
            const updates = evaluateSignalOutcome(updated, bar);
            if (!updates) continue;
            const afterUpdate = updateSignal(updated.id, updates);
            if (afterUpdate) {
              updated = afterUpdate;
              anyUpdate = true;
              if (isTerminal(afterUpdate.status, afterUpdate)) break;
            }
          }
          if (anyUpdate) checked++;

          // If terminal, archive and remove from open
          if (anyUpdate && isTerminal(updated.status, updated)) {
            const archiveRecord = buildArchiveRecord(updated);
            const yearMonth = new Date().toISOString().slice(0, 7);
            appendToArchive(yearMonth, archiveRecord);
            if (isLadderEligibleTF(sig.timeframe)) {
              try {
                recordLadderOutcome(sig.symbol, sig.grade, {
                  status: updated.status,
                  resolvedAt: archiveRecord.resolvedAt || updated.lastCheckedAt,
                  signalId: sig.id,
                });
              } catch (e) { console.log(`[Outcome] ladder.recordOutcome hatasi (${sig.id}): ${e.message}`); }
            } else {
              console.log(`[Outcome] ${sig.symbol} TF${sig.timeframe} ladder'a yazilmadi (1H league'dan haric)`);
            }
            removeOpenSignal(sig.id);
            resolved++;
            resolvedSignals.push(archiveRecord);
          }
        } catch (e) {
          console.log(`[Outcome] ${symbol} sinyal kontrol hatasi: ${e.message}`);
          errors++;
        }
      }
    } catch (e) {
      console.log(`[Outcome] ${symbol} sembol degistirme hatasi: ${e.message}`);
      errors += symbolSignals.length;
    }
  }

  return { checked, resolved, errors, resolvedSignals };
}
