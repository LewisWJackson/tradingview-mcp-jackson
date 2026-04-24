import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateRiskFlags } from '../src/lib/risk_flags.js';

const base = () => ({
  scannerRow: {
    details: { earningsDaysOut: 30, shortFloat: 5, sectorMomentumRank: 6 },
    notes: '4-stage VCP, extreme contraction',
  },
  quote: {
    averageDailyVolume10Day: 1_000_000,
    spreadPctOfPrice: 0.05,
    prevClose: 100,
    openToday: 101,
  },
  recentNewsCount24h: 2,
  atr14: 2.5,
});

test('green: clean setup, no risks', () => {
  const r = evaluateRiskFlags(base());
  assert.strictEqual(r.overallRiskBand, 'green');
  assert.strictEqual(r.earnings.flag, 'green');
  assert.strictEqual(r.liquidity.flag, 'green');
  assert.strictEqual(r.spread.flag, 'green');
});

test('red earnings: ≤2 days out', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = 1;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'red');
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('yellow earnings: 3-7 days out', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = 5;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'yellow');
  assert.strictEqual(r.overallRiskBand, 'yellow');
});

test('yellow earnings: corrupt sentinel defaults to yellow (never silently green)', () => {
  const ctx = base();
  ctx.scannerRow.details.earningsDaysOut = -20547;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.earnings.flag, 'yellow');
  assert.ok(r.earnings.reason.includes('unverified'));
});

test('yellow liquidity: 200k–500k ADV', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 300_000;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.liquidity.flag, 'yellow');
});

test('red liquidity: < 200k ADV', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 100_000;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.liquidity.flag, 'red');
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('red spread: > 0.5% of price', () => {
  const ctx = base();
  ctx.quote.spreadPctOfPrice = 0.8;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.spread.flag, 'red');
});

test('yellow spread: 0.10%–0.50%', () => {
  const ctx = base();
  ctx.quote.spreadPctOfPrice = 0.3;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.spread.flag, 'yellow');
});

test('red news gap: today opened >2 ATR from prior close', () => {
  const ctx = base();
  ctx.quote.openToday = 106;    // +6 vs prev 100
  ctx.atr14 = 2.5;              // 6 / 2.5 = 2.4 ATR
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.newsGap.flag, 'red');
});

test('yellow news gap: 1-2 ATR', () => {
  const ctx = base();
  ctx.quote.openToday = 103;    // +3 vs 100, 1.2 ATR
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.newsGap.flag, 'yellow');
});

test('merger flag red when scanner notes mention merger', () => {
  const ctx = base();
  ctx.scannerRow.notes = 'merger_pending flagged';
  ctx.scannerRow.mergerPending = true;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.mergerPending, true);
  assert.strictEqual(r.overallRiskBand, 'red');
});

test('overall band: any red wins over yellow', () => {
  const ctx = base();
  ctx.quote.averageDailyVolume10Day = 100_000; // red
  ctx.scannerRow.details.earningsDaysOut = 5;  // yellow
  assert.strictEqual(evaluateRiskFlags(ctx).overallRiskBand, 'red');
});

test('risk flags module is additive: never returns a blocking signal', () => {
  // No matter the inputs, result never carries a "block" or "cancel" field.
  const cases = [
    base(),
    { ...base(), scannerRow: { ...base().scannerRow, details: { ...base().scannerRow.details, earningsDaysOut: 0 } } },
    { ...base(), quote: { ...base().quote, averageDailyVolume10Day: 50_000 } },
    { ...base(), quote: { ...base().quote, spreadPctOfPrice: 5.0 } },
  ];
  for (const c of cases) {
    const r = evaluateRiskFlags(c);
    // The summary must be consultable; no block/cancel/suppress fields.
    assert.ok('overallRiskBand' in r);
    assert.strictEqual(r.block, undefined);
    assert.strictEqual(r.cancel, undefined);
    assert.strictEqual(r.suppress, undefined);
  }
});

test('short float: red at ≥20%, yellow at 10-19%, green below', () => {
  const ctx = base();
  ctx.scannerRow.details.shortFloat = 25;
  assert.strictEqual(evaluateRiskFlags(ctx).shortFloat.flag, 'red');
  ctx.scannerRow.details.shortFloat = 15;
  assert.strictEqual(evaluateRiskFlags(ctx).shortFloat.flag, 'yellow');
  ctx.scannerRow.details.shortFloat = 5;
  assert.strictEqual(evaluateRiskFlags(ctx).shortFloat.flag, 'green');
});

test('missing quote.spreadPctOfPrice → yellow with reason', () => {
  const ctx = base();
  delete ctx.quote.spreadPctOfPrice;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.spread.flag, 'yellow');
  assert.ok(r.spread.reason.includes('bid/ask unavailable'));
});

test('missing quote.averageDailyVolume10Day → yellow', () => {
  const ctx = base();
  delete ctx.quote.averageDailyVolume10Day;
  const r = evaluateRiskFlags(ctx);
  assert.strictEqual(r.liquidity.flag, 'yellow');
  assert.ok(r.liquidity.reason.includes('ADV unavailable'));
});

test('overall band: green requires all flags green (or short float null)', () => {
  const r = evaluateRiskFlags(base());
  assert.strictEqual(r.overallRiskBand, 'green');
});

test('returns { ...dims, mergerPending, recentNewsCount24h, overallRiskBand }', () => {
  const r = evaluateRiskFlags(base());
  assert.ok('earnings' in r);
  assert.ok('liquidity' in r);
  assert.ok('spread' in r);
  assert.ok('newsGap' in r);
  assert.ok('shortFloat' in r);
  assert.ok('mergerPending' in r);
  assert.ok('recentNewsCount24h' in r);
  assert.ok('overallRiskBand' in r);
});
