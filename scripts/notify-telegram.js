#!/usr/bin/env node
// Standalone Telegram notifier for tradingview-mcp BUY/SELL signals.
// Node built-ins only — no npm dependencies. Fully separate from the MCP server.
//
// Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .env (project root).
//   - Sends ONLY BUY / SELL signals. WAIT (or anything else) is ignored.
//   - Message carries symbol, side, entry, stop, target, R/R and reasons.
//   - De-duplicates on  symbol + side + bar_time  via a local state file,
//     so the same signal is never sent twice.
//   - Never prints the bot token (redacted from every log line and error).
//
// Usage:
//   node scripts/notify-telegram.js --test                # send a labelled TEST message
//   node scripts/notify-telegram.js --signal '<json>'     # process one signal object
//   <scan that prints JSON lines> | node scripts/notify-telegram.js
//   add --dry-run to any of the above  -> validate + format, but do NOT send
//   add --verbose (-v)                 -> extra diagnostics on stderr
//
// Signal object (one compact JSON object per stdin line, or via --signal):
//   {
//     "symbol":   "NSE:RELIANCE1!",
//     "side":     "BUY" | "SELL" | "WAIT",
//     "entry":    1316.6,
//     "stop":     1308.4,
//     "target":   1333.0,
//     "rr":       2.0,                 // or "rr_text": "1:2.0"
//     "bar_time": 1788434100,          // unix seconds — part of the dedupe key
//     "reasons":  ["...", "..."],      // array or string
//     "scan_time":"14:35 IST"          // optional, display only
//   }
//
// Exit codes: 0 ok (sent, or deliberately not sent) · 1 send/network failure
//             2 usage error · 3 invalid signal · 4 missing credentials

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import https from 'node:https';
import { createInterface } from 'node:readline';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_ENV_PATH = resolve(PROJECT_ROOT, '.env');
const DEFAULT_STATE_PATH = resolve(SCRIPT_DIR, '.notify-telegram-state.json');
const STATE_MAX_ENTRIES = 500;
const TELEGRAM_TIMEOUT_MS = 15000;

const HELP = `notify-telegram.js — standalone Telegram BUY/SELL notifier (Node built-ins only)

  --test              Send a clearly labelled TEST message and exit.
  --signal '<json>'   Process exactly one signal object given as JSON.
  (no args)           Read newline-delimited JSON signal objects from stdin.
  --dry-run           Validate + format, print what would be sent, but do NOT send.
  --verbose, -v       Extra diagnostics on stderr.
  --env <path>        Override .env location (default: <project root>/.env).
  --state <path>      Override dedupe state file (default: scripts/.notify-telegram-state.json).
  --help, -h          This help.

Credentials come from .env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
(shell environment variables of the same name take precedence if set).
Only side "BUY" or "SELL" is ever sent. Dedupe key = symbol + side + bar_time.`;

// ── arg parsing ───────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    test: false, dryRun: false, verbose: false, help: false,
    signal: null, envPath: DEFAULT_ENV_PATH, statePath: DEFAULT_STATE_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--test') a.test = true;
    else if (arg === '--dry-run') a.dryRun = true;
    else if (arg === '--verbose' || arg === '-v') a.verbose = true;
    else if (arg === '--help' || arg === '-h') a.help = true;
    else if (arg === '--signal') a.signal = argv[++i] ?? '';
    else if (arg === '--env') a.envPath = resolve(process.cwd(), argv[++i] ?? '');
    else if (arg === '--state') a.statePath = resolve(process.cwd(), argv[++i] ?? '');
    else { console.error(`notify-telegram: unknown argument "${arg}" (try --help)`); process.exit(2); }
  }
  return a;
}

// ── .env parsing (tiny, dependency-free) ──────────────────────────
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let val = m[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[m[1]] = val;
  }
  return out;
}

function loadConfig(envPath) {
  const fromFile = parseEnvFile(envPath);
  // Shell env wins over the file so a value can be supplied without writing it to disk.
  const token = String(process.env.TELEGRAM_BOT_TOKEN ?? fromFile.TELEGRAM_BOT_TOKEN ?? '').trim();
  const chatId = String(process.env.TELEGRAM_CHAT_ID ?? fromFile.TELEGRAM_CHAT_ID ?? '').trim();
  return { token, chatId };
}

// ── redaction: the token must never reach a log line ──────────────
function makeRedactor(token) {
  return (s) => {
    let str = String(s);
    if (token && token.length >= 6) str = str.split(token).join('***REDACTED***');
    // also scrub anything token-shaped (bot<digits>:<secret>)
    return str.replace(/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot***REDACTED***');
  };
}

// ── formatting helpers ───────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtNum(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v.toLocaleString('en-US', { maximumFractionDigits: 4 });
  }
  return String(v);
}

