import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeFibLevels } from '../lib/fib-engine.js';

function bar(index, { high, low, close = null }) {
  const c = close ?? (high + low) / 2;
  return {
    time: 1700000000 + index * 86400,
    open: c,
    high,
    low,
    close: c,
    volume: 1000,
  };
}

test('computeFibLevels uses active down leg after a weak post-bottom bounce', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(i, { high: 188 + i, low: 178 + i }));
  bars.push(bar(10, { high: 180, low: 184, close: 178 }));
  for (let i = 11; i < 40; i++) bars.push(bar(i, { high: 180 + (i - 10) * 3.4, low: 184 + (i - 10) * 3.2 }));
  bars.push(bar(40, { high: 285.99, low: 276, close: 282 }));
  for (let i = 41; i < 80; i++) bars.push(bar(i, { high: 285 - (i - 40) * 2.1, low: 276 - (i - 40) * 2.2 }));
  bars.push(bar(80, { high: 190, low: 182.99, close: 186 }));
  for (let i = 81; i < 90; i++) bars.push(bar(i, { high: 185 + (i - 80) * 2.1, low: 183 + (i - 80) * 1.5 }));
  bars.push(bar(90, { high: 205, low: 198, close: 202 }));
  for (let i = 91; i < 105; i++) bars.push(bar(i, { high: 203 - (i - 90) * 0.4, low: 191 - (i - 90) * 0.1, close: 194.4 }));

  const fib = computeFibLevels(bars, '1D');

  assert.equal(fib.direction, 'down');
  assert.equal(fib.swing.high.price, 285.99);
  assert.equal(fib.swing.low.price, 182.99);
  assert.equal(fib.retracement.find(r => r.level === 0.236).price, 207.298);
});

test('computeFibLevels keeps active up leg before a confirmed deep break', () => {
  const bars = [];
  for (let i = 0; i < 10; i++) bars.push(bar(i, { high: 120 + i, low: 100 + i }));
  bars.push(bar(10, { high: 110, low: 100, close: 105 }));
  for (let i = 11; i < 40; i++) bars.push(bar(i, { high: 105 + (i - 10) * 3.2, low: 101 + (i - 10) * 3.0 }));
  bars.push(bar(40, { high: 200, low: 192, close: 198 }));
  for (let i = 41; i < 46; i++) bars.push(bar(i, { high: 199 - (i - 40) * 0.8, low: 190 - (i - 40) * 0.7, close: 195 }));

  const fib = computeFibLevels(bars, '1D');

  assert.equal(fib.direction, 'up');
  assert.equal(fib.swing.high.price, 200);
  assert.equal(fib.swing.low.price, 100);
});
