/**
 * Indicator Scorer — evaluates each indicator's predictive contribution.
 * Uses lift metric: win rate when aligned vs when absent.
 * Implements critical thinking about indicator reliability.
 */

import { readAllArchives, readJSON, writeJSON, dataPath } from './persistence.js';
import { computeZScore } from './stats-engine.js';

const INDICATORS_PATH = dataPath('stats', 'by-indicator.json');

/**
 * Classify how a specific indicator related to the trade outcome.
 * Returns 'aligned' | 'opposed' | 'neutral' | 'absent'
 */
function classifyIndicator(signal, indicatorKey) {
  const ind = signal.indicators;
  if (!ind) return 'absent';
  const dir = signal.direction;

  switch (indicatorKey) {
    case 'khanSaab_score': {
      const ks = ind.khanSaab;
      if (!ks) return 'absent';

      // Priority 1: If signalStatus is BUY or SELL (not WAIT), use directly
      if (ks.signalStatus === 'BUY') return dir === 'long' ? 'aligned' : 'opposed';
      if (ks.signalStatus === 'SELL') return dir === 'short' ? 'aligned' : 'opposed';

      // Priority 2: Use bias field (the actual directional indicator in practice)
      if (!ks.bias) return 'absent';
      const bias = ks.bias.toUpperCase();
      const score = bias.includes('BULL') ? (ks.bullScore || 0) : (ks.bearScore || 0);
      const isStrong = bias.startsWith('STRONG');
      const biasDir = bias.includes('BULL') ? 'long' : bias.includes('BEAR') ? 'short' : null;
      if (!biasDir) return 'neutral';

      // MILD bias with low score = unreliable
      if (!isStrong && score < 60) return 'neutral';

      // Strong or high-score aligned = true alignment
      if (biasDir === dir && score >= 60) return 'aligned';

      // Strong opposing bias = true opposition
      if (biasDir !== dir && isStrong) return 'opposed';

      return 'neutral';
    }
    case 'smc_bos': {
      const smc = ind.smc;
      if (!smc || !smc.lastBOS) return 'absent';
      const bosDir = smc.lastBOS.direction === 'bullish' ? 'long' : 'short';
      return bosDir === dir ? 'aligned' : 'opposed';
    }
    case 'smc_choch': {
      const smc = ind.smc;
      if (!smc || !smc.lastCHoCH) return 'absent';
      const chochDir = smc.lastCHoCH.direction === 'bullish' ? 'long' : 'short';
      return chochDir === dir ? 'aligned' : 'opposed';
    }
    case 'smc_ob': {
      const smc = ind.smc;
      if (!smc) return 'absent';
      return smc.hasOB ? 'aligned' : 'absent';
    }
    case 'smc_fvg': {
      const smc = ind.smc;
      if (!smc) return 'absent';
      return smc.hasFVG ? 'aligned' : 'absent';
    }
    case 'formation': {
      const f = ind.formation;
      if (!f || !f.direction) return 'absent';
      const fDir = f.direction === 'bullish' ? 'long' : 'short';
      return fDir === dir ? 'aligned' : 'opposed';
    }
    case 'rsi_divergence': {
      const d = ind.divergence;
      // calculators.detectRSIDivergence `type` alanini uretir (direction degil).
      // Snapshot her ikisini de kopyalar — ikisinden birini de kabul et.
      const divRaw = d?.direction || d?.type;
      if (!divRaw) return 'absent';
      const divDir = String(divRaw).toLowerCase().includes('bull') ? 'long' : 'short';
      return divDir === dir ? 'aligned' : 'opposed';
    }
    case 'squeeze_filter': {
      const sq = ind.squeeze;
      if (!sq) return 'absent';
      if (sq.status === 'squeeze') return 'opposed'; // squeeze = don't trade
      return 'aligned'; // normal/high vol = trade ortami uygun
    }
    case 'cdv': {
      const cdv = ind.cdv;
      if (!cdv || !cdv.direction) return 'absent';
      // calculators.analyzeCDV 'BUY'/'SELL'/'STRONG_BUY'/'STRONG_SELL'/'NEUTRAL'
      // dondurebilir; tum varyantlari dogru siniflandir.
      const raw = String(cdv.direction).toUpperCase();
      if (raw === 'NEUTRAL' || raw === 'MIXED') return 'neutral';
      const cdvDir = raw.includes('BUY') ? 'long' : raw.includes('SELL') ? 'short' : null;
      if (!cdvDir) return 'absent';
      return cdvDir === dir ? 'aligned' : 'opposed';
    }
    case 'macro_filter': {
      const mf = ind.macroFilter;
      if (!mf) return 'absent';
      return mf.downgrade ? 'opposed' : 'aligned';
    }
    case 'volume_confirm': {
      // If candles show volume confirmation in trade direction
      const cdv = ind.cdv;
      if (!cdv) return 'absent';
      return cdv.buyRatio > 55 && dir === 'long' ? 'aligned'
        : cdv.buyRatio < 45 && dir === 'short' ? 'aligned'
        : 'neutral';
    }
    case 'mtf_confirmation': {
      const mtf = ind.mtfConfirmation;
      if (!mtf || mtf.direction === 'mixed') return 'absent';
      return mtf.direction === dir ? 'aligned' : 'opposed';
    }
    default:
      return 'absent';
  }
}

