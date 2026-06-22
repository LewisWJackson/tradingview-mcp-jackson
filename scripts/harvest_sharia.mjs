/**
 * harvest_sharia.mjs — build a RELIABLE Sharia-compliance dataset for the TASI universe.
 *
 * Source of truth = Musaffa (AAOIFI methodology), scraped per symbol from
 * musaffa.com/stock/{code}.SR/. The definitive status sits in the page's FAQ schema
 * ("classified as NOT HALAL as of March 2026") and the status chip — both plain-fetchable.
 *
 * Transparency layer = we ALSO compute the two AAOIFI financial ratios we can source from
 * TradingView fundamentals (interest-bearing debt / market cap, cash+ST-invest / market cap;
 * both must be < 30%). The third AAOIFI ratio (impure income / revenue < 5%) isn't in the
 * scanner feed, so Musaffa remains the authority — the computed ratios are a cross-check and
 * a change-detector, not an override.
 *
 * Writes dashboard/sharia_data.json. Run: node --experimental-sqlite scripts/harvest_sharia.mjs
 * (sqlite flag only needed because fundamentals import chain touches db; harmless otherwise)
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASI_STOCKS } from './tasi_screener.mjs';
import { getFundamentals } from '../dashboard/fundamentals.mjs';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'dashboard', 'sharia_data.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Musaffa status text → our canonical status
function mapStatus(raw) {
  const s = (raw || '').toUpperCase().trim();
  if (/NOT\s*HALAL|NON[-\s]?COMPLIANT/.test(s)) return 'non_compliant';
  if (/DOUBTFUL|QUESTIONABLE|UNDER\s*REVIEW/.test(s)) return 'review';
  if (/HALAL|COMPLIANT/.test(s)) return 'compliant';
  return 'unknown';
}

async function fetchMusaffa(code) {
  const url = `https://musaffa.com/stock/${code}.SR/`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await (await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) })).text();
      // primary: FAQ schema sentence has status + as-of date
      let m = html.match(/classified as ([A-Z][A-Z ]*?) as of (\w+\s+\d{4})/);
      if (m) return { status: mapStatus(m[1]), label: m[1].trim(), asOf: m[2], url };
      // backup: the status chip
      m = html.match(/status-text">([^<]+)<\/h5>/);
      if (m) return { status: mapStatus(m[1]), label: m[1].trim(), asOf: null, url };
      return { status: 'unknown', label: null, asOf: null, url };
    } catch (e) { if (attempt) return { status: 'unknown', label: null, asOf: null, url, error: e.message }; await sleep(800); }
  }
}

// Secondary authority (AAOIFI-based) — fills Musaffa's coverage gaps (404s).
async function fetchMuslimXchange(code) {
  const url = `https://muslimxchange.com/ticker/${code}/`;
  try {
    const html = await (await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(25000) })).text();
    if (/not\s+shariah\s+compliant|non[-\s]?compliant/i.test(html)) return { status: 'non_compliant', label: 'NOT COMPLIANT', source: 'muslimxchange', url };
    if (/doubtful|questionable/i.test(html)) return { status: 'review', label: 'DOUBTFUL', source: 'muslimxchange', url };
    if (/is\s+shariah\s+compliant|stock\s+is\s+shariah\s+compliant/i.test(html)) return { status: 'compliant', label: 'COMPLIANT', source: 'muslimxchange', url };
    return null;
  } catch { return null; }
}

async function computeRatios(sym) {
  try {
    const f = await getFundamentals(sym);
    const mc = f.marketCap;
    if (!mc || mc <= 0) return null;
    const debtRatio = f.totalDebt != null ? f.totalDebt / mc : null;
    const cashRatio = f.totalCash != null ? f.totalCash / mc : null;
    const fails = [];
    if (debtRatio != null && debtRatio > 0.30) fails.push('debt');
    if (cashRatio != null && cashRatio > 0.30) fails.push('cash');
    return { debtRatio: debtRatio != null ? +debtRatio.toFixed(3) : null, cashRatio: cashRatio != null ? +cashRatio.toFixed(3) : null, ratioFails: fails };
  } catch { return null; }
}

async function main() {
  const syms = TASI_STOCKS;
  console.error(`harvesting Sharia status for ${syms.length} TASI names from Musaffa ...`);
  const out = { source: 'musaffa (AAOIFI)', generatedAt: new Date().toISOString(), ratioNote: 'debt & cash ratios computed from TradingView fundamentals (impure-income ratio not sourced; Musaffa is authority)', data: {} };
  let ok = 0, nc = 0, rev = 0, unk = 0, disagree = 0;
  for (let i = 0; i < syms.length; i++) {
    const { sym } = syms[i];
    const code = sym.replace('TADAWUL:', '');
    let m = await fetchMusaffa(code);
    // Musaffa gap (404/parse-miss) → secondary authority muslimxchange
    if (m.status === 'unknown') {
      const mx = await fetchMuslimXchange(code);
      if (mx) m = { ...mx, asOf: null };
    }
    const r = await computeRatios(sym);
    // banks (10xx/11xx) + insurance (80xx-86xx): debt/cap & cash/cap ratios are structurally
    // inapplicable (deposits/sukuk aren't interest debt) — Musaffa's activity screen rules them.
    const isFinancial = /^1[01]/.test(code) || /^8[0-6]/.test(code);
    // cross-check (non-financials only): Musaffa says compliant but computed ratios fail → flag, don't override
    const disagrees = !isFinancial && m.status === 'compliant' && r && r.ratioFails.length > 0;
    if (disagrees) disagree++;
    out.data[sym] = {
      status: m.status,
      label: m.label,
      asOf: m.asOf,
      source: m.source || 'musaffa',
      financial: isFinancial,
      ratios: isFinancial ? null : r,    // ratios not meaningful for financials
      flag: disagrees ? `Musaffa says compliant but computed ${r.ratioFails.join('+')} ratio >30% — verify` : null,
    };
    if (m.status === 'compliant') ok++; else if (m.status === 'non_compliant') nc++; else if (m.status === 'review') rev++; else unk++;
    if ((i + 1) % 20 === 0) console.error(`  ${i + 1}/${syms.length} …`);
    await sleep(300);
  }
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.error(`\n✓ ${OUT}`);
  console.log(`compliant ${ok} · non_compliant ${nc} · review ${rev} · unknown ${unk} · ratio-disagreements flagged ${disagree}`);
}
main();
