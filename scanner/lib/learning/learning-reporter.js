/**
 * Learning Reporter — generates detailed human-readable reports on demand.
 * Covers: performance, indicator critique, weight changes, and recommendations.
 */

import { getAllCachedStats, recomputeAllStats, computeEWMAWinRate } from './stats-engine.js';
import { scoreAllIndicators, generateIndicatorReport } from './indicator-scorer.js';
import { loadWeights, getAdjustmentHistory } from './weight-adjuster.js';
import { getOpenSignals, validateSignalPriceLevels } from './signal-tracker.js';
import { readAllArchives } from './persistence.js';
import { DEFAULT_VOTE_WEIGHTS } from '../signal-grader.js';
import { getAnomalyState } from './anomaly-detector.js';
import { getCheckpointHistory } from './shadow-guard.js';
import { classifyOutcome } from './ladder-engine.js';

function finiteRR(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function reportActualRR(signal) {
  const cls = classifyOutcome(signal?.status || signal?.outcome);
  if (cls !== 'win' && cls !== 'loss') return null;

  if (signal?.entry != null) {
    const riskSl = signal.slOriginal ?? signal.initialSl ?? signal.originalSl ?? signal.sl;
    const risk = Math.abs(Number(signal.entry) - Number(riskSl));
    if (Number.isFinite(risk) && risk > 0) {
      if (signal.status === 'trailing_stop_exit' && signal.slHitPrice != null) {
        const reward = signal.direction === 'short'
          ? Number(signal.entry) - Number(signal.slHitPrice)
          : Number(signal.slHitPrice) - Number(signal.entry);
        return Math.round((reward / risk) * 100) / 100;
      }
      if (signal.status === 'tp3_hit' && signal.tp3 != null) return Math.round((Math.abs(Number(signal.tp3) - Number(signal.entry)) / risk) * 100) / 100;
      if (signal.status === 'tp2_hit' && signal.tp2 != null) return Math.round((Math.abs(Number(signal.tp2) - Number(signal.entry)) / risk) * 100) / 100;
      if (signal.status === 'tp1_hit' && signal.tp1 != null) return Math.round((Math.abs(Number(signal.tp1) - Number(signal.entry)) / risk) * 100) / 100;
      if (signal.status === 'sl_hit') return -1;
    }
  }

  return finiteRR(signal?.actualRR);
}

function validationSignalForReport(signal) {
  if (!signal || typeof signal !== 'object') return signal;
  const sl = signal.slOriginal ?? signal.initialSl ?? signal.originalSl ?? signal.sl;
  return { ...signal, sl };
}

function reportOutcomeClass(signal) {
  const raw = classifyOutcome(signal?.status || signal?.outcome);
  if (raw !== 'win' && raw !== 'loss') return 'neutral';
  if (validateSignalPriceLevels(validationSignalForReport(signal))) return 'neutral';

  const rr = reportActualRR(signal);
  if (rr == null || rr === 0) return 'neutral';
  return rr > 0 ? 'win' : 'loss';
}

export function summarizeResolvedSignalsForReport(signals) {
  const summary = {
    total: Array.isArray(signals) ? signals.length : 0,
    wins: 0,
    losses: 0,
    neutrals: 0,
    totalPnlR: 0,
    winRate: null,
    bySymbol: {},
  };

  for (const s of signals || []) {
    const symbol = s.symbol || 'UNKNOWN';
    if (!summary.bySymbol[symbol]) {
      summary.bySymbol[symbol] = { wins: 0, losses: 0, neutrals: 0, pnlR: 0 };
    }
    const bucket = summary.bySymbol[symbol];
    const cls = reportOutcomeClass(s);
    const rr = reportActualRR(s);

    if (cls === 'win') {
      summary.wins++;
      bucket.wins++;
    } else if (cls === 'loss') {
      summary.losses++;
      bucket.losses++;
    } else {
      summary.neutrals++;
      bucket.neutrals++;
    }

    if ((cls === 'win' || cls === 'loss') && rr != null) {
      summary.totalPnlR += rr;
      bucket.pnlR += rr;
    }
  }

  const realized = summary.wins + summary.losses;
  summary.winRate = realized > 0 ? Math.round(summary.wins / realized * 100) : null;
  return summary;
}

/**
 * Full comprehensive report.
 */
export function generateFullReport() {
  const stats = recomputeAllStats();
  const weights = loadWeights();
  const { scores: indicatorScoresAll, ranking } = scoreAllIndicators();
  const indicatorScores = indicatorScoresAll?.real || {};
  const openSignals = getOpenSignals();
  const allResolved = readAllArchives();
  const history = getAdjustmentHistory();

  // Yeni iki-katmanli sema: her dimension { real, virtual, lastUpdated }
  const overallReal = stats.overall?.real || {};
  const overallVirtual = stats.overall?.virtual || {};
  const byGradeReal = stats.byGrade?.real || {};
  const byGradeVirtual = stats.byGrade?.virtual || {};
  const byTFReal = stats.byTimeframe?.real || {};
  const byCategoryReal = stats.byCategory?.real || {};

  const lines = [];

  // Header
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push('║         OTONOM OGRENME RAPORU — TV SCANNER                  ║');
  lines.push(`║         ${new Date().toLocaleString('tr-TR')}                ║`);
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  // System state
  lines.push(`Ogrenme Durumu: ${weights.learningState.toUpperCase()}`);
  lines.push(`Agirlik Versiyonu: v${weights.version}`);
  lines.push(`Toplam Cozulmus: ${stats.totalSignals} (Gercek: ${stats.realSignals} | Sanal: ${stats.virtualSignals})`);
  lines.push(`Acik Sinyal: ${openSignals.length}`);
  lines.push('');

  // === SECTION 1: Overall Performance (Gercek Liga) ===
  lines.push('═══ 1. GENEL PERFORMANS — GERCEK LIGA (A/B/C) ═══');
  const ov = overallReal;
  if (ov.total > 0) {
    lines.push(`Toplam: ${ov.total} sinyal | Kazanc: ${ov.wins} | Kayip: ${ov.losses}`);
    lines.push(`Kazanma Orani: %${ov.winRate}`);
    lines.push(`EWMA Kazanma Orani: %${ov.ewmaWinRate} (son sinyallere agirlik verilmis)`);
    lines.push(`Ortalama R:R: ${ov.avgRR} | Ort. Kazanc RR: ${ov.avgWinRR} | Ort. Kayip RR: ${ov.avgLossRR}`);
    lines.push(`Beklenti (Expectancy): ${ov.expectancy}`);
    lines.push(`Kar Faktoru (Profit Factor): ${ov.profitFactor}`);
    lines.push(`TP1 Hit: %${ov.tp1HitRate} | TP2 Hit: %${ov.tp2HitRate} | TP3 Hit: %${ov.tp3HitRate} | SL Hit: %${ov.slHitRate}`);
    lines.push(`Ort. Tutma Suresi: ${ov.avgHoldingMinutes} dakika`);
    lines.push(`Son Trend: ${ov.recentTrend}`);
  } else {
    lines.push('Henuz cozulmus gercek (A/B/C) sinyal yok.');
  }
  lines.push('');

  // Sanal liga (BEKLE) ozet bilgisi — promotion adaylari takibi icin
  lines.push('--- SANAL LIGA (BEKLE) — Referans ---');
  const ovV = overallVirtual;
  if (ovV.total > 0) {
    lines.push(`Toplam: ${ovV.total} | WR: %${ovV.winRate} | PF: ${ovV.profitFactor} | Ort RR: ${ovV.avgRR}`);
    lines.push('(Sanal sinyaller gercek performansi kirletmez; sadece promotion kararlari icin kullanilir.)');
  } else {
    lines.push('Henuz cozulmus BEKLE sinyali yok.');
  }
  lines.push('');

  // === SECTION 2: Grade Performance ===
  lines.push('═══ 2. SINYAL KALITESI PERFORMANSI (GERCEK) ═══');
  for (const [grade, gradeStats] of Object.entries(byGradeReal)) {
    if (!gradeStats || gradeStats.total === 0) continue;
    const target = { A: 65, B: 55, C: 45 }[grade] || 50;
    const status = gradeStats.winRate >= target ? 'BASARILI' : gradeStats.winRate >= target - 10 ? 'KABUL EDILEBILIR' : 'DUSUK';
    lines.push(`${grade}-SINYAL: ${gradeStats.total} sinyal | WR: %${gradeStats.winRate} (hedef: %${target}) → ${status}`);
    lines.push(`  PF: ${gradeStats.profitFactor} | Beklenti: ${gradeStats.expectancy} | Trend: ${gradeStats.recentTrend}`);
  }
  const bekleStats = byGradeVirtual.BEKLE;
  if (bekleStats && bekleStats.total > 0) {
    lines.push(`BEKLE (sanal): ${bekleStats.total} sinyal | WR: %${bekleStats.winRate} | PF: ${bekleStats.profitFactor} | Trend: ${bekleStats.recentTrend}`);
  }
  lines.push('');

  // === SECTION 3: Timeframe Analysis (Gercek) ===
  lines.push('═══ 3. ZAMAN DILIMI ANALIZI (GERCEK) ═══');
  const tfEntries = Object.entries(byTFReal).sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));
  for (const [tf, tfStats] of tfEntries) {
    if (!tfStats || tfStats.total < 3) continue;
    const reliability = weights.timeframeReliability[tf] || 1.0;
    const relLabel = reliability >= 1.0 ? '' : ` [GUVENILIRLIK: ${reliability}]`;
    lines.push(`TF ${tf}: ${tfStats.total} sinyal | WR: %${tfStats.winRate} | PF: ${tfStats.profitFactor}${relLabel}`);
  }
  lines.push('');

  // === SECTION 4: Category Analysis (Gercek) ===
  lines.push('═══ 4. KATEGORI ANALIZI (GERCEK) ═══');
  for (const [cat, catStats] of Object.entries(byCategoryReal)) {
    if (!catStats || catStats.total < 3) continue;
    lines.push(`${cat.toUpperCase()}: ${catStats.total} sinyal | WR: %${catStats.winRate} | PF: ${catStats.profitFactor} | Trend: ${catStats.recentTrend}`);
  }
  lines.push('');

  // === SECTION 5: Indicator Critique ===
  lines.push('═══ 5. INDIKATOR ELESTIRISEL DEGERLENDIRMESI ═══');
  lines.push(generateIndicatorReport());
  lines.push('');

  // === SECTION 6: Current Weights ===
  lines.push('═══ 6. MEVCUT OGRENILMIS PARAMETRELER ═══');
  lines.push('Grade Esikleri:');
  for (const [key, val] of Object.entries(weights.gradeThresholds)) {
    const def = {
      A_min: 7, A_minAgreement: 70,
      B_min: 5, B_minAgreement: 60,
      C_min: 3, C_minAgreement: 50,
      BEKLE_min: 1.5, minRR: 2.0,
    }[key];
    const changed = val !== def ? ` (varsayilan: ${def})` : '';
    lines.push(`  ${key}: ${val}${changed}`);
  }
  lines.push('');
  // 2026-05-02 — additive_v1: Effective = max(0, Base + Δ); indicatorDisabled[key]=true → Effective=0.
  lines.push('Indikator Agirliklari (Base + Δ = Effective):');
  lines.push(`  ${'Kaynak'.padEnd(20)} | ${'Base'.padStart(5)} | ${'Δ'.padStart(6)} | ${'Eff'.padStart(5)} | Not`);
  lines.push(`  ${'─'.repeat(20)} | ${'─'.repeat(5)} | ${'─'.repeat(6)} | ${'─'.repeat(5)} | ${'─'.repeat(20)}`);
  const allKeys = new Set([
    ...Object.keys(DEFAULT_VOTE_WEIGHTS || {}),
    ...Object.keys(weights.indicatorWeights || {}),
    ...Object.keys(weights.indicatorDisabled || {}),
  ]);
  const disabledMap = weights.indicatorDisabled || {};
  for (const key of allKeys) {
    const base = DEFAULT_VOTE_WEIGHTS?.[key] ?? 1.0;
    const isDisabled = disabledMap[key] === true;
    const delta = weights.indicatorWeights?.[key];
    const deltaNum = (typeof delta === 'number') ? delta : 0;
    const effective = isDisabled ? 0 : Math.max(0, base + deltaNum);
    const dStr = (deltaNum >= 0 ? '+' : '') + deltaNum.toFixed(2);
    let note = '';
    if (isDisabled) note = '← DISABLED';
    else if (deltaNum !== 0) note = (deltaNum > 0 ? '↑ ogrendi (basarili)' : '↓ ogrendi (basarisiz)');
    lines.push(`  ${key.padEnd(20)} | ${base.toFixed(2).padStart(5)} | ${dStr.padStart(6)} | ${effective.toFixed(2).padStart(5)} | ${note}`);
  }
  lines.push('');

  if (Object.keys(weights.symbolAdjustments).length > 0) {
    lines.push('Sembol Uyarilari:');
    for (const [sym, adj] of Object.entries(weights.symbolAdjustments)) {
      lines.push(`  ${sym}: Grade ${adj.gradeShift > 0 ? '+' : ''}${adj.gradeShift} — ${adj.reason}`);
    }
    lines.push('');
  }

  if (Object.keys(weights.slMultiplierOverrides).length > 0) {
    lines.push('SL Carpan Ayarlamalari:');
    for (const [tf, mult] of Object.entries(weights.slMultiplierOverrides)) {
      lines.push(`  TF ${tf}: ${mult}x`);
    }
    lines.push('');
  }

  // === SECTION 7: Adjustment History ===
  lines.push('═══ 7. SON AYARLAMA GECMISI ═══');
  const recentHistory = history.slice(-5);
  if (recentHistory.length === 0) {
    lines.push('Henuz ayarlama yapilmadi.');
  } else {
    for (const entry of recentHistory) {
      lines.push(`[${entry.timestamp}] Faz: ${entry.phase} | Cozulmus: ${entry.totalResolved}`);
      for (const change of entry.changes) {
        lines.push(`  → ${change}`);
      }
    }
  }
  lines.push('');

  // === SECTION 8: Recommendations ===
  lines.push('═══ 8. ONERILER ═══');
  const recommendations = generateRecommendations(stats, indicatorScores, weights);
  if (recommendations.length === 0) {
    lines.push('Henuz yeterli veri yok. En az 30 cozulmus sinyal sonrasi oneriler olusturulacak.');
  } else {
    recommendations.forEach((r, i) => lines.push(`${i + 1}. ${r}`));
  }
  lines.push('');

  // === SECTION 9: Open Signals Status ===
  if (openSignals.length > 0) {
    lines.push('═══ 9. ACIK SINYALLER ═══');
    for (const sig of openSignals.slice(0, 20)) {
      const hitMarkers = [];
      if (sig.tp1Hit) hitMarkers.push('TP1✓');
      if (sig.tp2Hit) hitMarkers.push('TP2✓');
      if (sig.tp3Hit) hitMarkers.push('TP3✓');
      if (sig.slHit) hitMarkers.push('SL✗');
      const hitStr = hitMarkers.length > 0 ? hitMarkers.join(' ') : 'beklemede';
      lines.push(`${sig.symbol} ${sig.grade}-${sig.direction?.toUpperCase()} | Entry: ${sig.entry} | Son: ${sig.lastCheckedPrice || '?'} | ${hitStr} | ${sig.checkCount}x`);
      lines.push(`  SL: ${sig.sl || '?'} | TP1: ${sig.tp1 || '?'} | TP2: ${sig.tp2 || '?'} | TP3: ${sig.tp3 || '?'}`);
    }
    if (openSignals.length > 20) lines.push(`  ... ve ${openSignals.length - 20} sinyal daha`);
  }

  return lines.join('\n');
}

