/**
 * Weight Adjuster — adaptive threshold and weight tuning.
 * Implements damped adjustments with minimum sample sizes.
 * Follows observation → preliminary → active learning phases.
 */

import { readJSON, writeJSON, dataPath, readAllArchives } from './persistence.js';
import { recomputeAllStats } from './stats-engine.js';
import { scoreAllIndicators, scoreIndicatorsForSubset } from './indicator-scorer.js';
import { preCommitCheck, createCheckpoint, evaluatePendingCheckpoints } from './shadow-guard.js';

// Faulty trade adjustment parameters
const FAULTY_MIN_COUNT = 3;     // en az 3 hatali goren indikator ayarlanir
const FAULTY_GUILT_RATE = 0.15; // toplam sinyalin > %15'inde suclu cikarsa azalt
const FAULTY_REDUCE_PCT = 0.9;  // agirligi %10 azalt
const FAULTY_WEIGHT_FLOOR = 0.3;

// --- Per-symbol league transitions (muhafazakar esikler) ---
// Promotion: virtual (BEKLE) liga tutarli kazanci icin
const PROMOTION_MIN_N = 30;      // en az 30 BEKLE cozulmus
const PROMOTION_MIN_WR = 60;     // %60+ win rate
const PROMOTION_MIN_RR = 1.0;    // avgRR >= 1.0
const PROMOTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 gun
const PROMOTION_HYSTERESIS = 15; // promotion sonrasi 15 yeni sinyal gec
// Demotion: real liga kalici zarar icin
const DEMOTION_MIN_N = 20;       // en az 20 gercek sinyal
const DEMOTION_MAX_WR = 35;      // %35 altinda
const DEMOTION_FAULTY_COUNT = 3; // VEYA >= 3 faultyTrade
const DEMOTION_HYSTERESIS = 15;
// Flagged sembollerin real sinyal ureme yolu kapali oldugu icin stats.winRate
// sonsuza dek eski degerde kalir (catch-22). Virtual WR kurtulus yolu:
// flag konduktan sonra BEKLE kovasinda iyi performans gostrirse flag kaldirilir.
const FLAG_RECOVERY_MIN_N = 15;  // en az 15 yeni BEKLE cozulmus
const FLAG_RECOVERY_MIN_WR = 40; // %40+ win rate
const FLAG_RECOVERY_COOLDOWN = 20; // flag kaldirildiktan sonra 20 yeni sinyal gec

const WEIGHTS_PATH = dataPath('weights', 'current.json');
const HISTORY_DIR = dataPath('weights', 'history');

const DEFAULT_WEIGHTS = {
  version: 1,
  gradeThresholds: {
    A_min: 7.5, A_minAgreement: 75,
    B_min: 5, B_minAgreement: 60,
    C_min: 3, C_minAgreement: 50,
    BEKLE_min: 1.5,
    minRR: 2.0,
  },
  indicatorWeights: {
    khanSaab: 1.0, smc_bos: 1.0, smc_choch: 1.0, smc_ob: 1.0, smc_fvg: 1.0,
    formation: 1.0, rsi_divergence: 1.0, rsi_level: 1.0, macd: 1.0, ema_cross: 1.0,
    cdv: 1.0, adx_trend: 1.0, squeeze_filter: 1.0, macro_filter: 1.0, volume_confirm: 1.0,
    stoch_rsi: 1.0,
  },
  slMultiplierOverrides: {},
  timeframeReliability: {},
  symbolAdjustments: {},
  byRegime: {},
  learningState: 'observation',
  totalResolved: 0,
  observationThreshold: 30,
  adjustmentHistory: [],
  // Faz 0 Part 2: per-key circular log, rate cap hesabi icin yapisal veri.
  // Key formati: global indikator icin "<indicatorKey>", rejim-scoped icin
  // "regime:<regime>:<indicatorKey>". Her entry: {at, from, to}.
  weightChangeLog: {},
};

// Target win rates per grade
const TARGET_WIN_RATES = { A: 65, B: 55, C: 45 };

// Target profit factors per grade — WR tek basina profitability'yi olcmez.
// Ornegin A sinyal WR %70 olup R:R %0.5 ise PF 1.16, bu iyi degil. PF altindaki
// grade'ler sikilastirilir.
const TARGET_PROFIT_FACTORS = { A: 2.5, B: 1.8, C: 1.2 };

// Minimum sample size for adjustments
const MIN_SAMPLE = 20;

// DISABLED indicators — auto-tuner bu anahtarlarin agirligini yukseltemez.
// 2026-04-18: formation canli veride -17.46% lift ile net zararli. Yeni veri
// gelse bile 0.0 tabanindan sapmamali. Kaldirmak yerine gizli tutulur ki
// raporlara "counterproductive" goruntusu kalsin ve ileride veri degisirse
// manuel olarak kaldirilabilsin.
// 2026-04-22: khanSaab autonomous-learning raporunda -8.58% lift. Vote ozelinde
// devre disi (ayrica current.json indicatorWeights.khanSaab = 0). Veri akisi
// (rsi/macd/ema/adx) ayri vote'lar olarak korunur — sadece composite khanSaab
// oyu sifirlanir.
const DISABLED_INDICATORS = new Set(['formation', 'khanSaab']);

// Maximum adjustment per cycle (damping)
const MAX_ADJUST_PCT = 0.10; // 10% max change

// --- Faz 0 Part 2: Learning overfit guardrails (Risk #1, #16) ---
// MAX_WEIGHT_RATE_PER_DAY: herhangi bir indikator agirliginin son 24 saatte
//   kümülatif |delta| / baseline degeri bu orani asamaz. Damping (per-cycle)
//   + rate cap (rolling 24h) kombinasyonu kontrolsuz surukulenmeyi engeller.
// INDICATOR_LEARNING_MIN_SAMPLE: MIN_SAMPLE=20 diger ayarlamalar icin kalir;
//   indikator agirlik ogrenmesi risk matrisi #1 geregi 30 ornek esigi ister.
// WEIGHT_CHANGE_LOG_MAX: per-key circular buffer boyutu.
const MAX_WEIGHT_RATE_PER_DAY = 0.20;
const INDICATOR_LEARNING_MIN_SAMPLE = 30;
const WEIGHT_CHANGE_LOG_MAX = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Son 24h icinde bu key icin kaydedilmis mutlak delta'lari topla.
 * @returns {{sum24h:number, baseline24h:number|null, entries:Array}}
 */
