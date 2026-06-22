#!/usr/bin/env node
/**
 * ipo_population.mjs — POPULATION-grade hardening of the Saudi IPO base-rate study.
 *
 * THE WALL
 *   Offer prices for the full IPO population are not cheaply scrapable (saudiexchange.sa
 *   is Akamai-walled, firecrawl is out of credits). The n=5 clean "day-1 close vs offer"
 *   sample is too thin. So we harden in two complementary ways:
 *
 *     (A) PRICE-DERIVED POPULATION PROXY (no offer price needed). For every TASI name
 *         whose FIRST cached daily bar is on/after 2021-01-01 (i.e. it listed in the
 *         study window), measure first-bar / first-5-session price behavior. This is a
 *         PROXY for the offer-relative pop, not the truth — see CAVEAT below.
 *
 *     (B) TRUE POP on the OFFER-PRICE SUBSET. For the curated LEDGER names that have a
 *         known offer price, compute the real day-1 pop = day-1 close / offer − 1, and
 *         check whether the proxy tracks the truth.
 *
 * LOAD-BEARING MECHANIC
 *   Tadawul caps day-1 moves at ±30% for the first 3 sessions (then ±10%). A hot IPO
 *   pins +30% on day 1. The proxy therefore looks for near-+30% prints in the first 3
 *   sessions and reports a cap-pin rate.
 *
 * CAVEAT (state it loudly, do not bury it)
 *   Yahoo's first cached bar is the first SECONDARY-MARKET trading bar. Its OPEN is the
 *   first traded price, which on a capped Saudi IPO is itself already up to +30% above
 *   the offer. So intraday (close/open−1) UNDERSTATES the true offer-relative pop on hot
 *   deals (the gap from offer→open is invisible to us). The proxy measures "did it keep
 *   rising / pin the cap after the first print", which is correlated with but NOT equal
 *   to the offer-relative pop. Offer-relative truth is only known on the small subset (B).
 *
 * This is a FREQUENCY study, NOT a price backtest — no portfolioGuillotine.
 *
 * USAGE
 *   node --experimental-sqlite scripts/ipo_population.mjs
 *   node --experimental-sqlite scripts/ipo_population.mjs --json
 */
import { getBars, warm, iso } from './bars_cache.mjs';
import { TASI_STOCKS } from './tasi_screener.mjs';

const toYahooSym = (sym) => sym.replace('TADAWUL:', '') + '.SR';

// ---- LEDGER with KNOWN offer prices (copied from ipo_harvest.mjs) ----------
// [company, code, market, year, offerSar, listDate, day1_pct(known close-vs-offer or null)]
const LEDGER_OFFERS = [
  ['ACWA Power',           '2082', 'Main', 2021, 56.00, '2021-10-11', 30],
  ['Nayifat Finance',      '4081', 'Main', 2021, 34.00, '2021-11-22', null],
  ['Luberef',              '2030', 'Main', 2022, 99.00, '2022-12-28', -4],
  ['MBC Group',            '4072', 'Main', 2024, 25.00, '2024-01-08', 30],
  ['Middle East Pharma',   '4016', 'Main', 2024, 82.00, '2024-02-27', null],
  ['Modern Mills',         '2284', 'Main', 2024, 48.00, '2024-03-27', null],
  ['Dr Soliman Fakeeh',    '4017', 'Main', 2024, 57.50, '2024-06-05', null],
  ['Miahona',              '2084', 'Main', 2024, 11.50, '2024-06-06', null],
  ['Saudi Manpower',       '1834', 'Main', 2024,  7.50, '2024-06-12', null],
  ['Rasan Information Tech','8313', 'Main', 2024, 37.00, '2024-06-13', 30],
  ['Al Taiseer (Talco)',   '4143', 'Main', 2024, 43.00, '2024-06-13', null],
  ['Al Majed Oud',         '4165', 'Main', 2024, 94.00, '2024-10-07', null],
  ['Arabian Mills',        '2285', 'Main', 2024, 66.00, '2024-10-08', null],
  ['Fourth Milling (MC4)', '2286', 'Main', 2024,  5.30, '2024-10-29', null],
  ['Tamkeen HR',           '1835', 'Main', 2024, 50.00, '2024-11-27', null],
  ['United Intl Holding',  '4083', 'Main', 2024,132.00, '2024-12-03', null],
  ['Nice One Beauty',      '4328', 'Main', 2025, 35.00, '2025-01-08', null],
  ['Flynas',               '4264', 'Main', 2025, 80.00, '2025-06-18', null],
  ['Dar AlBalad',          '7205', 'Main', 2026,  9.75, '2026-05-20', 26],
  ['Smile Care (Basma)',   '9626', 'Nomu', 2025,  4.40, '2025-02-03', null],
  ['Lamasat',              '9628', 'Nomu', 2025,  5.75, '2025-02-09', null],
];
const OFF_COLS = ['company','code','market','year','offerSar','listDate','day1_known'];
const ledgerOffers = LEDGER_OFFERS.map(r => Object.fromEntries(OFF_COLS.map((c,i)=>[c,r[i]])));

