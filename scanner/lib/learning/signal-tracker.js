/**
 * Signal Tracker — records scanner signals with full indicator snapshots
 * for later outcome tracking and learning.
 */

import { readJSON, writeJSON, dataPath, readAllArchives } from './persistence.js';
import { inferCategory as resolveInferCategory, extractBaseAsset, getResolvedExchangeRank } from '../symbol-resolver.js';
import { dispatchToOkxExecutor as dispatchToOkxExecutorShared } from '../okx-dispatcher.js';

/**
 * Dedup grup anahtari uretir.
 * Crypto'da MONUSD ve MONUSDC ayni base asset'e sahip oldugundan ayni gruba dusmeli —
 * boylece ayni coin'in farkli stable pair'leri icin mukerrer pozisyon acilmaz.
 * Diger kategorilerde (hisse, forex, emtia) cross-pair kavrami olmadigindan
 * sembol+kategori birlesimi kullanilir.
 */
function dedupGroupKey(symbolOrSig, categoryArg) {
  let symbol, category;
  if (typeof symbolOrSig === 'string') {
    symbol = symbolOrSig;
    category = categoryArg || resolveInferCategory(symbol) || 'unknown';
  } else if (symbolOrSig && typeof symbolOrSig === 'object') {
    symbol = symbolOrSig.symbol;
    category = symbolOrSig.category || resolveInferCategory(symbol) || 'unknown';
  } else {
    return 'unknown:unknown';
  }
  if (category === 'kripto' || category === 'crypto') {
    const base = extractBaseAsset(symbol);
    if (base) return `crypto:${base}`;
  }
  return `${category}:${String(symbol || '').toUpperCase()}`;
}

const OPEN_PATH = dataPath('signals', 'open.json');

// Max open BEKLE (virtual) signals per symbol. Eskiyi otomatik superseded_by_cap yap.
const BEKLE_CAP_PER_SYMBOL = 5;

/**
 * OKX Executor'a sinyal POST et. Yalnizca kripto + A/B/C kaliteli.
 * Idempotent: executor ayni `reason.id` icin duplicate donar.
 * Executor erisilemez ise sinyal kalici kuyruga (data/okx-queue.json) yazilir
 * ve executor geri geldiginde otomatik drain edilir.
 */
function dispatchToOkxExecutor(signal) {
  const cat = signal.category || resolveInferCategory(signal.symbol);
  if (cat !== 'kripto' && cat !== 'crypto') return;
  if (!['A', 'B', 'C'].includes(signal.grade)) return;
  // Ladder filtresi: yalnizca league='real' sinyaller executor'a gider.
  // A/B daima 'real'; C ve BEKLE sembol+grade bazli tier'a tabidir.
  if (signal.league && signal.league !== 'real') return;
  // Pump-top guard: pendingPullback olan sinyalde entry zaten pullback hedefi
  // (gövde ortası); executor bunu limit emir olarak gönderiyor. Dispatch'i
  // engellemiyoruz — sadece logla.
  if (signal.pendingPullback) {
    console.log(`[Signal] ${signal.symbol}: pump-pullback limit dispatch (target ${signal.pendingPullback.target}, severity ${signal.pendingPullback.severity})`);
  }

  const payload = {
    symbol_tv: signal.symbol,
    tf: String(signal.timeframe ?? ''),
    side: signal.direction === 'short' ? 'short' : 'long',
    quality: signal.grade,
    entry: Number(signal.entry),
    sl: Number(signal.sl),
    tp1: signal.tp1 != null ? Number(signal.tp1) : undefined,
    tp2: signal.tp2 != null ? Number(signal.tp2) : undefined,
    tp3: signal.tp3 != null ? Number(signal.tp3) : undefined,
    reason: {
      id: signal.id,
      rr: signal.rr,
      indicators: signal.indicators,
      reasoning: signal.reasoning,
      warnings: signal.warnings,
    },
  };
  dispatchToOkxExecutorShared(payload);
}

function generateId(symbol, tf) {
  const ts = Math.floor(Date.now() / 1000);
  const cleanSym = (symbol || 'UNKNOWN').replace(/[^a-zA-Z0-9]/g, '');
  return `sig_${cleanSym}_${tf}_${ts}`;
}

/**
 * Get the most recent open signal for a given symbol (any timeframe).
 * Used to generate transition directives (e.g., "close short, go long").
 */
export function getLastSignalForSymbol(symbol) {
  const data = readJSON(OPEN_PATH, { signals: [] });
  const symbolSignals = data.signals
    .filter(s => s.symbol === symbol && s.status === 'open')
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return symbolSignals[0] || null;
}

/**
 * Get all signals for a symbol within a time range.
 */
