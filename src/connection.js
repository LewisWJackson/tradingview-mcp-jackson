import CDP from 'chrome-remote-interface';
import { Mutex } from 'async-mutex';
import { trace } from './tracer.js';

let client = null;
let targetInfo = null;

// Write-tool serialization mutex.
//
// Why: stdio MCP and Streamable HTTP both support concurrent in-flight
// requests; the MCP SDK dispatches handlers as async tasks. CDP itself
// supports concurrent commands (response matching by id), so two
// evaluate() calls reach Chrome on the same connection and Chrome's
// single JS thread runs them in arrival order. For READ tools that's
// fine. For WRITE tools (chart_set_symbol, chart_set_timeframe,
// chart_manage_indicator, draw_shape, etc.) interleaving can leave the
// page in an inconsistent state — e.g. two rapid chart_set_symbol calls
// from different clients can race on the symbol-load lifecycle and the
// "winner" depends on Chrome's microtask scheduling rather than arrival
// order.
//
// Solution: evaluateWrite() runs inside a process-wide async mutex.
// Concurrent writes serialize; reads stay unblocked. The classification
// is per-handler (see src/core/<module>.js) — handlers calling
// state-mutating JS expressions use evaluateWrite(); read-only handlers
// stay on evaluate().
//
// Per-instance scope: one MCP server process = one mutex. If you run
// multiple MCP processes against the same Chrome (legacy stdio
// per-consumer pattern), the mutex does NOT cross processes — each MCP
// has its own. The recommended deployment is one MCP process serving
// multiple consumers via Streamable HTTP, where the mutex covers all
// callers.
const writeMutex = new Mutex();
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
  // Prefer targets with tradingview.com/chart in the URL
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
  const span = trace.start('evaluate', expression);
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
    span.error(msg);
    throw new Error(`JS evaluation error: ${msg}`);
  }
  span.end();
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

/**
 * Run an evaluate() under the process-wide write mutex.
 *
 * Use this for any handler whose JS expression MUTATES chart/page state
 * — chart_set_*, indicator add/remove, draw_*, alert_create/delete,
 * pane_set_*, tab_*, pine_set_source, pine_smart_compile, replay_*,
 * batch_run when it contains write subtasks.
 *
 * Read-only handlers stay on evaluate() — no contention, no overhead.
 *
 * @param {string} expression - JS expression to evaluate on the page.
 * @param {object} [opts] - Same options as evaluate().
 * @returns {Promise<*>} - Same return shape as evaluate().
 */
export async function evaluateWrite(expression, opts = {}) {
  const span = trace.startWrite(expression);
  return writeMutex.runExclusive(async () => {
    span.acquired();
    try {
      const r = await evaluate(expression, opts);
      span.released();
      return r;
    } catch (e) {
      span.error(String(e.message || e));
      throw e;
    }
  });
}

/**
 * Run a multi-step write sequence (multiple evaluate() calls) atomically
 * under the write mutex. Use this when a single logical operation issues
 * 2+ JS evaluations that must NOT interleave with another writer's
 * sequence — e.g. chart_manage_indicator captures the before-snapshot,
 * runs the add/remove, then captures the after-snapshot.
 *
 * The callback receives the unlocked evaluate() so it can run multiple
 * reads/writes inside the critical section without re-locking.
 *
 * @param {function((string, object?) => Promise<*>): Promise<*>} fn
 *   Async callback that receives evaluate() and returns its result.
 * @returns {Promise<*>}
 */
export async function withWriteLock(fn) {
  const span = trace.startSection();
  return writeMutex.runExclusive(async () => {
    span.acquired();
    try {
      const r = await fn(evaluate);
      span.released();
      return r;
    } catch (e) {
      span.error(String(e.message || e));
      throw e;
    }
  });
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
