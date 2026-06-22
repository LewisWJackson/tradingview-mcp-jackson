/**
 * Tests for the strategy state machine: pure decision logic (no DB) +
 * persistence wiring round-trip (promote/evaluate/getState/transitions via SQLite).
 * Run: node --experimental-sqlite --test tests/strategy_state.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { decide, gateMet, exposureFor, CFG, promote, evaluate, getState, transitions } from '../dashboard/strategy_state.mjs';
import { ingestIndexEvents, getIndexEvents, indexEventsSummary } from '../dashboard/index_events.mjs';
import { db } from '../dashboard/db.js';

// baseline evidence that PASSES the promotion gate
const pass = { n: 30, t: 2.9, halfT1: 2.3, halfT2: 1.8, netMean: 0.012, rollMean: 0.012, rollT: 2.5, roll18Mean: 0.011, currentDD: -0.05 };

describe('gateMet', () => {
  it('passes a clean strategy', () => assert.equal(gateMet(pass, CFG), true));
  it('fails on too few periods', () => assert.equal(gateMet({ ...pass, n: 20 }, CFG), false));
  it('fails on t<=2', () => assert.equal(gateMet({ ...pass, t: 1.9 }, CFG), false));
  it('fails on weak half', () => assert.equal(gateMet({ ...pass, halfT2: 1.0 }, CFG), false));
  it('fails on negative net', () => assert.equal(gateMet({ ...pass, netMean: -0.001 }, CFG), false));
});

describe('exposureFor', () => {
  it('maps states to multipliers', () => {
    assert.equal(exposureFor('promoted'), 1.0);
    assert.equal(exposureFor('decaying'), 0.5);
    assert.equal(exposureFor('candidate'), 0);
    assert.equal(exposureFor('retired'), 0);
  });
});

describe('decide — manual up (no auto-apply)', () => {
  it('candidate meeting gate is RECOMMENDED promote, not auto-applied', () => {
    const r = decide('candidate', pass);
    assert.equal(r.state, 'candidate');
    assert.equal(r.recommendedAction, 'promote');
    assert.equal(r.actor, null);
    assert.equal(r.exposureMult, 0);
  });
  it('candidate failing gate gets no recommendation', () => {
    const r = decide('candidate', { ...pass, t: 1.0 });
    assert.equal(r.recommendedAction, null);
  });
});

describe('decide — auto risk-down', () => {
  it('promoted decays on rolling-12 negative', () => {
    const r = decide('promoted', { ...pass, rollMean: -0.003 });
    assert.equal(r.state, 'decaying');
    assert.equal(r.actor, 'auto');
    assert.equal(r.exposureMult, 0.5);
  });
  it('promoted decays on rolling t<1', () => {
    const r = decide('promoted', { ...pass, rollT: 0.8 });
    assert.equal(r.state, 'decaying');
  });
  it('promoted decays on DD < -20%', () => {
    const r = decide('promoted', { ...pass, currentDD: -0.22 });
    assert.equal(r.state, 'decaying');
  });
  it('retires on rolling-18 negative (sustained)', () => {
    const r = decide('promoted', { ...pass, roll18Mean: -0.002 });
    assert.equal(r.state, 'retired');
    assert.equal(r.exposureMult, 0);
  });
  it('retires on DD <= -30% circuit-breaker regardless of rolling', () => {
    const r = decide('promoted', { ...pass, currentDD: -0.31 });
    assert.equal(r.state, 'retired');
    assert.equal(r.actor, 'auto');
  });
  it('decaying retires on DD floor', () => {
    const r = decide('decaying', { ...pass, currentDD: -0.31 });
    assert.equal(r.state, 'retired');
  });
});

describe('decide — no auto up', () => {
  it('retired with recovered rolling is RECOMMENDED, not auto-promoted', () => {
    const r = decide('retired', { ...pass, rollT: 2.6, rollMean: 0.01 });
    assert.equal(r.state, 'retired');
    assert.equal(r.recommendedAction, 'promote');
    assert.equal(r.actor, null);
  });
  it('healthy promoted stays promoted, full exposure', () => {
    const r = decide('promoted', pass);
    assert.equal(r.state, 'promoted');
    assert.equal(r.exposureMult, 1.0);
    assert.equal(r.actor, null);
  });
});

describe('decide — thin-data evidence (null rolling stats)', () => {
  // When too few periods exist, strategy_validation emits null rolling fields.
  // The null guards must prevent a spurious decay/retire on a healthy promoted strategy.
  it('null rolling stats do not auto-decay a promoted strategy', () => {
    const r = decide('promoted', { ...pass, rollMean: null, rollT: null, roll18Mean: null });
    assert.equal(r.state, 'promoted');
    assert.equal(r.actor, null);
  });
  it('DD floor still retires even with null rolling stats', () => {
    const r = decide('promoted', { ...pass, rollMean: null, rollT: null, roll18Mean: null, currentDD: -0.31 });
    assert.equal(r.state, 'retired');
    assert.equal(r.actor, 'auto');
  });
});

// ── Persistence wiring (DB round-trip) ──────────────────────────────────────
// The pure tests above never exercise promote/evaluate/getState against SQLite —
// exactly where the "Lab shows stale state after promote" class of bug lived.
// These assert a promote/auto-decay actually persists and reads back (the data
// half of that defect). Full API+cache e2e needs bar fixtures, out of scope here.
describe('persistence wiring (DB round-trip)', () => {
  const TID = '__test_strat__';
  const wipe = () => db.exec(`DELETE FROM strategy_state WHERE strategy_id='${TID}'; DELETE FROM strategy_transitions WHERE strategy_id='${TID}';`);
  before(wipe);
  after(wipe);

  it('unseen strategy defaults to candidate / exposure 0', () => {
    wipe();
    const s = getState(TID);
    assert.equal(s.state, 'candidate');
    assert.equal(s.exposure_mult, 0);
  });

  it('promote persists promoted/1.0 and is read back by getState', () => {
    wipe();
    const r = promote(TID, pass);
    assert.equal(r.ok, true);
    assert.equal(r.state, 'promoted');
    const s = getState(TID);
    assert.equal(s.state, 'promoted');
    assert.equal(s.exposure_mult, 1.0);
  });

  it('promote with failing gate is rejected and does not persist', () => {
    wipe();
    const r = promote(TID, { ...pass, t: 0.5 });
    assert.equal(r.ok, false);
    assert.equal(getState(TID).state, 'candidate');
  });

  it('auto-decay persists and logs an auto transition', () => {
    wipe();
    promote(TID, pass);                                       // → promoted
    const res = evaluate(TID, { ...pass, rollMean: -0.01, rollT: 0.5 });
    assert.equal(res.changed, true);
    assert.equal(res.state, 'decaying');
    const s = getState(TID);
    assert.equal(s.state, 'decaying');
    assert.equal(s.exposure_mult, 0.5);
    const log = transitions(TID, 5);
    assert.ok(log.some(t => t.from_state === 'promoted' && t.to_state === 'decaying' && t.actor === 'auto'));
  });
});

describe('index_events ingest', () => {
  it('ingests valid add/delete events, rejects bad rows, dedups re-runs', () => {
    // idempotent across runs: the DB persists, so clear this test's own rows first
    db.prepare("DELETE FROM index_events WHERE source='test'").run();
    const rows = [
      { code: '1120', action: 'add',    review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' },
      { code: '2222', action: 'delete', review: '2024-11', announce_date: '2024-11-06', effective_date: '2024-11-25', index: 'MSCI Saudi', source: 'test' },
      { code: 'XX',   action: 'add',    review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' }, // bad code
      { code: '1120', action: 'sideways', review: '2019-05', announce_date: '2019-05-14', effective_date: '2019-05-28', index: 'MSCI Saudi', source: 'test' }, // bad action
      { code: '1120', action: 'add',    review: '2019-05', announce_date: '2019/05/14', effective_date: 'nope',       index: 'MSCI Saudi', source: 'test' }, // bad date
    ];
    const r1 = ingestIndexEvents(rows);
    assert.equal(r1.inserted, 2, `expected 2 inserted, got ${r1.inserted}`);
    assert.equal(r1.skipped, 3, `expected 3 skipped, got ${r1.skipped}`);
    // re-run is idempotent
    const r2 = ingestIndexEvents(rows);
    assert.equal(r2.inserted, 0, 'second ingest should insert nothing (UNIQUE dedup)');

    const adds = getIndexEvents({ action: 'add' });
    assert.ok(adds.some(e => e.sym === 'TADAWUL:1120' && e.effective_date === '2019-05-28'));
    const sum = indexEventsSummary();
    assert.ok(sum.total >= 2 && sum.adds >= 1 && sum.deletes >= 1, JSON.stringify(sum));
  });
});
