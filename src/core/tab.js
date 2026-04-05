/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import { getClient, evaluate, connectToTarget } from '../connection.js';

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
 * Find the Electron shell target that contains the tab bar.
 */
async function findShellTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // The shell target is a file:// URL containing the tab bar with .create-new-tab-button
  const shells = targets.filter(t =>
    t.type === 'page' && /^file:\/\/\//i.test(t.url) && /windowsapps|resources/i.test(t.url)
  );
  // The shell with the tab bar has the .create-new-tab-button — try each
  const CDP_mod = (await import('chrome-remote-interface')).default;
  for (const shell of shells) {
    let client;
    try {
      client = await CDP_mod({ host: CDP_HOST, port: CDP_PORT, target: shell.id });
      await client.Runtime.enable();
      const { result } = await client.Runtime.evaluate({
        expression: `!!document.querySelector('.create-new-tab-button')`,
        returnByValue: true,
      });
      await client.close();
      if (result.value) return shell;
    } catch {
      if (client) try { await client.close(); } catch {}
    }
  }
  return null;
}

/**
 * Open a new tab via the Electron shell's tab bar button.
 * @param {object} opts
 * @param {string} [opts.type] - Tab type to open (currently: "layout")
 * @param {string} [opts.name] - Name of the item to select (e.g. layout name)
 */
export async function newTab({ type, name } = {}) {
  const chartsBefore = await list();

  // Step 1: Find the Electron shell and click the new tab button
  const shell = await findShellTarget();
  if (!shell) {
    throw new Error('Could not find TradingView Electron shell target. Is TradingView Desktop running?');
  }

  const CDP_mod = (await import('chrome-remote-interface')).default;
  const shellClient = await CDP_mod({ host: CDP_HOST, port: CDP_PORT, target: shell.id });
  await shellClient.Runtime.enable();
  await shellClient.Runtime.evaluate({
    expression: `document.querySelector('.create-new-tab-button').click()`,
    returnByValue: true,
  });
  await shellClient.close();

  // Step 2: Wait for the new-tab selection screen target to appear
  let newTabTarget = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 500));
    const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const targets = await resp.json();
    newTabTarget = targets.find(t => t.type === 'page' && /new-tab/i.test(t.url));
    if (newTabTarget) break;
  }

  if (!newTabTarget) {
    throw new Error('New tab opened but selection screen target not found after 7.5 seconds');
  }

  // Step 3: If type specified, select the item on the selection screen
  if (type === 'layout' && name) {
    const tabClient = await CDP_mod({ host: CDP_HOST, port: CDP_PORT, target: newTabTarget.id });
    await tabClient.Runtime.enable();

    // Wait for layout list to render
    let clicked = false;
    for (let i = 0; i < 10; i++) {
      const { result } = await tabClient.Runtime.evaluate({
        expression: `
          (() => {
            const items = document.querySelectorAll('.layout-list-item');
            for (const item of items) {
              if (item.textContent.includes('${name.replace(/'/g, "\\'")}')) {
                item.click();
                return true;
              }
            }
            return false;
          })()
        `,
        returnByValue: true,
      });
      if (result.value) { clicked = true; break; }
      await new Promise(r => setTimeout(r, 500));
    }
    await tabClient.close();

    if (!clicked) {
      throw new Error(`Layout "${name}" not found on the new tab selection screen`);
    }

    // Wait for the chart target to appear
    let chartTarget = null;
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 500));
      const chartsAfter = await list();
      // Find the new chart target that wasn't in the before list
      const beforeIds = new Set(chartsBefore.tabs.map(t => t.id));
      const newChart = chartsAfter.tabs.find(t => !beforeIds.has(t.id));
      if (newChart) { chartTarget = newChart; break; }
    }

    if (chartTarget) {
      await connectToTarget(chartTarget.id);
      const state = await list();
      return { success: true, action: 'new_tab_opened', type: 'layout', name, tab_id: chartTarget.id, ...state };
    } else {
      throw new Error(`Layout "${name}" was selected but chart target did not appear after 7.5 seconds`);
    }
  }

  // No type specified — stay on selection screen, connect to it
  await connectToTarget(newTabTarget.id);
  const state = await list();
  return { success: true, action: 'new_tab_opened', type: 'selection_screen', ...state };
}

/**
 * Close the active tab via the Electron shell's close button.
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const shell = await findShellTarget();
  if (!shell) {
    throw new Error('Could not find TradingView Electron shell target.');
  }

  const CDP_mod = (await import('chrome-remote-interface')).default;
  const shellClient = await CDP_mod({ host: CDP_HOST, port: CDP_PORT, target: shell.id });
  await shellClient.Runtime.enable();

  // Click the close button on the active tab
  const { result } = await shellClient.Runtime.evaluate({
    expression: `
      (() => {
        const activeTab = document.querySelector('.tab.active');
        if (!activeTab) return 'no active tab';
        const closeBtn = activeTab.querySelector('.tab-close-button-container button');
        if (!closeBtn) return 'no close button';
        closeBtn.click();
        return 'closed';
      })()
    `,
    returnByValue: true,
  });
  await shellClient.close();

  if (result.value !== 'closed') {
    throw new Error(`Failed to close tab: ${result.value}`);
  }

  await new Promise(r => setTimeout(r, 1000));

  // Reconnect to the first available chart tab
  const after = await list();
  if (after.tabs.length > 0) {
    await connectToTarget(after.tabs[0].id);
  }

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

    // Reconnect CDP client to the newly activated target
    await connectToTarget(target.id);

    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}
