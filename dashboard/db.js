/**
 * db.js — SQLite persistence layer for the Mawjah dashboard
 *
 * Replaces 10+ flat-file JSON stores with a single ACID database.
 * Run dashboard/server.mjs with: node --experimental-sqlite dashboard/server.mjs
 *
 * Tables:
 *   score_history   — daily signal scores per symbol (time-series)
 *   positions       — real watchlist positions (sym → JSON blob)
 *   alert_rules     — user-defined alert conditions
 *   virtual_meta    — virtual portfolio scalars (cash, balance_start)
 *   virtual_positions — virtual portfolio holdings
 *   virtual_trades  — virtual trade log
 *   insider_buys    — manually logged insider purchases
 *   block_deal_log  — Argaam block deal records
 *   meta            — ad-hoc key-value store (last_block_deals, auto_scan, etc.)
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WEIGHTS } from './allocation.mjs';
import { computeBook } from './fills.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH   = join(__dirname, 'mawjah.db');

// Suppress only the SQLite experimental warning — leave all other warnings intact
process.on('warning', w => { if (w.name === 'ExperimentalWarning' && w.message.includes('SQLite')) return; console.warn(w.message); });

export const db = new DatabaseSync(DB_PATH);

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS score_history (
    sym        TEXT NOT NULL,
    date       TEXT NOT NULL,
    score      INTEGER,
    max_score  INTEGER,
    bias       TEXT,
    price      REAL,
    mode       TEXT,
    vc         INTEGER,
    rb         INTEGER,
    wh         REAL,
    PRIMARY KEY (sym, date)
  );

  CREATE TABLE IF NOT EXISTS positions (
    sym  TEXT PRIMARY KEY,
    data TEXT NOT NULL  -- JSON blob
  );

  CREATE TABLE IF NOT EXISTS alert_rules (
    id   TEXT PRIMARY KEY,
    sym  TEXT,
    field TEXT,
    op   TEXT,
    data TEXT NOT NULL  -- full rule as JSON
  );

  CREATE TABLE IF NOT EXISTS virtual_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS virtual_positions (
    sym       TEXT PRIMARY KEY,
    name      TEXT,
    shares    REAL,
    avg_cost  REAL,
    date      TEXT
  );

  CREATE TABLE IF NOT EXISTS virtual_trades (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sym        TEXT,
    name       TEXT,
    action     TEXT,
    shares     REAL,
    price      REAL,
    date       TEXT,
    cash_after REAL
  );

  CREATE TABLE IF NOT EXISTS opportunity_signals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sym          TEXT NOT NULL,
    name         TEXT,
    signal_type  TEXT NOT NULL,
    conviction   REAL DEFAULT 0,
    detected_at  TEXT NOT NULL,
    refreshed_at TEXT,
    scan_ts      TEXT,
    payload      TEXT,
    status       TEXT DEFAULT 'active',
    expires_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_oppsig_active ON opportunity_signals(status, conviction DESC);
  CREATE INDEX IF NOT EXISTS idx_oppsig_sym    ON opportunity_signals(sym, signal_type);

  CREATE TABLE IF NOT EXISTS insider_buys (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    sym     TEXT,
    name    TEXT,
    person  TEXT,
    role    TEXT,
    shares  REAL,
    price   REAL,
    value   REAL,
    date    TEXT,
    notes   TEXT,
    added   TEXT,
    source  TEXT DEFAULT 'manual'
  );

  CREATE TABLE IF NOT EXISTS block_deal_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    sym    TEXT,
    date   TEXT,
    source TEXT DEFAULT 'argaam',
    deals  TEXT  -- JSON
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS goals_profile (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS allocation_policy (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS fills (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    sym    TEXT NOT NULL,
    name   TEXT,
    action TEXT NOT NULL,   -- 'buy' | 'sell'
    shares REAL NOT NULL,
    price  REAL NOT NULL,
    fees   REAL DEFAULT 0,
    date   TEXT NOT NULL,   -- YYYY-MM-DD
    note   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_fills_sym ON fills(sym, id);

  CREATE TABLE IF NOT EXISTS decision_snapshots (
    period TEXT PRIMARY KEY,   -- rebalance anchor (YYYY-MM-DD); one plan per period
    as_of  TEXT,
    data   TEXT NOT NULL       -- full snapshot JSON
  );

  CREATE TABLE IF NOT EXISTS accuracy_signals (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    sym              TEXT NOT NULL,
    name             TEXT,
    logged_at        TEXT NOT NULL,
    price_entry      REAL NOT NULL,
    price_stop       REAL,
    price_t1         REAL,
    price_t2         REAL,
    bias             TEXT,
    score            INTEGER,
    max_score        INTEGER,
    composite        INTEGER,
    scan_mode        TEXT,
    style_tags       TEXT,
    market           TEXT,
    sector           TEXT,
    hurst            REAL,
    atr_rank         INTEGER,
    rsi_entry        REAL,
    vol_ratio_entry  REAL,
    outcome          TEXT,
    price_outcome    REAL,
    outcome_at       TEXT,
    days_to_outcome  INTEGER,
    r_multiple       REAL,
    notes            TEXT,
    regime           TEXT,
    market_index     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_acc_sym  ON accuracy_signals(sym, outcome);
  CREATE INDEX IF NOT EXISTS idx_acc_date ON accuracy_signals(logged_at DESC);

  -- Validation spine: every signal graded by forward EXCESS return vs an
  -- equal-weight TASI basket over a fixed horizon, net of cost. This is the
  -- honest edge metric (the accuracy_signals stop/target hit-rate flatters
  -- signals in a rising tape — see scripts/backtest_logic.mjs).
  CREATE TABLE IF NOT EXISTS signal_outcomes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    sym          TEXT NOT NULL,
    source       TEXT NOT NULL,        -- 'scoreBias' | 'opportunity'
    signal_type  TEXT NOT NULL,        -- 'STRONG_BUY' | opportunity signal_type
    score        REAL,
    conviction   REAL,
    entry_date   TEXT NOT NULL,        -- YYYY-MM-DD bar date the signal is based on
    entry_price  REAL NOT NULL,
    horizon      INTEGER NOT NULL,     -- forward sessions (5/10/20)
    regime       TEXT,                 -- 'up'|'down' at entry (index vs its SMA50)
    graded_at    TEXT,                 -- ISO; NULL = pending
    fwd_price    REAL,
    signal_ret   REAL,
    basket_ret   REAL,                 -- equal-weight TASI basket, same window
    excess       REAL,                 -- signal_ret - basket_ret
    excess_net   REAL,                 -- excess - round-trip cost
    UNIQUE(sym, source, signal_type, entry_date, horizon)
  );
  CREATE INDEX IF NOT EXISTS idx_so_pending ON signal_outcomes(graded_at, entry_date);
  CREATE INDEX IF NOT EXISTS idx_so_type    ON signal_outcomes(signal_type, horizon);

  CREATE TABLE IF NOT EXISTS strategy_state (
    strategy_id   TEXT PRIMARY KEY,
    state         TEXT NOT NULL,
    since         TEXT,
    evidence      TEXT,
    exposure_mult REAL NOT NULL DEFAULT 0,
    updated_at    TEXT
  );
  CREATE TABLE IF NOT EXISTS strategy_transitions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    reason      TEXT,
    actor       TEXT NOT NULL,
    evidence    TEXT,
    at          TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cma_filings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sym           TEXT NOT NULL,          -- TADAWUL:XXXX
    company       TEXT,                   -- English company name
    company_ar    TEXT,                   -- Arabic company name
    institution   TEXT,                   -- Shareholder/institution name (Arabic)
    institution_en TEXT,                  -- Mapped English name if known
    prev_pct      REAL,                   -- Previous stake %
    new_pct       REAL,                   -- New stake % after transaction
    direction     TEXT NOT NULL,          -- 'buy' | 'sell' | 'unknown'
    shares_delta  INTEGER,                -- Change in number of shares (positive = buy)
    filing_date   TEXT NOT NULL,          -- YYYY-MM-DD
    source        TEXT DEFAULT 'manual',  -- 'argaam' | 'mubasher' | 'manual' | 'tadawul'
    source_url    TEXT,
    raw_text      TEXT,                   -- Original Arabic text snippet
    verified      INTEGER DEFAULT 0,      -- 1 = CMA-confirmed, 0 = inferred
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS cma_sym_date ON cma_filings (sym, filing_date);

  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE,
    username      TEXT UNIQUE,
    password_hash TEXT,
    display_name  TEXT,
    avatar_url    TEXT,
    provider      TEXT DEFAULT 'local',
    provider_id   TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    last_login    TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_provider ON users(provider, provider_id)
    WHERE provider_id IS NOT NULL;
`);

// ── One-time migration from existing JSON files ───────────────────────────────
function migrateIfEmpty(table, jsonPath, importFn) {
  const count = db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get();
  if (count.n > 0) return;
  if (!existsSync(jsonPath)) return;
  try {
    const data = JSON.parse(readFileSync(jsonPath, 'utf8'));
    importFn(data);
    console.log(`[db] migrated ${table} from ${jsonPath.split('/').pop()}`);
  } catch (e) {
    // Roll back any open transaction so subsequent migrations can start fresh
    try { db.exec('ROLLBACK'); } catch {}
    console.warn(`[db] migration warning for ${table}:`, e.message);
  }
}

// score_history: { sym: [{d, s, m, b, p, md?, vc?, rb?, wh?}] }
migrateIfEmpty('score_history', join(__dirname, 'score_history.json'), data => {
  const ins = db.prepare(`INSERT OR IGNORE INTO score_history
    (sym, date, score, max_score, bias, price, mode, vc, rb, wh)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  for (const [sym, entries] of Object.entries(data || {})) {
    for (const e of (entries || []).slice(-15)) {
      const vcVal = e.vc == null ? null : (e.vc ? 1 : 0);
      const rbVal = e.rb == null ? null : (e.rb ? 1 : 0);
      ins.run(sym, e.d, e.s ?? null, e.m ?? null, e.b ?? null,
              e.p ?? null, e.md ?? null, vcVal, rbVal, e.wh ?? null);
    }
  }
  db.exec('COMMIT');
});

// positions: { sym: {...positionData} }
migrateIfEmpty('positions', join(__dirname, 'positions.json'), data => {
  const ins = db.prepare('INSERT OR IGNORE INTO positions (sym, data) VALUES (?,?)');
  db.exec('BEGIN');
  for (const [sym, pos] of Object.entries(data || {})) {
    ins.run(sym, JSON.stringify(pos));
  }
  db.exec('COMMIT');
});

// alert_rules: [{id, sym, field, op, ...}]
migrateIfEmpty('alert_rules', join(__dirname, 'alert_rules.json'), data => {
  const ins = db.prepare('INSERT OR IGNORE INTO alert_rules (id, sym, field, op, data) VALUES (?,?,?,?,?)');
  db.exec('BEGIN');
  for (const rule of (data || [])) {
    ins.run(rule.id, rule.sym, rule.field, rule.op, JSON.stringify(rule));
  }
  db.exec('COMMIT');
});

// virtual_portfolio: { cash, balance_start, positions: {}, trades: [] }
migrateIfEmpty('virtual_meta', join(__dirname, 'virtual_portfolio.json'), data => {
  const insMeta = db.prepare('INSERT OR IGNORE INTO virtual_meta (key, value) VALUES (?,?)');
  const insPos  = db.prepare('INSERT OR IGNORE INTO virtual_positions (sym,name,shares,avg_cost,date) VALUES (?,?,?,?,?)');
  const insTrade = db.prepare('INSERT INTO virtual_trades (sym,name,action,shares,price,date,cash_after) VALUES (?,?,?,?,?,?,?)');
  db.exec('BEGIN');
  insMeta.run('cash', String(data.cash ?? 100000));
  insMeta.run('balance_start', String(data.balance_start ?? 100000));
  for (const [sym, pos] of Object.entries(data.positions || {})) {
    insPos.run(sym, pos.name ?? sym, pos.shares ?? 0, pos.avg_cost ?? 0, pos.date ?? null);
  }
  for (const t of (data.trades || []).slice().reverse()) {  // oldest first for AUTOINCREMENT order
    insTrade.run(t.sym, t.name ?? t.sym, t.action, t.shares, t.price, t.date, t.cash_after ?? null);
  }
  db.exec('COMMIT');
});

// insider_buys: [{sym, name, person, role, shares, price, value, date, notes, added}]
migrateIfEmpty('insider_buys', join(__dirname, 'insider_buys.json'), data => {
  const ins = db.prepare(`INSERT INTO insider_buys
    (sym,name,person,role,shares,price,value,date,notes,added)
    VALUES (?,?,?,?,?,?,?,?,?,?)`);
  db.exec('BEGIN');
  for (const b of (data || [])) {
    ins.run(b.sym, b.name ?? '', b.person ?? '', b.role ?? '', b.shares ?? 0,
            b.price ?? 0, b.value ?? 0, b.date, b.notes ?? '', b.added ?? new Date().toISOString());
  }
  db.exec('COMMIT');
});

// ── Score history helpers ─────────────────────────────────────────────────────
const _scoreInsert = db.prepare(`
  INSERT OR REPLACE INTO score_history (sym,date,score,max_score,bias,price,mode,vc,rb,wh)
  VALUES (?,?,?,?,?,?,?,?,?,?)
`);
const _scoreForSym = db.prepare(
  'SELECT * FROM score_history WHERE sym=? ORDER BY date DESC LIMIT ?'
);
const _scoreAll    = db.prepare('SELECT * FROM score_history ORDER BY sym, date DESC');
const _scorePrune  = db.prepare(`
  DELETE FROM score_history WHERE sym=? AND date NOT IN (
    SELECT date FROM score_history WHERE sym=? ORDER BY date DESC LIMIT 15
  )
`);

export const scoreHistory = {
  /** Upsert one entry and prune to last 15 per symbol. */
  upsert(sym, entry) {
    const vc = entry.vc == null ? null : (entry.vc ? 1 : 0);
    const rb = entry.rb == null ? null : (entry.rb ? 1 : 0);
    _scoreInsert.run(sym, entry.d, entry.s ?? null, entry.m ?? null, entry.b ?? null,
                     entry.p ?? null, entry.md ?? null, vc, rb, entry.wh ?? null);
    _scorePrune.run(sym, sym);
  },
  /** Returns last `limit` entries for a symbol, newest first. */
  forSym(sym, limit = 15) {
    return _scoreForSym.all(sym, limit).map(rowToScoreEntry);
  },
  /** Returns all entries grouped as { sym: [entries] } for API compatibility. */
  allGrouped() {
    const rows = _scoreAll.all();
    const out = {};
    for (const row of rows) {
      if (!out[row.sym]) out[row.sym] = [];
      if (out[row.sym].length < 15) out[row.sym].push(rowToScoreEntry(row));
    }
    return out;
  },
};

