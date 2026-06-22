/**
 * momentum_confirm.mjs — confirmation tests for the AVENUE 4 lead (cross-sectional
 * 6-1 momentum top-quintile). Two checks:
 *
 *  #1 LIQUIDITY FILTER — restrict the universe each month to the liquid half (avg daily
 *     traded value, last 60d). Tests (a) tradeability — does the edge survive on names
 *     you can actually fill? and (b) proxies DOWN the survivorship bias — liquid mid/large
 *     caps delist far less than micro-caps, so if the edge holds on liquid names it's less
 *     likely a delisting-blowup artifact.
 *
 *  #2 SEASONAL OVERLAY (avenue 2) ON momentum — hold the momentum quintile only outside
 *     the 2 weakest calendar months (walk-forward, learned from prior years' basket).
 *     Does stacking the drawdown-overlay on the return-engine improve CAGR/DD/Sharpe?
 *
 * Benchmark = equal-weight basket. Both-positive discipline: ABS return AND excess, net
 * cost, NW-t. Survivorship still present (Yahoo currently-listed) — #1 only mitigates it.
 *
 * Run: node scripts/momentum_confirm.mjs
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const cum = a => a.reduce((v, r) => v * (1 + r), 1) - 1;
const cagrM = a => Math.pow(1 + cum(a), 12 / a.length) - 1;
const sharpe = a => +(mean(a) / sd(a) * Math.sqrt(12)).toFixed(2);
function maxDD(rets) { let v = 1, p = 1, dd = 0; for (const r of rets) { v *= 1 + r; if (v > p) p = v; const d = v / p - 1; if (d < dd) dd = d; } return dd; }
function nwT(a, lag = 3) { const N = a.length; if (N < lag + 2) return NaN; const m = mean(a), e = a.map(x => x - m); let v = e.reduce((s, x) => s + x * x, 0) / N; for (let k = 1; k <= lag; k++) { let g = 0; for (let i = k; i < N; i++) g += e[i] * e[i - k]; g /= N; v += 2 * (1 - k / (lag + 1)) * g; } return +(m / Math.sqrt(v / N)).toFixed(2); }
const mom6 = (c, i) => (i >= 126 ? c[i - 21] / c[i - 126] - 1 : null);

async function main() {
  const syms = TASI_STOCKS.map(s => s.sym), ysyms = syms.map(toYahooSym);
  console.error(`loading ${ysyms.length} from cache ...`); await warm(ysyms, '10y');
  const data = {};
  for (let k = 0; k < syms.length; k++) { const b = await getBars(ysyms[k], '10y'); if (b.length < 300) continue; data[syms[k]] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), v: b.map(x => x.v), idx: null }; data[syms[k]].idx = Object.fromEntries(data[syms[k]].dates.map((d, i) => [d, i])); }
  const names = Object.keys(data);
  const allDates = [...new Set(names.flatMap(s => data[s].dates))].sort();
  const rebal = [];
  for (let i = 0; i < allDates.length - 1; i++) if (allDates[i].slice(0, 7) !== allDates[i + 1].slice(0, 7)) rebal.push(allDates[i]);
  rebal.push(allDates.at(-1));

  // build per-interval rows
  const intervals = [];   // {month, year, basket, names:[{s,fwd,mom,liq}]}
  for (let ri = 0; ri < rebal.length - 1; ri++) {
    const d0 = rebal[ri], d1 = rebal[ri + 1];
    const rows = [];
    for (const s of names) { const a = data[s]; const i = a.idx[d0], j = a.idx[d1]; if (i == null || j == null || i < 126) continue; const m = mom6(a.c, i); if (m == null || !isFinite(m)) continue; let liq = 0, n = 0; for (let k = Math.max(0, i - 59); k <= i; k++) { liq += a.c[k] * (a.v[k] || 0); n++; } liq /= n; rows.push({ s, fwd: a.c[j] / a.c[i] - 1, mom: m, liq }); }
    if (rows.length < 30) continue;
    intervals.push({ month: +d1.slice(5, 7), year: +d1.slice(0, 4), basket: mean(rows.map(r => r.fwd)), names: rows });
  }

  // quintile return given a row-subset selector + previous holdings (for turnover)
  function quintileSeries(filterFn) {
    const abs = [], turn = []; let prev = new Set();
    for (const iv of intervals) {
      const pool = iv.names.filter(filterFn);
      if (pool.length < 15) { abs.push(iv.basket); turn.push(0); continue; }   // fallback: basket
      const sorted = [...pool].sort((a, b) => b.mom - a.mom);
      const top = sorted.slice(0, Math.floor(sorted.length / 5));
      const set = new Set(top.map(r => r.s)); let ch = 0; for (const s of set) if (!prev.has(s)) ch++;
      turn.push(set.size ? ch / set.size : 0); prev = set; abs.push(mean(top.map(r => r.fwd)));
    }
    return { abs, turn };
  }
  const basketM = intervals.map(iv => iv.basket);
  function netOf(abs, turn, RT) { const cm = mean(turn) * RT; return abs.map(x => x - cm); }
  function report(label, abs, turn) {
    for (const RT of [0.0061, 0.012]) { const net = netOf(abs, turn, RT); const ex = net.map((x, i) => x - basketM[i]);
      console.log(`  ${label.padEnd(26)} cost ${RT === 0.0061 ? '0.61%' : '1.2% '}: ABS CAGR ${pct(cagrM(net)).padStart(8)}  maxDD ${pct(maxDD(net)).padStart(8)}  excess ${pct(mean(ex)*12).padStart(8)}/yr  NWt ${nwT(ex)}`); }
  }

  console.log(`\n=== AVENUE 4 CONFIRMATION — ${intervals.length} months, ${names.length} names, ${rebal[0]}→${rebal.at(-1)} ===`);
  console.log(`basket: CAGR ${pct(cagrM(basketM))}  maxDD ${pct(maxDD(basketM))}\n`);

  // #1 LIQUIDITY FILTER
  console.log(`── #1 LIQUIDITY FILTER (does edge survive on tradeable names?) ──`);
  const all = quintileSeries(() => true);
  report('all names (baseline)', all.abs, all.turn);
  // liquid half: per-month median traded value
  function quintileLiquid(keepFrac) {
    const abs = [], turn = []; let prev = new Set();
    for (let q = 0; q < intervals.length; q++) { const iv = intervals[q]; const thr = [...iv.names].sort((a, b) => b.liq - a.liq); const keep = new Set(thr.slice(0, Math.ceil(thr.length * keepFrac)).map(r => r.s)); const pool = iv.names.filter(r => keep.has(r.s));
      if (pool.length < 15) { abs.push(iv.basket); turn.push(0); continue; }
      const sorted = [...pool].sort((a, b) => b.mom - a.mom); const top = sorted.slice(0, Math.floor(sorted.length / 5));
      const set = new Set(top.map(r => r.s)); let ch = 0; for (const s of set) if (!prev.has(s)) ch++; turn.push(set.size ? ch / set.size : 0); prev = set; abs.push(mean(top.map(r => r.fwd))); }
    return { abs, turn };
  }
  const lh = quintileLiquid(0.5), lt = quintileLiquid(0.33);
  report('liquid HALF (top 50% val)', lh.abs, lh.turn);
  report('liquid THIRD (top 33% val)', lt.abs, lt.turn);

  // #2 SEASONAL OVERLAY on momentum (walk-forward weak-2-months by basket)
  console.log(`\n── #2 MOMENTUM × SEASONAL OVERLAY (cash in 2 weakest walk-forward months) ──`);
  const years = [...new Set(intervals.map(iv => iv.year))].sort();
  function weakMonthsBefore(Y) { const byM = {}; intervals.forEach(iv => { if (iv.year < Y) (byM[iv.month] ||= []).push(iv.basket); }); const ms = Object.entries(byM).map(([m, a]) => [+m, mean(a)]).sort((a, b) => a[1] - b[1]); return new Set(ms.slice(0, 2).map(e => e[0])); }
  function applyOverlay(absSeries) {   // cash (0) in weak months of the test year (walk-forward); year0 = no overlay
    const out = []; let trans = 0, inMkt = true;
    for (let q = 0; q < intervals.length; q++) { const iv = intervals[q]; const weak = iv.year > years[0] ? weakMonthsBefore(iv.year) : new Set(); const want = !weak.has(iv.month); if (want !== inMkt) { trans++; inMkt = want; } out.push(want ? absSeries[q] : 0); }
    return { out, trans };
  }
  function comboReport(label, absRaw, turn) {
    const net = netOf(absRaw, turn, 0.012);                 // use the realistic-cost momentum leg
    const ov = applyOverlay(net);
    const ovCostDrag = ov.trans * 0.0061 / 2;               // each in/out leg
    const ovEq = (1 + cum(ov.out)) * (1 - ovCostDrag);
    const ovCAGR = Math.pow(ovEq, 12 / ov.out.length) - 1;
    console.log(`  ${label.padEnd(30)} CAGR ${pct(ovCAGR).padStart(8)}  maxDD ${pct(maxDD(ov.out)).padStart(8)}  Sharpe ${sharpe(ov.out)}  (overlay ${ov.trans} trans)`);
  }
  // baselines @1.2% cost
  console.log(`  basket buy&hold                CAGR ${pct(cagrM(basketM)).padStart(8)}  maxDD ${pct(maxDD(basketM)).padStart(8)}  Sharpe ${sharpe(basketM)}`);
  const bOv = applyOverlay(basketM); const bOvCAGR = Math.pow((1 + cum(bOv.out)) * (1 - bOv.trans * 0.0061 / 2), 12 / bOv.out.length) - 1;
  console.log(`  basket + seasonal overlay      CAGR ${pct(bOvCAGR).padStart(8)}  maxDD ${pct(maxDD(bOv.out)).padStart(8)}  Sharpe ${sharpe(bOv.out)}  (overlay ${bOv.trans} trans)`);
  const mNet = netOf(lh.abs, lh.turn, 0.012);
  console.log(`  momentum(liquid½) always-in    CAGR ${pct(cagrM(mNet)).padStart(8)}  maxDD ${pct(maxDD(mNet)).padStart(8)}  Sharpe ${sharpe(mNet)}`);
  comboReport('momentum(liquid½) + overlay', lh.abs, lh.turn);

  console.log(`\nNOTE: survivorship still present (Yahoo=listed-only). #1 only mitigates via the liquid-name proxy. Real confirmation = point-in-time universe w/ delisted names.`);
  process.exit(0);
}
main();
