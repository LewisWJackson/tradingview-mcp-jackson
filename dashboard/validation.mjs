/**
 * validation.mjs — the validation spine.
 *
 * Every signal is logged with its entry bar/price, then graded once its horizon
 * has elapsed by its forward EXCESS return vs an equal-weight TASI basket over the
 * same window, net of cost. This is the honest edge metric; the accuracy_signals
 * stop/target hit-rate flatters signals in a rising tape (see scripts/backtest_logic.mjs).
 *
 * Price access is injected (getBars/universe) so the server (Yahoo-backed), scripts,
 * and tests all share one grading implementation and can never drift.
 */
import { db } from './db.js';

export const HORIZONS = [5, 10, 20];
export const HEADLINE_HORIZON = 20;
// Derayah real round-trip = ~0.11% (regulatory fees only, no commission). Env-overridable.
export const COST_RT = +process.env.COST_RT || 0.0011;

// Lifecycle status per signal family. Until the state machine (P2) automates this, it's a
// seed: every per-signal family is EXPERIMENTAL (no proven edge — the 9-pt score family
// tested t=0.74, the opportunity engine is score-derived). Validated edges live as
// STRATEGIES (strategy_validation.mjs), not per-signal rows. Nothing here is "promoted".
export const FAMILY_STATUS = {
  STRONG_BUY: 'retired',            // 9-pt score — definitively dead (portfolio t=0.74)
  STRONG_BUY_CONFIRMED: 'experimental',
  SCORE_TRAJECTORY: 'experimental',
  PRE_BREAKOUT_COIL: 'experimental',
  STEALTH_RS_LEADER: 'experimental',
  VOLATILITY_EXPANSION: 'experimental',
  DIVERGENCE_REVERSAL: 'experimental',
  SMART_MONEY_ACCUMULATION: 'experimental',
  INSIDER_TECHNICAL_SYNC: 'experimental',
  MTF_CONFLUENCE: 'experimental',
};
export const familyStatus = (t) => FAMILY_STATUS[t] || 'experimental';

