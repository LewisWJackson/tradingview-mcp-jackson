/**
 * Parser Validator — Risk #5 azaltma (Yuksek olasilik / Yuksek etki).
 *
 * Sorun: Pine indicator format'i sessizce degisirse parser fonksiyonlari
 * `{result objesi, tum alanlar null}` doner. Caller "veri aldim" zanneder,
 * sinyal kismi/yanlis verilerle uretilir.
 *
 * Cozum: zorunlu field listesini sema olarak tanimla, parse sonrasi
 * dogrula. Eksik field varsa:
 *   1. parser_alarm log + counter
 *   2. Eksik orani >50% ise parsed'i null'a indir (caller "veri yok" gorur,
 *      mevcut akista zaten BEKLE'ye duser)
 *
 * Counter dosyasi: scanner/data/parser-alarms.json
 *   { date, total, bySource: {khan: N, smc: N}, byField: {...}, yesterday }
 *
 * Risk Matrix #5: "Gunluk log review; parser_alarm > 0 ise acil fix"
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_PATH = path.resolve(__dirname, '..', 'data', 'parser-alarms.json');

// ---------------------------------------------------------------------------
// Sema sozlesmeleri
// ---------------------------------------------------------------------------

/**
 * KhanSaab dashboard zorunlu alanlari. Parser bunlardan en az %50'sini
 * dogru cikarmali; aksi halde format kirilmis sayilir.
 *
 * "Kritik" altsetler signal-grader ve scanner-engine'in olmazsa olmazlari:
 *   - bullScore/bearScore: oylama
 *   - bias: direction inference
 *   - rsi/macd/adx: ana teknik metrikler
 *   - emaStatus: direction
 */
export const KHANSAAB_SCHEMA = {
  required: ['bullScore', 'bearScore', 'bias', 'rsi', 'macd', 'adx', 'emaStatus'],
  optional: ['vwap', 'volume', 'signalStatus', 'atr', 'rsi5m', 'macdMain', 'macdSignal', 'trendStrength'],
  // En az bu kadar zorunlu alan dolu olmali — altina dusersek format kirik
  minRequiredFilledRatio: 0.5,
};

/**
 * calcTechnicals(bars) cikti semasi — bars'tan compute edildigi icin
 * Pine indicator format'ina bagli DEGIL; ama bars yetersiz/bozuksa null
 * doner. Burada validate edilen sey: KhanSaab benzeri rol oynayan
 * technical metrics tam doldurulmus mu?
 *
 * Not: bullScore/bias/vwap calcTechnicals tarafindan dolduruluyor degil
 * (sadece parseKhanSaabDashboard onlari uretir). Required sadece teknik
 * cekirdek metrikleri.
 */
export const TECHNICAL_SCHEMA = {
  required: ['rsi', 'ema21', 'adx', 'macd', 'emaStatus'],
  optional: ['ema9', 'macdMain', 'macdSignal'],
  minRequiredFilledRatio: 0.6,  // 5'in 3'u dolu olmali
};

/**
 * SMC label parser zorunlu alanlari. SMC parser ayni anda tum alanlari
 * doldurmaz (orn. EQH/EQL bazi piyasalarda yok); bu yuzden minimum esikler
 * daha gevsek.
 */
export const SMC_SCHEMA = {
  // En az BOS veya CHoCH bulunmali — yapi tespiti olmadan SMC isgormez
  oneOf: ['lastBOS', 'lastCHoCH'],
  optional: ['eqh', 'eql', 'strongHigh', 'weakHigh', 'strongLow', 'weakLow'],
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFilled(v) {
  if (v == null) return false;
  if (typeof v === 'string' && v.trim() === '') return false;
  if (Array.isArray(v) && v.length === 0) return false;
  return true;
}

/**
 * KhanSaab parsed objesini sema'ya gore dogrula.
 * @returns {{ok: boolean, missingRequired: string[], filledRatio: number, severity: 'ok'|'partial'|'broken'}}
 */
export function validateKhanSaab(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, missingRequired: KHANSAAB_SCHEMA.required, filledRatio: 0, severity: 'broken' };
  }
  const missing = KHANSAAB_SCHEMA.required.filter(f => !isFilled(parsed[f]));
  const filled = KHANSAAB_SCHEMA.required.length - missing.length;
  const ratio = filled / KHANSAAB_SCHEMA.required.length;
  let severity = 'ok';
  if (ratio < KHANSAAB_SCHEMA.minRequiredFilledRatio) severity = 'broken';
  else if (missing.length > 0) severity = 'partial';
  return { ok: severity === 'ok', missingRequired: missing, filledRatio: +ratio.toFixed(2), severity };
}

/**
 * SMC parsed objesini sema'ya gore dogrula.
 */
/**
 * calcTechnicals çıktısını dogrula.
 */
export function validateTechnicals(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, missingRequired: TECHNICAL_SCHEMA.required, filledRatio: 0, severity: 'broken' };
  }
  const missing = TECHNICAL_SCHEMA.required.filter(f => !isFilled(parsed[f]));
  const filled = TECHNICAL_SCHEMA.required.length - missing.length;
  const ratio = filled / TECHNICAL_SCHEMA.required.length;
  let severity = 'ok';
  if (ratio < TECHNICAL_SCHEMA.minRequiredFilledRatio) severity = 'broken';
  else if (missing.length > 0) severity = 'partial';
  return { ok: severity === 'ok', missingRequired: missing, filledRatio: +ratio.toFixed(2), severity };
}