export function getSignalHistory(symbol, daysBack = 3) {
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  // Check open signals
  const openData = readJSON(OPEN_PATH, { signals: [] });
  const openMatches = openData.signals.filter(s => s.symbol === symbol && s.createdAt >= cutoff);

  // Check archived signals
  let archivedMatches = [];
  try {
    const allArchived = readAllArchives();
    archivedMatches = allArchived.filter(s => s.symbol === symbol && s.createdAt >= cutoff);
  } catch {}

  return [...openMatches, ...archivedMatches].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * Generate transition directive when a new signal conflicts with an existing open signal.
 * Returns directive object or null if no conflict.
 *
 * NOTE: REVERSE ve CLOSE_AND_WAIT tipleri kaldirildi. Zit yon sinyali geldiginde
 * pozisyona dokunulmaz — acik pozisyon SL/TP/elle ile kapanir. Ters yon sinyalleri
 * sadece `reverseAttempts` arrayinde loglanir (recordSignal icinde).
 * Bu fonksiyon sadece AYNI YONDE sinyal icin directive uretir.
 */
export function generateTransitionDirective(newSignal, existingSignal) {
  if (!existingSignal || !newSignal) return null;

  const sameDirection = existingSignal.direction === newSignal.direction;
  if (!sameDirection) return null; // Zit yon artik directive uretmiyor

  const newGrade = newSignal.grade;
  const existingGrade = existingSignal.grade;
  const gradeOrder = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4 };

  const directive = {
    type: null,
    message: '',
    previousSignal: {
      id: existingSignal.id,
      direction: existingSignal.direction,
      grade: existingSignal.grade,
      entry: existingSignal.entry,
      sl: existingSignal.sl,
      tp1: existingSignal.tp1,
      createdAt: existingSignal.createdAt,
    },
    newSignal: {
      direction: newSignal.direction,
      grade: newGrade,
      entry: newSignal.entry,
      sl: newSignal.sl,
    },
  };

  // Same direction — update or reinforce
  if ((gradeOrder[newGrade] || 9) < (gradeOrder[existingGrade] || 9)) {
    // New signal is stronger grade
    directive.type = 'REINFORCE';
    directive.message = `${(existingSignal.direction || '').toUpperCase()} GUCLENDI: ${existingGrade} → ${newGrade} yukseltildi. Pozisyon devam, SL/TP guncelle.`;
  } else {
    // Same or weaker grade — update SL/TP if changed
    const slChanged = existingSignal.sl && newSignal.sl && Math.abs(existingSignal.sl - newSignal.sl) / existingSignal.sl > 0.005;
    if (slChanged) {
      directive.type = 'UPDATE_LEVELS';
      directive.message = `${(existingSignal.direction || '').toUpperCase()} DEVAM: SL guncelle (${existingSignal.sl?.toFixed(2)} → ${newSignal.sl?.toFixed(2)}). Pozisyon ayni yonde.`;
    } else {
      directive.type = 'HOLD';
      directive.message = `${(existingSignal.direction || '').toUpperCase()} DEVAM: Ayni yonde sinyal tekrarlandi (${newGrade}). Pozisyon tut.`;
    }
  }

  return directive;
}

/**
 * Record a new signal from the scanner output.
 * Extracts the full indicator snapshot for later analysis.
 * Also checks for existing signals on the same symbol and generates transition directives.
 */
