/**
 * Shadow Guard — weight adjustment'larin uretime cikmadan once test edilmesi
 * ve sonradan performans degerlendirmesi.
 *
 * Iki katmanli koruma:
 *   1) PRE-COMMIT: grade esik degisikliklerinin arsivde hangi sinyalleri
 *      yeniden siniflandiracagini hesapla; cok agresif ise (>30% yeniden
 *      siniflandirma) degisikligi reddet.
 *   2) POST-COMMIT ROLLBACK: her ayarlama sonrasi bir "checkpoint" olustur;
 *      sonraki N sinyalde (ornegin 30) PF ayarlama oncesine gore anlamli
 *      dusmusse weights'i onceki snapshot'a otomatik geri al.
 *
 * Her iki katman da insan onayi istemez — kendi kendini korur.
 */

import { readJSON, writeJSON, dataPath, readAllArchives } from './persistence.js';

const CHECKPOINTS_PATH = dataPath('weights', 'checkpoints.json');

const ROLLBACK_MIN_SIGNALS = 30;       // ayarlama sonrasi en az 30 cozulmus sinyal
const ROLLBACK_PF_DROP_PCT = 25;       // PF %25+ dustu ise geri al
const ROLLBACK_WR_DROP_PCT = 10;       // veya WR 10 puan+ dustu ise
const PRECOMMIT_MAX_RECLASS_PCT = 30;  // grade esik degisikligi icin max %30 yeniden siniflandirma

/**
 * Grade esik degisikliklerinin arsivde hangi sinyalleri downgrade/upgrade
 * edecegini tahmin et. khanSaab bull/bearScore snapshot'i uzerinden yeniden
 * siniflandirma yapar (tam score hesabi yoktur ama en guclu proxy'dir).
 */
export function simulateThresholdChange(weightsBefore, weightsAfter, archives) {
  const tBefore = weightsBefore.gradeThresholds || {};
  const tAfter = weightsAfter.gradeThresholds || {};

  // A/B/C min skor sinirlari degisti mi?
  const changed =
    tBefore.A_min !== tAfter.A_min ||
    tBefore.B_min !== tAfter.B_min ||
    tBefore.C_min !== tAfter.C_min;
  if (!changed) return { affected: 0, totalScoreable: 0, reclassPct: 0, changed: false };

  let reclassified = 0;
  let totalScoreable = 0;

  for (const sig of archives) {
    const ks = sig.indicators?.khanSaab;
    if (!ks) continue;
    const score = Math.max(ks.bullScore || 0, ks.bearScore || 0); // 0-7 arasi
    if (!Number.isFinite(score) || score <= 0) continue;
    totalScoreable++;

    const gradeBefore = scoreToGrade(score, tBefore);
    const gradeAfter = scoreToGrade(score, tAfter);
    if (gradeBefore !== gradeAfter) reclassified++;
  }

  const reclassPct = totalScoreable > 0 ? (reclassified / totalScoreable) * 100 : 0;
  return {
    affected: reclassified,
    totalScoreable,
    reclassPct: Math.round(reclassPct * 10) / 10,
    changed: true,
  };
}

function scoreToGrade(score, t) {
  if (score >= (t.A_min ?? 7)) return 'A';
  if (score >= (t.B_min ?? 5)) return 'B';
  if (score >= (t.C_min ?? 3)) return 'C';
  return 'BEKLE';
}

/**
 * Pre-commit gate — reject changes that would reclassify too much of the
 * archived signal base.
 */
export function preCommitCheck(weightsBefore, weightsAfter) {
  const archives = readAllArchives();
  const result = simulateThresholdChange(weightsBefore, weightsAfter, archives);
  if (!result.changed) return { allowed: true, reason: 'no threshold change', result };
  if (result.totalScoreable < 20) {
    return { allowed: true, reason: `yetersiz arsiv (${result.totalScoreable}) — veto yok`, result };
  }
  if (result.reclassPct > PRECOMMIT_MAX_RECLASS_PCT) {
    return {
      allowed: false,
      reason: `cok agresif esik degisikligi: %${result.reclassPct} yeniden siniflandirma > %${PRECOMMIT_MAX_RECLASS_PCT}`,
      result,
    };
  }
  return {
    allowed: true,
    reason: `makul esik degisikligi: %${result.reclassPct} yeniden siniflandirma`,
    result,
  };
}

/**
 * Ayarlama oncesi weight snapshot'i + o andaki stats checkpoint olarak kaydet.
 * Sonraki rollback-monitor cagrilari bu noktadan sonraki sinyallerin PF'sini
 * olcer.
 */
