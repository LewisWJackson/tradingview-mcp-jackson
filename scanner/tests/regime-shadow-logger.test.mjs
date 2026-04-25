/**
 * Faz 1 İter 2 — Shadow logger testleri.
 */

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { logRegime, readLog, __internals } from '../lib/learning/regime-shadow-logger.js';

// Test temizliği: işlem başında/sonunda oluşturulan log dosyalarını sil
function cleanTestLogs() {
  const dir = __internals.LOG_DIR;
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith('regime-log-2099-') || f.startsWith('regime-log-2098-')) {
      try { fs.unlinkSync(`${dir}/${f}`); } catch {}
    }
  }
}
cleanTestLogs();
after(cleanTestLogs);

test('1. JSONL append + alan sözleşmesi', () => {
  const now = Date.parse('2099-01-15T12:00:00Z');
  const fakeResult = {
    regime: 'trending_up', subRegime: null, rawRegime: 'trending_up',
    confidence: 0.75, transitioned: true, stableBars: 3, transitionsToday: 1,
    unstable: false, newPositionAllowed: true,
    strategyHint: 'pullback_entry_long', notes: ['adx=30'],
  };
  const r = logRegime({
    symbol: 'BTCUSDT', timeframe: '60', marketType: 'crypto',
    result: fakeResult, now,
  });
  assert.equal(r.ok, true);
  assert.ok(r.path.endsWith('regime-log-2099-01-15.jsonl'));

  const records = readLog('2099-01-15');
  assert.equal(records.length, 1);
  const rec = records[0];
  // DeepSeek sözleşmesindeki alanların hepsi var mı?
  const required = [
    'utcTimestamp', 'symbol', 'timeframe', 'marketType', 'regime',
    'subRegime', 'rawRegime', 'confidence', 'transitioned',
    'barsSinceTransition', 'transitionsToday', 'unstable',
    'newPositionAllowed', 'strategyHint', 'notes',
  ];
  for (const f of required) assert.ok(f in rec, `missing field: ${f}`);
  assert.equal(rec.symbol, 'BTCUSDT');
  assert.equal(rec.transitioned, true);
  assert.equal(rec.barsSinceTransition, 3);
});

test('2. Günlük rotasyon: farklı tarihler farklı dosyaya', () => {
  const day1 = Date.parse('2099-02-01T23:59:00Z');
  const day2 = Date.parse('2099-02-02T00:01:00Z');
  const res = {
    regime: 'ranging', rawRegime: 'ranging', confidence: 0.5,
    transitioned: false, stableBars: 10, transitionsToday: 0,
    unstable: false, newPositionAllowed: true, strategyHint: 'mean_reversion',
    notes: [],
  };
  logRegime({ symbol: 'X', timeframe: '60', marketType: 'crypto', result: res, now: day1 });
  logRegime({ symbol: 'X', timeframe: '60', marketType: 'crypto', result: res, now: day2 });

  assert.equal(readLog('2099-02-01').length, 1);
  assert.equal(readLog('2099-02-02').length, 1);
});

test('3. Hatalı input → ok:false, throw yok (shadow safety)', () => {
  const r = logRegime({ symbol: null, timeframe: null });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('4. notes non-array → boş array fallback', () => {
  const now = Date.parse('2099-03-01T10:00:00Z');
  logRegime({
    symbol: 'Y', timeframe: '60', marketType: 'crypto',
    result: { regime: 'ranging', notes: 'not-an-array' },
    now,
  });
  const recs = readLog('2099-03-01');
  assert.ok(Array.isArray(recs[0].notes));
  assert.equal(recs[0].notes.length, 0);
});
