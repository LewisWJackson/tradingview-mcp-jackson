/**
 * Alignment Filters — Entry / SL / TP seviyelerini SMC ve HTF Fibonacci
 * yapisiyla uyumlu hale getiren son katman filtreler.
 *
 * CLAUDE.md kurallari:
 *   - OB Catismasi: hesaplanan SL baska bir OB'nin icine/kenarina dusuyorsa
 *     GECERSIZ → OB disina tasi.
 *   - Genel SMC Hiza: Entry/SL/TP yapisal referansa oturtulur.
 *   - HTF Fib Celiski: TP, HTF fib direncinin (long) / desteginin (short)
 *     otesine tasiyorsa → TP fib onune cekilir. Entry HTF fib'in yanlis
 *     tarafindaysa → sinyal iptal.
 */

import { loadFibCache, checkFibCacheAge, recordStaleFibUsage } from './fib-engine.js';
import { buildBarriers, classifyEntryVsBarriers } from './barrier-detector.js';

/**
 * Aşama A — Bariyer cap reddetme kuralı (geçici köprü, Faz 4 unified-levels öncesi).
 *
 * HTF bariyeri TP'yi cap'liyorsa, cap edilen mesafe SL mesafesinin en az
 * `minDistRatio` katı olmalı. Aksi halde cap saçma kısa TP üretir
 * (R:R 1:2 minimum'u boğar) — bu durumda cap REDDEDILIR, orijinal TP'ler
 * korunur.
 *
 * @param {{entry:number, sl:number, capped:number, minDistRatio?:number}} opts
 * @returns {{refused:boolean, slDist:number, cappedDist:number, minTpDist:number}}
 */
export function shouldRefuseBarrierCap({ entry, sl, capped, minDistRatio = 1.3 }) {
  const slDist = Math.abs(entry - sl);
  const cappedDist = Math.abs(entry - capped);
  const minTpDist = slDist * minDistRatio;
  return { refused: cappedDist < minTpDist, slDist, cappedDist, minTpDist };
}

/**
 * SL bir OB'nin icinde mi (entry OB haric)?
 * obLow/obHigh aralığı ve karar mantigi: SL o OB'den tepki aliyorsa erken
 * tetiklenir; disina tasinmali.
 *
 * @param {object} opts
 * @param {number} opts.sl — hesaplanan SL fiyati
 * @param {'long'|'short'} opts.direction
 * @param {number} opts.atr — SL'yi tasirken kullanilacak tampon (ATR*0.3)
 * @param {Array<{high,low,type?}>} opts.orderBlocks — SMC OB listesi
 * @param {object|null} opts.entryOBZone — entry'nin oturtuldugu OB (varsa)
 * @returns {{sl:number, moved:boolean, reason?:string, conflictOB?:object}}
 */
export function resolveSLOBConflict({ sl, direction, atr, orderBlocks, entryOBZone }) {
  if (!Array.isArray(orderBlocks) || orderBlocks.length === 0 || !atr || atr <= 0) {
    return { sl, moved: false };
  }

  // Entry OB'yi skip icin basit imza (low+high eslesmesi)
  const sameAsEntry = (ob) => {
    if (!entryOBZone) return false;
    const eps = Math.max(Math.abs(ob.high - ob.low), 1e-6) * 0.01;
    return Math.abs(ob.low - entryOBZone.low) < eps
        && Math.abs(ob.high - entryOBZone.high) < eps;
  };

  // SL bu OB'nin icinde veya kenarinda mi?
  const overlaps = (ob, price) => price >= ob.low && price <= ob.high;
  const nearEdge = (ob, price) => {
    const pad = atr * 0.15;
    return price >= (ob.low - pad) && price <= (ob.high + pad);
  };

  for (const ob of orderBlocks) {
    if (sameAsEntry(ob)) continue;
    if (overlaps(ob, sl) || nearEdge(ob, sl)) {
      // SL bu OB'ye yakin — tepki riskine karsi disina tasi
      const buffer = atr * 0.3;
      const newSL = direction === 'long'
        ? Math.min(sl, ob.low - buffer)  // long icin daha asagi
        : Math.max(sl, ob.high + buffer); // short icin daha yukari
      return {
        sl: newSL,
        moved: true,
        reason: `SL ${sl.toFixed(4)} OB [${ob.low.toFixed(4)}-${ob.high.toFixed(4)}] icinde/kenarinda — ${direction === 'long' ? 'altina' : 'ustune'} tasindi: ${newSL.toFixed(4)}`,
        conflictOB: ob,
      };
    }
  }
  return { sl, moved: false };
}