function fmtRR(sig) {
  const cand = sig.rr_text ?? sig.risk_reward ?? sig.rr;
  if (cand === undefined || cand === null || cand === '') return null;
  const str = String(cand).trim();
  if (str.includes(':')) return str;              // already "1:2.0"
  const n = Number(str);
  return Number.isFinite(n) ? `1:${n}` : str;
}

function fmtBarTimeDisplay(v) {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) return `${d.toISOString().replace('.000Z', 'Z')} (bar_time ${v})`;
  }
  return String(v);
}

function reasonsToLines(reasons) {
  if (Array.isArray(reasons)) return reasons.map((r) => String(r).trim()).filter(Boolean);
  if (typeof reasons === 'string') {
    return reasons.split(/\r?\n|\s*[|•]\s*/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function normSide(side) {
  const s = String(side ?? '').trim().toUpperCase();
  if (s === 'BUY' || s === 'LONG') return 'BUY';
  if (s === 'SELL' || s === 'SHORT') return 'SELL';
  return s;
}

// ── validation ───────────────────────────────────────────────────
const REQUIRED_FIELDS = ['symbol', 'side', 'entry', 'stop', 'target', 'bar_time', 'reasons'];

function validateSignal(sig) {
  if (typeof sig !== 'object' || sig === null || Array.isArray(sig)) return ['not a JSON object'];
  const errs = [];
  for (const f of REQUIRED_FIELDS) {
    if (sig[f] === undefined || sig[f] === null || sig[f] === '') errs.push(`missing "${f}"`);
  }
  if (fmtRR(sig) === null) errs.push('missing "rr" / "rr_text" / "risk_reward"');
  if (reasonsToLines(sig.reasons).length === 0) errs.push('"reasons" is empty');
  return errs;
}

// ── message builders ─────────────────────────────────────────────
function buildMessage(sig) {
  const side = normSide(sig.side);
  const dot = side === 'BUY' ? '🟢' : '🔴';
  const lines = [`${dot} <b>${escapeHtml(side)} — ${escapeHtml(sig.symbol)}</b>`];
  if (sig.scan_time) lines.push(`Scan: ${escapeHtml(sig.scan_time)}`);
  lines.push(`Entry: <code>${escapeHtml(fmtNum(sig.entry))}</code>`);
  lines.push(`Stop: <code>${escapeHtml(fmtNum(sig.stop))}</code>`);
  lines.push(`Target: <code>${escapeHtml(fmtNum(sig.target))}</code>`);
  lines.push(`R/R: <code>${escapeHtml(fmtRR(sig))}</code>`);
  lines.push(`Bar time: ${escapeHtml(fmtBarTimeDisplay(sig.bar_time))}`);
  lines.push('Reasons:');
  for (const r of reasonsToLines(sig.reasons)) lines.push(`• ${escapeHtml(r)}`);
  return lines.join('\n');
}

function buildTestMessage() {
  return [
    '🧪 <b>TEST MESSAGE — tradingview-mcp Telegram notifier</b>',
    'Connectivity check only. This is NOT a trading signal.',
    `Sent: ${new Date().toISOString().replace('.000Z', 'Z')}`,
    'If you can read this, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set correctly.',
  ].join('\n');
}

// ── dedupe key + state file ──────────────────────────────────────
function dedupeKey(sig) {
  return `${String(sig.symbol).trim().toUpperCase()}|${normSide(sig.side)}|${String(sig.bar_time).trim()}`;
}

function loadState(path) {
  try {
    if (!existsSync(path)) return { version: 1, sent: {} };
    const s = JSON.parse(readFileSync(path, 'utf8'));
    if (s && typeof s === 'object' && s.sent && typeof s.sent === 'object') return { version: 1, sent: s.sent };
  } catch { /* corrupt or unreadable — start fresh */ }
  return { version: 1, sent: {} };
}

function saveState(path, state) {
  const keys = Object.keys(state.sent);
  if (keys.length > STATE_MAX_ENTRIES) {
    keys.sort((a, b) => String(state.sent[a].at || '').localeCompare(String(state.sent[b].at || '')));
    for (const k of keys.slice(0, keys.length - STATE_MAX_ENTRIES)) delete state.sent[k];
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

// ── Telegram send (Node https only) ──────────────────────────────
function telegramSend(text, { token, chatId }) {
  return new Promise((resolveP, rejectP) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        method: 'POST',
        hostname: 'api.telegram.org',
        path: `/bot${token}/sendMessage`,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: TELEGRAM_TIMEOUT_MS,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(body); } catch { /* leave null */ }
          if (res.statusCode >= 200 && res.statusCode < 300 && json && json.ok) {
            resolveP(json.result);
          } else {
            const desc = (json && (json.description || json.error_code)) || `HTTP ${res.statusCode}`;
            rejectP(new Error(`Telegram API error: ${desc}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`Telegram request timed out after ${TELEGRAM_TIMEOUT_MS}ms`)));
    req.on('error', rejectP);
    req.write(payload);
    req.end();
  });
}

// ── per-signal handling ─────────────────────────────────────────
async function handleSignal(sig, cfg, args, state, redact) {
  const side = normSide(sig && sig.side);
  if (side !== 'BUY' && side !== 'SELL') {
    if (args.verbose) console.error(`skip: side="${(sig && sig.side) ?? ''}" (only BUY/SELL are sent)`);
    return 'skipped-side';
  }
  const errs = validateSignal(sig);
  if (errs.length) {
    console.error(`skip ${(sig && sig.symbol) || '(no symbol)'}: invalid signal — ${errs.join('; ')}`);
    return 'invalid';
  }
  const key = dedupeKey(sig);
  if (state.sent[key]) {
    if (args.verbose) console.error(`skip: already sent ${key} at ${state.sent[key].at}`);
    return 'duplicate';
  }
  const text = buildMessage(sig);
  if (args.dryRun) {
    console.error(`[dry-run] would send to chat ${cfg.chatId || '(unset)'}:\n${text}\n`);
    return 'dry-run';
  }
  try {
    await telegramSend(text, cfg);
  } catch (e) {
    console.error(`send failed for ${key}: ${redact(e.message)}`);
    return 'send-failed';
  }
  state.sent[key] = {
    at: new Date().toISOString(),
    symbol: String(sig.symbol),
    side,
    bar_time: String(sig.bar_time),
  };
  saveState(args.statePath, state);
  console.error(`sent: ${side} ${sig.symbol} (${key})`);
  return 'sent';
}

// ── main ────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(HELP); process.exit(0); }

  const cfg = loadConfig(args.envPath);
  const redact = makeRedactor(cfg.token);

  const needCreds = !args.dryRun;
  if (needCreds && (!cfg.token || !cfg.chatId)) {
    console.error('notify-telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set in .env (see .env.example).');
    console.error(`  checked: ${args.envPath}`);
    process.exit(4);
  }

  // TEST MODE
  if (args.test) {
    const text = buildTestMessage();
    if (args.dryRun) {
      console.error(`[dry-run] would send TEST message to chat ${cfg.chatId || '(unset)'}:\n${text}`);
      process.exit(0);
    }
    try {
      await telegramSend(text, cfg);
      console.error('notify-telegram: TEST message sent OK.');
      process.exit(0);
    } catch (e) {
      console.error(`notify-telegram: TEST message FAILED — ${redact(e.message)}`);
      process.exit(1);
    }
  }

  const state = loadState(args.statePath);

  // SINGLE SIGNAL
  if (args.signal !== null) {
    let sig;
    try { sig = JSON.parse(args.signal); }
    catch (e) { console.error(`notify-telegram: --signal is not valid JSON — ${e.message}`); process.exit(3); }
    const r = await handleSignal(sig, cfg, args, state, redact);
    if (r === 'send-failed') process.exit(1);
    if (r === 'invalid') process.exit(3);
    process.exit(0);
  }

  // STDIN STREAM
  if (process.stdin.isTTY) {
    console.error('notify-telegram: nothing to do. Pipe JSON signal lines on stdin, or use --signal / --test / --help.');
    process.exit(2);
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let sent = 0, failed = 0;
  for await (const line of rl) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    let sig;
    try { sig = JSON.parse(t); }
    catch { if (args.verbose) console.error(`skip: non-JSON line: ${t.slice(0, 120)}`); continue; }
    const r = await handleSignal(sig, cfg, args, state, redact);
    if (r === 'sent') sent++;
    else if (r === 'send-failed') failed++;
  }
  console.error(`notify-telegram: done — ${sent} sent, ${failed} failed.`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  const msg = String((e && e.message) || e).replace(/\bbot\d{6,}:[A-Za-z0-9_-]{20,}/g, 'bot***REDACTED***');
  console.error(`notify-telegram: fatal — ${msg}`);
  process.exit(1);
});
