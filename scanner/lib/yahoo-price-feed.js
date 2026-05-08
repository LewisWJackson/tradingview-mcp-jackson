/**
 * Yahoo Finance Price Feed — ABD hissesi + emtia icin REST polling
 *
 * Yahoo Finance'in v7/quote endpoint'i artik auth gerektiriyor (HTTP 401).
 * v8/finance/chart endpoint'i hala acik (anahtarsiz) ve her sembol icin
 * `meta.regularMarketPrice` doner. Her polling dongusunde tum sembolleri
 * paralel cekeriz.
 *
 * TV -> Yahoo sembol haritasi:
 *   XAUUSD  -> GC=F  (gold futures, $/oz)
 *   XAGUSD  -> SI=F  (silver futures, $/oz)
 *   COPPER  -> HG=F  (copper futures, $/lb)
 *   BA, NFLX, AVGO, ... -> aynen (US hisse senetleri)
 *
 * Not: Kripto icin ayri bir modul (live-price-feed.js — Binance WS) kullaniyoruz.
 * Kripto sembolleri burada atlanir.
 */

const CHART_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const POLL_INTERVAL_MS = 5000; // 5 saniyede bir — Yahoo'ya nazik
const REQUEST_TIMEOUT_MS = 4000;
const BAR_RANGE_TOLERANCE = 0.02;

// BIST kategori prefix takilacak TV sembol seti (registerSymbolsByCategory ile doldurulur)
const _bistSymbols = new Set();

// Emtia haritasi — TV sembolleri (rules.json'dan) Yahoo sembollerine
const COMMODITY_MAP = {
  'XAUUSD': 'GC=F',
  'XAGUSD': 'SI=F',
  'COPPER': 'HG=F',
  'XAUEUR': 'GC=F', // proxy
  'XAGEUR': 'SI=F',
  'NATGAS': 'NG=F',
  'CRUDE': 'CL=F',
  'WTICOUSD': 'CL=F',
  'UKOIL': 'BZ=F',
  'BRENT': 'BZ=F',
};

// Yahoo'da izlenen sembollerin listesi — tv -> yahoo (normalize cache)
const _symbolMap = new Map(); // tvSymbol -> yahooSymbol | null
// yahooSymbol -> Set<tvSymbol>
const _reverseMap = new Map();
// yahooSymbol -> { price, ts }
const _priceMap = new Map();

let _timer = null;
let _broadcastFn = null;
let _stats = {
  lastPollAt: null,
  polls: 0,
  errors: 0,
  symbolsTracked: 0,
  pricesResolved: 0,
};
let _stopped = false;

/**
 * TV sembolunu Yahoo Finance sembolune cevir.
 * Kripto (.P, USDT, USDC vs.) icin null doner — onlar Binance feed'inde.
 * Forex pariteleri (EURUSD) de suanda atlaniyor (Yahoo'da EURUSD=X ile cekilebilir
 * ama kullanici bu adimda forex istemedi).
 */