function rowToScoreEntry(row) {
  const e = { d: row.date, s: row.score, m: row.max_score, b: row.bias, p: row.price };
  if (row.mode  != null) e.md = row.mode;
  if (row.vc    != null) e.vc = !!row.vc;
  if (row.rb    != null) e.rb = !!row.rb;
  if (row.wh    != null) e.wh = row.wh;
  return e;
}

// ── Positions helpers ─────────────────────────────────────────────────────────
export const positions = {
  getAll() {
    const rows = db.prepare('SELECT * FROM positions').all();
    return Object.fromEntries(rows.map(r => [r.sym, JSON.parse(r.data)]));
  },
  get(sym) { return db.prepare('SELECT data FROM positions WHERE sym=?').get(sym) || null; },
  set(sym, data) {
    db.prepare('INSERT OR REPLACE INTO positions (sym,data) VALUES (?,?)').run(sym, JSON.stringify(data));
  },
  setAll(obj) {
    db.exec('BEGIN');
    db.prepare('DELETE FROM positions').run();
    const ins = db.prepare('INSERT INTO positions (sym,data) VALUES (?,?)');
    for (const [sym, data] of Object.entries(obj || {})) ins.run(sym, JSON.stringify(data));
    db.exec('COMMIT');
  },
};

// ── Real fill ledger ──────────────────────────────────────────────────────────
// Append-only log of ACTUAL Derayah fills. The ledger is the source of truth;
// the derived open book is projected back into the `positions` blob above so
// decision.mjs HOLD/SELL and the exit-check P&L keep reading one set of holdings.
const normFillSym = (s) => /^\d{4}$/.test((s || '').trim()) ? `TADAWUL:${(s || '').trim()}` : (s || '').trim();
const today = () => new Date().toISOString().split('T')[0];

