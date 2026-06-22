/**
 * blockdeal_atr_exit_test.mjs — does an ATR bracket (stop + target, exit whichever hits
 * first) beat the fixed 20-session hold on the SAME block-deal entries?
 *
 * Entries = the validated signal: BIG deals (value ≥ median) at PREMIUM or AT-MARKET
 * (deal price ≥ same-day close − 0.1%). Enter at the deal-day close.
 *
 * Each exit rule simulated intrabar with daily H/L (stop checked before target on a
 * same-day touch = pessimistic). Max hold capped at the validated horizon (20 sessions),
 * so a bracket can only exit EARLIER, never run past where the edge was measured.
 *
 * Fair excess: each trade compared to the equal-weight basket over the SAME #days held.
 * Net of Derayah 0.11% RT. t-stats are simple (clustering caveat noted — see findings).
 *
 * Run: node scripts/blockdeal_atr_exit_test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'data', 'block_deals_signed.json');
const COST_RT = +process.env.COST_RT || 0.0011;
const MAXH = +process.env.MAXH || 20;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const winp = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';

function atrAt(h, l, c, i, p = 14) {
  if (i < p) return null;
  let s = 0; for (let k = i - p + 1; k <= i; k++) s += Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1]));
  return s / p;
}

async function main() {
  const { events } = JSON.parse(readFileSync(CACHE, 'utf8'));
  const ysyms = TASI_STOCKS.map(s => toYahooSym(s.sym));
  await warm(ysyms, '10y');
  const data = {};
  for (let i = 0; i < ysyms.length; i++) {
    const b = await getBars(ysyms[i], '10y'); if (!b.length) continue;
    data[TASI_STOCKS[i].sym] = { dates: b.map(x => iso(x.t)), o: b.map(x => x.o), h: b.map(x => x.h), l: b.map(x => x.l), c: b.map(x => x.c) };
  }
  const universe = Object.keys(data);
  const entryIdx = (sym, date) => { const d = data[sym]; if (!d) return -1; return d.dates.findIndex(x => x >= date); };
  // equal-weight basket return over exactly `hd` sessions from `date`
  const ewC = {};
  const ew = (date, hd) => { const k = date + '|' + hd; if (k in ewC) return ewC[k]; const rs = []; for (const s of universe) { const d = data[s]; const i = d.dates.findIndex(x => x >= date); if (i < 0 || i + hd >= d.c.length) continue; rs.push(d.c[i + hd] / d.c[i] - 1); } return ewC[k] = rs.length ? mean(rs) : null; };

  // ---- build entry set: BIG (≥ median value) + premium/at-market ----
  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const entries = [];
  for (const e of events) {
    if (e.value < medVal || !e.price) continue;
    const d = data[e.sym]; if (!d) continue;
    const i = entryIdx(e.sym, e.date); if (i < 14 || i + MAXH >= d.c.length) continue;
    const prem = e.price / d.c[i] - 1;
    if (prem < -0.001) continue;                 // skip discounts (informed sellers)
    if (Math.abs(prem) > 0.10) continue;          // parse-error guard
    entries.push({ sym: e.sym, date: e.date, i });
  }

  // ---- exit simulators ----
  // returns { ret, held } for a trade entered at close[i]
  function simBracket(d, i, kStop, kTgt) {
    const atr = atrAt(d.h, d.l, d.c, i); if (!atr) return null;
    const entry = d.c[i], stop = entry - kStop * atr, tgt = entry + kTgt * atr;
    for (let j = i + 1; j <= i + MAXH && j < d.c.length; j++) {
      const hd = j - i;
      // gap handling at open, then intrabar; stop checked first (pessimistic)
      if (d.o[j] <= stop) return { ret: d.o[j] / entry - 1, held: hd };
      if (d.l[j] <= stop) return { ret: stop / entry - 1, held: hd };
      if (d.o[j] >= tgt) return { ret: d.o[j] / entry - 1, held: hd };
      if (d.h[j] >= tgt) return { ret: tgt / entry - 1, held: hd };
    }
    const j = Math.min(i + MAXH, d.c.length - 1);
    return { ret: d.c[j] / entry - 1, held: j - i };   // timeout
  }
  function simFixed(d, i) { const j = i + MAXH; return { ret: d.c[j] / d.c[i] - 1, held: MAXH }; }
  // trailing stop: ratchet a stop up under the running peak. kInit = initial stop distance,
  // kTrail = trail distance (ATR units, fixed off entry ATR). Lets winners run, caps downside.
  function simTrail(d, i, kInit, kTrail) {
    const atr = atrAt(d.h, d.l, d.c, i); if (!atr) return null;
    const entry = d.c[i]; let stop = entry - kInit * atr, peak = entry;
    for (let j = i + 1; j <= i + MAXH && j < d.c.length; j++) {
      const hd = j - i;
      if (d.o[j] <= stop) return { ret: d.o[j] / entry - 1, held: hd };   // gap through stop
      if (d.l[j] <= stop) return { ret: stop / entry - 1, held: hd };     // intrabar stop
      peak = Math.max(peak, d.h[j]);
      stop = Math.max(stop, peak - kTrail * atr);                          // ratchet up only
    }
    const j = Math.min(i + MAXH, d.c.length - 1);
    return { ret: d.c[j] / entry - 1, held: j - i };
  }
  // close-based trail: stop only triggers on a CLOSE below it (no wick exits); trails off
  // the running peak CLOSE. Exit booked at that day's close.
  function simTrailClose(d, i, kInit, kTrail) {
    const atr = atrAt(d.h, d.l, d.c, i); if (!atr) return null;
    const entry = d.c[i]; let stop = entry - kInit * atr, peak = entry;
    for (let j = i + 1; j <= i + MAXH && j < d.c.length; j++) {
      const hd = j - i;
      if (d.c[j] <= stop) return { ret: d.c[j] / entry - 1, held: hd };
      peak = Math.max(peak, d.c[j]);
      stop = Math.max(stop, peak - kTrail * atr);
    }
    const j = Math.min(i + MAXH, d.c.length - 1);
    return { ret: d.c[j] / entry - 1, held: j - i };
  }

  const rules = [
    ['FIXED 20 (hold)', (d, i) => simFixed(d, i)],
    ['stop1.5 tgt1.5 (1:1)', (d, i) => simBracket(d, i, 1.5, 1.5)],
    ['stop1.5 tgt3.0 (1:2)', (d, i) => simBracket(d, i, 1.5, 3.0)],
    ['stop2.0 tgt4.0 (1:2)', (d, i) => simBracket(d, i, 2.0, 4.0)],
    ['stop1.0 tgt3.0 (1:3)', (d, i) => simBracket(d, i, 1.0, 3.0)],
    ['stop3.0 tgt3.0 (wide)', (d, i) => simBracket(d, i, 3.0, 3.0)],
    ['stop2.0 tgt6.0 (1:3)', (d, i) => simBracket(d, i, 2.0, 6.0)],
    ['trail 2.0 ATR', (d, i) => simTrail(d, i, 2.0, 2.0)],
    ['trail 3.0 ATR', (d, i) => simTrail(d, i, 3.0, 3.0)],
    ['trail init2 trail3', (d, i) => simTrail(d, i, 2.0, 3.0)],
    ['trail init1.5 trail2.5', (d, i) => simTrail(d, i, 1.5, 2.5)],
    ['trailCLOSE 2.0 ATR', (d, i) => simTrailClose(d, i, 2.0, 2.0)],
    ['trailCLOSE 3.0 ATR', (d, i) => simTrailClose(d, i, 3.0, 3.0)],
    ['trailCLOSE init2 trail3', (d, i) => simTrailClose(d, i, 2.0, 3.0)],
  ];

  console.log(`\n=== BLOCK-DEAL EXIT TEST — ATR bracket vs fixed ${MAXH}-session hold ===`);
  console.log(`entries: ${entries.length} BIG premium/at-market deals (≥ median ${(medVal / 1e6).toFixed(1)}M SAR). Cost ${pct(COST_RT)} RT.`);
  console.log(`\n  ${'exit rule'.padEnd(22)} ${'n'.padStart(4)}  ${'ABS net'.padStart(8)} ${'t'.padStart(5)}  ${'win'.padStart(4)}  ${'EXCESS net'.padStart(10)} ${'t'.padStart(5)}  ${'avgDays'.padStart(7)}`);
  for (const [label, fn] of rules) {
    const abs = [], exc = [], days = [];
    for (const e of entries) {
      const r = fn(data[e.sym], e.i); if (!r) continue;
      const b = ew(e.date, r.held); if (b == null) continue;
      const net = r.ret - COST_RT;
      abs.push(net); exc.push(net - b); days.push(r.held);
    }
    console.log(`  ${label.padEnd(22)} ${String(abs.length).padStart(4)}  ${pct(mean(abs)).padStart(8)} ${String(tstat(abs)).padStart(5)}  ${winp(abs).padStart(4)}  ${pct(mean(exc)).padStart(10)} ${String(tstat(exc)).padStart(5)}  ${mean(days).toFixed(1).padStart(7)}`);
  }
  console.log(`\n  Read: a bracket "wins" only if ABS net AND EXCESS net both ≥ the FIXED row, ideally with fewer avg days (capital freed sooner).`);
  process.exit(0);
}
main();
