import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
// Mutable so tv_launch can override; defaults to TradingView Desktop's conventional port.
let cdpPort = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

export function setCdpPort(p) { if (Number.isFinite(p) && p > 0) cdpPort = p; }
export function getCdpPort() { return cdpPort; }
export function getCdpHost() { return CDP_HOST; }

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
      // Liveness: cheap eval + confirm the cached target still exists at the same URL family.
      // Why both: when TradingView navigates inside the same tab (e.g. home → /chart/...),
      // the target id stays the same but window globals reset. evaluate('1') still succeeds,
      // and the caller then hits "TradingViewApi is undefined" on the next call. Re-fetching
      // /json/list catches drift in URL + confirms the target is still listed.
      await client.Runtime.evaluate({ expression: '1', returnByValue: true });
      const resp = await fetch(`http://${CDP_HOST}:${cdpPort}/json/list`);
      const targets = await resp.json();
      const current = targets.find(t => t.id === targetInfo?.id);
      if (!current || !/tradingview/i.test(current.url)) {
        throw new Error('cached CDP target navigated away or no longer matches TradingView');
      }
      // Keep targetInfo URL in sync so downstream consumers see the new URL.
      targetInfo = current;
      return client;
    } catch {
      try { await client.close(); } catch {}
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
      client = await CDP({ host: CDP_HOST, port: cdpPort, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      // Boot-time race guard: during cold start TradingView's first page is `/` (home) and only
      // later navigates to /chart/...; the chart API globals (`TradingViewApi`) aren't initialised
      // on the home page. If they're missing, drop this client and retry — by the next pass the
      // page will likely have navigated and findChartTarget will pick the real chart target.
      const apiReady = await client.Runtime.evaluate({
        expression: "typeof window.TradingViewApi !== 'undefined' && !!window.TradingViewApi._activeChartWidgetWV",
        returnByValue: true,
      });
      if (!apiReady.result?.value) {
        try { await client.close(); } catch {}
        client = null;
        targetInfo = null;
        throw new Error('Connected to a TradingView tab but the chart API is not ready yet (likely the home/login page).');
      }

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
  const resp = await fetch(`http://${CDP_HOST}:${cdpPort}/json/list`);
  const targets = await resp.json();
  // Prefer targets actually showing a chart. Fall back to any TradingView tab only if no chart
  // tab exists — the chart-API readiness probe in connect() catches the case where we picked
  // a home-page tab during boot.
  return targets.find(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
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
