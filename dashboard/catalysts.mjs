/**
 * catalysts.mjs — ingest official Saudi Exchange issuer announcements as catalyst
 * events, classify by type, store, and expose for an event study.
 *
 * Source: the Tadawul issuer-announcements feed (harvested via Playwright — the only
 * method that bypasses its 403). Each row carries the 4-digit TADAWUL code, so symbol
 * resolution is exact. The point is to test WHICH catalyst types move the stock
 * (forward excess return vs basket) — see scripts/catalyst_edge_test.mjs.
 *
 * Event shape: { code, date('DD/MM/YYYY' or ISO), headline, type? }
 */
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS catalyst_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sym         TEXT NOT NULL,
    event_date  TEXT NOT NULL,          -- YYYY-MM-DD
    type        TEXT NOT NULL,          -- classified category
    headline    TEXT,
    source      TEXT DEFAULT 'tadawul',
    created_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(sym, event_date, type, headline)
  );
  CREATE INDEX IF NOT EXISTS idx_cat_type ON catalyst_events(type, event_date);
`);

// Classify an announcement headline into a catalyst category. Keyword-based; English
// feed (the Arabic annoucmentType filter maps to the same categories upstream).
const RULES = [
  ['acquisition', /acqui|merger|stake purchase|memorandum of understanding|to acquire|reverse takeover/i],
  ['capital_change', /capital increase|capital reduction|rights issue|bonus shares|increase its? capital|reduce its? capital/i],
  ['dividend', /dividend|distribut(e|ion) .*cash|profit distribution/i],
  ['contract', /contract|project (award|sign|sign[- ]off)|awarded|sign(s|ed)? .*(agreement|deal)|tender|purchase order/i],
  ['management', /resignation|appoint|chief executive|ceo|cfo|board member|board of directors.*change|managing director/i],
  ['earnings', /interim financial|annual financial|financial results|net profit|earnings/i],
  ['guidance', /profit warning|expects? .*(loss|profit)|material .*(impact|effect)|guidance/i],
  ['assembly', /general assembly|electronic voting|agenda items|extraordinary general|ordinary general/i],
  ['capital_ops', /sukuk|bond|debt instrument|financing|credit facility|loan/i],
];
export function classify(headline) {
  const h = headline || '';
  for (const [type, re] of RULES) if (re.test(h)) return type;
  return 'other';
}

const toISO = (d) => {
  if (!d) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  const m = d.match(/(\d{2})\/(\d{2})\/(\d{4})/);             // DD/MM/YYYY (Tadawul default)
  if (!m) return null;
  let dd = +m[1], mm = +m[2]; const y = m[3];
  if (mm > 12 && dd <= 12) [dd, mm] = [mm, dd];              // row was MM/DD — swap
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;   // unparseable — drop
  return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
};

const _ins = db.prepare(`INSERT OR IGNORE INTO catalyst_events (sym, event_date, type, headline, source) VALUES (?, ?, ?, ?, ?)`);
export function ingestCatalysts(events, source = 'tadawul') {
  let inserted = 0, skipped = 0;
  for (const e of events) {
    const code = String(e.code || '').match(/^\d{4}$/)?.[0];   // main-market 4-digit only
    const date = toISO(e.date);
    if (!code || !date) { skipped++; continue; }
    const type = e.type || classify(e.headline);
    inserted += _ins.run(`TADAWUL:${code}`, date, type, (e.headline || '').slice(0, 240), source).changes;
  }
  return { events: events.length, inserted, skipped };
}

// ── Risk flags ────────────────────────────────────────────────────────────────
// The event types that significantly predict SHORT-TERM weakness in the event study
// (forward excess vs basket, t < -2.5 at n>50). These are "don't buy right now"
// defensive signals — the one genuinely useful, validated output of the catalyst
// work. NOT alpha (you can't short TASI); they're entry-timing risk warnings.
export const RISK_META = {
  capital_ops: { window: 10, note: 'Debt/sukuk issuance — significant short-term weakness (5d excess −1.8%, t=−3.2)' },
  earnings:    { window: 7,  note: 'Recent earnings — sell-the-news short-term weakness (5d excess −0.7%, t=−2.7)' },
  management:  { window: 5,  note: 'Management/board resignation — next-day weakness (1d excess −0.9%, t=−2.5)' },
};

// Risk flags for one symbol: risk-type catalysts within their relevance window.
export function getRiskFlags(sym, asOf = null) {
  const today = asOf || new Date().toISOString().slice(0, 10);
  const flags = [];
  for (const [type, meta] of Object.entries(RISK_META)) {
    const cutoff = new Date(Date.now() - meta.window * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare(
      'SELECT event_date, headline FROM catalyst_events WHERE sym=? AND type=? AND event_date >= ? AND event_date <= ? ORDER BY event_date DESC'
    ).all(sym, type, cutoff, today);
    for (const r of rows) flags.push({ type, date: r.event_date, note: meta.note, headline: r.headline });
  }
  return flags;
}

// Bulk: map of sym -> flags for every symbol with an active risk catalyst.
export function getActiveRiskFlags() {
  const out = {};
  for (const [type, meta] of Object.entries(RISK_META)) {
    const cutoff = new Date(Date.now() - meta.window * 86400000).toISOString().slice(0, 10);
    const rows = db.prepare('SELECT sym, event_date, headline FROM catalyst_events WHERE type=? AND event_date >= ?').all(type, cutoff);
    for (const r of rows) (out[r.sym] ||= []).push({ type, date: r.event_date, note: meta.note, headline: r.headline });
  }
  return out;
}

export function catalystsSummary() {
  const total = db.prepare('SELECT COUNT(*) n FROM catalyst_events').get().n;
  const byType = db.prepare('SELECT type, COUNT(*) n FROM catalyst_events GROUP BY type ORDER BY n DESC').all();
  const range = db.prepare('SELECT MIN(event_date) min, MAX(event_date) max, COUNT(DISTINCT sym) syms FROM catalyst_events').get();
  return { total, byType, ...range };
}
