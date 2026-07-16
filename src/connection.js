import CDP from 'chrome-remote-interface';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// The Pine Editor gets its own dedicated, background TradingView tab so
// editing/compiling doesn't yank focus onto whatever chart the user is
// actively looking at. Its CDP target id is persisted here so it survives
// across separate CLI invocations (each `tv pine ...` call is a fresh process).
const PINE_TAB_STATE_PATH = join(homedir(), '.tradingview-mcp', 'pine_tab.json');
let pineClient = null;
let pineTargetInfo = null;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

export async function getClient() {
  if (client) {
    try {
      // Quick liveness check
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      return client;
    } catch {
      client = null;
      targetInfo = null;
    }
  }
  return connect();
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function listPageTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  return resp.json();
}

async function findChartTarget() {
  const targets = await listPageTargets();
  const pineTabId = readPineTabState()?.targetId;
  // Never hand the "main" connection the dedicated background Pine tab —
  // every other tool (chart, data, quotes, morning brief, ...) should keep
  // talking to the tab the user is actually looking at.
  const candidates = targets.filter(t => t.type === 'page' && t.id !== pineTabId);
  return candidates.find(t => /tradingview\.com\/chart/i.test(t.url))
    || candidates.find(t => /tradingview/i.test(t.url))
    || null;
}

// ── Dedicated background Pine Editor tab ──

function readPineTabState() {
  try {
    return JSON.parse(readFileSync(PINE_TAB_STATE_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function writePineTabState(state) {
  mkdirSync(join(homedir(), '.tradingview-mcp'), { recursive: true });
  writeFileSync(PINE_TAB_STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Opens a new TradingView tab (Ctrl/Cmd+T sent to whatever chart tab the
 * user currently has) to serve as a permanent home for Pine Editor work,
 * then immediately switches focus back to the user's original tab so the
 * only visible disruption is a brief one-time flash.
 */
async function createPineTab() {
  const before = await listPageTargets();
  const mainTarget = before.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  if (!mainTarget) {
    throw new Error('No TradingView chart tab found to open a dedicated Pine Editor tab from. Open a chart first.');
  }

  const c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: mainTarget.id });
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = Cmd (mac), 2 = Ctrl
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: mod, key: 't', code: 'KeyT', windowsVirtualKeyCode: 84 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });
  await c.close();

  let newTarget = null;
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    const after = await listPageTargets();
    newTarget = after.find(t => t.type === 'page' && /tradingview\.com/i.test(t.url) && !before.some(b => b.id === t.id));
    if (newTarget) break;
  }
  if (!newTarget) {
    throw new Error('Timed out waiting for a new TradingView tab to open for the Pine Editor.');
  }

  // Restore focus to the tab the user was actually looking at.
  await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${mainTarget.id}`).catch(() => {});

  return newTarget;
}

export async function getPineClient() {
  if (pineClient) {
    try {
      await pineClient.Runtime.evaluate({ expression: '1', returnByValue: true });
      return pineClient;
    } catch {
      pineClient = null;
      pineTargetInfo = null;
    }
  }
  return connectPine();
}

async function connectPine() {
  const state = readPineTabState();
  const targets = await listPageTargets();
  let target = state?.targetId ? targets.find(t => t.id === state.targetId && t.type === 'page') : null;

  if (!target) {
    target = await createPineTab();
    writePineTabState({ targetId: target.id });
  }

  pineTargetInfo = target;
  // Connecting directly to a target id (as opposed to /json/activate) does
  // not bring it to the foreground — this is what keeps it in the background.
  pineClient = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
  await pineClient.Runtime.enable();
  await pineClient.Page.enable();
  await pineClient.DOM.enable();
  return pineClient;
}

export async function evaluatePine(expression, opts = {}) {
  const c = await getPineClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluatePineAsync(expression) {
  return evaluatePine(expression, { awaitPromise: true });
}

export function getPineTabId() {
  return readPineTabState()?.targetId ?? null;
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
