/**
 * strategy_validation.mjs — grade STRATEGIES (portfolios), not isolated signals.
 *
 * The per-signal spine (validation.mjs) mis-measures a monthly-rebalanced strategy because
 * many names fire on the same date (cross-sectional clustering inflates t). The honest unit
 * for a strategy is the REBALANCE PERIOD: one observation per non-overlapping holding window.
 * This reproduces scripts/signal_showdown.mjs live, so the Lab's strategy edge == the
 * research number (momentum excess +1.57%/period, t≈3.6).
 *
 * Currently grades the one validated strategy (momentum-sharia). Equal-weight all-universe
 * basket, Derayah 0.11% RT, COVID carved out. Cached (slow recompute) with a TTL.
 */
import { getBars, warm, iso } from '../scripts/bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from '../scripts/tasi_screener.mjs';
import { evaluate, transitions } from './strategy_state.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011;
// Accepted survivorship haircut: Yahoo gives listed-only names, so backtest CAGR is
// optimistic. Bias bounded ~1-1.5%/yr on the liquid universe (most TASI exits are
// value-preserving mergers, failures skew illiquid → filtered out). No cheap
// survivorship-free TASI source exists (EODHD/TwelveData/FMP all checked). We DISCLOSE
// rather than correct the series: excess-vs-basket is haircut-robust; absolute CAGR is not.
const SURVIVORSHIP_HAIRCUT = +process.env.SURVIVORSHIP_HAIRCUT || 0.015;
const START = '2020-01-01', COVID0 = '2020-02-20', COVID1 = '2021-03-31';
const inCovid = d => d >= COVID0 && d <= COVID1;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? mean(a) / (sd(a) / Math.sqrt(a.length)) : NaN;

// statusWhy must track the state-machine state, NOT the promotion grader — a
// decaying/retired strategy showing a "passed the gate" rationale is misleading.
// Pure so the decaying/retired/candidate branches are unit-testable without bars.
export function buildStatusWhy(state, gradeWhy, lastReason, recommendedAction) {
  return state === 'promoted' ? `Live at full Scheme-D sizing — ${gradeWhy}.`
    : state === 'decaying' ? `Risk halved (decaying)${lastReason ? ` — ${lastReason}` : ''}.`
    : state === 'retired'  ? `Retired, 0% sizing${lastReason ? ` — ${lastReason}` : ''}.`
    : recommendedAction === 'promote' ? `Cleared the gate (${gradeWhy}) — promote to deploy.`
    : gradeWhy;
}

// Promotion gate (seed for the P2 state machine): real, significant, enough multi-regime data.
function gradeStatus({ t, netMean, n, h1t, h2t }) {
  if (n < 24) return { status: 'candidate', why: `only ${n} periods (<24 ≈ 2y) — not enough to promote` };
  if (!(netMean > 0) || !(t > 2)) return { status: 'candidate', why: `net ${(netMean * 100).toFixed(2)}%/period, t=${t.toFixed(2)} — needs net>0 AND t>2` };
  if (!(h1t > 1.5 && h2t > 1.5)) return { status: 'candidate', why: `not stable across both halves (t ${h1t?.toFixed(1)}/${h2t?.toFixed(1)})` };
  return { status: 'promoted', why: `net>0, t=${t.toFixed(2)}>2, stable both halves, ${n} periods` };
}

