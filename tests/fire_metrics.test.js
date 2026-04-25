import { test } from 'node:test';
import assert from 'node:assert';
import { computeMetrics, makeComparison, loadFiresFromDir } from '../scripts/dashboard/fire_metrics.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function fakeFire({ level = 2, outcome = null, mfe = null, mae = null, hindsight = null, riskBand = 'green', source = 'yahoo', latencyMs = 30_000, date = '2026-04-24' }) {
  return {
    eventId: Math.random().toString(36).slice(2),
    ticker: 'X',
    firedAt: '2026-04-24T18:00:00.000Z',
    fireStrength: level,
    riskFlags: { overallRiskBand: riskBand },
    debounce: { latencyFromFirstCrossMs: latencyMs, firstCrossObservedAt: '2026-04-24T17:59:30.000Z', confirmedAt: '2026-04-24T18:00:00.000Z' },
    audit: { activeSource: source, degraded: source !== 'yahoo' },
    setup: { confidence: 'MODERATE' },
    outcome,
    maxFavorableExcursionPct: mfe,
    maxAdverseExcursionPct: mae,
    hindsightPlan: hindsight,
    date,
  };
}

test('computeMetrics returns zero report on empty input', () => {
  const r = computeMetrics([]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.byLevel[2].count, 0);
  assert.strictEqual(r.byLevel[3].count, 0);
});

test('counts fires per level (Level 2 vs Level 3)', () => {
  const r = computeMetrics([
    fakeFire({ level: 2 }),
    fakeFire({ level: 2 }),
    fakeFire({ level: 3 }),
  ]);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.byLevel[2].count, 2);
  assert.strictEqual(r.byLevel[3].count, 1);
});

test('win rate by level computed only over tagged fires', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, outcome: 'continued' }),
    fakeFire({ level: 2, outcome: 'faded' }),
    fakeFire({ level: 2 }),  // untagged — excluded
    fakeFire({ level: 3, outcome: 'continued' }),
    fakeFire({ level: 3, outcome: 'continued' }),
  ]);
  assert.strictEqual(r.byLevel[2].tagged, 2);
  assert.strictEqual(r.byLevel[2].winRate, 0.5);
  assert.strictEqual(r.byLevel[3].tagged, 2);
  assert.strictEqual(r.byLevel[3].winRate, 1.0);
});

test('false breakout rate counts faded + whipsaw', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, outcome: 'continued' }),
    fakeFire({ level: 2, outcome: 'faded' }),
    fakeFire({ level: 2, outcome: 'whipsaw' }),
    fakeFire({ level: 2, outcome: 'earnings_gap' }),
  ]);
  // 2 of 4 are false breakouts (faded + whipsaw)
  assert.strictEqual(r.byLevel[2].falseBreakoutRate, 0.5);
});

test('average MFE / MAE by level', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, mfe: 2, mae: 1 }),
    fakeFire({ level: 2, mfe: 4, mae: 3 }),
    fakeFire({ level: 3, mfe: 5, mae: 1 }),
    fakeFire({ level: 3, mfe: 7, mae: 2 }),
  ]);
  assert.strictEqual(r.byLevel[2].avgMFE, 3);
  assert.strictEqual(r.byLevel[2].avgMAE, 2);
  assert.strictEqual(r.byLevel[3].avgMFE, 6);
  assert.strictEqual(r.byLevel[3].avgMAE, 1.5);
});

test('hindsight plan distribution counted per level', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, hindsight: 'STOCK_ONLY' }),
    fakeFire({ level: 2, hindsight: 'CSP_ONLY' }),
    fakeFire({ level: 2, hindsight: 'AVOID' }),
    fakeFire({ level: 2 }), // untagged
    fakeFire({ level: 3, hindsight: 'BOTH' }),
    fakeFire({ level: 3, hindsight: 'STOCK_ONLY' }),
  ]);
  assert.strictEqual(r.byLevel[2].hindsightPlanDistribution.STOCK_ONLY, 1);
  assert.strictEqual(r.byLevel[2].hindsightPlanDistribution.CSP_ONLY, 1);
  assert.strictEqual(r.byLevel[2].hindsightPlanDistribution.AVOID, 1);
  assert.strictEqual(r.byLevel[2].hindsightPlanDistribution.untagged, 1);
  assert.strictEqual(r.byLevel[3].hindsightPlanDistribution.BOTH, 1);
  assert.strictEqual(r.byLevel[3].hindsightPlanDistribution.STOCK_ONLY, 1);
});

test('comparison: insufficient_data when one level has no tagged fires', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, outcome: 'continued' }),
    fakeFire({ level: 3 }), // no outcome
  ]);
  assert.strictEqual(r.comparison.verdict, 'insufficient_data');
});

test('comparison: level_3_better when L3 wins on win rate + MFE + MAE', () => {
  const r = computeMetrics([
    // L2 weaker
    fakeFire({ level: 2, outcome: 'faded',     mfe: 1, mae: 3 }),
    fakeFire({ level: 2, outcome: 'continued', mfe: 2, mae: 2 }),
    // L3 stronger
    fakeFire({ level: 3, outcome: 'continued', mfe: 5, mae: 1 }),
    fakeFire({ level: 3, outcome: 'continued', mfe: 6, mae: 1 }),
  ]);
  assert.strictEqual(r.comparison.verdict, 'level_3_better');
  assert.strictEqual(r.comparison.l3OutperformsOnWinRate, true);
  assert.strictEqual(r.comparison.l3OutperformsOnMFE, true);
  assert.strictEqual(r.comparison.l3OutperformsOnMAE, true);
});