/**
 * Generate actionable recommendations based on data.
 * Gercek (A/B/C) liga temelli — sanal (BEKLE) sinyaller oneri icin kullanilmaz.
 */
function generateRecommendations(stats, indicatorScores, weights) {
  const recs = [];
  const realSignals = stats.realSignals ?? 0;

  if (realSignals < 30) return recs;

  const byGradeReal = stats.byGrade?.real || {};
  const byTFReal = stats.byTimeframe?.real || {};
  const overallReal = stats.overall?.real || {};

  // Grade-based recommendations
  if (byGradeReal.A && byGradeReal.A.winRate < 55 && byGradeReal.A.total >= 20) {
    const aMin = weights.gradeThresholds.A_min;
    recs.push(`A-sinyal kazanma orani dusuk (%${byGradeReal.A.winRate}). A-sinyal kanaat esigini yukseltmeyi deneyin. Mevcut A_min: ${aMin}, oneri: ${(aMin + 0.5).toFixed(2)}`);
  }
  if (byGradeReal.C && byGradeReal.C.winRate < 35 && byGradeReal.C.total >= 20) {
    recs.push(`C-sinyaller cok dusuk performans gosteriyor (%${byGradeReal.C.winRate}). C-sinyalleri tamamen devre disi birakmaya deneyin.`);
  }

  // Indicator-based recommendations (real liga scores)
  for (const [key, score] of Object.entries(indicatorScores || {})) {
    if (!score) continue;
    if (score.classification === 'counterproductive' && score.aligned_count >= 20) {
      recs.push(`${key} indikatoru sinyal kalitesini dusuruyor (lift: ${score.lift}%). Kaldirmayi veya ters mantikla kullanmayi deneyin.`);
    }
    if (score.classification === 'decorative' && score.aligned_count >= 30) {
      recs.push(`${key} indikatoru neredeyse hicbir fark yaratmiyor (lift: ${score.lift}%). Hesaplama yukunu azaltmak icin kaldirilabilir.`);
    }
  }

  // Timeframe-based recommendations
  for (const [tf, tfStats] of Object.entries(byTFReal)) {
    if (tfStats && tfStats.total >= 20 && tfStats.winRate < 40) {
      recs.push(`TF ${tf} cok dusuk performans (%${tfStats.winRate}). Bu zaman dilimini taramalardan cikarmayi deneyin.`);
    }
  }

  // SL optimization
  if (overallReal.slHitRate > 55 && overallReal.total >= 30) {
    recs.push(`SL cok sik tetikleniyor (%${overallReal.slHitRate}). Genel SL carpanini 0.2 artirmayi deneyin.`);
  }
  if (overallReal.tp3HitRate < 10 && overallReal.tp1HitRate > 60 && overallReal.total >= 30) {
    recs.push(`TP1 sik tetikleniyor (%${overallReal.tp1HitRate}) ama TP3 neredeyse hic tetiklenmiyor (%${overallReal.tp3HitRate}). TP1'de daha fazla kapatma (%50), TP3 hedefini dusurme deneyin.`);
  }

  // Macro filter effectiveness
  const macro = indicatorScores?.macro_filter;
  if (macro && macro.lift < 0 && macro.aligned_count >= 20) {
    recs.push(`Makro filtre sinyal kalitesine katki saglamiyor. Filtre kurallarini gozden gecirin.`);
  }

  return recs;
}

