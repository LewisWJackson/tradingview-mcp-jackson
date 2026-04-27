import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildBarriers } from '../lib/barrier-detector.js';
import { formatBarrierFibBasis } from '../lib/alignment-filters.js';

const fibCache = {
  timeframes: {
    '1D': {
      fib: {
        tf: '1D',
        direction: 'up',
        swing: {
          high: { price: 200, time: 1770000000 },
          low: { price: 100, time: 1760000000 },
        },
        retracement: [
          { level: 0.382, price: 161.8, tf: '1D' },
          { level: 0.618, price: 138.2, tf: '1D' },
        ],
        extensions: [
          { level: 1.272, price: 227.2, tf: '1D' },
        ],
      },
    },
  },
};

test('HTF fib barriers carry level and top-bottom basis metadata', () => {
  const barriers = buildBarriers({ entry: 150, atr: 2, fibCache });
  const zone = barriers.aboveBarriers.find(z => z.price === 161.8);

  assert.ok(zone, 'expected 1D 0.382 retracement above entry');
  assert.equal(zone.fibDetails.length, 1);
  assert.deepEqual(zone.fibDetails[0], {
    tf: '1D',
    kind: 'retracement',
    level: 0.382,
    price: 161.8,
    direction: 'up',
    swing: {
      high: { price: 200, time: 1770000000 },
      low: { price: 100, time: 1760000000 },
    },
  });
});

test('HTF-Barrier warning fib basis text includes fib point and top-bottom dates/prices', () => {
  const barriers = buildBarriers({ entry: 150, atr: 2, fibCache });
  const zone = barriers.aboveBarriers.find(z => z.price === 161.8);
  const text = formatBarrierFibBasis(zone);

  assert.match(text, /1D retracement 0\.382 @ 161\.8000/);
  assert.match(text, /top 200\.0000 @ /);
  assert.match(text, /bottom 100\.0000 @ /);
  assert.match(text, /swing=up/);
});
