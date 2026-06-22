/**
 * Honesty guard — the dead 9-pt score must never be framed as a buy signal in
 * user-facing copy. Twice the framing crept back (whale cull, first sweep), so
 * this test fails the build if banned buy-advice phrases reappear.
 *
 * Standard: the score is DESCRIPTIVE trend-state context, NOT advice. The only
 * validated buy-list is the Momentum tab. See memory edge_validation_findings.
 *
 * Run: node --test tests/honesty.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const ASSETS = join(ROOT, 'dashboard', 'assets');

// Banned buy-advice phrasing for the 9-pt score (case-insensitive).
const BANNED = [
  /high(?:est)?[-\s]?conviction/i,
  /priority entr/i,
  /strong opportunit/i,
  /\btop pick/i,
  /justify (?:new )?entr/i,
  /\bbuy now\b/i,
  /conviction (?:long|buy|entry)/i,
  /\bTop Setups\b/,
];

// A line is EXCUSED if it carries the honest reframe context, or is a code
// comment, or is the deliberately-kept cautionary sell side.
const EXCUSE = [
  /trend[-\s]?state/i, /descriptive/i, /not a buy/i, /momentum tab/i,
  /lagged/i, /negative signal/i, /don't buy/i,
];
const isComment = (l) => {
  const t = l.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

function scanFile(abs, rel) {
  const lines = readFileSync(abs, 'utf8').split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    if (isComment(line)) return;
    if (EXCUSE.some((rx) => rx.test(line))) return;
    for (const rx of BANNED) {
      if (rx.test(line)) {
        hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
        break;
      }
    }
  });
  return hits;
}

function targetFiles() {
  const files = [join(ROOT, 'dashboard', 'index.html')];
  for (const f of readdirSync(ASSETS)) {
    if (f.endsWith('.js') || f.endsWith('.html')) files.push(join(ASSETS, f));
  }
  return files;
}

describe('honesty guard — no buy-advice framing of the 9-pt score', () => {
  it('finds zero banned buy-advice phrases in user-facing dashboard copy', () => {
    const violations = [];
    for (const abs of targetFiles()) {
      const rel = abs.slice(ROOT.length + 1);
      violations.push(...scanFile(abs, rel));
    }
    assert.deepEqual(
      violations,
      [],
      `Banned buy-advice phrasing for the dead 9-pt score (reframe as descriptive ` +
      `trend state; validated buy-list = Momentum tab):\n  ${violations.join('\n  ')}`
    );
  });

  it('summary tiles + their i18n keys use trend-state labels, not Buy/Sell', () => {
    const violations = [];
    // The big summary tiles must not be labelled Buy/Sell — they show the dead
    // score's trend state. Catch both the HTML fallback and the i18n values.
    const html = readFileSync(join(ROOT, 'dashboard', 'index.html'), 'utf8');
    const TILE_LABEL = /data-i18n="(?:strongBuy|buy|strongSell)">\s*(?:Strong )?(?:Buy|Sell)\b/g;
    (html.match(TILE_LABEL) || []).forEach((m) => violations.push(`index.html tile label: ${m}`));

    // The i18n values feeding those keys (en) must be trend-state words.
    const i18n = readFileSync(join(ASSETS, 'app-core-01-i18n-fmt.js'), 'utf8');
    const EN_KEYS = /strongBuy:'([^']*)', buy:'([^']*)', watch:'[^']*', scanned:'[^']*', strongSell:'([^']*)'/;
    const m = i18n.match(EN_KEYS);
    if (m) {
      if (/buy/i.test(m[1])) violations.push(`i18n strongBuy = '${m[1]}' (should be trend-state)`);
      if (/buy/i.test(m[2])) violations.push(`i18n buy = '${m[2]}' (should be trend-state)`);
      if (/sell/i.test(m[3])) violations.push(`i18n strongSell = '${m[3]}' (should be trend-state)`);
    }
    assert.deepEqual(violations, [], `Summary-tile Buy/Sell labels regressed:\n  ${violations.join('\n  ')}`);
  });
});
