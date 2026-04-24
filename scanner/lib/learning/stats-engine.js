/**
 * Stats Engine — computes aggregated statistics from resolved signals.
 * Uses pure statistical methods: moving averages, z-scores, EWMA.
 */

import { readAllArchives, readJSON, writeJSON, dataPath } from './persistence.js';

/**
 * Compute comprehensive stats for a set of signals.
 */
function computeGroupStats(signals) {
  if (!signals || signals.length === 0) {
    return { total: 0, wins: 0, losses: 0, winRate: 0, avgRR: 0, expectancy: 0, profitFactor: 0 };
  }

  const total = signals.length;
  const wins = signals.filter(s => s.win).length;
  const losses = total - wins;
  const winRate = total > 0 ? Math.round((wins / total) * 10000) / 100 : 0;

  // R:R analysis
  const withRR = signals.filter(s => s.actualRR != null);
  const avgRR = withRR.length > 0 ? Math.round(withRR.reduce((sum, s) => sum + s.actualRR, 0) / withRR.length * 100) / 100 : 0;

  const winRRs = withRR.filter(s => s.win);
  const lossRRs = withRR.filter(s => !s.win);
  const avgWinRR = winRRs.length > 0 ? winRRs.reduce((s, x) => s + x.actualRR, 0) / winRRs.length : 0;
  const avgLossRR = lossRRs.length > 0 ? Math.abs(lossRRs.reduce((s, x) => s + x.actualRR, 0) / lossRRs.length) : 0;

  // Expectancy: (winRate * avgWin) - (lossRate * avgLoss)
  const expectancy = Math.round(((winRate / 100) * avgWinRR - ((100 - winRate) / 100) * avgLossRR) * 100) / 100;

  // Profit factor: gross wins / gross losses
  const grossWins = winRRs.reduce((s, x) => s + x.actualRR, 0);
  const grossLosses = Math.abs(lossRRs.reduce((s, x) => s + x.actualRR, 0));
  const profitFactor = grossLosses > 0 ? Math.round((grossWins / grossLosses) * 100) / 100 : grossWins > 0 ? Infinity : 0;

  // TP hit rates
  const tp1HitRate = total > 0 ? Math.round(signals.filter(s => s.tp1Hit).length / total * 10000) / 100 : 0;
  const tp2HitRate = total > 0 ? Math.round(signals.filter(s => s.tp2Hit).length / total * 10000) / 100 : 0;
  const tp3HitRate = total > 0 ? Math.round(signals.filter(s => s.tp3Hit).length / total * 10000) / 100 : 0;
  const slHitRate = total > 0 ? Math.round(signals.filter(s => s.slHit).length / total * 10000) / 100 : 0;

  // Holding period
  const holdingMinutes = signals.filter(s => s.holdingPeriodMinutes != null).map(s => s.holdingPeriodMinutes);
  const avgHoldingMinutes = holdingMinutes.length > 0 ? Math.round(holdingMinutes.reduce((a, b) => a + b, 0) / holdingMinutes.length) : 0;

  // MFE/MAE
  const mfes = signals.filter(s => s.maxFavorableExcursion != null).map(s => s.maxFavorableExcursion);
  const maes = signals.filter(s => s.maxAdverseExcursion != null).map(s => s.maxAdverseExcursion);
  const avgMFE = mfes.length > 0 ? Math.round(mfes.reduce((a, b) => a + b, 0) / mfes.length * 100) / 100 : 0;
  const avgMAE = maes.length > 0 ? Math.round(maes.reduce((a, b) => a + b, 0) / maes.length * 100) / 100 : 0;

  // Recent trend: last 20 vs previous 20
  let recentTrend = 'insufficient_data';
  if (signals.length >= 20) {
    const sorted = [...signals].sort((a, b) => new Date(b.resolvedAt) - new Date(a.resolvedAt));
    const recent20 = sorted.slice(0, 20);
    const recentWR = recent20.filter(s => s.win).length / 20;

    if (sorted.length >= 40) {
      const prev20 = sorted.slice(20, 40);
      const prevWR = prev20.filter(s => s.win).length / 20;
      recentTrend = recentWR > prevWR + 0.05 ? 'improving' : recentWR < prevWR - 0.05 ? 'declining' : 'stable';
    } else {
      recentTrend = recentWR >= 0.55 ? 'positive' : recentWR <= 0.45 ? 'negative' : 'neutral';
    }
  }

  // Smart entry metrics
  const withSmartEntry = signals.filter(s => s.entrySource && s.entrySource !== 'quote_price' && s.entrySource !== 'lastbar_close');
  const entryReachedCount = withSmartEntry.filter(s => s.entryHit).length;
  // entry_missed artik uretilmiyor (expiry kaldirildi); eski arsiv kayitlarinda gorunebilir.
  const entryMissedCount = signals.filter(s => s.status === 'entry_missed').length;
  const entryExpiredList = signals.filter(s => s.status === 'entry_expired');
  const entryExpiredCount = entryExpiredList.length;
  // Kacirilan hareket: entry_expired sinyallerinde preEntryMFE / entry yuzdesi ortalamasi
  // — "bu sinyaller hakliydi, girseydik ne kazanirdik" gostergesi
  const missedMoves = entryExpiredList
    .map(s => (s.preEntryMFE && s.entry) ? (s.preEntryMFE / s.entry) * 100 : null)
    .filter(v => v != null && isFinite(v));
  const avgMissedMovePct = missedMoves.length > 0
    ? Math.round(missedMoves.reduce((a, b) => a + b, 0) / missedMoves.length * 100) / 100
    : 0;
  const entryReachedRate = withSmartEntry.length > 0
    ? Math.round(entryReachedCount / withSmartEntry.length * 10000) / 100
    : null;

  // Win rate among only entry-reached signals (more accurate for smart entry)
  // Legacy signals (no entrySource or quote_price) are always counted
  const activeSignals = signals.filter(s => {
    const isSmart = s.entrySource && s.entrySource !== 'quote_price' && s.entrySource !== 'lastbar_close';
    return !isSmart || s.entryHit;
  });
  const activeWins = activeSignals.filter(s => s.win).length;
  const activeWinRate = activeSignals.length > 0
    ? Math.round(activeWins / activeSignals.length * 10000) / 100
    : winRate;

  return {
    total, wins, losses, winRate, avgRR, avgWinRR: Math.round(avgWinRR * 100) / 100,
    avgLossRR: Math.round(avgLossRR * 100) / 100,
    expectancy, profitFactor,
    tp1HitRate, tp2HitRate, tp3HitRate, slHitRate,
    avgHoldingMinutes, avgMFE, avgMAE,
    recentTrend,
    // Smart entry stats
    smartEntryCount: withSmartEntry.length,
    entryReachedRate,
    entryMissedCount,
    entryExpiredCount,
    avgMissedMovePct,
    activeWinRate,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Compute faulty trade analysis — hangi indikatorlerin / TF'lerin hatali trade'lere
 * yol actigini tespit eder. Faulty trade: SL hit oldugunda acikken zit yon sinyalleri
 * gelmis ama dinlenmemis trade (reverseAttempts.length > 0).
 */
function computeFaultyTradeStats(signals) {
  const faulty = signals.filter(s => s.faultyTrade);
  if (faulty.length === 0) {
    return { total: 0, faultyRate: 0, byGrade: {}, byTimeframe: {}, indicatorGuilt: {}, avgFirstReverseLagMinutes: null };
  }

  const byGrade = {};
  const byTF = {};
  const indicatorGuilt = {};

  for (const f of faulty) {
    byGrade[f.grade] = (byGrade[f.grade] || 0) + 1;
    byTF[f.timeframe] = (byTF[f.timeframe] || 0) + 1;

    const ind = f.indicators || {};
    if (ind.khanSaab?.bias) {
      const k = `khanSaab_${ind.khanSaab.bias}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.khanSaab?.volStatus) {
      const k = `khanSaab_vol_${ind.khanSaab.volStatus}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.smc?.lastBOS) {
      const k = `smc_BOS_${ind.smc.lastBOS}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.smc?.lastCHoCH) {
      const k = `smc_CHoCH_${ind.smc.lastCHoCH}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.formation?.name) {
      const k = `formation_${ind.formation.name}_${ind.formation.direction || 'na'}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.squeeze?.status) {
      const k = `squeeze_${ind.squeeze.status}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.divergence?.type) {
      const k = `divergence_${ind.divergence.type}_${ind.divergence.direction || 'na'}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.cdv?.direction) {
      const k = `cdv_${ind.cdv.direction}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
    if (ind.mtfConfirmation) {
      const k = `mtf_${typeof ind.mtfConfirmation === 'string' ? ind.mtfConfirmation : 'mixed'}`;
      indicatorGuilt[k] = (indicatorGuilt[k] || 0) + 1;
    }
  }

  const lags = faulty
    .map(f => f.faultyTradeAnalysis?.firstReverseLagMinutes)
    .filter(n => Number.isFinite(n));
  const avgLag = lags.length > 0
    ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length)
    : null;

  return {
    total: faulty.length,
    faultyRate: signals.length > 0 ? Math.round(faulty.length / signals.length * 10000) / 100 : 0,
    byGrade,
    byTimeframe: byTF,
    indicatorGuilt,
    avgFirstReverseLagMinutes: avgLag,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Group signals by a key function and compute stats for each group.
 */
function computeByDimension(signals, keyFn) {
  const groups = {};
  for (const sig of signals) {
    const key = keyFn(sig);
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(sig);
  }

  const result = {};
  for (const [key, groupSignals] of Object.entries(groups)) {
    result[key] = computeGroupStats(groupSignals);
  }
  return result;
}

/**
 * Compute EWMA (Exponentially Weighted Moving Average) win rate.
 * More recent signals have higher weight.
 * @param {Array} signals - sorted by date ascending
 * @param {number} alpha - decay factor (0.1 = slow, 0.3 = fast)
 */
export function computeEWMAWinRate(signals, alpha = 0.15) {
  if (signals.length === 0) return 0;
  const sorted = [...signals].sort((a, b) => new Date(a.resolvedAt) - new Date(b.resolvedAt));
  let ewma = sorted[0].win ? 1 : 0;
  for (let i = 1; i < sorted.length; i++) {
    const val = sorted[i].win ? 1 : 0;
    ewma = alpha * val + (1 - alpha) * ewma;
  }
  return Math.round(ewma * 10000) / 100;
}

/**
 * Z-score: how many standard deviations the observed win rate deviates
 * from the expected rate. Used to determine statistical significance.
 */
export function computeZScore(observed, expected, n) {
  if (n < 5 || expected <= 0 || expected >= 1) return 0;
  const se = Math.sqrt(expected * (1 - expected) / n);
  if (se === 0) return 0;
  return Math.round(((observed - expected) / se) * 100) / 100;
}

/**
 * Uc-kademeli ladder'a gore sinyal ligini dondur. Eski kayitlarda `league`
 * alani yoksa grade bazli default: A/B=real, C=ara, BEKLE=virtual.
 */
export function signalLeague(sig) {
  if (!sig) return 'virtual';
  if (sig.league === 'real' || sig.league === 'ara' || sig.league === 'virtual') return sig.league;
  if (sig.grade === 'A' || sig.grade === 'B') return 'real';
  if (sig.grade === 'C') return 'ara';
  return 'virtual';
}

/**
 * @deprecated BEKLE=virtual ikili ayrimindan kalan yardimci. Yeni kodda
 * signalLeague(sig) kullanin. Eski cagrici'lar bir sure kalabilir.
 */
export function isVirtualSignal(sig) {
  return signalLeague(sig) === 'virtual';
}

function splitLeagues(signals) {
  const real = [];
  const ara = [];
  const virtual = [];
  for (const s of signals) {
    const league = signalLeague(s);
    if (league === 'real') real.push(s);
    else if (league === 'ara') ara.push(s);
    else virtual.push(s);
  }
  return { real, ara, virtual };
}

/**
 * Recompute all statistics from archived signals.
 * Schema: her dimension dosyasi { real: {...}, virtual: {...}, lastUpdated } yazar.
 * Eski tek-katmanli okuyucular mevcut oldugundan geriye donuk uyumluluk icin
 * `legacy` alani da eklenir — eski client/alan ornekleri calismaya devam etsin.
 */
export function recomputeAllStats() {
  const allSignals = readAllArchives();
  const { real, ara, virtual } = splitLeagues(allSignals);
  const nowIso = new Date().toISOString();

  const wrapDimension = (keyFn) => ({
    real: computeByDimension(real, keyFn),
    ara: computeByDimension(ara, keyFn),
    virtual: computeByDimension(virtual, keyFn),
    lastUpdated: nowIso,
  });

  const overallReal = computeGroupStats(real);
  const overallAra = computeGroupStats(ara);
  const overallVirtual = computeGroupStats(virtual);
  overallReal.ewmaWinRate = computeEWMAWinRate(real);
  overallAra.ewmaWinRate = computeEWMAWinRate(ara);
  overallVirtual.ewmaWinRate = computeEWMAWinRate(virtual);

  const overall = {
    real: overallReal,
    ara: overallAra,
    virtual: overallVirtual,
    lastUpdated: nowIso,
  };

  const byGrade = wrapDimension(s => s.grade);
  const byTimeframe = wrapDimension(s => s.timeframe);
  const bySymbol = wrapDimension(s => s.symbol);
  const byCategory = wrapDimension(s => s.category);
  const byMode = wrapDimension(s => s.mode);
  const byDirection = wrapDimension(s => s.direction);

  // Faulty trade analizi sadece real sinyallerde anlamli
  // (virtual pozisyon acilmadigi icin reverseAttempts uretmez).
  const faultyTrades = computeFaultyTradeStats(real);

  // Persist
  writeJSON(dataPath('stats', 'overall.json'), overall);
  writeJSON(dataPath('stats', 'by-grade.json'), byGrade);
  writeJSON(dataPath('stats', 'by-timeframe.json'), byTimeframe);
  writeJSON(dataPath('stats', 'by-symbol.json'), bySymbol);
  writeJSON(dataPath('stats', 'by-category.json'), byCategory);
  writeJSON(dataPath('stats', 'by-mode.json'), byMode);
  writeJSON(dataPath('stats', 'by-direction.json'), byDirection);
  writeJSON(dataPath('stats', 'faulty-trades.json'), faultyTrades);

  return {
    overall, byGrade, byTimeframe, bySymbol, byCategory, byMode, byDirection, faultyTrades,
    totalSignals: allSignals.length,
    realSignals: real.length,
    araSignals: ara.length,
    virtualSignals: virtual.length,
  };
}

/**
 * Get cached stats (read from file, no recomputation).
 */
export function getCachedStats(dimension) {
  const validDims = ['overall', 'by-grade', 'by-timeframe', 'by-symbol', 'by-category', 'by-mode', 'by-direction', 'faulty-trades'];
  if (!validDims.includes(dimension)) return null;
  return readJSON(dataPath('stats', `${dimension}.json`), {});
}

/**
 * Get all cached stats at once.
 */
export function getAllCachedStats() {
  return {
    overall: getCachedStats('overall'),
    byGrade: getCachedStats('by-grade'),
    byTimeframe: getCachedStats('by-timeframe'),
    bySymbol: getCachedStats('by-symbol'),
    byCategory: getCachedStats('by-category'),
    faultyTrades: getCachedStats('faulty-trades'),
  };
}