// ── logging ────────────────────────────────────────────────────────────────
// Insert one pending row per horizon. Idempotent via the UNIQUE constraint.
const _ins = db.prepare(`
  INSERT OR IGNORE INTO signal_outcomes
    (sym, source, signal_type, score, conviction, entry_date, entry_price, horizon, regime)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
export function logSignal({ sym, source, signal_type, score = null, conviction = null, entry_date, entry_price, regime = null }) {
  if (!sym || !entry_date || !(entry_price > 0)) return 0;
  let n = 0;
  for (const h of HORIZONS) n += _ins.run(sym, source, signal_type, score, conviction, entry_date, entry_price, h, regime).changes;
  return n;
}

// Sync pending rows from the source signal tables (idempotent). Lets the spine
// capture every STRONG BUY and opportunity signal without touching each creation
// path — one daily sync keeps signal_outcomes complete.
export function backfillFromTables() {
  let n = 0;
  for (const r of db.prepare("SELECT sym, substr(logged_at,1,10) d, price_entry, score, regime FROM accuracy_signals WHERE bias='STRONG BUY' AND price_entry > 0").all())
    n += logSignal({ sym: r.sym, source: 'scoreBias', signal_type: 'STRONG_BUY', score: r.score, entry_date: r.d, entry_price: r.price_entry, regime: r.regime });
  for (const r of db.prepare("SELECT sym, signal_type, conviction, substr(detected_at,1,10) d, discovery_price FROM opportunity_signals WHERE discovery_price > 0").all())
    n += logSignal({ sym: r.sym, source: 'opportunity', signal_type: r.signal_type, conviction: r.conviction, entry_date: r.d, entry_price: r.discovery_price });
  return n;
}

// ── grading ──────────────────────────────────────────────────────────────────
// getBars(sym) -> sorted [{date:'YYYY-MM-DD', close:Number}] (may be cached by caller)
// universe -> array of TASI syms for the equal-weight basket
export async function gradePending({ getBars, universe, cost = COST_RT } = {}) {
  const pending = db.prepare('SELECT * FROM signal_outcomes WHERE graded_at IS NULL ORDER BY entry_date').all();
  if (!pending.length) return { graded: 0, stillPending: 0 };

  // basket cache: `${date}|${h}` -> equal-weight forward return (or null)
  const basketCache = new Map();
  const barsCache = new Map();
  const bars = async (s) => { if (!barsCache.has(s)) barsCache.set(s, await getBars(s)); return barsCache.get(s); };

  function fwdAt(arr, date, h) {
    const i = arr.findIndex(b => b.date >= date);
    if (i < 0 || i + h >= arr.length) return null;
    return { ret: arr[i + h].close / arr[i].close - 1, fwdPrice: arr[i + h].close };
  }
  async function basket(date, h) {
    const k = date + '|' + h;
    if (basketCache.has(k)) return basketCache.get(k);
    const rs = [];
    for (const s of universe) { const f = fwdAt(await bars(s), date, h); if (f) rs.push(f.ret); }
    const v = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
    basketCache.set(k, v); return v;
  }

  const upd = db.prepare(`UPDATE signal_outcomes SET graded_at=?, fwd_price=?, signal_ret=?, basket_ret=?, excess=?, excess_net=? WHERE id=?`);
  let graded = 0, stillPending = 0;
  const now = new Date().toISOString();

  for (const row of pending) {
    const sb = await bars(row.sym);
    const f = sb && fwdAt(sb, row.entry_date, row.horizon);
    if (!f) { stillPending++; continue; }              // horizon not elapsed yet (or no data)
    const bret = await basket(row.entry_date, row.horizon);
    if (bret == null) { stillPending++; continue; }
    const excess = f.ret - bret;
    upd.run(now, f.fwdPrice, f.ret, bret, excess, excess - cost, row.id);
    graded++;
  }
  return { graded, stillPending };
}

// ── stats ─────────────────────────────────────────────────────────────────────
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = (a) => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;

// Greedy overlap correction: per (sym), keep entries spaced >= horizon trading
// sessions apart (~horizon*7/5 calendar days) so forward windows barely overlap.
function overlapCorrected(rows, horizon) {
  const gapDays = Math.ceil(horizon * 7 / 5);
  const bySym = {};
  for (const r of rows.sort((a, b) => a.entry_date < b.entry_date ? -1 : 1)) (bySym[r.sym] ||= []).push(r);
  const kept = [];
  for (const list of Object.values(bySym)) {
    let last = null;
    for (const r of list) {
      const d = new Date(r.entry_date).getTime();
      if (last == null || (d - last) / 86400000 >= gapDays) { kept.push(r); last = d; }
    }
  }
  return kept;
}

function summarize(rows) {
  const ex = rows.map(r => r.excess);
  const net = rows.map(r => r.excess_net);
  return {
    n: rows.length,
    excess_mean: +(mean(ex) || 0).toFixed(5),
    excess_median: +(median(ex) || 0).toFixed(5),
    net_mean: +(mean(net) || 0).toFixed(5),
    beat_rate: rows.length ? +(ex.filter(x => x > 0).length / rows.length).toFixed(3) : 0,
    t_raw: +(tstat(ex) || 0).toFixed(2),
  };
}

export function getValidationStats({ horizon = HEADLINE_HORIZON } = {}) {
  const graded = db.prepare('SELECT * FROM signal_outcomes WHERE graded_at IS NOT NULL AND horizon=?').all(horizon);
  const pending = db.prepare('SELECT COUNT(*) n FROM signal_outcomes WHERE graded_at IS NULL AND horizon=?').get(horizon).n;
  if (!graded.length) return { horizon, headline_horizon: HEADLINE_HORIZON, cost_rt: COST_RT, graded: 0, pending, note: 'no graded signals yet' };

  const indep = overlapCorrected(graded, horizon);
  const group = (key, withStatus = false) => {
    const m = {};
    for (const r of graded) { const g = r[key] || 'unknown'; (m[g] ||= []).push(r); }
    return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, withStatus ? { ...summarize(v), status: familyStatus(k) } : summarize(v)]));
  };

  return {
    horizon, headline_horizon: HEADLINE_HORIZON, cost_rt: COST_RT, pending,
    all: summarize(graded),
    overlap_corrected: { ...summarize(indep), note: 'one signal per stock per horizon-window; t_raw here is the honest significance' },
    by_type: group('signal_type', true),
    by_regime: group('regime'),
    note: 'Per-signal families are all EXPERIMENTAL (no proven edge). Validated edges are tracked as strategies — see /api/lab/strategy.',
  };
}
