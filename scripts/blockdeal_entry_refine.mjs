/**
 * blockdeal_entry_refine.mjs — refine the block-deal ENTRY: which premium/size/Sharia cut
 * is the sharpest, and is "at-market" a real signal or a thin-sample fluke?
 *
 * Validated baseline (block_deal_signed_test): BIG premium deals excess +1.63% (t=4.03,
 * oc-t 1.91), at-market +2.74% (t=2.89, n=32 thin). 20-session hold, equal-weight basket,
 * Derayah 0.11% RT. Here we slice the same signed events by premium magnitude, deal size,
 * and Sharia status, reporting overlap-corrected significance for each cut.
 *
 * Run: node scripts/blockdeal_entry_refine.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBars, warm, iso } from './bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from './tasi_screener.mjs';
import { getShariaStatus } from '../dashboard/sharia.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const H = 20, COST_RT = +process.env.COST_RT || 0.0011;
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const tstat = a => a.length > 1 ? +(mean(a) / (sd(a) / Math.sqrt(a.length))).toFixed(2) : NaN;
const pct = x => isNaN(x) ? '—' : (x * 100).toFixed(2) + '%';
const winp = a => a.length ? (a.filter(x => x > 0).length / a.length * 100).toFixed(0) + '%' : '–';
// overlap-correct: keep one event per symbol per 30 calendar days
const overlapCorrect = rows => { const lu = {}, out = []; for (const r of [...rows].sort((a, b) => a.date < b.date ? -1 : 1)) { const t = new Date(r.date).getTime(); if (lu[r.sym] == null || t - lu[r.sym] >= 30 * 864e5) { out.push(r); lu[r.sym] = t; } } return out; };

async function main() {
  const { events } = JSON.parse(readFileSync(join(__dirname, '..', 'data', 'block_deals_signed.json'), 'utf8'));
  await warm(TASI_STOCKS.map(s => toYahooSym(s.sym)), '10y');
  const data = {};
  for (const s of TASI_STOCKS) { const b = await getBars(toYahooSym(s.sym), '10y'); if (!b.length) continue; data[s.sym] = { dates: b.map(x => iso(x.t)), c: b.map(x => x.c) }; }
  const universe = Object.keys(data);
  const fwd = (sym, date) => { const d = data[sym]; if (!d) return null; const i = d.dates.findIndex(x => x >= date); if (i < 0 || i + H >= d.c.length) return null; return { i, ret: d.c[i + H] / d.c[i] - 1 }; };
  const ewC = {}; const ew = date => { if (date in ewC) return ewC[date]; const rs = []; for (const s of universe) { const f = fwd(s, date); if (f) rs.push(f.ret); } return ewC[date] = rs.length ? mean(rs) : null; };

  const vals = events.map(e => e.value).filter(v => v > 0).sort((a, b) => a - b);
  const medVal = vals[Math.floor(vals.length / 2)] || 0;
  const q75 = vals[Math.floor(vals.length * 0.75)] || 0;

  // build signed rows for BIG deals
  const rows = [];
  for (const e of events) {
    if (e.value < medVal || !e.price) continue;
    const f = fwd(e.sym, e.date), bm = ew(e.date); if (!f || bm == null) continue;
    const c = data[e.sym].c[f.i];
    const prem = e.price / c - 1; if (Math.abs(prem) > 0.10) continue;       // parse guard
    rows.push({ sym: e.sym, date: e.date, prem, value: e.value, abs: f.ret - COST_RT, exc: f.ret - COST_RT - bm, sharia: getShariaStatus(e.sym).status, huge: e.value >= q75 });
  }

  const show = (label, a) => {
    if (!a.length) { console.log(`  ${label.padEnd(26)} n=   0  (none)`); return; }
    const oc = overlapCorrect(a);
    console.log(`  ${label.padEnd(26)} n=${String(a.length).padStart(4)}  EXC ${pct(mean(a.map(r => r.exc))).padStart(7)} t=${String(tstat(a.map(r => r.exc))).padStart(5)}  win ${winp(a.map(r => r.exc)).padStart(4)}  | ABS ${pct(mean(a.map(r => r.abs))).padStart(7)}  | oc n=${String(oc.length).padStart(3)} EXC ${pct(mean(oc.map(r => r.exc))).padStart(7)} t=${tstat(oc.map(r => r.exc))}`);
  };

  console.log(`\n=== BLOCK-DEAL ENTRY REFINEMENT — BIG deals (≥${(medVal / 1e6).toFixed(1)}M), ${H}-session, ${pct(COST_RT)} RT ===`);
  console.log(`events ${events.length} | signed BIG rows ${rows.length} | HUGE cutoff (top quartile) ${(q75 / 1e6).toFixed(1)}M`);

  const atm = rows.filter(r => Math.abs(r.prem) <= 0.001);
  const prem = rows.filter(r => r.prem > 0.001);
  const disc = rows.filter(r => r.prem < -0.001);

  console.log(`\n── the sign (premium / at-market / discount) ──`);
  show('PREMIUM (buyer paid up)', prem);
  show('AT-MARKET', atm);
  show('DISCOUNT (skip)', disc);

  console.log(`\n── premium MAGNITUDE (is bigger better, or overpaying?) ──`);
  show('prem 0.1–0.5%', rows.filter(r => r.prem > 0.001 && r.prem <= 0.005));
  show('prem 0.5–1.5%', rows.filter(r => r.prem > 0.005 && r.prem <= 0.015));
  show('prem 1.5–3%', rows.filter(r => r.prem > 0.015 && r.prem <= 0.03));
  show('prem >3%', rows.filter(r => r.prem > 0.03));

  console.log(`\n── deal SIZE (within premium+at-market signal) ──`);
  const sig = rows.filter(r => r.prem > -0.001);
  show('BIG (≥median)', sig);
  show('HUGE (top quartile)', sig.filter(r => r.huge));

  console.log(`\n── Sharia (the tradeable set) ──`);
  show('signal ∩ compliant', sig.filter(r => r.sharia === 'compliant'));
  show('signal ∩ non-compliant', sig.filter(r => r.sharia !== 'compliant'));

  console.log(`\n── candidate REFINED rules ──`);
  show('premium-only (drop at-mkt)', prem);
  show('premium+atmkt (current)', sig);
  show('premium ∩ compliant', prem.filter(r => r.sharia === 'compliant'));
  show('prem ≥0.5% ∩ compliant', prem.filter(r => r.prem >= 0.005 && r.sharia === 'compliant'));
  process.exit(0);
}
main();