export function recordSignal(scanResult) {
  if (!scanResult || scanResult.grade === 'IPTAL' || scanResult.grade === 'HATA') return null;

  // Validate critical price levels — reject signals with missing/invalid SL/TP
  const _entry = parseFloat(scanResult.entry);
  const _sl = parseFloat(scanResult.sl);
  const _tp1 = parseFloat(scanResult.tp1);
  if (!Number.isFinite(_entry) || _entry <= 0 ||
      !Number.isFinite(_sl) || _sl <= 0 ||
      !Number.isFinite(_tp1) || _tp1 <= 0) {
    console.log(`[Signal] REDDEDILDI: ${scanResult.symbol} — gecersiz fiyat (entry: ${scanResult.entry}, sl: ${scanResult.sl}, tp1: ${scanResult.tp1})`);
    return null;
  }
  // Validate SL is on correct side of entry
  if (scanResult.direction === 'long' && _sl >= _entry) {
    console.log(`[Signal] REDDEDILDI: ${scanResult.symbol} — long ama SL (${_sl}) >= entry (${_entry})`);
    return null;
  }
  if (scanResult.direction === 'short' && _sl <= _entry) {
    console.log(`[Signal] REDDEDILDI: ${scanResult.symbol} — short ama SL (${_sl}) <= entry (${_entry})`);
    return null;
  }

  const now = new Date();
  const tf = scanResult.timeframe || scanResult.tf || '60';

  // Tek-pozisyon + reverse-yok politikasi:
  // - Ayni sembolde zit yon acik sinyal varsa → yeni sinyali `reverseAttempts`
  //   dizisine ekle, acik pozisyona DOKUNMA, yeni kayit acma.
  // - Ayni yonde acik sinyal varsa → UPSERT (TF/grade degisebilir), tracking
  //   state (entryHit, tp1Hit, reverseAttempts) korunur.
  const data = readJSON(OPEN_PATH, { signals: [] });
  // Dashboard'da "canli takipte" sayilan tum statuler dedup'a dahil.
  // tp1_hit / tp2_hit trailing SL ile yasamaya devam ediyor; bunlari gormezden
  // gelirsek ayni sembol+yon icin mukerrer kayit aciliyor (bkz. /api/signals/open-dashboard).
  const ACTIVE_STATUSES = new Set(['open', 'tp1_hit', 'tp2_hit']);
  // Cross-pair dedup: MONUSD ve MONUSDC ayni base coin (MON) — ayni gruba dusmeli.
  // Crypto disinda sembol+kategori grup anahtari (eski davranisla ayni).
  const newKey = dedupGroupKey(scanResult);
  const allForGroup = data.signals.filter(s =>
    ACTIVE_STATUSES.has(s.status) && dedupGroupKey(s) === newKey
  );
  const opposite = allForGroup.find(s => s.direction !== scanResult.direction);
  const sameDir = allForGroup.find(s => s.direction === scanResult.direction);

  // --- 1C: Zit yon sinyali ---
  // Opposite kayit sadece A/B/C ise "gercek" pozisyon sayilir ve reverseAttempt
  // olarak loglanir. BEKLE/IPTAL virtual sinyaller gercek pozisyon degil —
  // yeni A/B/C sinyalleri bloklamamali ve executor dispatch'ini engellememeli.
  // Bu durumda virtual opposite kayit `superseded_by_reverse` ile kapatilir ve
  // yeni sinyal normal akisa dusup executor'a dispatch edilir.
  if (opposite) {
    const oppositeIsReal = ['A', 'B', 'C'].includes(opposite.grade);
    const newIsReal = ['A', 'B', 'C'].includes(scanResult.grade);

    if (!oppositeIsReal && newIsReal) {
      // Virtual BEKLE opposite, gelen gercek A/B/C tarafindan supersede edilir.
      opposite.status = 'superseded_by_reverse';
      opposite.supersededAt = now.toISOString();
      opposite.supersededBy = `${tf}_${scanResult.grade}_${scanResult.direction}`;
      writeJSON(OPEN_PATH, data);
      console.log(`[Signal] ${scanResult.symbol}: virtual opposite (BEKLE ${opposite.direction}) gercek ${scanResult.grade}-${scanResult.direction} tarafindan supersede edildi`);
      // opposite artik aktif degil — yeni kayit akisina dus (sameDir kontrolu
      // allForGroup cache uzerinden yapildi; opposite kapatildigi icin tekrar
      // active listesi tarayip fresh path'e gitmek guvenli).
      // Bu dallanmada sameDir zaten opposite'den bagimsiz bulunmustu; asagi dus.
    } else {
      if (!Array.isArray(opposite.reverseAttempts)) opposite.reverseAttempts = [];
      opposite.reverseAttempts.push({
        at: now.toISOString(),
        direction: scanResult.direction,
        grade: scanResult.grade,
        timeframe: tf,
        entry: scanResult.entry || null,
        sl: scanResult.sl || null,
        tp1: scanResult.tp1 || null,
        reasoning: Array.isArray(scanResult.reasoning) ? scanResult.reasoning.slice(0, 5) : [],
        indicatorSnapshot: extractIndicatorSnapshot(scanResult),
      });
      if (!Array.isArray(opposite.warnings)) opposite.warnings = [];
      opposite.warnings.push(
        `REVERSE SINYAL: ${tf} TF ${scanResult.grade}-${(scanResult.direction || '').toUpperCase()} @ ${now.toISOString().slice(11, 16)}`
      );
      writeJSON(OPEN_PATH, data);
      console.log(`[Signal] ${scanResult.symbol}: zit yon sinyal ${scanResult.grade}-${scanResult.direction} loglandi — pozisyon dokunulmadi (reverseAttempts: ${opposite.reverseAttempts.length})`);

      // Gercek A/B/C reverse sinyal ise executor'in reverseClose mekanizmasina
      // dispatch et — tracker'in return null'u executor akisini blokluyor;
      // duplicate id idempotent, guvenli.
      if (oppositeIsReal && newIsReal) {
        dispatchToOkxExecutor({
          ...scanResult,
          id: scanResult.id || generateId(scanResult.symbol, tf),
        });
      }
      return null;
    }
  }

  // --- 1B: Ayni yonde mevcut sinyal varsa UPSERT ---
  if (sameDir) {
    const gradeOrder = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4 };
    const tfRank = { '1': 1, '3': 2, '5': 3, '15': 4, '30': 5, '45': 6, '60': 7, '120': 8, '240': 9, '1D': 10, '3D': 11, '1W': 12, '1M': 13 };
    const newGradeRank = gradeOrder[scanResult.grade] ?? 9;
    const existGradeRank = gradeOrder[sameDir.grade] ?? 9;
    const newTFRank = tfRank[tf] ?? 0;
    const existTFRank = tfRank[sameDir.timeframe] ?? 0;
    const betterGrade = newGradeRank < existGradeRank;
    const sameGradeHigherTF = newGradeRank === existGradeRank && newTFRank > existTFRank;
    // TP1/TP2 vurmus sinyalde fiyat seviyeleri (entry/SL/TP) donmus olmali —
    // aksi halde tp1Hit:true + yeni tp1 degeri tutarsiz kayit olusturur.
    const levelsFrozen = sameDir.status === 'tp1_hit' || sameDir.status === 'tp2_hit';
    const shouldUpgradeLevels = (betterGrade || sameGradeHigherTF) && !levelsFrozen;

    // Ayni sembol icin ayni yonde BASKA TF'de acik sinyal var mi? (tek pozisyon kurali)
    const otherSameDirs = allForGroup.filter(s =>
      s.direction === scanResult.direction &&
      s.id !== sameDir.id
    );
    for (const other of otherSameDirs) {
      other.status = 'superseded_by_tf';
      other.supersededAt = now.toISOString();
      other.supersededBy = `${tf}_${scanResult.grade}`;
    }

    // Upsert: her tarama indicator snapshot'ini ve warnings'i guncel tut.
    // Fiyat seviyeleri ve TF sadece "daha iyi" sinyallerde guncellenir —
    // boylece yanlislikla downgrade ile daha kotu SL/entry'ye gecis olmaz.
    sameDir.lastRefreshedAt = now.toISOString();
    sameDir.refreshCount = (sameDir.refreshCount || 0) + 1;
    sameDir.indicators = extractIndicatorSnapshot(scanResult);
    sameDir.reasoning = scanResult.reasoning || sameDir.reasoning;
    sameDir.warnings = [
      ...(scanResult.warnings || []),
      ...(sameDir.warnings || []).filter(w => typeof w === 'string' && w.startsWith('REVERSE SINYAL:')),
    ];
    sameDir.transitionDirective = generateTransitionDirective(scanResult, sameDir);

    // Cross-pair sembol promosyonu: yeni sinyal daha yuksek likiditeli borsada ise
    // (ornegin Binance:BTCUSDT vs Coinbase:BTCUSD), kayitin sembolunu/kategorisini
    // yukari cek. Tracking state korunur — sadece etiket guncellenir.
    if (sameDir.symbol !== scanResult.symbol) {
      const newRank = getResolvedExchangeRank(scanResult.symbol, scanResult.category).rank;
      const existRank = getResolvedExchangeRank(sameDir.symbol, sameDir.category).rank;
      if (newRank < existRank) {
        if (!Array.isArray(sameDir.warnings)) sameDir.warnings = [];
        sameDir.warnings.push(`SEMBOL PROMOSYONU: ${sameDir.symbol} → ${scanResult.symbol} (daha hacimli borsa)`);
        sameDir.symbol = scanResult.symbol;
        sameDir.category = scanResult.category || sameDir.category;
      }
    }

    if (shouldUpgradeLevels) {
      sameDir.grade = scanResult.grade;
      sameDir.timeframe = tf;
      sameDir.entry = scanResult.entry || sameDir.entry;
      sameDir.sl = scanResult.sl || sameDir.sl;
      sameDir.tp1 = scanResult.tp1 || sameDir.tp1;
      sameDir.tp2 = scanResult.tp2 || sameDir.tp2;
      sameDir.tp3 = scanResult.tp3 || sameDir.tp3;
      sameDir.rr = scanResult.rr || sameDir.rr;
      sameDir.entrySource = scanResult.entrySource || sameDir.entrySource;
      sameDir.entryZone = scanResult.entryZone || sameDir.entryZone;
      sameDir.entryReasoning = scanResult.entryReasoning || sameDir.entryReasoning;
      sameDir.quotePrice = scanResult.quotePrice || sameDir.quotePrice;
      sameDir.slSource = scanResult.slSource || sameDir.slSource;
      sameDir.atr = scanResult.atr || sameDir.atr;
      // Yeni entry source varsa deadline'i yenile (market-entry'de null).
      const _isSmart = scanResult.entrySource && scanResult.entrySource !== 'quote_price' && scanResult.entrySource !== 'lastbar_close';
      if (_isSmart) {
        const tfMin = Number(tf) || 15;
        sameDir.entryDeadline = new Date(now.getTime() + tfMin * 60 * 1000 * 8).toISOString();
      } else {
        sameDir.entryDeadline = null;
      }
      // entryHit'i yeni entrySource ile senkronize et. Smart→market gecisinde
      // (OB/FVG zonu doldu, refresh market entry'ye dustu) entryHit=true olmali;
      // aksi halde pozisyon aslinda dolmus ama UI "entry bekliyor" der ve
      // TP/SL hit olsa bile sinyal acik listede takili kalir.
      if (!_isSmart && !sameDir.entryHit) {
        sameDir.entryHit = true;
        sameDir.entryHitAt = sameDir.entryHitAt || now.toISOString();
      }
    } else {
      // Grade dustu ama TF ayni — sadece reasoning'e uyari ekle
      if (!Array.isArray(sameDir.warnings)) sameDir.warnings = [];
      sameDir.warnings.push(`GRADE DUSUS: ${sameDir.grade} → ${scanResult.grade} (pozisyon korundu)`);
    }

    writeJSON(OPEN_PATH, data);
    console.log(`[Signal] ${scanResult.symbol} ${scanResult.direction}: upsert (grade=${sameDir.grade}, tf=${sameDir.timeframe}, refreshCount=${sameDir.refreshCount})`);
    // Executor dispatch — yalniz grade yukseldi/levels tazelendi ve A/B/C ise.
    // Duplicate id gelirse executor reddeder (idempotent).
    if (shouldUpgradeLevels) dispatchToOkxExecutor(sameDir);
    return sameDir;
  }

  // --- BEKLE cap: sembol basina max N acik BEKLE, fazlasi en eskiden superseded_by_cap ---
  if (scanResult.grade === 'BEKLE') {
    const bekleOpen = allForGroup
      .filter(s => s.grade === 'BEKLE')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    // Yeni BEKLE geldiginde mevcut sayi >= cap ise, fazlasi yaslisiyla kapatilir.
    // Yeni kayit eklendikten sonra toplam cap'i asarsa da en eski dusmelidir.
    const excess = (bekleOpen.length + 1) - BEKLE_CAP_PER_SYMBOL;
    if (excess > 0) {
      for (let i = 0; i < excess; i++) {
        const victim = bekleOpen[i];
        if (!victim) break;
        victim.status = 'superseded_by_cap';
        victim.supersededAt = now.toISOString();
        victim.supersededBy = 'BEKLE_CAP';
      }
      writeJSON(OPEN_PATH, data);
      console.log(`[Signal] ${scanResult.symbol}: BEKLE cap asildi, ${excess} eski kayit superseded_by_cap`);
    }
  }

  // --- Yeni pozisyon: mevcut pozisyon yok, yeni kayit olustur ---
  const existingSignal = null; // Bu noktada opposite ve sameDir ikisi de null
  let transitionDirective = null;

  const record = {
    id: generateId(scanResult.symbol, tf),
    symbol: scanResult.symbol,
    category: scanResult.category || inferCategory(scanResult.symbol),
    timeframe: tf,
    mode: scanResult.mode || 'short',
    direction: scanResult.direction || null,
    grade: scanResult.grade,
    league: scanResult.league || null,
    position_pct: scanResult.position_pct ?? null,
    regime: scanResult.regime || null,

    // Price levels
    entry: scanResult.entry || null,
    sl: scanResult.sl || null,
    tp1: scanResult.tp1 || null,
    tp2: scanResult.tp2 || null,
    tp3: scanResult.tp3 || null,
    rr: scanResult.rr || null,

    // Smart entry metadata
    entrySource: scanResult.entrySource || 'lastbar_close',
    entryZone: scanResult.entryZone || null,
    entryReasoning: scanResult.entryReasoning || [],
    quotePrice: scanResult.quotePrice || null,
    slSource: scanResult.slSource || 'atr_based',
    atr: scanResult.atr || null,

    // Entry bekleme suresi (smart entry icin). 8 bar * TF dakika → ms
    entryDeadline: (() => {
      const isSmart = scanResult.entrySource && scanResult.entrySource !== 'quote_price' && scanResult.entrySource !== 'lastbar_close';
      if (!isSmart) return null;
      const tfMin = Number(tf) || 15;
      const deadlineMs = now.getTime() + tfMin * 60 * 1000 * 8;
      return new Date(deadlineMs).toISOString();
    })(),

    // Full indicator snapshot for learning
    indicators: extractIndicatorSnapshot(scanResult),

    // Grading detail
    reasoning: scanResult.reasoning || [],
    warnings: scanResult.warnings || [],

    // Tracking state
    createdAt: now.toISOString(),
    status: 'open',
    // Non-smart entry (quote_price / lastbar_close) = market giris, aninda dolmus sayilir.
    // Smart entry (limit/FVG/OB vb.) fiyat gelene kadar bekler; outcome-checker entryHit'i setler.
    entryHit: !(scanResult.entrySource && scanResult.entrySource !== 'quote_price' && scanResult.entrySource !== 'lastbar_close'),
    entryHitAt: (scanResult.entrySource && scanResult.entrySource !== 'quote_price' && scanResult.entrySource !== 'lastbar_close') ? null : now.toISOString(),
    slHit: false,
    slHitAt: null,
    tp1Hit: false,
    tp1HitAt: null,
    tp2Hit: false,
    tp2HitAt: null,
    tp3Hit: false,
    tp3HitAt: null,
    highestFavorable: null,
    lowestAdverse: null,
    lastCheckedPrice: null,
    lastCheckedAt: null,
    checkCount: 0,
    transitionDirective: transitionDirective,
    previousSignalId: existingSignal?.id || null,

    // --- Yeni alanlar (tek-poz + reverse-yok politikasi) ---
    lastRefreshedAt: null,
    refreshCount: 0,
    reverseAttempts: [],
    trailingStopActive: false,
    trailingStopLevel: null,
    manualClose: false,
    manualCloseAt: null,

    // Pump-top guard meta — entry dolana kadar executor'a gitmez.
    pumpGuard: scanResult.pumpGuard || null,
    pendingPullback: scanResult.pendingPullback || null,

    // Yapisal SL meta (varsa)
    structuralSL: scanResult.structuralSL || null,

    // --- Reconciliation (Risk #2 — broker state desync) ---
    // `id` ayni zamanda `trade_id` rolunde kullanilir; broker_order_ids bu id'ye
    // baglidir. Executor/broker her emir icin {venue, order_id, kind} ekler.
    //   kind: 'entry' | 'sl' | 'tp1' | 'tp2' | 'tp3' | 'reduce' | 'close'
    //   status: 'submitted' | 'live' | 'filled' | 'canceled' | 'rejected' | 'unknown'
    // reconciliationState: periyodik reconciliation job tarafindan guncellenir.
    //   state: 'unknown' | 'in_sync' | 'desync_detected' | 'halted'
    brokerVenue: scanResult.brokerVenue || null,
    brokerOrderIds: [],
    reconciliationState: {
      state: 'unknown',
      lastCheckedAt: null,
      desyncCount: 0,
      lastMismatch: null,
      expectedPosition: null,
      brokerPosition: null,
      haltedAt: null,
      haltReason: null,
      // C: TP/SL zincir asamasi — reconciliation job broker ile karsilastirirken bakar.
      currentStage: 'pending', // 'pending' | 'entry' | 'tp1' | 'tp2' | 'tp3' | 'closed'
      // A: monotonic sayac — timestamp'e degil buna guvenilir.
      monotonicSeq: 0,
      lastMonotonicTs: 0,
    },

    // Vote breakdown — A-grade attribution raporu icin gerekli. Sadece
    // {source, direction, weight} kaydet (reasoning zaten record.reasoning'de).
    voteBreakdown: Array.isArray(scanResult.votes)
      ? scanResult.votes.map(v => ({
          source: v.source,
          direction: v.direction || null,
          weight: typeof v.weight === 'number' ? Number(v.weight.toFixed(3)) : null,
        }))
      : null,
    tally: scanResult.tally
      ? {
          direction: scanResult.tally.direction,
          conviction: scanResult.tally.conviction,
          agreement: scanResult.tally.agreement,
          longScore: scanResult.tally.longScore,
          shortScore: scanResult.tally.shortScore,
          voterCount: scanResult.tally.voterCount,
        }
      : null,
  };

  // Persist — yeni kayit (tum dedup/opposite kontrolu yukarida yapildi)
  data.signals.push(record);
  writeJSON(OPEN_PATH, data);

  // Executor dispatch — yeni A/B/C kayit.
  dispatchToOkxExecutor(record);

  return record;
}

