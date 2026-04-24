/**
 * Symbol Resolver — scanner sembol adlarini TradingView borsa prefix'li tam ad'a cevirir.
 *
 * Ornekler:
 *   resolveSymbol('BA', 'abd_hisse')      → 'NYSE:BA'
 *   resolveSymbol('NFLX', 'abd_hisse')    → 'NASDAQ:NFLX'
 *   resolveSymbol('BTCUSDT', 'kripto')    → 'BINANCE:BTCUSDT'
 *   resolveSymbol('BTCUSD', 'kripto')     → 'COINBASE:BTCUSD'
 *   resolveSymbol('USDT.D')               → 'CRYPTOCAP:USDT.D'
 *   resolveSymbol('BTCXAU', 'kripto')     → 'BTCXAU' (broker sembolu, prefix eklenmez)
 *
 * NOT: Bu modul scanner-engine ve backtest.js icinde sembol scan/backtest oncesi
 * cagrilmalidir — TradingView setSymbol default olarak yanlis borsayi secebilir.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { lookupExchange } from './exchange-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

// Lazy-cached watchlist from rules.json — inferCategory fallback'i icin.
// BIST tickerlari (THYAO, GARAN, ASELS vb.) 2-6 harfli oldugundan heuristik onlari
// `abd_hisse` olarak yanlis etiketliyordu; watchlist membership'i once kontrol etmek
// bu sinifi dogru belirler.
let _cachedWatchlist = null;
let _cachedWatchlistMtime = 0;

function loadWatchlist() {
  try {
    const stat = fs.statSync(RULES_PATH);
    if (_cachedWatchlist && stat.mtimeMs === _cachedWatchlistMtime) return _cachedWatchlist;
    const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
    _cachedWatchlist = rules?.watchlist || null;
    _cachedWatchlistMtime = stat.mtimeMs;
    return _cachedWatchlist;
  } catch {
    return null;
  }
}

// Ozel semboller (korelasyon / makro gostergeler)
const SPECIAL = {
  'USDT.D': 'CRYPTOCAP:USDT.D',
  'BTC.D': 'CRYPTOCAP:BTC.D',
  'TOTAL': 'CRYPTOCAP:TOTAL',
  'TOTAL2': 'CRYPTOCAP:TOTAL2',
  'DXY': 'TVC:DXY',
  'VIX': 'TVC:VIX',
  'US10Y': 'TVC:US10Y',
  'GOLD': 'TVC:GOLD',
};

// Borsa override'lari — BINANCE'ta olmayan / baska borsalarda listeli kripto pair'leri.
// resolveCrypto default kuralindan once kontrol edilir.
// Listeyi genisletmek icin: sembol → 'EXCHANGE:SYMBOL'
const EXCHANGE_OVERRIDES = {
  // Hyperliquid token — Binance'ta spot yok, OKX'te listeli
  'HYPEUSDT': 'OKX:HYPEUSDT',
  'HYPEUSDC': 'OKX:HYPEUSDC',
  'HYPEUSD': 'COINBASE:HYPEUSD',
  // Monad henuz spot'ta yok; scanner MONUSD kullaniyor (Coinbase'de listeli)
  'MONUSD': 'COINBASE:MONUSD',
  'MONUSDT': 'COINBASE:MONUSD',  // MONUSDT yok, MONUSD'a yonlendir
  'MONUSDC': 'COINBASE:MONUSD',
};

// ABD hisse borsa eslemesi artik persistent cache'den okunur — bkz. exchange-cache.js
// + scanner/data/exchange-map.json. Cache miss durumunda default NYSE donulur.
// Yeni sembollerin dogru borsasini kesfetmek icin: discoverExchange() (async).

// Emtia / FX commodity eslestirmeleri (TradingView broker prefix'leri)
const COMMODITY_MAP = {
  'XAUUSD': 'OANDA:XAUUSD',
  'XAGUSD': 'OANDA:XAGUSD',
  'XPTUSD': 'OANDA:XPTUSD',
  'COPPER': 'CAPITALCOM:COPPER',
  'WTIUSD': 'TVC:USOIL',
  'BRENT': 'TVC:UKOIL',
};

/**
 * Sembolu kategori bilgisine gore TradingView tam adina cevirir.
 * @param {string} symbol - Scanner watchlist'indeki sembol (orn: 'BA', 'BTCUSDT')
 * @param {string} [category] - 'kripto' | 'forex' | 'abd_hisse' | 'bist' | 'emtia'
 * @returns {string} Borsa prefix'li tam sembol ornegin 'NYSE:BA'
 */
