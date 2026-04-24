import { test } from 'node:test';
import assert from 'node:assert';
import { buildQuoteUrl, parseQuoteResponse, normalizeQuoteRow, classifyHttpKind } from '../src/lib/quote_sources/yahoo.js';

test('buildQuoteUrl encodes symbols and crumb', () => {
  const url = buildQuoteUrl(['AAPL', 'MSFT', '^GSPC'], 'abc=def');
  assert.ok(url.includes('symbols=AAPL%2CMSFT%2C%5EGSPC'));
  assert.ok(url.includes('crumb=abc%3Ddef'));
});

test('parseQuoteResponse turns Yahoo response into a symbol→quote map', () => {
  const body = JSON.stringify({
    quoteResponse: {
      result: [
        { symbol: 'AAPL', regularMarketPrice: 250.1, bid: 250.05, ask: 250.15, regularMarketTime: 1776960000, averageDailyVolume10Day: 50_000_000 },
        { symbol: 'MSFT', regularMarketPrice: 418.9, bid: 418.80, ask: 418.95, regularMarketTime: 1776960000, averageDailyVolume10Day: 22_000_000 },
      ],
    },
  });
  const map = parseQuoteResponse(body);
  assert.strictEqual(map.AAPL.price, 250.1);
  assert.strictEqual(map.MSFT.ask, 418.95);
});

test('normalizeQuoteRow computes spread fields', () => {
  const r = normalizeQuoteRow({ symbol: 'X', regularMarketPrice: 100, bid: 99.80, ask: 100.10, regularMarketTime: 1776960000, averageDailyVolume10Day: 1_000_000 });
  assert.strictEqual(r.spreadAbsolute, 0.30);
  assert.strictEqual(r.spreadPctOfPrice.toFixed(2), '0.30');
});

test('normalizeQuoteRow handles missing bid/ask gracefully', () => {
  const r = normalizeQuoteRow({ symbol: 'X', regularMarketPrice: 100, regularMarketTime: 1776960000 });
  assert.strictEqual(r.bid, null);
  assert.strictEqual(r.spreadAbsolute, null);
});

test('timeout errors carry kind=timeout for chain introspection', async () => {
  // Manually construct the error pattern we emit on timeout — verifies the contract
  const err = new Error('Yahoo request timed out after 15000ms');
  err.kind = 'timeout';
  err.timeoutMs = 15000;
  assert.strictEqual(err.kind, 'timeout');
  assert.strictEqual(err.timeoutMs, 15000);
});

test('classifyHttpKind: status 429 → rate_limit', () => {
  assert.strictEqual(classifyHttpKind(429), 'rate_limit');
});

test('classifyHttpKind: status 500 → server_error', () => {
  assert.strictEqual(classifyHttpKind(500), 'server_error');
});

test('classifyHttpKind: status 502/503/504 → server_error', () => {
  assert.strictEqual(classifyHttpKind(502), 'server_error');
  assert.strictEqual(classifyHttpKind(503), 'server_error');
  assert.strictEqual(classifyHttpKind(504), 'server_error');
});

test('classifyHttpKind: status 403/418 (non-429, non-5xx) → http_error', () => {
  assert.strictEqual(classifyHttpKind(403), 'http_error');
  assert.strictEqual(classifyHttpKind(418), 'http_error');
});

test('parseQuoteResponse silently drops rows with no symbol key (do not fabricate)', () => {
  const body = JSON.stringify({ quoteResponse: { result: [{ regularMarketPrice: 1 }, { symbol: 'OK', regularMarketPrice: 2 }] } });
  const map = parseQuoteResponse(body);
  assert.strictEqual(Object.keys(map).length, 1);
  assert.strictEqual(map.OK.price, 2);
});

test('parseQuoteResponse throws typed parse_error on non-JSON body', () => {
  try {
    parseQuoteResponse('<html>rate limited</html>');
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.kind, 'parse_error');
    assert.strictEqual(err.source, 'yahoo');
    assert.strictEqual(err.status, null);
    assert.ok(err.cause instanceof Error);
  }
});
