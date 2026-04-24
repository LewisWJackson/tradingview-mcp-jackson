import { test } from 'node:test';
import assert from 'node:assert';
import { createLivePoller } from '../scripts/scanner/live_price_poller.js';

function mkFakeChain(priceSeq, opts = {}) {
  let tick = 0;
  return {
    async fetchQuotes(symbols) {
      const priceForTick = priceSeq[tick++] || priceSeq[priceSeq.length - 1];
      const quotes = {};
      for (const s of symbols) {
        quotes[s] = {
          symbol: s,
          price: priceForTick[s] ?? null,
          bid: priceForTick[s] ? priceForTick[s] - 0.05 : null,
          ask: priceForTick[s] ? priceForTick[s] + 0.05 : null,
          spreadAbsolute: 0.10,
          spreadPctOfPrice: 0.01,
          averageDailyVolume10Day: 1_000_000,
          volume: 500_000,
          prevClose: 150,
          openToday: 150.5,
          marketTimeIso: new Date().toISOString(),
          quoteSource: 'yahoo',
          quoteAgeMs: 100,
          fireSuppressed: opts.fireSuppressed ?? false,
        };
      }
      return {
        quotes,
        fetchedAt: new Date(),
        activeSource: opts.activeSource ?? 'yahoo',
        degraded: opts.degraded ?? false,
        sourceAttempts: opts.sourceAttempts ?? [{ name: 'yahoo', ok: true, error: null }],
      };
    },
    async probe() {},
    activeSourceName: () => opts.activeSource ?? 'yahoo',
    cachePrime: () => {},
  };
}

test('fires when a candidate crosses trigger with 2-poll confirmation', async () => {
  const chain = mkFakeChain([
    { APH: 150.00 },   // below trigger
    { APH: 153.00 },   // above #1 — PENDING
    { APH: 153.10 },   // above #2 — FIRE
  ]);
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'APH', trigger: 152.81, confidence: 'HIGH', setupType: 'building_base', rank: 6, confidenceBand: { low: 61, mid: 66, high: 71 }, probabilityScore: 66 }] }),
    chain,
    onFire: (e) => fires.push(e),
    onError: () => {},
    isMarketOpen: () => true,
  });
  await poller.tick();
  await poller.tick();
  await poller.tick();
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].ticker, 'APH');
  assert.strictEqual(fires[0].price.firedPrice, 153.10);
});

test('does not poll when market is closed', async () => {
  let chainCalls = 0;
  const chain = {
    async fetchQuotes() { chainCalls++; return { quotes: {}, fetchedAt: new Date() }; },
    async probe() {}, activeSourceName: () => 'yahoo', cachePrime: () => {},
  };
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'X', trigger: 10 }] }),
    chain, onFire: () => {}, onError: () => {},
    isMarketOpen: () => false,
  });
  await poller.tick();
  assert.strictEqual(chainCalls, 0);
});

test('fire event carries audit metadata from chain (activeSource, degraded, sourceAttempts)', async () => {
  const chain = mkFakeChain(
    [{ APH: 150 }, { APH: 153 }, { APH: 153.1 }],
    { activeSource: 'tv_cdp', degraded: true, sourceAttempts: [{ name: 'yahoo', ok: false, error: { kind: 'rate_limit', status: 429, message: '429' } }, { name: 'tv_cdp', ok: true, error: null }] }
  );
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'APH', trigger: 152.81, confidence: 'HIGH', setupType: 'building_base', rank: 6, probabilityScore: 66 }] }),
    chain,
    onFire: (e) => fires.push(e),
    onError: () => {},
    isMarketOpen: () => true,
  });
  await poller.tick(); await poller.tick(); await poller.tick();
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].audit.activeSource, 'tv_cdp');
  assert.strictEqual(fires[0].audit.degraded, true);
  assert.strictEqual(fires[0].audit.sourceAttempts.length, 2);
  assert.strictEqual(fires[0].audit.sourceAttempts[0].error.kind, 'rate_limit');
});

