/**
 * Regime Profiles — piyasa-özel rejim eşikleri.
 *
 * Taxonomy (docs/regime-taxonomy.md §2-5) her piyasa için farklı eşikler
 * tanımlar. İter 1'de compute-regime.js içinde inline idi; İter 2'de
 * profili ayrı dosyaya çıkardık (kalibrasyon + gözden geçirme ayrı iş olsun).
 *
 * Her piyasa profili şu şekli taşır:
 *   {
 *     adxHi:   <number>    trending_up/down alt-eşik (bu değerin üstünde trend)
 *     adxLo:   <number>    ranging/breakout_pending üst-eşik (altında sıkışma)
 *     ...piyasa-özel alanlar (chaos24h, vixChaos, usdtryChaosPct, vb.)
 *   }
 *
 * Kalibrasyon: shadow-mode 4 haftasından sonra canlı veriyle güncellenir.
 * Bu dosya commit'lenmiş konfigdir (runtime state değil), değişiklikler
 * gözden geçirilmelidir.
 */

export const REGIME_PROFILES = {
  // ----------------------------------------------------------------------
  // Kripto (taxonomy §2)
  // Karakteristik: 24/7, BTC dominance etkisi, funding rate sinyali
  // ----------------------------------------------------------------------
  crypto: {
    adxHi: 25,
    adxLo: 20,
    chaos24h: 0.08,            // |24h return| > %8 → chaos
    chaos1h: 0.04,             // |1h return| > %4 → chaos
    fundingAbsChaos: 0.001,    // |funding| > 0.1% → chaos (overcrowded)
    bbWidthTightRatio: 0.7,    // BB < %70 medyan → sıkışma (breakout_pending)
    weekendLowVolRangePct: 0.015,  // hafta sonu + günlük range < %1.5 → drift
  },

  // ----------------------------------------------------------------------
  // ABD Hisse (taxonomy §3)
  // Session-bound, VIX + sektör RS + earnings penceresi
  // ----------------------------------------------------------------------
  us_stocks: {
    adxHi: 22,
    adxLo: 18,
    vixChaos: 30,              // VIX > 30 → chaos
    vixHalt: 35,               // VIX > 35 → tüm ABD halt (ek risk kuralı)
    vixCalm: 12,               // VIX < 12 → low_vol_drift
    gapOpenChaosPct: 0.02,     // gap open > %2 → chaos
    sectorRsHaltSigma: -2,     // sektör RS < -2σ → o sektör halt
    bbWidthTightRatio: 0.7,
  },

  // ----------------------------------------------------------------------
  // BIST (taxonomy §4)
  // TL volatilitesi ana sürücü, USDTRY × BIST korelasyonu ayıraç
  // ----------------------------------------------------------------------
  bist: {
    adxHi: 22,
    adxLo: 18,
    usdtryChaosPct: 0.04,          // USDTRY 1g > %4 → tüm BIST halt
    usdtryStableSigma: 0.005,      // 5g σ < %0.5 → "tl_stable" adayı
    usdtryStressSigma: 0.02,       // 5g σ > %2 → stres/decoupled adayı
    usdtrySpikeSigma: 0.03,        // 5g σ > %3 → tl_spike_inflation adayı
    rhoStableMax: 0.3,             // |ρ| < 0.3 → domestic story
    rhoSpikeMin: 0.7,              // ρ > 0.7 → tl_spike nominal patlama
    rhoDecoupledMax: 0.2,          // ρ < 0.2 → decoupled_stress
    bbWidthTightRatio: 0.7,
    circuitBreakerPct: 0.01,       // tavan-taban ±%1 → pozisyon yok
  },

  // ----------------------------------------------------------------------
  // Emtia (taxonomy §5) — alt sınıflara göre override'lar
  // ----------------------------------------------------------------------
  commodities: {
    adxHi: 25,
    adxLo: 20,
    bbWidthTightRatio: 0.7,
    // Alt sınıf özelleri
    metals: {
      vixFlightThreshold: 25,  // VIX > 25 + DXY↓ → risk_off_flight (trending_up bias)
    },
    energy: {
      inventorySigmaChaos: 2,  // EIA stok > 2σ → supply_shock
      opecChaosDurationMin: 240,
    },
    natgas: {
      winterMonths: [10, 11, 12, 1, 2, 3],  // ekim-mart
      storageLowPct: 0.95,     // depolama < %normal*0.95 → winter_premium
    },
    agri: {
      wasdeChaosMin: 120,
    },
    industrial: {
      chinaPmiFreeze: 50,      // PMI < 50 → trending_up dondur
    },
  },

  // Forex (taxonomy'de ayrı bölüm yok — crypto benzeri default)
  forex: {
    adxHi: 25,
    adxLo: 20,
    bbWidthTightRatio: 0.7,
  },
};