/**
 * Get all currently open (tracked) signals.
 */
export function getOpenSignals() {
  return readJSON(OPEN_PATH, { signals: [] }).signals;
}

/**
 * Update an open signal's tracking state.
 */
export function updateSignal(signalId, updates) {
  const data = readJSON(OPEN_PATH, { signals: [] });
  const idx = data.signals.findIndex(s => s.id === signalId);
  if (idx === -1) return null;

  Object.assign(data.signals[idx], updates);
  writeJSON(OPEN_PATH, data);
  return data.signals[idx];
}

/**
 * Remove a signal from the open list (after resolution).
 */
export function removeOpenSignal(signalId) {
  const data = readJSON(OPEN_PATH, { signals: [] });
  data.signals = data.signals.filter(s => s.id !== signalId);
  writeJSON(OPEN_PATH, data);
}

/**
 * Reconciliation: bir sinyale broker emir kaydi ekler.
 * order: { venue, orderId, kind, side, type, price, qty, status, submittedAt, raw }
 *   kind: 'entry' | 'sl' | 'tp1' | 'tp2' | 'tp3' | 'reduce' | 'close'
 *   status: 'submitted' | 'live' | 'filled' | 'canceled' | 'rejected' | 'unknown'
 * Idempotent: ayni (venue, orderId) varsa status/filled alanlarini gunceller.
 */
