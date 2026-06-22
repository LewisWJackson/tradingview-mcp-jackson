/**
 * filings.mjs — ingest TASI ownership-change / insider disclosures into the DB.
 *
 * Source-agnostic: takes already-structured events (e.g. from a Firecrawl extract of
 * Argaam/Tadawul disclosures, or a manual import) and normalizes + resolves the
 * company to a TADAWUL symbol + dedups + stores. The point is to make the
 * information edge VALIDATABLE — see scripts/filings_edge_test.mjs.
 *
 * Event shape (loose): { company, ticker?, party?, direction, prev_pct?, new_pct?,
 *                        shares?, date }  direction ∈ increase|decrease|buy|sell
 */
import { db } from './db.js';
import { TASI_STOCKS } from '../scripts/tasi_screener.mjs';

// ── company → TADAWUL symbol resolution ───────────────────────────────────────
const STOP_EN = new Set(['company','co','the','for','and','group','holding','holdings','ltd','saudi','arabia','arabian','sa','industries','industrial','national']);
const tokEn = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w && !STOP_EN.has(w));

// Arabic normalization: strip tashkeel, unify alef/ya/ta-marbuta, drop شركة / ال- prefixes.
const STOP_AR = new Set(['شركه', 'مجموعه', 'القابضه', 'السعوديه', 'العربيه']);
const normAr = (s) => (s || '')
  .replace(/[ً-ْ]/g, '')
  .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^؀-ۿ\s]/g, ' ').trim();
const tokAr = (s) => normAr(s).split(/\s+/).map(w => w.replace(/^ال/, '')).filter(w => w.length > 1 && !STOP_AR.has(w));

const NAME_INDEX = TASI_STOCKS.map(s => ({
  sym: s.sym, code: s.sym.split(':')[1],
  en: new Set(tokEn(s.name)), ar: new Set(tokAr(s.ar)),
}));

function bestMatch(toks, field, minScore) {
  if (!toks.size) return null;
  let best = null, score = 0;
  for (const x of NAME_INDEX) {
    let overlap = 0; for (const tkn of toks) if (x[field].has(tkn)) overlap++;
    const sc = overlap / Math.max(1, Math.min(toks.size, x[field].size));
    if (overlap > 0 && sc > score) { score = sc; best = x.sym; }
  }
  return score >= minScore ? best : null;
}

// Resolve in precision order: numeric ticker -> Arabic name -> English name.
export function resolveSymbol(company, ticker, companyAr) {
  if (ticker && /^\d{4}$/.test(ticker)) { const hit = NAME_INDEX.find(x => x.code === ticker); if (hit) return hit.sym; }
  return bestMatch(new Set(tokAr(companyAr)), 'ar', 0.5)   // Arabic is high-precision
      || bestMatch(new Set(tokEn(company)), 'en', 0.5);
}

// ── ingest ────────────────────────────────────────────────────────────────────
const _exists = db.prepare('SELECT 1 FROM cma_filings WHERE sym=? AND filing_date=? AND institution_en=? AND new_pct IS ?');
const _ins = db.prepare(`
  INSERT INTO cma_filings (sym, company, company_ar, institution, institution_en, prev_pct, new_pct, direction, shares_delta, filing_date, source, source_url, raw_text, verified)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
`);

// Normalize direction to a clean buy/sell-style label (increase = accumulation).
const cleanDir = (d) => /incr|buy|add/i.test(d) ? 'increase' : /decr|sell|reduc/i.test(d) ? 'decrease' : 'unknown';

export function ingestFilings(events, source = 'firecrawl') {
  let inserted = 0, resolved = 0, skipped = 0;
  for (const e of events) {
    const sym = resolveSymbol(e.company, e.ticker, e.company_ar);
    if (!sym) { skipped++; continue; }
    resolved++;
    const inst = e.party || null;
    const date = (e.date || '').slice(0, 10);
    if (!date) { skipped++; continue; }
    if (_exists.get(sym, date, inst, e.new_pct ?? null)) continue; // dedup
    _ins.run(sym, e.company || null, e.company_ar || null, inst, inst, e.prev_pct ?? null, e.new_pct ?? null,
             cleanDir(e.direction), e.shares ?? null, date, source, e.source_url || null, null);
    inserted++;
  }
  return { events: events.length, resolved, inserted, skipped };
}

export function getRecentFilings({ limit = 100, direction = null } = {}) {
  const where = direction ? `WHERE direction='${direction}'` : '';
  return db.prepare(`SELECT * FROM cma_filings ${where} ORDER BY filing_date DESC LIMIT ?`).all(limit);
}

export function filingsSummary() {
  const total = db.prepare('SELECT COUNT(*) n FROM cma_filings').get().n;
  const byDir = db.prepare('SELECT direction, COUNT(*) n FROM cma_filings GROUP BY direction').all();
  const range = db.prepare('SELECT MIN(filing_date) min, MAX(filing_date) max, COUNT(DISTINCT sym) syms FROM cma_filings').get();
  return { total, byDir, ...range };
}
