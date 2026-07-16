import CDP from 'chrome-remote-interface';
import { loadScannerTab } from './core/scanner_tab_state.js';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

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

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  // Prefer targets with tradingview.com/chart in the URL, but skip the
  // dedicated background scanner tab (if one is configured) so interactive
  // tools never accidentally attach to it instead of the foreground chart.
  const scannerId = loadScannerTab()?.target_id;
  const chartPages = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
  const nonScannerPages = scannerId ? chartPages.filter(t => t.id !== scannerId) : chartPages;
  return (nonScannerPages[0] || chartPages[0])
    || targets.find(t => t.type === 'page' && /tradingview/i.test(t.url))
    || null;
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

/**
 * A standalone CDP connection pinned to one specific target id, independent
 * of the default singleton above. Evaluating against it runs JS in that
 * tab's page context without bringing the tab to the foreground — used to
 * drive the background scanner tab while the user's active tab stays put.
 */
export function createScopedConnection(targetId) {
  let scopedClient = null;

  async function getScopedClient() {
    if (scopedClient) {
      try {
        await scopedClient.Runtime.evaluate({ expression: '1', returnByValue: true });
        return scopedClient;
      } catch {
        scopedClient = null;
      }
    }
    scopedClient = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await scopedClient.Runtime.enable();
    await scopedClient.Page.enable();
    await scopedClient.DOM.enable();
    return scopedClient;
  }

  async function scopedEvaluate(expression, opts = {}) {
    const c = await getScopedClient();
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

  async function scopedEvaluateAsync(expression) {
    return scopedEvaluate(expression, { awaitPromise: true });
  }

  async function scopedDisconnect() {
    if (scopedClient) {
      try { await scopedClient.close(); } catch {}
      scopedClient = null;
    }
  }

  return {
    targetId,
    getClient: getScopedClient,
    evaluate: scopedEvaluate,
    evaluateAsync: scopedEvaluateAsync,
    disconnect: scopedDisconnect,
  };
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