export function attachBrokerOrder(signalId, order) {
  if (!signalId || !order || !order.venue || !order.orderId) return null;
  const data = readJSON(OPEN_PATH, { signals: [] });
  const sig = data.signals.find(s => s.id === signalId);
  if (!sig) return null;
  if (!Array.isArray(sig.brokerOrderIds)) sig.brokerOrderIds = [];
  if (!sig.reconciliationState) sig.reconciliationState = { state:'unknown', monotonicSeq:0, lastMonotonicTs:0 };
  const rs = sig.reconciliationState;

  // A: Monotonic timestamp kontrolu. Sistem saati geri alinirsa clock_drift uyarisi.
  const nowMs = Date.now();
  if (rs.lastMonotonicTs && nowMs < rs.lastMonotonicTs) {
    console.warn(`[Reconciliation] ${signalId}: CLOCK DRIFT DETECTED — now=${nowMs} < last=${rs.lastMonotonicTs}`);
    if (!Array.isArray(sig.warnings)) sig.warnings = [];
    sig.warnings.push(`CLOCK_DRIFT at attachBrokerOrder: ${rs.lastMonotonicTs - nowMs}ms geri`);
  }
  rs.monotonicSeq = (rs.monotonicSeq || 0) + 1;
  rs.lastMonotonicTs = Math.max(rs.lastMonotonicTs || 0, nowMs);

  const existing = sig.brokerOrderIds.find(o => o.venue === order.venue && o.orderId === order.orderId);
  const now = new Date(nowMs).toISOString();

  // B: partial fills — yeni fill append edilir, aggregate filledQty/avgFillPrice yeniden hesaplanir.
  const incomingFills = Array.isArray(order.fills) ? order.fills : [];
  const mergeFills = (prevFills) => {
    const base = Array.isArray(prevFills) ? prevFills.slice() : [];
    for (const f of incomingFills) {
      if (!f || typeof f.qty !== 'number') continue;
      // Dedup: (at, price, qty) unique
      if (base.some(x => x.at === f.at && x.price === f.price && x.qty === f.qty)) continue;
      base.push({ qty: f.qty, price: f.price, at: f.at || now });
    }
    return base;
  };
  const aggregate = (fills) => {
    if (!fills.length) return { filledQty: null, avgFillPrice: null };
    const q = fills.reduce((a, f) => a + f.qty, 0);
    if (q <= 0) return { filledQty: 0, avgFillPrice: null };
    const notional = fills.reduce((a, f) => a + f.qty * (f.price || 0), 0);
    return { filledQty: Number(q.toFixed(8)), avgFillPrice: Number((notional / q).toFixed(8)) };
  };

  const normalized = {
    venue: order.venue,
    orderId: order.orderId,
    kind: order.kind || 'unknown',
    side: order.side || null,
    type: order.type || null,
    price: order.price ?? null,
    qty: order.qty ?? null,
    status: order.status || 'submitted',
    // D: source — manuel mudahaleyi API'den ayir.
    source: order.source || 'api', // 'api' | 'manual' | 'unknown'
    submittedAt: order.submittedAt || now,
    updatedAt: now,
    monotonicSeq: rs.monotonicSeq,
    fills: incomingFills.length ? mergeFills([]) : [],
    filledQty: order.filledQty ?? null,
    avgFillPrice: order.avgFillPrice ?? null,
    raw: order.raw || null,
  };

  if (existing) {
    // A: per-order monotonic — existing.updatedAt'den geri gitme
    const prevUpdated = Date.parse(existing.updatedAt || 0);
    if (prevUpdated && nowMs < prevUpdated) {
      console.warn(`[Reconciliation] ${signalId}/${order.orderId}: per-order clock drift ${prevUpdated - nowMs}ms geri`);
    }
    const merged = mergeFills(existing.fills);
    const agg = aggregate(merged);
    Object.assign(existing, normalized, {
      submittedAt: existing.submittedAt,           // ilk submit korunur
      source: existing.source === 'manual' ? 'manual' : (order.source || existing.source || 'api'),
      fills: merged,
      filledQty: agg.filledQty ?? normalized.filledQty,
      avgFillPrice: agg.avgFillPrice ?? normalized.avgFillPrice,
    });
  } else {
    if (incomingFills.length) {
      normalized.fills = mergeFills([]);
      const agg = aggregate(normalized.fills);
      normalized.filledQty = agg.filledQty ?? normalized.filledQty;
      normalized.avgFillPrice = agg.avgFillPrice ?? normalized.avgFillPrice;
    }
    sig.brokerOrderIds.push(normalized);
  }

  // D: manuel mudahale tespit edildiyse ayri uyari (desync degil, bilincli eylem).
  if (order.source === 'manual') {
    if (!Array.isArray(sig.warnings)) sig.warnings = [];
    sig.warnings.push(`MANUAL_INTERVENTION: ${order.venue}/${order.orderId} (${order.kind || '?'}) @ ${now}`);
  }

  if (!sig.brokerVenue) sig.brokerVenue = order.venue;
  writeJSON(OPEN_PATH, data);
  return existing || normalized;
}