let _cache = null;
// Drop the memoized result so the next read recomputes against current DB state.
// Must be called after any out-of-band strategy_state mutation (e.g. manual promote),
// otherwise the Lab API serves a pre-mutation snapshot for up to the TTL.
export function bustCache() { _cache = null; }
export async function getStrategyValidation({ ttlMs = 6 * 3600 * 1000 } = {}) {
  if (_cache && Date.now() - _cache.at < ttlMs) return _cache.data;

  // LEAK FIX (Sharia): we do NOT intersect the historical backtest universe with today's
  // compliant set. sharia_data.json has a single `asOf` per name (no dated history), so
  // applying it to 2020-2026 rebalances is retroactive look-ahead (a name compliant today
  // may not have been then, and vice-versa). Sharia is a LIVE-ONLY filter, applied at
  // screen time in momentum_screen.mjs — not baked into the historical grade. The grade
  // therefore runs on the full liquid universe; this is the honest, leak-free measurement.
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)).concat('^TASI.SR'), '10y');

  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    data[s.sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v), idx: Object.fromEntries(b.map((x, i) => [iso(x.t), i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; const i = d.idx[date]; if (i == null || i + H >= d.c.length) return null; return d.c[i + H] / d.c[i] - 1; };
  const ewC = {};
  const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const periods = [];
  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START || inCovid(date)) continue;
    const bench = ew(date); if (bench == null) continue;
    const rows = [];
    for (const s of usable) {
      // No compliant-Set intersection here — Sharia is a live-only filter (see note above).
      const d = data[s]; const i = d.idx[date];
      if (i == null || i < 504 || i + H >= d.c.length) continue;
      const mom6 = d.c[i - 21] / d.c[i - 126] - 1; if (!isFinite(mom6)) continue;
      // 52-week-high proximity, point-in-time: only bars up to the rebalance index i.
      let hi52 = -Infinity; for (let k = Math.max(0, i - 251); k <= i; k++) hi52 = Math.max(hi52, d.c[k]);
      const wk52 = hi52 > 0 ? d.c[i] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += d.c[k] * (d.v[k] || 0); n++; }
      rows.push({ s, mom6, wk52, liq: liq / n });
    }
    if (rows.length < 10) continue;
    const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * 0.5));
    // CORE SIGNAL = the LIVE combo (mirrors momentum_screen.mjs lines 99-108): rank-average
    // of 6-1mo momentum percentile + 52-week-high proximity percentile, computed WITHIN the
    // liquid pool at this rebalance (point-in-time). Falls back to mom6-only when wk52 sparse.
    const both = liquid.filter(r => r.wk52 != null);
    const pool = both.length >= 10 ? both : liquid;
    const pctRank = (arr, key) => { const a = [...arr].sort((x, y) => x[key] - y[key]); a.forEach((r, j) => r['_r_' + key] = arr.length > 1 ? j / (arr.length - 1) : 0.5); };
    pctRank(pool, 'mom6');
    if (pool === both) pctRank(pool, 'wk52');
    pool.forEach(r => r.combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6);
    const picks = [...pool].sort((a, b) => b.combo - a.combo).slice(0, Math.max(5, Math.floor(pool.length * 0.2))).map(r => r.s);
    const rs = picks.map(s => fwd(s, date)).filter(r => r != null); if (!rs.length) continue;
    const port = mean(rs) - COST_RT;
    periods.push({ date, year: +date.slice(0, 4), n: picks.length, excess: port - bench, abs: port });
  }

  const ex = periods.map(p => p.excess), abs = periods.map(p => p.abs);
  const t = tstat(ex);
  const mid = periods.length ? periods[Math.floor(periods.length / 2)].date : null;
  const h1 = ex.filter((_, i) => periods[i].date <= mid), h2 = ex.filter((_, i) => periods[i].date > mid);
  // compounded abs equity → CAGR + maxDD
  let eq = 1, pk = 1, mdd = 0; for (const r of abs) { eq *= 1 + r; pk = Math.max(pk, eq); mdd = Math.min(mdd, eq / pk - 1); }
  const yrs = periods.length * H / 252;
  const cagr = yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : NaN;
  const grade = gradeStatus({ t, netMean: mean(ex), n: periods.length, h1t: tstat(h1), h2t: tstat(h2) });

  // Rolling-window evidence for the state machine (most recent periods).
  const tail = (k) => ex.slice(Math.max(0, ex.length - k));
  const rollMean = mean(tail(12));
  const rollT = tstat(tail(12));
  const roll18Mean = mean(tail(18));
  // current drawdown = equity now vs running peak of compounded abs equity
  let ceq = 1, cpk = 1;
  for (const r of abs) { ceq *= 1 + r; cpk = Math.max(cpk, ceq); }
  const curDD = cpk > 0 ? ceq / cpk - 1 : 0;
  const evidence = {
    n: periods.length, t: +(t || 0).toFixed(2),
    halfT1: +(tstat(h1) || 0).toFixed(2), halfT2: +(tstat(h2) || 0).toFixed(2),
    netMean: +(mean(ex) || 0).toFixed(5),
    rollMean: (rollMean == null || isNaN(rollMean)) ? null : +rollMean.toFixed(5),
    rollT: (rollT == null || isNaN(rollT)) ? null : +rollT.toFixed(2),
    roll18Mean: (roll18Mean == null || isNaN(roll18Mean)) ? null : +roll18Mean.toFixed(5),
    currentDD: +(curDD).toFixed(4),
  };

  // evaluate() persists any AUTO risk-down and returns the resulting state +
  // exposure_mult + recommendedAction — no need to re-read with getState().
  const stRes = evaluate('momentum-sharia', evidence);
  const txns = transitions('momentum-sharia', 6);

  const statusWhy = buildStatusWhy(stRes.state, grade.why, txns[0]?.reason, stRes.recommendedAction);

  // per-year excess for the developing-over-time view
  const byYear = {};
  for (const p of periods) (byYear[p.year] ||= []).push(p.excess);
  const yearly = Object.fromEntries(Object.entries(byYear).map(([y, a]) => [y, { n: a.length, excess_mean: +(mean(a) * 100).toFixed(2), t: +(tstat(a) || 0).toFixed(2) }]));

  const out = {
    ok: true, asOf: cal.at(-1), cost_rt: COST_RT,
    strategies: [{
      id: 'momentum-sharia', name: 'Momentum (Sharia)',
      spec: 'liquid-half ∩ ≥2y · top-quintile (6-1mo × 52wk-high rank combo) · monthly · equal-weight · Sharia applied live (not in grade)',
      status: stRes.state, statusWhy,
      exposure_mult: stRes.exposure_mult,
      recommendedAction: stRes.recommendedAction,
      transitions: txns.map(t => ({ from: t.from_state, to: t.to_state, actor: t.actor, reason: t.reason, at: t.at.slice(0, 10) })),
      periods: periods.length, span: periods.length ? `${periods[0].date} → ${periods.at(-1).date}` : null,
      excess_per_period: +(mean(ex) * 100).toFixed(2), t: +(t || 0).toFixed(2),
      win_rate: periods.length ? +(ex.filter(x => x > 0).length / periods.length * 100).toFixed(0) : 0,
      cagr_abs: +((cagr || 0) * 100).toFixed(1), maxDD: +((mdd) * 100).toFixed(1),
      cagr_abs_net_haircut: +(((cagr || 0) - SURVIVORSHIP_HAIRCUT) * 100).toFixed(1),
      survivorship_haircut_pct: +(SURVIVORSHIP_HAIRCUT * 100).toFixed(1),
      half1_t: +(tstat(h1) || 0).toFixed(2), half2_t: +(tstat(h2) || 0).toFixed(2),
      avg_names: periods.length ? Math.round(mean(periods.map(p => p.n))) : 0,
      yearly,
      evidence,
    }],
    note: `One observation per non-overlapping 20-session rebalance (cross-sectional-clustering-robust). Equal-weight basket benchmark, COVID carved out. Absolute CAGR is survivorship-optimistic (listed-only data) — accepted ~${(SURVIVORSHIP_HAIRCUT * 100).toFixed(1)}%/yr haircut shown as cagr_abs_net_haircut; excess-vs-basket is the haircut-robust metric.`,
  };
  _cache = { at: Date.now(), data: out };
  return out;
}
