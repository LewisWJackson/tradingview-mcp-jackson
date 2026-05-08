import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildArchiveRecord, evaluateSignalOutcome } from '../lib/learning/outcome-checker.js';
import { summarizeResolvedSignalsForReport } from '../lib/learning/learning-reporter.js';
import { isPlausibleYahooPrice } from '../lib/yahoo-price-feed.js';
import { isMarketTradeable } from '../lib/market-hours.js';

test('unfilled smart-entry miss does not create realized R or report loss', () => {
  const record = buildArchiveRecord({
    id: 'sig_TEST_1D_1',
    symbol: 'XRPUSDT.P',
    direction: 'short',
    status: 'entry_missed_tp',
    createdAt: '2026-05-03T12:42:26.284Z',
    entrySource: 'smc_ob',
    entryHit: false,
    entry: 1.43,
    sl: 1.4667657142857142,
    tp1: 1.3932342857142856,
    lastCheckedPrice: 1.384,
  });

  assert.equal(record.actualRR, null);
  // Neutral status (entry_missed_tp) → win=null. anomaly-detector ve diger
  // PF/WR consumer'lari `s.win != null` ile bunlari otomatik dislar.
  assert.equal(record.win, null);

  const summary = summarizeResolvedSignalsForReport([record]);
  assert.equal(summary.wins, 0);
  assert.equal(summary.losses, 0);
  assert.equal(summary.neutrals, 1);
  assert.equal(summary.totalPnlR, 0);
  assert.equal(summary.bySymbol['XRPUSDT.P'].neutrals, 1);
});

test('trailing stop exit uses original SL risk, not moved SL', () => {
  const record = buildArchiveRecord({
    id: 'sig_ETHUSDC_240_1',
    symbol: 'ETHUSDC',
    direction: 'long',
    status: 'trailing_stop_exit',
    createdAt: '2026-05-01T16:30:35.679Z',
    entry: 2306.1,
    slOriginal: 2269.3532285714286,
    sl: 2326.97425,
    slHit: true,
    slHitPrice: 2326.97425,
    tp1Hit: true,
    tp1: 2340.6915,
    trailingStopExit: true,
  });

  assert.equal(record.actualRR, 0.57);
  assert.equal(record.win, true);
});

test('tp2 archive record uses original SL after breakeven move', () => {
  const record = buildArchiveRecord({
    id: 'sig_TP2_1',
    symbol: 'TEST',
    direction: 'long',
    status: 'tp2_hit',
    createdAt: '2026-05-03T00:00:00.000Z',
    entry: 100,
    slOriginal: 90,
    sl: 100,
    tp1: 110,
    tp2: 120,
    tp1Hit: true,
    tp2Hit: true,
  });

  assert.equal(record.actualRR, 2);
  assert.equal(record.win, true);
});

test('24h report summary recomputes stale tp2 RR after breakeven move', () => {
  const summary = summarizeResolvedSignalsForReport([{
    id: 'sig_TP2_old',
    symbol: 'TEST',
    direction: 'long',
    status: 'tp2_hit',
    entry: 100,
    slOriginal: 90,
    sl: 100,
    tp1: 110,
    tp2: 120,
    actualRR: null,
    tp1Hit: true,
    tp2Hit: true,
  }]);

  assert.equal(summary.wins, 1);
  assert.equal(summary.neutrals, 0);
  assert.equal(summary.totalPnlR, 2);
});

test('price-level validation rejects missing direction for realized report inputs', () => {
  const summary = summarizeResolvedSignalsForReport([{
    id: 'sig_BAD_DIR',
    symbol: 'TEST',
    status: 'tp1_hit',
    entry: 100,
    sl: 90,
    tp1: 110,
    actualRR: 1,
    tp1Hit: true,
  }]);

  assert.equal(summary.wins, 0);
  assert.equal(summary.neutrals, 1);
});

test('24h report summary corrects stale trailing RR without mutating archives', () => {
  const summary = summarizeResolvedSignalsForReport([{
    id: 'sig_ETHUSDC_240_old',
    symbol: 'ETHUSDC',
    direction: 'long',
    status: 'trailing_stop_exit',
    entry: 2306.1,
    slOriginal: 2269.3532285714286,
    sl: 2326.97425,
    slHitPrice: 2326.97425,
    tp1: 2340.6915,
    actualRR: 1,
    tp1Hit: true,
  }]);

  assert.equal(summary.totalPnlR, 0.57);
  assert.equal(summary.bySymbol.ETHUSDC.pnlR, 0.57);
});

test('24h report summary treats malformed historical trailing win as neutral', () => {
  const summary = summarizeResolvedSignalsForReport([{
    id: 'sig_CRCL_bad',
    symbol: 'CRCL',
    direction: 'short',
    status: 'trailing_stop_exit',
    entry: 99.4,
    sl: 99.4,
    tp1: 102.72872857142858,
    slHitPrice: 99.4,
    actualRR: null,
    tp1Hit: true,
  }]);

  assert.equal(summary.wins, 0);
  assert.equal(summary.losses, 0);
  assert.equal(summary.neutrals, 1);
  assert.equal(summary.totalPnlR, 0);
});

