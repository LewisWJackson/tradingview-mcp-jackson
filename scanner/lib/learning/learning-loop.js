/**
 * Learning Loop — background orchestrator.
 * Runs continuously while MacBook is online:
 *   - Outcome check: every 5 minutes
 *   - Stats recomputation: after each resolution
 *   - Weight adjustment: daily or every 10 resolutions
 */

import { checkAllOpenSignals } from './outcome-checker.js';
import { recomputeAllStats } from './stats-engine.js';
import { evaluateAndAdjust, loadWeights } from './weight-adjuster.js';
import { getOpenSignals } from './signal-tracker.js';
import { scoreAllIndicators, generateIndicatorReport } from './indicator-scorer.js';
import { ensureDataDirs, readJSON, writeJSON, dataPath } from './persistence.js';
import { isScanActive } from '../scanner-engine.js';
import { evaluateAnomaly, getAnomalyState, isDegradedMode } from './anomaly-detector.js';
import { onTransition as onLadderTransition } from './ladder-engine.js';

const OUTCOME_CHECK_INTERVAL = 5 * 60 * 1000;   // 5 minutes
const WEIGHT_ADJUST_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const RESOLUTION_THRESHOLD = 20; // Adjustment icin min resolved orneklem (Hafta 3-15: 10 -> 20)
// Hafta 3-15: Ardisik adjustment'lar arasi minimum bekleme. Continuous learning
// yerine batch window — ayni rejim icinde tekrar tekrar tune etmenin volatiliteyi
// arttirmasini engeller. 48 saatte en fazla bir agirlik degisikligi.
const MIN_ADJUST_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 saat

let outcomeTimer = null;
let weightTimer = null;
let running = false;
let resolutionsSinceLastAdjust = 0;
let lastAdjustmentTime = null;
let scanInProgressFn = null; // Function to check if scanner is busy
let broadcastFn = null; // Function to broadcast WS events

// Stats
let loopStats = {
  startedAt: null,
  outcomeChecks: 0,
  signalsResolved: 0,
  weightAdjustments: 0,
  lastOutcomeCheck: null,
  lastWeightAdjust: null,
  errors: 0,
};

/**
 * Set external integration functions.
 */
export function setIntegration({ isScanInProgress, broadcast }) {
  scanInProgressFn = isScanInProgress;
  broadcastFn = broadcast;
}

function broadcast(data) {
  if (broadcastFn) broadcastFn(data);
}

function isScannerBusy() {
  return scanInProgressFn ? scanInProgressFn() : false;
}

/**
 * Run outcome check cycle.
 * Skips if scanner is busy (shares CDP connection).
 * Uses BOTH the external scanInProgress check AND the global chart mutex.
 */
async function runOutcomeCheck() {
  // Quick pre-check: if scanner is clearly busy, skip immediately without waiting for lock
  if (isScannerBusy() || isScanActive()) {
    console.log('[Learning] Outcome check atlanıyor — chart mesgul');
    return;
  }

  try {
    const openCount = getOpenSignals().length;
    if (openCount === 0) return;

    // checkAllOpenSignals now acquires the chart lock internally (with 30s timeout)
    // If it can't get the lock, it returns { skipped: true }
    const result = await checkAllOpenSignals();
    if (result.skipped) return;
    loopStats.outcomeChecks++;
    loopStats.lastOutcomeCheck = new Date().toISOString();

    if (result.resolved > 0) {
      loopStats.signalsResolved += result.resolved;
      resolutionsSinceLastAdjust += result.resolved;

      // Broadcast resolution events
      for (const sig of (result.resolvedSignals || [])) {
        broadcast({
          type: 'signal_resolved',
          signal: {
            id: sig.id,
            symbol: sig.symbol,
            grade: sig.grade,
            direction: sig.direction,
            outcome: sig.outcome,
            actualRR: sig.actualRR,
            win: sig.win,
          },
        });
      }

      // Recompute stats after resolutions
      recomputeAllStats();

      // Her cozumleme dalgasindan sonra anomali dedektoru calistir —
      // WR coktu mu, PF negatife kaydi mi, kaybi dizisi var mi? Mod degisirse
      // dashboard'a WS eventi yolla.
      try {
        const anomalyResult = evaluateAnomaly();
        if (anomalyResult.transitioned) {
          broadcast({
            type: 'anomaly_mode_changed',
            data: {
              mode: anomalyResult.mode,
              triggers: anomalyResult.triggers,
              since: anomalyResult.since,
            },
          });
          console.log(`[Learning] ANOMALI MOD GECISI: ${anomalyResult.mode} — ${anomalyResult.triggers?.map(t => t.type).join(', ') || 'recovered'}`);
        }
      } catch (e) {
        console.error('[Learning] Anomali degerlendirmesi hatasi:', e.message);
      }

      // Trigger weight adjustment if threshold reached AND cooldown elapsed.
      // Hafta 3-15: ek cooldown; ayni rejim icinde ayarlamalar zincirlenmesin.
      const cooldownOk = !lastAdjustmentTime || (Date.now() - lastAdjustmentTime >= MIN_ADJUST_COOLDOWN_MS);
      if (resolutionsSinceLastAdjust >= RESOLUTION_THRESHOLD && cooldownOk) {
        await runWeightAdjustment();
      }
    }

    broadcast({
      type: 'learning_status',
      data: {
        openSignals: openCount - result.resolved,
        checked: result.checked,
        resolved: result.resolved,
        errors: result.errors,
      },
    });
  } catch (e) {
    loopStats.errors++;
    console.error('[Learning] Outcome check hatasi:', e.message);
  }
}

