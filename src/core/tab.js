/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate } from '../connection.js';
import { loadScannerTab, saveScannerTab, clearScannerTab } from './scanner_tab_state.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  // Use CDP Target.activateTarget to bring the tab to front
  try {
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    const text = await resp.text();
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}

/**
 * Pin an existing tab (by index, from `list()`) as the dedicated background
 * scanner tab. Once set, trade_alert.js drives that tab's chart directly via
 * a pinned CDP target — without ever activating/focusing it — so repeated
 * checks don't flicker whatever tab the user is actively looking at. Also
 * excluded from the default connection's target selection (see connection.js).
 */
export async function setScannerTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (isNaN(idx) || idx < 0 || idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs). Run "tv tab list" to see indexes.`);
  }

  const target = tabs.tabs[idx];
  saveScannerTab({ target_id: target.id, chart_id: target.chart_id });
  return { success: true, action: 'scanner_tab_set', index: idx, tab_id: target.id, chart_id: target.chart_id };
}

/**
 * Report whether a scanner tab is configured and still open.
 */
export async function getScannerTab() {
  const saved = loadScannerTab();
  if (!saved) return { success: true, configured: false };

  const tabs = await list();
  const match = tabs.tabs.find(t => t.id === saved.target_id);
  return {
    success: true,
    configured: true,
    active: Boolean(match),
    tab_id: saved.target_id,
    chart_id: saved.chart_id,
    index: match ? match.index : null,
    note: match ? undefined : 'Configured scanner tab is no longer open. Re-run "tv trade-alert set-scanner-tab <index>".',
  };
}

/**
 * Unpin the scanner tab. Trade alert checks fall back to scanning on the
 * active/foreground tab (the old, flickering behavior) until a new one is set.
 */
export async function clearScannerTabPin() {
  clearScannerTab();
  return { success: true, action: 'scanner_tab_cleared' };
}