/**
 * Generate a report of changes made by the learning system in the last N hours.
 * Shows: what changed, why, actual vs intended impact on win rate / ROI / drawdown.
 * Also shows the natural selection status of each pair.
 */
export function generate24hChangesReport(hours = 24) {
  const weights = loadWeights();
  const stats = recomputeAllStats();
  const allResolved = readAllArchives();
  const openSignals = getOpenSignals();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const lines = [];
  lines.push('╔══════════════════════════════════════════════════════════════╗');
  lines.push(`║   OTONOM OGRENME — SON ${hours} SAAT DEGISIKLIKLER               ║`);
  lines.push(`║   ${new Date().toLocaleString('tr-TR')}                                ║`);
  lines.push('╚══════════════════════════════════════════════════════════════╝');
  lines.push('');

  // --- Section 1: Weight adjustments in the last 24h ---
  const recentAdjustments = (weights.adjustmentHistory || []).filter(
    a => new Date(a.timestamp) >= cutoff
  );

  lines.push('═══ 1. SON ' + hours + ' SAATTE YAPILAN AYARLAMALAR ═══');
  if (recentAdjustments.length === 0) {
    lines.push('Bu donemde otomatik ayarlama yapilmadi.');
  } else {
    lines.push(`${recentAdjustments.length} ayarlama dongusu calistirildi:`);
    lines.push('');
    for (const adj of recentAdjustments) {
      lines.push(`[${new Date(adj.timestamp).toLocaleString('tr-TR')}] Faz: ${adj.phase} | Cozulmus: ${adj.totalResolved}`);
      for (const change of adj.changes) {
        lines.push(`  → ${change}`);
      }
      lines.push('');
    }
  }

  // --- Section 2: Signals resolved in the last 24h ---
  const recentResolved = allResolved.filter(s => {
    const resolvedAt = s.resolvedAt || s.slHitAt || s.tp1HitAt;
    return resolvedAt && new Date(resolvedAt) >= cutoff;
  });

  lines.push('═══ 2. SON ' + hours + ' SAATTE COZULEN SINYALLER ═══');
  if (recentResolved.length === 0) {
    lines.push('Bu donemde cozulen sinyal yok.');
  } else {
    const resolvedSummary = summarizeResolvedSignalsForReport(recentResolved);
    const realized = resolvedSummary.wins + resolvedSummary.losses;
    const wrText = resolvedSummary.winRate == null ? 'n/a' : `%${resolvedSummary.winRate}`;

    lines.push(`Toplam: ${resolvedSummary.total} | Realized: ${realized} | Kazanc: ${resolvedSummary.wins} | Kayip: ${resolvedSummary.losses} | Neutral/Missed: ${resolvedSummary.neutrals} | WR: ${wrText}`);
    lines.push(`Gerceklesen PnL (R cinsinden): ${resolvedSummary.totalPnlR >= 0 ? '+' : ''}${resolvedSummary.totalPnlR.toFixed(1)}R`);
    lines.push('');

    // Breakdown by symbol
    for (const [sym, data] of Object.entries(resolvedSummary.bySymbol)) {
      const total = data.wins + data.losses;
      const symWR = total > 0 ? `%${Math.round(data.wins / total * 100)}` : 'n/a';
      lines.push(`  ${sym}: ${data.wins}W/${data.losses}L/${data.neutrals}N (WR: ${symWR}) | Realized PnL: ${data.pnlR >= 0 ? '+' : ''}${data.pnlR.toFixed(1)}R`);
    }
  }
  lines.push('');

  // --- Section 3: Actual vs Intended Impact (Gercek Liga) ---
  lines.push('═══ 3. AKTUEL vs AMACLANAN ETKI (GERCEK) ═══');

  const ov = stats.overall?.real || {};
  const totalResolved = ov.total || 0;

  if (totalResolved >= 10) {
    // Split into "before adjustments" vs "after adjustments" by looking at recent vs old
    const lastAdjTime = recentAdjustments.length > 0 ? new Date(recentAdjustments[0].timestamp) : null;

    lines.push('Metrik            | Aktuel   | Hedef    | Durum');
    lines.push('─────────────────────────────────────────────────');
    lines.push(`Win Rate          | %${ov.winRate || 0}     | %55+     | ${(ov.winRate || 0) >= 55 ? 'BASARILI' : 'GELISTIRILIYOR'}`);
    lines.push(`Profit Factor     | ${ov.profitFactor || 0}     | 1.5+     | ${(ov.profitFactor || 0) >= 1.5 ? 'BASARILI' : 'GELISTIRILIYOR'}`);
    lines.push(`Beklenti          | ${ov.expectancy || 0}     | 0.3+     | ${(ov.expectancy || 0) >= 0.3 ? 'BASARILI' : 'GELISTIRILIYOR'}`);
    lines.push(`SL Hit Orani      | %${ov.slHitRate || 0}     | <%45     | ${(ov.slHitRate || 0) < 45 ? 'BASARILI' : 'GELISTIRILIYOR'}`);
    lines.push(`TP1 Hit Orani     | %${ov.tp1HitRate || 0}     | %60+     | ${(ov.tp1HitRate || 0) >= 60 ? 'BASARILI' : 'GELISTIRILIYOR'}`);
    lines.push(`Ort. R:R          | ${ov.avgRR || 0}     | 1.5+     | ${(ov.avgRR || 0) >= 1.5 ? 'BASARILI' : 'GELISTIRILIYOR'}`);

    if (ov.recentTrend) {
      const trendLabel = { improving: 'YUKSELIS', declining: 'DUSUS', stable: 'STABIL' }[ov.recentTrend] || ov.recentTrend;
      lines.push(`Son Trend         | ${trendLabel}`);
    }
  } else {
    lines.push(`Yeterli veri yok (${totalResolved}/10 sinyal cozuldu). En az 10 cozulmus sinyal gerekli.`);
  }
  lines.push('');

  // --- Section 4: Natural Selection — Pair Fitness (Gercek Liga) ---
  lines.push('═══ 4. DOGAL SELEKSIYON — PAIR UYGUNLUGU (GERCEK) ═══');
  lines.push('Guclu pair\'ler siklastirilir, zayif pair\'ler azaltilir/cikarilir.');
  lines.push('');

  const bySymbol = stats.bySymbol?.real || {};
  const bySymbolVirtual = stats.bySymbol?.virtual || {};
  // Bug #3 fix: hic degerlendirme icin min 10 sinyal (eski 3 cok dusuktu — 3 sinyalde
  // "CIKART — sistem disi" yanltici). Altindakiler listelenir ama "Yetersiz veri" etiketi alir.
  const FITNESS_MIN_N = 10;
  const symbolEntries = Object.entries(bySymbol)
    .filter(([, s]) => s && s.total >= 3)
    .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));

  if (symbolEntries.length === 0) {
    lines.push('Henuz yeterli sembol verisi yok.');
  } else {
    lines.push('Sembol       | Sinyal | WR    | PF    | Trend    | Durum');
    lines.push('─────────────────────────────────────────────────────────');

    for (const [sym, symStats] of symbolEntries) {
      const wr = symStats.winRate || 0;
      const pf = symStats.profitFactor || 0;
      let status;
      if (symStats.total < FITNESS_MIN_N) {
        // Bug #3 fix: 3-9 sinyalde karar verme
        status = `Yetersiz veri (${symStats.total}/${FITNESS_MIN_N})`;
      } else if (wr >= 60 && pf >= 1.5) {
        status = 'GUCLU — trade siklastir';
      } else if (wr >= 50 && pf >= 1.0) {
        status = 'NORMAL — devam';
      } else if (pf >= 1.5) {
        // Bug #4 fix: yuksek PF + orta WR klasik trend-follow profili, ZAYIF/CIKART sayma
        status = `KARISIK — yuksek PF/dusuk WR (PF ${pf})`;
      } else if (wr >= 40) {
        status = 'ZAYIF — trade azalt';
      } else {
        status = 'CIKART — sistem disi';
      }

      const adj = weights.symbolAdjustments?.[sym];
      if (adj) status += ` [Grade ${adj.gradeShift > 0 ? '+' : ''}${adj.gradeShift}]`;

      const rawTrend = symStats.recentTrend;
      const trend = (!rawTrend || rawTrend === 'insufficient_data') ? '—' : rawTrend;
      lines.push(`${sym.padEnd(12)} | ${String(symStats.total).padEnd(6)} | %${String(symStats.winRate).padEnd(4)} | ${String(symStats.profitFactor).padEnd(5)} | ${trend.padEnd(9)} | ${status}`);
    }
  }
  lines.push('');

  // Sanal liga promotion adaylari (BEKLE'de tutarli kazanc)
  const virtualCandidates = Object.entries(bySymbolVirtual)
    .filter(([, s]) => s && s.total >= 10 && s.winRate >= 55)
    .sort((a, b) => (b[1].winRate || 0) - (a[1].winRate || 0));
  if (virtualCandidates.length > 0) {
    lines.push('--- SANAL LIGA PROMOTION ADAYLARI (BEKLE WR >= %55, n >= 10) ---');
    for (const [sym, s] of virtualCandidates.slice(0, 10)) {
      const promoted = weights.symbolAdjustments?.[sym]?.gradeShift > 0 ? ' [PROMOTED]' : '';
      lines.push(`  ${sym.padEnd(12)} | ${String(s.total).padEnd(5)} | WR: %${s.winRate} | PF: ${s.profitFactor}${promoted}`);
    }
    lines.push('');
  }

  // --- Section 5: Current Learning State ---
  lines.push('═══ 5. OGRENME DURUMU ═══');
  lines.push(`Faz: ${weights.learningState.toUpperCase()}`);
  lines.push(`Agirlik Versiyonu: v${weights.version}`);
  lines.push(`Toplam Cozulmus: ${weights.totalResolved}`);
  lines.push(`Acik Sinyal: ${openSignals.length}`);

  if (recentAdjustments.length > 0) {
    const totalChanges = recentAdjustments.reduce((s, a) => s + a.changes.length, 0);
    lines.push(`Son ${hours}h degisiklik: ${totalChanges} parametre ayarlandi`);
  }

  return lines.join('\n');
}

