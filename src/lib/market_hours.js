/**
 * NYSE market-hours gate.
 *
 * Computes which operational mode the poller should be in given the current UTC time.
 * Uses IANA America/New_York timezone for DST correctness.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_PATH = path.resolve(__dirname, '..', '..', 'data', 'nyse_calendar.json');

let calendarCache = null;
function loadCalendar() {
  if (calendarCache) return calendarCache;
  const raw = fs.readFileSync(CALENDAR_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  calendarCache = new Map(parsed.days.map(d => [d.date, d]));
  return calendarCache;
}

/**
 * Convert a JS Date to {y, m, d, dow, hour, minute} in America/New_York.
 * dow: 0=Sun...6=Sat.
 */
function toET(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const g = name => parts.find(p => p.type === name)?.value;
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  // Intl.DateTimeFormat with hour12:false can output "24" at midnight on some engines — normalize.
  let hour = parseInt(g('hour'), 10);
  if (hour === 24) hour = 0;
  return {
    y: g('year'), m: g('month'), d: g('day'),
    dow: dowMap[g('weekday')],
    hour,
    minute: parseInt(g('minute'), 10),
    dateStr: `${g('year')}-${g('month')}-${g('day')}`,
  };
}

function minuteOfDay(hour, minute) {
  return hour * 60 + minute;
}

/**
 * Returns { mode, reason?, holiday?, etClock, closeTimeET? } where mode is one of:
 *   'PRE_WARM'       — 9:25 ≤ t < 9:30 ET
 *   'REGULAR'        — 9:30 ≤ t < sessionClose ET
 *   'CLOSE_CAPTURE'  — sessionClose ≤ t < sessionClose + 5 ET
 *   'PAUSED'         — all other times, with reason in {weekend, holiday, early_close, outside_hours}
 *
 * sessionClose is 16:00 ET on normal days, or the early-close time on calendar-flagged days.
 */
export function getMarketMode(nowDate = new Date()) {
  const cal = loadCalendar();
  const et = toET(nowDate);
  const etClock = `${et.hour}:${String(et.minute).padStart(2, '0')}`;

  if (et.dow === 0 || et.dow === 6) {
    return { mode: 'PAUSED', reason: 'weekend', etClock };
  }

  const calEntry = cal.get(et.dateStr);
  if (calEntry && calEntry.status === 'closed') {
    return { mode: 'PAUSED', reason: 'holiday', holiday: calEntry.name, etClock };
  }

  // Determine session close (default 16:00, or early-close override)
  let closeHour = 16, closeMinuteComponent = 0;
  let closeTimeET = '16:00';
  if (calEntry && calEntry.status === 'early_close') {
    const [h, m] = calEntry.closeTimeET.split(':').map(Number);
    closeHour = h; closeMinuteComponent = m;
    closeTimeET = calEntry.closeTimeET;
  }

  const nowMin = minuteOfDay(et.hour, et.minute);
  const preWarmStart = minuteOfDay(9, 25);
  const regularStart = minuteOfDay(9, 30);
  const sessionCloseMOD = minuteOfDay(closeHour, closeMinuteComponent);
  const captureEnd = sessionCloseMOD + 5;

  if (nowMin >= preWarmStart && nowMin < regularStart) {
    return { mode: 'PRE_WARM', etClock, closeTimeET };
  }
  if (nowMin >= regularStart && nowMin < sessionCloseMOD) {
    return { mode: 'REGULAR', etClock, closeTimeET };
  }
  if (nowMin >= sessionCloseMOD && nowMin < captureEnd) {
    return { mode: 'CLOSE_CAPTURE', etClock, closeTimeET };
  }

  const reason = (calEntry && calEntry.status === 'early_close' && nowMin >= captureEnd) ? 'early_close' : 'outside_hours';
  return { mode: 'PAUSED', reason, etClock, closeTimeET };
}

/**
 * Returns the ET trading-date string (YYYY-MM-DD) for a given instant.
 * Used so that fires logged at 3:45 PM PT / 6:45 PM ET get assigned to the correct trading day.
 */
export function tradingDate(nowDate = new Date()) {
  return toET(nowDate).dateStr;
}
