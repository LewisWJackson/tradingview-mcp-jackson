/**
 * block_deal_retest.mjs — re-test "follow the big players" (block deals) the RIGHT way:
 *   • benchmark = equal-weight TASI basket (not the Aramco-dominated index)
 *   • cost = Derayah 0.11% RT (env COST_RT)
 *   • horizons 5 AND 20 sessions, split by deal size (big vs small)
 *   • report window + sample size + how many have matured forward returns
 *
 * Honest framing: block_deal_log currently spans only ~2 weeks, so this is
 * underpowered — it can show direction, not a verdict.
 *
 * Run: node --experimental-sqlite scripts/block_deal_retest.mjs
 */
import { db } from '../dashboard/db.js';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const COST_RT = +process.env.COST_RT || 0.0011;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const med = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const win = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

async function main() {
  const ysyms = TASI_STOCKS.map(s => toYahooSym(s.sym));
  await warm(ysyms, '10y');
  // per-sym date->close index
  const data = {};
  for (let i = 0; i < ysyms.length; i++) { const b = await getBars(ysyms[i], '10y'); if (!b.length) continue; data[TASI_STOCKS[i].sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c), idx: Object.fromEntries(b.map((x, j) => [iso(x.t), j])) }; }
  const universe = Object.keys(data);

  function fwd(sym, date, H) { const d = data[sym]; if (!d) return null; let i = d.dates.findIndex(x => x >= date); if (i < 0) return null; const j = i + H; if (j >= d.c.length) return null; return d.c[j] / d.c[i] - 1; }
  const ewCache = {};
  function ew(date, H) { const k = date + '|' + H; if (k in ewCache) return ewCache[k]; const rs = []; for (const s of universe) { const f = fwd(s, date, H); if (f != null) rs.push(f); } return ewCache[k] = rs.length ? mean(rs) : null; }

  const raw = db.prepare('SELECT sym, date, deals FROM block_deal_log').all();
  const ev = new Map();
  for (const r of raw) { let val = 0; try { val = JSON.parse(r.deals)?.value || 0; } catch {} const k = r.sym + '|' + r.date; if (!ev.has(k) || val > ev.get(k).value) ev.set(k, { sym: r.sym, date: r.date, value: val }); }
  const events = [...ev.values()];
  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const dates = events.map(e => e.date).sort();

  console.log(`\n=== BLOCK-DEAL RE-TEST — excess vs EQUAL-WEIGHT basket, Derayah cost ${pct(COST_RT)} ===`);
  console.log(`events: ${events.length} unique (sym,date) | window ${dates[0]} → ${dates.at(-1)} | median deal ${(medVal / 1e6).toFixed(1)}M SAR`);

  for (const H of [5, 20]) {
    const exAll = [], exBig = [], exSmall = []; let matured = 0;
    for (const e of events) {
      const f = fwd(e.sym, e.date, H), bench = ew(e.date, H);
      if (f == null || bench == null) continue;
      matured++;
      const ex = f - bench;                 // excess vs equal-weight basket
      exAll.push(ex); (e.value >= medVal ? exBig : exSmall).push(ex);
    }
    console.log(`\n── horizon ${H} sessions (matured: ${matured}/${events.length}) ──`);
    if (!exAll.length) { console.log('   none matured yet at this horizon (events too recent).'); continue; }
    console.log(`   ALL   n=${String(exAll.length).padStart(4)}  excess ${pct(mean(exAll)).padStart(7)}  median ${pct(med(exAll)).padStart(7)}  beat ${win(exAll)}  t=${tstat(exAll)}  NET ${pct(mean(exAll) - COST_RT)}`);
    console.log(`   BIG   n=${String(exBig.length).padStart(4)}  excess ${pct(mean(exBig)).padStart(7)}  beat ${win(exBig)}  t=${tstat(exBig)}`);
    console.log(`   SMALL n=${String(exSmall.length).padStart(4)}  excess ${pct(mean(exSmall)).padStart(7)}  beat ${win(exSmall)}  t=${tstat(exSmall)}`);
  }
  console.log(`\n   NOTE: ~2-week event window → UNDERPOWERED. Direction only, not a verdict. A real test needs months of block-deal history (re-harvest Argaam).`);
  process.exit(0);
}
main();
