import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tradingDate } from './market_hours.js';

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

    const firedAtET = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'short',
    }).format(new Date(ts));

    const stored = {
      eventId: event.eventId || randomUUID(),
      ticker: event.ticker,
      firedAt: ts,
      firedAtET,
      ...event,
      timestamp: undefined, // normalized into firedAt
    };
    // Drop undefined keys (timestamp we just replaced)
    for (const k of Object.keys(stored)) if (stored[k] === undefined) delete stored[k];

    existing.fires.push(stored);
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
