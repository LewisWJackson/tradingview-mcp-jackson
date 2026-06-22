/**
 * strategy_state.mjs — the strategy lifecycle governor.
 *
 * Pure decision logic (decide/gateMet/exposureFor) + thin DB persistence.
 * Asymmetric: the machine only AUTO-moves a strategy DOWN (cut risk); every move
 * UP (add risk), including recovery, requires a confirmed user action.
 * Spec: docs/superpowers/specs/2026-06-17-strategy-state-machine-design.md
 */

import { db } from './db.js';

export const CFG = {
  PROMOTE_MIN_N: 24, PROMOTE_T: 2.0, PROMOTE_HALF_T: 1.5,
  ROLL_WINDOW: 12, DECAY_ROLL_T: 1.0, DECAY_DD: -0.20,
  RETIRE_WINDOW: 18, RETIRE_DD: -0.30,
};

const EXPOSURE = { promoted: 1.0, decaying: 0.5, candidate: 0, retired: 0 };
export const exposureFor = (state) => EXPOSURE[state] ?? 0;

export function gateMet(ev, cfg = CFG) {
  return ev.n >= cfg.PROMOTE_MIN_N && ev.t > cfg.PROMOTE_T &&
    ev.halfT1 > cfg.PROMOTE_HALF_T && ev.halfT2 > cfg.PROMOTE_HALF_T && ev.netMean > 0;
}

// Pure: given current state + evidence, return resulting state after AUTO risk-down,
// plus a manual up-recommendation if applicable. Never auto-applies an up-move.
export function decide(currentState, ev, cfg = CFG) {
  let state = currentState, actor = null, reason = null;
  const pc = v => (v * 100).toFixed(2) + '%';

  if (currentState === 'promoted' || currentState === 'decaying') {
    if (ev.currentDD <= cfg.RETIRE_DD) {
      state = 'retired'; actor = 'auto'; reason = `drawdown ${pc(ev.currentDD)} ≤ ${pc(cfg.RETIRE_DD)} circuit-breaker`;
    } else if (ev.roll18Mean != null && ev.roll18Mean < 0) {
      state = 'retired'; actor = 'auto'; reason = `rolling-${cfg.RETIRE_WINDOW} excess ${pc(ev.roll18Mean)} < 0 (sustained)`;
    } else if (currentState === 'promoted' &&
      ((ev.rollMean != null && ev.rollMean < 0) || (ev.rollT != null && ev.rollT < cfg.DECAY_ROLL_T) || ev.currentDD < cfg.DECAY_DD)) {
      state = 'decaying'; actor = 'auto';
      reason = `rolling-${cfg.ROLL_WINDOW} weakening (mean ${pc(ev.rollMean)}, t ${ev.rollT}, DD ${pc(ev.currentDD)})`;
    }
  }

  let recommendedAction = null;
  if (state === 'candidate') {
    if (gateMet(ev, cfg)) recommendedAction = 'promote';
  } else if (state === 'decaying' || state === 'retired') {
    if (ev.rollT != null && ev.rollT > cfg.PROMOTE_T && ev.rollMean > 0) recommendedAction = 'promote'; // recovery
  }

  return { state, exposureMult: exposureFor(state), actor, reason, recommendedAction };
}

const _get = db.prepare('SELECT * FROM strategy_state WHERE strategy_id=?');
const _upsert = db.prepare(`
  INSERT INTO strategy_state (strategy_id, state, since, evidence, exposure_mult, updated_at)
  VALUES (@id, @state, @since, @evidence, @mult, @at)
  ON CONFLICT(strategy_id) DO UPDATE SET
    state=@state, since=@since, evidence=@evidence, exposure_mult=@mult, updated_at=@at`);
const _log = db.prepare(`
  INSERT INTO strategy_transitions (strategy_id, from_state, to_state, reason, actor, evidence, at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

// Read current persisted state (defaults to candidate / exposure 0 if unseen).
export function getState(id) {
  const r = _get.get(id);
  if (!r) return { strategy_id: id, state: 'candidate', exposure_mult: 0, since: null };
  return r;
}

export function transitions(id, limit = 10) {
  return db.prepare('SELECT * FROM strategy_transitions WHERE strategy_id=? ORDER BY id DESC LIMIT ?').all(id, limit);
}

function write(id, toState, mult, reason, actor, ev) {
  const at = new Date().toISOString();
  const cur = _get.get(id);
  _upsert.run({ id, state: toState, since: at.slice(0, 10), evidence: JSON.stringify(ev || {}), mult, at });
  _log.run(id, cur ? cur.state : null, toState, reason, actor, JSON.stringify(ev || {}), at);
}

// Apply AUTO risk-down transitions for one strategy given fresh evidence.
// Returns { state, exposure_mult, recommendedAction, changed }.
export function evaluate(id, ev, cfg = CFG) {
  const cur = getState(id);
  const d = decide(cur.state, ev, cfg);
  const changed = d.state !== cur.state;
  if (changed && d.actor === 'auto') write(id, d.state, d.exposureMult, d.reason, 'auto', ev);
  else if (!_get.get(id)) write(id, cur.state, exposureFor(cur.state), 'initialized', 'auto', ev); // seed row
  return { state: d.state, exposure_mult: exposureFor(d.state), recommendedAction: d.recommendedAction, changed };
}

// MANUAL up-transition (user-confirmed). Re-checks eligibility; returns {ok,error?}.
export function promote(id, ev, cfg = CFG) {
  const cur = getState(id);
  const eligible = cur.state === 'candidate'
    ? gateMet(ev, cfg)
    : (cur.state === 'decaying' || cur.state === 'retired') && ev.rollT != null && ev.rollT > cfg.PROMOTE_T && ev.rollMean > 0;
  if (!eligible) return { ok: false, error: 'Promotion gate not met' };
  write(id, 'promoted', 1.0, 'manual promotion (user-confirmed)', 'user', ev);
  return { ok: true, state: 'promoted', exposure_mult: 1.0 };
}

export function allStates() {
  return db.prepare('SELECT * FROM strategy_state').all();
}