export function createCheckpoint(prevWeights, currentStats, label) {
  const all = readJSON(CHECKPOINTS_PATH, { checkpoints: [] });
  all.checkpoints.push({
    createdAt: new Date().toISOString(),
    label: label || 'adjustment',
    prevWeightsSnapshot: {
      gradeThresholds: prevWeights.gradeThresholds,
      indicatorWeights: prevWeights.indicatorWeights,
      slMultiplierOverrides: prevWeights.slMultiplierOverrides || {},
      timeframeReliability: prevWeights.timeframeReliability || {},
    },
    prevStats: {
      totalResolved: currentStats.totalResolved || 0,
      winRate: currentStats.overall?.winRate ?? null,
      profitFactor: currentStats.overall?.profitFactor ?? null,
      expectancy: currentStats.overall?.expectancy ?? null,
    },
    status: 'pending', // pending → confirmed | rolled_back | stale
  });
  // Son 20 checkpoint tutulur — fazlasi arsiv
  if (all.checkpoints.length > 20) {
    all.checkpoints = all.checkpoints.slice(-20);
  }
  writeJSON(CHECKPOINTS_PATH, all);
}

/**
 * Son ayarlamadan sonra N sinyal cozuldu mu ve performans bozuldu mu?
 * Bozulmusa weights'i prevSnapshot'a geri al.
 */
export function evaluatePendingCheckpoints(currentWeights, currentStats) {
  const data = readJSON(CHECKPOINTS_PATH, { checkpoints: [] });
  const archives = readAllArchives();
  const rollbacks = [];
  let changed = false;

  for (const cp of data.checkpoints) {
    if (cp.status !== 'pending') continue;

    const cpTime = new Date(cp.createdAt).getTime();
    const after = archives.filter(s => {
      const t = new Date(s.resolvedAt || s.createdAt).getTime();
      return t >= cpTime && s.grade !== 'BEKLE';
    });

    if (after.length < ROLLBACK_MIN_SIGNALS) continue;

    // Yeterli sinyal var — degerlendir
    const wins = after.filter(s => s.win).length;
    const winRate = (wins / after.length) * 100;
    const withRR = after.filter(s => s.actualRR != null);
    const winRRs = withRR.filter(s => s.win).map(s => s.actualRR);
    const lossRRs = withRR.filter(s => !s.win).map(s => s.actualRR);
    const grossWin = winRRs.reduce((a, b) => a + b, 0);
    const grossLoss = Math.abs(lossRRs.reduce((a, b) => a + b, 0));
    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);

    const prevPF = cp.prevStats.profitFactor ?? 0;
    const prevWR = cp.prevStats.winRate ?? 0;
    const pfDrop = prevPF > 0 ? ((prevPF - pf) / prevPF) * 100 : 0;
    const wrDrop = prevWR - winRate;

    const shouldRollback = (pfDrop > ROLLBACK_PF_DROP_PCT) || (wrDrop > ROLLBACK_WR_DROP_PCT);

    if (shouldRollback) {
      // Weights'i geri al
      Object.assign(currentWeights, {
        gradeThresholds: cp.prevWeightsSnapshot.gradeThresholds,
        indicatorWeights: cp.prevWeightsSnapshot.indicatorWeights,
        slMultiplierOverrides: cp.prevWeightsSnapshot.slMultiplierOverrides,
        timeframeReliability: cp.prevWeightsSnapshot.timeframeReliability,
      });
      cp.status = 'rolled_back';
      cp.rolledBackAt = new Date().toISOString();
      cp.postStats = { n: after.length, winRate, profitFactor: pf };
      rollbacks.push({
        label: cp.label,
        reason: `PF ${prevPF.toFixed(2)} → ${pf.toFixed(2)} (%${pfDrop.toFixed(0)} dusus) / WR ${prevWR.toFixed(0)} → ${winRate.toFixed(0)}`,
        n: after.length,
      });
      changed = true;
    } else {
      cp.status = 'confirmed';
      cp.confirmedAt = new Date().toISOString();
      cp.postStats = { n: after.length, winRate, profitFactor: pf };
      changed = true;
    }
  }

  if (changed) writeJSON(CHECKPOINTS_PATH, data);
  return { rollbacks, evaluatedCount: rollbacks.length };
}

/**
 * Son N gundeki checkpoint durumlarini dondur — dashboard raporlama icin.
 */
export function getCheckpointHistory(limit = 20) {
  const data = readJSON(CHECKPOINTS_PATH, { checkpoints: [] });
  return (data.checkpoints || []).slice(-limit).reverse();
}