export function validateSMC(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, missingRequired: SMC_SCHEMA.oneOf, filledRatio: 0, severity: 'broken' };
  }
  const oneOfFilled = SMC_SCHEMA.oneOf.some(f => isFilled(parsed[f]));
  const missing = oneOfFilled ? [] : SMC_SCHEMA.oneOf;
  const severity = oneOfFilled ? 'ok' : 'broken';
  return { ok: oneOfFilled, missingRequired: missing, filledRatio: oneOfFilled ? 1 : 0, severity };
}

// ---------------------------------------------------------------------------
// Counter (gunluk rotation)
// ---------------------------------------------------------------------------

function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function readCounter() {
  try {
    if (!fs.existsSync(COUNTER_PATH)) return null;
    return JSON.parse(fs.readFileSync(COUNTER_PATH, 'utf8'));
  } catch { return null; }
}

function writeCounter(state) {
  try {
    fs.mkdirSync(path.dirname(COUNTER_PATH), { recursive: true });
    fs.writeFileSync(COUNTER_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[parser-validator] counter write failed:', err.message);
  }
}

function emptyDay(date) {
  return { date, total: 0, bySource: {}, bySymbolTf: {}, byField: {} };
}

/**
 * Parser alarm kaydi — counter'a yazar, console.warn basar.
 * @param {Object} opts
 * @param {string} opts.source         'khanSaab'|'smc'
 * @param {string[]} opts.missing      eksik field listesi
 * @param {string} opts.severity       'partial'|'broken'
 * @param {string} [opts.symbol]
 * @param {string} [opts.timeframe]
 * @param {number} [opts.now]
 */
export function recordParserAlarm({ source, missing = [], severity, symbol = null, timeframe = null, now = Date.now() } = {}) {
  const today = todayUtc(now);
  let state = readCounter();
  if (!state || state.date !== today) {
    state = { ...emptyDay(today), yesterday: state || null };
  }
  state.total = (state.total || 0) + 1;
  state.bySource[source] = (state.bySource[source] || 0) + 1;
  if (symbol && timeframe) {
    const k = `${symbol}|${timeframe}`;
    state.bySymbolTf[k] = (state.bySymbolTf[k] || 0) + 1;
  }
  for (const f of missing) {
    state.byField[f] = (state.byField[f] || 0) + 1;
  }
  writeCounter(state);

  console.warn(`[parser_alarm] severity=${severity} source=${source} missing=${missing.join(',')} sym=${symbol}/${timeframe}`);
  return state;
}

/**
 * Bugun + dun istatistikleri.
 */
export function getParserAlarmStats(now = Date.now()) {
  const today = todayUtc(now);
  const state = readCounter() || emptyDay(today);
  return {
    today: state.date === today ? state : emptyDay(today),
    yesterday: state.yesterday || null,
  };
}

/**
 * Counter'i sifirla — testler icin.
 */
export function _resetParserAlarms() {
  try { fs.unlinkSync(COUNTER_PATH); } catch {}
}

// ---------------------------------------------------------------------------
// Wrapper helper'lar — caller'lar icin tek satirda kullanilabilir
// ---------------------------------------------------------------------------

/**
 * KhanSaab parse sonrasi cagrilir. Severity 'broken' ise null doner;
 * 'partial' ise parsed olduğu gibi gecer ama alarm kaydedilir.
 *
 * @param {Object|null} parsed  parseKhanSaabDashboard ciktisi
 * @param {{symbol?: string, timeframe?: string}} ctx
 * @returns {Object|null}
 */
export function gateKhanSaab(parsed, ctx = {}) {
  if (parsed == null) return null;  // already-null geçer
  const v = validateKhanSaab(parsed);
  if (v.ok) return parsed;
  recordParserAlarm({
    source: 'khanSaab', missing: v.missingRequired, severity: v.severity,
    symbol: ctx.symbol, timeframe: ctx.timeframe,
  });
  if (v.severity === 'broken') return null;  // <50% required dolu — caller veri yok gorsun
  return parsed;  // partial: data gecer ama alarm dustu
}

/**
 * calcTechnicals gate — broken ise null doner, partial ise alarm + gec.
 */
export function gateTechnicals(parsed, ctx = {}) {
  if (parsed == null) return null;
  const v = validateTechnicals(parsed);
  if (v.ok) return parsed;
  recordParserAlarm({
    source: 'technicals', missing: v.missingRequired, severity: v.severity,
    symbol: ctx.symbol, timeframe: ctx.timeframe,
  });
  if (v.severity === 'broken') return null;
  return parsed;
}

export function gateSMC(parsed, ctx = {}) {
  if (parsed == null) return null;
  const v = validateSMC(parsed);
  if (v.ok) return parsed;
  recordParserAlarm({
    source: 'smc', missing: v.missingRequired, severity: v.severity,
    symbol: ctx.symbol, timeframe: ctx.timeframe,
  });
  if (v.severity === 'broken') return null;
  return parsed;
}

export const __internals = { COUNTER_PATH, todayUtc, readCounter };
