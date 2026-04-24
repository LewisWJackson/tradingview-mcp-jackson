import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tradingDate } from './market_hours.js';

function formatFiredAtET(ts) {
  // ISO-8601 with the America/New_York offset (e.g. "2026-04-24T13:45:13-04:00").
  // Parseable by Date().
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const g = name => parts.find(p => p.type === name)?.value;
  let hour = g('hour');
  if (hour === '24') hour = '00';
  const dateStr = `${g('year')}-${g('month')}-${g('day')}`;
  const timeStr = `${hour}:${g('minute')}:${g('second')}`;
  // Compute offset by diffing UTC from ET-local interpretation
  const etAsUtc = Date.UTC(+g('year'), +g('month') - 1, +g('day'), +hour, +g('minute'), +g('second'));
  const utcMs = d.getTime();
  const offsetMin = Math.round((etAsUtc - utcMs) / 60000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${dateStr}T${timeStr}${sign}${hh}:${mm}`;
}

/**
 * Append-only daily fire audit log.
 *
 * Files named coiled_spring_fires_YYYY-MM-DD.json, where YYYY-MM-DD is the
 * America/New_York trading date for the fire's timestamp.
 *
 * Schema per §6.1 of the design spec — fields passed through so callers can
 * enrich freely without us having to re-edit here.
 */
export function createFireLog({ baseDir }) {
  if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

  function filePathForDate(dateStr) {
    return path.join(baseDir, `coiled_spring_fires_${dateStr}.json`);
  }

  function loadFile(fp) {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf8'));
  }

  function recordFire(event) {
    const ts = event.timestamp || new Date().toISOString();
    const dateStr = tradingDate(new Date(ts));
    const fp = filePathForDate(dateStr);
    const existing = loadFile(fp) || { date: dateStr, fires: [] };

    const firedAtET = formatFiredAtET(ts);

    const stored = {
      ...event,
      eventId: event.eventId || randomUUID(),
      ticker: event.ticker,
      firedAt: ts,
      firedAtET,
      timestamp: undefined, // normalized into firedAt
    };
    // Drop undefined keys (timestamp we just replaced)
    for (const k of Object.keys(stored)) if (stored[k] === undefined) delete stored[k];

    existing.fires.push(stored);
    // Non-atomic: single-process tool. Upgrade to write-then-rename if multi-process.
    fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
    return stored;
  }

  function getTodaysFires(now = new Date()) {
    return getFiresForDate(tradingDate(now));
  }

  function getFiresForDate(dateStr) {
    const fp = filePathForDate(dateStr);
    const parsed = loadFile(fp);
    return parsed ? parsed.fires : [];
  }

  return { recordFire, getTodaysFires, getFiresForDate, filePathForDate };
}
