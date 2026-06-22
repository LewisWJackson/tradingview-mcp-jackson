/**
 * import_index_events.mjs — ingest harvested MSCI index-review events into index_events.
 * Harvest is agent-assisted (firecrawl over MSCI/Argaam); this loads the saved JSON.
 *
 * Each record needs a 4-digit `code`. If a record has only a `name`, this resolves it
 * via TASI_STOCKS (English name or Arabic). Unresolved names are reported and skipped.
 *
 * Run: node --experimental-sqlite scripts/import_index_events.mjs [path]
 *   default path: data/index_events_harvest.json
 */
import { readFileSync } from 'node:fs';
import { ingestIndexEvents, indexEventsSummary } from '../dashboard/index_events.mjs';
import { TASI_STOCKS } from './tasi_screener.mjs';

// name (lowercased) -> 4-digit code, from the canonical universe map
const NAME2CODE = new Map();
for (const s of TASI_STOCKS) {
  const code = String(s.sym).match(/(\d{4})/)?.[1];
  if (!code) continue;
  NAME2CODE.set(s.name.toLowerCase(), code);
  if (s.ar) NAME2CODE.set(s.ar, code);
}
function resolveCode(rec) {
  if (String(rec.code || '').match(/^\d{4}$/)) return rec.code;
  const n = String(rec.name || '').toLowerCase().trim();
  return NAME2CODE.get(n) || null;
}

const path = process.argv[2] || new URL('../data/index_events_harvest.json', import.meta.url).pathname;
const raw = JSON.parse(readFileSync(path, 'utf8'));

const resolved = [], unresolved = [];
for (const rec of raw) {
  const code = resolveCode(rec);
  if (code) resolved.push({ ...rec, code });
  else unresolved.push(rec.name || rec.code || '(unknown)');
}

const r = ingestIndexEvents(resolved);
console.log('ingest:', JSON.stringify(r));
if (unresolved.length) {
  console.log(`\nUNRESOLVED name→code (${unresolved.length}) — add a 4-digit code manually in the JSON:`);
  for (const u of unresolved) console.log('  -', u);
}
console.log('\ndb summary:', JSON.stringify(indexEventsSummary(), null, 0));
process.exit(0);
