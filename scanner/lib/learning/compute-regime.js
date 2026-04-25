/**
 * computeRegime() — Faz 1 çekirdek modülü (Risk #4 azaltma + taxonomy spec).
 *
 * Sözleşme: docs/regime-taxonomy.md §8
 *
 * Sorumluluklar:
 *   1. Raw girdilerden ham rejim teşhisi (6 rejim)
 *   2. Piyasa-özel alt rejim (BIST USDTRY korelasyonu, emtia özel rejimleri)
 *   3. Histerezis (N=3 ardışık bar aynı rejim) — false-flip koruması
 *   4. Rate limit (>4 geçiş/gün/sembol → unstable flag, sinyal kesilir)
 *   5. Chaos pencereleri (FOMC/CPI/earnings/TCMB ± offset)
 *
 * Bu modül SHADOW-ONLY'dir (Faz 1). Hiçbir sinyal akışına bağlanmamıştır;
 * log üretir, strateji seçicisi Faz 2'de devreye girer.
 *
 * Saf fonksiyon + iç state Map. State persist edilmez (in-memory); shadow
 * logger her cycle çağrısını bağımsız olarak JSONL'e yazar, restart sonrası
 * log'lardan replay edilebilir.
 */

import { getProfile, REGIME_PROFILES } from './regime-profiles.js';

const HYSTERESIS_BARS = 3;
const MAX_TRANSITIONS_PER_DAY = 4;

// Per-(symbol, TF) histerezis + transition state
const _state = new Map();

function stateKey(symbol, tf) {
  return `${symbol}|${tf}`;
}

function newState() {
  return {
    regime: null,              // mevcut onaylı rejim
    subRegime: null,
    since: null,               // bu rejime giriş zamanı (UTC ms)
    stableBars: 0,             // bu rejimde kalınan bar sayısı
    recentRaw: [],             // son N ham rejim (histerezis buffer)
    transitions: [],           // tüm geçişler: [{day, at, from, to, raw}]
  };
}

/** Sadece testler için — state'i sıfırla. */
export function _resetState(key = null) {
  if (key == null) _state.clear();
  else _state.delete(key);
}

// ---------------------------------------------------------------------------
// 1. Indicator hesaplama — ohlcv + studyValues → normalize metrikler
// ---------------------------------------------------------------------------

/**
 * ohlcv: [{time, open, high, low, close, volume}, ...]  (son bar = en yeni)
 * studyValues: { adx?, plusDi?, minusDi?, bbUpper?, bbLower?, bbBasis?, ema20? }
 */
