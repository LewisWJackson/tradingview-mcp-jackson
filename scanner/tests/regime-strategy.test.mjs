/**
 * Faz 2 Commit 1 — regime-strategy.js wrapper unit testleri.
 *
 * Kapsam (docs/phase-2-design.md §3 + §6.5):
 *   - Vote suppression: ranging'de momentum bastırılır, mean-reversion öne çıkar
 *   - Gate kontrolleri: REGIME_GATES eşik kuralları
 *   - chaos/drift/closed: anında red
 *   - BIST decoupled_stress: long red, short serbest (gate'e tabi)
 *   - SL multiplier rejim profilinden
 *   - Shadow mode: wouldDispatch bayrağı doğru, dispatch=false
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  applyRegimeStrategy,
  suppressVotes,
  checkGates,
  __internals,
} from '../lib/learning/regime-strategy.js';
import { _resetWrapperMode, setWrapperMode } from '../lib/learning/wrapper-mode.js';

// Test başında shadow mode default
beforeEach(() => {
  _resetWrapperMode();
});

// Test sonrası test log'larını temizle
after(() => {
  const dir = './scanner/data';
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter(x => x.startsWith('wrapper-decisions-'))) {
    try { fs.unlinkSync(`${dir}/${f}`); } catch {}
  }
});

// ---------------------------------------------------------------------------
// suppressVotes — vote family bazlı ağırlıklandırma
// ---------------------------------------------------------------------------

test('1. suppressVotes ranging: momentum 0.3, mean_reversion 1.5', () => {
  const votes = [
    { indicator: 'macd_trend', direction: 'long', weight: 1.0 },
    { indicator: 'ema_cross', direction: 'long', weight: 1.0 },
    { indicator: 'rsi_oversold', direction: 'long', weight: 1.0 },
    { indicator: 'smc_bos_bullish', direction: 'long', weight: 1.0 },
  ];
  const r = suppressVotes(votes, 'ranging');
  const macd = r.adjusted.find(v => v.indicator === 'macd_trend');
  const rsi = r.adjusted.find(v => v.indicator === 'rsi_oversold');
  const smc = r.adjusted.find(v => v.indicator === 'smc_bos_bullish');
  assert.ok(Math.abs(macd.weight - 0.3) < 1e-6, 'momentum 0.3');
  assert.ok(Math.abs(rsi.weight - 1.5) < 1e-6, 'mean_reversion 1.5');
  assert.equal(smc.weight, 1.0, 'smc_structural nötr');
  assert.ok(r.boostedKeys.includes('rsi_oversold'));
});

test('2. suppressVotes high_vol_chaos: hepsi 0', () => {
  const votes = [
    { indicator: 'macd_trend', weight: 1.0 },
    { indicator: 'rsi_oversold', weight: 1.0 },
    { indicator: 'smc_bos_bullish', weight: 1.0 },
  ];
  const r = suppressVotes(votes, 'high_vol_chaos');
  for (const v of r.adjusted) assert.equal(v.weight, 0);
  assert.equal(r.suppressedKeys.length, 3);
});

test('3. suppressVotes trending_up: momentum 1.0, mean_reversion 0.5', () => {
  const votes = [
    { indicator: 'macd_trend', weight: 1.0 },
    { indicator: 'rsi_oversold', weight: 1.0 },
  ];
  const r = suppressVotes(votes, 'trending_up');
  const macd = r.adjusted.find(v => v.indicator === 'macd_trend');
  const rsi = r.adjusted.find(v => v.indicator === 'rsi_oversold');
  assert.equal(macd.weight, 1.0);
  assert.ok(Math.abs(rsi.weight - 0.5) < 1e-6);
});

// ---------------------------------------------------------------------------
// checkGates — REGIME_GATES tablosu
// ---------------------------------------------------------------------------

test('4. checkGates trending_up B grade pass', () => {
  const r = checkGates({ regime: 'trending_up', draftGrade: 'B', htfConfidence: 70, mtfAlignment: 80 });
  assert.equal(r.pass, true);
  assert.equal(r.decision, 'PASS');
});

test('5. checkGates trending_up C grade fail (gate B)', () => {
  const r = checkGates({ regime: 'trending_up', draftGrade: 'C', htfConfidence: 70, mtfAlignment: 80 });
  assert.equal(r.pass, false);
  assert.equal(r.decision, 'REJECT_GATE_GRADE');
});

test('6. checkGates ranging C grade pass (gate gevşek)', () => {
  const r = checkGates({ regime: 'ranging', draftGrade: 'C', htfConfidence: 50, mtfAlignment: 65 });
  assert.equal(r.pass, true);
});

test('7. checkGates ranging MTF 50 < 60 fail', () => {
  const r = checkGates({ regime: 'ranging', draftGrade: 'C', htfConfidence: 50, mtfAlignment: 50 });
  assert.equal(r.pass, false);
  assert.equal(r.decision, 'REJECT_GATE_MTF');
});

test('8. checkGates high_vol_chaos hep red', () => {
  const r = checkGates({ regime: 'high_vol_chaos', draftGrade: 'A', htfConfidence: 100, mtfAlignment: 100 });
  assert.equal(r.pass, false);
  assert.equal(r.decision, 'REJECT_CHAOS');
});

test('9. checkGates low_vol_drift hep red', () => {
  const r = checkGates({ regime: 'low_vol_drift', draftGrade: 'A' });
  assert.equal(r.pass, false);
  assert.equal(r.decision, 'REJECT_DRIFT');
});

// ---------------------------------------------------------------------------
// applyRegimeStrategy — entegre senaryolar
// ---------------------------------------------------------------------------

test('10. applyRegimeStrategy ranging C grade → PASS, momentum bastırıldı', () => {
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'ranging', newPositionAllowed: true, confidence: 0.7 },
    votes: [
      { indicator: 'macd_trend', weight: 1.0 },
      { indicator: 'rsi_oversold', weight: 1.0 },
    ],
    signalDraft: { direction: 'long', grade: 'C' },
    htfConfidence: 50, mtfAlignment: 65,
    symbol: 'BTCUSD', timeframe: '60', marketType: 'crypto',
  });
  assert.equal(out.rejected, false);
  assert.equal(out.decision, 'PASS');
  assert.equal(out.slMultiplier, 1.5);
  assert.equal(out.tpProfile, 'tight');
  assert.ok(out.boostedVotes.includes('rsi_oversold'));
  assert.equal(out.shadowMode, true);
  assert.equal(out.wouldDispatch, true);  // gate pass ama shadow → dispatch yok
});

test('11. applyRegimeStrategy chaos → REJECT', () => {
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'high_vol_chaos', newPositionAllowed: false },
    votes: [{ indicator: 'macd_trend', weight: 1.0 }],
    signalDraft: { direction: 'long', grade: 'A' },
  });
  assert.equal(out.rejected, true);
  assert.equal(out.decision, 'REJECT_CHAOS');
  assert.equal(out.wouldDispatch, false);
});

test('12. applyRegimeStrategy bist_decoupled_stress + long → REJECT_BIST_LONG', () => {
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'high_vol_chaos', subRegime: 'bist_decoupled_stress', newPositionAllowed: false },
    votes: [],
    signalDraft: { direction: 'long', grade: 'A' },
  });
  assert.equal(out.rejected, true);
  // newPositionAllowed=false önce yakalar
  assert.ok(['REJECT_CHAOS', 'REJECT_BIST_LONG'].includes(out.decision));
});

test('13. applyRegimeStrategy bist_decoupled_stress + long allowed → REJECT_BIST_LONG (özel kural)', () => {
  // Hipotetik: newPositionAllowed=true ama subRegime stress + long
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'ranging', subRegime: 'bist_decoupled_stress', newPositionAllowed: true },
    votes: [],
    signalDraft: { direction: 'long', grade: 'B' },
  });
  assert.equal(out.rejected, true);
  assert.equal(out.decision, 'REJECT_BIST_LONG');
});

test('14. applyRegimeStrategy live mode → wouldDispatch geçer, shadowMode=false', () => {
  setWrapperMode({ mode: 'live', by: 'unit_test' });
  const out = applyRegimeStrategy({
    regimeContext: { regime: 'trending_up', newPositionAllowed: true },
    votes: [{ indicator: 'macd_trend', weight: 1.0 }],
    signalDraft: { direction: 'long', grade: 'B' },
    htfConfidence: 70, mtfAlignment: 80,
  });
  assert.equal(out.shadowMode, false);
  assert.equal(out.wouldDispatch, true);
});

test('15. JSONL log üretildi mi?', () => {
  applyRegimeStrategy({
    regimeContext: { regime: 'ranging', newPositionAllowed: true },
    votes: [{ indicator: 'rsi_oversold', weight: 1.0 }],
    signalDraft: { direction: 'long', grade: 'C' },
    symbol: 'TESTSYM', timeframe: '60', marketType: 'crypto',
    htfConfidence: 50, mtfAlignment: 65,
  });
  const today = new Date().toISOString().slice(0, 10);
  const path = `./scanner/data/wrapper-decisions-${today}.jsonl`;
  assert.ok(fs.existsSync(path), 'log dosyası yok');
  const lines = fs.readFileSync(path, 'utf8').trim().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.symbol, 'TESTSYM');
  assert.equal(last.regime, 'ranging');
});
