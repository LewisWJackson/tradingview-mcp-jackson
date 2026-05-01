import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSMCLabels } from '../lib/calculators.js';
import { gradeShortTermSignal } from '../lib/signal-grader.js';
import { normalizeTradingViewColor } from '../lib/tv-bridge.js';

test('SMC BOS/CHoCH with null direction does not create SMC votes or reasoning', () => {
  const result = gradeShortTermSignal({
    symbol: 'UNITTEST',
    timeframe: '60',
    khanSaab: null,
    smc: {
      lastBOS: { direction: null, raw: 'BOS', price: 100 },
      lastCHoCH: { direction: null, raw: 'CHOCH', price: 99 },
    },
    studyValues: null,
    ohlcv: null,
    formation: null,
    squeeze: null,
    divergence: null,
    cdv: null,
    stochRSI: null,
    macroFilter: null,
    quotePrice: null,
    parsedBoxes: null,
    khanSaabLabels: null,
    regime: null,
    smcSRLines: [],
  });

  assert.equal(result.votes, null);
  assert.ok(!result.reasoning.some(r => String(r).includes('SMC BOS: null')));
  assert.ok(!result.reasoning.some(r => String(r).includes('SMC CHoCH: null')));
});

test('SMC label parser can infer direction from TradingView label colors', () => {
  const cases = [
    ['#819908', 'bullish'],
    ['#4536f2', 'bearish'],
    ['#089981', 'bullish'],
    ['#f23645', 'bearish'],
    ['#ef5350', 'bearish'],
    ['#26a69a', 'bullish'],
  ];

  for (const [color, expected] of cases) {
    const parsed = parseSMCLabels([
      { name: 'Smart Money Concepts', labels: [{ text: 'BOS', price: 100, color }] },
    ]);
    assert.equal(parsed.lastBOS.direction, expected, color);
  }
});

test('TradingView ARGB label colors normalize to #rrggbb', () => {
  assert.equal(normalizeTradingViewColor(0xff819908), '#819908');
  assert.equal(normalizeTradingViewColor(0xff4536f2), '#4536f2');
  assert.equal(normalizeTradingViewColor(null), null);
});
