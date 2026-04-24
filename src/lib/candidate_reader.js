/**
 * Reads coiled_spring_results.json and returns a normalized top-N list of
 * candidates that have an actionable alert trigger.
 *
 * Entries with entry_trigger like "no entry" (the scanner's "extended" verdict)
 * are filtered out — there's no trigger price to watch.
 */

import fs from 'node:fs';

const ALERT_RX = /alert\s+at\s+([\d.]+)/i;

function parseTrigger(text) {
  const m = (text || '').match(ALERT_RX);
  return m ? parseFloat(m[1]) : null;
}

export function readCandidates(resultsPath, { topN = 15 } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(resultsPath, 'utf8');
  } catch {
    return { candidates: [], error: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { candidates: [], error: 'parse' };
  }
  const list = parsed.results || parsed.top_15 || parsed.top || [];
  const out = [];
  for (const row of list) {
    const trigger = parseTrigger(row.entry_trigger);
    if (trigger == null || trigger <= 0) continue;
    out.push({
      symbol: row.symbol || row.ticker,
      trigger,
      triggerText: row.entry_trigger,
      confidence: String(row.composite_confidence || row.setup_quality || 'UNKNOWN').toUpperCase(),
      setupType: row.setup_type || 'unknown',
      rank: row.rank ?? null,
      confidenceBand: row.confidence_band || null,
      probabilityScore: row.probability_score ?? null,
    });
    if (out.length >= topN) break;
  }
  return { scanRunId: parsed.generated_at || parsed.generatedAt || null, candidates: out };
}
