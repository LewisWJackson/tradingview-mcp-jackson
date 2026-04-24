/**
 * Category + volatility tier resolver.
 *
 * WHY: BTC %2 ATR ile PEPE %15 ATR ayni grade_thresholds ile olculemez; kripto
 * etiketi tek basina yeterli degil. Bu modul:
 *   1) Bir sembolu 5 kategoriden birine oturtur (crypto/forex/us_stock/bist/
 *      commodity). rules.json watchlist'i otoriter kaynak, disindakiler heuristik.
 *   2) Sembolun son barlarindaki ATR% medianini biriktirir ve low/mid/high vol
 *      tier'a siniflandirir. Tier cache dolana kadar kategori varsayilani kullanilir.
 *   3) gradeThresholds icin tier-bazli carpan uretir (high vol = daha yuksek
 *      konvansiyon gerekir cunku gurultu buyuk).
 *   4) Weight'lerde voteWeightsByCategory[category][key] varsa onu carpan olarak
 *      uygular — 5 bucket learning bu yapida alttan beslenir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RULES_PATH = path.resolve(__dirname, '../../../rules.json');
const META_PATH = path.resolve(__dirname, '../../data/symbol-meta.json');

const CAT_MAP = {
  kripto: 'crypto',
  forex: 'forex',
  abd_hisse: 'us_stock',
  bist: 'bist',
  emtia: 'commodity',
};

const CATEGORY_DEFAULT_TIER = {
  crypto: 'mid',
  forex: 'low',
  us_stock: 'low',
  bist: 'mid',
  commodity: 'low',
  unknown: 'mid',
};

// ATR% (atr / price * 100) medyanina gore tier — deneyimsel sinirlar.
// Duzenli equity: < 0.8%; tipik crypto majors: 0.8-2.5%; memecoins/exotics: >2.5%
const TIER_THRESHOLDS = { low: 0.8, mid: 2.5 };

// Threshold ayirma carpani: high tier = gurultu fazla, A/B/C esikleri daha zor.
const TIER_THRESHOLD_MULT = { low: 0.9, mid: 1.0, high: 1.15 };

let rulesCache = null;
let rulesMtimeMs = 0;
function loadRules() {
  try {
    const stat = fs.statSync(RULES_PATH);
    if (rulesCache && stat.mtimeMs === rulesMtimeMs) return rulesCache;
    rulesCache = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
    rulesMtimeMs = stat.mtimeMs;
  } catch {
    rulesCache = rulesCache || { watchlist: {} };
  }
  return rulesCache;
}

function bareSymbol(symbol) {
  if (!symbol) return '';
  const s = String(symbol).toUpperCase();
  return s.includes(':') ? s.split(':')[1] : s;
}

/**
 * Return category for a symbol. Authority: rules.json watchlist. Fallback:
 * suffix heuristics for dynamically-added symbols (e.g., OKX auto-resolved
 * memecoins that haven't been added to watchlist yet).
 */
export function resolveCategory(symbol) {
  if (!symbol) return 'unknown';
  const bare = bareSymbol(symbol);
  const rules = loadRules();
  for (const [bucket, list] of Object.entries(rules.watchlist || {})) {
    for (const sym of list || []) {
      if (String(sym).toUpperCase() === bare) return CAT_MAP[bucket] || bucket;
    }
  }
  // Heuristik fallback
  if (/^(XAU|XAG|COPPER|OIL|WTI|BRENT|NATGAS|PLAT|PALL)/.test(bare)) return 'commodity';
  if (bare.endsWith('USDT') || bare.endsWith('USDC')) return 'crypto';
  // Crypto with USD quote (BTCUSD, ETHUSD, SOLUSD)
  if (/^(BTC|ETH|SOL|XRP|DOGE|ADA|AVAX|SUI|HYPE|DOT|LINK|PEPE|RENDER|MON|ARB|OP|INJ|TIA|NEAR)/.test(bare) && bare.endsWith('USD')) return 'crypto';
  // 6-harf forex cifti (EURUSD, GBPUSD, etc.)
  if (/^(EUR|USD|GBP|JPY|CHF|AUD|NZD|CAD|TRY|MXN|ZAR|SEK|NOK)/.test(bare) && bare.length === 6) return 'forex';
  const exchange = String(symbol).toUpperCase().includes(':') ? String(symbol).toUpperCase().split(':')[0] : '';
  if (exchange === 'BIST') return 'bist';
  // Default: ABD hisse (watchlist disindaki duz tickerlar)
  if (/^[A-Z]{1,5}$/.test(bare)) return 'us_stock';
  return 'unknown';
}

