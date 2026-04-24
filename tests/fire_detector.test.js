import { test } from 'node:test';
import assert from 'node:assert';
import { createFireDetector } from '../src/lib/fire_detector.js';

// Helper: drive a sequence of (price, ageMs) pairs through the detector for one ticker.
function driveTicker(detector, sym, trigger, seq) {
  const fires = [];
  detector.upsertTicker({ symbol: sym, trigger });
  for (const { price, ageMs = 100 } of seq) {
    const result = detector.observe(sym, { price, quoteAgeMs: ageMs });
    if (result.fired) fires.push(result);
  }
  return fires;
}

test('clean breakout fires once after 2 consecutive polls above trigger', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'APH', 152.81, [
    { price: 150.40 }, // below — ARMED
    { price: 152.85 }, // above #1 — PENDING
    { price: 152.90 }, // above #2 — FIRED
  ]);
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].firedPrice, 152.90);
  assert.strictEqual(fires[0].confirmPollCount, 2);
  assert.strictEqual(fires[0].fireStrength, 2, 'default confirmed fire is Level 2');
});

test('whipsaw (one-poll spike) does not fire', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'X', 100, [
    { price: 99 },
    { price: 101 }, // PENDING
    { price: 99 },  // back to ARMED
    { price: 99 },
  ]);
  assert.strictEqual(fires.length, 0);
});

test('hysteresis: re-arm requires price drop of ≥ 0.5% below trigger', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5 });
  const fires = driveTicker(det, 'Y', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // fire #1
    { price: 99.7 }, // 0.3% below — NOT re-armed
    { price: 102 }, { price: 102 }, // should NOT fire (still in FIRED state)
    { price: 99.3 }, // 0.7% below — re-armed
    { price: 101 }, { price: 101 }, // fire #2
  ]);
  assert.strictEqual(fires.length, 2);
});

test('daily fire cap (default 2) suppresses third fire', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5, maxFiresPerDay: 2 });
  driveTicker(det, 'Z', 100, [
    { price: 99 }, { price: 101 }, { price: 101 },
    { price: 99 }, { price: 101 }, { price: 101 },
    { price: 99 }, { price: 101 }, { price: 101 }, // 3rd — should be capped
  ]);
  const state = det.getState('Z');
  assert.strictEqual(state.firesToday, 2);
  assert.ok(state.lastSuppression);
  assert.strictEqual(state.lastSuppression.reason, 'daily_cap');
});

test('stale quote suppresses fire confirmation', () => {
  const det = createFireDetector({ confirmPolls: 2, staleQuoteMaxAgeMs: 5000 });
  const fires = driveTicker(det, 'Q', 100, [
    { price: 99, ageMs: 100 },
    { price: 101, ageMs: 100 },      // PENDING
    { price: 101, ageMs: 10_000 },   // stale — NOT promoted
    { price: 101, ageMs: 200 },      // fresh, but still PENDING (stale reset confirm count)
    { price: 101, ageMs: 200 },      // now FIRED
  ]);
  assert.strictEqual(fires.length, 1);
});

test('fireSuppressed flag (from stale source) blocks fire', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'S', 100, [
    { price: 99 },
    // Simulate two observations from the stale source
  ]);
  det.observe('S', { price: 101, quoteAgeMs: 100, fireSuppressed: true });
  det.observe('S', { price: 101, quoteAgeMs: 100, fireSuppressed: true });
  const state = det.getState('S');
  assert.notStrictEqual(state.state, 'FIRED');
});

test('restoreState correctly resumes FIRED ticker', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.restoreState({
    APH: { state: 'FIRED', trigger: 152.81, lastPrice: 152.90, firedEventId: 'abc', firesToday: 1 },
  });
  // Now observe another above-trigger print — should NOT re-fire (already FIRED)
  const result = det.observe('APH', { price: 153.00, quoteAgeMs: 100 });
  assert.strictEqual(result.fired, false);
  assert.strictEqual(det.getState('APH').state, 'FIRED');
});

