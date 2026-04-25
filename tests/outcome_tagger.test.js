import { test } from 'node:test';
import assert from 'node:assert';
import { applyTagging, tagAll } from '../scripts/dashboard/outcome_tagger.js';

const baseFire = () => ({
  eventId: 'uuid-1',
  ticker: 'APH',
  firedAt: '2026-04-24T18:00:00.000Z',
  firedAtET: '2026-04-24T14:00:00-04:00',
  price: { firedPrice: 152.83, bid: 152.80, ask: 152.86 },
  trigger: { level: 152.81 },
  fireStrength: 2,
  setup: { confidence: 'MODERATE' },
  riskFlags: { overallRiskBand: 'green' },
});

test('applyTagging sets outcome + MFE + MAE + hindsightPlan + outcomeTaggedAt', () => {
  const f = baseFire();
  const updated = applyTagging(f, {
    outcome: 'continued',
    mfe: '3.5',
    mae: '1.2',
    hindsightPlan: 'STOCK_ONLY',
  }, new Date('2026-04-24T22:00:00.000Z'));
  assert.strictEqual(updated.outcome, 'continued');
  assert.strictEqual(updated.maxFavorableExcursionPct, 3.5);
  assert.strictEqual(updated.maxAdverseExcursionPct, 1.2);
  assert.strictEqual(updated.hindsightPlan, 'STOCK_ONLY');
  assert.strictEqual(updated.outcomeTaggedAt, '2026-04-24T22:00:00.000Z');
});

test('applyTagging accepts all 4 hindsight plan values + null', () => {
  for (const plan of ['STOCK_ONLY', 'CSP_ONLY', 'BOTH', 'AVOID']) {
    const updated = applyTagging(baseFire(), { outcome: 'continued', hindsightPlan: plan });
    assert.strictEqual(updated.hindsightPlan, plan);
  }
  // dash → null
  const skipPlan = applyTagging(baseFire(), { outcome: 'continued', hindsightPlan: '-' });
  assert.strictEqual(skipPlan.hindsightPlan, null);
});

test('applyTagging case-normalizes outcome (lowercase) and hindsight plan (uppercase)', () => {
  const updated = applyTagging(baseFire(), { outcome: 'CONTINUED', hindsightPlan: 'stock_only' });
  assert.strictEqual(updated.outcome, 'continued');
  assert.strictEqual(updated.hindsightPlan, 'STOCK_ONLY');
});

test('applyTagging rejects invalid outcome and returns _skip flag', () => {
  const updated = applyTagging(baseFire(), { outcome: 'invalid_thing' });
  assert.ok(updated._skip);
  assert.strictEqual(updated.outcome, undefined);
});

test('applyTagging rejects empty outcome (skip)', () => {
  const updated = applyTagging(baseFire(), { outcome: '' });
  assert.ok(updated._skip);
});

test('applyTagging rejects invalid hindsight plan (sets null)', () => {
  const updated = applyTagging(baseFire(), { outcome: 'continued', hindsightPlan: 'NONSENSE' });
  assert.strictEqual(updated.hindsightPlan, null);
});

test('applyTagging treats empty mfe/mae as null', () => {
  const updated = applyTagging(baseFire(), { outcome: 'continued', mfe: '', mae: '' });
  assert.strictEqual(updated.maxFavorableExcursionPct, null);
  assert.strictEqual(updated.maxAdverseExcursionPct, null);
});

test('applyTagging treats dash-only mfe/mae as null', () => {
  const updated = applyTagging(baseFire(), { outcome: 'continued', mfe: '-', mae: '-' });
  assert.strictEqual(updated.maxFavorableExcursionPct, null);
  assert.strictEqual(updated.maxAdverseExcursionPct, null);
});

test('applyTagging rejects non-numeric mfe/mae as null', () => {
  const updated = applyTagging(baseFire(), { outcome: 'continued', mfe: 'abc', mae: 'xyz' });
  assert.strictEqual(updated.maxFavorableExcursionPct, null);
  assert.strictEqual(updated.maxAdverseExcursionPct, null);
});

test('applyTagging preserves all other fire fields untouched', () => {
  const f = baseFire();
  const updated = applyTagging(f, { outcome: 'continued' });
  assert.strictEqual(updated.eventId, 'uuid-1');
  assert.strictEqual(updated.ticker, 'APH');
  assert.strictEqual(updated.fireStrength, 2);
  assert.deepStrictEqual(updated.price, f.price);
});

test('tagAll skips fires that already have outcome', () => {
  const fires = [
    { ...baseFire(), eventId: 'a', outcome: 'continued' },
    { ...baseFire(), eventId: 'b' },
  ];
  let calls = 0;
  const result = tagAll(fires, (f) => { calls++; return { outcome: 'faded', mfe: '2', mae: '1', hindsightPlan: 'CSP_ONLY' }; });
  assert.strictEqual(result.summary.alreadyTagged, 1);
  assert.strictEqual(result.summary.tagged, 1);
  assert.strictEqual(calls, 1, 'getInput called only for untagged fires');
  assert.strictEqual(result.fires[0].outcome, 'continued');
  assert.strictEqual(result.fires[1].outcome, 'faded');
});

test('tagAll counts skipped fires when input is empty/invalid', () => {
  const fires = [
    { ...baseFire(), eventId: 'a' },
    { ...baseFire(), eventId: 'b' },
  ];
  const result = tagAll(fires, () => ({ outcome: '' }));
  assert.strictEqual(result.summary.skipped, 2);
  assert.strictEqual(result.summary.tagged, 0);
});

test('tagAll preserves Level 2 and Level 3 distinction in updated fires', () => {
  const fires = [
    { ...baseFire(), eventId: 'a', fireStrength: 2 },
    { ...baseFire(), eventId: 'b', fireStrength: 3 },
  ];
  const result = tagAll(fires, () => ({ outcome: 'continued', mfe: '2', mae: '1', hindsightPlan: 'STOCK_ONLY' }));
  assert.strictEqual(result.fires[0].fireStrength, 2);
  assert.strictEqual(result.fires[1].fireStrength, 3);
  assert.strictEqual(result.fires[0].outcome, 'continued');
  assert.strictEqual(result.fires[1].outcome, 'continued');
});