test('comparison: level_2_better when L2 wins on all three', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, outcome: 'continued', mfe: 5, mae: 1 }),
    fakeFire({ level: 2, outcome: 'continued', mfe: 6, mae: 1 }),
    fakeFire({ level: 3, outcome: 'faded',     mfe: 1, mae: 3 }),
    fakeFire({ level: 3, outcome: 'continued', mfe: 2, mae: 2 }),
  ]);
  assert.strictEqual(r.comparison.verdict, 'level_2_better');
});

test('comparison: mixed verdict when signals conflict', () => {
  // L3 wins on win rate, L2 wins on MFE — exactly one win each, MAE tied
  const r = computeMetrics([
    fakeFire({ level: 2, outcome: 'continued', mfe: 10, mae: 2 }),
    fakeFire({ level: 2, outcome: 'faded',     mfe: 10, mae: 2 }),
    fakeFire({ level: 3, outcome: 'continued', mfe: 1, mae: 2 }),
    fakeFire({ level: 3, outcome: 'continued', mfe: 1, mae: 2 }),
  ]);
  assert.strictEqual(r.comparison.verdict, 'mixed');
});

test('risk band distribution counts across all levels', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, riskBand: 'green' }),
    fakeFire({ level: 2, riskBand: 'red' }),
    fakeFire({ level: 3, riskBand: 'yellow' }),
  ]);
  assert.deepStrictEqual(r.riskBand, { green: 1, red: 1, yellow: 1 });
});

test('median fire latency computed in milliseconds', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, latencyMs: 15_000 }),
    fakeFire({ level: 2, latencyMs: 30_000 }),
    fakeFire({ level: 3, latencyMs: 45_000 }),
  ]);
  assert.strictEqual(r.medianLatencyMs, 30_000);
});

test('degraded-source fires counted (anything not yahoo)', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, source: 'yahoo' }),
    fakeFire({ level: 2, source: 'tv_cdp' }),
    fakeFire({ level: 3, source: 'stale' }),
  ]);
  assert.strictEqual(r.degradedSourceFires, 2);
});

test('fires/day computed across distinct dates', () => {
  const r = computeMetrics([
    fakeFire({ level: 2, date: '2026-04-22' }),
    fakeFire({ level: 2, date: '2026-04-23' }),
    fakeFire({ level: 3, date: '2026-04-23' }),
    fakeFire({ level: 3, date: '2026-04-24' }),
  ]);
  assert.strictEqual(r.days, 3);
  assert.strictEqual(r.firesPerDay, +(4 / 3).toFixed(2));
});

test('makeComparison returns insufficient_data when a level has no tagged fires', () => {
  const c = makeComparison(
    { tagged: 0, winRate: null, avgMFE: null, avgMAE: null },
    { tagged: 5, winRate: 0.6, avgMFE: 5, avgMAE: 2 },
  );
  assert.strictEqual(c.verdict, 'insufficient_data');
});

test('loadFiresFromDir returns [] for missing directory', () => {
  assert.deepStrictEqual(loadFiresFromDir('/nonexistent/dir'), []);
});

test('loadFiresFromDir reads multiple daily files in date order', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-metrics-'));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-22.json'), JSON.stringify({ date: '2026-04-22', fires: [{ ticker: 'A', fireStrength: 2 }] }));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-23.json'), JSON.stringify({ date: '2026-04-23', fires: [{ ticker: 'B', fireStrength: 3 }, { ticker: 'C', fireStrength: 2 }] }));
  fs.writeFileSync(path.join(dir, 'unrelated.json'), '{}');  // should be ignored
  const fires = loadFiresFromDir(dir);
  assert.strictEqual(fires.length, 3);
  assert.strictEqual(fires[0].date, '2026-04-22');
  assert.strictEqual(fires[1].date, '2026-04-23');
});

test('loadFiresFromDir filters by --date', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-metrics-'));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-22.json'), JSON.stringify({ date: '2026-04-22', fires: [{ fireStrength: 2 }] }));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-23.json'), JSON.stringify({ date: '2026-04-23', fires: [{ fireStrength: 3 }] }));
  const fires = loadFiresFromDir(dir, { date: '2026-04-23' });
  assert.strictEqual(fires.length, 1);
  assert.strictEqual(fires[0].date, '2026-04-23');
});

test('loadFiresFromDir filters by --since', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fire-metrics-'));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-22.json'), JSON.stringify({ date: '2026-04-22', fires: [{ fireStrength: 2 }] }));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-23.json'), JSON.stringify({ date: '2026-04-23', fires: [{ fireStrength: 3 }] }));
  fs.writeFileSync(path.join(dir, 'coiled_spring_fires_2026-04-24.json'), JSON.stringify({ date: '2026-04-24', fires: [{ fireStrength: 2 }] }));
  const fires = loadFiresFromDir(dir, { since: '2026-04-23' });
  assert.strictEqual(fires.length, 2);
});