/**
 * SMC indikatorunun cizdigi yatay destek/direnc cizgilerine gore SL ve TP hizalamasi.
 *   - Long: SL altindaki en yakin S/R cizgisinin ALTINA itilir (0.2×ATR buffer),
 *           TP ustundeki en yakin S/R cizgisinin ALTINA capped (0.1%).
 *   - Short: SL ustundeki en yakin S/R cizgisinin USTUNE itilir, TP altindaki
 *            en yakin S/R cizgisinin USTUNE capped.
 * Bu, OB'den farkli olarak cift-taraflı (lines kurumsal swing pivotlarını isaretler;
 * SL onun icine koyulursa stop-av riski yuksektir).
 *
 * @param {object} opts
 * @param {'long'|'short'} opts.direction
 * @param {number} opts.entry
 * @param {number} opts.sl
 * @param {number|null} opts.tp1
 * @param {number|null} opts.tp2
 * @param {number|null} opts.tp3
 * @param {number} opts.atr
 * @param {Array<number>} opts.srLines — SMC yatay seviyeler (sirali onemsiz)
 * @returns {{
 *   sl:number, slMoved:boolean, slReason?:string,
 *   tp1:number|null, tp2:number|null, tp3:number|null,
 *   warnings:string[]
 * }}
 */
export function applySMCLinesGuards({ direction, entry, sl, tp1, tp2, tp3, atr, srLines }) {
  const warnings = [];
  if (!Array.isArray(srLines) || srLines.length === 0 || !atr || atr <= 0 || !entry || entry <= 0) {
    return { sl, slMoved: false, tp1, tp2, tp3, warnings };
  }

  // Entry yakinindaki line'lari filtrele — %10'dan uzaklari yoksay (noise).
  // Ayrica entry'ye COK yakin (kucuk swing/BOS/CHoCH yapi cizgileri) de noise:
  // min mesafe = max(1×ATR, %1.5×entry). Bu esik altindaki cizgiler gercek
  // direnc/destek degil, intrabar yapi isaretleri — TP/SL'ye etki etmemeli.
  const minDist = Math.max(atr * 1.0, entry * 0.015);
  const relevant = srLines.filter(p =>
    Math.abs(p - entry) / entry < 0.10
    && Math.abs(p - entry) >= minDist
  );
  if (relevant.length === 0) return { sl, slMoved: false, tp1, tp2, tp3, warnings };

  const below = relevant.filter(p => p < entry).sort((a, b) => b - a); // en yakin ilk
  const above = relevant.filter(p => p > entry).sort((a, b) => a - b);
  const buffer = atr * 0.2;

  let outSL = sl;
  let slMoved = false;
  let slReason = null;

  if (direction === 'long') {
    // SL entry altinda olmali; bir S/R cizgisi SL ile entry arasinda ise
    // veya SL cizgiye cok yakinsa, cizginin altina it.
    for (const p of below) {
      if (p > outSL - 1e-9 && p < entry) {
        const moved = p - buffer;
        if (moved < outSL) {
          outSL = moved;
          slMoved = true;
          slReason = `SL SMC S/R cizgisi @ ${p.toFixed(4)} icinde — altina itildi: ${outSL.toFixed(4)}`;
          break;
        }
      }
    }
  } else {
    for (const p of above) {
      if (p < outSL + 1e-9 && p > entry) {
        const moved = p + buffer;
        if (moved > outSL) {
          outSL = moved;
          slMoved = true;
          slReason = `SL SMC S/R cizgisi @ ${p.toFixed(4)} icinde — ustune itildi: ${outSL.toFixed(4)}`;
          break;
        }
      }
    }
  }

  // TP capping: TP bir cizgiyi gecmesin (cizginin ONUNDEN al).
  const capTP = (tp) => {
    if (tp == null) return tp;
    if (direction === 'long') {
      const nearest = above[0];
      if (nearest && tp >= nearest) {
        const capped = nearest * 0.999;
        warnings.push(`TP ${tp.toFixed(4)} SMC direncini (@${nearest.toFixed(4)}) astigi icin capped → ${capped.toFixed(4)}`);
        return capped;
      }
    } else {
      const nearest = below[0];
      if (nearest && tp <= nearest) {
        const capped = nearest * 1.001;
        warnings.push(`TP ${tp.toFixed(4)} SMC destegini (@${nearest.toFixed(4)}) astigi icin capped → ${capped.toFixed(4)}`);
        return capped;
      }
    }
    return tp;
  };

  return {
    sl: outSL,
    slMoved,
    slReason,
    tp1: capTP(tp1),
    tp2: capTP(tp2),
    tp3: capTP(tp3),
    warnings,
  };
}

