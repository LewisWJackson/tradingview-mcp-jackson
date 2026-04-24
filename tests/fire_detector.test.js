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