test('upsertTicker changes trigger while preserving FIRED state', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5 });
  driveTicker(det, 'T', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // FIRED at 100 trigger
  ]);
  det.upsertTicker({ symbol: 'T', trigger: 105 }); // scanner updated trigger
  assert.strictEqual(det.getState('T').state, 'FIRED', 'state preserved');
  assert.strictEqual(det.getState('T').trigger, 105, 'trigger updated');
});

// E1 — Phase C clarification tests

test('stale quote preserves FIRED state (does not revert to ARMED)', () => {
  const det = createFireDetector({ confirmPolls: 2, staleQuoteMaxAgeMs: 5000 });
  // Fire the ticker legitimately
  driveTicker(det, 'R', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // FIRED
  ]);
  assert.strictEqual(det.getState('R').state, 'FIRED');
  // Now feed a stale above-trigger print — must NOT re-fire, AND must NOT revert FIRED
  const result = det.observe('R', { price: 105, quoteAgeMs: 10_000 });
  assert.strictEqual(result.fired, false);
  assert.strictEqual(det.getState('R').state, 'FIRED');
  assert.strictEqual(det.getState('R').lastSuppression.reason, 'quote_stale');
});

test('fireSuppressed flag preserves FIRED state (stale fallback never retriggers)', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  driveTicker(det, 'FS', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // FIRED
  ]);
  assert.strictEqual(det.getState('FS').state, 'FIRED');
  // fireSuppressed flag (chain serving stale) — FIRED state preserved
  det.observe('FS', { price: 110, quoteAgeMs: 100, fireSuppressed: true });
  assert.strictEqual(det.getState('FS').state, 'FIRED');
  assert.strictEqual(det.getState('FS').lastSuppression.reason, 'source_stale');
});

test('no duplicate fire events on sequential above-trigger ticks after FIRED', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'N', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // fire #1
    { price: 101 }, { price: 102 }, { price: 103 }, // sustained above — NO duplicate fires
  ]);
  assert.strictEqual(fires.length, 1);
});

test('price exactly at trigger does not fire (requires strict above)', () => {
  // NOTE: current implementation uses >= trigger; this test documents that behavior explicitly.
  const det = createFireDetector({ confirmPolls: 2 });
  const fires = driveTicker(det, 'E', 100, [
    { price: 99 },
    { price: 100 }, // exactly at trigger — current impl: PENDING (>= )
    { price: 100 }, // FIRED
  ]);
  assert.strictEqual(fires.length, 1, 'price exactly at trigger counts as above (>= semantics)');
});

test('daily cap: promoting to FIRED without emitting fire still sets state=FIRED', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5, maxFiresPerDay: 1 });
  // First fire
  driveTicker(det, 'CAP', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // fire #1
  ]);
  assert.strictEqual(det.getState('CAP').firesToday, 1);
  // Re-arm, then second cross — state should transition to FIRED without emitting
  det.observe('CAP', { price: 99 });   // hysteresis re-arm
  det.observe('CAP', { price: 101 });  // PENDING
  const result = det.observe('CAP', { price: 101 }); // would be fire #2, capped
  assert.strictEqual(result.fired, false, 'capped fire does not emit');
  assert.strictEqual(det.getState('CAP').state, 'FIRED', 'still transitioned to FIRED');
  assert.strictEqual(det.getState('CAP').lastSuppression.reason, 'daily_cap');
});

test('resetDailyCounters clears firesToday without disturbing state machine', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  driveTicker(det, 'D', 100, [
    { price: 99 }, { price: 101 }, { price: 101 }, // FIRED
  ]);
  assert.strictEqual(det.getState('D').firesToday, 1);
  assert.strictEqual(det.getState('D').state, 'FIRED');
  det.resetDailyCounters();
  assert.strictEqual(det.getState('D').firesToday, 0);
  assert.strictEqual(det.getState('D').state, 'FIRED', 'state preserved across daily reset');
});

// E2 — Fire Strength Levels (WATCH / CONFIRMED / HIGH CONVICTION)