// ---- helpers ---------------------------------------------------------------
const WINDOW_START = '2021-01-01';
const CAP = 0.30;                 // ±30% expanded limit, first 3 sessions
const NEAR_CAP = 0.275;           // "pinned the cap" threshold (>= +27.5%)
const median = a => { if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const pct = (n,d) => d ? (100*n/d) : 0;
const f1 = x => x===null||x===undefined ? 'n/a' : x.toFixed(1);

// ---- (1) identify the recent-listing population ----------------------------
async function buildPopulation() {
  const syms = TASI_STOCKS.map(s => toYahooSym(s.sym));
  await warm(syms, '10y');                         // warm cache (no-op if fresh)

  const pop = [];
  for (const s of TASI_STOCKS) {
    const y = toYahooSym(s.sym);
    const bars = await getBars(y, '10y');
    if (bars.length < 1) continue;
    const firstIso = iso(bars[0].t);
    if (firstIso < WINDOW_START) continue;          // had history before window → not a window-IPO
    // need enough bars to be a real listing (avoid 1-bar artifacts)
    if (bars.length < 2) continue;
    pop.push({ sym: s.sym, code: s.sym.replace('TADAWUL:',''), name: s.name, yahoo: y, firstIso, bars });
  }
  return pop;
}

// ---- (2) day-1 / first-5 proxy behavior per listing ------------------------
function proxyRow(p) {
  const b = p.bars;
  const b0 = b[0];
  const day1Intraday = b0.o > 0 ? b0.c / b0.o - 1 : null;        // close/open − 1
  const day1Up = day1Intraday !== null ? day1Intraday > 0 : null;
  // cap-pin proxy: any of the first 3 sessions closes OR highs >= +27.5% above ITS OWN open,
  // i.e. a near-+30% single-session move (the expanded-limit pin).
  let cappedFirst3 = false;
  const n3 = Math.min(3, b.length);
  for (let i = 0; i < n3; i++) {
    const bar = b[i];
    if (bar.o > 0) {
      const closeMove = bar.c / bar.o - 1;
      const highMove = bar.h / bar.o - 1;
      if (closeMove >= NEAR_CAP || highMove >= NEAR_CAP) { cappedFirst3 = true; break; }
    }
  }
  // first-5-session cumulative: close[min(4,last)] / open[0] − 1
  const lastIdx = Math.min(4, b.length - 1);
  const cum5 = b0.o > 0 ? b[lastIdx].c / b0.o - 1 : null;
  return {
    code: p.code, name: p.name, year: +p.firstIso.slice(0, 4), firstIso: p.firstIso,
    day1Intraday, day1Up, cappedFirst3, cum5,
  };
}

function aggregate(rows) {
  const di = rows.map(r => r.day1Intraday).filter(x => x !== null);
  const c5 = rows.map(r => r.cum5).filter(x => x !== null);
  const up = rows.filter(r => r.day1Up === true).length;
  const down = rows.filter(r => r.day1Up === false).length;
  const capped = rows.filter(r => r.cappedFirst3).length;
  const n = rows.length;
  return {
    n,
    pctUp: pct(up, n), pctDown: pct(down, n),
    pctCapped: pct(capped, n),
    medDay1: median(di) === null ? null : 100 * median(di),
    medCum5: median(c5) === null ? null : 100 * median(c5),
  };
}

// ---- (3) true pop on the offer-price subset --------------------------------
// DATA-QUALITY GUARD: Yahoo's first cached bar is NOT reliably the true day-1 bar.
// Three contamination modes seen in the raw data:
//   (i)  pre-IPO history (e.g. 2030.SR Luberef opens 2016, a spun-off Aramco unit),
//   (ii) Yahoo's first bar lags the real list date by weeks/months (ACWA, Rasan, ME
//        Pharma, Smile Care — first bar far after listDate),
//   (iii) price-scale mismatch vs offer (e.g. 4083 offer 132 but trades ~65 — a
//        split/restructure unit gap).
// We only TRUST the offer-relative pop when the first bar is within DATE_TOL days of
// the known list date AND the open is within a sane band of the offer (|gap|<=60%).
// Untrusted rows are reported but excluded from the trusted true-pop stat.
const DATE_TOL_DAYS = 6;
const daysBetween = (isoA, isoB) => Math.abs((Date.parse(isoA) - Date.parse(isoB)) / 86400e3);

async function offerSubsetTruePop() {
  const out = [];
  for (const r of ledgerOffers) {
    const y = toYahooSym('TADAWUL:' + r.code);
    const bars = await getBars(y, '10y');
    if (!bars.length) { out.push({ ...r, status: 'no-bars' }); continue; }
    const b0 = bars[0];
    const firstBar = iso(b0.t);
    const truePop = b0.c / r.offerSar - 1;            // day-1 CLOSE / offer − 1
    const proxy = b0.o > 0 ? b0.c / b0.o - 1 : null;  // close/open − 1 (the (A) proxy)
    const gapOfferToOpen = b0.o / r.offerSar - 1;     // offer→open (invisible to proxy)
    const dayLag = daysBetween(firstBar, r.listDate);
    // Sane offer->open band: Saudi day-1 is reference-capped, so an open below ~−35%
    // of offer is mechanically impossible — it signals a split/unit/scale artifact in
    // Yahoo (e.g. 4083: offer 132 but trades ~65). Upper band loose (+50%) for cap gaps.
    const trusted = dayLag <= DATE_TOL_DAYS && gapOfferToOpen >= -0.35 && gapOfferToOpen <= 0.50;
    out.push({
      ...r, firstBar, open: b0.o, close: b0.c, dayLag,
      truePop: 100 * truePop, proxy: proxy === null ? null : 100 * proxy,
      gapOfferToOpen: 100 * gapOfferToOpen,
      status: 'ok', trusted,
    });
  }
  return out;
}

// ---- main ------------------------------------------------------------------
const pop = await buildPopulation();
const rows = pop.map(proxyRow);
const overall = aggregate(rows);

// decay by listing year
const byYear = {};
for (const r of rows) (byYear[r.year] ||= []).push(r);
const years = Object.keys(byYear).sort();
const decay = years.map(y => ({ year: y, ...aggregate(byYear[y]) }));

const offerSubset = await offerSubsetTruePop();
const offOk = offerSubset.filter(r => r.status === 'ok' && r.trusted);     // date+scale clean
const offDirty = offerSubset.filter(r => r.status === 'ok' && !r.trusted); // contaminated first bar
const offPopped = offOk.filter(r => r.truePop > 0);
const offMedTrue = median(offOk.map(r => r.truePop));
const offMedProxy = median(offOk.map(r => r.proxy).filter(x => x !== null));
const offMedGap = median(offOk.map(r => r.gapOfferToOpen));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ populationN: pop.length, overall, decay, offerSubset,
    offerStats: { nTrusted: offOk.length, nContaminated: offDirty.length,
      poppedRate: pct(offPopped.length, offOk.length),
      medTruePop: offMedTrue, medProxy: offMedProxy, medGapOfferToOpen: offMedGap } }, null, 2));
  process.exit(0);
}