export const realFills = {
  // List the raw ledger, oldest → newest (chronological folds correctly).
  getAll() {
    return db.prepare('SELECT * FROM fills ORDER BY id ASC').all();
  },

  // Append one fill and re-project the open book into the positions blob.
  // Returns { id, fill, book } — book is the recomputed open book + realized P&L.
  log({ sym, name, action, shares, price, fees = 0, date, note }) {
    const s = normFillSym(sym);
    if (!s) return { error: 'sym required' };
    if (action !== 'buy' && action !== 'sell') return { error: "action must be 'buy' or 'sell'" };
    if (!(+shares > 0)) return { error: 'shares must be > 0' };
    if (!(+price > 0)) return { error: 'price must be > 0' };
    const d = date || today();
    const result = db.prepare(
      'INSERT INTO fills (sym,name,action,shares,price,fees,date,note) VALUES (?,?,?,?,?,?,?,?)'
    ).run(s, name || s, action, +shares, +price, +fees || 0, d, note || null);
    this._syncPositions();
    return { id: result.lastInsertRowid, fill: { sym: s, name: name || s, action, shares: +shares, price: +price, fees: +fees || 0, date: d, note: note || null }, book: this.book() };
  },

  // Delete one fill by id (correction path) and re-project.
  remove(id) {
    const r = db.prepare('DELETE FROM fills WHERE id=?').run(id);
    this._syncPositions();
    return { removed: r.changes };
  },

  // Current open book + realized P&L, folded from the full ledger.
  book() {
    return computeBook(this.getAll());
  },

  // Project the open book into the `positions` table so decision.mjs / exit-check
  // see real holdings. Keeps the blob shape they expect: { sym,name,shares,buy_price,avg_cost,date }.
  // Reconciles against the CURRENT open book, not the ledger sym list: every fill-sourced
  // position no longer open (sold to zero, or its fills deleted) is removed — even when the
  // ledger is now empty. Manually-entered positions (source != 'fill') are left untouched.
  _syncPositions() {
    const { open } = this.book();
    const openBySym = new Map(open.map(p => [p.sym, p]));
    for (const p of open) {
      positions.set(p.sym, {
        sym: p.sym, name: p.name, shares: p.shares,
        buy_price: p.avgCost, avg_cost: p.avgCost, price: p.avgCost,
        date: p.lastDate || today(), source: 'fill',
      });
    }
    for (const [sym, blob] of Object.entries(positions.getAll())) {
      if (blob && blob.source === 'fill' && !openBySym.has(sym)) {
        db.prepare('DELETE FROM positions WHERE sym=?').run(sym);
      }
    }
  },

  // Wipe the ledger (and the positions it derived). Used by tests / a hard reset.
  reset() {
    db.exec('BEGIN');
    db.prepare('DELETE FROM fills').run();
    db.exec('COMMIT');
    this._syncPositions();   // open book now empty → all fill-sourced positions removed
  },
};

// ── Decision snapshots ────────────────────────────────────────────────────────
// What the strategy SAID to do for a rebalance period — the intent the fill book
// is later measured against (see tracking.mjs). One plan per period (upsert).
export const decisionSnapshots = {
  save(snap) {
    if (!snap?.period) return { error: 'period required' };
    db.prepare('INSERT OR REPLACE INTO decision_snapshots (period,as_of,data) VALUES (?,?,?)')
      .run(snap.period, snap.asOf || null, JSON.stringify(snap));
    return { ok: true, period: snap.period };
  },
  getByPeriod(period) {
    const r = db.prepare('SELECT data FROM decision_snapshots WHERE period=?').get(period);
    return r ? JSON.parse(r.data) : null;
  },
  getLatest() {
    const r = db.prepare('SELECT data FROM decision_snapshots ORDER BY period DESC LIMIT 1').get();
    return r ? JSON.parse(r.data) : null;
  },
  getAll() {
    return db.prepare('SELECT data FROM decision_snapshots ORDER BY period DESC').all().map(r => JSON.parse(r.data));
  },
  remove(period) {
    return { removed: db.prepare('DELETE FROM decision_snapshots WHERE period=?').run(period).changes };
  },
};