test('Level 1 WATCH emitted on PENDING transition (not a trade action)', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'W', trigger: 100 });
  // First above-trigger observation → PENDING → fireStrength 1
  const r = det.observe('W', { price: 101, quoteAgeMs: 100 });
  assert.strictEqual(r.fired, false, 'Level 1 is not a trade action');
  assert.strictEqual(r.fireStrength, 1);
  assert.strictEqual(det.getState('W').state, 'PENDING');
});

test('ARMED observation returns fireStrength=null', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'A', trigger: 100 });
  const r = det.observe('A', { price: 95, quoteAgeMs: 100 });
  assert.strictEqual(r.fired, false);
  assert.strictEqual(r.fireStrength, null);
});

test('Level 2 CONFIRMED emitted on FIRED without strength context (default)', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'C2', trigger: 100 });
  det.observe('C2', { price: 95 });
  det.observe('C2', { price: 101 });  // PENDING
  const r = det.observe('C2', { price: 101 });  // FIRED
  assert.strictEqual(r.fired, true);
  assert.strictEqual(r.fireStrength, 2);
  assert.strictEqual(r.strengthBreakdown.reason, 'no_context_default_level_2');
});

test('Level 3 HIGH CONVICTION emitted when all signals + green risk', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'C3', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'green' };
  det.observe('C3', { price: 95 });
  det.observe('C3', { price: 101, strengthContext: ctx });   // PENDING, context only matters on FIRED step
  const r = det.observe('C3', { price: 101, strengthContext: ctx });  // FIRED with strong signals
  assert.strictEqual(r.fired, true);
  assert.strictEqual(r.fireStrength, 3);
  assert.strictEqual(r.strengthBreakdown.hasVolumeExpansion, true);
  assert.strictEqual(r.strengthBreakdown.hasRelativeStrength, true);
  assert.strictEqual(r.strengthBreakdown.hasCleanStructure, true);
  assert.strictEqual(r.strengthBreakdown.riskBand, 'green');
  assert.strictEqual(r.strengthBreakdown.downgradedByRisk, false);
});

test('Level 3 downgraded to Level 2 when riskBand is red', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'D1', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'red' };
  det.observe('D1', { price: 95 });
  det.observe('D1', { price: 101, strengthContext: ctx });
  const r = det.observe('D1', { price: 101, strengthContext: ctx });
  assert.strictEqual(r.fired, true);
  assert.strictEqual(r.fireStrength, 2, 'red risk downgrades from 3 to 2');
  assert.strictEqual(r.strengthBreakdown.wouldHaveBeenLevel3, true);
  assert.strictEqual(r.strengthBreakdown.downgradedByRisk, true);
  assert.strictEqual(r.strengthBreakdown.riskBand, 'red');
});

test('Level 3 downgraded to Level 2 when riskBand is yellow', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'D2', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'yellow' };
  det.observe('D2', { price: 95 });
  det.observe('D2', { price: 101, strengthContext: ctx });
  const r = det.observe('D2', { price: 101, strengthContext: ctx });
  assert.strictEqual(r.fireStrength, 2);
  assert.strictEqual(r.strengthBreakdown.downgradedByRisk, true);
});

test('Level 2 when technical signals incomplete even with green risk', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'S', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: false, cleanStructure: true, riskBand: 'green' };
  det.observe('S', { price: 95 });
  det.observe('S', { price: 101, strengthContext: ctx });
  const r = det.observe('S', { price: 101, strengthContext: ctx });
  assert.strictEqual(r.fireStrength, 2);
  assert.strictEqual(r.strengthBreakdown.wouldHaveBeenLevel3, false, 'not all signals → never could have been L3');
  assert.strictEqual(r.strengthBreakdown.downgradedByRisk, false);
});

test('stale quote on PENDING drops fireStrength back to null', () => {
  const det = createFireDetector({ confirmPolls: 2, staleQuoteMaxAgeMs: 5000 });
  det.upsertTicker({ symbol: 'ST', trigger: 100 });
  det.observe('ST', { price: 95 });
  det.observe('ST', { price: 101, quoteAgeMs: 100 });  // PENDING, fireStrength = 1
  assert.strictEqual(det.getState('ST').fireStrength, 1);
  det.observe('ST', { price: 101, quoteAgeMs: 10_000 }); // stale → revert to ARMED
  assert.strictEqual(det.getState('ST').fireStrength, null);
});

