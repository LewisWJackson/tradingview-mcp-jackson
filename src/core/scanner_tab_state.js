/**
 * Persisted identity of the dedicated background "scanner" tab.
 *
 * trade_alert.js drives this tab through every watchlist symbol/timeframe
 * without ever bringing it to the foreground, so repeated checks don't
 * flicker whatever chart tab the user is actively looking at. connection.js
 * reads this too, so the default (foreground) CDP connection used by every
 * other tool knows to skip this tab when picking a target.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const STATE_DIR = join(homedir(), '.tradingview-mcp');
const STATE_PATH = join(STATE_DIR, 'scanner_tab.json');

export function loadScannerTab() {
  if (!existsSync(STATE_PATH)) return null;
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    return state && state.target_id ? state : null;
  } catch {
    return null;
  }
}

export function saveScannerTab({ target_id, chart_id }) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify({ target_id, chart_id }, null, 2));
}

export function clearScannerTab() {
  if (existsSync(STATE_PATH)) writeFileSync(STATE_PATH, '{}');
}
