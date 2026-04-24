/**
 * MCP resources — context'e her konusmada otomatik yuklenebilecek statik
 * veya cagrilan veri kaynaklari. Tool degil — Claude bunlara `read` ister.
 *
 * Eklenen resources:
 *   tradingview://watchlist          → rules.json icindeki watchlist
 *   tradingview://market-hours       → scanner/lib/market-hours.js secanslari + su an acik olanlar
 *   tradingview://recent-signals     → son 20 A/B sinyal (scanner API'sinden)
 *   tradingview://scheduler-status   → canli scheduler durumu
 *   tradingview://claude-rules       → trading rules.json'un ozeti (risk + kategori kurallari)
 *
 * Tum okuma isleri `try/catch` ile sarmalanir — scanner API kapaliysa
 * resource "offline" not'u ile doner, MCP sunucusu cokmez.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.join(REPO_ROOT, 'rules.json');
const SCANNER_API = process.env.TV_SCANNER_API || 'http://localhost:3838';
const FETCH_TIMEOUT_MS = 2000;

async function fetchJson(urlPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${SCANNER_API}${urlPath}`, { signal: ctrl.signal });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (e) {
    return { error: e.message || 'fetch failed', note: 'scanner API offline olabilir' };
  } finally {
    clearTimeout(t);
  }
}

function textContent(uri, obj) {
  return {
    contents: [
      {
        uri,
        mimeType: 'application/json',
        text: JSON.stringify(obj, null, 2),
      },
    ],
  };
}

function readRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
  } catch (e) {
    return { error: `rules.json okunamadi: ${e.message}` };
  }
}

/** UTC dakika bazli basit market-hours kontrolu — scanner'daki ile ayni mantik. */
function currentOpenMarkets(now = new Date()) {
  const day = now.getUTCDay();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const total = h * 60 + m;
  const weekMins = day * 1440 + total;
  const isWeekday = day >= 1 && day <= 5;

  const out = ['kripto']; // 24/7
  if (weekMins >= 1320 && weekMins < 8520) out.push('forex');
  if (isWeekday && total >= 810 && total <= 1200) out.push('abd_hisse');
  if (isWeekday && total >= 420 && total <= 900) out.push('bist');
  if (weekMins >= 1380 && weekMins < 8520 && h !== 22) out.push('emtia');
  return out;
}

export function registerResources(server) {
  // 1) Watchlist
  server.resource(
    'watchlist',
    'tradingview://watchlist',
    { description: 'rules.json icindeki tum kategori watchlist\'leri', mimeType: 'application/json' },
    async (uri) => {
      const rules = readRules();
      return textContent(uri.href, rules.watchlist || rules);
    },
  );

  // 2) Market hours + su an acik kategoriler
  server.resource(
    'market-hours',
    'tradingview://market-hours',
    { description: 'Kategori bazli piyasa seanslari ve su an acik olanlar (UTC)', mimeType: 'application/json' },
    async (uri) => {
      const now = new Date();
      return textContent(uri.href, {
        now: now.toISOString(),
        openNow: currentOpenMarkets(now),
        sessions: {
          kripto: '24/7',
          forex: 'Pazar 22:00 UTC -> Cuma 22:00 UTC',
          abd_hisse: 'Haftaici UTC 13:30-20:00',
          bist: 'Haftaici UTC 07:00-15:00',
          emtia: 'Pazar 23:00 UTC -> Cuma 22:00 UTC, gunluk 22:00-23:00 mola',
        },
      });
    },
  );

  // 3) Canli scheduler durumu
  server.resource(
    'scheduler-status',
    'tradingview://scheduler-status',
    { description: 'Scanner scheduler\'in canli durumu (running, acik piyasalar, son taramalar)', mimeType: 'application/json' },
    async (uri) => {
      const data = await fetchJson('/api/scheduler/status');
      return textContent(uri.href, data);
    },
  );

  // 4) Son A/B sinyaller (acik sinyaller)
  server.resource(
    'recent-signals',
    'tradingview://recent-signals',
    { description: 'Learning sisteminin takip ettigi acik A/B kalite sinyaller', mimeType: 'application/json' },
    async (uri) => {
      const data = await fetchJson('/api/learning/signals/open');
      return textContent(uri.href, Array.isArray(data) ? data.slice(0, 20) : data);
    },
  );

  // 5) Trading kurallari ozeti (risk + kategori)
  server.resource(
    'claude-rules',
    'tradingview://claude-rules',
    { description: 'rules.json icindeki risk yonetimi ve kategori bazli kurallarin ozeti', mimeType: 'application/json' },
    async (uri) => {
      const rules = readRules();
      const summary = {
        risk: rules.risk || rules.risk_yonetimi || null,
        kategori_kurallari: rules.kategori_kurallari || null,
        sinyal_kalite_kriterleri: rules.sinyal_kalite_kriterleri || null,
        notlar: rules.notlar || null,
      };
      return textContent(uri.href, summary);
    },
  );
}
