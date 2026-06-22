/**
 * import_filings.mjs — ingest a JSON dump of disclosure events into cma_filings.
 * The dump is produced by a Firecrawl extract of Argaam/Tadawul disclosures
 * (agent runs firecrawl_extract -> save events array -> this script ingests).
 *
 * Run: node scripts/import_filings.mjs [path-to-events.json]
 */
import { readFileSync } from 'node:fs';
import { ingestFilings, filingsSummary } from '../dashboard/filings.mjs';

const path = process.argv[2] || new URL('../dashboard/seed/filings_seed.json', import.meta.url).pathname;
const events = JSON.parse(readFileSync(path, 'utf8'));
const r = ingestFilings(Array.isArray(events) ? events : (events.events || []), 'firecrawl-argaam');
console.log('ingest:', JSON.stringify(r));
console.log('  resolution rate:', (r.resolved / r.events * 100).toFixed(0) + '% of events mapped to a TADAWUL symbol');
console.log('db summary:', JSON.stringify(filingsSummary()));
process.exit(0);
