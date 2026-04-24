import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createStateStore } from '../src/lib/poller_state.js';

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-state-')); }

test('read returns empty state when file missing', () => {
  const dir = mktmp();
  const store = createStateStore({ filePath: path.join(dir, 'state.json') });
  const s = store.read();
  assert.deepStrictEqual(s.tickers, {});
  assert.strictEqual(s.circuitBreaker.status, 'closed');
});

test('write + read roundtrip preserves state', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp });
  store.write({
    asOf: '2026-04-24T17:45:20.000Z',
    tickers: {
      APH: { state: 'ARMED', trigger: 152.81, lastPrice: 150.38, lastPollAt: '2026-04-24T17:45:05.000Z', firedEventId: null },
    },
    circuitBreaker: { status: 'closed', consecutiveFailures: 0, openedAt: null },
  });
  const s = store.read();
  assert.strictEqual(s.tickers.APH.state, 'ARMED');
  assert.strictEqual(s.tickers.APH.trigger, 152.81);
});

test('isFresh returns false when snapshot is older than max age', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp, maxAgeMs: 10 * 60_000 });
  store.write({ asOf: '2026-04-24T00:00:00.000Z', tickers: {}, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.isFresh(new Date('2026-04-24T00:15:00.000Z')), false);
});

test('isFresh returns true when snapshot is within max age', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  const store = createStateStore({ filePath: fp, maxAgeMs: 10 * 60_000 });
  store.write({ asOf: '2026-04-24T00:00:00.000Z', tickers: {}, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.isFresh(new Date('2026-04-24T00:05:00.000Z')), true);
});

test('isFresh returns false when file is missing', () => {
  const dir = mktmp();
  const store = createStateStore({ filePath: path.join(dir, 'never.json') });
  assert.strictEqual(store.isFresh(), false);
});

test('write survives malformed prior file', () => {
  const dir = mktmp();
  const fp = path.join(dir, 'state.json');
  fs.writeFileSync(fp, '{not json');
  const store = createStateStore({ filePath: fp });
  const s = store.read();
  assert.deepStrictEqual(s.tickers, {}, 'falls back to empty state on parse error');
  store.write({ asOf: 't', tickers: { X: { state: 'ARMED' } }, circuitBreaker: { status: 'closed' } });
  assert.strictEqual(store.read().tickers.X.state, 'ARMED');
});
