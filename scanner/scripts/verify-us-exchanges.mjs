#!/usr/bin/env node
/**
 * verify-us-exchanges — rules.json'daki abd_hisse watchlist'indeki tum
 * tickerlari TradingView public symbol_search API'sine sorar ve dogru
 * borsa bilgisini scanner/data/exchange-map.json'a yazar.
 *
 * Kullanim:
 *   node scanner/scripts/verify-us-exchanges.mjs
 *   node scanner/scripts/verify-us-exchanges.mjs --force  (cache'i gormezden gelir, hepsini yeniden fetch eder)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { discoverExchange, lookupExchange, getCacheSnapshot } from '../lib/exchange-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RULES_PATH = path.resolve(__dirname, '../../rules.json');

const FORCE = process.argv.includes('--force');

const rules = JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8'));
const tickers = rules?.watchlist?.abd_hisse || [];

if (tickers.length === 0) {
  console.error('rules.json watchlist.abd_hisse bos.');
  process.exit(1);
}

console.log(`ABD hisse dogrulamasi: ${tickers.length} ticker`);
console.log('-'.repeat(50));

const beforeCache = getCacheSnapshot();
const beforeMap = { ...(beforeCache?.tickers || {}) };
let changed = 0, added = 0, failed = 0;

for (const t of tickers) {
  const ticker = String(t).toUpperCase();
  const before = beforeMap[ticker] || null;

  let after;
  if (FORCE) {
    // Force: cache'i bypass et, dogrudan API'den cek
    // (discoverExchange cache'i gormezden gelmez — temizleyip cagiralim)
    // Basit yaklasim: cache'te varsa sil, sonra cagir
    const snap = getCacheSnapshot();
    if (snap?.tickers?.[ticker]) delete snap.tickers[ticker];
    fs.writeFileSync(path.resolve(__dirname, '../data/exchange-map.json'),
      JSON.stringify(snap, null, 2));
    after = await discoverExchange(ticker);
  } else {
    after = await discoverExchange(ticker);
  }

  const mark = after
    ? (before == null ? 'EKLENDI' : (before === after ? 'OK' : `DEGISTI (${before}→${after})`))
    : 'BULUNAMADI';
  console.log(`${ticker.padEnd(8)} → ${String(after ?? '—').padEnd(10)} ${mark}`);

  if (!after) failed++;
  else if (before == null) added++;
  else if (before !== after) changed++;
}

console.log('-'.repeat(50));
console.log(`Toplam: ${tickers.length} | Eklendi: ${added} | Degisti: ${changed} | Bulunamadi: ${failed}`);