function sumRecentWeightChanges(log, key, nowMs) {
  const arr = (log && log[key]) || [];
  const cutoff = nowMs - DAY_MS;
  const entries = arr.filter(e => e && e.at && Date.parse(e.at) >= cutoff);
  const sum = entries.reduce((a, e) => a + Math.abs((e.to ?? 0) - (e.from ?? 0)), 0);
  // Baseline24h = ilk kayittan onceki 'from' (yoksa current weight; caller fallback eder)
  const baseline = entries.length ? entries[0].from : null;
  return { sum24h: sum, baseline24h: baseline, entries };
}

/**
 * Proposed weight'i rate cap ile kirpa. Son 24h kümülatif + proposed delta,
 * baseline24h (veya current) * 0.20 degerini asmamali.
 * Clip tetiklenirse warn log + capped deger dondurulur.
 */
function rateCapClip(weights, key, currentWeight, proposedWeight) {
  if (!Number.isFinite(currentWeight) || !Number.isFinite(proposedWeight)) return proposedWeight;
  if (currentWeight === proposedWeight) return proposedWeight;

  if (!weights.weightChangeLog) weights.weightChangeLog = {};
  const nowMs = Date.now();
  const { sum24h, baseline24h } = sumRecentWeightChanges(weights.weightChangeLog, key, nowMs);
  const baseline = (baseline24h != null && baseline24h > 0) ? baseline24h : Math.max(currentWeight, 0.01);
  const proposedDelta = Math.abs(proposedWeight - currentWeight);
  const totalIfCommitted = sum24h + proposedDelta;
  const cap = baseline * MAX_WEIGHT_RATE_PER_DAY;

  if (totalIfCommitted <= cap) return proposedWeight;

  const headroom = Math.max(0, cap - sum24h);
  const dir = proposedWeight > currentWeight ? 1 : -1;
  const capped = Number((currentWeight + dir * headroom).toFixed(3));
  console.warn(`[Learning][RATE_CAP] ${key}: proposed ${currentWeight}→${proposedWeight} ` +
               `(Δ=${proposedDelta.toFixed(3)}, 24h cumΔ=${sum24h.toFixed(3)}, cap=${cap.toFixed(3)}) ` +
               `→ clipped to ${capped}`);
  return capped;
}

/**
 * Weight change'i yapisal log'a kaydet. adjustIndicatorWeights ve
 * adjustRegimeSpecificWeights commit ettikten sonra cagirir.
 */
function logWeightChange(weights, key, fromVal, toVal) {
  if (!weights.weightChangeLog) weights.weightChangeLog = {};
  if (!Array.isArray(weights.weightChangeLog[key])) weights.weightChangeLog[key] = [];
  weights.weightChangeLog[key].push({ at: new Date().toISOString(), from: fromVal, to: toVal });
  if (weights.weightChangeLog[key].length > WEIGHT_CHANGE_LOG_MAX) {
    weights.weightChangeLog[key] = weights.weightChangeLog[key].slice(-WEIGHT_CHANGE_LOG_MAX);
  }
}

// Hard floors: auto-tuner cannot push thresholds below these values.
// Prevents runaway tightening when HTF veto / MTF 75% / per-symbol filters
// already reduce signal volume, causing misleading WR signals.
const THRESHOLD_FLOORS = { A_min: 7.5, B_min: 5.0, C_min: 3.5 };
// Skip threshold tightening until we have at least this many resolved signals.
const THRESHOLD_TUNE_MIN_RESOLVED = 100;
// Per-grade cooldown: require at least N new resolved signals for that grade
// between two conviction/agreement adjustments. Manuel "Ayarla" basislari
// ayni istatistige dayali tekrar tetiklemeyi engeller.
const THRESHOLD_TUNE_PER_GRADE_COOLDOWN = 20;

/**
 * Load current weights.
 */
export function loadWeights() {
  return readJSON(WEIGHTS_PATH, DEFAULT_WEIGHTS);
}

/**
 * Save weights with history snapshot.
 */
