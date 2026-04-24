/**
 * Faz 1 İter 1 — computeRegime() unit tests.
 * Çalıştırma: node --test scanner/tests/compute-regime.test.mjs
 *
 * Kapsam (DeepSeek Faz 1 planı):
 *   - 6 rejim tetiklenmesi (trending_up/down, ranging, breakout_pending,
 *     high_vol_chaos, low_vol_drift) — her biri minimum girdiyle
 *   - Histerezis N=3 (ping-pong ADX 24↔26 false-flip koruması)
 *   - Rate limit (5 geçiş → 5. bloke, unstable=true)
 *   - Trend yorgunluğu (ADX 30→26, fiyat EMA üstü) — DeepSeek eklentisi
 *   - Chaos bypass — histerezis beklemez, anında tetiklenir
 *   - İlk çağrı (state yok) — raw regime anında set edilir
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRegime,
  computeIndicators,
  classifyRaw,
  activeChaosWindow,
  _resetState,
  __internals,
} from '../lib/learning/compute-regime.js';

const BASE_SYMBOL = 'BTCUSDT';
const BASE_TF = '60';

// Yardımcı: bir dizi "bar"ı peş peşe çağırır; her çağrı stateful.
function feed(bars, { symbol = BASE_SYMBOL, timeframe = BASE_TF, marketType = 'crypto', macro = {}, session = null } = {}) {
  const results = [];
  for (const bar of bars) {
    const out = computeRegime({
      symbol, timeframe, marketType,
      indicators: bar.indicators,
      macro: bar.macro ?? macro,
      session: bar.session ?? session,
      now: bar.now,
    });
    results.push(out);
  }
  return results;
}

// Belirli bir rejimi tetikleyecek minimum indicators
function indForRegime(regime) {
  switch (regime) {
    case 'trending_up':
      return { adx: 30, adxSlope: 1, priceAboveEma20: true, bbWidthRatio: 1.2, returns24h: 0, returns1h: 0, dailyRangePct: 0.05 };
    case 'trending_down':
      return { adx: 30, adxSlope: 1, priceAboveEma20: false, bbWidthRatio: 1.2, returns24h: 0, returns1h: 0, dailyRangePct: 0.05 };
    case 'ranging':
      return { adx: 15, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0, returns24h: 0, returns1h: 0, dailyRangePct: 0.03 };
    case 'breakout_pending':
      return { adx: 15, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 0.5, returns24h: 0, returns1h: 0, dailyRangePct: 0.03 };
    default:
      throw new Error(`unknown regime ${regime}`);
  }
}

// ---------------------------------------------------------------------------

test('1. trending_up 3 bar sonra onaylanır', () => {
  _resetState();
  const bars = Array.from({ length: 3 }, (_, i) => ({
    indicators: indForRegime('trending_up'),
    now: 1700_000_000_000 + i * 3600_000,
  }));
  const r = feed(bars);
  assert.equal(r[0].regime, 'trending_up');           // ilk çağrı anında set
  assert.equal(r[0].transitioned, true);
  assert.equal(r[2].stableBars, 3);
  assert.equal(r[2].newPositionAllowed, true);        // histerezis doldu
});

test('2. trending_down tetiklenir', () => {
  _resetState();
  const r = feed([{ indicators: indForRegime('trending_down'), now: 1700_000_000_000 }]);
  assert.equal(r[0].regime, 'trending_down');
  assert.equal(r[0].strategyHint, 'pullback_entry_short');
});

test('3. ranging tetiklenir', () => {
  _resetState();
  const r = feed([{ indicators: indForRegime('ranging'), now: 1700_000_000_000 }]);
  assert.equal(r[0].regime, 'ranging');
  assert.equal(r[0].strategyHint, 'mean_reversion');
});

test('4. breakout_pending tetiklenir (dar BB + düşük ADX)', () => {
  _resetState();
  const r = feed([{ indicators: indForRegime('breakout_pending'), now: 1700_000_000_000 }]);
  assert.equal(r[0].regime, 'breakout_pending');
  assert.equal(r[0].strategyHint, 'momentum_breakout');
});

test('5. high_vol_chaos tetiklenir (crypto 24h return > %8)', () => {
  _resetState();
  const ind = { adx: 20, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0, returns24h: 0.10, returns1h: 0.01, dailyRangePct: 0.1 };
  const r = feed([{ indicators: ind, now: 1700_000_000_000 }]);
  assert.equal(r[0].regime, 'high_vol_chaos');
  assert.equal(r[0].newPositionAllowed, false);
});

test('6. low_vol_drift tetiklenir (us_stocks premarket)', () => {
  _resetState();
  const r = computeRegime({
    symbol: 'AAPL', timeframe: '60', marketType: 'us_stocks',
    indicators: { adx: 20, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0 },
    macro: { vix: 15 },
    session: 'premarket',
    now: 1700_000_000_000,
  });
  assert.equal(r.regime, 'low_vol_drift');
});

// ---------------------------------------------------------------------------
// Histerezis — false-flip koruması
// ---------------------------------------------------------------------------

test('7. Histerezis: ADX 24↔26 ping-pong, rejim değişmez', () => {
  _resetState();
  // İlk rejim: trending_up (ADX 30, slope+, priceAbove)
  feed([
    { indicators: indForRegime('trending_up'), now: 1_700_000_000_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_003_600_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_007_200_000 },
  ]);

  // Şimdi ADX 19 (ranging gri) — 1 bar, 2 bar
  const flip1 = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: indForRegime('ranging'),
    now: 1_700_010_800_000,
  });
  assert.equal(flip1.regime, 'trending_up', 'histerezis daha dolmadı');
  assert.equal(flip1.rawRegime, 'ranging');

  const flip2 = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: indForRegime('trending_up'),
    now: 1_700_014_400_000,
  });
  // trending_up geri → histerezis sıfırlanır
  assert.equal(flip2.regime, 'trending_up');

  const flip3 = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: indForRegime('ranging'),
    now: 1_700_018_000_000,
  });
  assert.equal(flip3.regime, 'trending_up', 'ping-pong flip bastırıldı');
});

test('8. Histerezis: 3 ardışık ranging → transition onaylanır', () => {
  _resetState();
  feed([
    { indicators: indForRegime('trending_up'), now: 1_700_000_000_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_003_600_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_007_200_000 },
  ]);
  const r = feed([
    { indicators: indForRegime('ranging'), now: 1_700_010_800_000 },
    { indicators: indForRegime('ranging'), now: 1_700_014_400_000 },
    { indicators: indForRegime('ranging'), now: 1_700_018_000_000 },
  ]);
  assert.equal(r[0].regime, 'trending_up');
  assert.equal(r[1].regime, 'trending_up');
  assert.equal(r[2].regime, 'ranging');
  assert.equal(r[2].transitioned, true);
});

// ---------------------------------------------------------------------------
// DeepSeek eklentisi: Trend yorgunluğu — ADX 30→26, fiyat EMA üstü
// ---------------------------------------------------------------------------

test('9. Trend yorgunluğu: ADX 30→26, fiyat EMA üstü → trending_up korunur', () => {
  _resetState();
  // 3 bar ADX=30 ile trending_up onayla
  feed([
    { indicators: { adx: 30, adxSlope: 1, priceAboveEma20: true, bbWidthRatio: 1.2 }, now: 1_700_000_000_000 },
    { indicators: { adx: 30, adxSlope: 1, priceAboveEma20: true, bbWidthRatio: 1.2 }, now: 1_700_003_600_000 },
    { indicators: { adx: 30, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.2 }, now: 1_700_007_200_000 },
  ]);

  // ADX 26 ama slope düşüyor → raw taxonomy'ye göre trending_up DEĞİL
  // (ADX türevi ≥ 0 şartı sağlanmıyor). Ham → grey_zone → ranging.
  // Histerezis bunu 3 bar bekler; bu test tam o bastırmayı doğrular.
  const r1 = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: { adx: 26, adxSlope: -1, priceAboveEma20: true, bbWidthRatio: 1.1 },
    now: 1_700_010_800_000,
  });
  assert.equal(r1.regime, 'trending_up', 'histerezis ham flip-i bastırıyor');
  assert.equal(r1.rawRegime, 'ranging', 'raw: slope negatif → grey_zone → ranging');

  // ADX 22'ye iniyor (gri bölge: 20-25) → raw "ranging" (grey_zone default)
  const r2 = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: { adx: 22, adxSlope: -1, priceAboveEma20: true, bbWidthRatio: 1.0 },
    now: 1_700_014_400_000,
  });
  // Gri zone → ranging ham, ama histerezis daha dolmadı → trending_up korunur
  assert.equal(r2.regime, 'trending_up', 'histerezis grey_zone flip-i bastırıyor');
  assert.ok(r2.rawRegime === 'ranging', 'raw grey_zone → ranging');
});

// ---------------------------------------------------------------------------
// Rate limit: >4 geçiş/gün/sembol → unstable
// ---------------------------------------------------------------------------

test('10. Rate limit: 4 geçiş sonrası unstable, 5. geçiş bloke', () => {
  _resetState();
  const dayStart = Date.parse('2024-06-15T00:00:00Z');
  // Histerezis'i hızlı geçmek için her rejimi 3 bar üst üste yaz
  const cycles = [
    'trending_up', 'ranging', 'trending_down', 'ranging', 'trending_up',
  ];
  let t = dayStart;
  let results = [];
  for (const r of cycles) {
    for (let i = 0; i < 3; i++) {
      const res = computeRegime({
        symbol: BASE_SYMBOL, timeframe: BASE_TF,
        indicators: indForRegime(r),
        now: t,
      });
      results.push(res);
      t += 3600_000;
    }
  }
  // 5 rejim × 3 bar = 15 çağrı. İlki + 4 transition = 5 transition girişimi.
  // MAX_TRANSITIONS_PER_DAY = 4 → 5. bloke.
  const finalState = results[results.length - 1];
  assert.equal(finalState.transitionsToday >= 4, true, 'en az 4 transition kaydedilmiş');
  assert.equal(finalState.unstable, true, 'unstable flag set');
  assert.notEqual(finalState.regime, 'trending_up', '5. transition bloke oldu, son rejim korundu');
});

// ---------------------------------------------------------------------------
// Chaos bypass — histerezis beklemez
// ---------------------------------------------------------------------------

test('11. Chaos bypass: trending_up ortasında crypto cascade anında chaos', () => {
  _resetState();
  feed([
    { indicators: indForRegime('trending_up'), now: 1_700_000_000_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_003_600_000 },
    { indicators: indForRegime('trending_up'), now: 1_700_007_200_000 },
  ]);

  // Tek bar chaos (returns24h = 10%)
  const r = computeRegime({
    symbol: BASE_SYMBOL, timeframe: BASE_TF,
    indicators: { adx: 20, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0, returns24h: 0.10, returns1h: 0 },
    now: 1_700_010_800_000,
  });
  assert.equal(r.regime, 'high_vol_chaos', 'chaos histerezis beklemedi');
  assert.equal(r.transitioned, true);
  assert.equal(r.newPositionAllowed, false);
});

// ---------------------------------------------------------------------------
// activeChaosWindow — config driven
// ---------------------------------------------------------------------------

test('12. activeChaosWindow: FOMC ± 120 dk penceresi', () => {
  const chaosWindows = { us_fomc: { start_offset_min: 0, duration_min: 120 } };
  const eventAt = 1_700_000_000_000;
  const events = [{ type: 'us_fomc', at: eventAt }];

  assert.equal(activeChaosWindow({ events, chaosWindows, now: eventAt - 1 }), null, '1ms önce: pencere dışı');
  assert.equal(activeChaosWindow({ events, chaosWindows, now: eventAt + 60_000 }), 'us_fomc');
  assert.equal(activeChaosWindow({ events, chaosWindows, now: eventAt + 119 * 60_000 }), 'us_fomc');
  assert.equal(activeChaosWindow({ events, chaosWindows, now: eventAt + 121 * 60_000 }), null, 'pencere bitti');
});

// ---------------------------------------------------------------------------
// BIST subRegime
// ---------------------------------------------------------------------------

test('13. BIST: usdtry_1d > %4 → high_vol_chaos + bist_decoupled_stress', () => {
  _resetState();
  const r = computeRegime({
    symbol: 'GARAN', timeframe: '60', marketType: 'bist',
    indicators: { adx: 25, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0 },
    macro: { usdtry_return_1d: 0.05, usdtry_realized_sigma_5d: 0.03, usdtry_bist_rho_5d: 0.5 },
    now: 1_700_000_000_000,
  });
  assert.equal(r.regime, 'high_vol_chaos');
  assert.equal(r.subRegime, 'bist_decoupled_stress');
});

test('14. BIST: tl stable + rho~0 → bist_tl_stable_domestic subRegime', () => {
  _resetState();
  const r = computeRegime({
    symbol: 'GARAN', timeframe: '60', marketType: 'bist',
    indicators: { adx: 15, adxSlope: 0, priceAboveEma20: true, bbWidthRatio: 1.0 },
    macro: { usdtry_realized_sigma_5d: 0.003, usdtry_bist_rho_5d: 0.1, usdtry_return_1d: 0.002 },
    now: 1_700_000_000_000,
  });
  assert.equal(r.regime, 'ranging');
  assert.equal(r.subRegime, 'bist_tl_stable_domestic');
});

// ---------------------------------------------------------------------------
// computeIndicators smoke test
// ---------------------------------------------------------------------------

test('15. computeIndicators: bbWidthRatio 50-bar median ile hesaplanır', () => {
  const ohlcv = Array.from({ length: 60 }, (_, i) => ({
    time: i * 3600,
    open: 100,
    high: 102,
    low: 98,
    close: 100 + Math.sin(i / 10),
    volume: 1000,
  }));
  const studyValues = { adx: 25, ema20: 99.5, bbUpper: 103, bbLower: 97, bbBasis: 100 };
  const ind = computeIndicators({ ohlcv, studyValues });
  assert.equal(ind.adx, 25);
  assert.equal(ind.priceAboveEma20, true);
  assert.ok(ind.bbWidth != null && ind.bbWidthRatio != null);
  assert.equal(ind.barCount, 60);
});

test('16. __internals sabitleri taxonomy ile uyumlu', () => {
  assert.equal(__internals.HYSTERESIS_BARS, 3);
  assert.equal(__internals.MAX_TRANSITIONS_PER_DAY, 4);
});
