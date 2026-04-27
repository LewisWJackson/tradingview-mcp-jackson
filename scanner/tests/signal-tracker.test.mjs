import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shouldRefreshBarrierLevels } from '../lib/learning/signal-tracker.js';

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
