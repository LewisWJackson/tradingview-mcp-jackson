/**
 * Economic / event blackout windows.
 *
 * Paralı veri kaynaği kullanmıyoruz; operatör `scanner/data/blackout.json`
 * dosyasına FOMC / NFP / CPI / yerel merkez bankası / onemli earnings / yuksek
 * volatilite pencerelerini manuel girer. Format:
 *
 *   {
 *     "windows": [
 *       { "name": "FOMC April", "from": "2026-04-30T17:30:00Z", "to": "2026-04-30T20:00:00Z", "scope": "all" },
 *       { "name": "NFP May", "from": "2026-05-02T12:00:00Z", "to": "2026-05-02T14:30:00Z", "scope": "forex,us_stocks" }
 *     ]
 *   }
 *
 * scope = "all" → butun semboller reddedilir; "crypto" | "forex" | "us_stocks" | "bist"
 * | "commodities" veya virgullu kombinasyon → yalniz o asset class.
 *
 * Dosya yoksa veya parse edilemezse hic blackout uygulanmaz; test modu.
 * JSON her cagrida okunur ama memoize edilir (60sn cache) — dosya editi live
 * yansir, I/O maliyeti minimal.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BLACKOUT_PATH = path.resolve(__dirname, '..', 'data', 'blackout.json');

const CACHE_TTL_MS = 60_000;
let cache = { at: 0, windows: [] };

function loadBlackoutFile() {
  try {
    if (!fs.existsSync(BLACKOUT_PATH)) return [];
    const raw = fs.readFileSync(BLACKOUT_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.windows)) return [];
    return parsed.windows.filter(w => w && w.from && w.to).map(w => ({
      name: w.name || 'unnamed',
      from: new Date(w.from).getTime(),
      to: new Date(w.to).getTime(),
      scope: (w.scope || 'all').toLowerCase(),
    })).filter(w => Number.isFinite(w.from) && Number.isFinite(w.to) && w.to > w.from);
  } catch (e) {
    return [];
  }
}

function getWindows() {
  const now = Date.now();
  if (now - cache.at < CACHE_TTL_MS) return cache.windows;
  cache = { at: now, windows: loadBlackoutFile() };
  return cache.windows;
}

function classifySymbol(symbol) {
  const s = (symbol || '').toUpperCase();
  if (s.startsWith('BIST:')) return 'bist';
  if (/USD[T]?|USDC|BTC|ETH|SOL|DOGE|SHIB|LINK|XRP|AVAX|DOT|ADA|SUI|APT|RENDER|WLD|PEPE|FET|TAO/.test(s) && !/XAU|XAG/.test(s)) {
    return 'crypto';
  }
  if (/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|TRY)[A-Z]{3}$/.test(s) || /USDTRY|EURUSD|GBPUSD|USDJPY|USDCHF|AUDUSD|NZDUSD|USDCAD/.test(s)) {
    return 'forex';
  }
  if (/XAU|XAG|COPPER|WTI|BRENT|UKOIL|CRUDE/.test(s)) return 'commodities';
  return 'us_stocks';
}

/**
 * @param {string} symbol TV sembolu
 * @param {number} [now] test icin override
 * @returns {null | { name: string, scope: string, endsAt: number }}
 */
export function checkBlackout(symbol, now = Date.now()) {
  const windows = getWindows();
  if (!windows.length) return null;
  const klass = classifySymbol(symbol);
  for (const w of windows) {
    if (now < w.from || now >= w.to) continue;
    if (w.scope === 'all' || w.scope.split(',').map(x => x.trim()).includes(klass)) {
      return { name: w.name, scope: w.scope, endsAt: w.to };
    }
  }
  return null;
}
