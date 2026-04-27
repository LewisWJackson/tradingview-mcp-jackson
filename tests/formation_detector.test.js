/**
 * Unit tests for scanner/lib/formation-detector.js.
 *
 * Run: node --test tests/formation_detector.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  checkVolumeConfirmation,
  detectFormations,
} from '../scanner/lib/formation-detector.js';

function bar(i, open, high, low, close, volume = 100) {
  return { time: 1_700_000_000 + i * 60, open, high, low, close, volume };
}

function findFormation(out, namePart) {
  return out.formations.find(f => f.name.includes(namePart));
}

describe('formation detector risk controls', () => {
  it('marks a bull flag as broken when the last close breaks the projected upper flag band', () => {
    const bars = [];
    for (let i = 0; i < 5; i++) {
      const open = 100 + i * 3;
      const close = open + 3;
      bars.push(bar(i, open, close + 0.5, open - 0.5, close));
    }

    let close = 113;
    for (let i = 5; i < 19; i++) {
      bars.push(bar(i, close, close + 0.1, close - 0.4, close - 0.3));
      close -= 0.3;
    }
    bars.push(bar(19, close, 110.6, close - 0.1, 110.5));

    const flag = findFormation(detectFormations(bars), 'Bayragi');
    assert.ok(flag);
    assert.equal(flag.direction, 'bullish');
    assert.equal(flag.broken, true);
    assert.equal(flag.maturity, 100);
  });

  it('does not report double top without a meaningful prior uptrend and neckline depth', () => {
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 103, 99.8, 102),
      bar(2, 102, 101, 99.7, 100),
      bar(3, 100, 100.5, 98.9, 99.5),
      bar(4, 99.5, 101.5, 99.2, 101),
      bar(5, 101, 103.2, 100.4, 102),
      bar(6, 102, 101.5, 99.6, 100),
      bar(7, 100, 100.8, 99.4, 100.2),
      bar(8, 100.2, 101, 99.5, 100.4),
      bar(9, 100.4, 100.9, 99.8, 100.1),
      bar(10, 100.1, 100.7, 99.9, 100.2),
      bar(11, 100.2, 100.8, 99.7, 100.3),
      bar(12, 100.3, 100.9, 99.6, 100.1),
      bar(13, 100.1, 100.6, 99.8, 100.2),
      bar(14, 100.2, 100.7, 99.9, 100.4),
      bar(15, 100.4, 100.8, 99.8, 100.1),
      bar(16, 100.1, 100.9, 99.7, 100.2),
      bar(17, 100.2, 100.8, 99.8, 100.3),
      bar(18, 100.3, 100.9, 99.9, 100.4),
      bar(19, 100.4, 100.8, 99.8, 100.2),
    ];

    assert.equal(findFormation(detectFormations(bars), 'Cift Tepe'), undefined);
  });

  it('requires two neckline reactions for head and shoulders', () => {
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 100, 103, 99.5, 102),
      bar(2, 102, 106, 101, 105),
      bar(3, 105, 104, 99, 100),
      bar(4, 100, 107, 99.5, 106),
      bar(5, 106, 112, 105, 111),
      bar(6, 111, 108, 100.5, 101),
      bar(7, 101, 106, 100.8, 105),
      bar(8, 105, 107, 104, 106),
      bar(9, 106, 105, 101, 102),
      bar(10, 102, 103, 100.5, 101),
      bar(11, 101, 102, 100, 101),
      bar(12, 101, 102, 100, 101),
      bar(13, 101, 102, 100, 101),
      bar(14, 101, 102, 100, 101),
      bar(15, 101, 102, 100, 101),
      bar(16, 101, 102, 100, 101),
      bar(17, 101, 102, 100, 101),
      bar(18, 101, 102, 100, 101),
      bar(19, 101, 102, 100, 101),
    ];

    assert.equal(findFormation(detectFormations(bars), 'Omuz-Bas-Omuz'), undefined);
  });

  it('returns finite volume confirmation values when volume is missing', () => {
    const bars = Array.from({ length: 21 }, (_, i) => ({ ...bar(i, 100, 101, 99, 100), volume: undefined }));
    const result = checkVolumeConfirmation(bars);
    assert.equal(Number.isFinite(result.ratio), true);
    assert.equal(Number.isFinite(result.avgVolume), true);
    assert.equal(Number.isFinite(result.lastVolume), true);
    assert.equal(result.confirmed, false);
  });

  it('reports malformed OHLC input instead of silently swallowing detector failures', () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 101, 99, 100));
    bars[10] = { time: bars[10].time, open: 100, high: 99, low: 98, close: 100, volume: 100 };

    const result = detectFormations(bars);
    assert.deepEqual(result.formations, []);
    assert.equal(result.detectorErrors.length, 1);
    assert.equal(result.detectorErrors[0].detector, 'input');
  });
});
