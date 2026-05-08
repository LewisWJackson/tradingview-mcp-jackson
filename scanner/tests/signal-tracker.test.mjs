import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  findRecentMissedSetup,
  reconcileSmartEntryHitState,
  sanitizeReverseAttemptsForDashboard,
  shouldRefreshBarrierLevels,
  timeframeToMinutes,
  validateSignalPriceLevels,
} from '../lib/learning/signal-tracker.js';

test('same grade and TF refreshes TP levels when old HTF barrier cap changes', () => {
  const existing = {
    symbol: 'FSLR',
    direction: 'long',
    timeframe: '240',
    grade: 'BEKLE',
    tp1: 195.84739285714286,
    tp2: 195.84739285714286,
    tp3: 195.84739285714286,
    rr: '1:0.8',
    warnings: ['[HTF-Barrier] TP capped by old fib'],
  };
  const scanResult = {
    symbol: 'FSLR',
    direction: 'long',
    timeframe: '240',
    grade: 'BEKLE',
    tp1: 199.842,
    tp2: 202.951,
    tp3: 206.06,
    rr: '1:2.1',
    reasoning: ['Barrier: ust=[1D@207.2980(s=3.0)] alt=[-]'],
  };

  assert.equal(shouldRefreshBarrierLevels(existing, scanResult), true);
});

test('does not refresh TP levels after TP ladder has started', () => {
  const existing = {
    direction: 'long',
    timeframe: '240',
    tp1: 195,
    warnings: ['[HTF-Barrier] old'],
  };
  const scanResult = {
    direction: 'long',
    timeframe: '240',
    tp1: 205,
    warnings: ['[HTF-Barrier] new'],
  };

  assert.equal(shouldRefreshBarrierLevels(existing, scanResult, { levelsFrozen: true }), false);
});

test('does not refresh unrelated non-barrier TP changes', () => {
  const existing = {
    direction: 'long',
    timeframe: '240',
    tp1: 195,
    warnings: ['REVERSE SINYAL: 240 TF BEKLE-SHORT'],
  };
  const scanResult = {
    direction: 'long',
    timeframe: '240',
    tp1: 205,
    warnings: [],
  };

  assert.equal(shouldRefreshBarrierLevels(existing, scanResult), false);
});

test('dashboard reverse attempts omit null-direction SMC artifacts', () => {
  const attempts = sanitizeReverseAttemptsForDashboard([
    {
      reasoning: [
        'MACD Trend: BEAR',
        'SMC BOS: null',
        'SMC CHoCH: null — yapisal degisim',
      ],
      indicatorSnapshot: {
        smc: {
          lastBOS: { direction: null, raw: 'BOS', price: 100 },
          lastCHoCH: { direction: null, raw: 'CHOCH', price: 99 },
          hasOB: false,
          hasFVG: false,
        },
      },
    },
  ]);

  assert.deepEqual(attempts[0].reasoning, ['MACD Trend: BEAR']);
  assert.equal(attempts[0].indicatorSnapshot.smc, null);
});

test('price-level validation rejects TP on the wrong side of entry', () => {
  const error = validateSignalPriceLevels({
    symbol: 'CRCL',
    direction: 'short',
    entry: 99.4,
    sl: 106.0164,
    tp1: 102.72872857142858,
  });

  assert.match(error, /short ama TP1/);
});

test('smart entry refresh resets legacy hit when quote never touched entry', () => {
  const existing = {
    direction: 'short',
    entry: 4586.7,
    entryHit: true,
    entryHitAt: '2026-05-04T12:28:56.429Z',
    highestFavorable: 35.18,
    lowestAdverse: 1.8,
  };
  reconcileSmartEntryHitState(existing, {
    direction: 'short',
    entrySource: 'smc_ob',
    entry: 4586.7,
    quotePrice: 4585.4,
  }, new Date('2026-05-04T15:00:00Z'));

  assert.equal(existing.entryHit, false);
  assert.equal(existing.entryHitAt, null);
  assert.equal(existing.highestFavorable, 0);
  assert.equal(existing.lowestAdverse, 0);
});

test('smart entry refresh stamps legacy hit when quote has touched entry', () => {
  const existing = {
    direction: 'short',
    entry: 4586.7,
    entryHit: true,
    entryHitAt: '2026-05-04T12:28:56.429Z',
  };
  reconcileSmartEntryHitState(existing, {
    direction: 'short',
    entrySource: 'smc_ob',
    entry: 4586.7,
    quotePrice: 4588.5,
  }, new Date('2026-05-04T15:00:00Z'));

  assert.equal(existing.entryHit, true);
  assert.equal(existing.entryHitAt, '2026-05-04T15:00:00.000Z');
  assert.equal(existing.entryHitPrice, 4586.7);
});

test('1D timeframe parses to daily minutes for smart-entry deadlines', () => {
  assert.equal(timeframeToMinutes('1D'), 1440);
  assert.equal(timeframeToMinutes('240'), 240);
});

test('recent missed same setup blocks immediate re-open without touching unrelated setups', () => {
  const scanResult = {
    symbol: 'XRPUSDT.P',
    direction: 'short',
    timeframe: '1D',
    entry: 1.43,
    sl: 1.4667657142857142,
    tp1: 1.3932342857142856,
  };
  const now = new Date('2026-05-03T17:00:00Z');
  const recentArchive = [{
    symbol: 'XRPUSDT.P',
    direction: 'short',
    timeframe: '1D',
    status: 'entry_missed_tp',
    resolvedAt: '2026-05-03T13:43:12.142Z',
    entry: 1.43,
    sl: 1.4667657142857142,
    tp1: 1.3932342857142856,
    entrySource: 'smc_ob',
    entryHit: false,
  }];
  const unrelatedArchive = [{
    symbol: 'XRPUSDT.P',
    direction: 'long',
    timeframe: '1D',
    status: 'entry_missed_tp',
    resolvedAt: '2026-05-03T13:43:12.142Z',
    entry: 1.43,
    sl: 1.39,
    tp1: 1.47,
    entrySource: 'smc_ob',
    entryHit: false,
  }];

  assert.equal(findRecentMissedSetup(scanResult, recentArchive, now)?.symbol, 'XRPUSDT.P');
  assert.equal(findRecentMissedSetup(scanResult, unrelatedArchive, now), null);
});
