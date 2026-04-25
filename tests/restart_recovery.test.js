import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFireLog } from '../src/lib/fire_events.js';
import { createFireDetector } from '../src/lib/fire_detector.js';

// Simulate the F1+F2 boot logic: rebuild detector state from today's fire log,
// then verify a 3rd attempted fire is suppressed by daily_cap.
test('restart recovery: detector seeded from fire log honors maxFiresPerDay', () => {
  // Setup: temp dir with today's fire log seeded with 2 fires for ticker X
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-restart-'));
  const log = createFireLog({ baseDir: dir });

  // Seed two fires for X today
  log.recordFire({
    ticker: 'X',
    trigger: { level: 100 },
    price: { firedPrice: 101 },
    fireStrength: 2,
    timestamp: new Date().toISOString(),
  });
  log.recordFire({
    ticker: 'X',
    trigger: { level: 100 },
    price: { firedPrice: 102 },
    fireStrength: 2,
    timestamp: new Date().toISOString(),
  });

  // Simulate restart: detector starts empty, seeds from fire log
  const detector = createFireDetector({ confirmPolls: 2, maxFiresPerDay: 2, hysteresisPct: 0.5 });
  const todaysFires = log.getTodaysFires();
  assert.strictEqual(todaysFires.length, 2, 'two fires seeded');

  const byTicker = {};
  for (const f of todaysFires) {
    if (!byTicker[f.ticker]) byTicker[f.ticker] = [];
    byTicker[f.ticker].push(f);
  }
  for (const [ticker, fires] of Object.entries(byTicker)) {
    const trigger = fires[fires.length - 1]?.trigger?.level;
    detector.upsertTicker({ symbol: ticker, trigger });
    const maxLevel = fires.reduce((max, f) => Math.max(max, f.fireStrength || 0), 0);
    detector.restoreState({
      [ticker]: {
        symbol: ticker,
        trigger,
        state: 'FIRED',
        firesToday: fires.length,
        lastFireLevel: maxLevel,
        fireStrength: maxLevel,
        confirmsSeen: 0,
        pendingSince: null,
        firstCrossObservedAt: null,
        firedEventId: null,
        lastSuppression: null,
        lastPrice: null,
      },
    });
  }

  // Verify state: ticker is FIRED with firesToday=2
  const state = detector.getState('X');
  assert.strictEqual(state.state, 'FIRED');
  assert.strictEqual(state.firesToday, 2);

  // Now drive a 3rd would-be fire: drop below trigger (re-arm via hysteresis),
  // then re-cross. Cap must suppress emission.
  detector.observe('X', { price: 99, quoteAgeMs: 100 });   // hysteresis re-arm (price < 99.5)
  detector.observe('X', { price: 101, quoteAgeMs: 100 });  // PENDING
  const result = detector.observe('X', { price: 101, quoteAgeMs: 100 }); // would-be FIRE — suppressed
  assert.strictEqual(result.fired, false, 'third fire suppressed by daily cap');
  const stateAfter = detector.getState('X');
  assert.strictEqual(stateAfter.firesToday, 2, 'firesToday cap held at 2 after restart');
  assert.ok(stateAfter.lastSuppression);
  assert.strictEqual(stateAfter.lastSuppression.reason, 'daily_cap');
});
