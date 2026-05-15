/**
 * Trader briefing orchestration.
 *
 * Single call that pulls market context, active-chart tape + indicators,
 * key levels, news, and (optional) watchlist scans into a structured
 * response suitable for an active-trader pre-market read.
 *
 * Workflow:
 *   1. Save current chart state (for restore)
 *   2. If symbol given, switch to it; wait for chart settle
 *   3. Pull chart state + study values + Pine levels in sequence
 *   4. Pull news (REST, parallel-safe)
 *   5. Pull market context via batch_run quote_get on macro symbols
 *   6. (Optional) Run watchlist screens for oversold/overextended
 *   7. Restore original chart state
 *   8. Return structured brief
 */
import { evaluate } from '../connection.js';
import { getState, setSymbol } from './chart.js';
import { getStudyValues, getQuote, getPineLines, getPineLabels } from './data.js';
import { getNews } from './news.js';
import { batchRun } from './batch.js';

const MACRO_SYMBOLS = ['AMEX:SPY', 'NASDAQ:QQQ', 'AMEX:IWM', 'TVC:VIX', 'TVC:DXY', 'TVC:US10Y'];

function parseNumeric(v) {
  if (v == null) return null;
  const cleaned = String(v).replace(/[,$\s]/g, '').replace(/[Kk]$/, 'e3').replace(/[Mm]$/, 'e6').replace(/[Bb]$/, 'e9');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function distillStudies(studies) {
  // Pull out the commonly-cared-about indicator readings into named fields.
  const out = {};
  for (const s of studies || []) {
    const name = (s.name || '').toLowerCase();
    if (name.includes('relative strength')) {
      out.rsi = parseNumeric(s.values?.RSI);
      out.rsi_ma = parseNumeric(s.values?.['RSI-based MA']);
    } else if (name.includes('macd') || name.includes('moving average convergence')) {
      out.macd = parseNumeric(s.values?.MACD);
      out.macd_signal = parseNumeric(s.values?.['Signal line']);
      out.macd_hist = parseNumeric(s.values?.Histogram);
    } else if (name === 'bollinger bands') {
      out.bb_basis = parseNumeric(s.values?.Basis);
      out.bb_upper = parseNumeric(s.values?.Upper);
      out.bb_lower = parseNumeric(s.values?.Lower);
    } else if (name.includes('average true range')) {
      out.atr = parseNumeric(s.values?.ATR);
    } else if (name === 'simple moving average' || name === 'moving average exponential') {
      // Multiple SMAs present — collect into an array of {value}
      out.mas = out.mas || [];
      const v = parseNumeric(s.values?.MA);
      if (v != null) out.mas.push(v);
    } else if (name.includes('volume delta') || name.includes('volume suite')) {
      out.volume_delta = parseNumeric(s.values?.['Volume Delta']);
    }
  }
  if (out.mas) out.mas.sort((a, b) => a - b); // ascending — typically 20 < 50 < 200
  return out;
}

function readSummary(distilled, last) {
  const reads = [];
  if (distilled.rsi != null) {
    if (distilled.rsi < 30) reads.push(`RSI ${distilled.rsi} OVERSOLD`);
    else if (distilled.rsi > 70) reads.push(`RSI ${distilled.rsi} OVERBOUGHT`);
    else if (distilled.rsi < 45) reads.push(`RSI ${distilled.rsi} weak`);
    else if (distilled.rsi > 55) reads.push(`RSI ${distilled.rsi} strong`);
    else reads.push(`RSI ${distilled.rsi} neutral`);
  }
  if (distilled.macd != null && distilled.macd_signal != null) {
    const cross = distilled.macd > distilled.macd_signal ? 'bull' : 'bear';
    reads.push(`MACD ${cross} (${distilled.macd.toFixed(2)}/${distilled.macd_signal.toFixed(2)})`);
  }
  if (distilled.bb_basis != null && last != null) {
    const bandwidth = distilled.bb_upper - distilled.bb_lower;
    const pos = (last - distilled.bb_lower) / bandwidth; // 0=lower, 1=upper
    if (pos < 0.2) reads.push('near BB-lower');
    else if (pos > 0.8) reads.push('near BB-upper');
    else if (Math.abs(pos - 0.5) < 0.1) reads.push('at BB-basis');
  }
  if (distilled.mas && last != null) {
    const above = distilled.mas.filter(m => last > m).length;
    if (above === distilled.mas.length) reads.push(`above all ${distilled.mas.length} MAs`);
    else if (above === 0) reads.push(`below all ${distilled.mas.length} MAs`);
    else reads.push(`above ${above}/${distilled.mas.length} MAs`);
  }
  return reads.join(' · ');
}

export async function traderBrief({
  symbol = null,
  news_count = 5,
  include_macro = true,
  include_pine_levels = true,
  restore_after = true,
} = {}) {
  // 1. Capture original state
  const original = await getState();

  // 2. Switch to requested symbol (or stay on current)
  let chartChanged = false;
  if (symbol && symbol !== original.symbol) {
    await setSymbol({ symbol });
    chartChanged = true;
    // setSymbol already waits for chart-ready
  }

  const activeSymbol = symbol || original.symbol;
  const bareSymbol = activeSymbol.includes(':') ? activeSymbol.split(':').pop() : activeSymbol;

  // 3. Chart state + tape + indicators (sequential, all needed)
  let chartState = null, quote = null, studies = null, pineLines = null, pineLabels = null;
  try { chartState = await getState(); } catch (e) { chartState = { error: e.message }; }
  try { quote = await getQuote({}); } catch (e) { quote = { error: e.message }; }
  try { studies = await getStudyValues(); } catch (e) { studies = { error: e.message }; }
  if (include_pine_levels) {
    try { pineLines = await getPineLines({}); } catch (e) { pineLines = { error: e.message }; }
    try { pineLabels = await getPineLabels({}); } catch (e) { pineLabels = { error: e.message }; }
  }

  const distilled = distillStudies(studies?.studies);
  const reads = readSummary(distilled, quote?.last);

  // 4. News (uses local yf bridge — doesn't touch chart)
  let news = null;
  try { news = await getNews({ symbol: bareSymbol, n: news_count }); }
  catch (e) { news = { error: e.message, items: [] }; }

  // 5. Macro context — batch_run is slow (~3-5s/symbol), gate behind flag
  let macro = null;
  if (include_macro) {
    try {
      const m = await batchRun({ symbols: MACRO_SYMBOLS, action: 'quote_get', delay_ms: 1200 });
      macro = m.results.map(r => ({
        symbol: r.symbol,
        last: r.result?.last,
        change_pct: r.result?.change_pct != null ? Math.round(r.result.change_pct * 100) / 100 : null,
      })).filter(r => r.last != null);
    } catch (e) { macro = { error: e.message }; }
  }

  // 6. Restore original chart
  if (restore_after && chartChanged && original?.symbol) {
    try { await setSymbol({ symbol: original.symbol }); } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    symbol: activeSymbol,
    chart_state: chartState,
    tape: quote ? {
      open: quote.open, high: quote.high, low: quote.low, last: quote.last,
      volume: quote.volume,
      description: quote.description,
      change: quote.change, change_pct: quote.change_pct,
    } : null,
    indicators: distilled,
    read: reads,
    pine: include_pine_levels ? {
      lines_count: pineLines?.study_count || 0,
      lines: pineLines?.studies || [],
      labels_count: pineLabels?.study_count || 0,
      labels: pineLabels?.studies || [],
      note: (pineLines?.study_count === 0 && pineLabels?.study_count === 0)
        ? 'No accessible Pine drawings (likely publisher-protected scripts). Levels derived from BB+SMA instead.'
        : undefined,
    } : null,
    derived_levels: distilled.bb_basis != null ? {
      bb_basis: distilled.bb_basis,
      bb_upper: distilled.bb_upper,
      bb_lower: distilled.bb_lower,
      mas: distilled.mas || [],
    } : null,
    news: news?.items?.slice(0, news_count) || [],
    macro,
    restored: restore_after && chartChanged,
  };
}
