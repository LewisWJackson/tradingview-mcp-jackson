/**
 * Risk #18 — calcADX wilderRMA fix dogrulamasi.
 *
 * Wilder ADX'in matematiksel ozelligi: 0-100 arasinda kalmali. Daha onceki
 * bug nedeniyle yuzlere ulasiyordu (ETHUSDT.P 243.3, RENDERUSDC 205.1 vb.
 * canli sistemde gozlemlendi).
 *
 * Test stratejisi: sentetik bar serileri ureterek calcADX'in 0-100 aralik
 * sinirlarini ihlal etmedigini ve mantikli buyuk-kucuk siralamayi korudugunu
 * dogrula.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcADX } from '../lib/calculators.js';

/**
 * Sentetik bar uretici. mode:
 *   'sideways' → flat range, ADX dusuk olmali (~10-20)
 *   'strong_trend' → monotonic up, ADX yuksek (~40-60)
 *   'weak_trend'  → hafif up, ADX orta (~20-30)
 */
function genBars(n, mode) {
  const bars = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    let delta;
    if (mode === 'sideways') {
      delta = Math.sin(i / 3) * 0.5;  // dar range
    } else if (mode === 'strong_trend') {
      delta = 1.0 + (Math.random() - 0.5) * 0.3;  // tutarli yukari
    } else if (mode === 'weak_trend') {
      delta = 0.3 + (Math.random() - 0.5) * 0.5;
    } else {
      delta = (Math.random() - 0.5) * 1.0;  // random
    }
    const open = close;
    close = open + delta;
    const high = Math.max(open, close) + Math.abs(delta) * 0.3;
    const low = Math.min(open, close) - Math.abs(delta) * 0.3;
    bars.push({ open, high, low, close, volume: 1000 });
  }
  return bars;
}

test('1. ADX hicbir zaman 100 ustune cikmamali', () => {
  for (const mode of ['sideways', 'strong_trend', 'weak_trend', 'random']) {
    for (let trial = 0; trial < 10; trial++) {
      const bars = genBars(100, mode);
      const r = calcADX(bars);
      if (r != null) {
        assert.ok(r.adx <= 100, `mode=${mode} trial=${trial} adx=${r.adx} > 100 — Risk #18 regresyonu`);
        assert.ok(r.adx >= 0, `mode=${mode} adx=${r.adx} < 0`);
      }
    }
  }
});

test('2. Sideways bar serisinde ADX dusuk (<25 cogunlukla)', () => {
  let dusukSayisi = 0;
  const trials = 20;
  for (let t = 0; t < trials; t++) {
    const bars = genBars(100, 'sideways');
    const r = calcADX(bars);
    if (r && r.adx < 25) dusukSayisi++;
  }
  // Sideways mod'da %50+ adx<25 bekleniyor (Wilder ADX dar range'de zayif)
  assert.ok(dusukSayisi >= trials / 2,
    `sideways'ta sadece ${dusukSayisi}/${trials} dusuk ADX — bug regresyonu olabilir`);
});

test('3. Strong trend bar serisinde ADX yuksek (>20 cogunlukla)', () => {
  let yuksekSayisi = 0;
  const trials = 20;
  for (let t = 0; t < trials; t++) {
    const bars = genBars(100, 'strong_trend');
    const r = calcADX(bars);
    if (r && r.adx > 20) yuksekSayisi++;
  }
  assert.ok(yuksekSayisi >= trials / 2,
    `strong_trend'te sadece ${yuksekSayisi}/${trials} yuksek ADX — formul yanlis olabilir`);
});

test('4. Sabit bar (zero TR) → null (matematiksel olarak tanimsiz)', () => {
  const bars = Array.from({ length: 100 }, () => ({
    open: 100, high: 100, low: 100, close: 100, volume: 1000,
  }));
  const r = calcADX(bars);
  // tr === 0 her bar → ADX undefined, null donmeli
  assert.equal(r, null);
});

test('5. Yetersiz bar → null', () => {
  const bars = genBars(10, 'sideways');  // < period*2+5 = 33
  const r = calcADX(bars);
  assert.equal(r, null);
});

// ---------------------------------------------------------------------------
// Faz 2 v2.2 — ADX serisi + slope dogrulama
// ---------------------------------------------------------------------------

test('6. adxSeries son 5 deger doner, hepsi 0-100 araliginda', () => {
  const bars = genBars(100, 'strong_trend');
  const r = calcADX(bars);
  assert.ok(r != null);
  assert.ok(Array.isArray(r.adxSeries), 'adxSeries dizi olmali');
  assert.ok(r.adxSeries.length > 0 && r.adxSeries.length <= 5);
  for (const v of r.adxSeries) {
    assert.ok(v >= 0 && v <= 100, `adxSeries deger 0-100 disinda: ${v}`);
  }
  // Son deger r.adx ile esit olmali
  assert.equal(r.adxSeries[r.adxSeries.length - 1], r.adx);
});

test('7. Hizlanan trend: adxSeries son degeri ilkinden buyuk olmali', () => {
  // Yavas baslayan, sonra hizlanan trend simulasyonu
  const bars = [];
  let close = 100;
  for (let i = 0; i < 100; i++) {
    const accel = i < 50 ? 0.3 : 1.5;  // 50. bar sonrasi hizlan
    const delta = accel + (Math.random() - 0.5) * 0.4;
    const open = close;
    close = open + delta;
    bars.push({
      open, close,
      high: Math.max(open, close) + Math.abs(delta) * 0.3,
      low: Math.min(open, close) - Math.abs(delta) * 0.3,
      volume: 1000,
    });
  }
  const r = calcADX(bars);
  assert.ok(r && r.adxSeries.length >= 3);
  // Slope >= 0 olmali (trend hizlaniyor → ADX yukseliyor)
  const slope = r.adxSeries[r.adxSeries.length - 1] - r.adxSeries[0];
  assert.ok(slope >= 0, `hizlanan trendde slope >= 0 olmali, gelen: ${slope.toFixed(2)}`);
});

test('8. Sabit girdi: adxSeries elemanlari neredeyse esit', () => {
  // Sabit DX → wilderRMA sabit ADX → adxSeries değişmez
  // Tam sabit bar (zero TR) → null donduruyor; bu yuzden cok kucuk delta
  const bars = [];
  let close = 100;
  for (let i = 0; i < 100; i++) {
    close += 0.1 * (i % 2 === 0 ? 1 : -1);  // ±0.1 mikro osilasyon
    const open = close;
    bars.push({ open, close, high: open + 0.05, low: open - 0.05, volume: 1000 });
  }
  const r = calcADX(bars);
  if (r && r.adxSeries.length >= 3) {
    const range = Math.max(...r.adxSeries) - Math.min(...r.adxSeries);
    assert.ok(range < 5, `sabit girdide aralik <5 olmali, gelen: ${range.toFixed(2)}`);
  }
});
