/**
 * Regime Shadow Logger — Faz 1 İter 2.
 *
 * computeRegime() çıktısını JSONL dosyasına append eder. Log dosyaları
 * günlük rotasyonla yazılır: `scanner/data/regime-log-YYYY-MM-DD.jsonl`.
 *
 * **Shadow mode prensibi**: logger sinyal akışına hiçbir şekilde dokunmaz.
 * Scanner hook'u logger'ı try-catch içinde çağırır; logger içindeki bir
 * hata en kötü ihtimalle 1 satır log kaybına neden olur.
 *
 * JSONL satır sözleşmesi (DeepSeek İter 2 tavsiyesi):
 *   {
 *     "utcTimestamp":        ISO string,
 *     "symbol":              "BTCUSDT",
 *     "timeframe":           "60",
 *     "marketType":          "crypto",
 *     "subClass":            "metals" | null,
 *     "regime":              onaylı rejim (histerezis sonrası),
 *     "subRegime":           BIST için bist_normal_coupled vs null,
 *     "rawRegime":           histerezis öncesi ham rejim,
 *     "confidence":          0-0.95,
 *     "transitioned":        bu çağrıda rejim değişti mi (bool),
 *     "barsSinceTransition": stableBars,
 *     "transitionsToday":    bugünkü geçiş sayısı (rate-limit görünürlüğü),
 *     "unstable":            >4 geçiş → true (sinyal kesilmeli),
 *     "newPositionAllowed":  bool,
 *     "strategyHint":        "pullback_entry_long" | ...,
 *     "notes":               [debug notları]
 *   }
 *
 * Eski log dosyaları otomatik SİLİNMEZ — Faz 1 ara raporu ve Faz 2
 * kalibrasyon için temel veri kaynağıdır. Manuel arşivleme gerekir.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, '..', '..', 'data');

// Son dosya descriptor cache — günlük rotasyon anında yeniden açılır
let _currentDate = null;
let _currentPath = null;

function todayUtc(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10); // YYYY-MM-DD
}

function logPathFor(dateStr) {
  return path.join(LOG_DIR, `regime-log-${dateStr}.jsonl`);
}

/**
 * Shadow log satırı hazırla + JSONL'e yaz.
 * @param {Object} input  computeRegime() çağrısındaki tanımlayıcılar + sonuç
 * @returns {{ok: boolean, path?: string, error?: string}}
 */
export function logRegime({
  symbol,
  timeframe,
  marketType,
  subClass = null,
  result,           // computeRegime() dönen obje
  now = Date.now(),
} = {}) {
  try {
    if (!symbol || !timeframe || !result) {
      return { ok: false, error: 'missing_required_fields' };
    }

    const dateStr = todayUtc(now);
    const filePath = logPathFor(dateStr);

    // Günlük rotasyon: tarih değiştiyse path yeniden hesaplanır (fs.appendFileSync
    // idempotent, cache sadece hızlı referans için)
    if (_currentDate !== dateStr) {
      _currentDate = dateStr;
      _currentPath = filePath;
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const record = {
      utcTimestamp: new Date(now).toISOString(),
      symbol,
      timeframe: String(timeframe),
      marketType: marketType || null,
      subClass,
      regime: result.regime ?? null,
      subRegime: result.subRegime ?? null,
      rawRegime: result.rawRegime ?? null,
      confidence: result.confidence ?? null,
      transitioned: result.transitioned === true,
      barsSinceTransition: result.stableBars ?? 0,
      transitionsToday: result.transitionsToday ?? 0,
      unstable: result.unstable === true,
      newPositionAllowed: result.newPositionAllowed === true,
      strategyHint: result.strategyHint ?? null,
      notes: Array.isArray(result.notes) ? result.notes : [],
    };

    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/**
 * Bir JSONL dosyasını okuyup kayıtları döndür. Ara rapor üretici (İter 3)
 * bu fonksiyonu kullanır.
 */
export function readLog(dateStr) {
  const filePath = logPathFor(dateStr);
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').filter(l => l.trim());
  const records = [];
  for (const line of lines) {
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

/**
 * Son N günün log dosya yollarını liste.
 */
export function listRecentLogs(days = 7, now = Date.now()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(now - i * 86_400_000);
    const dateStr = d.toISOString().slice(0, 10);
    const p = logPathFor(dateStr);
    if (fs.existsSync(p)) out.push({ date: dateStr, path: p });
  }
  return out;
}

export const __internals = { LOG_DIR, logPathFor, todayUtc };
