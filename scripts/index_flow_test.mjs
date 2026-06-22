/**
 * index_flow_test.mjs — event study: do MSCI Saudi index ADDS earn a positive abnormal
 * return between announcement and effective date (front-running the forced inclusion flow),
 * and reverse after? Deletes mirror (negative; untradeable long-only, reported for shape).
 *
 * Abnormal return = name return − ^TASI.SR return over the same window (fair-benchmark rule).
 * Windows: pre (announce-5→announce), trade (announce+1→effective-1), reversal (effective→+20).
 * Net of 0.11% RT cost + a slippage haircut. Newey-West t. Time-split OOS. Trim-one robustness.
 * Run: node --experimental-sqlite scripts/index_flow_test.mjs
 * Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym } from './tasi_screener.mjs';
import { getIndexEvents } from '../dashboard/index_events.mjs';
import { sliceByDate } from '../dashboard/index_flow.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const SLIP = +process.env.SLIP || 0.0015;            // per-side slippage haircut (disclosed)
const MIN_N = +process.env.MIN_N || 20;              // underpowered threshold
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
// Newey-West t with Bartlett weights, lag L (handles overlapping event windows).
function nwT(x, L = 5) {
  const n = x.length; if (n < 3) return NaN;
  const m = mean(x), e = x.map(v => v - m);
  let g0 = e.reduce((s, v) => s + v * v, 0) / n, v = g0;
  for (let l = 1; l <= L; l++) {
    let g = 0; for (let t = l; t < n; t++) g += e[t] * e[t - l];
    g /= n; v += 2 * (1 - l / (L + 1)) * g;
  }
  const se = Math.sqrt(v / n);
  return se > 0 ? m / se : NaN;
}
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';

// Abnormal return over name window [iN,jN] and matching bench window [iB,jB]. null if invalid.
function abnAligned(nC, benchC, iN, jN, iB, jB) {
  if (iN > jN || iB > jB || iN < 0 || iB < 0) return null;
  const rn = (nC[iN] > 0 && nC[jN] > 0) ? nC[jN] / nC[iN] - 1 : null;
  const rb = (benchC[iB] > 0 && benchC[jB] > 0) ? benchC[jB] / benchC[iB] - 1 : null;
  if (rn == null || rb == null) return null;
  return rn - rb;
}

(async () => {
  const events = getIndexEvents({ index_name: 'MSCI Saudi' });
  if (!events.length) { console.log('No events in index_events. Run import_index_events.mjs first.'); process.exit(0); }

  const syms = [...new Set(events.map(e => e.sym))];
  await warm(syms.map(toYahooSym).concat('^TASI.SR'), '10y');
  const ib = await getBars('^TASI.SR', '10y');
  const benchDates = ib.map(x => iso(x.t)), benchC = ib.map(x => x.c);

  const rows = { add: { pre: [], trade: [], reversal: [] }, delete: { pre: [], trade: [], reversal: [] } };
  let used = 0, skipped = 0;
  for (const ev of events) {
    const b = await getBars(toYahooSym(ev.sym), '10y');
    if (!b || b.length < 30) { skipped++; continue; }
    const nDates = b.map(x => iso(x.t)), nC = b.map(x => x.c);
    const aIdxB = sliceByDate(benchDates, ev.announce_date);
    const eIdxB = sliceByDate(benchDates, ev.effective_date);
    if (aIdxB < 0 || eIdxB < 0 || eIdxB <= aIdxB) { skipped++; continue; }
    const aIdxN = sliceByDate(nDates, ev.announce_date);
    const eIdxN = sliceByDate(nDates, ev.effective_date);
    if (aIdxN < 0 || eIdxN < 0 || eIdxN <= aIdxN) { skipped++; continue; }

    const preB = Math.max(0, aIdxB - 5), preN = Math.max(0, aIdxN - 5);
    const revEndB = Math.min(benchC.length - 1, eIdxB + 20), revEndN = Math.min(nC.length - 1, eIdxN + 20);

    const arPre   = abnAligned(nC, benchC, preN, aIdxN, preB, aIdxB);
    const arTrade = abnAligned(nC, benchC, aIdxN + 1, eIdxN - 1, aIdxB + 1, eIdxB - 1);
    const arRev   = abnAligned(nC, benchC, eIdxN, revEndN, eIdxB, revEndB);
    if (arTrade == null) { skipped++; continue; }
    used++;
    const net = arTrade - COST_RT - 2 * SLIP; // round-trip cost + slippage both sides
    rows[ev.action].pre.push(arPre);
    rows[ev.action].trade.push(net);
    rows[ev.action].reversal.push(arRev);
  }

  console.log(`\nMSCI Saudi index-flow event study — events ${events.length}, used ${used}, skipped ${skipped}`);
  console.log(`cost ${(COST_RT * 100).toFixed(2)}% RT + slippage ${(SLIP * 100).toFixed(2)}%/side\n`);
  for (const action of ['add', 'delete']) {
    const tr = rows[action].trade.filter(x => x != null);
    if (!tr.length) { console.log(`${action.toUpperCase()}: no usable events`); continue; }
    const pre = rows[action].pre.filter(x => x != null), rev = rows[action].reversal.filter(x => x != null);
    console.log(`${action.toUpperCase()} (n=${tr.length})`);
    console.log(`  pre      mean ${pct(mean(pre))}`);
    console.log(`  trade    mean ${pct(mean(tr))} net  NW-t ${(nwT(tr) || 0).toFixed(2)}  win ${(tr.filter(x => x > 0).length / tr.length * 100).toFixed(0)}%`);
    console.log(`  reversal mean ${pct(mean(rev))}`);
    if (tr.length > 3) {
      const trims = tr.map((_, i) => mean(tr.filter((__, j) => j !== i)));
      console.log(`  trim-one trade mean range ${pct(Math.min(...trims))} … ${pct(Math.max(...trims))}`);
    }
  }

  if (rows.add.trade.length >= 4) {
    const t = rows.add.trade; const mid = Math.floor(t.length / 2);
    console.log(`\nADD OOS split — early(${mid}) mean ${pct(mean(t.slice(0, mid)))}  late(${t.length - mid}) mean ${pct(mean(t.slice(mid)))}`);
  }

  const t = rows.add.trade.filter(x => x != null);
  console.log('\nVERDICT (adds):');
  if (t.length < MIN_N) {
    console.log(`  UNDERPOWERED — only ${t.length} usable add events (<${MIN_N}); verdict NOT reliable. Harvest more / add reweights.`);
  } else {
    const m = mean(t), tstat = nwT(t);
    const pass = m > 0 && tstat > 2;
    console.log(`  ${pass ? 'SIGNAL' : 'NO SIGNAL'} — trade mean ${pct(m)} net, NW-t ${tstat.toFixed(2)} (need mean>0 AND t>2; then check OOS + trim-one above).`);
  }
})();
