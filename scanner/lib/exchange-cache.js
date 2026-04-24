/**
 * Exchange Cache — ABD hisse tickerlarinin dogru borsasini (NYSE/NASDAQ/AMEX)
 * persistent JSON cache'den okur. Cache miss durumunda TradingView public
 * symbol_search REST API'sine giderek borsayi kesfeder ve cache'e yazar.
 *
 * Cache dosyasi: scanner/data/exchange-map.json
 *
 * Kullanim:
 *   lookupExchange('LLY')        → 'NYSE'          (sync, cache'den)
 *   discoverExchange('NEWTICKER')→ Promise<'NASDAQ'> (async, REST + cache yaz)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_PATH = path.resolve(__dirname, '../data/exchange-map.json');

const US_EXCHANGES = new Set(['NYSE', 'NASDAQ', 'AMEX', 'NYSE Arca', 'NYSEARCA', 'BATS', 'CBOE']);

let _cache = null;
let _cacheMtime = 0;

function loadCache() {
  try {
    const stat = fs.statSync(CACHE_PATH);
    if (_cache && stat.mtimeMs === _cacheMtime) return _cache;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    _cache = raw;
    _cacheMtime = stat.mtimeMs;
    return _cache;
  } catch {
    _cache = { _meta: {}, tickers: {} };
    return _cache;
  }
}

function saveCache(cache) {
  const tmp = CACHE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, CACHE_PATH);
  _cache = cache;
  try { _cacheMtime = fs.statSync(CACHE_PATH).mtimeMs; } catch {}
}

/**
 * Cache'ten sync borsa okur. Yoksa null doner.
 * @param {string} ticker - Prefix'siz ABD ticker (orn: 'LLY')
 * @returns {string|null} 'NYSE' | 'NASDAQ' | null
 */
export function lookupExchange(ticker) {
  if (!ticker) return null;
  const cache = loadCache();
  const key = String(ticker).toUpperCase().replace(/^[A-Z]+:/, '');
  return cache?.tickers?.[key] || null;
}

/**
 * TradingView public symbol_search REST API ile borsa kesfeder.
 * Birden fazla US borsasinda listeli tickerlarda en oncelikli olani secer (NYSE/NASDAQ > Arca/BATS).
 * @param {string} ticker
 * @returns {Promise<string|null>} Bulunan borsa veya null
 */
async function fetchExchangeFromTV(ticker) {
  const t = String(ticker).toUpperCase();
  const url = `https://symbol-search.tradingview.com/symbol_search/?text=${encodeURIComponent(t)}&type=stock&hl=0&exchange=`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) scanner/1.0',
        'Origin': 'https://www.tradingview.com',
        'Referer': 'https://www.tradingview.com/',
      },
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!Array.isArray(results)) return null;

    // Exact match ve US borsasi olanlar
    const exactUS = results.filter(r =>
      String(r.symbol || '').toUpperCase() === t &&
      US_EXCHANGES.has(String(r.exchange || ''))
    );
    if (exactUS.length === 0) return null;

    // Oncelik: NYSE/NASDAQ/AMEX > diger (Arca, BATS, CBOE)
    const primary = exactUS.find(r => ['NYSE', 'NASDAQ', 'AMEX'].includes(r.exchange));
    if (primary) return primary.exchange;
    return exactUS[0].exchange;
  } catch {
    return null;
  }
}

/**
 * Cache'ten okur, yoksa TV API'sinden ceker ve cache'e yazar.
 * @param {string} ticker
 * @returns {Promise<string|null>}
 */
export async function discoverExchange(ticker) {
  const cached = lookupExchange(ticker);
  if (cached) return cached;

  const discovered = await fetchExchangeFromTV(ticker);
  if (!discovered) return null;

  // NYSE Arca / NYSEARCA gibi varyantlari NYSE olarak normalize et
  let normalized = discovered;
  if (/^NYSE\s+/i.test(discovered) || /^NYSEARCA$/i.test(discovered)) normalized = 'NYSE';

  const cache = loadCache();
  cache.tickers = cache.tickers || {};
  cache.tickers[String(ticker).toUpperCase()] = normalized;
  cache._meta = cache._meta || {};
  cache._meta.updatedAt = new Date().toISOString().slice(0, 10);
  saveCache(cache);
  return normalized;
}

/**
 * Birden cok ticker icin toplu dogrulama. Yeni kesfedilenleri cache'e yazar.
 * @param {string[]} tickers
 * @returns {Promise<Record<string,string|null>>}
 */
export async function discoverMany(tickers) {
  const out = {};
  for (const t of tickers) {
    out[t] = await discoverExchange(t);
  }
  return out;
}

/**
 * Tum cache'i dondurur (debug / UI icin).
 */
export function getCacheSnapshot() {
  return loadCache();
}
