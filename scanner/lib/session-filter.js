/**
 * Session-of-day filter (Hafta 3-14).
 *
 * Crypto 7/24 ama likidite saatlere gore dalgalanir. Asya dead zone'da
 * (22:00-06:00 UTC) spread genis, derinlik dusuk, sahte kirilim olasiligi yuksek.
 * Bu saatlerde yeni sinyal uretmeyiz; BEKLE olarak isaretlenir. FX ve emtia da
 * benzer ozellik gosterir — Tokyo sessionu yavas, London opendan once giris agir.
 *
 * BIST ve ABD hisse zaten market-hours.js tarafindan seans disinda reddedilir —
 * orada bir filtre yok; bu modul onlari etkilemez.
 */

// Varsayilan "sessiz saat" penceresi (UTC). Operator istemezse bunu genisletir.
const ASIA_DEAD_START_UTC = 22; // 22:00 UTC
const ASIA_DEAD_END_UTC = 5;    // 05:00 UTC (05:00'a kadar)

function classify(symbol) {
  const s = (symbol || '').toUpperCase();
  if (s.startsWith('BIST:')) return 'bist';
  if (/^(EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|TRY)[A-Z]{3}$/.test(s)) return 'forex';
  if (/XAU|XAG|COPPER|WTI|BRENT|UKOIL|CRUDE/.test(s)) return 'commodities';
  if (/USD[T]?|USDC|BTC|ETH|SOL|DOGE|SHIB|LINK|XRP|AVAX|DOT|ADA|SUI|APT|RENDER|WLD|PEPE|FET|TAO/.test(s) && !/XAU|XAG/.test(s)) {
    return 'crypto';
  }
  return 'us_stocks';
}

function inAsiaDeadZone(now = new Date()) {
  const h = now.getUTCHours();
  if (ASIA_DEAD_START_UTC < ASIA_DEAD_END_UTC) {
    return h >= ASIA_DEAD_START_UTC && h < ASIA_DEAD_END_UTC;
  }
  return h >= ASIA_DEAD_START_UTC || h < ASIA_DEAD_END_UTC;
}

/**
 * @returns {null | { reason: string }}
 */
export function checkSessionFilter(symbol, now = new Date()) {
  const klass = classify(symbol);
  // BIST ve us_stocks market-hours.js ile kontrol edilir; bu modulu atlariz.
  if (klass === 'bist' || klass === 'us_stocks') return null;
  // crypto / forex / commodities: Asya olu saatlerinde filtrele
  if (inAsiaDeadZone(now)) {
    const h = now.getUTCHours().toString().padStart(2, '0');
    return { reason: `Asya dusuk-likidite penceresi (${ASIA_DEAD_START_UTC}:00-${ASIA_DEAD_END_UTC}:00 UTC) — ${h}:00 UTC, spread/likidite riski` };
  }
  return null;
}