// ── Alert rules helpers ───────────────────────────────────────────────────────
export const alertRules = {
  getAll() {
    return db.prepare('SELECT data FROM alert_rules').all().map(r => JSON.parse(r.data));
  },
  upsert(rule) {
    db.prepare('INSERT OR REPLACE INTO alert_rules (id,sym,field,op,data) VALUES (?,?,?,?,?)')
      .run(rule.id, rule.sym, rule.field, rule.op, JSON.stringify(rule));
  },
  delete(id) {
    db.prepare('DELETE FROM alert_rules WHERE id=?').run(id);
  },
  updateAll(rules) {
    db.exec('BEGIN');
    db.prepare('DELETE FROM alert_rules').run();
    const ins = db.prepare('INSERT INTO alert_rules (id,sym,field,op,data) VALUES (?,?,?,?,?)');
    for (const r of rules) ins.run(r.id, r.sym, r.field, r.op, JSON.stringify(r));
    db.exec('COMMIT');
  },
};

// ── Virtual portfolio helpers ─────────────────────────────────────────────────
function getVirtualMeta(key, fallback) {
  const row = db.prepare('SELECT value FROM virtual_meta WHERE key=?').get(key);
  return row ? parseFloat(row.value) : fallback;
}
function setVirtualMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO virtual_meta (key,value) VALUES (?,?)').run(key, String(value));
}

export const virtualPortfolio = {
  get() {
    const cash          = getVirtualMeta('cash', 100000);
    const balance_start = getVirtualMeta('balance_start', 100000);
    const posRows = db.prepare('SELECT * FROM virtual_positions').all();
    const positions = Object.fromEntries(posRows.map(r => [r.sym, {
      sym: r.sym, name: r.name, shares: r.shares, avg_cost: r.avg_cost, date: r.date,
    }]));
    const trades = db.prepare('SELECT * FROM virtual_trades ORDER BY id DESC LIMIT 100').all()
      .map(r => ({ sym: r.sym, name: r.name, action: r.action, shares: r.shares,
                   price: r.price, date: r.date, cash_after: r.cash_after }));
    return { cash, balance_start, positions, trades };
  },

  buy({ sym, name, shares, price }) {
    const cash = getVirtualMeta('cash', 100000);
    // TASI round-trip cost: Tadawul 0.12% + Edaa 0.04% + broker ~0.15% = ~0.31% one-way
    const commRate = sym?.startsWith('TADAWUL:') ? 0.0031 : 0.001;
    const cost = shares * price * (1 + commRate);
    if (cost > cash) return { error: 'Insufficient virtual cash' };
    const newCash = +(cash - cost).toFixed(4);
    setVirtualMeta('cash', newCash);
    const existing = db.prepare('SELECT * FROM virtual_positions WHERE sym=?').get(sym);
    if (existing) {
      const totalShares = existing.shares + shares;
      const avgCost = +((existing.shares * existing.avg_cost + cost) / totalShares).toFixed(4);
      db.prepare('UPDATE virtual_positions SET shares=?,avg_cost=? WHERE sym=?')
        .run(totalShares, avgCost, sym);
    } else {
      db.prepare('INSERT INTO virtual_positions (sym,name,shares,avg_cost,date) VALUES (?,?,?,?,?)')
        .run(sym, name || sym, shares, +price.toFixed(4), new Date().toISOString().split('T')[0]);
    }
    db.prepare('INSERT INTO virtual_trades (sym,name,action,shares,price,date,cash_after) VALUES (?,?,?,?,?,?,?)')
      .run(sym, name || sym, 'buy', shares, +price.toFixed(4), new Date().toISOString().split('T')[0], newCash);
    return { ok: true };
  },

  sell({ sym, shares, price }) {
    const pos = db.prepare('SELECT * FROM virtual_positions WHERE sym=?').get(sym);
    if (!pos) return { error: `No position for ${sym}` };
    if (shares > pos.shares) return { error: `Only ${pos.shares} shares held` };
    const newShares = pos.shares - shares;
    const cash = getVirtualMeta('cash', 0);
    const commRate = sym?.startsWith('TADAWUL:') ? 0.0031 : 0.001;
    const proceeds = shares * price * (1 - commRate);
    const newCash = +(cash + proceeds).toFixed(4);
    setVirtualMeta('cash', newCash);
    if (newShares <= 0) {
      db.prepare('DELETE FROM virtual_positions WHERE sym=?').run(sym);
    } else {
      db.prepare('UPDATE virtual_positions SET shares=? WHERE sym=?').run(newShares, sym);
    }
    db.prepare('INSERT INTO virtual_trades (sym,name,action,shares,price,date,cash_after) VALUES (?,?,?,?,?,?,?)')
      .run(sym, pos.name, 'sell', shares, +price.toFixed(4), new Date().toISOString().split('T')[0], +(cash + proceeds).toFixed(4));
    return { ok: true };
  },

  reset(balance = 100000) {
    db.exec('BEGIN');
    setVirtualMeta('cash', balance);
    setVirtualMeta('balance_start', balance);
    db.prepare('DELETE FROM virtual_positions').run();
    db.prepare('DELETE FROM virtual_trades').run();
    db.exec('COMMIT');
  },
};

// Migrate: add source column to existing insider_buys tables
try { db.exec("ALTER TABLE insider_buys ADD COLUMN source TEXT DEFAULT 'manual'"); } catch(_) {}