// ---- report ----------------------------------------------------------------
console.log('=== SAUDI IPO POPULATION HARDENING (price-derived, 2026-06-22) ===\n');
console.log(`Recent-listing POPULATION (first cached bar >= ${WINDOW_START}): n = ${pop.length}`);
console.log(`  (of ${TASI_STOCKS.length} TASI names scanned; price-derived proxy — NOT offer-relative)\n`);

console.log('--- (A) PROXY base-rate (first-bar / first-5-session INTRADAY behavior) ---');
console.log(`  % UP day-1 (close>open):       ${f1(overall.pctUp)}%   (${overall.n} listings)`);
console.log(`  % DOWN day-1 (close<open):     ${f1(overall.pctDown)}%`);
console.log(`  % intraday ~+30% cap 1st 3:    ${f1(overall.pctCapped)}%  <- ~0: the cap pin is in the OPEN, not intraday`);
console.log(`  median day-1 intraday return:  ${f1(overall.medDay1)}%`);
console.log(`  median first-5-session return: ${f1(overall.medCum5)}%`);
console.log(`  LESSON: Yahoo's first daily bar already OPENS at the capped/popped price, so`);
console.log(`  close/open intraday is ~flat and CANNOT see the offer->open pop. (A) is a weak`);
console.log(`  proxy for "did it keep rising after the first print"; the real pop lives in (B).\n`);

