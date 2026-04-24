import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readCandidates } from '../src/lib/candidate_reader.js';

function writeTempResults(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reader-'));
  const p = path.join(dir, 'results.json');
  fs.writeFileSync(p, JSON.stringify(contents));
  return p;
}

test('parses top-15 candidates with alert triggers', () => {
  const p = writeTempResults({
    generated_at: '2026-04-24T16:20:00Z',
    results: [
      { symbol: 'APH', price: 150.38, entry_trigger: 'watchlist — alert at 152.81', probability_score: 66, setup_type: 'building_base', composite_confidence: 'high', rank: 6, confidence_band: { low: 61, mid: 66, high: 71 } },
      { symbol: 'LIN', price: 510.56, entry_trigger: 'watchlist — alert at 510.41', probability_score: 59, setup_type: 'building_base', composite_confidence: 'medium', rank: 15, confidence_band: { low: 54, mid: 59, high: 64 } },
      { symbol: 'NEM', price: 119.89, entry_trigger: 'no entry', probability_score: 62, setup_type: 'extended', composite_confidence: 'high', rank: 4, confidence_band: { low: 57, mid: 62, high: 67 } },
    ],
  });
  const out = readCandidates(p);
  assert.strictEqual(out.scanRunId, '2026-04-24T16:20:00Z');
  assert.strictEqual(out.candidates.length, 2, 'NEM (no entry) should be excluded — no trigger to watch');
  assert.deepStrictEqual(out.candidates[0], {
    symbol: 'APH', trigger: 152.81, triggerText: 'watchlist — alert at 152.81',
    confidence: 'HIGH', setupType: 'building_base', rank: 6,
    confidenceBand: { low: 61, mid: 66, high: 71 }, probabilityScore: 66,
  });
  assert.strictEqual(out.candidates[1].trigger, 510.41);
});

test('returns empty list when results file is missing', () => {
  const out = readCandidates('/nonexistent/path.json');
  assert.strictEqual(out.candidates.length, 0);
  assert.strictEqual(out.error, 'missing');
});

test('returns empty list on malformed JSON', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-reader-'));
  const p = path.join(dir, 'results.json');
  fs.writeFileSync(p, '{not json');
  const out = readCandidates(p);
  assert.strictEqual(out.candidates.length, 0);
  assert.strictEqual(out.error, 'parse');
});

test('normalizes confidence casing to uppercase', () => {
  const p = writeTempResults({
    generated_at: '2026-04-24T16:20:00Z',
    results: [
      { symbol: 'X', price: 10, entry_trigger: 'alert at 11', composite_confidence: 'moderate', setup_type: 'building_base', rank: 1 },
    ],
  });
  assert.strictEqual(readCandidates(p).candidates[0].confidence, 'MODERATE');
});

test('respects topN limit when specified', () => {
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push({ symbol: `T${i}`, price: 10, entry_trigger: 'alert at 11', setup_type: 'building_base', rank: i + 1 });
  const p = writeTempResults({ generated_at: 't', results: rows });
  assert.strictEqual(readCandidates(p, { topN: 5 }).candidates.length, 5);
});

test('scanRunId reads generatedAt (camelCase) when generated_at absent', () => {
  const p = writeTempResults({
    generatedAt: '2026-04-24T18:00:00Z',
    results: [
      { symbol: 'X', price: 10, entry_trigger: 'alert at 11', setup_type: 'building_base', rank: 1 },
    ],
  });
  assert.strictEqual(readCandidates(p).scanRunId, '2026-04-24T18:00:00Z');
});

test('scanRunId is null when neither key is present', () => {
  const p = writeTempResults({
    results: [
      { symbol: 'X', price: 10, entry_trigger: 'alert at 11', setup_type: 'building_base', rank: 1 },
    ],
  });
  assert.strictEqual(readCandidates(p).scanRunId, null);
});

test('trigger <= 0 rows are filtered out (defensive guard)', () => {
  const p = writeTempResults({
    generated_at: 't',
    results: [
      { symbol: 'BAD', price: 10, entry_trigger: 'alert at 0', setup_type: 'building_base', rank: 1 },
      { symbol: 'OK',  price: 10, entry_trigger: 'alert at 11', setup_type: 'building_base', rank: 2 },
    ],
  });
  const out = readCandidates(p);
  assert.strictEqual(out.candidates.length, 1);
  assert.strictEqual(out.candidates[0].symbol, 'OK');
});