// ── Insider buys helpers ──────────────────────────────────────────────────────
export const insiderBuys = {
  getAll() {
    return db.prepare('SELECT * FROM insider_buys ORDER BY date DESC, added DESC').all();
  },
  add(buy) {
    db.prepare(`INSERT INTO insider_buys (sym,name,person,role,shares,price,value,date,notes,added,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(buy.sym, buy.name ?? '', buy.person ?? '', buy.role ?? '',
           buy.shares ?? 0, buy.price ?? 0, buy.value ?? 0,
           buy.date, buy.notes ?? '', buy.added ?? new Date().toISOString(),
           buy.source ?? 'manual');
  },
  exists(sym, person, date) {
    return !!db.prepare('SELECT 1 FROM insider_buys WHERE sym=? AND person=? AND date=?')
      .get(sym, person ?? '', date);
  },
  delete(sym, date) {
    db.prepare('DELETE FROM insider_buys WHERE sym=? AND date=?').run(sym, date);
  },
  deleteAuto() {
    db.prepare("DELETE FROM insider_buys WHERE source != 'manual'").run();
  },
  syncAll(arr) {
    db.exec('BEGIN');
    db.prepare('DELETE FROM insider_buys').run();
    const ins = db.prepare(`INSERT INTO insider_buys (sym,name,person,role,shares,price,value,date,notes,added,source)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    for (const b of (arr || [])) {
      ins.run(b.sym, b.name ?? '', b.person ?? '', b.role ?? '',
              b.shares ?? 0, b.price ?? 0, b.value ?? 0,
              b.date, b.notes ?? '', b.added ?? new Date().toISOString(),
              b.source ?? 'manual');
    }
    db.exec('COMMIT');
  },
};

// ── Block deal log helpers ────────────────────────────────────────────────────
export const blockDeals = {
  getFrequency() {
    const rows = db.prepare('SELECT sym, date FROM block_deal_log').all();
    const freq = {};
    for (const r of rows) {
      if (!freq[r.sym]) freq[r.sym] = [];
      if (!freq[r.sym].includes(r.date)) freq[r.sym].push(r.date);
    }
    return freq;
  },
  recentForSym(sym, days = 15) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return db.prepare('SELECT date, deals FROM block_deal_log WHERE sym=? AND date>=? ORDER BY date DESC')
      .all(sym, cutoff).map(r => { try { return { date: r.date, ...JSON.parse(r.deals) }; } catch { return { date: r.date }; } });
  },
  recentAll(days = 15) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return db.prepare('SELECT sym, date, deals FROM block_deal_log WHERE date>=? ORDER BY date DESC')
      .all(cutoff).map(r => { try { return { sym: r.sym, date: r.date, ...JSON.parse(r.deals) }; } catch { return { sym: r.sym, date: r.date }; } });
  },
  appendDeals(deals, dateStr) {
    const ins = db.prepare('INSERT INTO block_deal_log (sym,date,source,deals) VALUES (?,?,?,?)');
    db.exec('BEGIN');
    for (const d of deals) {
      ins.run(d.sym || d.ticker || '', dateStr, 'argaam', JSON.stringify(d));
    }
    db.exec('COMMIT');
  },
  getLastDeals() {
    const row = db.prepare("SELECT value FROM meta WHERE key='last_block_deals'").get();
    return row ? JSON.parse(row.value) : null;
  },
  setLastDeals(data, date) {
    db.prepare("INSERT OR REPLACE INTO meta (key,value) VALUES ('last_block_deals',?)")
      .run(JSON.stringify({ data, date }));
  },
};

// ── CMA Filings ───────────────────────────────────────────────────────────────
export const cmaFilings = {
  insert(f) {
    return db.prepare(`
      INSERT INTO cma_filings
        (sym, company, company_ar, institution, institution_en, prev_pct, new_pct,
         direction, shares_delta, filing_date, source, source_url, raw_text, verified)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      f.sym, f.company||null, f.company_ar||null,
      f.institution||null, f.institution_en||null,
      f.prev_pct??null, f.new_pct??null,
      f.direction||'unknown', f.shares_delta??null,
      f.filing_date, f.source||'manual',
      f.source_url||null, f.raw_text||null, f.verified?1:0
    );
  },

  // Find filings for a sym, optionally within ±days of a reference date
  forSym(sym, refDate = null, days = 5) {
    if (refDate) {
      return db.prepare(`
        SELECT * FROM cma_filings
        WHERE sym = ?
          AND ABS(julianday(filing_date) - julianday(?)) <= ?
        ORDER BY filing_date DESC
      `).all(sym, refDate, days);
    }
    return db.prepare(
      'SELECT * FROM cma_filings WHERE sym = ? ORDER BY filing_date DESC LIMIT 20'
    ).all(sym);
  },

  // Recent filings across all stocks (for the monitor panel)
  recent(limit = 50) {
    return db.prepare(
      'SELECT * FROM cma_filings ORDER BY filing_date DESC, created_at DESC LIMIT ?'
    ).all(limit);
  },

  // Delete a filing by id
  delete(id) {
    return db.prepare('DELETE FROM cma_filings WHERE id = ?').run(id);
  },

  // Duplicate guard: same sym + institution + filing_date
  exists(sym, institution, filing_date) {
    return !!db.prepare(
      'SELECT 1 FROM cma_filings WHERE sym=? AND institution=? AND filing_date=? LIMIT 1'
    ).get(sym, institution, filing_date);
  },

  // Stats for a sym: how many buy/sell filings in last N days
  summary(sym, days = 30) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    return db.prepare(`
      SELECT direction, COUNT(*) as count, SUM(ABS(shares_delta)) as total_shares
      FROM cma_filings
      WHERE sym = ? AND filing_date >= ?
      GROUP BY direction
    `).all(sym, cutoff);
  },
};

// ── Opportunity Signals ───────────────────────────────────────────────────────
try { db.exec("ALTER TABLE opportunity_signals ADD COLUMN refreshed_at TEXT"); } catch(_) {}
try { db.exec("ALTER TABLE opportunity_signals ADD COLUMN discovery_price REAL"); } catch(_) {}

export const oppSignals = {
  upsert(sym, signalType, payload, scanTs) {
    const now = new Date().toISOString();
    const existing = db.prepare(
      "SELECT id, discovery_price FROM opportunity_signals WHERE sym=? AND signal_type=? AND status='active' ORDER BY detected_at DESC LIMIT 1"
    ).get(sym, signalType);
    if (existing) {
      db.prepare("UPDATE opportunity_signals SET conviction=?,refreshed_at=?,scan_ts=?,payload=?,expires_at=? WHERE id=?")
        .run(payload.conviction ?? 0, now, scanTs ?? null, JSON.stringify(payload), payload.expires_at ?? null, existing.id);
    } else {
      db.prepare(`INSERT INTO opportunity_signals (sym,name,signal_type,conviction,detected_at,refreshed_at,scan_ts,payload,status,expires_at,discovery_price)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sym, payload.name ?? '', signalType, payload.conviction ?? 0, now, now, scanTs ?? null, JSON.stringify(payload), 'active', payload.expires_at ?? null, payload.price ?? null);
    }
  },
  getActive(minConviction = 30, limit = 20) {
    return db.prepare(
      "SELECT * FROM opportunity_signals WHERE status='active' AND conviction>=? ORDER BY conviction DESC LIMIT ?"
    ).all(minConviction, limit).map(r => { try { return { ...r, payload: JSON.parse(r.payload || '{}') }; } catch { return { ...r, payload: {} }; } });
  },
  expireOld() {
    const now = new Date().toISOString();
    db.prepare("UPDATE opportunity_signals SET status='expired' WHERE status='active' AND expires_at IS NOT NULL AND expires_at < ?").run(now);
  },
  invalidate(sym, signalType) {
    db.prepare("UPDATE opportunity_signals SET status='invalidated' WHERE sym=? AND signal_type=? AND status='active'")
      .run(sym, signalType);
  },
  clearActive() {
    db.prepare("UPDATE opportunity_signals SET status='expired' WHERE status='active'").run();
  },
};

