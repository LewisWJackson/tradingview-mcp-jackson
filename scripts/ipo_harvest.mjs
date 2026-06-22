#!/usr/bin/env node
/**
 * ipo_harvest.mjs — Saudi IPO base-rate ledger builder
 *
 * PURPOSE
 *   Structural validation of the "IPO subscription flipping" retail edge for a
 *   Sharia-compliant Tadawul/Nomu account. This is a FREQUENCY-TABLE study, NOT a
 *   price backtest — do not run it through portfolioGuillotine. The edge is a
 *   primary-market mechanic (fixed offer price → scaled allocation → flip the pop),
 *   so the relevant statistic is the day-1 pop base rate and the break-issue tail.
 *
 * DATA PROVENANCE
 *   Assembled 2026-06-22 from public sources (Argaam, Arab News, The National,
 *   MenaBytes, sahmcapital, gulfbusiness, Zawya). saudiexchange.sa is Akamai-walled
 *   and firecrawl ran out of credits (HTTP 402) during this harvest, so the sample is
 *   hand-curated from news + Argaam article pages, NOT a complete exchange dump.
 *
 * IMPORTANT MECHANIC (caps the whole edge)
 *   Tadawul applies an expanded ±30% daily price-fluctuation limit for the first 3
 *   sessions of a new listing, reverting to ±10% from day 4. Therefore a day-1 close
 *   is mechanically bounded to [-30%, +30%]. Almost every hot main-market IPO simply
 *   pins the +30% cap on day 1 (ACWA Power, Rasan, MBC all "rose the maximum 30%").
 *   The large numbers quoted in the press (+134%, +147%, +190%) are CUMULATIVE /
 *   since-listing moves over weeks, not day-1 pops. The ledger below records the
 *   day-1 figure where a clean source exists, and flags 'cap' when the print was the
 *   +30% limit. Fields that could not be sourced cleanly are null.
 *
 * USAGE
 *   node scripts/ipo_harvest.mjs            # prints the base-rate table
 *   node scripts/ipo_harvest.mjs --json     # raw ledger as JSON
 */