function saveWeights(weights, reason) {
  weights.updatedAt = new Date().toISOString();
  weights.updateReason = reason;
  weights.version = (weights.version || 0) + 1;

  // Save history snapshot
  const histFile = `${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  writeJSON(`${HISTORY_DIR}/${histFile}`, { ...weights, snapshotReason: reason });

  // Save current
  writeJSON(WEIGHTS_PATH, weights);
  return weights;
}

/**
 * Clamp a value between min and max.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Adjust grade thresholds based on win rates.
 * Uses conviction-based thresholds (A_min, B_min, C_min) and agreement minimums.
 * If A-signal WR < target → tighten (raise threshold). If >> target → loosen slightly.
 */
function adjustGradeThresholds(weights, statsByGrade) {
  const changes = [];

  // Guardrail: don't tune thresholds until we have enough resolved data
  // Prevents runaway tightening during Plan B filter rollout.
  if ((weights.totalResolved || 0) < THRESHOLD_TUNE_MIN_RESOLVED) {
    return [`Threshold ayarlamasi atlandi — ${weights.totalResolved}/${THRESHOLD_TUNE_MIN_RESOLVED} resolved sinyal gerekli`];
  }

  weights.thresholdTuneState = weights.thresholdTuneState || {};

  for (const [grade, target] of Object.entries(TARGET_WIN_RATES)) {
    const stats = statsByGrade[grade];
    if (!stats || stats.total < MIN_SAMPLE) continue;

    // Cooldown: ayni istatistik uzerinden pespese ayarlama yapilmasin.
    // Grade icin son ayarlamadan bu yana en az N yeni cozulmus sinyal gerekli.
    const lastTune = weights.thresholdTuneState[grade];
    if (lastTune && (stats.total - (lastTune.total || 0)) < THRESHOLD_TUNE_PER_GRADE_COOLDOWN) {
      changes.push(`${grade}-sinyal esigi beklemede — son ayarlamadan bu yana ${stats.total - lastTune.total}/${THRESHOLD_TUNE_PER_GRADE_COOLDOWN} yeni cozulmus sinyal`);
      continue;
    }

    const delta = target - stats.winRate;
    // PF hedefine gore ek sikilastirma sinyali: WR yuzeysel olarak iyi olsa
    // bile PF hedef altindaysa esik sikilastir.
    const pfTarget = TARGET_PROFIT_FACTORS[grade] || 1.0;
    const pfDelta = pfTarget - (stats.profitFactor ?? 0);

    let gradeTouched = false;
    // Adjust conviction threshold (smaller step, clamped by floor)
    const convKey = `${grade}_min`;
    const currentConv = weights.gradeThresholds[convKey];
    const floor = THRESHOLD_FLOORS[convKey] ?? 1.0;
    // Monotonluk: C_min <= B_min <= A_min (aksi halde if/else waterfall'da
    // alt grade ulasilmaz olur — ornegin C_min > A_min ise C sinifi hic
    // atanmaz). Tavani komsu grade'e bagla.
    let ceiling = 12.0;
    if (grade === 'B') ceiling = Math.min(12.0, (weights.gradeThresholds.A_min ?? 12.0) - 0.25);
    if (grade === 'C') ceiling = Math.min(12.0, (weights.gradeThresholds.B_min ?? 12.0) - 0.25);
    if (currentConv != null) {
      let adjustment = 0;
      if (delta > 10) adjustment = 0.20;       // was 0.5 — slower tightening
      else if (delta > 5) adjustment = 0.10;   // was 0.25
      else if (delta < -15) adjustment = -0.10; // was -0.25

      // PF hedef altindaysa ek sikilastirma (WR iyi gorunse bile)
      if (pfDelta > 0.5 && adjustment <= 0) adjustment = 0.10;
      else if (pfDelta > 0.3 && adjustment <= 0) adjustment = 0.05;

      if (adjustment !== 0) {
        // Apply 50% damping
        const dampedAdj = adjustment * 0.5;
        const newConv = clamp(Math.round((currentConv + dampedAdj) * 100) / 100, floor, ceiling);
        if (newConv !== currentConv) {
          weights.gradeThresholds[convKey] = newConv;
          changes.push(`${grade}-sinyal kanaat esigi: ${currentConv} → ${newConv} (WR: %${stats.winRate}/%${target}, PF: ${(stats.profitFactor ?? 0).toFixed(2)}/${pfTarget}, taban: ${floor}, tavan: ${ceiling})`);
          gradeTouched = true;
        }
      }
    }

    // Adjust agreement threshold
    const agrKey = `${grade}_minAgreement`;
    const currentAgr = weights.gradeThresholds[agrKey];
    if (currentAgr != null) {
      let agrAdj = 0;
      if (delta > 10) agrAdj = 5;       // Tighten agreement too
      else if (delta > 5) agrAdj = 2;
      else if (delta < -15) agrAdj = -2;

      if (agrAdj !== 0) {
        const dampedAgrAdj = Math.round(agrAdj * 0.5);
        const newAgr = clamp(currentAgr + dampedAgrAdj, 40, 90);
        if (newAgr !== currentAgr) {
          weights.gradeThresholds[agrKey] = newAgr;
          changes.push(`${grade}-sinyal uyum esigi: ${currentAgr}% → ${newAgr}% (WR: %${stats.winRate})`);
          gradeTouched = true;
        }
      }
    }

    if (gradeTouched) {
      weights.thresholdTuneState[grade] = {
        total: stats.total,
        timestamp: new Date().toISOString(),
      };
    }
  }

  // Monotonluk duzeltmesi: eski bozuk state (C_min > B_min > A_min ihlali)
  // her cycle basinda tek seferlik temizlenir.
  const gt = weights.gradeThresholds;
  const bCeil = Math.max(THRESHOLD_FLOORS.B_min, (gt.A_min ?? 12) - 0.25);
  if (gt.B_min != null && gt.B_min > bCeil) {
    changes.push(`[MONOTON] B-sinyal esigi kisildi: ${gt.B_min} → ${bCeil} (A_min=${gt.A_min} altinda kalmali)`);
    gt.B_min = bCeil;
  }
  const cCeil = Math.max(THRESHOLD_FLOORS.C_min, (gt.B_min ?? 12) - 0.25);
  if (gt.C_min != null && gt.C_min > cCeil) {
    changes.push(`[MONOTON] C-sinyal esigi kisildi: ${gt.C_min} → ${cCeil} (B_min=${gt.B_min} altinda kalmali)`);
    gt.C_min = cCeil;
  }

  return changes;
}

/**
 * Adjust indicator weights based on lift scores.
 * High lift → increase weight. Near-zero lift → decrease. Negative lift → heavily decrease.
 */
function adjustIndicatorWeights(weights, indicatorScores) {
  const changes = [];

  for (const [key, score] of Object.entries(indicatorScores)) {
    // Faz 0 Part 2: indikator ogrenmesi icin min 30 ornek esigi (Risk #1).
    // MIN_SAMPLE=20 diger ayarlamalar icin (TF, faulty) korunur.
    if (!score || score.aligned_count < INDICATOR_LEARNING_MIN_SAMPLE) continue;
    if (!score.significant) continue; // Only adjust statistically significant results
    // Pinned disabled indicators — 0 tabanindan sapmasinlar.
    if (DISABLED_INDICATORS.has(key)) {
      if (weights.indicatorWeights[key] !== 0) {
        weights.indicatorWeights[key] = 0;
        changes.push(`${key} agirlik sabitlendi: 0 (DISABLED — canli lift negatif)`);
      }
      continue;
    }

    const currentWeight = weights.indicatorWeights[key];
    if (currentWeight == null) continue;

    let targetWeight = currentWeight;

    if (score.classification === 'load_bearing') {
      targetWeight = clamp(currentWeight * 1.1, 0.3, 2.0); // Boost 10%
    } else if (score.classification === 'useful') {
      targetWeight = clamp(currentWeight * 1.05, 0.3, 2.0); // Small boost
    } else if (score.classification === 'decorative') {
      targetWeight = clamp(currentWeight * 0.9, 0.3, 2.0); // Reduce 10%
    } else if (score.classification === 'counterproductive') {
      targetWeight = clamp(currentWeight * 0.7, 0.3, 2.0); // Significant reduction
    }

    // Apply damping: move only 50% toward target
    const dampedWeight = Math.round((currentWeight + (targetWeight - currentWeight) * 0.5) * 100) / 100;

    // Faz 0 Part 2: rate cap (24h rolling %20). Damping + rate cap birlikte
    // kontrolsuz surukulenmeyi onler — tek cycle'da %10, 24h'te toplam %20.
    const finalWeight = rateCapClip(weights, key, currentWeight, dampedWeight);

    if (Math.abs(finalWeight - currentWeight) >= 0.02) {
      weights.indicatorWeights[key] = finalWeight;
      logWeightChange(weights, key, currentWeight, finalWeight);
      const capNote = finalWeight !== dampedWeight ? ' [RATE-CAPPED]' : '';
      changes.push(`${key} agirlik: ${currentWeight} → ${finalWeight} (lift: ${score.lift}%, sinif: ${score.classification})${capNote}`);
    }
  }

  return changes;
}

/**
 * Adjust timeframe reliability based on per-TF win rates.
 */
function adjustTimeframeReliability(weights, statsByTF) {
  const changes = [];
  const adjustedTfs = new Set(); // ayni dongude faulty handler tarafindan tekrar dusurulmesin

  for (const [tf, stats] of Object.entries(statsByTF)) {
    if (stats.total < MIN_SAMPLE) continue;

    const currentRel = weights.timeframeReliability[tf] || 1.0;
    let targetRel = 1.0;

    if (stats.winRate < 40) targetRel = 0.6;
    else if (stats.winRate < 45) targetRel = 0.75;
    else if (stats.winRate < 50) targetRel = 0.9;
    else if (stats.winRate > 65) targetRel = 1.1;
    else targetRel = 1.0;

    // Damped adjustment
    const dampedRel = Math.round((currentRel + (targetRel - currentRel) * 0.3) * 100) / 100;

    if (Math.abs(dampedRel - currentRel) >= 0.02) {
      weights.timeframeReliability[tf] = dampedRel;
      adjustedTfs.add(String(tf));
      changes.push(`TF ${tf} guvenilirlik: ${currentRel} → ${dampedRel} (WR: %${stats.winRate})`);
    }
  }

  return { changes, adjustedTfs };
}

/**
 * Detect and flag problematic symbols — GERCEK liga (A/B/C) temelli demotion.
 * Sanal (BEKLE) sinyaller burada degerlendirilmez; onlar promotion path'ine gider.
 */
function detectSymbolProblems(weights, statsBySymbolReal, faultyBySymbol = {}, statsBySymbolVirtual = {}) {
  const changes = [];
  const totalResolved = weights.totalResolved || 0;

  // --- Flagged sembol kurtulus yolu (virtual WR bazli) ---
  // Flag konmus sembollerin gercek sinyal uretme yolu kapali; stats.winRate
  // sonsuza dek eski demote-zamani degerinde kalir. Bu sembollerin yeni BEKLE
  // sinyalleri iyi performans gosterirse (regime sift), flag kaldirilir ki
  // tekrar real liga cikabilsin. Kritik: bu kontrol real-based recovery'den
  // ONCE yapilir cunku aksi halde asla dogal yolla temizlenmez.
  for (const [symbol, adj] of Object.entries(weights.symbolAdjustments || {})) {
    if (!adj || adj.gradeShift >= 0) continue;
    const vStats = statsBySymbolVirtual?.[symbol];
    if (!vStats) continue;
    if (vStats.total < FLAG_RECOVERY_MIN_N) continue;
    if (vStats.winRate < FLAG_RECOVERY_MIN_WR) continue;
    if (adj.cooldownUntilCount && adj.cooldownUntilCount > totalResolved) continue;

    delete weights.symbolAdjustments[symbol];
    if (weights.symbolRules?.[symbol]?.autoFlagged) {
      delete weights.symbolRules[symbol];
    }
    // Flag tekrar konarsa histerezis icin isaret birak — otomatik re-flag'leri
    // 20 yeni sinyal boyunca ertele (flapping'i engellemek icin).
    if (!weights.symbolAdjustments[symbol]) {
      weights.symbolAdjustments[symbol] = {
        gradeShift: 0,
        reason: `Flag kaldirildi (virtual WR %${vStats.winRate})`,
        clearedAt: new Date().toISOString(),
        cooldownUntilCount: totalResolved + FLAG_RECOVERY_COOLDOWN,
      };
    }
    changes.push(`${symbol}: FLAG KALDIRILDI (virtual WR %${vStats.winRate}, n=${vStats.total}) → real liga donus`);
  }

  for (const [symbol, stats] of Object.entries(statsBySymbolReal)) {
    if (stats.total < DEMOTION_MIN_N) continue;

    const faultyCount = faultyBySymbol[symbol] || 0;
    const underperforming = stats.winRate < DEMOTION_MAX_WR;
    const tooManyFaulty = faultyCount >= DEMOTION_FAULTY_COUNT;
    if (!underperforming && !tooManyFaulty) {
      // Recovered — eski auto-flag'leri temizle (histerezis gec olsa bile)
      if (weights.symbolRules?.[symbol]?.autoFlagged && stats.winRate > 45) {
        delete weights.symbolRules[symbol];
        changes.push(`${symbol}: otomatik minGrade flag kaldirildi (gercek WR: %${stats.winRate})`);
      }
      if (weights.symbolAdjustments?.[symbol]?.gradeShift < 0 && stats.winRate > 45) {
        delete weights.symbolAdjustments[symbol];
      }
      continue;
    }

    // Histerezis: son demotion/promotion'dan bu yana yeterli yeni sinyal oldu mu?
    const existingAdj = weights.symbolAdjustments?.[symbol];
    if (existingAdj?.cooldownUntilCount > totalResolved) continue;

    const reason = tooManyFaulty
      ? `Hatali trade birikmesi: ${faultyCount} faulty + WR %${stats.winRate} (${stats.total} sinyal)`
      : `Surekli dusuk gercek performans: WR %${stats.winRate} (${stats.total} sinyal)`;

    if (!weights.symbolRules) weights.symbolRules = {};
    weights.symbolRules[symbol] = {
      ...(weights.symbolRules[symbol] || {}),
      minGrade: 'BEKLE',
      autoFlagged: true,
      reason,
      flaggedAt: new Date().toISOString(),
    };
    weights.symbolAdjustments[symbol] = {
      gradeShift: -1,
      reason,
      flaggedAt: new Date().toISOString(),
      cooldownUntilCount: totalResolved + DEMOTION_HYSTERESIS,
    };
    changes.push(`${symbol}: DEMOTION → BEKLE (${reason})`);
  }

  return changes;
}

/**
 * Detect promotions — SANAL (BEKLE) liga tutarli kazanc saglayan semboller.
 * Kosullar: >=30 cozulmus BEKLE, WR>=60, avgRR>=1.0, 30g pencerede ayni.
 * Histerezis: promotion sonrasi 15 yeni sinyal gecmeden re-evaluate yok.
 */
function detectPromotions(weights, statsBySymbolVirtual, allVirtualSignals) {
  const changes = [];
  const totalResolved = weights.totalResolved || 0;
  const now = Date.now();

  for (const [symbol, stats] of Object.entries(statsBySymbolVirtual)) {
    if (!stats || stats.total < PROMOTION_MIN_N) continue;
    if (stats.winRate < PROMOTION_MIN_WR) continue;
    if ((stats.avgRR || 0) < PROMOTION_MIN_RR) continue;

    // 30 gunluk pencere kontrolu
    const recent = allVirtualSignals.filter(s =>
      s.symbol === symbol &&
      s.resolvedAt &&
      (now - new Date(s.resolvedAt).getTime()) <= PROMOTION_WINDOW_MS
    );
    if (recent.length < PROMOTION_MIN_N) continue;

    const recentWins = recent.filter(s => s.win).length;
    const recentWR = Math.round((recentWins / recent.length) * 10000) / 100;
    if (recentWR < PROMOTION_MIN_WR) continue;

    // Histerezis: cooldown kontrol
    const existingAdj = weights.symbolAdjustments?.[symbol];
    if (existingAdj?.cooldownUntilCount > totalResolved) continue;
    // Zaten promoted ise tekrar yazma
    if (existingAdj?.gradeShift > 0) continue;

    const reason = `Otomatik promotion: BEKLE WR %${recentWR} (${recent.length} sinyal, 30g)`;
    weights.symbolAdjustments[symbol] = {
      gradeShift: +1,
      reason,
      promotedAt: new Date().toISOString(),
      cooldownUntilCount: totalResolved + PROMOTION_HYSTERESIS,
    };
    // Eger symbolRules[sym] minGrade=BEKLE ise temizle (yukari cikti)
    if (weights.symbolRules?.[symbol]?.autoFlagged) {
      delete weights.symbolRules[symbol];
    }
    changes.push(`${symbol}: PROMOTION (BEKLE → C) — WR %${recentWR}, n=${recent.length}`);
  }

  return changes;
}

/**
 * Adjust SL multipliers based on SL hit rates per timeframe.
 *
 * Rolling-window adaptif kural (Hafta 2-9 guncellemesi 2026-04-18):
 *   - SL-hit > %65 → carpan +0.25 (max 3.5). Eski ust sinir 2.5 cok dusuktu —
 *     TF30 canli veride %80 SL hit ile 2.5'ta sikismisti. Tavan genisletildi.
 *   - SL-hit < %40 → carpan -0.25 (min 1.0). Gereksiz genis SL'ler kucultulur.
 *   - %40-%65 arasi → dokunma.
 *
 * Hafta 1-5 bug fix: degisim yoksa adjustmentHistory'ye yazilmasin (eskiden
 * "2.5 → 2.5" turunde no-op loglari biriktiriyordu, adjustmentCount sahte
 * sisiyordu).
 */
function adjustSLMultipliers(weights, statsByTF) {
  const changes = [];
  const MAX_MULT = 3.5;
  const MIN_MULT = 1.0;
  const STEP = 0.25;

  for (const [tf, stats] of Object.entries(statsByTF)) {
    if (stats.total < MIN_SAMPLE) continue;

    const currentMult = weights.slMultiplierOverrides[tf] != null
      ? Number(weights.slMultiplierOverrides[tf])
      : null;
    const baseline = currentMult != null ? currentMult : 1.5; // varsayilan

    let target = baseline;
    let reason = null;
    if (stats.slHitRate > 65) {
      target = Math.min(baseline + STEP, MAX_MULT);
      reason = `SL-hit %${stats.slHitRate} > %65 — genislet`;
    } else if (stats.slHitRate < 40) {
      target = Math.max(baseline - STEP, MIN_MULT);
      reason = `SL-hit %${stats.slHitRate} < %40 — daralt`;
    }

    const rounded = Math.round(target * 100) / 100;
    if (currentMult === rounded) continue; // NO-OP: log ETME
    if (currentMult == null && rounded === 1.5) continue; // default'tan default'a no-op
    if (!reason) continue; // esik disinda bir ayarlama yok

    weights.slMultiplierOverrides[tf] = rounded;
    changes.push(`TF ${tf} SL carpani: ${currentMult != null ? currentMult : 'varsayilan'} → ${rounded} (${reason}, n=${stats.total})`);
  }

  return changes;
}

/**
 * Adjust indicator weights based on faulty trade analysis.
 * Faulty trade = SL hit + zit yon sinyali acikken gelmis (reverseAttempts > 0).
 * Bu tip trade'lerde suclu indikatorlerin agirligini azalt.
 *
 * Map: indicatorGuilt key → weight-adjuster indicatorWeights key
 */
const GUILT_TO_WEIGHT_KEY = {
  'khanSaab_STRONG_BULL': 'khanSaab',
  'khanSaab_STRONG_BEAR': 'khanSaab',
  'khanSaab_MILD_BULL': 'khanSaab',
  'khanSaab_MILD_BEAR': 'khanSaab',
  'smc_BOS_bull': 'smc_bos',
  'smc_BOS_bear': 'smc_bos',
  'smc_CHoCH_bull': 'smc_choch',
  'smc_CHoCH_bear': 'smc_choch',
  'cdv_bullish': 'cdv',
  'cdv_bearish': 'cdv',
};

function adjustFromFaultyTrades(weights, faultyStats, totalSignals, statsByTF = {}, skipTfs = new Set()) {
  const changes = [];
  if (!faultyStats || !faultyStats.total || faultyStats.total < FAULTY_MIN_COUNT) {
    return changes;
  }

  const guilt = faultyStats.indicatorGuilt || {};

  // Formation ve divergence gibi dinamik keyleri prefix bazli esle
  for (const [guiltKey, count] of Object.entries(guilt)) {
    if (count < FAULTY_MIN_COUNT) continue;
    const guiltRate = totalSignals > 0 ? count / totalSignals : 0;
    if (guiltRate < FAULTY_GUILT_RATE) continue;

    let weightKey = GUILT_TO_WEIGHT_KEY[guiltKey];
    if (!weightKey) {
      if (guiltKey.startsWith('formation_')) weightKey = 'formation';
      else if (guiltKey.startsWith('divergence_')) weightKey = 'rsi_divergence';
      else if (guiltKey.startsWith('squeeze_')) weightKey = 'squeeze_filter';
      else if (guiltKey.startsWith('khanSaab_vol_')) weightKey = 'volume_confirm';
    }
    if (!weightKey || weights.indicatorWeights[weightKey] == null) continue;

    const current = weights.indicatorWeights[weightKey];
    const reduced = Math.max(
      FAULTY_WEIGHT_FLOOR,
      Math.round(current * FAULTY_REDUCE_PCT * 100) / 100
    );
    if (reduced < current) {
      weights.indicatorWeights[weightKey] = reduced;
      changes.push(
        `[FAULTY] ${weightKey} agirlik: ${current} → ${reduced} (${guiltKey} ${count}/${totalSignals} hatali trade'de suclu, %${Math.round(guiltRate * 10000) / 100})`
      );
    }
  }

  // Grade-bazli: cok sayida A-grade faulty varsa A_min yukselt
  if ((faultyStats.byGrade?.A || 0) >= 5) {
    const currA = weights.gradeThresholds.A_min;
    const newA = clamp(Math.round((currA + 0.25) * 100) / 100, currA, 12.0);
    if (newA > currA) {
      weights.gradeThresholds.A_min = newA;
      changes.push(`[FAULTY] A_min esigi: ${currA} → ${newA} (${faultyStats.byGrade.A} A-grade hatali trade)`);
    }
  }

  // TF-bazli: bir TF digerlerinden *base-rate'e gore* anormal orani hatali ise reliability dusur.
  // Eski mantik yalnizca faulty-ici payi bakiyordu; bu base-rate fallacy yaratiyordu
  // (ornegin TUM sinyallerin %80'i TF 30 ise, faulty'nin %82'sinin TF 30 olmasi anormal
  // degildir). Simdi faulty payi ile toplam sinyal payi karsilastirilir: faulty TF'de
  // en az %50 daha yogunsa (lift >= 1.5) ve o TF henuz bu dongude WR-bazli ayarlanmadiysa
  // reliability dusurulur.
  const tfCounts = Object.entries(faultyStats.byTimeframe || {});
  const faultyTotalTf = tfCounts.reduce((s, [, c]) => s + c, 0);
  // Toplam sinyal sayisi TF dagilimi
  const totalByTf = {};
  let grandTotal = 0;
  for (const [tf, stats] of Object.entries(statsByTF)) {
    const t = Number(stats?.total) || 0;
    totalByTf[tf] = t;
    grandTotal += t;
  }
  if (tfCounts.length > 1 && grandTotal > 0) {
    for (const [tf, count] of tfCounts) {
      if (count < FAULTY_MIN_COUNT) continue;
      if (skipTfs.has(String(tf))) continue; // Bug #1: ayni dongude WR-bazli dusurulduyse tekrar dokunma
      const faultyShare = count / (faultyTotalTf || 1);
      const baseShare = (totalByTf[tf] || 0) / grandTotal;
      if (baseShare <= 0) continue;
      const lift = faultyShare / baseShare; // 1.0 = baseline, 1.5+ = anormal
      if (lift < 1.5) continue;
      const curRel = weights.timeframeReliability[tf] || 1.0;
      const newRel = Math.max(0.5, Math.round((curRel * 0.95) * 100) / 100);
      if (newRel < curRel) {
        weights.timeframeReliability[tf] = newRel;
        changes.push(`[FAULTY] TF ${tf} guvenilirlik: ${curRel} → ${newRel} (faulty payi %${Math.round(faultyShare * 100)}, taban %${Math.round(baseShare * 100)}, lift ${lift.toFixed(2)}x)`);
      }
    }
  }

  return changes;
}

