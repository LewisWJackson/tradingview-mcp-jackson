/**
 * import_catalysts.mjs — ingest harvested Tadawul announcements into catalyst_events.
 * Harvest is via Playwright (the only method that bypasses the Tadawul 403); this
 * script ingests the saved JSON [{code,date,headline}] and classifies each.
 *
 * Run: node scripts/import_catalysts.mjs [path]
 */
import { readFileSync } from 'node:fs';
import { ingestCatalysts, catalystsSummary, classify } from '../dashboard/catalysts.mjs';

const path = process.argv[2] || new URL('../dashboard/seed/catalysts_seed.json', import.meta.url).pathname;
const rows = JSON.parse(readFileSync(path, 'utf8'));
const r = ingestCatalysts(rows, 'tadawul');
console.log('ingest:', JSON.stringify(r));
console.log('classification of this batch:');
for (const e of rows) console.log(`  ${e.code}  ${classify(e.headline).padEnd(14)} ${e.headline.slice(0, 70)}`);
console.log('db summary:', JSON.stringify(catalystsSummary(), null, 0));
process.exit(0);
