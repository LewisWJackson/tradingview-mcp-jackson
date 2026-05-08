/**
 * Anomaly Detector — sistem performansinda ani bozulmayi tespit et ve
 * gerekiyorsa "degraded mode" aktive et.
 *
 * Degraded mode kurallari:
 *   - Tum uretilen sinyallerin grade'i 1 kademe dusurulur (scanner tarafinda
 *     okunup uygulanir).
 *   - Bot okx-executor yeni pozisyon ACMAZ — yalniz mevcut pozisyonlar yonetilir.
 *   - Dashboard'da gorunur alarm gosterilir.
 *
 * Tetikleyiciler:
 *   1) Son 30 sinyalin WR degerinin, 200-sinyal tarihi ortalamasindan 2-sigma
 *      asagida olmasi.
 *   2) Son 7 gunluk PF < 1.0 (kayipta).
 *   3) Son 10 sinyalde 7+ SL hit (guclu negatif dizi).
 *
 * Cikis kosullari (auto-recovery):
 *   - Son 20 sinyalde WR >= 200-sinyal tarihi ortalamasi.
 *   - VEYA manuel override ile "clear" edilir.
 */

import { readJSON, writeJSON, dataPath, readAllArchives } from './persistence.js';
import { classifyOutcome } from './ladder-engine.js';

const STATE_PATH = dataPath('anomaly-state.json');

const DEGRADE_WINDOW = 30;       // son 30 sinyal
const BASELINE_WINDOW = 200;     // tarihi ortalama icin
const Z_THRESHOLD = 2.0;         // 2-sigma
const RECENT_DAYS_PF_CHECK = 7;  // son 7 gun PF
const MIN_PF_THRESHOLD = 1.0;
const LOSS_STREAK_WINDOW = 10;
const LOSS_STREAK_MAX_WINS = 3;  // 10 sinyalde <=3 win → negatif dizi
const RECOVERY_WINDOW = 20;
const MIN_SIGNALS_FOR_DETECTION = 50;
// Virtual-alpha-inversion: BEKLE (reddedilen) sinyallerin WR'si Real ligadan
// bu kadar puan yukseginde VE orneklem yeterliyse grading anti-selektif demek.
const VIRTUAL_ALPHA_INVERSION_THRESHOLD = 5;  // BEKLE WR >= Real WR + 5
const VIRTUAL_ALPHA_MIN_REAL_N = 30;
const VIRTUAL_ALPHA_MIN_VIRTUAL_N = 30;

function loadState() {
  return readJSON(STATE_PATH, {
    mode: 'normal',         // 'normal' | 'degraded'
    since: null,
    triggeredBy: null,
    lastCheck: null,
    history: [],
  });
}

function saveState(state) {
  writeJSON(STATE_PATH, state);
}

function computeWR(signals) {
  if (!signals.length) return null;
  const wins = signals.filter(s => s.win).length;
  return (wins / signals.length) * 100;
}

function computePF(signals) {
  const withRR = signals.filter(s => s.actualRR != null);
  if (!withRR.length) return null;
  const winRRs = withRR.filter(s => s.win).map(s => s.actualRR);
  const lossRRs = withRR.filter(s => !s.win).map(s => s.actualRR);
  const grossWin = winRRs.reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(lossRRs.reduce((a, b) => a + b, 0));
  return grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
}

/**
 * Anomali degerlendirmesi — tetikleyicileri kontrol et, state'i guncelle.
 * Returns: { mode, transitioned, triggers, details }
 */
