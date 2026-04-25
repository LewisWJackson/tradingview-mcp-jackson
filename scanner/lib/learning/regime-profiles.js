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