/**
 * Run weight adjustment cycle.
 */
async function runWeightAdjustment() {
  try {
    const result = evaluateAndAdjust();
    loopStats.weightAdjustments++;
    loopStats.lastWeightAdjust = new Date().toISOString();
    lastAdjustmentTime = Date.now();
    resolutionsSinceLastAdjust = 0;

    broadcast({
      type: 'weights_updated',
      data: {
        state: result.state,
        changes: result.changes,
        message: result.message,
        totalResolved: result.totalResolved,
      },
    });

    if (result.changes.length > 0) {
      console.log(`[Learning] Agirlik ayarlamasi: ${result.changes.length} degisiklik`);
      result.changes.forEach(c => {
        if (typeof c === 'string') console.log(`  - ${c}`);
        else if (c?.type === 'pre_commit_veto') console.log(`  - VETO: ${c.reason}`);
        else console.log(`  -`, c);
      });
    }
  } catch (e) {
    loopStats.errors++;
    console.error('[Learning] Weight adjustment hatasi:', e.message);
  }
}

// ─── Ladder transition → learning hook ──────────────────────────────────────
// Her promotion/demotion event'i:
//   1) ladder-quality.json'da sembol+grade kalite istatistigini gunceller
//   2) WS ile frontend'e yayilir (anlik lig tablosu guncellemesi icin)
//   3) Agirlik ayarlamasinin erken tetiklenmesi icin counter artar
const LADDER_QUALITY_PATH = dataPath('ladder-quality.json');

function recordLadderQuality(event) {
  try {
    const data = readJSON(LADDER_QUALITY_PATH, { updatedAt: null, bySymbol: {} });
    const key = event.symbol;
    if (!data.bySymbol[key]) data.bySymbol[key] = {};
    const gradeKey = event.grade;
    if (!data.bySymbol[key][gradeKey]) {
      data.bySymbol[key][gradeKey] = { promotions: 0, demotions: 0, history: [] };
    }
    const rec = data.bySymbol[key][gradeKey];
    if (event.kind === 'promote') rec.promotions++;
    else if (event.kind === 'demote') rec.demotions++;
    rec.history.push({
      at: event.at,
      kind: event.kind,
      from: event.from,
      to: event.to,
      streak: event.streak,
      windowWR: event.windowWR,
      triggeredBy: event.triggeredBy,
    });
    if (rec.history.length > 50) rec.history = rec.history.slice(-50);
    rec.lastKind = event.kind;
    rec.lastAt = event.at;
    // Kalite skoru: promotion - demotion (zaman agirlikli, son olay = tam agirlik)
    rec.qualityScore = rec.promotions - rec.demotions;
    data.updatedAt = new Date().toISOString();
    writeJSON(LADDER_QUALITY_PATH, data);
  } catch (e) {
    console.log(`[Learning] Ladder quality kayit hatasi: ${e.message}`);
  }
}

function handleLadderTransition(event) {
  console.log(`[Ladder] ${event.symbol} ${event.grade}: ${event.from} → ${event.to} (${event.kind}, seri=${event.streak}, WR=${event.windowWR}%)`);

  // 1) Persist learning-facing kalite istatistigi
  recordLadderQuality(event);

  // 2) WS broadcast — frontend anlik guncellensin
  broadcast({
    type: 'ladder_transition',
    event,
    ts: Date.now(),
  });

  // 3) Weight ayarlamayi tetiklemek icin cozumleme sayacina katki — demotion'lar
  //    sinyal kalitesinin bozuldugunun en guclu gostergesi, erken adjust tetiklenebilir.
  if (event.kind === 'demote') {
    resolutionsSinceLastAdjust += 1;
  }
}