/**
 * Piyasa profili getir. Bilinmeyen marketType → crypto default.
 * @param {string} marketType  'crypto'|'us_stocks'|'bist'|'commodities'|'forex'
 * @param {string|null} subClass  commodities için 'metals'|'energy'|...
 */
export function getProfile(marketType, subClass = null) {
  const base = REGIME_PROFILES[marketType] || REGIME_PROFILES.crypto;
  if (marketType === 'commodities' && subClass && base[subClass]) {
    return { ...base, ...base[subClass] };
  }
  return base;
}

/**
 * Faz 2 — Rejim-aware filtre eşikleri (REGIME_GATES).
 *
 * docs/phase-2-design.md §6.5 tablosu. Şu anki sayılar TAHMIN; May 2 Faz 1
 * raporu sonrası gerçek rejim dağılımı + outcome verisiyle kalibre edilecek.
 *
 * applyRegimeStrategy() bu tabloyu okur:
 *   - minGrade: rejim bu altı grade'leri reddeder
 *   - htfConfMin: HTF güveni bu yüzdenin altıysa BEKLE
 *   - mtfAlignMin: MTF uyumu bu yüzdenin altıysa BEKLE
 *   - allowNewPosition: chaos/drift/closed → false (yeni pozisyon yok)
 */
export const REGIME_GATES = {
  trending_up:      { allowNewPosition: true, minGrade: 'B', htfConfMin: 60, mtfAlignMin: 75 },
  trending_down:    { allowNewPosition: true, minGrade: 'B', htfConfMin: 60, mtfAlignMin: 75 },
  ranging:          { allowNewPosition: true, minGrade: 'C', htfConfMin: 45, mtfAlignMin: 60 },
  breakout_pending: { allowNewPosition: true, minGrade: 'B', htfConfMin: 55, mtfAlignMin: 70 },
  high_vol_chaos:   { allowNewPosition: false, minGrade: null, htfConfMin: null, mtfAlignMin: null },
  low_vol_drift:    { allowNewPosition: false, minGrade: null, htfConfMin: null, mtfAlignMin: null },
  market_closed:    { allowNewPosition: false, minGrade: null, htfConfMin: null, mtfAlignMin: null },
};

/**
 * Rejim → SL multiplier override.
 * docs/phase-2-design.md §2 tablosu (taxonomy ayrıntısı). Trending'de geniş SL
 * (ATR×2.5), ranging'de dar (ATR×1.5, range içinde fail erken), breakout'ta
 * geniş (ATR×3.0).
 */
export const REGIME_SL_MULT = {
  trending_up:      2.5,
  trending_down:    2.5,
  ranging:          1.5,
  breakout_pending: 3.0,
  high_vol_chaos:   null,  // pozisyon yok
  low_vol_drift:    null,
  market_closed:    null,
};

/**
 * Rejim → vote suppression tablosu.
 * Hangi indikatör oyları rejimde "bastırılır" (ağırlık 0)? Hangi oylar
 * "öne çıkarılır" (ağırlık 1.5×)?
 *
 * docs/phase-2-design.md §2 tablosu — basit string match yerine indikatör
 * ailelerine göre kategorize edilmiştir.
 *
 * indicatorKey örnekleri (collectVotes'tan beklenen):
 *   - 'macd_trend', 'ema_cross', 'adx_strong', 'volume_high'  → momentum ailesi
 *   - 'rsi_oversold', 'rsi_overbought', 'bb_touch_lower', 'bb_touch_upper' → mean-reversion ailesi
 *   - 'smc_bos_bullish', 'smc_bos_bearish', 'smc_choch'  → SMC ailesi
 *   - 'orderblock_bounce', 'fvg_fill'  → SMC seviye ailesi
 *   - 'formation_bullish', 'formation_bearish'  → formasyon ailesi
 *   - 'htf_trend_aligned', 'htf_trend_conflict'  → HTF ailesi
 */
