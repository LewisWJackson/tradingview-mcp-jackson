/**
 * contract_flow_guillotine_test.mjs — re-test the govt-contract edge through the SAME bar that
 * momentum passed and the 9-pt score failed (signal_showdown.mjs methodology).
 *
 * Why: the original contract_flow_test.mjs measured drift vs ^TASI (the condemned cap-weighted
 * benchmark) and put NW-t on the POOLED list of 375 overlapping, calendar-clustered events —
 * the exact cross-sectional-clustering inflation that made the 9-pt score's pooled t=3.89 look
 * real when its honest per-period t was 0.74. This re-test fixes both:
 *   • Benchmark = equal-weight all-universe basket (the fair benchmark), NOT ^TASI.
 *   • ONE observation per non-overlapping 20-session period: the pick = names with a contract
 *     award in the prior 20 sessions, equal-weighted; excess vs the basket. t on the per-period
 *     series already absorbs cross-name clustering.
 *   • Reports govt, private, and the govt−private spread (benchmark-robust via the control).
 *
 * PASS bar (same as momentum): per-period EXCESS t > 2 AND positive, AND govt beats private.
 * Run: node --experimental-sqlite scripts/contract_flow_guillotine_test.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { db } from '../dashboard/db.js';
import { classifyCounterparty, isContractHeadline } from '../dashboard/contract_flow.mjs';
import { mean, tstat, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011, SLIP = +process.env.SLIP || 0.0015;
const START = '2021-07-01';   // contract history begins 2021-06; first full period after
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';

async function main() {
  // ── build price panel (same as showdown) ──
  const syms = TASI_STOCKS.map(s => s.sym);
  await warm([...syms.map(toYahooSym), '^TASI.SR'], '10y');
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[s.sym] = { closes: b.map(x => x.c), volumes: b.map(x => x.v || 0), dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const usable = Object.keys(data);

  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const ewC = {};
  const ew = (date) => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };
  // trailing-60d avg traded value at a date (liquidity)
  const adv = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i < 60) return null; let s = 0; for (let k = i - 59; k <= i; k++) s += d.closes[k] * d.volumes[k]; return s / 60; };

  // ── contract events: keep real awards, group by sym with counterparty ──
  const raw = db.prepare("SELECT sym, event_date, headline FROM catalyst_events WHERE type='contract'").all();
  const evG = [], evP = [];   // {sym, date}
  for (const r of raw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.event_date) || !isContractHeadline(r.headline) || !data[r.sym]) continue;
    (classifyCounterparty(r.headline) === 'govt' ? evG : evP).push({ sym: r.sym, date: r.event_date });
  }

  // ── per-period portfolios: pick = names with an award in the prior H sessions ──
  const cost = COST_RT + 2 * SLIP;
  const Xg = [], Xp = [], XgL = [], XpL = [], spread = [];   // per-period EXCESS series
  let nPer = 0, span0 = '9999', span1 = '0', sizeG = [], sizeGL = [];

  for (let ci = MIN_HISTORY; ci + H < cal.length; ci += H) {
    const date = cal[ci]; if (date < START) continue;
    const bench = ew(date); if (bench == null) continue;
    const lo = cal[Math.max(0, ci - H)];
    const inWin = ev => ev.date > lo && ev.date <= date && data[ev.sym].dateIdx[date] != null;
    const gSyms = [...new Set(evG.filter(inWin).map(e => e.sym))];
    const pSyms = [...new Set(evP.filter(inWin).map(e => e.sym))];
    if (!gSyms.length && !pSyms.length) continue;

    // liquidity threshold = median ADV across the usable universe this period
    const advs = usable.map(s => adv(s, date)).filter(v => v != null).sort((a, b) => a - b);
    const medADV = advs.length ? advs[Math.floor(advs.length / 2)] : 0;
    const isLiq = s => { const a = adv(s, date); return a != null && a >= medADV; };

    const port = picks => { const rs = picks.map(s => fwd(s, date)).filter(r => r != null); return rs.length ? mean(rs) - cost : null; };
    const push = (arr, picks) => { const p = port(picks); if (p != null) arr.push(p - bench); return p != null; };

    const gAll = gSyms, pAll = pSyms, gLiq = gSyms.filter(isLiq), pLiq = pSyms.filter(isLiq);
    if (gAll.length) { push(Xg, gAll); sizeG.push(gAll.length); }
    if (pAll.length) push(Xp, pAll);
    let gx = null;
    if (gLiq.length) { const before = XgL.length; if (push(XgL, gLiq)) { sizeGL.push(gLiq.length); gx = XgL[XgL.length - 1]; } }
    let px = null;
    if (pLiq.length) { if (push(XpL, pLiq)) px = XpL[XpL.length - 1]; }
    if (gx != null && px != null) spread.push(gx - px);   // paired, same period → benchmark+market cancel

    nPer++; if (date < span0) span0 = date; if (date > span1) span1 = date;
  }

  const row = (label, x, sizes) => {
    const an = sizes && sizes.length ? mean(sizes).toFixed(1) : '—';
    console.log(`  ${label.padEnd(22)} periods=${String(x.length).padStart(3)}  avgN ${String(an).padStart(4)}  excess/pd ${pct(mean(x)).padStart(8)}  t ${(tstat(x) || 0).toFixed(2).padStart(5)}`);
  };

  console.log(`\n=== CONTRACT-FLOW under the GUILLOTINE (one obs / ${H}-session period, equal-weight basket) ===`);
  console.log(`Span ${span0}→${span1}, ${nPer} periods (~${(nPer * H / 252).toFixed(1)}y). Benchmark = equal-weight all-universe. Cost ${pct(cost)} (RT+slip).`);
  console.log(`This per-period t absorbs cross-name clustering — the bar momentum passed (t=3.60) and the 9-pt score failed (t=0.74).\n`);
  row('govt — all', Xg, sizeG);
  row('govt — liquid half', XgL, sizeGL);
  row('private — all', Xp);
  row('private — liquid half', XpL);
  console.log(`\n  govt−private spread (liquid, paired): mean ${pct(mean(spread))}  t ${(tstat(spread) || 0).toFixed(2)}  (n=${spread.length} periods)`);

  // Authoritative verdict via the SHARED gate (the one bar every signal must clear).
  const verdict = portfolioGuillotine(XgL, { controlExcess: XpL });
  console.log(`\nVERDICT (govt ∩ liquid, the validated cut) — via shared portfolioGuillotine():`);
  console.log(`  ${verdict.reason}`);
  console.log(`  beats private control: ${verdict.beatsControl}; govt−private paired spread t ${(tstat(spread) || 0).toFixed(2)}`);
  if (!verdict.pass) console.log(`  → the pooled-NW SIGNAL did NOT hold under the cross-clustering-robust test. NOT an edge.`);
  process.exit(0);
}
main();