// ── Strategy Validation ───────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS tracked_opportunities (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    sym               TEXT NOT NULL,
    name              TEXT,
    signal_type       TEXT NOT NULL,
    conviction        REAL,
    -- Entry snapshot
    tracked_at        TEXT NOT NULL,
    entry_price       REAL NOT NULL,
    simulated_capital REAL DEFAULT 20000,
    shares            REAL,
    stop              REAL,
    target1           REAL,
    target2           REAL,
    atr_pct           REAL,
    -- Indicators frozen at entry
    rsi               REAL,
    mfi               REAL,
    whale_score       REAL,
    vol_ratio         REAL,
    obv_trend         TEXT,
    divergence        TEXT,
    weekly_trend      TEXT,
    market_regime     TEXT,
    score             INTEGER,
    max_score         INTEGER,
    rs_score          REAL,
    signals_json      TEXT,
    -- Excursion tracking
    mae               REAL DEFAULT 0,
    mfe               REAL DEFAULT 0,
    -- Outcome
    status            TEXT DEFAULT 'tracking',
    exit_price        REAL,
    exit_date         TEXT,
    exit_reason       TEXT,
    -- User
    notes             TEXT,
    created_at        TEXT,
    updated_at        TEXT
  );

  CREATE TABLE IF NOT EXISTS validation_milestones (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    track_id     INTEGER NOT NULL,
    checkpoint   TEXT NOT NULL,
    target_date  TEXT NOT NULL,
    actual_date  TEXT,
    price        REAL,
    pnl_pct      REAL,
    pnl_sar      REAL,
    drawdown_pct REAL,
    peak_pct     REAL,
    status       TEXT DEFAULT 'pending',
    recorded_at  TEXT,
    UNIQUE(track_id, checkpoint)
  );
