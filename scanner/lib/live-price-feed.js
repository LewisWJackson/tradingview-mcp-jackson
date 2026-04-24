/**
 * Live Price Feed — Binance public WebSocket
 *
 * Tek WebSocket baglantisi, Binance'in tum spot ticker'larini !miniTicker@arr
 * stream'inden alir. Sembolu TradingView formatindan (BTCUSD, BTCUSDT.P,
 * BINANCE:ETHUSDC vs.) Binance spot formatina (BTCUSDT, ETHUSDC) normalize eder.
 *
 * Kullanim:
 *   import { startLivePriceFeed, getLivePrice, getAllLivePrices, onPriceUpdate }
 *     from './live-price-feed.js';
 *   startLivePriceFeed({ broadcast: broadcastWS });
 *
 * Not: Sadece kripto. Forex/hisse/emtia icin ayri feed'ler ilerde eklenecek.
 */

import WebSocket from 'ws';

const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws/!miniTicker@arr';

// tvSymbol -> binanceSymbol cache
const _symbolMap = new Map();
// binanceSymbol -> { price, ts } (son fiyat)
const _priceMap = new Map();
// tvSymbol -> son broadcast ts (throttle icin)
const _lastBroadcastAt = new Map();
// binanceSymbol -> Set<tvSymbol> (ayni binance sembolu icin birden fazla tv varyasyonu olabilir)
const _reverseMap = new Map();

let _ws = null;
let _broadcastFn = null;
let _reconnectTimer = null;
let _stopped = false;
let _stats = {
  connected: false,
  lastMessageAt: null,
  messagesReceived: 0,
  pricesTracked: 0,
  reconnects: 0,
};

// Broadcast throttle: ayni sembol icin 1 saniyede 1 guncelleme yeterli
const BROADCAST_THROTTLE_MS = 1000;

/**
 * TV sembolunu Binance spot sembolune normalize et.
 * Ornekler:
 *   "BTCUSD"            -> "BTCUSDT"
 *   "BTCUSDT.P"         -> "BTCUSDT"
 *   "BINANCE:ETHUSDC"   -> "ETHUSDC"
 *   "OKX:SOLUSDT.P"     -> "SOLUSDT"
 *   "USDT.D"            -> null  (dominance, borsa verisi degil)
 *   "BTCXAU"            -> null  (altin paritesi, Binance'te yok)
 */
export function normalizeToBinance(tvSymbol) {
  if (!tvSymbol || typeof tvSymbol !== 'string') return null;

  // Cache kontrol
  if (_symbolMap.has(tvSymbol)) return _symbolMap.get(tvSymbol);

  let s = tvSymbol.trim().toUpperCase();

  // Borsa prefix'ini at (BINANCE:, OKX:, COINBASE: vb.)
  if (s.includes(':')) s = s.split(':')[1];

  // Perpetual suffix'ini at (.P, .PS)
  s = s.replace(/\.P$|\.PS$/i, '');

  // Dominance/synthetic semboller (USDT.D, BTC.D vb.)
  if (s.endsWith('.D') || s.includes('.')) {
    _symbolMap.set(tvSymbol, null);
    return null;
  }

  // USD quote'u USDT'ye cevir (Binance USD paritesi yok)
  // Ama XAU, XAG, EUR, vb. base'i olanlari dislamamiz gerek — sadece kripto base'leri dusun
  // Basitce: base tarafini kontrol et. Base'de rakam yoksa ve belli fiat/kiymet degilse kripto say.
  if (s.endsWith('USD') && !s.endsWith('USDT') && !s.endsWith('USDC')) {
    const base = s.slice(0, -3);
    // XAU, XAG gibi altin/gumus; EUR, GBP gibi fiat; TRY gibi — Binance spot'ta yok
    const NON_CRYPTO = new Set(['XAU', 'XAG', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'TRY']);
    if (NON_CRYPTO.has(base)) {
      _symbolMap.set(tvSymbol, null);
      return null;
    }
    s = base + 'USDT';
  }

  // XAU/XAG bazli semboller kripto degil
  if (s.startsWith('XAU') || s.startsWith('XAG')) {
    _symbolMap.set(tvSymbol, null);
    return null;
  }

  _symbolMap.set(tvSymbol, s);
  return s;
}

/**
 * Bir TV sembolu icin son fiyat — yoksa null.
 */
export function getLivePrice(tvSymbol) {
  const bin = normalizeToBinance(tvSymbol);
  if (!bin) return null;
  const entry = _priceMap.get(bin);
  return entry ? entry.price : null;
}