/**
 * HTF fib seviyeleri SL icin de bir duvar olsun: SL entry'nin yanlis tarafinda
 * bir HTF fib yapisi tarafindan delinmeden yerlesmeli. Ornegin:
 *   - Long: SL entry altinda olmali; entry ile SL arasinda bir HTF fib destegi
 *     (retracement level) varsa, SL o destegin ALTINA itilir — destege degmeden
 *     stop yemek, yapisal olarak erken cikis demek.
 *   - Short: SL ustunde bir HTF fib direnci varsa, SL o direncin USTUNE itilir.
 *
 * Sadece entry'ye %5'ten yakin seviyeleri dikkate alir (makro guruldu onlenir).
 * Buffer: 0.15×ATR (cizgi iyi tanimlidir, fazla gevsetmeye gerek yok).
 */
export function enforceHTFFibSLGuard({ direction, entry, sl, atr, htfLevels }) {
  if (!Array.isArray(htfLevels) || htfLevels.length === 0 || !atr || atr <= 0) {
    return { sl, moved: false };
  }
  const maxDist = entry * 0.05;
  const buffer = atr * 0.15;

  if (direction === 'long') {
    // SL ile entry arasina duşen en asagi HTF fib seviyesi
    const inside = htfLevels
      .filter(l => l.price > sl && l.price < entry && (entry - l.price) <= maxDist)
      .sort((a, b) => a.price - b.price)[0];
    if (inside) {
      const moved = inside.price - buffer;
      if (moved < sl) {
        return {
          sl: moved,
          moved: true,
          reason: `SL, HTF fib destegi ${inside.tf} ${inside.level} @ ${inside.price.toFixed(4)} icine dusmus — altina itildi: ${moved.toFixed(4)}`,
        };
      }
    }
  } else {
    const inside = htfLevels
      .filter(l => l.price < sl && l.price > entry && (l.price - entry) <= maxDist)
      .sort((a, b) => b.price - a.price)[0];
    if (inside) {
      const moved = inside.price + buffer;
      if (moved > sl) {
        return {
          sl: moved,
          moved: true,
          reason: `SL, HTF fib direnci ${inside.tf} ${inside.level} @ ${inside.price.toFixed(4)} icine dusmus — ustune itildi: ${moved.toFixed(4)}`,
        };
      }
    }
  }
  return { sl, moved: false };
}

/**
 * HTF fib cache'inden entry/TP celiski kontrolu + TP capping.
 * Mantik:
 *   - Long TP'leri fiyat ustundeki en yakin HTF fib direncinin otesine gecmesin
 *   - Short TP'leri fiyat altindaki en yakin HTF fib desteginin otesine gecmesin
 *   - Entry HTF trend'in net yanlis tarafindaysa (long ama 4H/1D trend_down
 *     ve entry HTF desteginin cok altinda) → sinyal iptal onerilir.
 *
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {'long'|'short'} opts.direction
 * @param {number} opts.entry
 * @param {number} opts.sl
 * @param {number|null} opts.tp1
 * @param {number|null} opts.tp2
 * @param {number|null} opts.tp3
 * @returns {{
 *   rejected:boolean, reasons:string[], warnings:string[],
 *   adjusted:{entry:number,sl:number,tp1:number|null,tp2:number|null,tp3:number|null},
 *   htfSummary:object|null
 * }}
 */