export const VOTE_FAMILIES = {
  momentum:        ['macd_trend', 'ema_cross', 'adx_strong', 'volume_high', 'macd_main', 'macd_signal', 'trend_strength'],
  mean_reversion:  ['rsi_oversold', 'rsi_overbought', 'bb_touch_lower', 'bb_touch_upper', 'rsi_divergence_bullish', 'rsi_divergence_bearish', 'discount_zone', 'premium_zone'],
  smc_structural:  ['smc_bos_bullish', 'smc_bos_bearish', 'smc_choch_bullish', 'smc_choch_bearish'],
  smc_levels:      ['orderblock_bounce', 'fvg_fill', 'liquidity_sweep'],
  formation:       ['formation_bullish', 'formation_bearish'],
  htf:             ['htf_trend_aligned', 'htf_trend_conflict'],
  cdv:             ['cdv_buy', 'cdv_sell', 'cdv_strong_buy', 'cdv_strong_sell'],
};

/**
 * Rejim başına aile ağırlık çarpanları.
 * 1.0 = nötr, 0 = tamamen bastır, 1.5 = öne çıkar.
 *
 * Bu tablo Faz 0 patch (b)'nin "tam bypass" mantığının yumuşak versiyonudur:
 * ranging'de momentum 0'a inmek yerine 0.3'e (mean-reversion için yön ipucu
 * hâlâ değerli olabilir), mean-reversion 1.5'e çıkıyor.
 */
export const REGIME_VOTE_WEIGHTS = {
  trending_up:      { momentum: 1.0, mean_reversion: 0.5, smc_structural: 1.0, smc_levels: 1.2, formation: 1.0, htf: 1.0, cdv: 1.0 },
  trending_down:    { momentum: 1.0, mean_reversion: 0.5, smc_structural: 1.0, smc_levels: 1.2, formation: 1.0, htf: 1.0, cdv: 1.0 },
  ranging:          { momentum: 0.3, mean_reversion: 1.5, smc_structural: 1.0, smc_levels: 1.2, formation: 0.8, htf: 0.7, cdv: 1.0 },
  breakout_pending: { momentum: 0.7, mean_reversion: 0.3, smc_structural: 1.0, smc_levels: 1.0, formation: 1.2, htf: 1.0, cdv: 1.0 },
  high_vol_chaos:   { momentum: 0,   mean_reversion: 0,   smc_structural: 0,   smc_levels: 0,   formation: 0,   htf: 0,   cdv: 0   },
  low_vol_drift:    { momentum: 0,   mean_reversion: 0,   smc_structural: 0,   smc_levels: 0,   formation: 0,   htf: 0,   cdv: 0   },
  market_closed:    { momentum: 0,   mean_reversion: 0,   smc_structural: 0,   smc_levels: 0,   formation: 0,   htf: 0,   cdv: 0   },
};

/** indicatorKey → vote family lookup. */
export function familyOf(indicatorKey) {
  if (!indicatorKey) return null;
  const k = String(indicatorKey).toLowerCase();
  for (const [family, keys] of Object.entries(VOTE_FAMILIES)) {
    if (keys.some(p => k.includes(p))) return family;
  }
  return null;
}

/** Scanner kategori adını (rules.json) taxonomy marketType'a çevir. */
export function categoryToMarketType(category) {
  switch (category) {
    case 'kripto':
    case 'crypto':    return 'crypto';
    case 'abd_hisse': return 'us_stocks';
    case 'bist':      return 'bist';
    case 'emtia':     return 'commodities';
    case 'forex':     return 'forex';
    default:          return 'crypto';
  }
}
