#!/usr/bin/env node
// Scrapes TradingView's Options Chain page (±10 strikes, nearest expiration) for
// each of FATTAH's six tickers, filters to ask <= $0.45, and writes the results
// into fattah/detector/tracked_contracts.json's per-ticker candidates array.
//
// Navigation follows the confirmed path from
// ~/tradingview-mcp-jackson/skills/option-chain-navigate/SKILL.md: ticker badge
// dropdown -> ASSETS -> Options -> strikes preset -> ±10 strikes. The chain
// renders as a real <table>, so once there we read structured data/cell-id and
// data-strike attributes instead of parsing pixel screenshots.
//
// Usage:
//   node scripts/fetch_option_chain.mjs               # all six tickers
//   node scripts/fetch_option_chain.mjs AAPL MSFT      # subset

import { readFileSync, writeFileSync } from 'fs';
import { chart, ui } from '../src/core/index.js';
import { disconnect } from '../src/connection.js';

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'IBIT', 'META'];
const ENTRY_PRICE_CEILING = 0.45;
const CONTRACTS_FILE = new URL(
  '../../fattah/detector/tracked_contracts.json',
  import.meta.url
).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TradingView's SPA re-renders asynchronously after navigation clicks — a
// find immediately after a click frequently misses because the DOM hasn't
// caught up yet (confirmed empirically: NVDA runs failed intermittently at
// fixed 500ms delays, then the same click target appeared moments later).
// Poll instead of trusting one fixed sleep.
async function pollFindElement(query, { strategy = 'text', matchText, preferTag = 'button', timeoutMs = 4000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await ui.findElement({ query, strategy });
    const visible = found.elements.filter((e) => e.visible && (!matchText || e.text === matchText));
    // Duplicate hidden/wrapper panels are common (see SKILL.md gotchas) — a
    // giant wrapper div often matches before the real clickable element does.
    // Prefer the smallest matching element of the preferred tag.
    const tagged = visible.filter((e) => e.tag === preferTag);
    const pool = tagged.length > 0 ? tagged : visible;
    if (pool.length > 0) {
      pool.sort((a, b) => a.width * a.height - b.width * b.height);
      return pool[0];
    }
    await sleep(intervalMs);
  }
  return null;
}

async function closeKnownAd() {
  // Deliberately narrow — see SKILL.md "Close Any Ad" gotcha: a broad
  // [class*="close"] sweep once closed the chain overlay's own back control.
  await ui.uiEvaluate({
    expression: `
      (function(){
        var texts = ['Learn more', 'Double your deposit', 'tastyfx'];
        var closed = 0;
        var candidates = Array.from(document.querySelectorAll('[class*="close" i]'));
        candidates.forEach(function(c){
          var box = c.closest('[class*="banner" i], [class*="promo" i], [class*="ad" i]');
          if (box && box.getBoundingClientRect().y > 700) {
            try { c.click(); closed++; } catch(e) {}
          }
        });
        return { closed: closed };
      })()
    `,
  });
}

async function dismissMarketClosedTooltip() {
  await ui.mouseClick({ x: 900, y: 600, button: 'left' });
  await sleep(200);
}

async function backToChartIfOnChainPage() {
  // If a prior run (or manual session) left the Options Chain page open,
  // calling chart.setSymbol() there updates the chain in-place instead of
  // going through the badge -> dropdown -> Options flow, which desyncs every
  // coordinate this script computes afterward. Always start from a known
  // clean main-chart state.
  const btn = await pollFindElement('Back to chart', { timeoutMs: 1500 });
  if (btn) {
    await ui.mouseClick({ x: btn.x + btn.width / 2, y: btn.y + btn.height / 2, button: 'left' });
    await sleep(1000);
  }
}

async function openOptionsChain(ticker) {
  await backToChartIfOnChainPage();
  await chart.setSymbol({ symbol: ticker });
  await sleep(1500);
  await dismissMarketClosedTooltip();

  // The dropdown chevron next to the ticker pill (top-left toolbar) sits at a
  // fixed (170, 19) across tickers in this window layout — confirmed live for
  // both AAPL and NVDA. Dynamic lookup via [aria-label="Change symbol"] is
  // NOT reliable here: that aria-label belongs to the *chart legend* text
  // (a different element than the toolbar pill), so computing an offset from
  // it lands on the wrong toolbar button (opened "Change interval" instead
  // of the Chart/Assets dropdown in testing). See SKILL.md's duplicate-panel
  // gotcha — this page renders several stacked/hidden copies of the toolbar.
  await ui.mouseClick({ x: 170, y: 19, button: 'left' });

  const optionsBtn = await pollFindElement('Options', { matchText: 'Options', preferTag: 'div' });
  if (!optionsBtn) throw new Error(`${ticker}: "Options" menu entry not found`);
  await ui.mouseClick({ x: optionsBtn.x + optionsBtn.width / 2, y: optionsBtn.y + optionsBtn.height / 2, button: 'left' });
  await sleep(1200);
  await closeKnownAd();

  const chainReady = await pollFindElement('Strike', { timeoutMs: 5000 });
  if (!chainReady) throw new Error(`${ticker}: option chain table never rendered`);

  // Widen from the default ±6 to ±10 strikes (max clean preset per SKILL.md —
  // "All strikes" mixes in greeks data that isn't needed here).
  const strikesBtn = await pollFindElement('±6 strikes', { timeoutMs: 3000 });
  const realBtn = strikesBtn?.tag === 'button' ? strikesBtn
    : (await ui.findElement({ query: '±6 strikes', strategy: 'text' })).elements.find((e) => e.tag === 'button');
  if (realBtn) {
    await ui.mouseClick({ x: realBtn.x + realBtn.width / 2, y: realBtn.y + realBtn.height / 2, button: 'left' });
    const presetEl = await pollFindElement('±10 strikes', { timeoutMs: 3000 });
    if (presetEl) {
      await ui.mouseClick({ x: presetEl.x + presetEl.width / 2, y: presetEl.y + presetEl.height / 2, button: 'left' });
      await sleep(800);
    }
  }
}

