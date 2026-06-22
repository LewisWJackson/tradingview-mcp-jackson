/**
 * rules-engine.js — single source of truth for strategy config
 *
 * All consumers (dashboard, scalper, screener) should import from here
 * instead of reading rules.json directly. This guarantees one parse,
 * consistent helpers, and a single place to change strategy parameters.
 *
 * Usage:
 *   import { getRules, getMarketConfig, getSignalThresholds } from '../src/rules-engine.js';
 */

import { readFileSync, writeFileSync, watchFile } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RULES_PATH = resolve(__dirname, '../rules.json');

let _cache = null;

function load() {
  _cache = JSON.parse(readFileSync(RULES_PATH, 'utf8'));
  return _cache;
}

// Invalidate cache whenever rules.json changes on disk
watchFile(RULES_PATH, { interval: 2000 }, () => { _cache = null; });

/** Returns the full parsed rules.json, cached until file changes. */
export function getRules() {
  return _cache || load();
}

/** Returns the config object for a specific market (e.g. 'CRYPTO_XRP'). */
export function getMarketConfig(market) {
  const r = getRules();
  return r.markets?.[market] ?? null;
}

/** Returns the currently active market key (e.g. 'CRYPTO_XRP'). */
export function getActiveMarket() {
  return getRules().active_market ?? null;
}

/** Returns the config for the currently active market. */
export function getActiveMarketConfig() {
  const key = getActiveMarket();
  return key ? getMarketConfig(key) : null;
}

/**
 * Returns signal thresholds for a market:
 *   { rsiLongMin, rsiLongMax, rsiShortMin, rsiShortMax, atrStop, atrTp, volumeMult }
 *
 * Falls back to global bias_criteria if market-specific values aren't set.
 */
export function getSignalThresholds(market) {
  const r = getRules();
  const m = r.markets?.[market];

  // Parse RSI ranges from strings like "RSI(14) between 50 and 78" or "RSI 52–72"
  function parseRsiRange(criteria, direction) {
    const line = (criteria || []).find(c => /RSI/i.test(c));
    if (!line) return direction === 'long' ? [52, 72] : [28, 48];
    // Match "between X and Y"
    const between = line.match(/between\s+(\d+)\s+and\s+(\d+)/i);
    if (between) return [parseInt(between[1]), parseInt(between[2])];
    // Match "X–Y" or "X-Y" range notation
    const range = line.match(/(\d+)[–\-](\d+)/);
    if (range) return [parseInt(range[1]), parseInt(range[2])];
    return direction === 'long' ? [52, 72] : [28, 48];
  }

  const longCrit  = m?.entry_rules?.long  ?? r.bias_criteria?.bullish ?? [];
  const shortCrit = m?.entry_rules?.short ?? r.bias_criteria?.bearish ?? [];
  const exitRules = m?.exit_rules ?? {};

  const [rsiLongMin, rsiLongMax]   = parseRsiRange(longCrit, 'long');
  const [rsiShortMin, rsiShortMax] = parseRsiRange(shortCrit, 'short');

  // ATR multipliers from exit rules ("2.0 × ATR(14)..." )
  function parseAtrMult(str) {
    const m = String(str || '').match(/^(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : null;
  }
  const atrStop = parseAtrMult(exitRules.stop_loss)  ?? 2.0;
  const atrTp   = parseAtrMult(exitRules.take_profit) ?? 3.0;

  // Volume multiplier for Tadawul is 1.2×, others 1.0×
  const volumeMult = market === 'TADAWUL' ? 1.2 : 1.0;

  return { rsiLongMin, rsiLongMax, rsiShortMin, rsiShortMax, atrStop, atrTp, volumeMult };
}

/** Returns global risk rules array. */
export function getRiskRules() {
  return getRules().risk_rules ?? [];
}

/** Returns the combined screener watchlist. */
export function getWatchlist() {
  return getRules().watchlist ?? [];
}

/** Returns the screener config (market-specific symbol lists). */
export function getScreenerConfig() {
  return getRules().screener ?? {};
}

/**
 * Writes updated fields back to rules.json.
 * Only bias_criteria and risk_rules are writable to prevent accidental overwrites.
 */
export function updateRules(patch) {
  const allowed = ['bias_criteria', 'risk_rules', 'active_market', 'active_timeframe'];
  const r = getRules();
  for (const key of allowed) {
    if (patch[key] !== undefined) r[key] = patch[key];
  }
  r.last_updated = new Date().toISOString().split('T')[0];
  writeFileSync(RULES_PATH, JSON.stringify(r, null, 2));
  _cache = r;
  return r;
}
