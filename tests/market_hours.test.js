import { test } from 'node:test';
import assert from 'node:assert';
import { getMarketMode, tradingDate } from '../src/lib/market_hours.js';

// All tests pin a fixed "now" so they're deterministic across runs.
// Times are expressed in UTC; the module converts to America/New_York.

test('REGULAR during the 10 AM ET hour on a normal Thursday', () => {
  const now = new Date('2026-04-23T14:00:00Z'); // 10:00 EDT
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('PRE_WARM 9:27 AM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T13:27:00Z'); // 9:27 EDT
  assert.strictEqual(getMarketMode(now).mode, 'PRE_WARM');
});

test('CLOSE_CAPTURE at 4:02 PM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T20:02:00Z'); // 16:02 EDT
  assert.strictEqual(getMarketMode(now).mode, 'CLOSE_CAPTURE');
});

test('PAUSED after 4:05 PM ET on a normal weekday', () => {
  const now = new Date('2026-04-23T20:10:00Z'); // 16:10 EDT
  assert.strictEqual(getMarketMode(now).mode, 'PAUSED');
});

test('PAUSED on Saturday at 11 AM ET', () => {
  const now = new Date('2026-04-25T15:00:00Z'); // 11:00 EDT Sat
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'weekend');
});

test('PAUSED on Good Friday 2026 at 11 AM ET', () => {
  const now = new Date('2026-04-03T15:00:00Z');
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'holiday');
  assert.strictEqual(result.holiday, 'Good Friday');
});

test('REGULAR at 12 PM ET on an early-close day (Day After Thanksgiving)', () => {
  const now = new Date('2026-11-27T17:00:00Z'); // 12:00 EST
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('PAUSED at 2 PM ET on an early-close day', () => {
  const now = new Date('2026-11-27T19:00:00Z'); // 14:00 EST
  const result = getMarketMode(now);
  assert.strictEqual(result.mode, 'PAUSED');
  assert.strictEqual(result.reason, 'early_close');
});

test('CLOSE_CAPTURE at 1:02 PM ET on an early-close day', () => {
  const now = new Date('2026-11-27T18:02:00Z'); // 13:02 EST
  assert.strictEqual(getMarketMode(now).mode, 'CLOSE_CAPTURE');
});

test('DST transition — REGULAR 10 AM ET on 2026-03-09 (first EDT day)', () => {
  // DST 2026 starts Sun Mar 8; Monday Mar 9 is first EDT trading day
  const now = new Date('2026-03-09T14:00:00Z'); // 10:00 EDT
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('DST transition — REGULAR 10 AM ET on 2026-11-02 (first EST day)', () => {
  const now = new Date('2026-11-02T15:00:00Z'); // 10:00 EST
  assert.strictEqual(getMarketMode(now).mode, 'REGULAR');
});

test('tradingDate returns ET date, not UTC date, for a late-evening ET timestamp', () => {
  // 2026-04-23 23:01 EDT = 2026-04-24 03:01 UTC — UTC date is April 24, ET is still April 23
  const now = new Date('2026-04-24T03:01:00Z');
  assert.strictEqual(tradingDate(now), '2026-04-23');
});

test('tradingDate returns correct date at 10 AM ET mid-session', () => {
  const now = new Date('2026-04-23T14:00:00Z');
  assert.strictEqual(tradingDate(now), '2026-04-23');
});