// --- Regime-specific learning ---
// Rejim etiketi signal-tracker tarafindan recordSignal icinde yazilir.
// Her rejim icin yeterli ornek (>=30) biriktiginde, o rejime ozgu indikator
// agirliklari hesaplanir ve weights.byRegime[regime].indicatorWeights altinda
// saklanir. Signal-grader calistiginda pickRegimeWeights ile default agirliklarin
// uzerine bindirilir.
const REGIME_MIN_SAMPLES = 30;
// Faz 0 Part 2: rejim taxonomy ile uyumlu (docs/regime-taxonomy.md).
// Eski etiketler (risk_on/risk_off/range/high_vol) geriye uyumluluk icin
// okunmaya devam eder — byRegime altinda orada kalirlar — ama yeni veri
// bunlara yazilmaz. Yeni taxonomy 6 rejim + market_closed.
const REGIMES_TRACKED = [
  'trending_up', 'trending_down', 'ranging',
  'breakout_pending', 'high_vol_chaos', 'low_vol_drift',
];
// Legacy rejim etiketleri — byRegime'de varsa degistirilmez ama ogrenilmez.
const LEGACY_REGIMES = new Set(['risk_on', 'risk_off', 'range', 'high_vol']);
const INDICATOR_KEY_MAP = {
  khanSaab_score: 'khanSaab',
  smc_bos: 'smc_bos', smc_choch: 'smc_choch', smc_ob: 'smc_ob', smc_fvg: 'smc_fvg',
  formation: 'formation', rsi_divergence: 'rsi_divergence', squeeze_filter: 'squeeze_filter',
  cdv: 'cdv', macro_filter: 'macro_filter', volume_confirm: 'volume_confirm',
};