/**
 * Reconciliation: periyodik job tarafindan cagrilir.
 * patch: reconciliationState uzerine uygulanacak partial obje.
 * Ek olarak `desyncIncrement: true` ile desyncCount artirir, `halt: { reason }`
 * ile state='halted' + haltedAt/haltReason setler.
 */
export function updateReconciliationState(signalId, patch = {}) {
  const VALID_STAGES = new Set(['pending', 'entry', 'tp1', 'tp2', 'tp3', 'closed']);
  const data = readJSON(OPEN_PATH, { signals: [] });
  const sig = data.signals.find(s => s.id === signalId);
  if (!sig) return null;
  if (!sig.reconciliationState) {
    sig.reconciliationState = {
      state: 'unknown', lastCheckedAt: null, desyncCount: 0,
      lastMismatch: null, expectedPosition: null, brokerPosition: null,
      haltedAt: null, haltReason: null,
      currentStage: 'pending', monotonicSeq: 0, lastMonotonicTs: 0,
    };
  }
  const rs = sig.reconciliationState;
  const nowMs = Date.now();

  // A: monotonic kontrol.
  if (rs.lastMonotonicTs && nowMs < rs.lastMonotonicTs) {
    console.warn(`[Reconciliation] ${signalId}: CLOCK DRIFT in updateReconciliationState — ${rs.lastMonotonicTs - nowMs}ms geri`);
    if (!Array.isArray(sig.warnings)) sig.warnings = [];
    sig.warnings.push(`CLOCK_DRIFT at updateReconciliationState: ${rs.lastMonotonicTs - nowMs}ms geri`);
  }
  rs.monotonicSeq = (rs.monotonicSeq || 0) + 1;
  rs.lastMonotonicTs = Math.max(rs.lastMonotonicTs || 0, nowMs);

  const now = new Date(nowMs).toISOString();
  rs.lastCheckedAt = patch.lastCheckedAt || now;
  if (patch.state) rs.state = patch.state;
  if (patch.expectedPosition !== undefined) rs.expectedPosition = patch.expectedPosition;
  if (patch.brokerPosition !== undefined) rs.brokerPosition = patch.brokerPosition;
  if (patch.lastMismatch !== undefined) rs.lastMismatch = patch.lastMismatch;
  if (patch.desyncIncrement) rs.desyncCount = (rs.desyncCount || 0) + 1;

  // C: currentStage — yalniz gecerli degerler ve monotonic ilerleme (gecici regresyon sadece 'closed'a gecis haric).
  if (patch.currentStage) {
    if (!VALID_STAGES.has(patch.currentStage)) {
      console.warn(`[Reconciliation] ${signalId}: invalid currentStage=${patch.currentStage}, ignored`);
    } else {
      const order = { pending: 0, entry: 1, tp1: 2, tp2: 3, tp3: 4, closed: 5 };
      const prev = order[rs.currentStage] ?? 0;
      const next = order[patch.currentStage];
      if (next < prev && patch.currentStage !== 'closed') {
        console.warn(`[Reconciliation] ${signalId}: stage regression ${rs.currentStage} → ${patch.currentStage} (allowed sadece 'closed' icin)`);
        if (!Array.isArray(sig.warnings)) sig.warnings = [];
        sig.warnings.push(`STAGE_REGRESSION: ${rs.currentStage} → ${patch.currentStage}`);
      }
      rs.currentStage = patch.currentStage;
    }
  }

  if (patch.halt) {
    rs.state = 'halted';
    rs.haltedAt = now;
    rs.haltReason = patch.halt.reason || 'unspecified';
  }

  // D: manuel mudahale bilincli eylem — desync degil, ayri alarm.
  if (patch.manualIntervention) {
    if (!Array.isArray(sig.warnings)) sig.warnings = [];
    sig.warnings.push(`MANUAL_INTERVENTION_RECONCILED: ${patch.manualIntervention.detail || 'detay yok'} @ ${now}`);
  }

  writeJSON(OPEN_PATH, data);
  return rs;
}

