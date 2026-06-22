/**
 * blockdeal_signal.mjs — LIVE "follow the big premium trades" signal (validated edge #3).
 *
 * Validated (scripts/block_deal_signed_test.mjs, 12mo): a BIG block deal that prints at or
 * above the market price (an aggressive buyer) tends to beat the basket AND make money over
 * the next ~20 sessions (abs +0.87% net, excess +1.6%, t=4.0 / 1.9 overlap-corrected). A big
 * deal at a DISCOUNT is an informed seller — it beats the basket but LOSES money; skip it.
 *
 * This returns deals still inside their ~20-session hold window, signed and Sharia-filtered.
 * Source = block_deal_log (what the live Argaam scraper maintains). Prices from bars_cache.
 */
import { getBars, warm, iso } from '../scripts/bars_cache.mjs';
import { toYahooSym, TASI_STOCKS } from '../scripts/tasi_screener.mjs';
import { getShariaStatus } from './sharia.mjs';
import { db } from './db.js';

const BIG_SAR = 10_000_000;      // validated median deal size ≈ 10M SAR
const HOLD = 20;                 // ~1 month
const PREM = 0.001;              // ±0.1% dead-band around market for "at-market"
const NAME = Object.fromEntries(TASI_STOCKS.map(s => [s.sym, s.name]));

export async function getBlockDealSignal() {
  // recent deals only (active window + buffer)
  const cutoff = new Date(Date.now() - 35 * 86400000).toISOString().slice(0, 10);
  const rows = db.prepare('SELECT sym, date, deals FROM block_deal_log WHERE date >= ? ORDER BY date DESC').all(cutoff);
  // dedup to one per (sym,date), keep largest value; pull price+value
  const ev = new Map();
  let dataAsOf = '';
  for (const r of rows) {
    if (r.date > dataAsOf) dataAsOf = r.date;
    let d = {}; try { d = JSON.parse(r.deals) || {}; } catch {}
    const value = d.value || 0, price = d.price || 0;
    const k = r.sym + '|' + r.date;
    if (!ev.has(k) || value > ev.get(k).value) ev.set(k, { sym: r.sym, date: r.date, value, price });
  }
  const events = [...ev.values()].filter(e => e.value >= BIG_SAR && e.price > 0);
  if (!events.length) return { success: true, asOf: dataAsOf, signals: [], skipped: [], universe: { bigDeals: 0 }, note: 'No big block deals in the last ~5 weeks (or scraper data is stale — refresh Whale Watch).' };

  // need bars for the deal names
  const ysyms = [...new Set(events.map(e => toYahooSym(e.sym)))];
  await warm(ysyms, '10y');

  const signals = [], skipped = [];
  for (const e of events) {
    const b = await getBars(toYahooSym(e.sym), '10y');
    if (!b.length) continue;
    const dates = b.map(x => iso(x.t)), c = b.map(x => x.c);
    let i = dates.findIndex(x => x >= e.date);
    if (i < 0) continue;
    const lastIdx = c.length - 1;
    const held = lastIdx - i;                     // trading sessions since the deal
    if (held > HOLD) continue;                    // window expired — no longer actionable
    const premium = e.price / c[i] - 1;           // deal price vs market close that day
    if (Math.abs(premium) > 0.10) continue;        // >10% off market = deal-price parse error, drop
    const cls = premium > PREM ? 'premium' : premium < -PREM ? 'discount' : 'at-market';
    const sharia = getShariaStatus(e.sym).status;
    const rec = {
      sym: e.sym, code: e.sym.replace('TADAWUL:', ''), name: NAME[e.sym] || e.sym,
      dealDate: e.date, dealPrice: +e.price.toFixed(2), currentPrice: +c[lastIdx].toFixed(2),
      premiumPct: +(premium * 100).toFixed(2), cls,
      valueM: +(e.value / 1e6).toFixed(1),
      sessionsHeld: held, sessionsLeft: HOLD - held,
      sinceDealPct: +((c[lastIdx] / c[i] - 1) * 100).toFixed(1),
      sharia,
    };
    if (cls === 'discount') skipped.push(rec);            // informed seller — avoid
    else signals.push(rec);                               // premium / at-market — the signal
  }
  // collapse to one entry per stock — keep the freshest active deal (most sessions left)
  const bySym = new Map();
  for (const s of signals) { const cur = bySym.get(s.sym); if (!cur || s.sessionsLeft > cur.sessionsLeft) bySym.set(s.sym, s); }
  const uniq = [...bySym.values()];
  // sort: compliant first, then freshest
  uniq.sort((a, b) => (a.sharia === 'compliant' ? 0 : 1) - (b.sharia === 'compliant' ? 0 : 1) || b.sessionsLeft - a.sessionsLeft);

  return {
    success: true, asOf: dataAsOf,
    params: {
      trigger: 'big block deal ≥10M SAR at premium / at-market price', hold: '~20 sessions (1 month)',
      skip: 'discount deals (informed sellers — they lose money)', cost: '0.11% RT (Derayah)', universe: 'Sharia-compliant preferred',
    },
    status: {
      verdict: 'MARGINAL / UNCONFIRMED — fails the per-period gate (t 1.94 < 2)',
      effect: 'BIG premium/at-market event excess +1.54%/bucket — positive but not significant',
      power: 'underpowered: only ~1y of deal history → 14 non-overlapping buckets',
      caveat: 'the original "validated" oc-t 1.9 ≈ the gate t 1.94 — it was always marginally below t>2',
      discountWarning: 'discount deals look worse (informed sellers) — still skipped',
      next: 're-harvest Argaam to push past ~30 buckets; that\'s the only way to settle it',
    },
    universe: { bigDeals: events.length, active: uniq.length, skippedDiscount: skipped.length },
    signals: uniq, skipped,
    note: 'NOT a validated edge — fails the cross-clustering-robust gate (t 1.94), underpowered (~1y). Suggestive only; shown for awareness, do not size on it. Heuristic deal-price tag, ~50-name coverage, survivorship.',
  };
}