let unsubscribeLadder = null;

/**
 * Start the learning loop.
 */
export function startLearningLoop() {
  if (running) return;

  ensureDataDirs();
  running = true;
  loopStats.startedAt = new Date().toISOString();
  lastAdjustmentTime = Date.now();

  // Ladder transition listener — learning integration
  if (!unsubscribeLadder) {
    unsubscribeLadder = onLadderTransition(handleLadderTransition);
  }

  console.log('[Learning] Otonom ogrenme dongusu baslatildi');
  console.log('[Learning] Outcome check: her 5 dakika | Weight adjust: gunluk veya 20 cozum + 6sa cooldown sonrasi');
  console.log('[Learning] Ladder transition hook aktif — promotion/demotion event\'leri kalite verisine isleniyor');

  // Outcome check every 5 minutes
  outcomeTimer = setInterval(runOutcomeCheck, OUTCOME_CHECK_INTERVAL);

  // Weight adjustment daily
  weightTimer = setInterval(() => {
    if (Date.now() - lastAdjustmentTime >= WEIGHT_ADJUST_INTERVAL) {
      runWeightAdjustment();
    }
  }, 60 * 60 * 1000); // Check hourly if daily adjust is due

  // Run initial check after 30 seconds (give scanner time to settle)
  setTimeout(runOutcomeCheck, 30000);
}

/**
 * Stop the learning loop.
 */
export function stopLearningLoop() {
  if (!running) return;

  running = false;
  if (outcomeTimer) { clearInterval(outcomeTimer); outcomeTimer = null; }
  if (weightTimer) { clearInterval(weightTimer); weightTimer = null; }
  if (unsubscribeLadder) { unsubscribeLadder(); unsubscribeLadder = null; }

  console.log('[Learning] Otonom ogrenme dongusu durduruldu');
}

/**
 * Get learning loop status.
 */
export function getLearningStatus() {
  const weights = loadWeights();
  const openSignals = getOpenSignals();
  const anomaly = getAnomalyState();

  return {
    running,
    learningState: weights.learningState,
    totalResolved: weights.totalResolved,
    observationProgress: weights.totalResolved < weights.observationThreshold
      ? `${weights.totalResolved}/${weights.observationThreshold}`
      : 'Tamamlandi',
    openSignals: openSignals.length,
    resolutionsSinceLastAdjust,
    weightVersion: weights.version,
    anomaly: {
      mode: anomaly.mode,
      since: anomaly.since,
      triggers: anomaly.triggeredBy,
    },
    degraded: anomaly.mode === 'degraded',
    ...loopStats,
  };
}

/**
 * Get comprehensive learning summary for reporting.
 */
export function getLearningSummary() {
  const weights = loadWeights();
  const openSignals = getOpenSignals();
  const { scores: indicatorScores, ranking } = scoreAllIndicators();
  const indicatorReport = generateIndicatorReport();

  return {
    status: getLearningStatus(),
    weights: {
      version: weights.version,
      learningState: weights.learningState,
      gradeThresholds: weights.gradeThresholds,
      indicatorWeights: weights.indicatorWeights,
      timeframeReliability: weights.timeframeReliability,
      symbolAdjustments: weights.symbolAdjustments,
      slMultiplierOverrides: weights.slMultiplierOverrides,
    },
    indicatorRanking: ranking,
    indicatorReport,
    adjustmentHistory: weights.adjustmentHistory?.slice(-10) || [],
    openSignals: openSignals.map(s => ({
      id: s.id,
      symbol: s.symbol,
      grade: s.grade,
      direction: s.direction,
      entry: s.entry,
      status: s.status,
      tp1Hit: s.tp1Hit,
      tp2Hit: s.tp2Hit,
      checkCount: s.checkCount,
      createdAt: s.createdAt,
    })),
  };
}

/**
 * Force a manual weight adjustment cycle (for testing/reporting).
 */
export function forceAdjustment() {
  return evaluateAndAdjust();
}

/**
 * Force a manual outcome check.
 */
export async function forceOutcomeCheck() {
  return checkAllOpenSignals();
}