export function enforceHTFFibAlignment({ symbol, direction, entry, sl, tp1, tp2, tp3 }) {
  const reasons = [];
  const warnings = [];
  const adjusted = { entry, sl, tp1, tp2, tp3 };

  const cache = loadFibCache(symbol);
  if (!cache || !cache.timeframes) {
    return { rejected: false, reasons, warnings, adjusted, htfSummary: null };
  }

  // Tum HTF fib levellarini flatten et (retracement + extension, tum TF'ler)
  const allLevels = [];
  const htfTrends = {};
  for (const [tf, data] of Object.entries(cache.timeframes)) {
    if (data?.trend) htfTrends[tf] = data.trend;
    if (data?.fib) {
      for (const r of (data.fib.retracement || [])) allLevels.push({ ...r, tf, kind: 'retracement' });
      for (const e of (data.fib.extensions || []))  allLevels.push({ ...e, tf, kind: 'extension' });
    }
  }

  // 1) Entry HTF trend celiskisi
  //    Long ama iki+ HTF'de trend_down, veya short ama iki+ HTF'de trend_up → iptal
  const trendVals = Object.values(htfTrends).map(t => t.regime);
  const downCount = trendVals.filter(v => v === 'trend_down').length;
  const upCount = trendVals.filter(v => v === 'trend_up').length;
  if (direction === 'long' && downCount >= 2) {
    reasons.push(`HTF trend celiski: ${downCount} HTF'de trend_down — long sinyal iptal`);
    return { rejected: true, reasons, warnings, adjusted, htfSummary: { trendVals, htfTrends } };
  }
  if (direction === 'short' && upCount >= 2) {
    reasons.push(`HTF trend celiski: ${upCount} HTF'de trend_up — short sinyal iptal`);
    return { rejected: true, reasons, warnings, adjusted, htfSummary: { trendVals, htfTrends } };
  }

  // 2) TP capping: long icin entry'nin USTUNDEKI en yakin fib seviyesinin OTESINE
  //    TP gidiyorsa → TP'yi fib'in hemen altina cek (buffer kucuk).
  //    Short icin aynisi ters yonde.
  const above = allLevels.filter(l => l.price > entry).sort((a, b) => a.price - b.price);
  const below = allLevels.filter(l => l.price < entry).sort((a, b) => b.price - a.price);

  const capTP = (tp) => {
    if (tp == null) return tp;
    if (direction === 'long') {
      // En yakin fib direnci: entry'nin hemen ustu
      const nearest = above[0];
      if (!nearest) return tp;
      if (tp >= nearest.price) {
        // fib'in %0.1 altina cek (absolute min tick)
        const capped = nearest.price * 0.999;
        warnings.push(`TP ${tp.toFixed(4)} HTF fib direncini (${nearest.tf} ${nearest.level} @ ${nearest.price.toFixed(4)}) astigi icin capped → ${capped.toFixed(4)}`);
        return capped;
      }
      return tp;
    } else {
      const nearest = below[0];
      if (!nearest) return tp;
      if (tp <= nearest.price) {
        const capped = nearest.price * 1.001;
        warnings.push(`TP ${tp.toFixed(4)} HTF fib destegini (${nearest.tf} ${nearest.level} @ ${nearest.price.toFixed(4)}) astigi icin capped → ${capped.toFixed(4)}`);
        return capped;
      }
      return tp;
    }
  };

  adjusted.tp1 = capTP(tp1);
  adjusted.tp2 = capTP(tp2);
  adjusted.tp3 = capTP(tp3);

  // 3) Entry HTF fib'in yanlis tarafindaysa (guclu sinyal): sadece uyari.
  //    Ornek: long ama entry HTF golden zone'un cok altinda — tepki yerine
  //    dip av riski. Burada reject etmiyoruz, downstream grader kaliteyi dusurebilir.
  if (direction === 'long' && above[0] && (above[0].price - entry) / Math.max(entry, 1e-9) < 0.002) {
    warnings.push(`Entry (${entry.toFixed(4)}) HTF fib direncinin (${above[0].tf} ${above[0].level}) cok yakininda — long risk yuksek`);
  }
  if (direction === 'short' && below[0] && (entry - below[0].price) / Math.max(entry, 1e-9) < 0.002) {
    warnings.push(`Entry (${entry.toFixed(4)}) HTF fib desteginin (${below[0].tf} ${below[0].level}) cok yakininda — short risk yuksek`);
  }

  return {
    rejected: false,
    reasons,
    warnings,
    adjusted,
    htfSummary: {
      trendVals,
      htfTrends,
      nearestAbove: above[0] || null,
      nearestBelow: below[0] || null,
      _allLevels: allLevels,
    },
  };
}