let metaCache = null;
let metaCacheMtime = 0;
function loadMeta() {
  try {
    if (fs.existsSync(META_PATH)) {
      const stat = fs.statSync(META_PATH);
      if (metaCache && stat.mtimeMs === metaCacheMtime) return metaCache;
      metaCache = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
      metaCacheMtime = stat.mtimeMs;
    } else {
      metaCache = metaCache || { symbols: {} };
    }
  } catch {
    metaCache = metaCache || { symbols: {} };
  }
  if (!metaCache.symbols) metaCache.symbols = {};
  return metaCache;
}

function tierFromAtrPct(atrPct) {
  if (!Number.isFinite(atrPct)) return null;
  if (atrPct < TIER_THRESHOLDS.low) return 'low';
  if (atrPct < TIER_THRESHOLDS.mid) return 'mid';
  return 'high';
}

/**
 * Return the volatility tier for a symbol. Uses cached ATR% median when
 * available; otherwise falls back to category default.
 */
export function getVolTier(symbol) {
  const meta = loadMeta();
  const key = bareSymbol(symbol);
  const entry = meta.symbols[key];
  if (entry?.tier) return entry.tier;
  if (entry?.atrPctMedian != null) {
    const t = tierFromAtrPct(entry.atrPctMedian);
    if (t) return t;
  }
  return CATEGORY_DEFAULT_TIER[resolveCategory(symbol)] || 'mid';
}

/**
 * Multiplier applied to A_min/B_min/C_min at grade time — higher-vol symbols
 * need higher conviction to earn the same grade (noise penalty).
 */
export function getThresholdMultiplier(symbol) {
  return TIER_THRESHOLD_MULT[getVolTier(symbol)] ?? 1.0;
}

/**
 * Optional category-level vote weight multiplier. Reads from
 * weights.voteWeightsByCategory[category][key]; default 1.0 (pass-through).
 * Future weight-adjuster iterations will populate this table by grouping
 * learning samples per category; for now it is a hook that keeps existing
 * global learning intact.
 */
export function getCategoryWeightMultiplier(weights, symbol, key) {
  const table = weights?.voteWeightsByCategory;
  if (!table) return 1.0;
  const cat = resolveCategory(symbol);
  const bucket = table[cat];
  if (!bucket) return 1.0;
  const v = bucket[key];
  return Number.isFinite(v) ? v : 1.0;
}

/**
 * Update the rolling ATR% median for a symbol. Called from signal-grader with
 * freshly-computed ATR over the last 14 bars. Uses EWMA with sample-cap for
 * smooth convergence (capped at ~50 samples to remain responsive to regime
 * shifts). Best-effort writes — failures logged but not thrown.
 */
export function updateSymbolMeta(symbol, atrPct) {
  if (!symbol || !Number.isFinite(atrPct) || atrPct <= 0) return;
  const meta = loadMeta();
  const key = bareSymbol(symbol);
  const prev = meta.symbols[key] || { samples: 0, atrPctMedian: null };
  const samples = (prev.samples || 0) + 1;
  const alpha = 2 / (Math.min(samples, 50) + 1);
  const median = prev.atrPctMedian == null ? atrPct : prev.atrPctMedian * (1 - alpha) + atrPct * alpha;
  meta.symbols[key] = {
    samples,
    atrPctMedian: median,
    tier: tierFromAtrPct(median),
    category: resolveCategory(symbol),
    updatedAt: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(META_PATH), { recursive: true });
    const tmp = META_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf8');
    fs.renameSync(tmp, META_PATH);
    metaCacheMtime = fs.statSync(META_PATH).mtimeMs;
  } catch {
    // best-effort — asynchronous ATR updates shouldn't fail grading
  }
}

/**
 * Compute ATR% of close-price over last `period` bars for a bars array.
 * Returns null if not enough data.
 */
export function computeAtrPct(bars, period = 14) {
  if (!Array.isArray(bars) || bars.length < period + 1) return null;
  const slice = bars.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < slice.length; i++) {
    const tr = Math.max(
      slice[i].high - slice[i].low,
      Math.abs(slice[i].high - slice[i - 1].close),
      Math.abs(slice[i].low - slice[i - 1].close),
    );
    sum += tr;
  }
  const atr = sum / period;
  const price = slice[slice.length - 1].close;
  if (!price || !Number.isFinite(price)) return null;
  return (atr / price) * 100;
}
