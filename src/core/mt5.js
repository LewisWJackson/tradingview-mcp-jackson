/**
 * Core MT5 bridge client. Talks over HTTP to mt5-bridge/server.py, which
 * runs under the Wine Python bundled inside MetaTrader 5.app and holds the
 * live connection to the terminal via the official MetaTrader5 package.
 */
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const BRIDGE_SCRIPT = path.join(REPO_ROOT, 'mt5-bridge', 'server.py');

const MT5_APP = '/Applications/MetaTrader 5.app';
const WINE_BIN = `${MT5_APP}/Contents/SharedSupport/wine/bin/wine`;
const WINE_PREFIX = `${process.env.HOME}/Library/Application Support/net.metaquotes.wine.metatrader5`;
const WINE_PYTHON = 'C:\\Python311\\python.exe';

const PORT = 6789;
const BASE_URL = `http://127.0.0.1:${PORT}`;

function toWinePath(macPath) {
  return 'Z:' + macPath.replace(/\//g, '\\');
}

async function checkHealth() {
  const res = await fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(3000) });
  return res.json();
}

export async function ensureBridgeRunning() {
  const healthy = await checkHealth().catch(() => null);
  if (healthy) return healthy;
  return launchBridge();
}

export async function launchBridge() {
  if (process.platform !== 'darwin') {
    throw new Error('MT5 bridge launch is currently implemented for macOS only.');
  }
  if (!existsSync(WINE_BIN)) {
    throw new Error(`Wine binary not found at ${WINE_BIN}. Is MetaTrader 5.app installed?`);
  }
  if (!existsSync(BRIDGE_SCRIPT)) {
    throw new Error(`Bridge script not found at ${BRIDGE_SCRIPT}`);
  }

  const wineScriptPath = toWinePath(BRIDGE_SCRIPT);
  const child = spawn(WINE_BIN, [WINE_PYTHON, wineScriptPath, String(PORT)], {
    env: { ...process.env, WINEPREFIX: WINE_PREFIX },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const health = await checkHealth().catch(() => null);
    if (health) return health;
  }
  throw new Error(
    'MT5 bridge launched but did not become healthy within 20s. Check that AutoTrading is enabled in the MT5 terminal and .env.mt5 has valid credentials.'
  );
}

async function request(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (!res.ok && data?.error === undefined) {
    throw new Error(`mt5-bridge HTTP ${res.status}`);
  }
  return data;
}

export async function health() {
  return request('GET', '/health');
}

export async function getAccount() {
  return request('GET', '/account');
}

export async function getPositions(symbol) {
  return request('GET', `/positions${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`);
}

export async function getOrders(symbol) {
  return request('GET', `/orders${symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''}`);
}

export async function getQuote(symbol) {
  return request('GET', `/quote?symbol=${encodeURIComponent(symbol)}`);
}

export async function getSymbolInfo(symbol) {
  return request('GET', `/symbol_info?symbol=${encodeURIComponent(symbol)}`);
}

export async function getOhlcv({ symbol, timeframe = 'M15', count = 100 }) {
  return request(
    'GET',
    `/ohlcv?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}&count=${count}`
  );
}

export async function getHistoryDeals(days = 7) {
  return request('GET', `/history_deals?days=${days}`);
}

export async function getHistoryOrders(days = 7) {
  return request('GET', `/history_orders?days=${days}`);
}

export async function placeOrder(params) {
  return request('POST', '/order', params);
}

export async function closePosition(params) {
  return request('POST', '/position/close', params);
}

export async function modifyPosition(params) {
  return request('POST', '/position/modify', params);
}

export async function cancelOrder(params) {
  return request('POST', '/order/cancel', params);
}

export async function modifyPendingOrder(params) {
  return request('POST', '/order/modify', params);
}
