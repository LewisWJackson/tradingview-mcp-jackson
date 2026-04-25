/**
 * Risk #5 — parser-validator unit testleri.
 */

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  validateKhanSaab, validateTechnicals, validateSMC,
  gateTechnicals, gateSMC,
  recordParserAlarm, getParserAlarmStats, _resetParserAlarms,
  __internals,
} from '../lib/parser-validator.js';

beforeEach(() => _resetParserAlarms());
after(() => _resetParserAlarms());

// ---------------------------------------------------------------------------
// validateKhanSaab
// ---------------------------------------------------------------------------

test('1. validateKhanSaab: tam veri → ok', () => {
  const v = validateKhanSaab({
    bullScore: 60, bearScore: 40, bias: 'BULL', rsi: 55,
    macd: 'BULL', adx: 28, emaStatus: 'BULL',
  });
  assert.equal(v.ok, true);
  assert.equal(v.severity, 'ok');
  assert.equal(v.filledRatio, 1);
});

test('2. validateKhanSaab: 1 eksik → partial', () => {
  const v = validateKhanSaab({
    bullScore: 60, bearScore: 40, bias: 'BULL', rsi: 55,
    macd: 'BULL', adx: 28, emaStatus: null,
  });
  assert.equal(v.ok, false);
  assert.equal(v.severity, 'partial');
  assert.deepEqual(v.missingRequired, ['emaStatus']);
});

test('3. validateKhanSaab: cogu eksik → broken', () => {
  const v = validateKhanSaab({ bullScore: 60, rsi: 55 });
  assert.equal(v.severity, 'broken');
  assert.ok(v.filledRatio < 0.5);
});

test('4. validateKhanSaab: null/undefined → broken', () => {
  assert.equal(validateKhanSaab(null).severity, 'broken');
  assert.equal(validateKhanSaab(undefined).severity, 'broken');
});

// ---------------------------------------------------------------------------
// validateTechnicals (calcTechnicals output)
// ---------------------------------------------------------------------------

test('5. validateTechnicals: 5/5 dolu → ok', () => {
  const v = validateTechnicals({
    rsi: 55, ema21: 100, adx: 28, macd: 'BULL', emaStatus: 'BULL',
    bullScore: null,  // calcTechnicals her zaman null doldurur, sema'da degil
  });
  assert.equal(v.severity, 'ok');
});

test('6. validateTechnicals: 2/5 eksik → ok (3/5 = 0.6 esikte)', () => {
  const v = validateTechnicals({ rsi: 55, ema21: 100, adx: 28 });
  // 3/5 = 0.6 → minRatio = 0.6 → severity ok mu broken mu? 0.6 esikte =
  // ok degil partial — minRatio'nun ALTINA dusersek broken; esitse partial.
  assert.equal(v.severity, 'partial');
});

test('7. validateTechnicals: 1/5 dolu → broken', () => {
  const v = validateTechnicals({ rsi: 55 });
  assert.equal(v.severity, 'broken');
});

// ---------------------------------------------------------------------------
// validateSMC
// ---------------------------------------------------------------------------

test('8. validateSMC: lastBOS varsa → ok', () => {
  const v = validateSMC({ lastBOS: { direction: 'bullish', price: 100 } });
  assert.equal(v.ok, true);
});

test('9. validateSMC: lastCHoCH varsa → ok', () => {
  const v = validateSMC({ lastCHoCH: { direction: 'bearish', price: 100 } });
  assert.equal(v.ok, true);
});

test('10. validateSMC: hicbiri yoksa → broken', () => {
  const v = validateSMC({ lastBOS: null, lastCHoCH: null, eqh: [], eql: [] });
  assert.equal(v.severity, 'broken');
});

// ---------------------------------------------------------------------------
// gateTechnicals + alarm counter
// ---------------------------------------------------------------------------

test('11. gateTechnicals: ok → parsed gec, alarm yok', () => {
  const parsed = { rsi: 55, ema21: 100, adx: 28, macd: 'BULL', emaStatus: 'BULL' };
  const out = gateTechnicals(parsed, { symbol: 'BTC', timeframe: '60' });
  assert.equal(out, parsed);
  const stats = getParserAlarmStats();
  assert.equal(stats.today.total, 0);
});

test('12. gateTechnicals: broken → null + alarm', () => {
  const parsed = { rsi: 55 };
  const out = gateTechnicals(parsed, { symbol: 'BTC', timeframe: '60' });
  assert.equal(out, null);
  const stats = getParserAlarmStats();
  assert.equal(stats.today.total, 1);
  assert.equal(stats.today.bySource.technicals, 1);
  assert.ok(stats.today.bySymbolTf['BTC|60'] >= 1);
});

test('13. gateTechnicals: partial → parsed gec ama alarm tetiklenir', () => {
  const parsed = { rsi: 55, ema21: 100, adx: 28 };  // 3/5 partial
  const out = gateTechnicals(parsed, { symbol: 'BTC', timeframe: '60' });
  assert.equal(out, parsed);  // veri gecer
  const stats = getParserAlarmStats();
  assert.equal(stats.today.total, 1);  // ama alarm dustu
});

test('14. gateSMC: broken → null + alarm', () => {
  const parsed = { lastBOS: null, lastCHoCH: null };
  const out = gateSMC(parsed, { symbol: 'BTC', timeframe: '60' });
  assert.equal(out, null);
  const stats = getParserAlarmStats();
  assert.equal(stats.today.bySource.smc, 1);
});

test('15. gateTechnicals: parsed null gelirse passthrough', () => {
  const out = gateTechnicals(null);
  assert.equal(out, null);
  const stats = getParserAlarmStats();
  assert.equal(stats.today.total, 0);  // alarm tetiklenmedi (calcTechnicals zaten null vermis)
});

// ---------------------------------------------------------------------------
// Counter rotation
// ---------------------------------------------------------------------------

test('16. Counter rotation: yeni gun yeni dosya, dunki yesterday alaninda', () => {
  // Gun 1: alarm bas
  recordParserAlarm({ source: 'smc', missing: ['lastBOS'], severity: 'broken',
    symbol: 'X', timeframe: '60',
    now: Date.parse('2099-06-15T10:00:00Z') });
  // Gun 2: yeni alarm (rotation tetiklenir)
  recordParserAlarm({ source: 'technicals', missing: ['rsi'], severity: 'broken',
    symbol: 'Y', timeframe: '60',
    now: Date.parse('2099-06-16T10:00:00Z') });

  const stats = getParserAlarmStats(Date.parse('2099-06-16T10:00:00Z'));
  assert.equal(stats.today.date, '2099-06-16');
  assert.equal(stats.today.total, 1);
  assert.equal(stats.today.bySource.technicals, 1);
  assert.equal(stats.yesterday?.date, '2099-06-15');
  assert.equal(stats.yesterday?.total, 1);
});
