/**
 * CDP Connection for Scanner
 * TradingView Electron's /json/list HTTP endpoint often hangs.
 * This module connects via browser-level WebSocket and finds chart targets
 * using Target.getTargets protocol method instead.
 */

import http from 'node:http';
import CDP from 'chrome-remote-interface';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

let client = null;
let chartTargetId = null;

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout: ' + url)); });
    req.on('error', reject);
  });
}

/**
 * Find chart target using browser-level WebSocket + Target.getTargets.
 * Priority: /chart page > any TV page with chart API > any TV page
 */
async function findChartTargetViaBrowserWS() {
  const version = await httpGet(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('No webSocketDebuggerUrl in /json/version');

  const browser = await CDP({ target: wsUrl });
  const { targetInfos } = await browser.Target.getTargets();
  await browser.close();

  // Priority 1: explicit chart page
  const chartTarget = targetInfos.find(t =>
    t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
  );
  if (chartTarget) return chartTarget.targetId;

  // Priority 2: any TradingView HTTPS page — test each for chart API
  // IMPORTANT: exclude file:// internal Electron pages (they don't have chart API)
  const tvTargets = targetInfos.filter(t =>
    t.type === 'page' && t.url && t.url.startsWith('https://') && /tradingview/i.test(t.url)
  );

  for (const t of tvTargets) {
    try {
      const testWsUrl = `ws://${CDP_HOST}:${CDP_PORT}/devtools/page/${t.targetId}`;
      const testClient = await CDP({ target: testWsUrl });
      await testClient.Runtime.enable();
      const check = await testClient.Runtime.evaluate({
        expression: '(function(){ return typeof window.TradingViewApi !== "undefined" && !!window.TradingViewApi._activeChartWidgetWV; })()',
        returnByValue: true,
      });
      await testClient.close();
      if (check.result?.value === true) {
        console.log(`[CDP] Chart API bulundu: ${t.url}`);
        return t.targetId;
      }
    } catch { /* try next */ }
  }

  // Priority 3: any HTTPS TV page (last resort) — prefer /chart URLs
  if (tvTargets.length > 0) {
    const sorted = [...tvTargets].sort((a, b) => {
      const aChart = /\/chart/i.test(a.url) ? 0 : 1;
      const bChart = /\/chart/i.test(b.url) ? 0 : 1;
      return aChart - bChart;
    });
    console.log(`[CDP] Chart API bulunamadi, en iyi TV sayfasi kullaniliyor: ${sorted[0].url}`);
    return sorted[0].targetId;
  }

  throw new Error('TradingView chart sayfasi bulunamadi. TradingView acik ve bir grafik gorunuyor mu?');
}

/**
 * Get or establish CDP connection to the chart page.
 * Validates that the chart API is actually accessible, not just the page.
 */
export async function getClient() {
  if (client) {
    try {
      const check = await client.Runtime.evaluate({
        expression: '(function(){ return typeof window.TradingViewApi !== "undefined" && !!window.TradingViewApi._activeChartWidgetWV; })()',
        returnByValue: true,
      });
      if (check.result?.value === true) return client;
      // Page alive but chart API gone — reconnect
      console.log('[CDP] Chart API kayboldu, yeniden baglaniyor...');
      try { await client.close(); } catch {}
      client = null;
      chartTargetId = null;
    } catch {
      client = null;
      chartTargetId = null;
    }
  }
  return connect();
}

/**
 * Connect to TradingView chart via CDP.
 * Retries up to 3 times with exponential backoff.
 */
export async function connect() {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000;
  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const targetId = await findChartTargetViaBrowserWS();
      chartTargetId = targetId;

      const wsUrl = `ws://${CDP_HOST}:${CDP_PORT}/devtools/page/${targetId}`;
      client = await CDP({ target: wsUrl });

      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      console.log(`[CDP] Baglanti denemesi ${attempt + 1}/${MAX_RETRIES} basarisiz: ${err.message}`);
      if (attempt < MAX_RETRIES - 1) {
        const delay = BASE_DELAY * Math.pow(2, attempt);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw new Error(`CDP baglanti ${MAX_RETRIES} denemede basarisiz: ${lastError?.message}`);
}

/**
 * Evaluate JavaScript on the chart page.
 */
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

/**
 * Disconnect from CDP.
 */
export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    chartTargetId = null;
  }
}

/**
 * Health check: verifies connection + chart API availability.
 */
export async function healthCheck() {
  const c = await getClient();
  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.apiAvailable = true;
      } catch(e) {
        result.apiAvailable = false;
        result.error = e.message;
      }
      return result;
    })()
  `);
  return { connected: true, ...state };
}
