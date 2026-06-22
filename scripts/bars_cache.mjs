/**
 * bars_cache.mjs — on-disk Yahoo OHLCV cache so research scripts stop refetching
 * ~180 symbols every run. Supports a configurable range (default 10y daily — the
 * stock fetchYahooOHLCV is hardcapped to 2y, too short for multi-year seasonality).
 *
 * Cache: data/bars_cache.json  { [yahooSym]: { fetched, range, bars:[{t,o,h,l,c,v}] } }
 * Stale after CACHE_TTL_H hours → refetch. Delete the file to force a full refresh.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE = join(__dirname, '..', 'data', 'bars_cache.json');
const CACHE_TTL_H = 18;
const YF_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'application/json' };

let mem = null;
function load() { if (mem) return mem; mem = existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, 'utf8')) : {}; return mem; }
function save() { mkdirSync(dirname(CACHE), { recursive: true }); writeFileSync(CACHE, JSON.stringify(mem)); }

async function fetchYahoo(yahooSym, range = '10y', interval = '1d') {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo ${res.status} for ${yahooSym}`);
  const r = (await res.json()).chart?.result?.[0];
  if (!r) throw new Error(`No data for ${yahooSym}`);
  const ts = r.timestamp || [], q = r.indicators?.quote?.[0] || {};
  return ts.map((t, i) => ({ t, o: q.open?.[i] ?? null, h: q.high?.[i] ?? null, l: q.low?.[i] ?? null, c: q.close?.[i] ?? null, v: q.volume?.[i] ?? 0 }))
    .filter(b => b.c != null && b.c > 0 && b.h != null && b.l != null);
}

/** Get bars for one yahooSym, cached. Returns [{t,o,h,l,c,v}] ascending. [] on failure. */
export async function getBars(yahooSym, range = '10y') {
  const db = load();
  const hit = db[yahooSym];
  const fresh = hit && hit.range === range && (Date.now() - hit.fetched) < CACHE_TTL_H * 3600e3;
  if (fresh) return hit.bars;
  try {
    const bars = await fetchYahoo(yahooSym, range);
    db[yahooSym] = { fetched: Date.now(), range, bars };
    return bars;
  } catch {
    return hit ? hit.bars : [];   // fall back to stale on network error
  }
}

/** Warm the cache for many symbols with bounded concurrency, then persist once. */
export async function warm(yahooSyms, range = '10y', concurrency = 12) {
  let i = 0, ok = 0;
  async function worker() { while (i < yahooSyms.length) { const s = yahooSyms[i++]; const b = await getBars(s, range); if (b.length) ok++; } }
  await Promise.all(Array.from({ length: concurrency }, worker));
  save();
  return { requested: yahooSyms.length, withData: ok };
}

export const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