export function normalizeToYahoo(tvSymbol) {
  if (!tvSymbol || typeof tvSymbol !== 'string') return null;
  if (_symbolMap.has(tvSymbol)) return _symbolMap.get(tvSymbol);

  let s = tvSymbol.trim().toUpperCase();

  // Borsa prefix'i at (BINANCE:, OKX:, NASDAQ:, NYSE:, COMEX:, BIST:, TVC: vb.)
  if (s.includes(':')) s = s.split(':')[1];

  // Perp suffix at
  s = s.replace(/\.P$|\.PS$/i, '');

  // Kripto belirtisi olanlari dislamayi dene — USDT/USDC/USD + dominance
  if (s.endsWith('USDT') || s.endsWith('USDC')) { _symbolMap.set(tvSymbol, null); return null; }
  if (s.endsWith('.D')) { _symbolMap.set(tvSymbol, null); return null; }
  // XXXUSD kripto mu (BTCUSD, ETHUSD) metal mi (XAUUSD)? Metal olanlari whitelist ile cozuyoruz.
  if (s.endsWith('USD')) {
    // Metal whitelist
    if (COMMODITY_MAP[s]) { _symbolMap.set(tvSymbol, COMMODITY_MAP[s]); return COMMODITY_MAP[s]; }
    // Fiat pariteleri (EURUSD vb.) — forex, simdilik atla
    const base = s.slice(0, -3);
    const FOREX_BASE = new Set(['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'TRY']);
    if (FOREX_BASE.has(base)) { _symbolMap.set(tvSymbol, null); return null; }
    // Bilinmeyen XXXUSD — buyuk ihtimal kripto (BTCUSD vb.), atla
    _symbolMap.set(tvSymbol, null);
    return null;
  }

  // Direkt emtia haritasi (COPPER, NATGAS vs.)
  if (COMMODITY_MAP[s]) {
    _symbolMap.set(tvSymbol, COMMODITY_MAP[s]);
    return COMMODITY_MAP[s];
  }

  // Forex cross (EURCHF, GBPJPY vs.) — simdilik atla
  if (/^[A-Z]{6}$/.test(s)) {
    const b = s.slice(0, 3), q = s.slice(3);
    const FIAT = new Set(['EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'TRY', 'USD']);
    if (FIAT.has(b) && FIAT.has(q)) { _symbolMap.set(tvSymbol, null); return null; }
  }

  // BIST hisseleri — Yahoo'da "SYMBOL.IS" formatinda (THYAO.IS, SASA.IS vb.)
  // registerSymbolsByCategory ile bist kategorisi eklendiyse bu set dolucaktir.
  if (_bistSymbols.has(tvSymbol) || _bistSymbols.has(s)) {
    const yahooSym = s + '.IS';
    _symbolMap.set(tvSymbol, yahooSym);
    return yahooSym;
  }
  // BIST: prefix ile geldiyse direkt .IS ekle
  if (tvSymbol.toUpperCase().startsWith('BIST:')) {
    const yahooSym = s + '.IS';
    _symbolMap.set(tvSymbol, yahooSym);
    return yahooSym;
  }

  // Geri kalan her sey ABD hissesi varsayimi (BA, NFLX, AVGO, AAPL, ...)
  // 1-5 harf, sadece harf — standart US ticker
  if (/^[A-Z][A-Z.]{0,5}$/.test(s)) {
    _symbolMap.set(tvSymbol, s);
    return s;
  }

  _symbolMap.set(tvSymbol, null);
  return null;
}

/**
 * Yalniz belirli bir kategorideki sembolleri kaydet (BIST'i dislamak icin).
 * categories: { abd_hisse: [...], emtia: [...], ... } — sadece abd_hisse ve emtia islenir.
 */
export function registerSymbolsByCategory(categories = {}) {
  // BIST sembollerini onceden set'e ekle ki normalizeToYahoo dogru ceviri yapsin
  for (const tv of (categories.bist || [])) {
    let s = tv.trim().toUpperCase();
    if (s.includes(':')) s = s.split(':')[1];
    _bistSymbols.add(tv);
    _bistSymbols.add(s);
  }

  const allowed = ['abd_hisse', 'emtia', 'bist'];
  for (const cat of allowed) {
    const syms = categories[cat] || [];
    for (const tv of syms) {
      const y = normalizeToYahoo(tv);
      if (!y) continue;
      if (!_reverseMap.has(y)) _reverseMap.set(y, new Set());
      _reverseMap.get(y).add(tv);
    }
  }
  _stats.symbolsTracked = _reverseMap.size;
}

/**
 * Ek semboller (acik sinyallerden gelen).
 * Kategori belirsiz oldugu icin normalize sadece US-hisse benzeri veya emtia whitelist'teyse kabul edilir.
 */
export function registerSymbols(tvSymbols = []) {
  for (const tv of tvSymbols) {
    // BIST: prefix'i olan sembolleri _bistSymbols'a ekle ki normalizeToYahoo .IS eklesin
    if (tv.toUpperCase().startsWith('BIST:')) {
      const bare = tv.split(':')[1].trim().toUpperCase();
      _bistSymbols.add(tv);
      _bistSymbols.add(bare);
    }
    const y = normalizeToYahoo(tv);
    if (!y) continue;
    if (!_reverseMap.has(y)) _reverseMap.set(y, new Set());
    _reverseMap.get(y).add(tv);
  }
  _stats.symbolsTracked = _reverseMap.size;
}

async function fetchOne(yahooSymbol) {
  // includePrePost=true ile pre/post market barlari da gelir
  const url = `${CHART_URL}${encodeURIComponent(yahooSymbol)}?interval=2m&range=1d&includePrePost=true`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (TVScanner)' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!resp.ok) return null;
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;

    const regularPrice = meta.regularMarketPrice;
    if (!isFinite(regularPrice)) return null;

    // Mevcut seansi currentTradingPeriod uzerinden belirle
    const nowSec = Date.now() / 1000;
    const periods = meta.currentTradingPeriod || {};
    const pre = periods.pre;
    const regular = periods.regular;
    const post = periods.post;

    let marketState = 'REGULAR';
    if (pre && nowSec >= pre.start && nowSec < pre.end) marketState = 'PRE';
    else if (regular && nowSec >= regular.start && nowSec < regular.end) marketState = 'REGULAR';
    else if (post && nowSec >= post.start && nowSec < post.end) marketState = 'POST';
    else if (regular && nowSec >= regular.end) marketState = 'CLOSED';

    // PRE veya POST seansdayken son bari kullan
    let price = Number(regularPrice);
    let ts = meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now();

    const quote = result?.indicators?.quote?.[0] || {};

    if (marketState === 'PRE' || marketState === 'POST') {
      const timestamps = result?.timestamp || [];
      const closes = quote.close || [];
      // Son gecerli (non-null) bari bul
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null && isFinite(closes[i])) {
          price = Number(closes[i]);
          ts = timestamps[i] ? timestamps[i] * 1000 : Date.now();
          break;
        }
      }
    }

    if (!isPlausibleYahooPrice(price, quote)) return null;

    return { price, regularPrice: Number(regularPrice), marketState, ts };
  } catch {
    clearTimeout(t);
    return null;
  }
}

export function isPlausibleYahooPrice(price, quote = {}, tolerance = BAR_RANGE_TOLERANCE) {
  if (!Number.isFinite(Number(price))) return false;
  const highs = Array.isArray(quote.high) ? quote.high.filter(Number.isFinite) : [];
  const lows = Array.isArray(quote.low) ? quote.low.filter(Number.isFinite) : [];
  if (!highs.length || !lows.length) return true;
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  return Number(price) <= maxHigh * (1 + tolerance)
    && Number(price) >= minLow * (1 - tolerance);
}

async function pollOnce() {
  _stats.polls++;
  _stats.lastPollAt = Date.now();

  const yahooSymbols = Array.from(_reverseMap.keys());
  if (yahooSymbols.length === 0) return;

  // Paralel cek — 20 sembol ~1 saniye tamamlanir
  const results = await Promise.all(yahooSymbols.map(s => fetchOne(s).then(r => [s, r])));

  const updates = [];
  for (const [yahooSymbol, r] of results) {
    if (!r) { _stats.errors++; continue; }
    const prev = _priceMap.get(yahooSymbol);
    _priceMap.set(yahooSymbol, r);

    // Fiyat degismediyse yayinlama
    if (prev && prev.price === r.price) continue;

    const tvSet = _reverseMap.get(yahooSymbol);
    if (!tvSet) continue;
    for (const tvSymbol of tvSet) {
      updates.push({ tvSymbol, price: r.price, ts: r.ts, marketState: r.marketState || 'REGULAR' });
    }
  }
  _stats.pricesResolved = _priceMap.size;

  if (updates.length > 0 && _broadcastFn) {
    _broadcastFn({ type: 'live_prices', updates });
  }
}

export function getYahooPrice(tvSymbol) {
  const y = normalizeToYahoo(tvSymbol);
  if (!y) return null;
  const entry = _priceMap.get(y);
  return entry ? entry.price : null;
}

export function getAllYahooPrices() {
  const out = {};
  for (const [tvSymbol, yahooSymbol] of _symbolMap.entries()) {
    if (!yahooSymbol) continue;
    const entry = _priceMap.get(yahooSymbol);
    if (entry) out[tvSymbol] = { price: entry.price, ts: entry.ts, yahoo: yahooSymbol, marketState: entry.marketState || 'REGULAR' };
  }
  return out;
}

export function getYahooFeedStats() {
  return {
    ..._stats,
    symbolsTracked: _reverseMap.size,
    pricesResolved: _priceMap.size,
  };
}

export function startYahooPriceFeed(options = {}) {
  _broadcastFn = options.broadcast || null;
  if (_timer) {
    console.log('[YahooFeed] Zaten calisiyor — yeni timer baslatilmadi');
    return;
  }
  _stopped = false;
  // Ilk polling hemen, sonra aralikli
  pollOnce().catch(e => console.log('[YahooFeed] ilk poll hatasi:', e.message));
  _timer = setInterval(() => {
    if (_stopped) return;
    pollOnce().catch(e => console.log('[YahooFeed] poll hatasi:', e.message));
  }, POLL_INTERVAL_MS);
  console.log(`[YahooFeed] Baslatildi — ${POLL_INTERVAL_MS / 1000}sn aralikla polling`);
}

export function stopYahooPriceFeed() {
  _stopped = true;
  if (_timer) { clearInterval(_timer); _timer = null; }
}