/**
 * Quick summary report (shorter, for dashboard).
 * Gercek liga (A/B/C) metrikleri birincil; sanal (BEKLE) yanda gosterilir.
 */
export function generateQuickSummary() {
  const weights = loadWeights();
  const stats = getAllCachedStats();
  const open = getOpenSignals();

  const overallReal = stats.overall?.real || {};
  const overallVirtual = stats.overall?.virtual || {};

  // Real liga acik sinyal sayisi (BEKLE hariç)
  const realOpen = open.filter(s => s.grade !== 'BEKLE').length;
  const virtualOpen = open.filter(s => s.grade === 'BEKLE').length;

  return {
    learningState: weights.learningState,
    weightVersion: weights.version,
    totalResolved: overallReal.total || 0,
    realResolved: overallReal.total || 0,
    virtualResolved: overallVirtual.total || 0,
    openSignals: open.length,
    realOpen,
    virtualOpen,
    winRate: overallReal.winRate || 0,
    ewmaWinRate: overallReal.ewmaWinRate || 0,
    profitFactor: overallReal.profitFactor || 0,
    expectancy: overallReal.expectancy || 0,
    recentTrend: overallReal.recentTrend || 'insufficient_data',
    virtual: {
      winRate: overallVirtual.winRate || 0,
      profitFactor: overallVirtual.profitFactor || 0,
      total: overallVirtual.total || 0,
    },
    topIndicator: null, // Will be filled from ranking
    worstIndicator: null,
    lastAdjustment: weights.updatedAt,
    adjustmentCount: weights.adjustmentHistory?.length || 0,
  };
}

