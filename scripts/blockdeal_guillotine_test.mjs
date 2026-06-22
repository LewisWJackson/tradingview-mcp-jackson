/**
 * blockdeal_guillotine_test.mjs — audit the block-deal "edge" through the SAME bar that killed
 * contract-flow and validated momentum (dashboard/guillotine.mjs).
 *
 * Block-deals was logged as a "2nd edge" on an OVERLAP-CORRECTED t (oc-t ~1.9) and FAILED the
 * monthly-portfolio showdown (t 1.66) — but the defense was "it's a within-days EVENT trade, not
 * a monthly hold", and that event framing was never put through the cross-clustering-robust gate.
 * This does that: enter at the deal (BIG, premium/at-market — the validated subset), hold 20
 * sessions, EXCESS vs the equal-weight basket; then group deals into NON-OVERLAPPING 20-session
 * buckets (one obs per bucket = equal-weight mean of that bucket's event excesses) so same-period
 * clustering can't inflate the t. portfolioGuillotine on the bucket series is the verdict.
 *
 * Run: node --experimental-sqlite scripts/blockdeal_guillotine_test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { mean, tstat, portfolioGuillotine } from '../dashboard/guillotine.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const H = 20, MIN_HISTORY = 210, COST_RT = +process.env.COST_RT || 0.0011, SLIP = +process.env.SLIP || 0.0015;
const pct = x => isNaN(x) || x == null ? '—' : (x * 100).toFixed(2) + '%';

async function main() {
  await warm([...TASI_STOCKS.map(s => toYahooSym(s.sym)), '^TASI.SR'], '10y');
  const data = {};
  for (const s of TASI_STOCKS) {
    const b = await getBars(toYahooSym(s.sym), '10y'); if (!b || b.length < MIN_HISTORY + H) continue;
    const dates = b.map(x => iso(x.t));
    data[s.sym] = { dates, closes: b.map(x => x.c), dateIdx: Object.fromEntries(dates.map((dt, i) => [dt, i])) };
  }
  const ib = await getBars('^TASI.SR', '10y');
  const cal = ib.map(x => iso(x.t));
  const calIdx = Object.fromEntries(cal.map((d, i) => [d, i]));
  const usable = Object.keys(data);

  const fwd = (sym, date) => { const d = data[sym]; const i = d.dateIdx[date]; if (i == null || i + H >= d.closes.length) return null; return d.closes[i + H] / d.closes[i] - 1; };
  const ewC = {};
  const ew = (date) => { if (date in ewC) return ewC[date]; const rs = []; for (const s of usable) { const r = fwd(s, date); if (r != null) rs.push(r); } return ewC[date] = rs.length ? mean(rs) : null; };

  const { events } = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'block_deals_signed.json'), 'utf8'));
  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const cost = COST_RT + 2 * SLIP;

  // build event-level excess for the validated subset (BIG, premium/at-market) and for all-BIG
  function eventExcesses(filterFn) {
    const out = [];   // {bucket, excess, abs}
    for (const e of events) {
      const d = data[e.sym]; if (!d) continue;
      const entryDate = d.dates.find(x => x >= e.date); if (!entryDate) continue;
      const ci = calIdx[entryDate]; if (ci == null || ci < MIN_HISTORY) continue;
      const prem = e.price > 0 ? e.price / d.closes[d.dateIdx[entryDate]] - 1 : null;
      if (!filterFn(e, prem)) continue;
      const r = fwd(e.sym, entryDate), bench = ew(entryDate);
      if (r == null || bench == null) continue;
      out.push({ bucket: Math.floor(ci / H), abs: r - cost, excess: (r - cost) - bench });
    }
    return out;
  }
  // bucket → one obs (equal-weight mean of that bucket's event excesses) → non-overlapping series
  function bucketSeries(evs) {
    const byB = new Map();
    for (const e of evs) { if (!byB.has(e.bucket)) byB.set(e.bucket, { ex: [], ab: [] }); byB.get(e.bucket).ex.push(e.excess); byB.get(e.bucket).ab.push(e.abs); }
    const buckets = [...byB.keys()].sort((a, b) => a - b);
    return { excess: buckets.map(b => mean(byB.get(b).ex)), abs: buckets.map(b => mean(byB.get(b).ab)), nEvents: evs.length, nBuckets: buckets.length };
  }

  const bigPrem = eventExcesses((e, prem) => e.value >= medVal && prem != null && prem > -0.001 && Math.abs(prem) < 0.10);
  const bigAll = eventExcesses((e) => e.value >= medVal);
  const sP = bucketSeries(bigPrem), sA = bucketSeries(bigAll);

  console.log(`\n=== BLOCK-DEALS under the event-level GUILLOTINE (one obs / non-overlapping ${H}-session bucket) ===`);
  console.log(`Enter at deal, hold ${H}, EXCESS vs equal-weight basket. Cost ${pct(cost)} (RT+slip). ${events.length} deals, BIG≥${(medVal / 1e6).toFixed(1)}M SAR.\n`);

  const row = (label, s) => console.log(`  ${label.padEnd(26)} events=${String(s.nEvents).padStart(3)}  buckets=${String(s.nBuckets).padStart(3)}  excess/bucket ${pct(mean(s.excess)).padStart(8)}  t ${(tstat(s.excess) || 0).toFixed(2).padStart(5)}`);
  row('BIG premium/at-market', sP);
  row('BIG all (incl. discount)', sA);

  const v = portfolioGuillotine(sP.excess, { abs: sP.abs });
  console.log(`\nVERDICT (BIG premium/at-market — the validated subset) — via shared portfolioGuillotine():`);
  console.log(`  ${v.reason}`);
  if (!v.pass) console.log(`  → block-deals does NOT clear the event-level gate either. Same status as contract-flow: not a confirmed edge.`);
  process.exit(0);
}
main();
