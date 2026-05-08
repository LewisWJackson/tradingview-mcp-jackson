/**
 * Market hours — kategori bazli seans tanimi (tek kaynak).
 *
 * Butun saatler UTC. Scheduler bunu kullanarak "o an acik" kategorileri secer.
 * Manuel REST uclari (server.js icindeki /api/scan/*) bu filtreyi kullanmaz —
 * kullanici localhost uzerinden istedigi zaman tarama yapabilir.
 *
 * NOT: DST kaymasi uygulanmaz. Mevcut scheduler davranisiyla uyumlu kalmak icin
 * US ve BIST eski sabit UTC pencereleri korunur.
 */

/** Hafta ici mi? (Pzt-Cum) */
export function isWeekday(now = new Date()) {
  const day = now.getUTCDay(); // 0=Pazar, 6=Cumartesi
  return day >= 1 && day <= 5;
}

/**
 * ABD hisse regular session: haftaici UTC 13:30 - 20:00.
 * (Kis saati doneminde gercek saat 14:30-21:00 olur — bilincli kabul.)
 */
export function isUSEquityOpen(now = new Date()) {
  if (!isWeekday(now)) return false;
  const total = now.getUTCHours() * 60 + now.getUTCMinutes();
  return total >= 810 && total <= 1200;
}

/**
 * ABD hisse extended (pre + post): haftaici UTC 08:00-13:30 (pre) ve 20:00-24:00 (post).
 * Yahoo bu pencerelerde de fiyat yayinliyor; outcome-checker live tick'leri bu sayede
 * kabul eder. (Kis saati: gercekte 4am-9:30am ET pre-market, 4pm-8pm ET post-market.)
 */
export function isUSEquityExtendedOpen(now = new Date()) {
  if (!isWeekday(now)) return false;
  const total = now.getUTCHours() * 60 + now.getUTCMinutes();
  return total >= 480 && total < 1440; // 08:00 - 24:00 UTC
}

/**
 * BIST: haftaici UTC 07:00 - 15:00 (TRT 10:00-18:00).
 */
export function isBISTOpen(now = new Date()) {
  if (!isWeekday(now)) return false;
  const total = now.getUTCHours() * 60 + now.getUTCMinutes();
  return total >= 420 && total <= 900;
}

/**
 * Forex: Pazar 22:00 UTC -> Cuma 22:00 UTC.
 * Haftalik dakika = gun*1440 + saat*60 + dakika.
 * Acik aralik: [1320, 8520).
 */
export function isForexOpen(now = new Date()) {
  const mins = now.getUTCDay() * 1440 + now.getUTCHours() * 60 + now.getUTCMinutes();
  return mins >= 1320 && mins < 8520;
}

/**
 * Emtia (COMEX/CME altin, gumus, bakir): Pazar 23:00 UTC -> Cuma 22:00 UTC,
 * gunluk 22:00-23:00 UTC araligi mola.
 */
export function isCommoditiesOpen(now = new Date()) {
  const mins = now.getUTCDay() * 1440 + now.getUTCHours() * 60 + now.getUTCMinutes();
  if (mins < 1380 || mins >= 8520) return false; // hafta sonu
  if (now.getUTCHours() === 22) return false;    // gunluk 1 saatlik mola
  return true;
}

/** Kripto: her zaman acik. */
export function isCryptoOpen() {
  return true;
}

/** Kategori -> acik mi? fonksiyonu. */
export const SESSIONS = {
  kripto: isCryptoOpen,
  forex: isForexOpen,
  abd_hisse: isUSEquityOpen,
  bist: isBISTOpen,
  emtia: isCommoditiesOpen,
};

export const ALL_CATEGORIES = Object.keys(SESSIONS);

export function normalizeMarketCategory(category) {
  if (!category) return category;
  const c = String(category);
  if (c === 'us_stock' || c === 'us_stocks' || c === 'stock') return 'abd_hisse';
  if (c === 'crypto') return 'kripto';
  if (c === 'commodity' || c === 'commodities') return 'emtia';
  return c;
}

/**
 * Outcome-checker / live-outcome-processor icin "tick kabul edilebilir mi" testi.
 * abd_hisse'de regular + pre/post-market saatlerinde true; hafta sonu false.
 * Diger kategoriler icin SESSIONS map'i ile ayni davranir.
 */
export function isMarketTradeable(category, now = new Date()) {
  category = normalizeMarketCategory(category);
  if (category === 'abd_hisse') return isUSEquityExtendedOpen(now);
  const fn = SESSIONS[category];
  return fn ? fn(now) : true;
}

/** Belirli kategori su an acik mi? Bilinmeyen kategori icin true. */
export function isMarketOpen(category, now = new Date()) {
  category = normalizeMarketCategory(category);
  const fn = SESSIONS[category];
  return fn ? fn(now) : true;
}

/** Su an acik olan kategorilerin listesi. */
export function openMarkets(now = new Date()) {
  return ALL_CATEGORIES.filter(c => SESSIONS[c](now));
}

/** Kategori -> boolean map (UI icin). */
export function marketStatusMap(now = new Date()) {
  const out = {};
  for (const c of ALL_CATEGORIES) out[c] = SESSIONS[c](now);
  return out;
}

// Scheduler'in eski API'siyla uyumluluk icin alias'lar:
export const isUSMarketHours = isUSEquityOpen;
export const isBISTMarketHours = isBISTOpen;
