import CDP from 'chrome-remote-interface';

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

// Scoring weights for choosing between several open TradingView windows.
// apiReady dominates: a focused window whose chart API hasn't initialised is
// useless to every tool, so a ready background window beats it. Focus then
// breaks the tie between windows that are equally usable.
const SCORE_API_READY = 4;
const SCORE_FOCUSED = 2;
const SCORE_VISIBLE = 1;
const MAX_TARGET_SCORE = SCORE_API_READY + SCORE_FOCUSED + SCORE_VISIBLE;
const PROBE_TIMEOUT = 2000;

function scoreTarget(state) {
  if (!state) return 0;
  return (state.apiReady ? SCORE_API_READY : 0)
    + (state.focused ? SCORE_FOCUSED : 0)
    + (state.visible ? SCORE_VISIBLE : 0);
}

/**
 * Briefly attach to a target to ask whether it is focused, visible and has a
 * live chart API. Returns null if the window can't be probed in time.
 */
async function probeTarget(target) {
  let timer = null;

  // The socket is closed by this chain rather than by the caller's finally: on
  // timeout the race has already moved on, so a finally out there can run while
  // this is still connecting and leave an orphaned socket open — which keeps the
  // event loop alive long after the process meant to exit.
  const connect = (async () => {
    const client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    try {
      const { result } = await client.Runtime.evaluate({
        expression: `(function () {
          try {
            return {
              focused: document.hasFocus(),
              visible: document.visibilityState === 'visible',
              apiReady: !!(window.TradingViewApi && window.TradingViewApi._activeChartWidgetWV),
            };
          } catch (e) { return null; }
        })()`,
        returnByValue: true,
      });
      return result?.value ?? null;
    } finally {
      try { await client.close(); } catch { /* ignore */ }
    }
  })();
  // A failure arriving after the race settled must not go unhandled.
  connect.catch(() => {});

  try {
    return await Promise.race([
      connect,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('probe timeout')), PROBE_TIMEOUT);
      }),
    ]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findChartTarget() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const pages = targets.filter(t => t.type === 'page');
  // Prefer targets with tradingview.com/chart in the URL
  const charts = pages.filter(t => /tradingview\.com\/chart/i.test(t.url));
  const candidates = charts.length ? charts : pages.filter(t => /tradingview/i.test(t.url));

  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Several windows open (a restored session can bring back half a dozen).
  // Taking the first match attaches to an arbitrary one — often a background
  // window with no initialised chart API — so rank them instead.
  let best = null;
  let bestScore = -1;
  for (const t of candidates) {
    const score = scoreTarget(await probeTarget(t));
    if (score > bestScore) { best = t; bestScore = score; }
    if (bestScore === MAX_TARGET_SCORE) break;
  }
  return best || candidates[0];
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