/**
 * Score a single indicator across all resolved signals.
 */
function scoreIndicator(indicatorKey, signals) {
  const aligned = [];
  const opposed = [];
  const neutral = [];
  const absent = [];

  for (const sig of signals) {
    const classification = classifyIndicator(sig, indicatorKey);
    switch (classification) {
      case 'aligned': aligned.push(sig); break;
      case 'opposed': opposed.push(sig); break;
      case 'neutral': neutral.push(sig); break;
      case 'absent': absent.push(sig); break;
    }
  }

  const alignedWinRate = aligned.length > 0 ? aligned.filter(s => s.win).length / aligned.length : null;
  const opposedWinRate = opposed.length > 0 ? opposed.filter(s => s.win).length / opposed.length : null;
  const baselineWinRate = [...neutral, ...absent].length > 0
    ? [...neutral, ...absent].filter(s => s.win).length / [...neutral, ...absent].length
    : signals.filter(s => s.win).length / (signals.length || 1);

  // Lift: how much better is the win rate when this indicator aligns?
  const lift = alignedWinRate != null ? Math.round((alignedWinRate - baselineWinRate) * 10000) / 100 : 0;

  // Contrarian lift: how much worse when this indicator opposes?
  const contrarianLift = opposedWinRate != null ? Math.round((opposedWinRate - baselineWinRate) * 10000) / 100 : 0;

  // Statistical significance — 12+ indikator test edilir, Bonferroni duzeltmesi
  // icin alfa=0.05/12 → tek-kuyruk kritik z~2.64. Daha muhafazakar bir esik
  // kullanmadan "significant" damgasi false-positive uretiyordu.
  const zScore = aligned.length >= 5
    ? computeZScore(alignedWinRate, baselineWinRate, aligned.length)
    : 0;
  const significant = Math.abs(zScore) > 2.64 && aligned.length >= 30;

  // Contribution score: normalized 0-1
  const contributionScore = alignedWinRate != null ? Math.round(alignedWinRate * 100) / 100 : 0;

  // Classification
  let classification = 'insufficient_data';
  if (aligned.length >= 20) {
    if (lift > 15 && significant) classification = 'load_bearing';       // Strong positive contributor
    else if (lift > 5) classification = 'useful';                        // Moderate contributor
    else if (lift > -5) classification = 'decorative';                   // Near-zero impact
    else classification = 'counterproductive';                            // Negative impact
  } else if (aligned.length >= 10) {
    classification = 'preliminary';
  }

  return {
    indicatorKey,
    total_signals: signals.length,
    aligned_count: aligned.length,
    opposed_count: opposed.length,
    neutral_count: neutral.length,
    absent_count: absent.length,
    aligned_win_rate: alignedWinRate != null ? Math.round(alignedWinRate * 10000) / 100 : null,
    opposed_win_rate: opposedWinRate != null ? Math.round(opposedWinRate * 10000) / 100 : null,
    baseline_win_rate: Math.round(baselineWinRate * 10000) / 100,
    contribution_score: contributionScore,
    lift,
    contrarian_lift: contrarianLift,
    z_score: zScore,
    significant,
    classification,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Score all indicators and rank them.
 * Gercek (A/B/C) ve sanal (BEKLE) sinyalleri ayri havuzlarda skorlar —
 * sanal liga promotion kararlari, gercek liga indikator agirlik ayari icin kullanilir.
 */
export function scoreAllIndicators() {
  const all = readAllArchives();
  const emptyResult = { scores: { real: {}, virtual: {} }, ranking: { real: [], virtual: [] }, totalSignals: 0 };
  if (all.length === 0) {
    writeJSON(INDICATORS_PATH, emptyResult.scores);
    return emptyResult;
  }

  const real = all.filter(s => s.grade !== 'BEKLE');
  const virtual = all.filter(s => s.grade === 'BEKLE');

  const indicatorKeys = [
    'khanSaab_score', 'smc_bos', 'smc_choch', 'smc_ob', 'smc_fvg',
    'formation', 'rsi_divergence', 'squeeze_filter', 'cdv',
    'macro_filter', 'volume_confirm', 'mtf_confirmation',
  ];

  const scoreSet = (signals) => {
    const out = {};
    for (const key of indicatorKeys) out[key] = scoreIndicator(key, signals);
    return out;
  };

  const scores = {
    real: scoreSet(real),
    virtual: scoreSet(virtual),
  };

  const rankSet = (scoreObj) =>
    Object.values(scoreObj)
      .filter(s => s.aligned_count >= 5)
      .sort((a, b) => b.lift - a.lift)
      .map(s => ({
        indicator: s.indicatorKey,
        lift: s.lift,
        classification: s.classification,
        alignedWR: s.aligned_win_rate,
        n: s.aligned_count,
      }));

  const ranking = {
    real: rankSet(scores.real),
    virtual: rankSet(scores.virtual),
  };

  // Persist
  writeJSON(INDICATORS_PATH, scores);

  return { scores, ranking, totalSignals: all.length, realSignals: real.length, virtualSignals: virtual.length };
}

/**
 * Score indicators over a pre-filtered subset (e.g. by regime/category).
 * Does not persist — caller decides what to do.
 */
export function scoreIndicatorsForSubset(signals) {
  const indicatorKeys = [
    'khanSaab_score', 'smc_bos', 'smc_choch', 'smc_ob', 'smc_fvg',
    'formation', 'rsi_divergence', 'squeeze_filter', 'cdv',
    'macro_filter', 'volume_confirm', 'mtf_confirmation',
  ];
  const out = {};
  for (const key of indicatorKeys) out[key] = scoreIndicator(key, signals || []);
  return out;
}

/**
 * Get cached indicator scores.
 */
export function getCachedIndicatorScores() {
  return readJSON(INDICATORS_PATH, {});
}

/**
 * Generate a human-readable indicator report (gercek liga temelli).
 */
export function generateIndicatorReport() {
  const { scores: scoresAll, ranking: rankingAll, totalSignals, realSignals, virtualSignals } = scoreAllIndicators();
  const scores = scoresAll?.real || {};
  const ranking = rankingAll?.real || [];

  if (totalSignals === 0 || (realSignals || 0) === 0) {
    return 'Henuz yeterli gercek sinyal verisi yok — en az 20 cozulmus A/B/C sinyali gerekli.';
  }

  const lines = [];
  lines.push(`=== INDIKATOR PERFORMANS RAPORU (GERCEK LIGA) ===`);
  lines.push(`Gercek sinyaller: ${realSignals} | Sanal (BEKLE): ${virtualSignals}`);
  lines.push('');

  // Load-bearing indicators
  const loadBearing = ranking.filter(r => r.classification === 'load_bearing');
  if (loadBearing.length > 0) {
    lines.push('YUKSEK KATKI (Load-bearing):');
    for (const r of loadBearing) {
      lines.push(`  ${r.indicator}: lift +${r.lift}% | WR ${r.alignedWR}% | n=${r.n}`);
    }
    lines.push('');
  }

  // Useful indicators
  const useful = ranking.filter(r => r.classification === 'useful');
  if (useful.length > 0) {
    lines.push('ORTA KATKI (Useful):');
    for (const r of useful) {
      lines.push(`  ${r.indicator}: lift +${r.lift}% | WR ${r.alignedWR}% | n=${r.n}`);
    }
    lines.push('');
  }

  // Decorative indicators
  const decorative = ranking.filter(r => r.classification === 'decorative');
  if (decorative.length > 0) {
    lines.push('DUSUK KATKI (Dekoratif — kaldirilabilir):');
    for (const r of decorative) {
      lines.push(`  ${r.indicator}: lift ${r.lift}% | WR ${r.alignedWR}% | n=${r.n}`);
    }
    lines.push('');
  }

  // Counterproductive
  const counter = ranking.filter(r => r.classification === 'counterproductive');
  if (counter.length > 0) {
    lines.push('NEGATIF KATKI (Kontra-uretken — kaldirin veya ters kullanin):');
    for (const r of counter) {
      lines.push(`  ${r.indicator}: lift ${r.lift}% | WR ${r.alignedWR}% | n=${r.n}`);
    }
    lines.push('');
  }

  // Critical recommendations
  lines.push('--- ELESTIRISEL DEGERLENDIRME ---');
  for (const [key, score] of Object.entries(scores)) {
    if (score.classification === 'decorative' && score.aligned_count >= 30) {
      lines.push(`ONERI: ${key} indikatoru neredeyse hicbir katki saglamiyor (lift: ${score.lift}%). Kaldirilmasi sinyal kalitesini etkilemez.`);
    }
    if (score.classification === 'counterproductive') {
      lines.push(`UYARI: ${key} indikatoru sinyal kalitesini DUSURUYOR (lift: ${score.lift}%). Ters kullanmayi veya kaldirmayi deneyin.`);
    }
    if (score.opposed_win_rate != null && score.opposed_win_rate > 60 && score.opposed_count >= 15) {
      lines.push(`ILGINC: ${key} KARSI olduğunda bile %${score.opposed_win_rate} kazanma orani — bu indikator guvenilmez olabilir.`);
    }
  }

  return lines.join('\n');
}