`);

export const dbTracked = {
  insert(data) {
    const r = db.prepare(`INSERT INTO tracked_opportunities
      (sym,name,signal_type,conviction,tracked_at,entry_price,simulated_capital,shares,stop,target1,target2,atr_pct,
       rsi,mfi,whale_score,vol_ratio,obv_trend,divergence,weekly_trend,market_regime,score,max_score,rs_score,signals_json,
       status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'tracking',?,?)`)
      .run(data.sym,data.name??'',data.signal_type,data.conviction??null,
           data.tracked_at,data.entry_price,data.simulated_capital??20000,data.shares??null,
           data.stop??null,data.target1??null,data.target2??null,data.atr_pct??null,
           data.rsi??null,data.mfi??null,data.whale_score??null,data.vol_ratio??null,
           data.obv_trend??null,data.divergence??null,data.weekly_trend??null,data.market_regime??null,
           data.score??null,data.max_score??null,data.rs_score??null,
           data.signals_json??null,data.tracked_at,data.tracked_at);
    return r.lastInsertRowid;
  },
  getAll() {
    return db.prepare('SELECT * FROM tracked_opportunities ORDER BY created_at DESC').all();
  },
  get(id) {
    return db.prepare('SELECT * FROM tracked_opportunities WHERE id=?').get(id);
  },
  updateExcursion(id, mae, mfe) {
    db.prepare('UPDATE tracked_opportunities SET mae=MIN(mae,?),mfe=MAX(mfe,?),updated_at=? WHERE id=?')
      .run(mae, mfe, new Date().toISOString(), id);
  },
  close(id, status, exitPrice, exitDate) {
    db.prepare('UPDATE tracked_opportunities SET status=?,exit_price=?,exit_date=?,exit_reason=?,updated_at=? WHERE id=?')
      .run(status, exitPrice??null, exitDate??new Date().toISOString().slice(0,10), status, new Date().toISOString(), id);
  },
  addNote(id, note) {
    db.prepare('UPDATE tracked_opportunities SET notes=?,updated_at=? WHERE id=?')
      .run(note, new Date().toISOString(), id);
  },
  delete(id) {
    db.prepare('DELETE FROM validation_milestones WHERE track_id=?').run(id);
    db.prepare('DELETE FROM tracked_opportunities WHERE id=?').run(id);
  },
};

export const dbMilestones = {
  insert(data) {
    db.prepare(`INSERT OR IGNORE INTO validation_milestones (track_id,checkpoint,target_date,status)
      VALUES (?,?,?,'pending')`).run(data.track_id, data.checkpoint, data.target_date);
  },
  getPending(trackId) {
    return db.prepare("SELECT * FROM validation_milestones WHERE track_id=? AND status='pending' ORDER BY target_date")
      .all(trackId);
  },
  getAll(trackId) {
    return db.prepare('SELECT * FROM validation_milestones WHERE track_id=? ORDER BY target_date')
      .all(trackId);
  },
  update(trackId, checkpoint, data) {
    db.prepare(`UPDATE validation_milestones SET actual_date=?,price=?,pnl_pct=?,pnl_sar=?,
      drawdown_pct=?,peak_pct=?,status=?,recorded_at=? WHERE track_id=? AND checkpoint=?`)
      .run(data.actual_date,data.price,data.pnl_pct,data.pnl_sar,data.drawdown_pct,
           data.peak_pct,data.status,data.recorded_at??new Date().toISOString(),
           trackId, checkpoint);
  },
  getAllForTracks(ids) {
    if (!ids.length) return [];
    return db.prepare(`SELECT * FROM validation_milestones WHERE track_id IN (${ids.map(()=>'?').join(',')})`)
      .all(...ids);
  },
};

// ── Goals profile ─────────────────────────────────────────────────────────────
const DEFAULT_GOAL_PROFILE = {
  goal_name: 'My Trading Goal',
  capital_sar: 100000,
  target_return_pct: 15,
  horizon_months: 12,
  max_drawdown_pct: 10,
  zakat_pct: 2.5,
  risk_per_trade_pct: 1.5,
  max_open_positions: 5,
  preferred_markets: ['tasi'],
  excluded_sectors: [],
  sharia_required: false,
  style_preference: ['Momentum', 'Trend'],
  goal_start_date: null,
  notes: '',
};

function getGoalMeta(key) {
  const row = db.prepare('SELECT value FROM goals_profile WHERE key=?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setGoalMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO goals_profile (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
}

export const goalsProfile = {
  get() {
    const profile = { ...DEFAULT_GOAL_PROFILE };
    for (const key of Object.keys(DEFAULT_GOAL_PROFILE)) {
      const v = getGoalMeta(key);
      if (v !== undefined) profile[key] = v;
    }
    return profile;
  },
  save(updates) {
    for (const [key, value] of Object.entries(updates)) {
      setGoalMeta(key, value);
    }
  },
};

// ── Multi-asset allocation policy ─────────────────────────────────────────────
// Mirrors goalsProfile: a key/value meta store backing a single policy object
// { weights, values, cadence }. Default weights come from allocation.mjs.
const DEFAULT_ALLOCATION = {
  weights: { ...DEFAULT_WEIGHTS },
  values: {},
  cadence: 'quarterly',
};

function getAllocMeta(key) {
  const row = db.prepare('SELECT value FROM allocation_policy WHERE key=?').get(key);
  if (!row) return undefined;
  try { return JSON.parse(row.value); } catch { return row.value; }
}

function setAllocMeta(key, value) {
  db.prepare('INSERT OR REPLACE INTO allocation_policy (key, value) VALUES (?,?)').run(key, JSON.stringify(value));
}

export const allocationPolicy = {
  get() {
    const policy = {
      weights: { ...DEFAULT_ALLOCATION.weights },
      values: { ...DEFAULT_ALLOCATION.values },
      cadence: DEFAULT_ALLOCATION.cadence,
    };
    for (const key of Object.keys(DEFAULT_ALLOCATION)) {
      const v = getAllocMeta(key);
      if (v !== undefined) policy[key] = v;
    }
    return policy;
  },
  // Shallow-merge a patch ({ weights?, values?, cadence? }) and persist each key.
  set(patch = {}) {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      setAllocMeta(key, value);
    }
    return this.get();
  },
};

// ── Accuracy lab ──────────────────────────────────────────────────────────────
export const accuracyLab = {
  log({ sym, name, price_entry, price_stop, price_t1, price_t2, bias, score, max_score,
        composite, scan_mode, style_tags, market, sector, hurst, atr_rank, rsi_entry,
        vol_ratio_entry, regime, market_index }) {
    const logged_at = new Date().toISOString().split('T')[0];
    // Prevent duplicate for same sym on same day with same bias direction
    const exists = db.prepare('SELECT id FROM accuracy_signals WHERE sym=? AND logged_at=? AND outcome IS NULL').get(sym, logged_at);
    if (exists) return exists.id;
    const result = db.prepare(`
      INSERT INTO accuracy_signals
      (sym,name,logged_at,price_entry,price_stop,price_t1,price_t2,bias,score,max_score,
       composite,scan_mode,style_tags,market,sector,hurst,atr_rank,rsi_entry,vol_ratio_entry,
       regime,market_index)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(sym, name||sym, logged_at, price_entry, price_stop, price_t1, price_t2, bias, score,
           max_score, composite, scan_mode, JSON.stringify(style_tags||[]), market||null, sector||null,
           hurst||null, atr_rank||null, rsi_entry||null, vol_ratio_entry||null,
           regime||null, market_index||null);
    return result.lastInsertRowid;
  },

  updateOutcome(id, { outcome, price_outcome, r_multiple }) {
    const today = new Date().toISOString().split('T')[0];
    const sig = db.prepare('SELECT * FROM accuracy_signals WHERE id=?').get(id);
    if (!sig) return;
    const days = sig.logged_at
      ? Math.round((new Date(today) - new Date(sig.logged_at)) / 86400000)
      : null;
    db.prepare(`UPDATE accuracy_signals SET outcome=?,price_outcome=?,outcome_at=?,days_to_outcome=?,r_multiple=? WHERE id=?`)
      .run(outcome, price_outcome, today, days, r_multiple, id);
  },

  checkAndExpire() {
    // Expire signals older than 10 trading days with no outcome
    // Rough: 14 calendar days ≈ 10 trading days
    const cutoff = new Date(Date.now() - 14 * 86400000).toISOString().split('T')[0];
    const stale = db.prepare("SELECT * FROM accuracy_signals WHERE outcome IS NULL AND logged_at < ?").all(cutoff);
    for (const sig of stale) {
      db.prepare("UPDATE accuracy_signals SET outcome='expired',outcome_at=? WHERE id=?")
        .run(new Date().toISOString().split('T')[0], sig.id);
    }
    return stale.length;
  },

  // Direction is derived from the entry/stop geometry, NOT the (possibly re-labeled)
  // bias string — a long has stop < entry, a short has stop > entry. R is signed so
  // a stop is always negative and a target always positive, for both directions.
  checkPriceOutcomes(scanResults) {
    const active = db.prepare("SELECT * FROM accuracy_signals WHERE outcome IS NULL").all();
    for (const sig of active) {
      const r = scanResults.find(x => x.sym === sig.sym);
      if (!r?.price) continue;
      const price = r.price;
      if (!sig.price_entry || !sig.price_stop) continue;
      const isLong = sig.price_stop < sig.price_entry;
      const dir    = isLong ? 1 : -1;
      const risk   = Math.abs(sig.price_entry - sig.price_stop);
      const rAt    = (p) => risk ? +((dir * (p - sig.price_entry)) / risk).toFixed(2) : (dir * (p - sig.price_entry) >= 0 ? 1 : -1);
      const atStop = isLong ? price <= sig.price_stop : price >= sig.price_stop;
      const atT2   = isLong ? price >= sig.price_t2  : price <= sig.price_t2;
      const atT1   = isLong ? price >= sig.price_t1  : price <= sig.price_t1;
      if (sig.price_stop && atStop) {
        this.updateOutcome(sig.id, { outcome: 'stop', price_outcome: price, r_multiple: rAt(price) });
      } else if (sig.price_t2 && atT2) {
        this.updateOutcome(sig.id, { outcome: 't2', price_outcome: price, r_multiple: rAt(price) });
      } else if (sig.price_t1 && atT1) {
        this.updateOutcome(sig.id, { outcome: 't1', price_outcome: price, r_multiple: rAt(price) });
      }
    }
  },

  getAll({ limit = 100, outcome = null } = {}) {
    const where = outcome ? `WHERE outcome='${outcome}'` : '';
    return db.prepare(`SELECT * FROM accuracy_signals ${where} ORDER BY logged_at DESC LIMIT ?`).all(limit);
  },

  getActive() {
    return db.prepare("SELECT * FROM accuracy_signals WHERE outcome IS NULL ORDER BY logged_at DESC").all();
  },

  getStats() {
    const all = db.prepare("SELECT * FROM accuracy_signals WHERE outcome IS NOT NULL AND outcome != 'expired'").all();
    if (!all.length) return { total: 0, t1_rate: 0, t2_rate: 0, stop_rate: 0, avg_r: 0, expectancy: 0 };
    const t1  = all.filter(s => s.outcome === 't1' || s.outcome === 't2').length;
    const t2  = all.filter(s => s.outcome === 't2').length;
    const stops = all.filter(s => s.outcome === 'stop').length;
    const rs  = all.map(s => s.r_multiple).filter(r => r != null);
    const avg_r = rs.length ? +(rs.reduce((a,b)=>a+b,0)/rs.length).toFixed(2) : 0;
    return {
      total:     all.length,
      active:    db.prepare("SELECT COUNT(*) as n FROM accuracy_signals WHERE outcome IS NULL").get().n,
      expired:   db.prepare("SELECT COUNT(*) as n FROM accuracy_signals WHERE outcome='expired'").get().n,
      t1_rate:   all.length ? Math.round(t1/all.length*100) : 0,
      t2_rate:   all.length ? Math.round(t2/all.length*100) : 0,
      stop_rate: all.length ? Math.round(stops/all.length*100) : 0,
      avg_r,
      expectancy: +(avg_r).toFixed(2),
    };
  },

  getInsights() {
    const completed = db.prepare("SELECT * FROM accuracy_signals WHERE outcome IN ('t1','t2','stop')").all();
    if (completed.length < 5) return [];
    const groups = {};
    for (const s of completed) {
      const tags = JSON.parse(s.style_tags||'[]');
      const styleKey = tags[0] || 'Unknown';
      const mktKey   = s.market || 'unknown';
      const key      = `${styleKey}__${mktKey}`;
      if (!groups[key]) groups[key] = { key, style: styleKey, market: mktKey, signals: [] };
      groups[key].signals.push(s);
    }
    return Object.values(groups)
      .filter(g => g.signals.length >= 3)
      .map(g => {
        const t1  = g.signals.filter(s => s.outcome==='t1'||s.outcome==='t2').length;
        const rs  = g.signals.map(s=>s.r_multiple).filter(r=>r!=null);
        const avgR= rs.length ? +(rs.reduce((a,b)=>a+b,0)/rs.length).toFixed(2) : 0;
        return {
          style: g.style, market: g.market, count: g.signals.length,
          t1_rate: Math.round(t1/g.signals.length*100), avg_r: avgR,
          expectancy: avgR,
          rating: t1/g.signals.length >= 0.7 && avgR >= 1 ? 'strong'
                : t1/g.signals.length >= 0.5 ? 'moderate' : 'weak',
        };
      })
      .sort((a,b) => b.expectancy - a.expectancy);
  },

  manualLog({ sym, name, price_entry, price_stop, price_t1, price_t2, bias, notes }) {
    return this.log({ sym, name, price_entry, price_stop, price_t1, price_t2, bias, notes });
  },

  delete(id) {
    db.prepare('DELETE FROM accuracy_signals WHERE id=?').run(id);
  },

  clearAll() {
    const n = db.prepare('SELECT COUNT(*) as n FROM accuracy_signals').get().n;
    db.prepare('DELETE FROM accuracy_signals').run();
    return n;
  },

  // ── Kelly position sizing ─────────────────────────────────────────────────
  // Returns win-rate statistics and Kelly fraction for a given market+style combination.
  // Uses JSON double-quote matching for style_tags stored as JSON.stringify arrays.
  winRateFor(market, primaryStyleTag) {
    const tag = primaryStyleTag || 'Unknown';
    const rows = db.prepare(`
      SELECT outcome, r_multiple FROM accuracy_signals
      WHERE outcome IN ('t1','t2','stop')
        AND market = ?
        AND style_tags LIKE ?
      ORDER BY logged_at DESC LIMIT 50
    `).all(market, `%"${tag}"%`);

    if (rows.length < 5) return null;

    const wins  = rows.filter(r => r.outcome === 't1' || r.outcome === 't2');
    const stops = rows.filter(r => r.outcome === 'stop');
    const win_rate = wins.length / rows.length;

    const avgWinR  = wins.length  ? wins.reduce((a, r)  => a + (r.r_multiple ?? 1), 0) / wins.length   : 1;
    const avgLossR = stops.length ? Math.abs(stops.reduce((a, r) => a + (r.r_multiple ?? -1), 0) / stops.length) : 1;

    if (avgWinR <= 0 || avgLossR <= 0) return null;

    const R = avgWinR / avgLossR;
    const kelly_full = Math.max(0, win_rate - (1 - win_rate) / R);
    const kelly_half = Math.min(0.20, kelly_full * 0.5); // capped at 20%

    const expectancy = +(win_rate * avgWinR - (1 - win_rate) * avgLossR).toFixed(2);
    const confidence = rows.length >= 20 ? 'high' : rows.length >= 10 ? 'moderate' : 'low';

    return {
      sample: rows.length,
      win_rate_pct: +(win_rate * 100).toFixed(1),
      avg_win_r:    +avgWinR.toFixed(2),
      avg_loss_r:   +avgLossR.toFixed(2),
      kelly_full_pct: +(kelly_full * 100).toFixed(1),
      kelly_half_pct: +(kelly_half * 100).toFixed(1),
      expectancy,
      confidence,
    };
  },

  // ── Win-rate breakdown by category (market × style_tag) ───────────────────
  winRateByCategory() {
    const rows = db.prepare(`
      SELECT market, style_tags, outcome, r_multiple
      FROM accuracy_signals
      WHERE outcome IN ('t1','t2','stop')
      ORDER BY logged_at DESC LIMIT 500
    `).all();

    const map = {};
    for (const row of rows) {
      let tags;
      try { tags = JSON.parse(row.style_tags || '[]'); } catch { tags = []; }
      const tag = tags[0] || 'Unknown';
      const key = `${row.market || 'unknown'}__${tag}`;
      if (!map[key]) map[key] = { market: row.market || 'unknown', style: tag, wins: 0, stops: 0, winRs: [], lossRs: [] };
      if (row.outcome === 't1' || row.outcome === 't2') {
        map[key].wins++;
        if (row.r_multiple != null) map[key].winRs.push(row.r_multiple);
      } else {
        map[key].stops++;
        if (row.r_multiple != null) map[key].lossRs.push(Math.abs(row.r_multiple));
      }
    }

    return Object.values(map)
      .filter(g => (g.wins + g.stops) >= 3)
      .map(g => {
        const total    = g.wins + g.stops;
        const win_rate = g.wins / total;
        const avgWinR  = g.winRs.length  ? g.winRs.reduce((a,b)=>a+b,0)  / g.winRs.length  : 1;
        const avgLossR = g.lossRs.length ? g.lossRs.reduce((a,b)=>a+b,0) / g.lossRs.length : 1;
        const expectancy = +(win_rate * avgWinR - (1 - win_rate) * avgLossR).toFixed(2);
        const rating   = win_rate >= 0.7 && expectancy >= 1 ? 'strong'
                       : win_rate >= 0.5 && expectancy >= 0 ? 'moderate' : 'weak';
        return {
          market: g.market, style: g.style,
          total, wins: g.wins, stops: g.stops,
          win_rate_pct: +(win_rate * 100).toFixed(1),
          avg_win_r: +avgWinR.toFixed(2), avg_loss_r: +avgLossR.toFixed(2),
          expectancy, rating,
        };
      })
      .sort((a, b) => b.expectancy - a.expectancy);
  },
};

// ── Meta key-value helpers ────────────────────────────────────────────────────
export const metaStore = {
  get(key, fallback = null) {
    const row = db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return row.value; }
  },
  set(key, value) {
    db.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)').run(key, JSON.stringify(value));
  },
};
