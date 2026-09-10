#!/usr/bin/env node
// Trade-plan journal logger — sits between scan-run.js and notify-telegram.js
// in the pipe and records every BUY/SELL signal to a durable JSONL journal,
// without changing what flows downstream.
//
//   node scripts/scan-run.js | node scripts/journal-log.js | node scripts/notify-telegram.js
//
// Every line read from stdin is written to stdout UNCHANGED, so this script
// can be inserted into the existing scan -> notify pipe with zero effect on
// notify-telegram.js. In addition, any line that parses as a valid BUY or
// SELL signal (same required fields as notify-telegram.js expects) is
// appended as one JSON object per line to the journal file. WAIT signals,
// invalid signals and non-JSON lines are passed through but never journaled.
//
// De-duplicates on  symbol + side + bar_time  via a local state file, so
// re-running the scanner over the same bar does not double-log a trade.
//
// Node built-ins only — no npm dependencies. Never sends anything anywhere;
// pure logging. Does not read .env and does not touch Telegram.
//
// Usage:
//   <scan that prints JSON lines> | node scripts/journal-log.js | <next stage>
//   add --dry-run  -> passthrough + print what would be journaled, write nothing
//   add --verbose (-v) -> extra diagnostics on stderr
//
// Exit codes: 0 ok · 2 usage error

import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_JOURNAL_PATH = resolve(PROJECT_ROOT, 'trade-journal.jsonl');
const DEFAULT_STATE_PATH = resolve(SCRIPT_DIR, '.journal-log-state.json');
const STATE_MAX_ENTRIES = 500;

const HELP = `journal-log.js — trade-plan journal logger (Node built-ins only)

  <scan that prints JSON lines> | node scripts/journal-log.js | <next stage>

  Passes every stdin line through to stdout unchanged. Any valid BUY or SELL
  signal line is also appended to the journal file as one JSON object per
  line. WAIT / invalid / non-JSON lines are passed through but not journaled.

  --dry-run          Passthrough as normal, but only print what would be
                      journaled (stderr) — do not write the journal or state.
  --verbose, -v       Extra diagnostics on stderr.
  --journal <path>    Override journal file (default: <project root>/trade-journal.jsonl).
  --state <path>      Override dedupe state file (default: scripts/.journal-log-state.json).
  --help, -h          This help.

Dedupe key = symbol + side + bar_time. Only BUY/SELL signals are journaled.`;

// ── arg parsing ───────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    dryRun: false, verbose: false, help: false,
    journalPath: DEFAULT_JOURNAL_PATH, statePath: DEFAULT_STATE_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') a.verbose = true;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg === '--journal') a.journalPath = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--state') a.statePath = resolve(process.cwd(), argv[++i] ?? '');
    else { console.error(`journal-log: unknown argument "${arg}" (try --help)`); process.exit(2); }
  }
  return a;
}

// ── shared helpers (mirrors notify-telegram.js conventions) ───────
function normSide(side) {
  const s = String(side ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'BUY';
  if (s === 'SELL' || s === 'SHORT') return 'SELL';
  return s;
}

function reasonsToLines(reasons) {
  if (Array.isArray(reasons)) return reasons.map((r) => String(r).trim()).filter(Boolean);
  if (typeof reasons === 'string') {
    return reasons.split(/\r?\n|\s*[|•]\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function rrValue(sig) {
  const cand = sig.rr_text ?? sig.risk_reward ?? sig.rr;
  return cand === undefined || cand === null || cand === '' ? null : cand;
}

const REQUIRED_FIELDS = ['symbol', 'side', 'entry', 'stop', 'target', 'bar_time', 'reasons'];

function validateSignal(sig) {
  if (typeof sig !== 'object' || sig === null || Array.isArray(sig)) return ['not a JSON object'];
  const errs = [];
  for (const f of REQUIRED_FIELDS) {
    if (sig[f] === undefined || sig[f] === null || sig[f] === '') errs.push(`missing "${f}"`);
  }
  if (rrValue(sig) === null) errs.push('missing "rr" / "rr_text" / "risk_reward"');
  if (reasonsToLines(sig.reasons).length === 0) errs.push('"reasons" is empty');
  return errs;
}

function dedupeKey(sig) {
  return `${String(sig.symbol).trim().toUpperCase()}|${normSide(sig.side)}|${String(sig.bar_time).trim()}`;
}

// ── state file (dedupe only — separate from the journal itself) ──
function loadState(path) {
  try {
    if (!existsSync(path)) return { version: 1, logged: {} };
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s && typeof s === 'object' && s.logged && typeof s.logged === 'object') return { version: 1, logged: s.logged };
  } catch { /* corrupt or unreadable — start fresh */ }
  return { version: 1, logged: {} };
}

function saveState(path, state) {
  const keys = Object.keys(state.logged);
  if (keys.length > STATE_MAX_ENTRIES) {
    keys.sort((a, b) => String(state.logged[a].at || '').localeCompare(String(state.logged[b].at || '')));
    for (const k of keys.slice(0, keys.length - STATE_MAX_ENTRIES)) delete state.logged[k];
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// ── journal record ─────────────────────────────────────────────
function buildJournalRecord(sig) {
  const side = normSide(sig.side);
  return {
    symbol: sig.symbol,
    side,
    entry: sig.entry,
    stop: sig.stop,
    target: sig.target,
    rr: sig.rr ?? null,
    rr_text: sig.rr_text ?? (rrValue(sig) != null ? String(rrValue(sig)) : null),
    bar_time: sig.bar_time,
    scan_time: sig.scan_time ?? null,
    reasons: reasonsToLines(sig.reasons),
    logged_at: new Date().toISOString(),
  };
}

// ── per-line handling ───────────────────────────────────────────
function handleLine(line, args, state) {
  const t = line.trim();
  if (!t || t.startsWith('#')) return;

  let sig;
  try { sig = JSON.parse(t); }
  catch { if (args.verbose) console.error(`journal-log: skip non-JSON line: ${t.slice(0, 120)}`); return; }

  const side = normSide(sig && sig.side);
  if (side !== 'BUY' && side !== 'SELL') {
    if (args.verbose) console.error(`journal-log: skip ${side || '(no side)'} — only BUY/SELL are journaled`);
    return;
  }

  const errs = validateSignal(sig);
  if (errs.length) {
    console.error(`journal-log: skip ${sig.symbol || '(no symbol)'}: invalid signal — ${errs.join('; ')}`);
    return;
  }

  const key = dedupeKey(sig);
  if (state.logged[key]) {
    if (args.verbose) console.error(`journal-log: skip — already journaled ${key} at ${state.logged[key].at}`);
    return;
  }

  const record = buildJournalRecord(sig);

  if (args.dryRun) {
    console.error(`[dry-run] would append to ${args.journalPath}:\n${JSON.stringify(record)}\n`);
    return;
  }

  appendFileSync(args.journalPath, JSON.stringify(record) + '\n');
  state.logged[key] = { at: record.logged_at, symbol: record.symbol, side, bar_time: String(sig.bar_time) };
  saveState(args.statePath, state);
  if (args.verbose) console.error(`journal-log: logged ${side} ${sig.symbol} (${key})`);
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  if (process.stdin.isTTY) {
    console.error('journal-log: nothing to do. Pipe JSON signal lines on stdin (see --help).');
    process.exit(2);
  }

  const state = loadState(args.statePath);
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    process.stdout.write(line + '\n');
    handleLine(line, args, state);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(`journal-log: fatal — ${e && e.message ? e.message : e}`);
  process.exit(1);
});
