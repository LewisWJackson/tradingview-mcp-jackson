/**
 * index_events.mjs — store MSCI Saudi index-review adds/deletes point-in-time and
 * expose them for an event study (scripts/index_flow_test.mjs). Mirrors catalysts.mjs.
 *
 * Symbols stored as `TADAWUL:${code}` (4-digit main-market code). announce_date is the
 * public-info timestamp (entry); effective_date is the flow execution date (exit).
 * Spec: docs/superpowers/specs/2026-06-21-msci-index-flow-design.md
 */
import { db } from './db.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS index_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    sym            TEXT NOT NULL,
    action         TEXT NOT NULL,          -- 'add' | 'delete'
    review         TEXT NOT NULL,          -- e.g. '2024-11'
    announce_date  TEXT NOT NULL,          -- YYYY-MM-DD
    effective_date TEXT NOT NULL,          -- YYYY-MM-DD
    index_name     TEXT NOT NULL DEFAULT 'MSCI Saudi',
    source         TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(sym, effective_date, action, index_name)
  );
  CREATE INDEX IF NOT EXISTS idx_idxev_eff ON index_events(effective_date);
`);

const isISO = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const _ins = db.prepare(
  `INSERT OR IGNORE INTO index_events (sym, action, review, announce_date, effective_date, index_name, source)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

/** Ingest harvested events [{code,action,review,announce_date,effective_date,index,source}]. */
export function ingestIndexEvents(events) {
  let inserted = 0, skipped = 0;
  for (const e of events || []) {
    const code = String(e.code || '').match(/^\d{4}$/)?.[0];
    const action = (e.action === 'add' || e.action === 'delete') ? e.action : null;
    if (!code || !action || !isISO(e.announce_date) || !isISO(e.effective_date) || !e.review) { skipped++; continue; }
    inserted += _ins.run(
      `TADAWUL:${code}`, action, e.review, e.announce_date, e.effective_date,
      e.index || 'MSCI Saudi', e.source || null
    ).changes;
  }
  return { events: (events || []).length, inserted, skipped };
}

/** Read events, optionally filtered by action and/or index_name, ascending by effective_date. */
export function getIndexEvents({ action = null, index_name = null } = {}) {
  let q = 'SELECT sym, action, review, announce_date, effective_date, index_name, source FROM index_events';
  const where = [], args = [];
  if (action) { where.push('action = ?'); args.push(action); }
  if (index_name) { where.push('index_name = ?'); args.push(index_name); }
  if (where.length) q += ' WHERE ' + where.join(' AND ');
  q += ' ORDER BY effective_date ASC';
  return db.prepare(q).all(...args);
}

export function indexEventsSummary() {
  const total = db.prepare('SELECT COUNT(*) n FROM index_events').get().n;
  const adds = db.prepare("SELECT COUNT(*) n FROM index_events WHERE action='add'").get().n;
  const deletes = db.prepare("SELECT COUNT(*) n FROM index_events WHERE action='delete'").get().n;
  const range = db.prepare('SELECT MIN(effective_date) min, MAX(effective_date) max, COUNT(DISTINCT sym) syms FROM index_events').get();
  return { total, adds, deletes, ...range };
}
