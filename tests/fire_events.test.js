import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createFireLog } from '../src/lib/fire_events.js';

function mktmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-fire-')); }

test('recordFire writes a new file with one entry', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  const event = log.recordFire({
    ticker: 'LIN',
    trigger: 510.41,
    firedPrice: 510.56,
    timestamp: '2026-04-24T17:45:13.000Z',
    confidence: 'MODERATE',
    setupType: 'building_base',
    rank: 15,
  });
  assert.ok(event.eventId);
  assert.strictEqual(event.ticker, 'LIN');
  const files = fs.readdirSync(dir).filter(f => f.startsWith('coiled_spring_fires_'));
  assert.strictEqual(files.length, 1);
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(parsed.fires.length, 1);
  assert.strictEqual(parsed.fires[0].ticker, 'LIN');
});

test('recordFire appends to existing file on same trading day', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'A', trigger: 10, firedPrice: 11, timestamp: '2026-04-24T17:00:00.000Z' });
  log.recordFire({ ticker: 'B', trigger: 20, firedPrice: 21, timestamp: '2026-04-24T17:30:00.000Z' });
  const files = fs.readdirSync(dir).filter(f => f.startsWith('coiled_spring_fires_'));
  assert.strictEqual(files.length, 1, 'same trading day → one file');
  const parsed = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  assert.strictEqual(parsed.fires.length, 2);
});

test('getTodaysFires returns empty when nothing logged', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  assert.deepStrictEqual(log.getTodaysFires(new Date('2026-04-24T17:00:00Z')), []);
});

test('getTodaysFires returns events for the ET trading day', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'X', trigger: 1, firedPrice: 2, timestamp: '2026-04-24T23:00:00.000Z' }); // 7 PM ET (after close — same trading day)
  const fires = log.getTodaysFires(new Date('2026-04-24T23:00:00Z'));
  assert.strictEqual(fires.length, 1);
});

test('fire event preserves all audit fields when provided', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  const event = log.recordFire({
    ticker: 'APH', trigger: 152.81, firedPrice: 152.83,
    timestamp: '2026-04-24T18:00:00.000Z',
    confidence: 'HIGH', setupType: 'building_base', rank: 6,
    pollSequence: 847, scanRunId: '2026-04-24T17:00:00Z',
    price: { bid: 152.80, ask: 152.86, spreadAbsolute: 0.06, spreadPctOfPrice: 0.04, quoteSource: 'yahoo', quoteAgeMs: 312 },
    debounce: { confirmPollCount: 2, firstCrossObservedAt: '2026-04-24T17:59:45.000Z', confirmedAt: '2026-04-24T18:00:00.000Z' },
    marketContext: { vix: 18.63, vixRegime: 'constructive' },
    riskFlags: { overallRiskBand: 'green', earnings: { active: false } },
  });
  assert.strictEqual(event.price.spreadPctOfPrice, 0.04);
  assert.strictEqual(event.riskFlags.overallRiskBand, 'green');
  assert.ok(event.eventId);
});

test('getFiresForDate returns events for an arbitrary date', () => {
  const dir = mktmp();
  const log = createFireLog({ baseDir: dir });
  log.recordFire({ ticker: 'OLD', trigger: 1, firedPrice: 2, timestamp: '2026-04-22T17:00:00.000Z' });
  log.recordFire({ ticker: 'NEW', trigger: 1, firedPrice: 2, timestamp: '2026-04-24T17:00:00.000Z' });
  assert.strictEqual(log.getFiresForDate('2026-04-22').length, 1);
  assert.strictEqual(log.getFiresForDate('2026-04-22')[0].ticker, 'OLD');
  assert.strictEqual(log.getFiresForDate('2026-04-24').length, 1);
});
