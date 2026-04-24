import { test } from 'node:test';
import assert from 'node:assert';
import { createQuoteChain } from '../src/lib/quote_sources/chain.js';

function mkMockSource(name, impl) {
  return { name, fetch: impl };
}

test('uses primary source when healthy', async () => {
  const primary = mkMockSource('yahoo', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 100, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const secondary = mkMockSource('tv_cdp', async () => { throw new Error('should not be called'); });
  const chain = createQuoteChain({ sources: [primary, secondary] });
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.price, 100);
  assert.strictEqual(out.quotes.APH.quoteSource, 'yahoo');
});

test('flips to secondary after 5 consecutive primary failures', async () => {
  let primaryCalls = 0;
  const primary = mkMockSource('yahoo', async () => { primaryCalls++; throw new Error('rate limit'); });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 5 });
  for (let i = 0; i < 4; i++) {
    try { await chain.fetchQuotes(['APH']); } catch {}
  }
  assert.strictEqual(chain.activeSourceName(), 'yahoo');
  try { await chain.fetchQuotes(['APH']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp', 'flipped after 5th failure');
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.quoteSource, 'tv_cdp');
  assert.strictEqual(primaryCalls, 5, 'primary not retried while degraded');
});

test('serves stale cache with fire suppression when all sources fail', async () => {
  const primary = mkMockSource('yahoo', async () => { throw new Error('down'); });
  const secondary = mkMockSource('tv_cdp', async () => { throw new Error('down'); });
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1 });
  // Seed the cache
  chain.cachePrime('APH', { symbol: 'APH', price: 100, marketTimeIso: new Date(Date.now() - 60_000).toISOString() }, 'yahoo');
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.quotes.APH.quoteSource, 'stale');
  assert.strictEqual(out.quotes.APH.fireSuppressed, true);
  assert.ok(out.quotes.APH.quoteAgeMs >= 60_000);
});

test('recovery probe flips back to primary after success', async () => {
  let primaryShouldSucceed = false;
  const primary = mkMockSource('yahoo', async syms => {
    if (!primaryShouldSucceed) throw new Error('down');
    return { quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 101, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() };
  });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1, probeIntervalMs: 0 });
  // Force a flip
  try { await chain.fetchQuotes(['APH']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp');
  primaryShouldSucceed = true;
  // A manual probe attempt
  await chain.probe(['APH']);
  assert.strictEqual(chain.activeSourceName(), 'yahoo');
});

test('successful fetch returns activeSource + degraded=false + sourceAttempts', async () => {
  const primary = mkMockSource('yahoo', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 100, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, mkMockSource('tv_cdp', async () => { throw new Error('unused'); })] });
  const out = await chain.fetchQuotes(['X']);
  assert.strictEqual(out.activeSource, 'yahoo');
  assert.strictEqual(out.degraded, false);
  assert.strictEqual(out.sourceAttempts.length, 1);
  assert.strictEqual(out.sourceAttempts[0].name, 'yahoo');
  assert.strictEqual(out.sourceAttempts[0].ok, true);
});

test('sourceAttempts records per-source error details including kind and status', async () => {
  const rateErr = Object.assign(new Error('rate limited'), { kind: 'rate_limit', status: 429 });
  const primary = mkMockSource('yahoo', async () => { throw rateErr; });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1 });
  const out = await chain.fetchQuotes(['X']);
  assert.strictEqual(out.activeSource, 'tv_cdp');
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.sourceAttempts.length, 2);
  assert.strictEqual(out.sourceAttempts[0].ok, false);
  assert.strictEqual(out.sourceAttempts[0].error.kind, 'rate_limit');
  assert.strictEqual(out.sourceAttempts[0].error.status, 429);
  assert.strictEqual(out.sourceAttempts[1].ok, true);
});

