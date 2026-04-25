/**
 * Aşama A — bariyer cap reddetme kuralı unit testleri.
 *
 * Senaryolar canlı dashboard kartlarından alındı (Risk Matrix v1.7 notu):
 *   LINKUSDT.P 240 LONG: entry 9.40, SL 9.22, capped 9.6155 → REDDET
 *   ETHUSDC 240 SHORT: entry 2317, SL 2426.87, capped 2260.14 → REDDET
 *   Hipotetik geniş mesafe → APPLY
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRefuseBarrierCap } from '../lib/alignment-filters.js';

test('1. LINKUSDT.P kanonik dashboard sinyali → cap REDDET', () => {
  const r = shouldRefuseBarrierCap({ entry: 9.40, sl: 9.22, capped: 9.6155 });
  assert.equal(r.refused, true, 'cap mesafesi (0.2155) < 1.3 × 0.18 = 0.234');
  assert.ok(Math.abs(r.slDist - 0.18) < 1e-6);
  assert.ok(Math.abs(r.cappedDist - 0.2155) < 1e-3);
  assert.ok(Math.abs(r.minTpDist - 0.234) < 1e-3);
});

test('2. ETHUSDC SHORT kanonik dashboard sinyali → cap REDDET', () => {
  const r = shouldRefuseBarrierCap({ entry: 2317, sl: 2426.87, capped: 2260.14 });
  assert.equal(r.refused, true, 'short SL üst, capped alt → cappedDist 56.86 < 1.3 × 109.87 = 142.83');
  assert.ok(Math.abs(r.slDist - 109.87) < 1e-3);
  assert.ok(Math.abs(r.cappedDist - 56.86) < 1e-3);
});

test('3. Yeterli mesafe → cap APPLY (refuse=false)', () => {
  // entry 100, SL 95 (slDist 5 → minTpDist 6.5), capped 110 (cappedDist 10) → 10 >= 6.5 → APPLY
  const r = shouldRefuseBarrierCap({ entry: 100, sl: 95, capped: 110 });
  assert.equal(r.refused, false);
  assert.equal(r.slDist, 5);
  assert.equal(r.cappedDist, 10);
  assert.equal(r.minTpDist, 6.5);
});

test('4. Tam sınır (cappedDist == minTpDist) → APPLY', () => {
  // 1.3 × 5 = 6.5; capped 106.5 → cappedDist 6.5 = minTpDist 6.5 → refused=false
  const r = shouldRefuseBarrierCap({ entry: 100, sl: 95, capped: 106.5 });
  assert.equal(r.refused, false);
});

test('5. Sınırın 1¢ altı → REDDET', () => {
  const r = shouldRefuseBarrierCap({ entry: 100, sl: 95, capped: 106.49 });
  assert.equal(r.refused, true);
});

test('6. minDistRatio özelleştirme — daha gevşek 1.0 ile aynı LINK → APPLY', () => {
  // Faz 4 unified-levels'te ratio rejime göre değişebilir; test edilebilirlik için
  const r = shouldRefuseBarrierCap({ entry: 9.40, sl: 9.22, capped: 9.6155, minDistRatio: 1.0 });
  assert.equal(r.refused, false, '1.0 ile cappedDist 0.2155 >= 0.18 → APPLY');
});