test('fire event includes fireStrength and riskFlags', async () => {
  const chain = mkFakeChain([{ X: 150 }, { X: 153 }, { X: 153.1 }]);
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{
      symbol: 'X', trigger: 152.81, confidence: 'MODERATE', setupType: 'building_base',
      rank: 1, probabilityScore: 60,
      // No strong technical signals provided → expect Level 2
    }] }),
    chain, onFire: (e) => fires.push(e), onError: () => {}, isMarketOpen: () => true,
  });
  await poller.tick(); await poller.tick(); await poller.tick();
  assert.strictEqual(fires[0].fireStrength, 2);
  assert.ok(fires[0].riskFlags);
  assert.ok(['green','yellow','red'].includes(fires[0].riskFlags.overallRiskBand));
});

test('no duplicate fire events on sustained above-trigger ticks after first fire', async () => {
  const chain = mkFakeChain([
    { X: 150 }, { X: 153 }, { X: 153.1 },     // fire #1
    { X: 153.5 }, { X: 154 }, { X: 155 },     // sustained above — NO re-fire
  ]);
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'X', trigger: 152.81, confidence: 'MOD', setupType: 'building_base', rank: 1, probabilityScore: 60 }] }),
    chain, onFire: (e) => fires.push(e), onError: () => {}, isMarketOpen: () => true,
  });
  for (let i = 0; i < 6; i++) await poller.tick();
  assert.strictEqual(fires.length, 1, 'subsequent above-trigger ticks must NOT re-fire');
});

test('fireSuppressed quote from chain does not cause a fire (stale data contract)', async () => {
  const chain = mkFakeChain(
    [{ X: 153 }, { X: 153.1 }, { X: 153.2 }],
    { fireSuppressed: true, activeSource: 'stale', degraded: true }
  );
  const fires = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'X', trigger: 150, confidence: 'MOD', setupType: 'building_base', rank: 1, probabilityScore: 60 }] }),
    chain, onFire: (e) => fires.push(e), onError: () => {}, isMarketOpen: () => true,
  });
  await poller.tick(); await poller.tick(); await poller.tick();
  assert.strictEqual(fires.length, 0);
});

test('dropped candidate is removed from detector when scanner refreshes', async () => {
  const chain = mkFakeChain([{ A: 100, B: 100 }], {});
  let candidates = [
    { symbol: 'A', trigger: 99, confidence: 'MOD', setupType: 'building_base', rank: 1 },
    { symbol: 'B', trigger: 99, confidence: 'MOD', setupType: 'building_base', rank: 2 },
  ];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates }),
    chain, onFire: () => {}, onError: () => {}, isMarketOpen: () => true,
  });
  await poller.tick();
  assert.ok(poller.detector.getState('A'));
  assert.ok(poller.detector.getState('B'));
  // Scanner refresh: B dropped out
  candidates = [{ symbol: 'A', trigger: 99, confidence: 'MOD', setupType: 'building_base', rank: 1 }];
  await poller.tick();
  assert.ok(poller.detector.getState('A'));
  assert.strictEqual(poller.detector.getState('B'), undefined, 'B removed from detector');
});

test('chain.fetchQuotes error surfaces via onError (does not throw)', async () => {
  const chain = {
    async fetchQuotes() { throw new Error('network down'); },
    async probe() {}, activeSourceName: () => 'yahoo', cachePrime: () => {},
  };
  const errors = [];
  const poller = createLivePoller({
    getCandidates: () => ({ candidates: [{ symbol: 'X', trigger: 10, confidence: 'MOD', setupType: 'building_base', rank: 1 }] }),
    chain, onFire: () => {},
    onError: (e) => errors.push(e),
    isMarketOpen: () => true,
  });
  const result = await poller.tick();
  assert.strictEqual(result.skipped, 'fetch_error');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].type, 'fetch_error');
});