export function evaluateAnomaly() {
  const state = loadState();
  // 2026-05-04: NEUTRAL kapanislari (entry_missed_tp, entry_expired, sl_hit_high_mfe,
  // manual_close, vb.) win/loss istatistiklerinden hariç tut. Bunlar “entry hic
  // dolmadan kaçti” veya “SL koyuldu ama yon dogruydu” gibi notr durumlar; loss
  // streak veya WR baseline hesabinda sayilmamali.
  const allResolved = readAllArchives().filter(s => s.win != null);
  const isWinLoss = (s) => {
    const cls = classifyOutcome(s.status || s.outcome);
    return cls === 'win' || cls === 'loss';
  };
  const archives = allResolved
    .filter(s => s.grade !== 'BEKLE' && isWinLoss(s))
    .sort((a, b) => new Date(a.resolvedAt) - new Date(b.resolvedAt));
  const virtualArchives = allResolved
    .filter(s => s.grade === 'BEKLE' && isWinLoss(s))
    .sort((a, b) => new Date(a.resolvedAt) - new Date(b.resolvedAt));

  state.lastCheck = new Date().toISOString();

  if (archives.length < MIN_SIGNALS_FOR_DETECTION) {
    saveState(state);
    return { mode: state.mode, transitioned: false, reason: 'yetersiz arsiv' };
  }

  const triggers = [];

  // Trigger 1: WR 2-sigma asagida mi?
  const recent = archives.slice(-DEGRADE_WINDOW);
  const baseline = archives.slice(-BASELINE_WINDOW, -DEGRADE_WINDOW);
  if (recent.length >= DEGRADE_WINDOW && baseline.length >= 50) {
    const baseWR = computeWR(baseline);
    const recentWR = computeWR(recent);
    if (baseWR != null && recentWR != null && baseWR > 0 && baseWR < 100) {
      const p = baseWR / 100;
      const se = Math.sqrt((p * (1 - p)) / recent.length);
      const observed = recentWR / 100;
      const z = se > 0 ? (observed - p) / se : 0;
      if (z < -Z_THRESHOLD) {
        triggers.push({
          type: 'wr_drop_2sigma',
          baseWR: Math.round(baseWR * 10) / 10,
          recentWR: Math.round(recentWR * 10) / 10,
          z: Math.round(z * 100) / 100,
        });
      }
    }
  }

  // Trigger 2: son 7 gun PF < 1.0
  const sevenDaysAgo = Date.now() - RECENT_DAYS_PF_CHECK * 86400000;
  const weekSignals = archives.filter(s => new Date(s.resolvedAt).getTime() >= sevenDaysAgo);
  if (weekSignals.length >= 20) {
    const pf = computePF(weekSignals);
    if (pf != null && pf < MIN_PF_THRESHOLD) {
      triggers.push({
        type: 'weekly_pf_below_1',
        pf: Math.round(pf * 100) / 100,
        n: weekSignals.length,
      });
    }
  }

  // Trigger 4: virtual-alpha-inversion — BEKLE (rejected) ligasi Real ligayi
  // tutarli sekilde dovuyor mu? Eger evetse grading filtremiz kazananlari reddediyor
  // kaybedenleri geciriyor demek. Manual/anomaly incelemesi zorunlu.
  if (archives.length >= VIRTUAL_ALPHA_MIN_REAL_N && virtualArchives.length >= VIRTUAL_ALPHA_MIN_VIRTUAL_N) {
    const realSample = archives.slice(-Math.min(100, archives.length));
    const virtualSample = virtualArchives.slice(-Math.min(100, virtualArchives.length));
    const realWR = computeWR(realSample);
    const virtualWR = computeWR(virtualSample);
    if (realWR != null && virtualWR != null && virtualWR - realWR >= VIRTUAL_ALPHA_INVERSION_THRESHOLD) {
      triggers.push({
        type: 'virtual_alpha_inversion',
        realWR: Math.round(realWR * 10) / 10,
        virtualWR: Math.round(virtualWR * 10) / 10,
        gap: Math.round((virtualWR - realWR) * 10) / 10,
        realN: realSample.length,
        virtualN: virtualSample.length,
      });
    }
  }

  // Trigger 3: son N sinyalde agir SL dizisi
  const lossStreak = archives.slice(-LOSS_STREAK_WINDOW);
  if (lossStreak.length === LOSS_STREAK_WINDOW) {
    const wins = lossStreak.filter(s => s.win).length;
    if (wins <= LOSS_STREAK_MAX_WINS) {
      triggers.push({
        type: 'loss_streak',
        windowSize: LOSS_STREAK_WINDOW,
        wins,
      });
    }
  }

  const previousMode = state.mode;

  // Mod gecisi — 2026-04-27'ye kadar askida.
  // Yeni strateji/oylama matematigi sonrasi sistemin 1 hafta boyunca kendi
  // dengesini bulmasi icin otomatik degraded'e GECMEYIZ; tetikleyicileri
  // "muted" olarak kaydederiz, operator gorunurlugu icin. Recovery ve manuel
  // clear normal calisir. Tarih gecince blok kalkar.
  const DEGRADED_ENTRY_DISABLED_UNTIL = Date.UTC(2026, 3, 27); // 2026-04-27
  const entryBlocked = Date.now() < DEGRADED_ENTRY_DISABLED_UNTIL;

  if (triggers.length > 0 && state.mode === 'normal' && !entryBlocked) {
    state.mode = 'degraded';
    state.since = new Date().toISOString();
    state.triggeredBy = triggers;
    state.history.push({
      at: state.since,
      event: 'entered_degraded',
      triggers,
    });
  } else if (triggers.length > 0 && state.mode === 'normal' && entryBlocked) {
    state.history.push({
      at: new Date().toISOString(),
      event: 'muted_trigger',
      triggers,
      note: 'auto-degraded askida (2026-04-27 oncesi)',
    });
  } else if (state.mode === 'degraded') {
    // Recovery check
    const recoveryRecent = archives.slice(-RECOVERY_WINDOW);
    const recoveryBaseline = archives.slice(-BASELINE_WINDOW);
    if (recoveryRecent.length === RECOVERY_WINDOW && recoveryBaseline.length >= 100) {
      const recWR = computeWR(recoveryRecent);
      const baseWR = computeWR(recoveryBaseline);
      if (recWR != null && baseWR != null && recWR >= baseWR && triggers.length === 0) {
        state.mode = 'normal';
        state.triggeredBy = null;
        state.history.push({
          at: new Date().toISOString(),
          event: 'recovered',
          recWR: Math.round(recWR * 10) / 10,
          baseWR: Math.round(baseWR * 10) / 10,
        });
      }
    }
  }

  // history sinirli tut
  if (state.history.length > 100) state.history = state.history.slice(-100);

  saveState(state);
  return {
    mode: state.mode,
    transitioned: previousMode !== state.mode,
    triggers,
    since: state.since,
  };
}

/**
 * Scanner / okx-executor bu fonksiyonu cagirarak "su an degraded mi?" sorusuna
 * cevap alir ve davranisini buna gore ayarlar.
 */
export function isDegradedMode() {
  const state = loadState();
  return state.mode === 'degraded';
}

export function getAnomalyState() {
  return loadState();
}

/**
 * Manuel override — olaganustu durumlarda operator state'i resetler.
 */
export function clearAnomalyState(reason = 'manual_clear') {
  const state = loadState();
  state.mode = 'normal';
  state.triggeredBy = null;
  state.history.push({
    at: new Date().toISOString(),
    event: 'manual_clear',
    reason,
  });
  saveState(state);
}
