/**
 * calibration.mjs — turns graded signal_outcomes into honest per-signal probabilities.
 *
 * Two numbers per bucket, the ones that matter for an individual-name trader:
 *   P(profit)  — fraction of graded signals with a positive ABSOLUTE return
 *   P(beat)    — fraction that BEAT buy-and-hold (the equal-weight basket)
 *
 * Each comes with a Wilson score interval (a binomial confidence interval that
 * stays honest at small n) and a `reliable` flag, so a 70%-on-n=4 cell is never
 * mistaken for a real probability. A label that can't cite enough samples is a vibe.
 */
import { db } from './db.js';
import { HEADLINE_HORIZON } from './validation.mjs';

const MIN_N = 20; // below this, a bucket rate is not trustworthy

// Wilson score interval for a binomial proportion (k successes of n).
export function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom;
  return [Math.max(0, +(center - margin).toFixed(3)), Math.min(1, +(center + margin).toFixed(3))];
}

function summarize(rows, minN = MIN_N) {
  const n = rows.length;
  const kAbs = rows.filter(r => r.signal_ret > 0).length;
  const kBeat = rows.filter(r => r.excess > 0).length;
  return {
    n,
    p_profit: n ? +(kAbs / n).toFixed(3) : null,
    p_beat:   n ? +(kBeat / n).toFixed(3) : null,
    ci_profit: wilson(kAbs, n),
    ci_beat:   wilson(kBeat, n),
    mean_ret:  n ? +(rows.reduce((a, r) => a + r.signal_ret, 0) / n).toFixed(4) : null,
    reliable:  n >= minN,
  };
}

// Full calibration table at a horizon: overall, by signal_type, and by score band.
export function getCalibration({ horizon = HEADLINE_HORIZON, minN = MIN_N } = {}) {
  const rows = db.prepare(
    'SELECT signal_type, score, regime, signal_ret, excess FROM signal_outcomes WHERE graded_at IS NOT NULL AND signal_ret IS NOT NULL AND horizon=?'
  ).all(horizon);
  const pending = db.prepare('SELECT COUNT(*) n FROM signal_outcomes WHERE graded_at IS NULL AND horizon=?').get(horizon).n;
  if (!rows.length) return { horizon, minN, graded: 0, pending, note: 'no graded signals at this horizon yet' };

  const group = (key, val) => {
    const m = {};
    for (const r of rows) { const g = val(r); if (g == null) continue; (m[g] ||= []).push(r); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, summarize(v, minN)]));
  };

  return {
    horizon, minN, graded: rows.length, pending,
    overall: summarize(rows, minN),
    by_type:  group('signal_type', r => r.signal_type),
    by_score: group('score', r => (r.score != null ? `score_${r.score}` : null)),
    by_regime: group('regime', r => r.regime || 'unknown'),
  };
}

// Look up the two probabilities for a specific signal, narrowest reliable bucket first.
// Falls back type+score -> type -> overall so it always returns something, but reports
// which basis it used and whether that basis had enough samples.
export function calibrateSignal({ signal_type, score, regime, horizon = HEADLINE_HORIZON, minN = MIN_N } = {}) {
  const q = (where, params) => db.prepare(
    `SELECT signal_ret, excess FROM signal_outcomes WHERE graded_at IS NOT NULL AND signal_ret IS NOT NULL AND horizon=? ${where}`
  ).all(horizon, ...params);

  const tries = [
    { basis: 'type+score', rows: () => q('AND signal_type=? AND score=?', [signal_type, score]) },
    { basis: 'type',       rows: () => q('AND signal_type=?', [signal_type]) },
    { basis: 'overall',    rows: () => q('', []) },
  ];
  for (const tr of tries) {
    const s = summarize(tr.rows(), minN);
    if (s.reliable || tr.basis === 'overall') return { ...s, basis: tr.basis, signal_type, score, horizon };
  }
}
