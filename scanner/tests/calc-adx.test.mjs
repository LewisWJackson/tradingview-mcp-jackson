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