export function resolveSymbol(symbol, category) {
  if (!symbol) return symbol;
  const sym = String(symbol).trim();

  // Zaten prefix'li ise oldugu gibi dondur
  if (sym.includes(':')) return sym;

  // Ozel semboller (USDT.D, DXY, vb.)
  const upper = sym.toUpperCase();
  if (SPECIAL[upper]) return SPECIAL[upper];

  // XAU pair'leri broker-spesifik, dokunma (BTCXAU/ETHXAU gibi)
  if (upper.endsWith('XAU') && upper !== 'XAUUSD') return sym;

  switch (category) {
    case 'kripto':
      return resolveCrypto(upper);
    case 'abd_hisse':
      return resolveUSStock(upper);
    case 'bist':
      return `BIST:${upper}`;
    case 'forex':
      return `FX:${upper}`;
    case 'emtia':
      return resolveCommodity(upper);
    default:
      return sym;
  }
}

function resolveCrypto(symbol) {
  // Override listesinde olanlar default kurali atlar
  if (EXCHANGE_OVERRIDES[symbol]) return EXCHANGE_OVERRIDES[symbol];
  // Oncelik: BINANCE (USDT / USDC) → COINBASE (USD fallback)
  if (symbol.endsWith('USDT')) return `BINANCE:${symbol}`;
  if (symbol.endsWith('USDC')) return `BINANCE:${symbol}`;
  if (symbol.endsWith('USD')) return `COINBASE:${symbol}`;
  return `BINANCE:${symbol}`;
}

function resolveUSStock(symbol) {
  const exchange = lookupExchange(symbol) || 'NYSE';
  return `${exchange}:${symbol}`;
}

function resolveCommodity(symbol) {
  return COMMODITY_MAP[symbol] || symbol;
}

// Cross-pair dedup destegi icin stable suffix listesi.
// Ornek: MONUSD ve MONUSDC ayni base ('MON') — dedup icin tek grup.
const STABLE_SUFFIX_REGEX = /(USDT|USDC|USD|BUSD|DAI|TUSD|FDUSD)$/;

// Borsa likidite siralamasi (dusuk = daha hacimli).
// Cross-pair dedup'ta hangi sembolun korunacagini belirler.
// BINANCE en buyuk hacim, ardindan derivatives borsalari, sonra COINBASE/KRAKEN.
const EXCHANGE_LIQUIDITY_RANK = {
  BINANCE: 0,
  BYBIT: 1,
  OKX: 2,
  COINBASE: 3,
  KRAKEN: 4,
  BITSTAMP: 5,
};

/**
 * Crypto sembolunden base asset'i (coin) cikarir.
 * Stable suffix yoksa null doner — cross-pair dedup uygulanmaz.
 * @param {string} symbol - Prefix'li ya da prefix'siz crypto sembol
 * @returns {string|null} Base coin (orn: 'BTC', 'MON') ya da null
 */
export function extractBaseAsset(symbol) {
  if (!symbol) return null;
  let s = String(symbol).toUpperCase();
  const colonIdx = s.indexOf(':');
  if (colonIdx >= 0) s = s.slice(colonIdx + 1);
  const m = s.match(STABLE_SUFFIX_REGEX);
  if (!m) return null;
  return s.slice(0, m.index);
}

/**
 * Verilen sembolun TradingView'da hangi borsada acilacagini ve o borsanin
 * likidite ranking'ini doner. Dusuk rank = daha hacimli borsa.
 * Cross-pair dedup tiebreaker'i.
 * @param {string} symbol
 * @param {string} [category]
 * @returns {{ exchange: string|null, rank: number }}
 */