function adjustRegimeSpecificWeights(weights) {
  const changes = [];
  const all = (readAllArchives() || []).filter(s => s.grade !== 'BEKLE' && s.regime && s.win != null);
  if (all.length === 0) return changes;

  if (!weights.byRegime) weights.byRegime = {};

  for (const regime of REGIMES_TRACKED) {
    const subset = all.filter(s => s.regime === regime);
    if (subset.length < REGIME_MIN_SAMPLES) continue;

    const scores = scoreIndicatorsForSubset(subset);
    if (!weights.byRegime[regime]) weights.byRegime[regime] = { indicatorWeights: {}, slMultiplierOverrides: {} };
    const rw = weights.byRegime[regime].indicatorWeights;

    for (const [scorerKey, score] of Object.entries(scores)) {
      if (!score || score.aligned_count < 20) continue;
      if (!score.significant) continue;
      const weightKey = INDICATOR_KEY_MAP[scorerKey];
      if (!weightKey) continue;

      const baseGlobal = weights.indicatorWeights[weightKey] ?? 1.0;
      const currentRegimeW = rw[weightKey] != null ? rw[weightKey] : baseGlobal;
      let targetMult = 1.0;
      if (score.classification === 'load_bearing') targetMult = 1.15;
      else if (score.classification === 'useful') targetMult = 1.07;
      else if (score.classification === 'decorative') targetMult = 0.92;
      else if (score.classification === 'counterproductive') targetMult = 0.70;
      else continue;

      const targetRegimeW = clamp(baseGlobal * targetMult, 0.3, 2.0);
      const damped = Math.round((currentRegimeW + (targetRegimeW - currentRegimeW) * 0.5) * 100) / 100;

      // Faz 0 Part 2: rate cap per-regime key (rejim + indikator scoped).
      // Log key: "regime:{regime}:{weightKey}" → ayni key'i global ile karistirmaz.
      const scopedKey = `regime:${regime}:${weightKey}`;
      const finalRegimeW = rateCapClip(weights, scopedKey, currentRegimeW, damped);

      if (Math.abs(finalRegimeW - currentRegimeW) >= 0.02) {
        rw[weightKey] = finalRegimeW;
        logWeightChange(weights, scopedKey, currentRegimeW, finalRegimeW);
        const capNote = finalRegimeW !== damped ? ' [RATE-CAPPED]' : '';
        changes.push(`rejim[${regime}] ${weightKey}: ${currentRegimeW} → ${finalRegimeW} (lift: ${score.lift}%, n=${score.aligned_count})${capNote}`);
      }
    }
  }

  return changes;
}