/**
 * Uc filtrenin birlesik uygulamasi. signal-grader'dan tek cagri ile kullanilir.
 * Sonuc: {rejected, reasons, warnings, adjusted:{sl,tp1,tp2,tp3}, htfSummary}
 * Not: entry degisimi burada yapmaz (grader'da zaten entry fallback var).
 */
export function applyAlignmentFilters({
  symbol, direction, entry, sl, tp1, tp2, tp3,
  atr, smc, srLines, entryOBZone, currentTF,
}) {
  const warnings = [];
  const reasons = [];
  let adjustedSL = sl;
  let adjTP1 = tp1, adjTP2 = tp2, adjTP3 = tp3;
  let slMoved = false;

  // 1) SL ↔ OB catismasi
  if (smc?.orderBlocks) {
    const slRes = resolveSLOBConflict({
      sl: adjustedSL,
      direction,
      atr,
      orderBlocks: smc.orderBlocks,
      entryOBZone,
    });
    adjustedSL = slRes.sl;
    if (slRes.moved) { slMoved = true; warnings.push(`[SL-OB] ${slRes.reason}`); }
  }

  // 2) Cache + HTF trend reject (erken cikis)
  const cache = loadFibCache(symbol);

  // Faz 0 patch (f) — Risk #6: HTF fib cache yas kontrolu.
  // Cache null veya > 24h → warn log + sayaç artir + warning ekle.
  // Cache null GECIRILMEZ; buildBarriers zaten null'a tolerant (bos sonuc doner).
  // Canlida `stale_used_24h` metrigi `data/fib/_stale-counter.json` uzerinden izlenir.
  let fibStaleInfo = null;
  try {
    const age = checkFibCacheAge(cache);
    if (age.missing || age.stale) {
      fibStaleInfo = age;
      recordStaleFibUsage(symbol, { missing: age.missing });
      const ageLabel = age.missing ? 'YOK' : `${age.ageHours}h`;
      console.warn(`[HTF-Fib][STALE] ${symbol}: cache ${ageLabel} (refreshed_at=${age.refreshedAt || 'null'}) — sayac +1`);
      warnings.push(`HTF fib cache stale/eksik: ${ageLabel} — fib refresh gerekli`);
    }
  } catch (e) {
    console.warn(`[HTF-Fib] yas kontrolu hatasi (${symbol}): ${e.message}`);
  }

  const htfTrends = {};
  if (cache?.timeframes) {
    for (const [tf, data] of Object.entries(cache.timeframes)) {
      if (data?.trend) htfTrends[tf] = data.trend;
    }
  }
  const trendVals = Object.values(htfTrends).map(t => t.regime);
  const downCount = trendVals.filter(v => v === 'trend_down').length;
  const upCount = trendVals.filter(v => v === 'trend_up').length;
  if (direction === 'long' && downCount >= 2) {
    reasons.push(`[HTF-Fib] HTF trend celiski: ${downCount} HTF'de trend_down — long sinyal iptal`);
    return {
      rejected: true, reasons, warnings,
      adjusted: { sl: adjustedSL, tp1: adjTP1, tp2: adjTP2, tp3: adjTP3 },
      slMoved, htfSummary: { trendVals, htfTrends }, barrierSummary: null, entryZoneClass: null,
    };
  }
  if (direction === 'short' && upCount >= 2) {
    reasons.push(`[HTF-Fib] HTF trend celiski: ${upCount} HTF'de trend_up — short sinyal iptal`);
    return {
      rejected: true, reasons, warnings,
      adjusted: { sl: adjustedSL, tp1: adjTP1, tp2: adjTP2, tp3: adjTP3 },
      slMoved, htfSummary: { trendVals, htfTrends }, barrierSummary: null, entryZoneClass: null,
    };
  }

  // 3) HTF Barrier — sadece 1D/1W seviyeleri, sadece "onemli" zone'larda TP cap.
  //    Sinyal TF'nin kendi SMC/fib'i primary (TP olusturucu zaten dogru).
  //    HTF sadece revision: TP majeur HTF direnc/desteginin otesine gecerse
  //    onune cekilir — tek seferlik, progressive-zone yok.
  const barriers = buildBarriers({
    entry, atr,
    currentTF: currentTF || '60',
    currentTFSmcLines: Array.isArray(srLines) ? srLines : [],
    fibCache: cache || null,
  });

  const targetZones = direction === 'long' ? barriers.aboveBarriers : barriers.belowBarriers;
  // Sadece "onemli" zone'lar (strength >= 3.0) cap yapar — 1D alone, 1W, veya
  // 1D+1W multi-source. Orta TF gurultulerle TP kesilmez.
  const majorZone = targetZones.find(z => (z.strength || 0) >= 3.0) || null;

  if (majorZone) {
    const buffer = Math.max(atr * 0.15, majorZone.price * 0.0015);
    const capped = direction === 'long' ? majorZone.price - buffer : majorZone.price + buffer;

    // Aşama A — bariyer min-distance kuralı (geçici köprü, Faz 4'te
    // unified-levels.js ile yerini alacak).
    const refuseCheck = shouldRefuseBarrierCap({ entry, sl: adjustedSL, capped });

    if (refuseCheck.refused) {
      warnings.push(`[HTF-Barrier] Cap REDDEDILDI — bariyer (${majorZone.tf} @ ${majorZone.price.toFixed(4)}) çok yakın: cap mesafesi ${refuseCheck.cappedDist.toFixed(4)} < min ${refuseCheck.minTpDist.toFixed(4)} (1.3×SL). Orijinal TP'ler korundu (Aşama A geçici kural, Faz 4 unified-levels öncesi).`);
    } else {
      const cap = (tp) => {
        if (tp == null) return tp;
        const crossed = direction === 'long' ? tp >= majorZone.price : tp <= majorZone.price;
        return crossed ? capped : tp;
      };
      const tp1New = cap(adjTP1), tp2New = cap(adjTP2), tp3New = cap(adjTP3);
      const anyChanged = tp1New !== adjTP1 || tp2New !== adjTP2 || tp3New !== adjTP3;
      if (anyChanged) {
        warnings.push(`[HTF-Barrier] TP'ler onemli HTF ${majorZone.sources.join('+')} seviyesinin (${majorZone.tf} @ ${majorZone.price.toFixed(4)}, strength=${majorZone.strength}) onune cekildi → ${capped.toFixed(4)}`);
      }
      adjTP1 = tp1New; adjTP2 = tp2New; adjTP3 = tp3New;
    }
  }

  // 4) Entry-in-zone — sadece bilgilendirme, grade'i etkilemez.
  const entryZoneClass = classifyEntryVsBarriers({
    entry, atr, direction,
    aboveBarriers: barriers.aboveBarriers,
    belowBarriers: barriers.belowBarriers,
  });
  if (entryZoneClass.inZone) {
    const z = entryZoneClass.zone;
    const msg = `[HTF-Zone] Entry ${entryZoneClass.zoneType} zone icinde (${z.tf} @ ${z.price.toFixed(4)}) — ${direction.toUpperCase()} icin ${entryZoneClass.alignment === 'confirm' ? 'uyumlu' : 'dikkat'}`;
    if (entryZoneClass.alignment === 'confirm') reasons.push(msg);
    else warnings.push(msg);
  }

  return {
    rejected: false,
    reasons,
    warnings,
    adjusted: {
      sl: adjustedSL,
      tp1: adjTP1,
      tp2: adjTP2,
      tp3: adjTP3,
    },
    slMoved,
    htfSummary: {
      trendVals, htfTrends,
      nearestAbove: barriers.aboveBarriers[0] || null,
      nearestBelow: barriers.belowBarriers[0] || null,
      _allLevels: [], // legacy — barrier model'i kullaniliyor artik
      fibStale: fibStaleInfo, // Faz 0 patch (f): null ya da {stale, missing, ageHours, refreshedAt}
    },
    barrierSummary: {
      above: barriers.aboveBarriers,
      below: barriers.belowBarriers,
      noiseThreshold: barriers.debug.noiseThreshold,
      totalZones: barriers.totalZones,
    },
    entryZoneClass,
  };
}