export function getResolvedExchangeRank(symbol, category) {
  if (!symbol) return { exchange: null, rank: 99 };
  const resolved = resolveSymbol(symbol, category);
  const m = String(resolved).toUpperCase().match(/^([A-Z]+):/);
  const exchange = m ? m[1] : null;
  const rank = exchange ? (EXCHANGE_LIQUIDITY_RANK[exchange] ?? 99) : 99;
  return { exchange, rank };
}

/**
 * Watchlist grubundan sembolun kategorisini tahmin eder.
 * rules.json'daki watchlist yapisina bakarak calisir.
 * @param {string} symbol
 * @param {object} [watchlist] - rules.json watchlist objesi, yoksa heuristik kullanilir
 * @returns {string|null}
 */
export function inferCategory(symbol, watchlist = null) {
  if (!symbol) return null;
  const raw = String(symbol).toUpperCase();

  // Borsa prefix'i kategori belirleyici — BIST:XYZ her zaman 'bist',
  // NASDAQ/NYSE/AMEX = 'abd_hisse', BINANCE/COINBASE/OKX = 'kripto', vb.
  // Bu, watchlist'te listelenmemis ama prefix'li kayitlarin (orn: BIST:MIATK)
  // heuristikle yanlis kategoriye dusmesini engeller.
  const prefixMatch = raw.match(/^([A-Z]+):/);
  if (prefixMatch) {
    const ex = prefixMatch[1];
    if (ex === 'BIST') return 'bist';
    if (ex === 'NASDAQ' || ex === 'NYSE' || ex === 'AMEX') return 'abd_hisse';
    if (ex === 'BINANCE' || ex === 'COINBASE' || ex === 'OKX' || ex === 'KRAKEN' || ex === 'BYBIT' || ex === 'BITSTAMP') return 'kripto';
    if (ex === 'OANDA' || ex === 'FX' || ex === 'FX_IDC') {
      // OANDA hem forex hem emtia (XAUUSD, XAGUSD) icin kullaniliyor
      const sym = raw.slice(prefixMatch[0].length);
      if (/^(XAU|XAG|XPT|XPD)/.test(sym)) return 'emtia';
      return 'forex';
    }
    if (ex === 'TVC') {
      const sym = raw.slice(prefixMatch[0].length);
      if (/^(GOLD|SILVER|COPPER|USOIL|UKOIL|NATGAS)/.test(sym)) return 'emtia';
      // TVC:DXY, TVC:VIX, TVC:US10Y → kategorisiz makro
      return null;
    }
    if (ex === 'CRYPTOCAP') return null; // USDT.D, BTC.D, TOTAL — makro
  }

  const upper = raw.replace(/^[A-Z]+:/, '');

  // Ozel semboller kategorisiz
  if (SPECIAL[upper]) return null;

  // Watchlist varsa oradan kategori bul — caller vermediyse rules.json'dan lazy-load et.
  // Bu, BIST tickerlarinin (THYAO, GARAN...) heuristikte `abd_hisse`'ye dusmesini onler.
  const wl = (watchlist && typeof watchlist === 'object') ? watchlist : loadWatchlist();
  if (wl && typeof wl === 'object') {
    for (const [cat, symbols] of Object.entries(wl)) {
      if (Array.isArray(symbols) && symbols.map(s => s.toUpperCase()).includes(upper)) {
        return cat;
      }
    }
  }

  // Heuristik tahmin (watchlist olmayan / watchlist'te bulunamayan durumlarda)
  if (/^(XAU|XAG|XPT|COPPER|WTI|BRENT)/.test(upper)) return 'emtia';
  if (/USDT$|USDC$|USD$/.test(upper) && upper.length >= 6) {
    // BTCUSD, ETHUSDT, SOLUSDC → kripto
    // EURUSD, GBPUSD → forex
    const base = upper.replace(/(USDT|USDC|USD)$/, '');
    const forexBases = new Set(['EUR', 'GBP', 'AUD', 'NZD', 'CAD', 'CHF', 'JPY']);
    return forexBases.has(base) ? 'forex' : 'kripto';
  }
  if (upper.endsWith('XAU')) return 'kripto'; // BTCXAU, ETHXAU
  // Turkce harfler yok, 4-6 harf → buyuk ihtimal hisse
  if (/^[A-Z]{2,6}$/.test(upper)) return 'abd_hisse';
  return null;
}