/**
 * Gunluk/haftalik "digest" — dashboard'da gorunur, ne ogrenildi+ne degisti+ne
 * uyari var ozeti. Insan mudahalesi olmadan sistemin kendisini anlatmasi icin.
 *
 * windowHours: 24 (gunluk digest) veya 168 (haftalik)
 */
export function generateDigest(windowHours = 24) {
  const weights = loadWeights();
  const stats = getAllCachedStats();
  const anomaly = getAnomalyState();
  const checkpoints = getCheckpointHistory(10);
  const archives = readAllArchives();
  const cutoff = Date.now() - windowHours * 3600000;

  const recentResolved = archives.filter(s => {
    const t = new Date(s.resolvedAt || s.createdAt).getTime();
    return t >= cutoff && s.grade !== 'BEKLE';
  });
  const wins = recentResolved.filter(s => s.win).length;
  const wrRecent = recentResolved.length > 0 ? (wins / recentResolved.length) * 100 : null;

  const recentAdjustments = (weights.adjustmentHistory || []).filter(h => {
    const t = new Date(h.timestamp).getTime();
    return t >= cutoff;
  });

  const rollbacks = checkpoints.filter(cp => {
    const t = new Date(cp.rolledBackAt || cp.createdAt).getTime();
    return cp.status === 'rolled_back' && t >= cutoff;
  });

  // En cok degisen indikator agirligi
  const weightChangeCounts = {};
  for (const adj of recentAdjustments) {
    for (const c of (adj.changes || [])) {
      const label = typeof c === 'string' ? c.split(':')[0] : c.type || 'other';
      weightChangeCounts[label] = (weightChangeCounts[label] || 0) + 1;
    }
  }
  const topChanges = Object.entries(weightChangeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));

  const overallReal = stats.overall?.real || {};

  return {
    windowHours,
    generatedAt: new Date().toISOString(),
    mode: anomaly.mode,
    modeSince: anomaly.since,
    modeTriggers: anomaly.triggeredBy,
    overallWR: overallReal.winRate ?? null,
    overallPF: overallReal.profitFactor ?? null,
    recentWR: wrRecent != null ? Math.round(wrRecent * 10) / 10 : null,
    recentResolvedCount: recentResolved.length,
    adjustmentsCount: recentAdjustments.length,
    rollbacksCount: rollbacks.length,
    rollbacks: rollbacks.map(r => ({
      label: r.label,
      at: r.rolledBackAt,
      postStats: r.postStats,
    })),
    topChanges,
    learningState: weights.learningState,
    weightVersion: weights.version,
    highlights: buildHighlights({
      mode: anomaly.mode,
      wrRecent,
      recentCount: recentResolved.length,
      rollbacksCount: rollbacks.length,
      adjCount: recentAdjustments.length,
    }),
  };
}

function buildHighlights({ mode, wrRecent, recentCount, rollbacksCount, adjCount }) {
  const out = [];
  if (mode === 'degraded') {
    out.push({ level: 'critical', msg: 'Sistem DEGRADED modda — yeni poz acilmiyor, grade\'ler 1 kademe dusuruldu' });
  }
  if (rollbacksCount > 0) {
    out.push({ level: 'warn', msg: `${rollbacksCount} agirlik degisikligi otomatik geri alindi (performans dustu)` });
  }
  if (adjCount === 0 && recentCount > 20) {
    out.push({ level: 'info', msg: 'Son donemde otonom ayarlama gerekmedi — parametreler stabil' });
  }
  if (wrRecent != null && recentCount >= 10) {
    if (wrRecent >= 60) out.push({ level: 'good', msg: `Son donem WR %${wrRecent.toFixed(0)} — guclu` });
    else if (wrRecent < 35) out.push({ level: 'warn', msg: `Son donem WR %${wrRecent.toFixed(0)} — dikkat` });
  }
  if (out.length === 0) out.push({ level: 'info', msg: 'Sistem stabil — kaydedilecek onemli bir olay yok' });
  return out;
}