/**
 * Main evaluation and adjustment cycle.
 * Called periodically by the learning loop.
 *
 * Gercek (A/B/C) ve sanal (BEKLE) liga ayri degerlendirilir:
 *   - Threshold/indicator/TF/faulty ayarlari → gercek liga
 *   - Demotion → gercek liga
 *   - Promotion → sanal liga
 */
export function evaluateAndAdjust() {
  const weights = loadWeights();
  const stats = recomputeAllStats();
  const indResult = scoreAllIndicators();
  const indicatorScoresReal = indResult.scores?.real || {};

  // Snapshot BEFORE any adjustments (for checkpoint + pre-commit diff)
  const weightsBefore = JSON.parse(JSON.stringify(weights));

  // Sonraki adim oncesi: acik bekleyen checkpoint'leri degerlendir ve
  // gerekiyorsa otomatik rollback uygula. Rollback uygulandi ise bu dongude
  // yeni ayarlama oynamayiz; weights eski degerlere donmus olur.
  const rollbackResult = evaluatePendingCheckpoints(weights, {
    overall: stats.overall,
    totalResolved: stats.realSignals ?? stats.totalSignals ?? 0,
  });
  if (rollbackResult.rollbacks.length > 0) {
    saveWeights(weights, `OTOMATIK ROLLBACK: ${rollbackResult.rollbacks.map(r => r.label).join(', ')}`);
    return {
      state: 'rolled_back',
      totalResolved: weights.totalResolved,
      message: `Performans dusmesi tespit edildi, ${rollbackResult.rollbacks.length} ayarlama geri alindi`,
      changes: [],
      rollbacks: rollbackResult.rollbacks,
    };
  }

  // YENI SEMA: her dimension { real, virtual } iceriyor
  const byGradeReal = stats.byGrade?.real || {};
  const byTFReal = stats.byTimeframe?.real || {};
  const bySymbolReal = stats.bySymbol?.real || {};
  const bySymbolVirtual = stats.bySymbol?.virtual || {};

  // Gercek sinyal sayisi learning phase'i belirler (BEKLE learning'i kirletmez)
  const totalResolved = stats.realSignals ?? stats.totalSignals ?? 0;
  weights.totalResolved = totalResolved;

  // Phase check: observation → preliminary → active
  if (totalResolved < weights.observationThreshold) {
    weights.learningState = 'observation';
    saveWeights(weights, `Gozlem modu — ${totalResolved}/${weights.observationThreshold} gercek sinyal toplandi`);
    return {
      state: 'observation',
      totalResolved,
      message: `Gozlem modunda: ${totalResolved} gercek sinyal cozuldu, ${weights.observationThreshold} gerekli. Henuz ayarlama yapilmiyor.`,
      changes: [],
    };
  }

  if (totalResolved < 50) {
    weights.learningState = 'preliminary';
  } else {
    weights.learningState = 'active';
  }

  // Faulty trades per-symbol map (demotion icin)
  const faultyBySymbol = {};
  const faultySignalsArr = (readAllArchives() || []).filter(s => s.faultyTrade && s.grade !== 'BEKLE');
  for (const s of faultySignalsArr) {
    faultyBySymbol[s.symbol] = (faultyBySymbol[s.symbol] || 0) + 1;
  }

  // Sanal (virtual) arsiv — promotion penceresi icin gerekli
  const allVirtualArchives = (readAllArchives() || []).filter(s => s.grade === 'BEKLE');

  // Run all adjustments
  const allChanges = [];

  allChanges.push(...adjustGradeThresholds(weights, byGradeReal));
  allChanges.push(...adjustIndicatorWeights(weights, indicatorScoresReal));
  const tfRel = adjustTimeframeReliability(weights, byTFReal);
  allChanges.push(...tfRel.changes);
  // NOTE (2026-04-18): detectSymbolProblems / detectPromotions yollari uc-kademeli
  // ladder (scanner/lib/learning/ladder-engine.js) tarafindan devraliniyor. Cift
  // karar mekanizmasindan kacinmak icin devre disi. symbolAdjustments objesi
  // mevcut verilerle uyumluluk icin duruyor ama yeni demote/promote uretmez.
  // allChanges.push(...detectSymbolProblems(weights, bySymbolReal, faultyBySymbol, bySymbolVirtual));
  // allChanges.push(...detectPromotions(weights, bySymbolVirtual, allVirtualArchives));
  allChanges.push(...adjustSLMultipliers(weights, byTFReal));
  allChanges.push(...adjustRegimeSpecificWeights(weights));
  // Bug #1 fix: ayni dongude WR-bazli reliability dusurulen TF'leri faulty handler'a
  // skipTfs olarak ver → cifte sayim yok. Bug #2 fix: byTFReal ile base-rate karsilastirmasi.
  allChanges.push(...adjustFromFaultyTrades(
    weights, stats.faultyTrades, stats.realSignals || 0, byTFReal, tfRel.adjustedTfs,
  ));

  // Record adjustment
  let preCommitBlocked = null;
  if (allChanges.length > 0) {
    // PRE-COMMIT GATE: grade esik degisikligi cok agresifse veto
    const gate = preCommitCheck(weightsBefore, weights);
    if (!gate.allowed) {
      // Esik degisikliklerini geri al, diger ayarlamalar korunur
      weights.gradeThresholds = weightsBefore.gradeThresholds;
      preCommitBlocked = gate;
      allChanges.push({
        type: 'pre_commit_veto',
        reason: gate.reason,
        result: gate.result,
      });
    }

    weights.adjustmentHistory.push({
      timestamp: new Date().toISOString(),
      phase: weights.learningState,
      totalResolved,
      changes: allChanges,
    });
    if (weights.adjustmentHistory.length > 50) {
      weights.adjustmentHistory = weights.adjustmentHistory.slice(-50);
    }

    // Rollback monitor icin checkpoint olustur
    createCheckpoint(weightsBefore, {
      overall: stats.overall,
      totalResolved,
    }, `${weights.learningState}_${new Date().toISOString().slice(0, 10)}`);

    saveWeights(weights, `${weights.learningState} ayarlama — ${allChanges.length} degisiklik`);
  } else {
    // Hafta 1-5 bug fix: degisim yoksa weight dosyasina yazma. Eski kod her
    // dongude version++ yapip history snapshot uretiyordu — 57 cozulmus sinyal
    // icin 136 version ortaya cikmasinin ana nedeni buydu. Artik yalnizca
    // anlamli bir degisim varsa diske yazilir.
  }

  return {
    state: weights.learningState,
    totalResolved,
    realSignals: stats.realSignals,
    virtualSignals: stats.virtualSignals,
    message: allChanges.length > 0
      ? `${allChanges.length} ayarlama yapildi (${weights.learningState} mod)`
      : 'Ayarlama gerekmedi — parametreler uygun',
    changes: allChanges,
    stats: {
      overall: stats.overall,
      byGrade: stats.byGrade,
    },
  };
}

/**
 * Reset weights to defaults.
 */
export function resetWeights() {
  const weights = { ...DEFAULT_WEIGHTS };
  return saveWeights(weights, 'Manuel sifirlama');
}

/**
 * Get weight adjustment history.
 */
export function getAdjustmentHistory() {
  const weights = loadWeights();
  return weights.adjustmentHistory || [];
}