/**
 * Tum takip edilen TV sembollerinin son fiyatlari.
 * { tvSymbol: { price, ts, binance } }
 */
export function getAllLivePrices() {
  const out = {};
  for (const [tvSymbol, binance] of _symbolMap.entries()) {
    if (!binance) continue;
    const entry = _priceMap.get(binance);
    if (entry) {
      out[tvSymbol] = { price: entry.price, ts: entry.ts, binance };
    }
  }
  return out;
}

export function getFeedStats() {
  return {
    ..._stats,
    pricesTracked: _priceMap.size,
    symbolsResolved: Array.from(_symbolMap.values()).filter(Boolean).length,
    symbolsUnresolved: Array.from(_symbolMap.values()).filter(v => v === null).length,
  };
}

/**
 * TV sembollerini feed'e kaydet (normalize + reverse map kur).
 * Watchlist + acik sinyaller periyodik olarak bu fonksiyonu cagirmali.
 */
export function registerSymbols(tvSymbols = []) {
  for (const tv of tvSymbols) {
    const bin = normalizeToBinance(tv);
    if (!bin) continue;
    if (!_reverseMap.has(bin)) _reverseMap.set(bin, new Set());
    _reverseMap.get(bin).add(tv);
  }
}

function handleTicker(tickers) {
  _stats.messagesReceived++;
  _stats.lastMessageAt = Date.now();

  if (!Array.isArray(tickers)) return;

  const updates = []; // { tvSymbol, price, ts } — broadcast icin

  for (const t of tickers) {
    const sym = t.s;
    const price = parseFloat(t.c);
    if (!sym || !isFinite(price)) continue;

    const prev = _priceMap.get(sym);
    _priceMap.set(sym, { price, ts: t.E || Date.now() });

    // Bu binance sembolu bir veya daha fazla tv sembolune baglandiysa yayinla
    const tvSet = _reverseMap.get(sym);
    if (!tvSet || tvSet.size === 0) continue;

    // Throttle — ayni tvSymbol icin son 1sn'de yayinladiysak atla.
    // Ayrica fiyat degismediyse (prev == price) hic gondermeyelim.
    if (prev && prev.price === price) continue;

    const now = Date.now();
    for (const tvSymbol of tvSet) {
      const lastTs = _lastBroadcastAt.get(tvSymbol) || 0;
      if (now - lastTs < BROADCAST_THROTTLE_MS) continue;
      _lastBroadcastAt.set(tvSymbol, now);
      updates.push({ tvSymbol, price, ts: t.E || now });
    }
  }

  if (updates.length > 0 && _broadcastFn) {
    _broadcastFn({ type: 'live_prices', updates });
  }
}

function connect() {
  if (_stopped) return;

  try {
    _ws = new WebSocket(BINANCE_WS_URL);
  } catch (e) {
    console.log(`[LiveFeed] WS create hatasi: ${e.message}`);
    scheduleReconnect();
    return;
  }

  _ws.on('open', () => {
    _stats.connected = true;
    console.log(`[LiveFeed] Binance WS bagli — !miniTicker@arr (${_reverseMap.size} tv sembolu takipte)`);
  });

  _ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); }
    catch { return; }
    handleTicker(data);
  });

  _ws.on('close', (code, reason) => {
    _stats.connected = false;
    console.log(`[LiveFeed] WS kapandi code=${code} reason=${(reason || '').toString()}`);
    scheduleReconnect();
  });

  _ws.on('error', (err) => {
    console.log(`[LiveFeed] WS hatasi: ${err.message}`);
    // error event sonrasi close gelecek — reconnect orada tetiklenecek
  });
}

function scheduleReconnect() {
  if (_stopped) return;
  if (_reconnectTimer) return;
  _stats.reconnects++;
  const delay = 3000;
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Feed'i baslat.
 *   options.broadcast  -> (msg) => void  (WS yayin callback'i)
 *   options.symbols    -> string[]       (baslangicta registerSymbols cagir)
 */
export function startLivePriceFeed(options = {}) {
  _broadcastFn = options.broadcast || null;
  if (options.symbols && options.symbols.length > 0) {
    registerSymbols(options.symbols);
  }
  _stopped = false;
  connect();
}

export function stopLivePriceFeed() {
  _stopped = true;
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  if (_ws) {
    try { _ws.close(); } catch {}
    _ws = null;
  }
  _stats.connected = false;
}