test('outcome checker marks wrong-side TP as invalid before TP processing', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_ATATR_240_bad',
    symbol: 'ATATR',
    direction: 'short',
    status: 'open',
    entrySource: 'quote_price',
    entryHit: true,
    entry: 14.4,
    sl: 15.398857142857144,
    tp1: 14.972857142857142,
    tp2: 9.89,
  }, {
    high: 15,
    low: 14.9,
    close: 14.95,
  });

  assert.equal(updates.status, 'invalid_data');
  assert.match(updates.warnings.at(-1), /short ama TP1/);
});

test('outcome checker allows valid breakeven SL after TP1', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_VALID_BE',
    symbol: 'TEST',
    direction: 'short',
    status: 'tp1_hit',
    entrySource: 'quote_price',
    entryHit: true,
    entry: 100,
    slOriginal: 110,
    sl: 100,
    tp1: 90,
    tp1Hit: true,
    trailingStopActive: true,
  }, {
    high: 99.5,
    low: 95,
    close: 97,
  });

  assert.notEqual(updates.status, 'invalid_data');
});

test('smart short entry does not fill before price touches entry', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_XAUUSD_240',
    symbol: 'XAUUSD',
    direction: 'short',
    status: 'open',
    entrySource: 'smc_ob',
    entryHit: false,
    entry: 4586.7,
    sl: 4668.938428571429,
    tp1: 4482.602985714286,
    atr: 41.74214285714288,
  }, {
    high: 4585.4,
    low: 4585.4,
    close: 4585.4,
  });

  assert.equal(updates.entryHit, undefined);
  assert.equal(updates.entryHitAt, undefined);
});

test('legacy smart entry hit without fill price is re-stamped only on real touch', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_XAUUSD_240_legacy',
    symbol: 'XAUUSD',
    direction: 'short',
    status: 'open',
    entrySource: 'smc_ob',
    entryHit: true,
    entryHitAt: '2026-05-04T12:28:56.429Z',
    entry: 4586.7,
    sl: 4668.938428571429,
    tp1: 4482.602985714286,
  }, {
    high: 4588.5,
    low: 4588.5,
    close: 4588.5,
  });

  assert.equal(updates.entryHit, true);
  assert.equal(updates.entryHitPrice, 4586.7);
  assert.notEqual(updates.entryHitAt, '2026-05-04T12:28:56.429Z');
});

test('legacy smart entry hit without fill price is reverted if current bar still missed entry', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_XAUUSD_240_legacy_miss',
    symbol: 'XAUUSD',
    direction: 'short',
    status: 'open',
    entrySource: 'smc_ob',
    entryHit: true,
    entryHitAt: '2026-05-04T12:28:56.429Z',
    entry: 4586.7,
    sl: 4668.938428571429,
    tp1: 4482.602985714286,
  }, {
    high: 4585.4,
    low: 4585.4,
    close: 4585.4,
  });

  assert.equal(updates.entryHit, false);
  assert.equal(updates.entryHitAt, null);
});

test('smart long entry does not fill before price touches entry', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_LONG_PENDING',
    symbol: 'TEST',
    direction: 'long',
    status: 'open',
    entrySource: 'smc_ob',
    entryHit: false,
    entry: 100,
    sl: 90,
    tp1: 110,
    atr: 8,
  }, {
    high: 101,
    low: 101,
    close: 101,
  });

  assert.equal(updates.entryHit, undefined);
  assert.equal(updates.entryHitAt, undefined);
});

test('outcome checker rejects bad equity tick before false SL hit', () => {
  const updates = evaluateSignalOutcome({
    id: 'sig_KTOS_240_bad_tick',
    symbol: 'KTOS',
    direction: 'short',
    status: 'open',
    entrySource: 'quote_price',
    entryHit: true,
    entry: 62.08,
    sl: 65.01505,
    tp1: 59.14495,
  }, {
    high: 83.79,
    low: 83.79,
    close: 83.79,
  });

  assert.equal(updates.status, undefined);
  assert.equal(updates.slHit, undefined);
  assert.match(updates.warnings[0], /Fiyat sapmasi cok yuksek/);
});

test('yahoo feed rejects prices outside the returned intraday bar range', () => {
  assert.equal(isPlausibleYahooPrice(83.79, {
    high: [62.4, 64.13],
    low: [61.8, 62.2],
  }), false);

  assert.equal(isPlausibleYahooPrice(62.76, {
    high: [62.4, 64.13],
    low: [61.8, 62.2],
  }), true);
});

test('market-hours treats us_stock category as US equity session', () => {
  assert.equal(isMarketTradeable('us_stock', new Date('2026-05-02T12:54:01.224Z')), false);
  assert.equal(isMarketTradeable('us_stock', new Date('2026-05-04T15:00:00.000Z')), true);
});