async function scrapeNearestExpiration(ticker) {
  const result = await ui.uiEvaluate({
    expression: `
      (function(){
        var table = document.querySelector('table');
        if (!table) return { error: 'no table found' };
        var rows = Array.from(table.querySelectorAll('tr'));
        var header = rows[1];
        var headerCells = Array.from(header.children).map(function(c){ return c.textContent.trim(); });
        var strikeIdx = headerCells.indexOf('Strike');
        if (strikeIdx === -1) return { error: 'Strike column not found', headerCells: headerCells };
        var out = [];
        for (var i = 2; i < rows.length; i++) {
          var r = rows[i];
          if (!r.hasAttribute('data-strike')) continue;
          var cells = Array.from(r.children).map(function(c){ return c.textContent.trim(); });
          var callCell = r.querySelector('[data-cell-part="call"]');
          var putCell = r.querySelector('[data-cell-part="put"]');
          out.push({
            strike: r.getAttribute('data-strike'),
            callSymbol: callCell ? callCell.getAttribute('data-cell-id') : null,
            putSymbol: putCell ? putCell.getAttribute('data-cell-id') : null,
            callAsk: cells[strikeIdx - 5],
            callBid: cells[strikeIdx - 4],
            putBid: cells[strikeIdx + 5],
            putAsk: cells[strikeIdx + 6],
          });
        }
        return { rows: out };
      })()
    `,
  });
  const parsed = result?.result;
  if (!parsed || parsed.error) {
    throw new Error(`${ticker}: chain scrape failed — ${parsed?.error || 'no result'}`);
  }
  return parsed.rows;
}

function toNumber(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (t === '' || t === '—' || t === '-') return null;
  const n = Number(t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// OPRA:{TICKER}{YYMMDD}{C|P}{STRIKE} (read directly off data-cell-id, confirmed
// live) -> OPRA_DLY:...same...  the format confirmed working for
// chart_set_symbol / ohlcv pulls (session-log-2026-07-19.md, item 3).
function toDlySymbol(oprSymbol) {
  if (!oprSymbol || !oprSymbol.startsWith('OPRA:')) return null;
  return 'OPRA_DLY:' + oprSymbol.slice('OPRA:'.length);
}

function buildCandidates(ticker, rows) {
  const candidates = [];
  for (const row of rows) {
    const strike = toNumber(row.strike);
    for (const side of ['call', 'put']) {
      const ask = toNumber(side === 'call' ? row.callAsk : row.putAsk);
      const bid = toNumber(side === 'call' ? row.callBid : row.putBid);
      const rawSymbol = side === 'call' ? row.callSymbol : row.putSymbol;
      if (ask == null || ask > ENTRY_PRICE_CEILING) continue;
      const symbol = toDlySymbol(rawSymbol);
      if (!symbol) continue;
      candidates.push({
        symbol,
        strike,
        type: side === 'call' ? 'C' : 'P',
        bid,
        ask,
      });
    }
  }
  return candidates;
}

async function fetchTicker(ticker) {
  console.log(`${ticker}: navigating to options chain...`);
  await openOptionsChain(ticker);
  const rows = await scrapeNearestExpiration(ticker);
  console.log(`${ticker}: scraped ${rows.length} strike rows`);
  const candidates = buildCandidates(ticker, rows);
  console.log(`${ticker}: ${candidates.length} candidates <= $${ENTRY_PRICE_CEILING}`);
  return candidates;
}

async function main() {
  const requested = process.argv.slice(2);
  const tickers = requested.length > 0 ? requested : TICKERS;
  for (const t of tickers) {
    if (!TICKERS.includes(t)) throw new Error(`Unknown ticker "${t}" — expected one of ${TICKERS.join(', ')}`);
  }

  const registry = JSON.parse(readFileSync(CONTRACTS_FILE, 'utf8'));
  const failures = [];

  for (const ticker of tickers) {
    try {
      const candidates = await fetchTicker(ticker);
      registry.tickers[ticker].candidates = candidates;
    } catch (err) {
      failures.push({ ticker, message: err.message });
      console.error(`${ticker}: FAILED — ${err.message}`);
    }
  }

  registry.generated_at = new Date().toISOString();
  writeFileSync(CONTRACTS_FILE, JSON.stringify(registry, null, 2) + '\n');
  console.log(`\nWrote ${CONTRACTS_FILE}`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} ticker(s) failed: ${failures.map((f) => f.ticker).join(', ')}`);
    process.exitCode = 1;
  }

  await disconnect();
}

main().catch(async (err) => {
  console.error('fetch_option_chain.mjs failed:', err);
  process.exitCode = 1;
  await disconnect();
});