console.log('--- (B) TRUE pop on OFFER-PRICE subset (day-1 close / offer - 1) ---');
console.log(`  TRUSTED subset n = ${offOk.length} (first bar within ${DATE_TOL_DAYS}d of list date & sane price scale)`);
console.log(`  Excluded (contaminated first bar): n = ${offDirty.length} → ${offDirty.map(r=>r.company.split(' ')[0]).join(', ')}`);
console.log(`  popped (truePop>0):            ${offPopped.length}/${offOk.length} = ${f1(pct(offPopped.length,offOk.length))}%`);
console.log(`  median TRUE pop:               ${f1(offMedTrue)}%`);
console.log(`  median offer->open GAP:        ${f1(offMedGap)}%   <- the pop is almost ALL in this gap`);
console.log('  TRUSTED per-name (truePop | proxy intraday | gap | dayLag):');
for (const r of offOk.sort((a,b)=>b.truePop-a.truePop)) {
  console.log(`    ${r.company.padEnd(22)} ${(r.code||'—').padEnd(5)} true ${f1(r.truePop).padStart(6)}% | proxy ${f1(r.proxy).padStart(6)}% | gap ${f1(r.gapOfferToOpen).padStart(6)}% | lag ${r.dayLag}d (${r.firstBar})`);
}
console.log('  EXCLUDED per-name (why):');
for (const r of offDirty.sort((a,b)=>a.dayLag-b.dayLag)) {
  const why = r.dayLag > DATE_TOL_DAYS ? `firstBar ${r.dayLag}d after listDate` : `price-scale artifact (impossible gap ${f1(r.gapOfferToOpen)}%)`;
  console.log(`    ${r.company.padEnd(22)} ${(r.code||'—').padEnd(5)} ${r.firstBar} vs list ${r.listDate} — ${why}`);
}
console.log();

console.log('--- (C) DECAY check by listing year ---');
console.log('  year   n   %up   %cap   medDay1   medCum5');
for (const d of decay) {
  console.log(`  ${d.year}  ${String(d.n).padStart(3)}  ${f1(d.pctUp).padStart(4)}%  ${f1(d.pctCapped).padStart(4)}%   ${f1(d.medDay1).padStart(6)}%   ${f1(d.medCum5).padStart(6)}%`);
}
console.log();

console.log('--- VERDICT (population-grade) ---');
console.log(`  Offer-subset TRUTH (n=${offOk.length}, clean): ${f1(pct(offPopped.length,offOk.length))}% popped, median +${f1(offMedTrue)}%.`);
console.log(`  Intraday proxy is BLIND to the offer->open gap (median gap +${f1(offMedGap)}%), so the`);
console.log(`  population intraday stats (up-rate ${f1(overall.pctUp)}%) UNDERSTATE the offer-relative pop.`);
console.log(`  The honest population-grade number is the OFFER-SUBSET truth, n=${offOk.length}, not n=5.`);
console.log(`  See docs/research/2026-06-22-ipo-ledger.md for the full decision + caveat.`);
