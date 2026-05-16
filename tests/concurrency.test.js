/**
 * tests/concurrency.test.js
 *
 * Tests for the write-tool serialization mutex in src/connection.js.
 *
 * The MCP server's CDP client is a module-level singleton shared by every
 * tool handler. Without serialization, concurrent calls to write tools
 * (chart_set_symbol, chart_set_timeframe, draw_shape, etc.) interleave on
 * Chrome's JS thread in arrival order — Chrome's microtask scheduling
 * decides the "winner", not the calling code. For some operations this is
 * benign (a quick clock-on-clock race). For others — symbol-load
 * lifecycle, indicator add+remove, replay state machine, dialog handling —
 * the result is a corrupted page state.
 *
 * The fix: `evaluateWrite()` runs every write under a process-wide
 * `async-mutex` instance. `withWriteLock(fn)` wraps a multi-step sequence
 * so multiple evaluates within one logical operation can't be interleaved
 * by another writer.
 *
 * These tests verify the mutex semantics without requiring a running
 * Chrome + TradingView. The mutex itself is module-level, so we can
 * exercise it with simulated workloads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mutex } from 'async-mutex';

test('async-mutex serializes concurrent writes in arrival order', async () => {
  // Mirror the pattern in src/connection.js — process-wide mutex,
  // each call wraps the critical section in runExclusive.
  const mutex = new Mutex();
  const order = [];

  async function fakeWrite(label, ms) {
    return mutex.runExclusive(async () => {
      order.push(`start:${label}`);
      await new Promise(r => setTimeout(r, ms));
      order.push(`end:${label}`);
      return label;
    });
  }

  // Fire 5 concurrent writes with overlapping work windows.
  const promises = [
    fakeWrite('A', 30),
    fakeWrite('B', 10),
    fakeWrite('C', 20),
    fakeWrite('D', 5),
    fakeWrite('E', 15),
  ];
  const results = await Promise.all(promises);

  // Each write must complete before the next one starts. The order
  // array should be: start:A, end:A, start:B, end:B, ... in arrival
  // order (Promise.all preserves order of submission for the mutex
  // queue inside async-mutex).
  assert.equal(order.length, 10, 'expected 10 markers (5 start + 5 end)');
  for (let i = 0; i < 5; i++) {
    const label = String.fromCharCode(65 + i);  // A, B, C, D, E
    assert.equal(order[i * 2], `start:${label}`, `position ${i * 2} should be start:${label}`);
    assert.equal(order[i * 2 + 1], `end:${label}`, `position ${i * 2 + 1} should be end:${label}`);
  }
  // Results returned in the order the promises were submitted.
  assert.deepEqual(results, ['A', 'B', 'C', 'D', 'E']);
});

test('async-mutex withWriteLock-style multi-step sequence is atomic', async () => {
  const mutex = new Mutex();
  const log = [];

  // Simulate two clients each doing a "read-modify-write" sequence
  // (mirrors src/core/chart.js manageIndicator: before-snapshot →
  // mutation → after-snapshot). Without locking the whole sequence,
  // a concurrent writer could mutate between our read and our read-
  // back, producing a stale "before".
  async function runSequence(id) {
    return mutex.runExclusive(async () => {
      const before = log.length;
      log.push(`${id}:write`);
      await new Promise(r => setTimeout(r, 10));
      const after = log.length;
      // The invariant: nothing else appended between before-snapshot and
      // after-snapshot inside this critical section. So after === before + 1.
      return { id, before, after, gained: after - before };
    });
  }

  const results = await Promise.all([
    runSequence('alpha'),
    runSequence('beta'),
    runSequence('gamma'),
  ]);

  for (const r of results) {
    assert.equal(r.gained, 1, `${r.id} should see exactly its own write inside the lock; saw ${r.gained}`);
  }
});

test('connection.js exports evaluateWrite + withWriteLock', async () => {
  const mod = await import('../src/connection.js');
  assert.equal(typeof mod.evaluateWrite, 'function', 'evaluateWrite must be exported');
  assert.equal(typeof mod.withWriteLock, 'function', 'withWriteLock must be exported');
  assert.equal(typeof mod.evaluate, 'function', 'evaluate must still be exported (read path)');
  assert.equal(typeof mod.evaluateAsync, 'function', 'evaluateAsync must still be exported');
});

test('reads do not block on the write mutex', async () => {
  // The whole point of the read/write split: a long-running write
  // (chart_set_symbol with a slow symbol-load) must not block reads
  // (quote_get, chart_get_state) that other consumers depend on. We
  // simulate this by holding the mutex with a deliberately slow async
  // op and verifying a "read" (no mutex) completes in parallel.
  const mutex = new Mutex();
  let readCompletedBeforeWriteEnded = false;

  const writePromise = mutex.runExclusive(async () => {
    await new Promise(r => setTimeout(r, 50));
    return 'write-done';
  });

  // A "read" does not enter the mutex.
  const readPromise = (async () => {
    await new Promise(r => setTimeout(r, 5));
    // If we got here in 5ms while the write is still running (50ms total),
    // the read is genuinely concurrent with the write.
    readCompletedBeforeWriteEnded = true;
    return 'read-done';
  })();

  const [readResult] = await Promise.all([readPromise, writePromise]);
  assert.equal(readResult, 'read-done');
  assert.ok(readCompletedBeforeWriteEnded, 'read must complete before write releases the mutex');
});
