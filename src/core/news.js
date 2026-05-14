/**
 * News retrieval — bridges to the local ~/bin/yf CLI (Yahoo Finance wrapper).
 *
 * Pattern: spawn the yf CLI, parse JSON stdout. Keeps the news source
 * outside the MCP process so yfinance schema changes don't break TV tools.
 */
import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

const YF_BIN = path.join(os.homedir(), 'bin', 'yf');

function runYf(args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const child = spawn(YF_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error(`yf ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`yf exited ${code}: ${err.slice(0, 200)}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`yf returned non-JSON: ${out.slice(0, 200)}`)); }
    });
  });
}

export async function getNews({ symbol, n }) {
  if (!symbol) throw new Error('symbol required');
  const count = Math.min(Math.max(parseInt(n || 5, 10), 1), 20);
  // yf expects bare ticker (MELI), not exchange-prefixed (NASDAQ:MELI).
  const bare = String(symbol).replace(/^[A-Z]+:/i, '');
  const items = await runYf(['news', bare, String(count)]);
  return {
    success: true,
    symbol,
    resolved_symbol: bare,
    count: Array.isArray(items) ? items.length : 0,
    items: Array.isArray(items) ? items : [],
  };
}