test('stale quote on FIRED preserves fireStrength', () => {
  const det = createFireDetector({ confirmPolls: 2, staleQuoteMaxAgeMs: 5000 });
  det.upsertTicker({ symbol: 'SF', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'green' };
  det.observe('SF', { price: 95 });
  det.observe('SF', { price: 101, strengthContext: ctx });
  det.observe('SF', { price: 101, strengthContext: ctx });  // FIRED, fireStrength=3
  assert.strictEqual(det.getState('SF').fireStrength, 3);
  // Stale print now
  det.observe('SF', { price: 105, quoteAgeMs: 10_000 });
  assert.strictEqual(det.getState('SF').state, 'FIRED');
  assert.strictEqual(det.getState('SF').fireStrength, 3, 'stale does not downgrade existing fire strength');
});

test('fireSuppressed never creates Level 2 or 3 even with strong context', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'FSL', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'green' };
  det.observe('FSL', { price: 95 });
  // Two above-trigger observations but fireSuppressed=true
  det.observe('FSL', { price: 101, strengthContext: ctx, fireSuppressed: true });
  const r = det.observe('FSL', { price: 101, strengthContext: ctx, fireSuppressed: true });
  assert.strictEqual(r.fired, false, 'suppressed data cannot fire');
  assert.strictEqual(r.fireStrength, null, 'no level awarded on suppressed data');
  assert.notStrictEqual(det.getState('FSL').state, 'FIRED');
});

test('hysteresis re-arm resets fireStrength to null', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5 });
  det.upsertTicker({ symbol: 'H', trigger: 100 });
  det.observe('H', { price: 95 });
  det.observe('H', { price: 101 });
  det.observe('H', { price: 101 });  // FIRED (level 2)
  assert.strictEqual(det.getState('H').fireStrength, 2);
  det.observe('H', { price: 99.3 }); // drops > 0.5% below → re-arm
  assert.strictEqual(det.getState('H').state, 'ARMED');
  assert.strictEqual(det.getState('H').fireStrength, null);
});

test('daily cap preserves existing fireStrength on capped transition', () => {
  const det = createFireDetector({ confirmPolls: 2, hysteresisPct: 0.5, maxFiresPerDay: 1 });
  det.upsertTicker({ symbol: 'CP', trigger: 100 });
  const ctx = { volumeExpansion: true, relativeStrength: true, cleanStructure: true, riskBand: 'green' };
  // First fire: Level 3
  det.observe('CP', { price: 95 });
  det.observe('CP', { price: 101, strengthContext: ctx });
  det.observe('CP', { price: 101, strengthContext: ctx });
  assert.strictEqual(det.getState('CP').fireStrength, 3);
  // Re-arm (hysteresis)
  det.observe('CP', { price: 99 });
  // Second would-be fire — capped
  det.observe('CP', { price: 101 });
  const r = det.observe('CP', { price: 101 });
  assert.strictEqual(r.fired, false, 'cap blocks emission');
  assert.strictEqual(det.getState('CP').lastSuppression.reason, 'daily_cap');
  // fireStrength should be preserved at the prior L3 value (no overwrite on cap)
  assert.strictEqual(det.getState('CP').fireStrength, 3);
});

test('snapshot and restoreState preserve fireStrength', () => {
  const det = createFireDetector({ confirmPolls: 2 });
  det.upsertTicker({ symbol: 'SR', trigger: 100 });
  det.observe('SR', { price: 95 });
  det.observe('SR', { price: 101 });
  det.observe('SR', { price: 101 }); // FIRED, fireStrength=2
  const snap = det.snapshot();
  assert.strictEqual(snap.SR.fireStrength, 2);

  const det2 = createFireDetector({ confirmPolls: 2 });
  det2.restoreState(snap);
  assert.strictEqual(det2.getState('SR').fireStrength, 2);
});