/**
 * Get open signal count.
 */
export function getOpenCount() {
  return readJSON(OPEN_PATH, { signals: [] }).signals.length;
}

/**
 * Extract indicator snapshot from a scan result for learning / analysis.
 * Used both for new records and reverseAttempts logging.
 */
export function extractIndicatorSnapshot(scanResult) {
  if (!scanResult) return {};
  return {
    khanSaab: scanResult.khanSaab || scanResult.khanSaabBias ? {
      bias: scanResult.khanSaabBias || scanResult.khanSaab?.bias,
      bullScore: scanResult.khanSaab?.bullScore,
      bearScore: scanResult.khanSaab?.bearScore,
      signalStatus: scanResult.khanSaab?.signalStatus,
      rsi: scanResult.khanSaab?.rsi,
      adx: scanResult.khanSaab?.adx,
      volStatus: scanResult.khanSaab?.volStatus,
    } : null,
    smc: scanResult.smc ? {
      lastBOS: scanResult.smc.lastBOS || null,
      lastCHoCH: scanResult.smc.lastCHoCH || null,
      hasOB: !!scanResult.smc.orderBlocks?.length,
      hasFVG: !!scanResult.smc.fvgZones?.length,
    } : null,
    // Tum formasyonlar — ogrenme rank-2+ formasyonlari da saydirabilsin.
    // `formation` geriye uyumluluk icin birinci formasyonu tutar.
    formation: scanResult.formations?.[0] ? {
      name: scanResult.formations[0].name,
      direction: scanResult.formations[0].direction,
      maturity: scanResult.formations[0].maturity,
      broken: scanResult.formations[0].broken,
    } : null,
    formations: Array.isArray(scanResult.formations)
      ? scanResult.formations.slice(0, 5).map(f => ({
          name: f.name,
          direction: f.direction,
          maturity: f.maturity,
          broken: f.broken,
        }))
      : [],
    candles: Array.isArray(scanResult.candles)
      ? scanResult.candles.slice(0, 5).map(c => ({
          name: c.name,
          direction: c.direction ?? null,
          strength: c.strength ?? null,
        }))
      : [],
    squeeze: scanResult.squeeze ? {
      status: scanResult.squeeze.status,
      ratio: scanResult.squeeze.ratio,
    } : null,
    divergence: scanResult.divergence ? {
      type: scanResult.divergence.type,
      direction: scanResult.divergence.direction,
    } : null,
    cdv: scanResult.cdv ? {
      direction: scanResult.cdv.direction,
      buyRatio: scanResult.cdv.buyRatio,
    } : null,
    macroFilter: scanResult.macroFilter || null,
    mtfConfirmation: scanResult.mtfConfirmation || null,
  };
}

/**
 * Compare two indicator snapshots and return which fields changed.
 * Used by outcome-checker faulty trade analysis.
 */
