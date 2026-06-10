#!/usr/bin/env node
/**
 * push_liquidity_map.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads daily_context.json and pushes updated liquidity map levels to the
 * "HMM Liquidity Map Levels" Pine indicator on every TradingView chart tab.
 *
 * Scans ALL CDP chart targets so it works regardless of which tab is active
 * or how many windows are open.
 *
 * Usage:
 *   node scripts/push_liquidity_map.js [/path/to/daily_context.json]
 *
 * Called automatically by tv_liquidity_push.py (Python) after the
 * daily_context_generator regenerates the context each morning.
 */

import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const INDICATOR_NAME = 'HMM Liquidity Map Levels';
const CATALYST_OFFSET = 40.0;

// ── Pine input option maps ────────────────────────────────────────────────────
const BIAS_OPTIONS = new Set([
  'Bullish Above Pivot', 'Bearish Below Pivot', 'Balanced At Pivot', 'Near Pivot',
]);
const DAY_TYPE_OPTIONS = new Set([
  'Expansion', 'Mean Reversion', 'Trending', 'Breakout', 'Choppy',
]);

// ── Build inputs object from daily_context ────────────────────────────────────
function buildInputs(ctx) {
  const mhp      = parseFloat(ctx.mhp ?? 0);
  const upper    = ctx.upper_zone ?? {};
  const lower    = ctx.lower_zone ?? {};
  let   dayType  = ctx.day_type  ?? 'Mean Reversion';
  let   bias     = ctx.bias_state ?? 'Balanced At Pivot';

  if (!DAY_TYPE_OPTIONS.has(dayType)) dayType = 'Mean Reversion';
  if (!BIAS_OPTIONS.has(bias))        bias    = 'Balanced At Pivot';

  return {
    in_0:  mhp,
    in_1:  parseFloat(upper.low  ?? 0),   // Bear Zone Low
    in_2:  parseFloat(upper.mid  ?? 0),   // Bear Zone Mid
    in_3:  parseFloat(upper.high ?? 0),   // Bear Zone High
    in_4:  parseFloat(lower.low  ?? 0),   // Bull Zone Low
    in_5:  parseFloat(lower.mid  ?? 0),   // Bull Zone Mid
    in_6:  parseFloat(lower.high ?? 0),   // Bull Zone High
    in_7:  dayType,                        // Day Type dropdown
    in_8:  bias,                           // Bias dropdown
    in_10: Math.round((mhp + CATALYST_OFFSET) * 100) / 100,  // Cat Upper
    in_11: Math.round((mhp - CATALYST_OFFSET) * 100) / 100,  // Cat Lower
  };
}

// ── Set indicator inputs on a single CDP target ───────────────────────────────
async function updateTarget(targetId, inputs) {
  const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
  try {
    await client.Runtime.enable();

    // Search all chart widgets in this target for the HMM Liquidity Map indicator
    const studyListResult = await client.Runtime.evaluate({
      expression: `(function() {
        try {
          // Try all chart widgets in the layout, not just the active one
          var collection = window.TradingViewApi._chartWidgetCollection;
          var charts = [];
          if (collection) {
            try {
              var wc = collection._widgets || collection._chartWidgets || [];
              for (var w of wc) {
                try { charts.push(w.value ? w.value() : w); } catch(e) {}
              }
            } catch(e) {}
          }
          // Always include the active chart
          try {
            var active = window.TradingViewApi._activeChartWidgetWV.value();
            if (active) charts.push(active);
          } catch(e) {}

          for (var chart of charts) {
            try {
              var studies = chart.getAllStudies();
              var match = studies.find(function(s) {
                return s.name && s.name.indexOf('HMM Liquidity Map') !== -1;
              });
              if (match) return { found: true, entity_id: match.id };
            } catch(e) {}
          }
          return { found: false };
        } catch(e) { return { found: false, error: e.message }; }
      })()`,
      returnByValue: true,
    });

    const findResult = studyListResult.result?.value;
    if (!findResult?.found) return { updated: false, reason: findResult?.error ?? 'indicator not on this tab' };

    const match = findResult;
    if (!match) return { updated: false, reason: 'indicator not on this tab' };

    const entityId = match.entity_id;
    const inputsJson = JSON.stringify(inputs);

    const setResult = await client.Runtime.evaluate({
      expression: `(function() {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        var study = chart.getStudyById('${entityId.replace(/'/g, "\\'")}');
        if (!study) return { error: 'study not found after ID lookup' };
        var current = study.getInputValues();
        var overrides = ${inputsJson};
        var updated = {};
        for (var i = 0; i < current.length; i++) {
          if (overrides.hasOwnProperty(current[i].id)) {
            current[i].value = overrides[current[i].id];
            updated[current[i].id] = overrides[current[i].id];
          }
        }
        study.setInputValues(current);
        return { updated_inputs: updated };
      })()`,
      returnByValue: true,
    });

    const setVal = setResult.result?.value;
    if (setVal?.error) return { updated: false, reason: setVal.error };
    return { updated: true, entity_id: entityId, updated_inputs: setVal?.updated_inputs ?? {} };

  } finally {
    await client.close().catch(() => {});
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  // Load context file
  const ctxPath = process.argv[2]
    ?? resolve(__dirname, '../../hmm_mnq/data/daily_context.json');

  let ctx;
  try {
    ctx = JSON.parse(readFileSync(ctxPath, 'utf8'));
  } catch (e) {
    console.error(`❌  Cannot read ${ctxPath}: ${e.message}`);
    process.exit(1);
  }

  const inputs = buildInputs(ctx);
  console.log(`📊  MHP=${ctx.mhp}  Bear=${ctx.upper_zone?.low}–${ctx.upper_zone?.high}  Bull=${ctx.lower_zone?.low}–${ctx.lower_zone?.high}  [${ctx.day_type} / ${ctx.bias_state}]`);

  // Get all chart targets
  let targets;
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    targets = await resp.json();
  } catch (e) {
    console.error(`❌  CDP connection failed: ${e.message}`);
    process.exit(2);
  }

  const chartTargets = targets.filter(
    t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
  );

  if (chartTargets.length === 0) {
    console.error('❌  No TradingView chart tabs found. Is TradingView running?');
    process.exit(2);
  }

  // Deduplicate by URL (same layout may appear in multiple targets)
  const seen = new Set();
  const uniqueTargets = chartTargets.filter(t => {
    if (seen.has(t.url)) return false;
    seen.add(t.url);
    return true;
  });

  console.log(`🔍  Scanning ${uniqueTargets.length} unique chart tab(s)…`);

  let anyUpdated = false;
  for (const target of uniqueTargets) {
    const chartId = target.url.match(/\/chart\/([^/?]+)/)?.[1] ?? target.id.slice(0, 8);
    try {
      const result = await updateTarget(target.id, inputs);
      if (result.updated) {
        console.log(`  ✅  ${chartId}  — updated (entity: ${result.entity_id})`);
        anyUpdated = true;
      } else {
        console.log(`  ⏭   ${chartId}  — ${result.reason}`);
      }
    } catch (e) {
      console.error(`  ❌  ${chartId}  — ${e.message}`);
    }
  }

  if (anyUpdated) {
    console.log('✅  Liquidity map updated successfully');
  } else {
    console.log('⚠️  HMM Liquidity Map Levels indicator was not found on any tab');
    process.exit(1);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
