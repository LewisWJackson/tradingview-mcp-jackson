/**
 * pead_screen.mjs — LIVE conditioned-PEAD satellite screen ("what should I be holding now").
 *
 * The EXPERIMENTAL 2nd-edge candidate from scripts/pead_conditioned_test.mjs (gate PASS but
 * marginal: per-period guillotine t 2.14, n=118, orthogonal to momentum r≈0, fails at 0.30%
 * cost, front-loaded). The satellite is EVENT-DRIVEN: you enter 2 sessions AFTER a qualifying
 * earnings reaction and hold ~20 sessions ([+2,+22]). So "current picks" = compliant names whose
 * qualifying earnings reaction was recent enough that the drift window is STILL OPEN.
 *
 * A name QUALIFIES (mirrors the validated backtest, point-in-time at the event date):
 *   - reaction [0,+1] abnormal vs ^TASI ≥ the historical Q5 reaction breakpoint
 *     (the Q4/Q5 boundary = 80th-pctile cut over ALL matured compliant reactions), AND
 *   - momentum-aligned: live combo rank (6-1mo + 52wk-high pct-avg) ≥ 0.5 computed TODAY, AND
 *   - volume-confirmed: reaction-day volume > trailing-60d median (point-in-time), AND
 *   - Sharia-compliant.
 *
 * Mirrors dashboard/momentum_screen.mjs's contract. Modifies no existing module.
 */
import { getBars, warm, iso } from '../scripts/bars_cache.mjs';
import { TASI_STOCKS, toYahooSym } from '../scripts/tasi_screener.mjs';
import { db } from './db.js';
import { sliceByDate } from './index_flow.mjs';
import { quantileBreakpoints } from './pead.mjs';
import { getShariaStatus } from './sharia.mjs';

const DRIFT_DAYS = 20;            // [+2,+22] = 20 sessions held after the reaction day
const ENTRY_OFFSET = 2;           // enter 2 sessions after the reaction day
const LIQUID_FRAC = 0.5;
const MIN_LISTING = 504;          // ≥2y listed (matches live momentum screen)
const CAND_CALENDAR_DAYS = 34;    // ~22 trading sessions back: drift window may still be open

const validDate = d => /^\d{4}-\d{2}-\d{2}$/.test(d) && +d.slice(5, 7) >= 1 && +d.slice(5, 7) <= 12 && +d.slice(8, 10) >= 1 && +d.slice(8, 10) <= 31;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// abnormal return aligned on separate name/bench index windows (from pead_conditioned_test.mjs)
function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0 || jN >= nC.length || jB >= benchC.length) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}