export function diffIndicators(opening, reverse) {
  if (!opening || !reverse) return { note: 'snapshot eksik' };
  const diff = {};
  const same = {};

  const ks1 = opening.khanSaab || {};
  const ks2 = reverse.khanSaab || {};
  if (ks1.bias !== ks2.bias) diff.khanSaab_bias = `${ks1.bias} → ${ks2.bias}`;
  else if (ks1.bias) same.khanSaab_bias = ks1.bias;
  if ((ks1.volStatus || null) !== (ks2.volStatus || null)) diff.khanSaab_volStatus = `${ks1.volStatus} → ${ks2.volStatus}`;
  if (Number.isFinite(ks1.rsi) && Number.isFinite(ks2.rsi) && Math.abs(ks1.rsi - ks2.rsi) > 5) {
    diff.khanSaab_rsi = `${ks1.rsi?.toFixed(1)} → ${ks2.rsi?.toFixed(1)}`;
  }
  if (Number.isFinite(ks1.adx) && Number.isFinite(ks2.adx) && Math.abs(ks1.adx - ks2.adx) > 5) {
    diff.khanSaab_adx = `${ks1.adx?.toFixed(1)} → ${ks2.adx?.toFixed(1)}`;
  }

  const smc1 = opening.smc || {};
  const smc2 = reverse.smc || {};
  // lastBOS/lastCHoCH obje olabilir — referans karsilastirmasi yanlis diff
  // isaretler ve "[object Object] → [object Object]" yazisi yazar. Anlamli
  // alanlari (direction) cikar ve karsilastir.
  const smcField = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v;
    return v.direction || v.type || null;
  };
  const bos1 = smcField(smc1.lastBOS);
  const bos2 = smcField(smc2.lastBOS);
  if (bos1 !== bos2) diff.smc_BOS = `${bos1 || 'yok'} → ${bos2 || 'yok'}`;
  const ch1 = smcField(smc1.lastCHoCH);
  const ch2 = smcField(smc2.lastCHoCH);
  if (ch1 !== ch2) diff.smc_CHoCH = `${ch1 || 'yok'} → ${ch2 || 'yok'}`;

  const f1 = opening.formation || {};
  const f2 = reverse.formation || {};
  if (f1.name !== f2.name) diff.formation = `${f1.name || 'yok'} → ${f2.name || 'yok'}`;
  else if (f1.direction !== f2.direction) diff.formation_direction = `${f1.direction} → ${f2.direction}`;

  const sq1 = opening.squeeze || {};
  const sq2 = reverse.squeeze || {};
  if (sq1.status !== sq2.status) diff.squeeze = `${sq1.status} → ${sq2.status}`;

  const dv1 = opening.divergence || {};
  const dv2 = reverse.divergence || {};
  if (dv1.type !== dv2.type || dv1.direction !== dv2.direction) {
    diff.divergence = `${dv1.type || 'yok'}/${dv1.direction || '-'} → ${dv2.type || 'yok'}/${dv2.direction || '-'}`;
  }

  return { changed: diff, unchanged: same };
}

/**
 * One-time cleanup: mevcut mukerrer acik sinyalleri temizle.
 * Anahtar: symbol+direction (TF dahil DEGIL).
 * En yuksek grade + en yeni createdAt kazanir. Digerleri `superseded_by_cleanup`.
 * Arsive tasima YOK — sadece open.json'dan ayiklanir, archive'a outcome-checker bakar.
 */
export function cleanupDuplicateSignals() {
  const data = readJSON(OPEN_PATH, { signals: [] });
  const gradeOrder = { 'A': 0, 'B': 1, 'C': 2, 'BEKLE': 3, 'IPTAL': 4 };

  // Dashboard'da "canli takipte" sayilan statuler: open, tp1_hit (trailing), tp2_hit (trailing).
  // Dedup recordSignal'daki ACTIVE_STATUSES ile ayni kapsamda olmali.
  const ACTIVE_STATUSES = new Set(['open', 'tp1_hit', 'tp2_hit']);
  // Kazanan secimi: once en ilerlemis TP (tp2_hit > tp1_hit > open), sonra grade, sonra en yeni.
  // Boylece trailing aktif, kismen karda kapanmis bir pozisyon sifir-hareketli yeni bir kayitla
  // ezilmez.
  const statusProgress = { 'tp2_hit': 0, 'tp1_hit': 1, 'open': 2 };

  // Cross-pair dedup: crypto'da MONUSD/MONUSDC/MONUSDT ayni base coin (MON) gruba duser.
  // Yon dahil edilirse ters yon sinyaller ayri gruplara gider — kullanici "sadece birini tut"
  // istedigi icin crypto'da yon-bagimsiz gruplama yapilir, diger kategorilerde yon korunur.
  function groupKeyFor(sig) {
    const base = dedupGroupKey(sig);
    const isCrypto = base.startsWith('crypto:');
    return isCrypto ? base : `${base}_${sig.direction}`;
  }

  const groups = new Map();
  for (const sig of data.signals) {
    if (!ACTIVE_STATUSES.has(sig.status)) continue;
    const key = groupKeyFor(sig);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(sig);
  }

  let cleaned = 0;
  let kept = 0;
  const nowIso = new Date().toISOString();

  for (const [, group] of groups) {
    if (group.length <= 1) { kept += group.length; continue; }

    // Sort:
    //   1. En ilerlemis status (tp2_hit > tp1_hit > open) — kismen karda kapanmis kayit ezilmesin
    //   2. Daha hacimli borsa (BINANCE > BYBIT > OKX > COINBASE > KRAKEN) — user tercihi
    //   3. En iyi grade (A > B > C > BEKLE)
    //   4. En yeni
    group.sort((a, b) => {
      const pA = statusProgress[a.status] ?? 9;
      const pB = statusProgress[b.status] ?? 9;
      if (pA !== pB) return pA - pB;
      const rA = getResolvedExchangeRank(a.symbol, a.category).rank;
      const rB = getResolvedExchangeRank(b.symbol, b.category).rank;
      if (rA !== rB) return rA - rB;
      const gA = gradeOrder[a.grade] ?? 9;
      const gB = gradeOrder[b.grade] ?? 9;
      if (gA !== gB) return gA - gB;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const winner = group[0];
    kept++;
    for (let i = 1; i < group.length; i++) {
      const loser = group[i];
      loser.status = 'superseded_by_cleanup';
      loser.supersededAt = nowIso;
      loser.supersededBy = winner.id;
      cleaned++;
    }
  }

  writeJSON(OPEN_PATH, data);
  return { cleaned, kept, totalBefore: data.signals.length };
}

// --- Helpers ---

// Kategori tahmini rules.json watchlist'inden okunur (symbol-resolver.js).
// Yerel dublikat BIST hisselerini (THYAO/GARAN/AKBNK/ISCTR/SAHOL/EREGL/BIMAS/
// TUPRS/SISE/ASELS disindakileri, orn. PGSUS, TOASO, PEKGY, MERKO, AEFES)
// 'abd_hisse' olarak yanlis etiketliyordu — watchlist-tabanli surum dogru.
function inferCategory(symbol) {
  if (!symbol) return 'unknown';
  const cat = resolveInferCategory(symbol);
  return cat || 'unknown';
}
