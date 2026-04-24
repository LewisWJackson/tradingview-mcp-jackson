import { test } from 'node:test';
import assert from 'node:assert';
import { tvCdpFetchQuotes } from '../src/lib/quote_sources/tv_cdp.js';

test('tvCdpFetchQuotes returns a quote map using the provided dataCore', async () => {
  const calls = [];
  const dataCore = {
    async getQuote(sym) {
      calls.push(sym);
      if (sym === 'APH') return { symbol: 'APH', last: 150.38, bid: 150.30, ask: 150.42, time: 1776960000 };
      if (sym === 'LIN') return { symbol: 'LIN', last: 510.56, bid: 510.48, ask: 510.62, time: 1776960000 };
      return null;
    },
  };
  const out = await tvCdpFetchQuotes(['APH', 'LIN'], { dataCore });
  assert.strictEqual(out.quotes.APH.price, 150.38);
  assert.strictEqual(out.quotes.LIN.bid, 510.48);
  assert.deepStrictEqual(calls, ['APH', 'LIN']);
});

test('tvCdpFetchQuotes returns null entries for missing symbols (not watched in TV)', async () => {
  const dataCore = { async getQuote() { return null; } };
  const out = await tvCdpFetchQuotes(['UNKNOWN'], { dataCore });
  assert.strictEqual(out.quotes.UNKNOWN, null);
});

test('tvCdpFetchQuotes throws if dataCore unreachable', async () => {
  const dataCore = { async getQuote() { throw new Error('CDP unreachable'); } };
  await assert.rejects(() => tvCdpFetchQuotes(['X'], { dataCore }));
});

test('thrown error carries kind=source_unreachable and source=tv_cdp', async () => {
  const dataCore = { async getQuote() { throw new Error('CDP unreachable'); } };
  try {
    await tvCdpFetchQuotes(['X'], { dataCore });
    assert.fail('should have thrown');
  } catch (err) {
    assert.strictEqual(err.kind, 'source_unreachable');
    assert.strictEqual(err.source, 'tv_cdp');
    assert.strictEqual(err.status, null);
    assert.ok(Array.isArray(err.sourceFailures));
    assert.strictEqual(err.sourceFailures.length, 1);
  }
});

test('partial failure does not throw (some symbols succeed, some fail)', async () => {
  const dataCore = {
    async getQuote(sym) {
      if (sym === 'GOOD') return { symbol: 'GOOD', last: 100, bid: 99, ask: 101, time: 1776960000 };
      throw new Error('CDP error for ' + sym);
    },
  };
  const out = await tvCdpFetchQuotes(['GOOD', 'BAD'], { dataCore });
  assert.strictEqual(out.quotes.GOOD.price, 100);
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].symbol, 'BAD');
  assert.ok(out.failed[0].error.includes('BAD'));
});

test('failed entries carry source=tv_cdp for chain auditability', async () => {
  const dataCore = {
    async getQuote(sym) {
      if (sym === 'GOOD') return { symbol: 'GOOD', last: 100, time: 1776960000 };
      throw new Error('bad');
    },
  };
  const out = await tvCdpFetchQuotes(['GOOD', 'BAD'], { dataCore });
  assert.strictEqual(out.failed.length, 1);
  assert.strictEqual(out.failed[0].source, 'tv_cdp');
});

test('per-symbol failure carries kind when underlying error has one', async () => {
  const dataCore = {
    async getQuote() {
      const e = new Error('boom');
      e.kind = 'socket_closed';
      throw e;
    },
  };
  await assert.rejects(
    () => tvCdpFetchQuotes(['X'], { dataCore }),
    (err) => {
      assert.strictEqual(err.sourceFailures[0].kind, 'socket_closed');
      return true;
    },
  );
});

test('returns { quotes, fetchedAt, failed, missing } shape', async () => {
  const dataCore = { async getQuote(sym) { return sym === 'A' ? { symbol: 'A', last: 10, time: 1 } : null; } };
  const out = await tvCdpFetchQuotes(['A', 'B'], { dataCore });
  assert.ok(out.quotes);
  assert.ok(out.fetchedAt instanceof Date);
  assert.ok(Array.isArray(out.failed));
  assert.ok(Array.isArray(out.missing));
});