test('stale response includes activeSource=stale and both failure records', async () => {
  const primary = mkMockSource('yahoo', async () => { throw Object.assign(new Error('rl'), { kind: 'rate_limit', status: 429 }); });
  const secondary = mkMockSource('tv_cdp', async () => { throw Object.assign(new Error('cdp'), { kind: 'source_unreachable', status: null }); });
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1 });
  chain.cachePrime('APH', { symbol: 'APH', price: 100, marketTimeIso: new Date(Date.now() - 10_000).toISOString() }, 'yahoo');
  const out = await chain.fetchQuotes(['APH']);
  assert.strictEqual(out.activeSource, 'stale');
  assert.strictEqual(out.degraded, true);
  assert.strictEqual(out.quotes.APH.fireSuppressed, true);
  assert.strictEqual(out.sourceAttempts.length, 2);
  assert.strictEqual(out.sourceAttempts[0].error.kind, 'rate_limit');
  assert.strictEqual(out.sourceAttempts[1].error.kind, 'source_unreachable');
});

test('stale response emits null quote for symbols not in cache', async () => {
  const primary = mkMockSource('yahoo', async () => { throw new Error('down'); });
  const chain = createQuoteChain({ sources: [primary], flipAfterFailures: 1 });
  const out = await chain.fetchQuotes(['UNCACHED']);
  assert.strictEqual(out.activeSource, 'stale');
  assert.strictEqual(out.quotes.UNCACHED, null);
});

test('probe returns structured result { flipped, reason|restoredSource, error? }', async () => {
  let primaryOk = false;
  const primary = mkMockSource('yahoo', async syms => {
    if (!primaryOk) throw new Error('down');
    return { quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 100, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() };
  });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1, probeIntervalMs: 0 });
  // While on primary, probe should be a no-op
  assert.deepStrictEqual(await chain.probe(['X']), { flipped: false, reason: 'already_primary' });
  // Flip to secondary
  try { await chain.fetchQuotes(['X']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp');
  // Probe while primary is still down
  const badProbe = await chain.probe(['X']);
  assert.strictEqual(badProbe.flipped, false);
  assert.strictEqual(badProbe.reason, 'probe_failed');
  assert.ok(badProbe.error);
  // Primary comes back
  primaryOk = true;
  const goodProbe = await chain.probe(['X']);
  assert.strictEqual(goodProbe.flipped, true);
  assert.strictEqual(goodProbe.restoredSource, 'yahoo');
});

test('probe cooldown is NOT stamped on failure (allows quick retry)', async () => {
  const primary = mkMockSource('yahoo', async () => { throw new Error('still down'); });
  const secondary = mkMockSource('tv_cdp', async syms => ({ quotes: Object.fromEntries(syms.map(s => [s, { symbol: s, price: 99, marketTimeIso: new Date().toISOString() }])), fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [primary, secondary], flipAfterFailures: 1, probeIntervalMs: 30_000 });
  // Force flip
  try { await chain.fetchQuotes(['X']); } catch {}
  assert.strictEqual(chain.activeSourceName(), 'tv_cdp');
  // First probe fails — should not block subsequent probes
  const probe1 = await chain.probe(['X']);
  assert.strictEqual(probe1.flipped, false);
  assert.strictEqual(probe1.reason, 'probe_failed');
  // Second probe call should NOT be throttled (cooldown wasn't stamped on failure)
  const probe2 = await chain.probe(['X']);
  assert.strictEqual(probe2.flipped, false);
  assert.strictEqual(probe2.reason, 'probe_failed', 'cooldown not stamped on failure → re-attempts allowed');
});

test('tryFetch does not mutate source-returned quote objects', async () => {
  const sharedQuote = { symbol: 'X', price: 100, marketTimeIso: new Date().toISOString() };
  const source = mkMockSource('yahoo', async () => ({ quotes: { X: sharedQuote }, fetchedAt: new Date() }));
  const chain = createQuoteChain({ sources: [source] });
  await chain.fetchQuotes(['X']);
  // Verify the source's original object was NOT mutated
  assert.strictEqual(sharedQuote.quoteSource, undefined);
  assert.strictEqual(sharedQuote.quoteAgeMs, undefined);
});