// --- THE LEDGER -------------------------------------------------------------
// day1_pct: day-1 close vs offer, in %. null = not cleanly sourced.
// day1_note: 'cap' = hit the +30% limit on day 1; 'cum' = figure is cumulative not day-1.
// broke_issue: true if day-1 close < offer (where day-1 known).
const LEDGER = [
  // company, code, market, year, offerSar, overSubInst, listDate, day1_pct, day1_note, broke_issue, source
  ['ACWA Power',          '2082', 'Main', 2021, 56.00,  null,  '2021-10-11', 30,   'cap', false, 'arabnews'],
  ['Nayifat Finance',     '4081', 'Main', 2021, 34.00, 136,    '2021-11-22', null, 'cum', null,  'argaam/arabnews'],   // ATH 30.50 quoted = below offer; day-1 close unclear
  ['Luberef',             '2030', 'Main', 2022, 99.00,  null,  '2022-12-28', -4,   null,  true,  'thenational'],       // closed 95 = -4% (BROKE ISSUE)
  ['MBC Group',           '4072', 'Main', 2024, 25.00,  null,  '2024-01-08', 30,   'cap', false, 'thenational'],       // "rose as much as 30%"
  ['Middle East Pharma',  '4016', 'Main', 2024, 82.00,  null,  '2024-02-27', null, null,  null,  'sahmcapital'],       // +44.88% since-listing (cum)
  ['Modern Mills',        '2284', 'Main', 2024, 48.00, 127,    '2024-03-27', null, null,  null,  'sahmcapital'],       // -14.9% since-listing (cum); day1 unclear
  ['Dr Soliman Fakeeh',   '4017', 'Main', 2024, 57.50,  null,  '2024-06-05', null, null,  null,  'sahmcapital'],       // +18.78% since-listing (cum)
  ['Miahona',             '2084', 'Main', 2024, 11.50,  null,  '2024-06-06', null, 'cum', false, 'sahmcapital'],       // +134% since-listing (cum); popped
  ['Saudi Manpower (SMASCO)','1834','Main',2024, 7.50,  null,  '2024-06-12', null, null,  null,  'sahmcapital'],       // +0.53% since-listing (cum)
  ['Rasan Information Tech','8313','Main', 2024, 37.00, 129,    '2024-06-13', 30,   'cap', false, 'menabytes'],        // closed 48.1 = +30% cap
  ['Al Taiseer (Talco)',  '4143', 'Main', 2024, 43.00,  null,  '2024-06-13', null, null,  null,  'sahmcapital'],       // +71.86% since-listing (cum)
  ['Al Majed Oud',        '4165', 'Main', 2024, 94.00,  null,  '2024-10-07', null, null,  null,  'sahmcapital'],       // +53.4% since-listing (cum)
  ['Arabian Mills',       '2285', 'Main', 2024, 66.00,  null,  '2024-10-08', null, 'cum', null,  'sahmcapital/argaam'],// ATH 72.60 day1 (+10% intraday); closed below; -25.91% since
  ['Fourth Milling (MC4)','2286', 'Main', 2024, 5.30,   null,  '2024-10-29', null, 'cum', null,  'sahmcapital/argaam'],// ATH 5.79 day1 (+9.2% intraday); -23.96% since (BROKE later)
  ['Tamkeen HR',          '1835', 'Main', 2024, 50.00,  null,  '2024-11-27', null, null,  null,  'sahmcapital'],       // +28.6% since-listing (cum)
  ['United Intl Holding', '4083', 'Main', 2024, 132.00, null,  '2024-12-03', null, null,  null,  'sahmcapital'],       // +27.58% since-listing (cum)
  ['Nice One Beauty',     '4328', 'Main', 2025, 35.00,  null,  '2025-01-08', null, 'cum', false, 'arabnews'],          // +45% since debut (cum); popped
  ['Flynas',              '4264', 'Main', 2025, 80.00, 100,    '2025-06-18', null, null,  null,  'gulfnews'],          // "stormy start" (Israel-Iran); day1 unclear, not a clean pop
  ['Dar AlBalad',         '7205', 'Main', 2026, 9.75,   null,  '2026-05-20', 26,   null,  false, 'sahmcapital'],       // closed 12.32 = +26.4% (under ±30%)
  // ---- Nomu (parallel / qualified-investor market) ----
  ['Pan Gulf Marketing',  '9580', 'Nomu', 2024, null,   null,  '2024-02-XX', null, 'cum', true,  'argaam'],            // -35% post-listing (BROKE ISSUE, cum)
  ['Yaqeen Capital',      null,   'Nomu', 2024, null,   null,  '2024-06-XX', null, 'cum', true,  'arabnews'],          // -28% post-listing (BROKE ISSUE, cum)
  ['Purity for IT',       null,   'Nomu', 2024, null,   null,  '2024-10-XX', null, 'cum', false, 'arabnews'],          // +118% in first 30 days (cum)
  ['Smoh Almadi',         null,   'Nomu', 2025, 22.00,  null,  '2025-01-XX', null, 'cum', true,  'searchnews'],        // -60% after listing (BROKE ISSUE, cum)
  ['Smile Care (Basma)',  '9626', 'Nomu', 2025, 4.40, 1981,    '2025-02-03', null, null,  null,  'argaam'],            // 1981% oversub; day1 unclear
  ['Lamasat',             '9628', 'Nomu', 2025, 5.75, 1101,    '2025-02-09', null, null,  null,  'argaam'],            // 1101% oversub
  ['Ratio Speciality',    null,   'Nomu', 2025, 10.00, 865,    '2025-03-XX', null, 'cum', false, 'searchnews'],        // +190% after listing (cum); popped
];

const COLS = ['company','code','market','year','offerSar','overSubInst','listDate','day1_pct','day1_note','broke_issue','source'];
const rows = LEDGER.map(r => Object.fromEntries(COLS.map((c,i) => [c, r[i]])));

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

// --- BASE-RATE STATS --------------------------------------------------------
const known = rows.filter(r => r.day1_pct !== null);          // clean day-1 sample
const popped = known.filter(r => r.day1_pct > 0);
const broke  = rows.filter(r => r.broke_issue === true);       // includes cum-broke (proxy for tail)
const median = a => { const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const mean   = a => a.reduce((s,x)=>s+x,0)/a.length;

console.log('=== SAUDI IPO BASE-RATE LEDGER (2021-2026) ===\n');
console.log(`Total IPOs in ledger:        ${rows.length}  (Main ${rows.filter(r=>r.market==='Main').length} / Nomu ${rows.filter(r=>r.market==='Nomu').length})`);
console.log(`Clean DAY-1 pct sample:      n=${known.length}  ${known.map(r=>`${r.company.split(' ')[0]} ${r.day1_pct}%`).join(', ')}`);
console.log(`  popped (day1>0):           ${popped.length}/${known.length} = ${(100*popped.length/known.length).toFixed(0)}%`);
console.log(`  mean day-1 pop:            ${mean(known.map(r=>r.day1_pct)).toFixed(1)}%`);
console.log(`  median day-1 pop:          ${median(known.map(r=>r.day1_pct)).toFixed(1)}%`);
console.log(`  hit +30% cap on day 1:     ${known.filter(r=>r.day1_note==='cap').length}`);
console.log(`\nBroke-issue (day1 or post):  ${broke.length}/${rows.length}  → ${broke.map(r=>r.company).join(', ')}`);
console.log(`  (all confirmed break-issue are Nomu except Luberef on Main)`);
console.log('\nNOTE: day-1 is mechanically bounded to ±30% (3-session expanded limit).');
console.log('Large press figures (+134/+147/+190%) are CUMULATIVE, not day-1.');