// ── Result cache. The screen warms the whole compliant universe (~10s); its output only
// changes day-to-day (new bars/earnings/combo ranks). Cache per calendar day with a 6h TTL;
// only successful results are cached so a cold-cache miss can retry. `force:true` bypasses.
let _cache = null;   // { at:ms, asOf, data }
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export async function getPeadScreen({ heldSyms = [], force = false } = {}) {
  const today = new Date();
  const asOf = today.toISOString().slice(0, 10);
  if (!force && _cache && _cache.asOf === asOf && Date.now() - _cache.at < CACHE_TTL_MS) {
    return _cache.data;
  }
  // matured cutoff: events strictly older than this have a fully-closed drift window → used only
  // to estimate the historical Q5 reaction breakpoint.
  const maturedCutoff = new Date(Date.now() - (DRIFT_DAYS + 15) * 864e5).toISOString().slice(0, 10);
  // candidate window: event within the last ~34 calendar days (~22 sessions) and ≥1 session ago.
  const candFloor = new Date(Date.now() - CAND_CALENDAR_DAYS * 864e5).toISOString().slice(0, 10);

  const raw = db.prepare("SELECT sym, event_date FROM catalyst_events WHERE type='earnings'").all();
  const events = raw.filter(r => validDate(r.event_date));
  if (!events.length) return { success: false, error: 'No valid earnings events in catalyst_events.' };

  const compliant = TASI_STOCKS.filter(s => getShariaStatus(s.sym).status === 'compliant');
  const compSyms = new Set(compliant.map(s => s.sym));

  // candidate events: recent + compliant; matured events: any older event (compliant) for the breakpoint.
  const candidates = events.filter(e => e.event_date >= candFloor && e.event_date < asOf && compSyms.has(e.sym));
  const maturedEvents = events.filter(e => e.event_date <= maturedCutoff && compSyms.has(e.sym));

  // Warm: candidates + matured-event names + full compliant universe (for live combo) + bench.
  const candSyms = candidates.map(e => e.sym);
  const matSyms = maturedEvents.map(e => e.sym);
  const allSyms = [...new Set([...candSyms, ...matSyms])];
  await warm(allSyms.map(toYahooSym).concat(compliant.map(s => toYahooSym(s.sym))).concat('^TASI.SR'), '10y');

  const ib = await getBars('^TASI.SR', '10y');
  if (!ib || ib.length < 60) return { success: false, error: 'Benchmark ^TASI.SR cache cold. Run: node scripts/bars_cache.mjs warm.' };
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  // Preload compliant-universe bars once for the live combo cross-section.
  const uniBars = {};
  for (const s of compliant) { const b = await getBars(toYahooSym(s.sym), '10y'); if (b && b.length >= 60) uniBars[s.sym] = b; }

  // ── Historical Q5 reaction breakpoint (80th-pctile = Q4/Q5 boundary) over ALL matured
  // compliant reactions. This is how "top reaction quintile" applies to live events.
  const matReactions = [];
  for (const ev of maturedEvents) {
    const b = uniBars[ev.sym] || await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) continue;
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) continue;
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    if (reaction != null) matReactions.push(reaction);
  }
  if (matReactions.length < 20) return { success: false, error: `Too few matured reactions (${matReactions.length}) to set a Q5 breakpoint — cache may be cold or thin.` };
  const q5Breakpoint = quantileBreakpoints(matReactions)[3];   // 80th-pctile = Q4/Q5 cut

  // ── Live combo momentum rank as of TODAY (correct for a live entry decision).
  // Mirrors momentum_screen: liquid half of compliant universe, pct-rank mom6 + wk52, average.
  function comboRanksToday() {
    const rows = [];
    for (const s of compliant) {
      const b = uniBars[s.sym]; if (!b) continue;
      const c = b.map(x => x.c), v = b.map(x => x.v || 0);
      const idx = c.length - 1;                       // last available bar = today
      if (idx < 126) continue;
      if (idx + 1 < MIN_LISTING) continue;            // ≥2y listed
      const mom6 = c[idx - 21] / c[idx - 126] - 1;    // 6-1mo momentum
      if (!isFinite(mom6)) continue;
      const hi52 = Math.max(...c.slice(Math.max(0, idx - 251), idx + 1));
      const wk52 = hi52 > 0 ? c[idx] / hi52 : null;
      let liq = 0, n = 0; for (let k = Math.max(0, idx - 59); k <= idx; k++) { liq += c[k] * (v[k] || 0); n++; }
      rows.push({ sym: s.sym, mom6, wk52, liq: liq / n });
    }
    const m = new Map();
    if (rows.length) {
      const liquid = [...rows].sort((a, b) => b.liq - a.liq).slice(0, Math.ceil(rows.length * LIQUID_FRAC));
      const both = liquid.filter(r => r.wk52 != null);
      const pool = both.length >= 10 ? both : liquid;
      const pctRank = (arr, key) => { const s = [...arr].sort((a, b) => a[key] - b[key]); s.forEach((r, i) => r['_r_' + key] = arr.length > 1 ? i / (arr.length - 1) : 0.5); };
      pctRank(pool, 'mom6');
      if (pool === both) pctRank(pool, 'wk52');
      pool.forEach(r => { const combo = pool === both ? (r._r_mom6 + r._r_wk52) / 2 : r._r_mom6; m.set(r.sym, combo); });
    }
    return m;
  }
  const liveRanks = comboRanksToday();

  // ── Evaluate each candidate event against the qualification conditions.
  const holdings = [];
  for (const ev of candidates) {
    const b = uniBars[ev.sym] || await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) continue;
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c), nV = b.map(x => x.v || 0);
    const aB = sliceByDate(benchDates, ev.event_date), aN = sliceByDate(nDates, ev.event_date);
    if (aB < 0 || aN < 0) continue;

    // reaction [0,+1] abnormal vs ^TASI (point-in-time: uses only bars at/after the event).
    const reaction = abnAligned(nC, benchC, aN, aN + 1, aB, aB + 1);
    if (reaction == null) continue;

    // volume-confirmed: reaction-day vol > trailing-60d median PRIOR to the event (point-in-time).
    const trail = []; for (let k = aN - 60; k < aN; k++) if (k >= 0 && nV[k] > 0) trail.push(nV[k]);
    const trailMed = trail.length >= 20 ? median(trail) : NaN;
    const volConfirmed = isFinite(trailMed) && trailMed > 0 ? (nV[aN] || 0) > trailMed : false;

    // momentum-aligned: live combo rank ≥ 0.5 today.
    const combo = liveRanks.get(ev.sym);
    const momAligned = combo != null && combo >= 0.5;

    const q5OK = reaction >= q5Breakpoint;
    if (!(q5OK && momAligned && volConfirmed)) continue;

    // window bookkeeping. entryIdx = reaction day + 2 sessions; hold DRIFT_DAYS sessions.
    const entryIdx = aN + ENTRY_OFFSET;
    if (entryIdx >= nDates.length) continue;          // not enough bars to have entered yet
    const entryDate = nDates[entryIdx];
    const lastIdx = nDates.length - 1;
    const sessionsHeld = Math.max(0, lastIdx - entryIdx);
    const sessionsRemaining = Math.max(0, DRIFT_DAYS - sessionsHeld);
    if (sessionsRemaining <= 0) continue;             // drift window already closed → not an open pick
    const exitIdx = entryIdx + DRIFT_DAYS;
    const exitDate = exitIdx < nDates.length ? nDates[exitIdx] : null;   // null = still in the future

    const meta = TASI_STOCKS.find(s => s.sym === ev.sym);
    holdings.push({
      sym: ev.sym, code: ev.sym.replace('TADAWUL:', ''), name: meta?.name || ev.sym,
      price: +nC[lastIdx].toFixed(2),
      reaction: +(reaction * 100).toFixed(2),
      combo: +combo.toFixed(2),
      eventDate: ev.event_date,
      entryDate, sessionsHeld, sessionsRemaining,
      exitDate,
      sharia: getShariaStatus(ev.sym).basis,
    });
  }

  // newest entry first; tie-break on reaction desc.
  holdings.sort((a, b) => a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : b.reaction - a.reaction);

  const result = {
    success: true, asOf,
    params: {
      rule: 'Q5 earnings-reaction ∩ momentum-aligned (combo≥0.5) ∩ volume-confirmed',
      hold: '[+2,+22] sessions (~1 month)',
      benchmark: 'abnormal vs ^TASI',
      cost: '0.11% RT (Derayah)',
    },
    status: {
      tier: 'EXPERIMENTAL — borderline 2nd edge',
      detail: 'Gate PASS but marginal: guillotine t 2.14, fails at 0.30% cost, front-loaded. Orthogonal to momentum (r≈0). Size ~10% of risk budget. Retire if a refresh drops t<2.',
    },
    sizing: {
      note: 'Satellite sleeve ≈10% of risk budget, equal-weight across the open-window names.',
    },
    universe: {
      compliant: compliant.length,
      candidateEvents: candidates.length,
      maturedReactions: matReactions.length,
      q5BreakpointPct: +(q5Breakpoint * 100).toFixed(2),
      openWindow: holdings.length,
    },
    holdings,
    note: holdings.length ? null : 'No open PEAD candidates right now — event-driven, expect long quiet stretches between earnings seasons.',
  };
  _cache = { at: Date.now(), asOf, data: result };
  return result;
}
