/**
 * Faz 1 Iter 3 — regime-report.mjs unit testleri.
 *
 * Sentetik kayitlarla:
 *   - regimeDistribution % hesaplama
 *   - falseFlipAnalysis basit X→Y→X bastirma
 *   - bistStableDomesticRate
 *   - rateLimitHits unstable=true
 *   - chaosDurations chaos blok suresi
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  regimeDistribution,
  falseFlipAnalysis,
  hysteresisComparison,
  bistStableDomesticRate,
  rateLimitHits,
  chaosDurations,
} from '../scripts/regime-report.mjs';

function rec({ symbol = 'X', tf = '60', mt = 'crypto', regime = 'ranging',
  subRegime = null, rawRegime = null, transitioned = false, bars = 1,
  unstable = false, ts, _date = '2099-01-01' } = {}) {
  return {
    utcTimestamp: new Date(ts ?? Date.parse('2099-01-01T00:00:00Z')).toISOString(),
    symbol, timeframe: tf, marketType: mt,
    regime, subRegime, rawRegime: rawRegime || regime,
    confidence: 0.5, transitioned, barsSinceTransition: bars,
    transitionsToday: 1, unstable, newPositionAllowed: !unstable,
    strategyHint: null, notes: [],
    _logDate: _date,
  };
}

test('1. regimeDistribution: %-hesabi', () => {
  const recs = [
    rec({ regime: 'trending_up' }),
    rec({ regime: 'trending_up' }),
    rec({ regime: 'trending_up' }),
    rec({ regime: 'ranging' }),
  ];
  const d = regimeDistribution(recs);
  assert.equal(d.crypto._total, 4);
  assert.equal(d.crypto.trending_up.count, 3);
  assert.equal(d.crypto.trending_up.pct, 75);
  assert.equal(d.crypto.ranging.pct, 25);
});

test('2. falseFlipAnalysis: X→Y→X kucuk pencerede false-flip', () => {
  const T0 = Date.parse('2099-01-01T00:00:00Z');
  const recs = [
    rec({ transitioned: true, regime: 'trending_up', ts: T0 }),
    rec({ transitioned: true, regime: 'ranging', bars: 2, ts: T0 + 3600_000 }),
    rec({ transitioned: true, regime: 'trending_up', bars: 1, ts: T0 + 7200_000 }),
  ];
  const fa = falseFlipAnalysis(recs, 3);
  assert.equal(fa.totalFlips, 2);
  assert.equal(fa.falseFlips, 1);
  assert.equal(fa.examples.length, 1);
  assert.equal(fa.examples[0].via, 'ranging');
});

test('3. bistStableDomesticRate', () => {
  const recs = [
    rec({ mt: 'bist', subRegime: 'bist_tl_stable_domestic' }),
    rec({ mt: 'bist', subRegime: 'bist_normal_coupled' }),
    rec({ mt: 'bist', subRegime: 'bist_normal_coupled' }),
    rec({ mt: 'bist', subRegime: 'bist_normal_coupled' }),
  ];
  const b = bistStableDomesticRate(recs);
  assert.equal(b.total, 4);
  assert.equal(b.stableDomesticCount, 1);
  assert.equal(b.pct, 25);
});

test('4. rateLimitHits: unstable=true sembol-gun ciftleri', () => {
  const recs = [
    rec({ symbol: 'A', unstable: true, _date: '2099-01-01' }),
    rec({ symbol: 'A', unstable: true, _date: '2099-01-01' }),  // ayni gun
    rec({ symbol: 'A', unstable: true, _date: '2099-01-02' }),  // farkli gun
    rec({ symbol: 'B', unstable: true, _date: '2099-01-01' }),
    rec({ symbol: 'C', unstable: false }),
  ];
  const r = rateLimitHits(recs);
  assert.equal(r.distinctUnstableSymbolDays, 3);
});

test('5. chaosDurations: chaos blok suresi', () => {
  const T0 = Date.parse('2099-01-01T00:00:00Z');
  const recs = [
    rec({ regime: 'trending_up', ts: T0 }),
    rec({ regime: 'high_vol_chaos', ts: T0 + 3600_000 }),
    rec({ regime: 'high_vol_chaos', ts: T0 + 7200_000 }),
    rec({ regime: 'ranging', ts: T0 + 10800_000 }),  // chaos bitti, 2h surdu
  ];
  const cd = chaosDurations(recs, { _meta: {}, x: { typical: 60 } });
  assert.equal(cd.count, 1);
  assert.equal(cd.actualMedianMin, 120);
  assert.equal(cd.taxonomyMeanMin, 60);
});

test('6. hysteresisComparison: N=4 simulasyonu sayilari uretir', () => {
  const T0 = Date.parse('2099-01-01T00:00:00Z');
  const recs = [
    rec({ transitioned: true, regime: 'trending_up', rawRegime: 'trending_up', ts: T0 }),
    // Bu transition'dan sonraki bar farkli ham rejim → N=4'te bastırılırdı
    rec({ transitioned: false, regime: 'trending_up', rawRegime: 'ranging', ts: T0 + 3600_000 }),
  ];
  const h = hysteresisComparison(recs);
  assert.equal(h.n4Suppressed.totalTransitions, 1);
  assert.equal(h.n4Suppressed.wouldBeSuppressed, 1);
  assert.equal(h.n4Suppressed.suppressRate, 100);
});