export function computeIndicators({ ohlcv = [], studyValues = {} } = {}) {
  const n = ohlcv.length;
  const last = n ? ohlcv[n - 1] : null;

  const adx = toFiniteOrNull(studyValues.adx);
  const ema20 = toFiniteOrNull(studyValues.ema20);
  const bbUpper = toFiniteOrNull(studyValues.bbUpper);
  const bbLower = toFiniteOrNull(studyValues.bbLower);
  const bbBasis = toFiniteOrNull(studyValues.bbBasis);

  // BB genişliği (normalize edilmiş; basis != 0 ise)
  const bbWidth = (bbUpper != null && bbLower != null && bbBasis != null && bbBasis !== 0)
    ? (bbUpper - bbLower) / bbBasis
    : null;

  // 50-bar rolling BB width median (eğer geçmiş BB genişlikleri yoksa null)
  // Burada OHLCV'den yaklaşık BB-width üretmek için tek-bar basit tahmin:
  // 50-bar high-low aralığı / close_mean. Gerçek BB serileri studyValues
  // zamanla enjekte edilecek; şu an proxy olarak bu çalışır.
  let bbWidthMedian = null;
  if (n >= 50) {
    const widths = [];
    for (let i = n - 50; i < n; i++) {
      const bar = ohlcv[i];
      if (bar && bar.close) {
        widths.push((bar.high - bar.low) / bar.close);
      }
    }
    if (widths.length) {
      widths.sort((a, b) => a - b);
      bbWidthMedian = widths[Math.floor(widths.length / 2)];
    }
  }

  const bbWidthRatio = (bbWidth != null && bbWidthMedian != null && bbWidthMedian > 0)
    ? bbWidth / bbWidthMedian
    : null;

  // Fiyat 20EMA ilişkisi
  const priceAboveEma20 = (last && ema20 != null) ? last.close > ema20 : null;

  // ADX eğimi (son 5 bar — studyValues tek skalar veriyorsa proxy 0)
  const adxSlope = toFiniteOrNull(studyValues.adxSlope) ?? 0;

  // 24h return (1h TF için son 24 bar; 4h TF için son 6 bar — caller verir)
  const returnsBars = toIntOrNull(studyValues.returnsBarsFor24h) ?? 24;
  let returns24h = null;
  if (n >= returnsBars + 1) {
    const ref = ohlcv[n - returnsBars - 1]?.close;
    if (ref && last) returns24h = (last.close - ref) / ref;
  }

  // 1h return (son 1 bar — 1h TF'de son 1 bar, 4h'de son bar'ın %25'i proxy yok → last-bar range)
  let returns1h = null;
  if (n >= 2 && last) {
    const prev = ohlcv[n - 2]?.close;
    if (prev) returns1h = (last.close - prev) / prev;
  }

  // Günlük range (last bar yüksek-düşük / close)
  const dailyRangePct = (last && last.close) ? (last.high - last.low) / last.close : null;

  return {
    adx, adxSlope, ema20, bbWidth, bbWidthMedian, bbWidthRatio,
    priceAboveEma20, returns24h, returns1h, dailyRangePct,
    barCount: n, lastClose: last?.close ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2. Chaos pencere kontrolü — config/chaos-windows.json formatı
// ---------------------------------------------------------------------------

/**
 * events: [{type: 'us_fomc'|..., at: utcMs}]
 * chaosWindows: config/chaos-windows.json içeriği
 * @returns {string|null} aktif chaos penceresi tipi veya null
 */
export function activeChaosWindow({ events = [], chaosWindows = {}, now }) {
  if (!events.length || !now) return null;
  for (const ev of events) {
    const cfg = chaosWindows[ev.type];
    if (!cfg) continue;
    const offsetMs = (cfg.start_offset_min || 0) * 60_000;
    const durationMs = (cfg.duration_min || cfg.typical || 0) * 60_000;
    const start = ev.at + offsetMs;
    const end = start + durationMs;
    if (now >= start && now <= end) return ev.type;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3. Ham sınıflandırma (marketType'a göre threshold'lar)
// ---------------------------------------------------------------------------

// Threshold kaynağı İter 2'de regime-profiles.js'e taşındı. Bu sarmalayıcı
// geriye dönük uyumluluk için __internals.DEFAULT_THRESHOLDS altında
// export edilir.
function resolveThresholds(marketType, subClass = null) {
  return getProfile(marketType, subClass);
}

/**
 * Ham rejim sınıflandırma — histerezis UYGULANMAZ, sadece şu anki bar'ın
 * koşulları değerlendirilir. Histerezis layer'i computeRegime()'de uygulanır.
 *
 * @returns {{regime: string, subRegime: string|null, notes: string[]}}
 */
export function classifyRaw({
  marketType = 'crypto',
  subClass = null,
  indicators = {},
  macro = {},
  chaosActive = null,  // activeChaosWindow() sonucu; null ise chaos yok
  session = null,      // 'regular'|'premarket'|'afterhours'|'closed'
} = {}) {
  const t = resolveThresholds(marketType, subClass);
  const notes = [];

  // Öncelik sırası (taxonomy §1): chaos → closed → low_vol_drift → trending → ranging → breakout_pending
  // (high_vol_chaos her piyasada bir üstün öncelik)

  // 1. Market closed (session-bound piyasalar)
  if (session === 'closed') {
    return { regime: 'market_closed', subRegime: null, notes: ['session=closed'] };
  }

  // 2. Chaos pencere aktif → high_vol_chaos
  if (chaosActive) {
    notes.push(`chaos_window=${chaosActive}`);
    return { regime: 'high_vol_chaos', subRegime: null, notes };
  }

  // 3. Piyasa-spesifik chaos tetikleyicileri
  if (marketType === 'crypto') {
    const r24 = Math.abs(indicators.returns24h ?? 0);
    const r1 = Math.abs(indicators.returns1h ?? 0);
    if (r24 > t.chaos24h || r1 > t.chaos1h) {
      notes.push(`returns24h=${(r24 * 100).toFixed(2)}% returns1h=${(r1 * 100).toFixed(2)}%`);
      return { regime: 'high_vol_chaos', subRegime: null, notes };
    }
    const funding = Math.abs(macro.funding_rate ?? 0);
    if (t.fundingAbsChaos != null && funding > t.fundingAbsChaos) {
      notes.push(`funding=${funding}`);
      return { regime: 'high_vol_chaos', subRegime: null, notes };
    }
  } else if (marketType === 'us_stocks') {
    const vix = toFiniteOrNull(macro.vix);
    if (vix != null && vix > t.vixChaos) {
      notes.push(`vix=${vix}`);
      return { regime: 'high_vol_chaos', subRegime: null, notes };
    }
    if (session === 'premarket' || session === 'afterhours') {
      notes.push(`session=${session}`);
      return { regime: 'low_vol_drift', subRegime: null, notes };
    }
    if (vix != null && vix < t.vixCalm) {
      notes.push(`vix=${vix} (very_low)`);
      return { regime: 'low_vol_drift', subRegime: null, notes };
    }
  } else if (marketType === 'bist') {
    const usdtrySigma = toFiniteOrNull(macro.usdtry_realized_sigma_5d);
    const usdtryRet1d = Math.abs(toFiniteOrNull(macro.usdtry_return_1d) ?? 0);
    const rho = toFiniteOrNull(macro.usdtry_bist_rho_5d);

    if (usdtryRet1d > t.usdtryChaosPct) {
      notes.push(`usdtry_1d=${(usdtryRet1d * 100).toFixed(2)}% → TL stres`);
      return { regime: 'high_vol_chaos', subRegime: 'bist_decoupled_stress', notes };
    }
    // Alt rejim etiketi — histerezis sonrası ortak rejimle eşlenir
    let subRegime = null;
    if (usdtrySigma != null && rho != null) {
      if (usdtrySigma < t.usdtryStableSigma && Math.abs(rho) < 0.3) {
        subRegime = 'bist_tl_stable_domestic';
      } else if (usdtrySigma > 0.02 && (rho < 0.2 || rho < 0)) {
        subRegime = 'bist_decoupled_stress';
        notes.push('bist_decoupled_stress → long kesik');
        return { regime: 'high_vol_chaos', subRegime, notes };
      } else if (usdtrySigma > 0.03 && rho > 0.7) {
        subRegime = 'bist_tl_spike_inflation';
      } else {
        subRegime = 'bist_normal_coupled';
      }
      notes.push(`bist_sub=${subRegime}`);
      // Alt rejim sadece notu etkiler; trend kararı aşağıdaki ortak bloğa düşer
      return classifyTrendOrRange({ indicators, t, notes, subRegime });
    }
  } else if (marketType === 'commodities') {
    if (subClass === 'metals') {
      const vix = toFiniteOrNull(macro.vix);
      if (vix != null && vix > 25 && macro.dxy_direction === 'falling') {
        notes.push('risk_off_flight → trending_up_bias');
        // yine de ADX'e göre sınıflandır, not etiket olarak kalır
      }
    }
  }

  // 4. low_vol_drift — hafta sonu kripto veya pre/after US
  if (marketType === 'crypto' && session === 'weekend') {
    const dr = indicators.dailyRangePct ?? 1;
    if (dr < 0.015) {
      notes.push('weekend_low_vol');
      return { regime: 'low_vol_drift', subRegime: null, notes };
    }
  }

  // 5. Trend / ranging / breakout_pending — ortak blok
  return classifyTrendOrRange({ indicators, t, notes, subRegime: null });
}

function classifyTrendOrRange({ indicators, t, notes, subRegime }) {
  const { adx, adxSlope, priceAboveEma20, bbWidthRatio } = indicators;
  notes = [...notes, `adx=${adx} slope=${adxSlope} bbr=${fmt(bbWidthRatio)} pEma=${priceAboveEma20}`];

  if (adx == null) {
    return { regime: 'low_vol_drift', subRegime, notes: [...notes, 'adx=null'] };
  }

  if (adx > t.adxHi && (adxSlope ?? 0) >= 0) {
    if (priceAboveEma20 === true) return { regime: 'trending_up', subRegime, notes };
    if (priceAboveEma20 === false) return { regime: 'trending_down', subRegime, notes };
  }

  if (adx < t.adxLo) {
    if (bbWidthRatio != null && bbWidthRatio < 0.7) {
      return { regime: 'breakout_pending', subRegime, notes };
    }
    if (bbWidthRatio == null || (bbWidthRatio >= 0.5 && bbWidthRatio <= 1.5)) {
      return { regime: 'ranging', subRegime, notes };
    }
    return { regime: 'ranging', subRegime, notes };
  }

  // Grey zone (taxonomy'de tanımsız): ADX adxLo-adxHi arası. "Trend yorgunluğu"
  // senaryosu burası — sert karar verme, mevcut rejimi koru (histerezis halleder).
  return { regime: 'ranging', subRegime, notes: [...notes, 'grey_zone'] };
}

// ---------------------------------------------------------------------------
// 4. Ana computeRegime() — histerezis + rate limit + state yönetimi
// ---------------------------------------------------------------------------

/**
 * Tam arayüz — docs/regime-taxonomy.md §8 spec'i.
 */
export function computeRegime({
  symbol,
  timeframe,
  marketType = 'crypto',
  subClass = null,
  ohlcv = [],
  studyValues = {},
  macro = {},
  events = [],
  chaosWindows = {},
  session = null,
  now = Date.now(),
  // Testler için doğrudan indicators enjeksiyonu
  indicators = null,
} = {}) {
  if (!symbol || !timeframe) {
    throw new Error('computeRegime: symbol + timeframe zorunlu');
  }

  const ind = indicators || computeIndicators({ ohlcv, studyValues });
  const chaosActive = activeChaosWindow({ events, chaosWindows, now });
  const raw = classifyRaw({ marketType, subClass, indicators: ind, macro, chaosActive, session });

  const key = stateKey(symbol, timeframe);
  const st = _state.get(key) || newState();

  // Histerezis buffer güncelle
  st.recentRaw = [...(st.recentRaw || []), raw.regime].slice(-HYSTERESIS_BARS);
  const hysteresisMet = st.recentRaw.length >= HYSTERESIS_BARS
    && st.recentRaw.every(r => r === raw.regime);

  // Bugünkü geçiş sayısı
  const today = new Date(now).toISOString().slice(0, 10);
  const transitionsToday = (st.transitions || []).filter(t => t.day === today);
  const unstable = transitionsToday.length >= MAX_TRANSITIONS_PER_DAY;

  // Chaos anında histerezis BYPASS — chaos her zaman anında tetiklenir
  // (güvenlik önceliği: chaos'a geç kalmak pozisyona mal olur).
  const chaosImmediate = raw.regime === 'high_vol_chaos' || raw.regime === 'market_closed';

  let transitioned = false;
  if (st.regime == null) {
    // İlk tespit — histerezis beklemeden set et
    st.regime = raw.regime;
    st.subRegime = raw.subRegime;
    st.since = now;
    st.stableBars = 1;
    st.transitions = [{ day: today, at: now, from: null, to: raw.regime, raw: raw.regime }];
    transitioned = true;
  } else if ((hysteresisMet || chaosImmediate) && raw.regime !== st.regime && !unstable) {
    st.transitions = [...st.transitions, { day: today, at: now, from: st.regime, to: raw.regime, raw: raw.regime }];
    st.regime = raw.regime;
    st.subRegime = raw.subRegime;
    st.since = now;
    st.stableBars = chaosImmediate ? 1 : HYSTERESIS_BARS;
    transitioned = true;
  } else if (raw.regime === st.regime) {
    st.stableBars = (st.stableBars || 0) + 1;
    if (raw.subRegime) st.subRegime = raw.subRegime;
  } else {
    // Ham rejim farklı ama histerezis tamamlanmadı VEYA unstable
    // → mevcut rejim korunur, stableBars artar
    st.stableBars = (st.stableBars || 0) + 1;
  }

  _state.set(key, st);

  // Güven skoru: stableBars yükseldikçe artar, histerezis doldukça 0.3→0.9 bandı
  const confidence = Math.min(0.95, 0.3 + 0.1 * Math.min(st.stableBars, 7));

  const newPositionAllowed = !unstable
    && !chaosImmediate
    && st.stableBars >= HYSTERESIS_BARS;

  const strategyHint = pickStrategyHint(st.regime);

  return {
    regime: st.regime,
    subRegime: st.subRegime,
    rawRegime: raw.regime,
    confidence,
    since: st.since,
    stableBars: st.stableBars,
    transitioned,
    unstable,
    transitionsToday: transitionsToday.length + (transitioned ? 1 : 0),
    hysteresisMet,
    notes: raw.notes,
    strategyHint,
    newPositionAllowed,
  };
}

function pickStrategyHint(regime) {
  switch (regime) {
    case 'trending_up': return 'pullback_entry_long';
    case 'trending_down': return 'pullback_entry_short';
    case 'ranging': return 'mean_reversion';
    case 'breakout_pending': return 'momentum_breakout';
    case 'high_vol_chaos': return 'no_new_positions';
    case 'low_vol_drift': return 'no_new_positions';
    case 'market_closed': return 'no_new_positions';
    default: return 'no_new_positions';
  }
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

function toFiniteOrNull(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function toIntOrNull(x) { const n = Number.parseInt(x, 10); return Number.isFinite(n) ? n : null; }
function fmt(x) { return x == null ? 'null' : Number(x).toFixed(3); }

export const __internals = {
  HYSTERESIS_BARS,
  MAX_TRANSITIONS_PER_DAY,
  // Geriye dönük uyumluluk: testler ve okuyucular için proxy
  DEFAULT_THRESHOLDS: REGIME_PROFILES,
  stateKey,
};
