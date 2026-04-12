/**
 * Test fixtures for Coiled Spring Scanner v2.
 * Each fixture is a candidate data object matching the shape
 * expected by scoring_v2.js functions.
 */

// Generate N days of OHLCV bars with configurable behavior
function makeBars(count, { basePrice = 50, trend = 'flat', volatility = 'normal', volumeBase = 1000000, volumeTrend = 'flat' } = {}) {
  const bars = [];
  let price = basePrice;
  for (let i = 0; i < count; i++) {
    const dayFactor = i / count;
    // Price trend
    if (trend === 'up') price += basePrice * 0.003;
    else if (trend === 'down') price -= basePrice * 0.003;

    // Volatility
    let rangePct = 0.02; // 2% normal range
    if (volatility === 'tight') rangePct = 0.01;
    else if (volatility === 'contracting') rangePct = 0.03 * (1 - dayFactor * 0.7); // 3% → 0.9%
    else if (volatility === 'wide') rangePct = 0.05;

    const range = price * rangePct;
    const open = price - range * 0.3;
    const high = price + range * 0.5;
    const low = price - range * 0.5;
    const close = price + range * 0.2; // slight upward bias

    // Volume
    let vol = volumeBase;
    if (volumeTrend === 'drying') vol = volumeBase * (1 - dayFactor * 0.5);
    else if (volumeTrend === 'surging') vol = volumeBase * (1 + dayFactor * 3);

    bars.push({
      date: `2026-0${1 + Math.floor(i / 30)}-${String((i % 30) + 1).padStart(2, '0')}`,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round(vol),
    });
  }
  return bars;
}

/** Valid coiled spring — tight BB, low ATR, stacked MAs, accumulation days */
export const VALID_COIL = {
  price: 85.50,
  ma50: 82.10,
  ma150: 78.50,
  ma200: 74.20,
  high52w: 88.00,
  relStrengthPctile: 82,
  avgVol10d: 800000,
  avgVol3mo: 1500000,
  earningsTimestamp: Math.floor(Date.now() / 1000) + 35 * 86400, // 35 days out
  shortPercentOfFloat: 12,
  news: [{ title: 'Analyst upgrades EXAMPLE to buy rating' }],
  sectorRank: 2,
  ohlcv: makeBars(63, { basePrice: 80, trend: 'up', volatility: 'contracting', volumeBase: 1500000, volumeTrend: 'drying' }),
};

/** Already exploded — ZNTL-like: huge gap, massive volume */
export const ALREADY_EXPLODED = {
  price: 6.61,
  ma50: 2.63,
  ma150: 2.25,
  ma200: 1.88,
  high52w: 7.00,
  relStrengthPctile: 95,
  avgVol10d: 5000000,
  avgVol3mo: 700000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 5,
  ohlcv: makeBars(63, { basePrice: 4, trend: 'up', volatility: 'wide', volumeBase: 700000, volumeTrend: 'surging' }),
};

/** Broken down — below 200-day MA, downtrend */
export const BROKEN_DOWN = {
  price: 35.00,
  ma50: 38.00,
  ma150: 42.00,
  ma200: 45.00,
  high52w: 60.00,
  relStrengthPctile: 15,
  avgVol10d: 1200000,
  avgVol3mo: 1500000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [{ title: 'Company sued in class action lawsuit' }],
  sectorRank: 9,
  ohlcv: makeBars(63, { basePrice: 45, trend: 'down', volatility: 'normal' }),
};

/** Illiquid — too little volume for options */
export const ILLIQUID = {
  price: 22.00,
  ma50: 20.00,
  ma150: 19.00,
  ma200: 18.00,
  high52w: 25.00,
  relStrengthPctile: 60,
  avgVol10d: 50000,
  avgVol3mo: 80000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 6,
  ohlcv: makeBars(63, { basePrice: 20, trend: 'up', volatility: 'tight', volumeBase: 80000, volumeTrend: 'drying' }),
};

/** Fake compression — tight range but no accumulation, dead money */
export const FAKE_COMPRESSION = {
  price: 42.00,
  ma50: 41.50,
  ma150: 41.00,
  ma200: 40.50,
  high52w: 48.00,
  relStrengthPctile: 40,
  avgVol10d: 900000,
  avgVol3mo: 1000000,
  earningsTimestamp: null,
  shortPercentOfFloat: null,
  news: [],
  sectorRank: 8,
  ohlcv: makeBars(63, { basePrice: 41.5, trend: 'flat', volatility: 'tight', volumeBase: 1000000, volumeTrend: 'flat' }),
};

/** Edge case: score near classification boundary */
export const BOUNDARY_CANDIDATE = {
  price: 55.00,
  ma50: 53.00,
  ma150: 50.00,
  ma200: 48.00,
  high52w: 58.00,
  relStrengthPctile: 65,
  avgVol10d: 1100000,
  avgVol3mo: 1400000,
  earningsTimestamp: Math.floor(Date.now() / 1000) + 40 * 86400,
  shortPercentOfFloat: 8,
  news: [],
  sectorRank: 4,
  ohlcv: makeBars(63, { basePrice: 52, trend: 'up', volatility: 'contracting', volumeBase: 1400000, volumeTrend: 'drying' }),
};

export { makeBars };
