#!/usr/bin/env node
import * as chart from "../src/core/chart.js";
import * as data from "../src/core/data.js";
import { disconnect } from "../src/connection.js";

const args = process.argv.slice(2);
const symbolArg = args.find((a) => a.startsWith("--symbols="));
const benchmarkArg = args.find((a) => a.startsWith("--benchmark="));
const symbols = symbolArg
  ? symbolArg.slice("--symbols=".length).split(",").map((s) => s.trim()).filter(Boolean)
  : ["NASDAQ:AAPL", "NASDAQ:TSLA", "NASDAQ:NFLX", "BITSTAMP:BTCUSD", "BITSTAMP:ETHUSD"];
const benchmark = benchmarkArg ? benchmarkArg.slice("--benchmark=".length) : "SP:SPX";

const settings = {
  breakTolerancePct: 0.2,
  highVolumeMultiplier: 1.2,
  pullbackLookback: 20,
  trendBreakLookback: 8,
  minStockAvgVolume20: 1_000_000,
  minStockPrice: 1,
};
const barTimeoutMs = Number(process.env.MTF_SCAN_BAR_TIMEOUT_MS || 20000);
const symbolTimeoutMs = Number(process.env.MTF_SCAN_SYMBOL_TIMEOUT_MS || 70000);

function n(v) {
  return Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`${label} timed out after ${ms}ms`);
      error.code = "ETIMEDOUT";
      reject(error);
    }, ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function sma(values, len) {
  if (values.length < len) return null;
  const slice = values.slice(-len);
  return slice.reduce((a, b) => a + b, 0) / len;
}

function ema(values, len) {
  if (values.length < len) return null;
  const k = 2 / (len + 1);
  let value = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  for (let i = len; i < values.length; i++) value = values[i] * k + value * (1 - k);
  return value;
}

function emaSeries(values, len) {
  const out = Array(values.length).fill(null);
  if (values.length < len) return out;
  let value = values.slice(0, len).reduce((a, b) => a + b, 0) / len;
  out[len - 1] = value;
  const k = 2 / (len + 1);
  for (let i = len; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out[i] = value;
  }
  return out;
}

function rsi(values, len = 14) {
  if (values.length <= len) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= len; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / len;
  let avgLoss = losses / len;
  for (let i = len + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (len - 1) + Math.max(change, 0)) / len;
    avgLoss = (avgLoss * (len - 1) + Math.max(-change, 0)) / len;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function rsiSeries(values, len = 14) {
  const out = Array(values.length).fill(null);
  if (values.length <= len) return out;
  for (let end = len + 1; end <= values.length; end++) {
    out[end - 1] = rsi(values.slice(0, end), len);
  }
  return out;
}

function atr(bars, len = 14) {
  if (bars.length <= len) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
    trs.push(tr);
  }
  return sma(trs, len);
}

function roc(values, len) {
  if (values.length <= len) return null;
  const base = values[values.length - 1 - len];
  return base ? ((values.at(-1) - base) / base) * 100 : null;
}

function lowestLow(bars, len, offset = 0) {
  const end = bars.length - offset;
  const start = Math.max(0, end - len);
  if (end <= start) return null;
  return Math.min(...bars.slice(start, end).map((b) => b.low));
}

function highestHigh(bars, len, offset = 1) {
  const end = bars.length - offset;
  const start = Math.max(0, end - len);
  if (end <= start) return null;
  return Math.max(...bars.slice(start, end).map((b) => b.high));
}

function barStats(bars) {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume || 0);
  return {
    last: bars.at(-1),
    prev: bars.at(-2),
    closes,
    volumes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    ema50Series: emaSeries(closes, 50),
    rsi14: rsi(closes, 14),
    rsiSeries: rsiSeries(closes, 14),
    atr14: atr(bars, 14),
    volumeMa20: sma(volumes, 20),
    roc20: roc(closes, 20),
    roc5: roc(closes, 5),
  };
}

async function getBars(symbol, timeframe, count) {
  await chart.setSymbol({ symbol });
  await waitForState({ symbol });
  await chart.setTimeframe({ timeframe });
  await waitForState({ symbol, timeframe });
  const result = await data.getOhlcv({ count, summary: false });
  return result.bars;
}

async function getBarsWithTimeout(symbol, timeframe, count, timeoutMs = barTimeoutMs) {
  try {
    return await withTimeout(getBars(symbol, timeframe, count), timeoutMs, `${symbol} ${timeframe} bars`);
  } catch (error) {
    if (error.code === "ETIMEDOUT") await disconnect().catch(() => {});
    throw error;
  }
}

function tickerPart(symbol) {
  return String(symbol).split(":").pop().toUpperCase();
}

async function waitForState({ symbol, timeframe } = {}, timeoutMs = 45000) {
  const wantTicker = symbol ? tickerPart(symbol) : null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await chart.getState();
      const gotTicker = tickerPart(state.symbol || "");
      const symbolOk = !wantTicker || gotTicker === wantTicker;
      const timeframeOk = !timeframe || normalizeTimeframe(state.resolution) === normalizeTimeframe(timeframe);
      if (symbolOk && timeframeOk) {
        await sleep(1200);
        return state;
      }
    } catch {}
    await sleep(500);
  }
  throw new Error(`Chart did not reach requested state symbol=${symbol || "*"} timeframe=${timeframe || "*"}`);
}

async function scanSymbol(symbol, benchmarkDaily) {
  return withTimeout((async () => {
    const daily = await getBarsWithTimeout(symbol, "D", 260);
    const h1 = await getBarsWithTimeout(symbol, "60", 160);
    const m15 = await getBarsWithTimeout(symbol, "15", 160);
    return evaluateSymbol(symbol, daily, h1, m15, benchmarkDaily);
  })(), symbolTimeoutMs, `${symbol} scan`);
}

function normalizeTimeframe(timeframe) {
  const value = String(timeframe).toUpperCase();
  if (value === "D") return "1D";
  return value;
}

function classifySymbol(symbol, daily) {
  const d = barStats(daily);
  const isStock = /NASDAQ:|NYSE:|AMEX:/i.test(symbol);
  const reasons = [];
  if (isStock && d.last.close < settings.minStockPrice) reasons.push("low_price");
  if (isStock && d.volumeMa20 != null && d.volumeMa20 < settings.minStockAvgVolume20) reasons.push("low_avg_volume20");
  if (d.roc5 != null && Math.abs(d.roc5) > 25) reasons.push("recent_vertical_move");
  if (d.prev && Math.abs((d.last.close - d.prev.close) / d.prev.close) > 0.12) reasons.push("abnormal_daily_move");
  return { excluded: reasons.length > 0, reasons };
}

function evaluateSymbol(symbol, daily, h1, m15, benchmarkDaily) {
  const d = barStats(daily);
  const h = barStats(h1);
  const t = barStats(m15);
  const b = barStats(benchmarkDaily);

  const bPrevClose = benchmarkDaily.at(-2)?.close;
  const bEma200Series = emaSeries(b.closes, 200);
  const benchBroken2 = b.last.close < b.ema200 && bPrevClose < bEma200Series.at(-2);
  const benchStrong2 = b.last.close > b.ema200 && bPrevClose > bEma200Series.at(-2);
  const ema50Up10 = d.ema50Series.at(-1) != null && d.ema50Series.at(-11) != null && d.ema50Series.at(-1) > d.ema50Series.at(-11);
  const ema50Down10 = d.ema50Series.at(-1) != null && d.ema50Series.at(-11) != null && d.ema50Series.at(-1) < d.ema50Series.at(-11);
  const relativeWeak20 = Number.isFinite(d.roc20) && Number.isFinite(b.roc20) && d.roc20 < b.roc20;
  const longBias =
    d.last.close > d.ema200 &&
    d.ema50 > d.ema200 &&
    d.ema20 > d.ema50 &&
    ema50Up10 &&
    d.roc20 > b.roc20 &&
    !benchBroken2;
  const shortBias =
    d.last.close < d.ema200 &&
    d.ema50 < d.ema200 &&
    d.ema20 < d.ema50 &&
    ema50Down10 &&
    d.roc20 < 0 &&
    (!benchStrong2 || relativeWeak20);

  const tolerance = settings.breakTolerancePct / 100;
  const nearOrBetween = h.last.close <= h.ema20 * 1.01 && h.last.close >= h.ema50 * (1 - tolerance);
  const rsiReset = h.rsi14 >= 40 && h.rsi14 <= 55;
  const highVolumeSelloff = h.last.close < h.prev.close && h.last.volume > h.volumeMa20 * settings.highVolumeMultiplier && h.last.close < h.ema20;
  const ema50Held = h.last.close >= h.ema50 * (1 - tolerance);
  const watchPullback = longBias && nearOrBetween && rsiReset && !highVolumeSelloff && ema50Held;
  const shortNearOrBetween = h.last.close >= h.ema20 * 0.99 && h.last.close <= h.ema50 * (1 + tolerance);
  const shortRsiReset = h.rsi14 >= 45 && h.rsi14 <= 60;
  const highVolumeBounce = h.last.close > h.prev.close && h.last.volume > h.volumeMa20 * settings.highVolumeMultiplier && h.last.close > h.ema20;
  const ema50Rejected = h.last.close <= h.ema50 * (1 + tolerance);
  const shortWatchPullback = shortBias && shortNearOrBetween && shortRsiReset && !highVolumeBounce && ema50Rejected;

  const priorPullbackLow = lowestLow(h1, settings.pullbackLookback, 1);
  const priorPullbackHigh = highestHigh(h1, settings.pullbackLookback, 1);
  const hBreakout = h.last.close > highestHigh(h1, settings.trendBreakLookback, 1);
  const tBreakout = t.last.close > highestHigh(m15, settings.trendBreakLookback, 1);
  const hBreakdown = h.last.close < lowestLow(h1, settings.trendBreakLookback, 1);
  const tBreakdown = t.last.close < lowestLow(m15, settings.trendBreakLookback, 1);
  const tRsiPrev = t.rsiSeries.at(-2);
  const tRsiCross50 = tRsiPrev != null && tRsiPrev <= 50 && t.rsi14 > 50;
  const tRsiCross50Down = tRsiPrev != null && tRsiPrev >= 50 && t.rsi14 < 50;
  const conservative = watchPullback && t.last.close > t.ema20 && tRsiCross50 && t.last.close > t.prev.high && t.last.volume > t.volumeMa20;
  const aggressive = longBias && nearOrBetween && t.last.close > priorPullbackLow && (tBreakout || hBreakout) && t.rsi14 > 50;
  const shortConservative = shortWatchPullback && t.last.close < t.ema20 && tRsiCross50Down && t.last.close < t.prev.low && t.last.volume > t.volumeMa20;
  const shortAggressive = shortBias && shortNearOrBetween && t.last.close < priorPullbackHigh && (tBreakdown || hBreakdown) && t.rsi14 < 50;

  const sellInvalidated =
    h.last.close < priorPullbackLow ||
    h.last.close < h.ema50 * (1 - tolerance) ||
    (h.rsi14 < 40 && h.last.close < h.ema20) ||
    benchBroken2;
  const buyInvalidated =
    h.last.close > priorPullbackHigh ||
    h.last.close > h.ema50 * (1 + tolerance) ||
    (h.rsi14 > 60 && h.last.close > h.ema20) ||
    benchStrong2;

  const plannedEntry = t.last.close;
  const plannedLongStop = Math.min(priorPullbackLow - 0.5 * h.atr14, plannedEntry - 2 * t.atr14);
  const plannedLongR = plannedEntry - plannedLongStop;
  const plannedShortStop = Math.max(priorPullbackHigh + 0.5 * h.atr14, plannedEntry + 2 * t.atr14);
  const plannedShortR = plannedShortStop - plannedEntry;

  const liquidity = classifySymbol(symbol, daily);
  let status = "NO_TRADE";
  let tradeSide = "NONE";
  if (liquidity.excluded) status = "NO_TRADE";
  else if (conservative) { status = "BUY_TRIGGER_CONSERVATIVE"; tradeSide = "LONG"; }
  else if (aggressive) { status = "BUY_TRIGGER_AGGRESSIVE"; tradeSide = "LONG"; }
  else if (shortConservative) { status = "SHORT_TRIGGER_CONSERVATIVE"; tradeSide = "SHORT"; }
  else if (shortAggressive) { status = "SHORT_TRIGGER_AGGRESSIVE"; tradeSide = "SHORT"; }
  else if (watchPullback) { status = "WATCH_PULLBACK"; tradeSide = "LONG"; }
  else if (shortWatchPullback) { status = "SHORT_WATCH_PULLBACK"; tradeSide = "SHORT"; }
  else if (longBias && sellInvalidated) { status = "SELL_INVALIDATED"; tradeSide = "LONG"; }
  else if (shortBias && buyInvalidated) { status = "BUY_INVALIDATED"; tradeSide = "SHORT"; }

  const isShort = tradeSide === "SHORT";
  const plannedStop = isShort ? plannedShortStop : plannedLongStop;
  const plannedR = isShort ? plannedShortR : plannedLongR;
  const target1 = isShort ? plannedEntry - plannedR : plannedEntry + plannedR;
  const target2 = isShort ? plannedEntry - plannedR * 2 : plannedEntry + plannedR * 2;

  return {
    symbol,
    status,
    trade_side: tradeSide,
    excluded: liquidity.excluded,
    exclusion_reasons: liquidity.reasons,
    trend_condition: {
      long_bias: longBias,
      short_bias: shortBias,
      daily_close_gt_ema200: d.last.close > d.ema200,
      daily_close_lt_ema200: d.last.close < d.ema200,
      ema50_gt_ema200: d.ema50 > d.ema200,
      ema50_lt_ema200: d.ema50 < d.ema200,
      ema20_gt_ema50: d.ema20 > d.ema50,
      ema20_lt_ema50: d.ema20 < d.ema50,
      ema50_slope_10_up: ema50Up10,
      ema50_slope_10_down: ema50Down10,
      relative_weak_20d_vs_benchmark: relativeWeak20,
      relative_strength_20d_vs_benchmark: n(d.roc20 - b.roc20),
      benchmark_strong_2d: benchStrong2,
      benchmark_above_ema200: b.last.close > b.ema200,
    },
    setup_condition: {
      near_or_between_ema20_ema50: nearOrBetween,
      rsi_reset_40_55: rsiReset,
      no_high_volume_selloff: !highVolumeSelloff,
      ema50_held: ema50Held,
      short_near_or_between_ema20_ema50: shortNearOrBetween,
      short_rsi_reset_45_60: shortRsiReset,
      no_high_volume_bounce: !highVolumeBounce,
      ema50_rejected: ema50Rejected,
    },
    trigger_condition: {
      conservative,
      aggressive,
      short_conservative: shortConservative,
      short_aggressive: shortAggressive,
      trigger_close_gt_ema20: t.last.close > t.ema20,
      trigger_close_lt_ema20: t.last.close < t.ema20,
      trigger_rsi_cross_50: tRsiCross50,
      trigger_rsi_cross_50_down: tRsiCross50Down,
      trigger_breaks_prior_high: t.last.close > t.prev.high,
      trigger_breaks_prior_low: t.last.close < t.prev.low,
      trigger_volume_gt_ma20: t.last.volume > t.volumeMa20,
    },
    risk_plan: {
      entry_price: n(plannedEntry),
      stop_price: n(plannedStop),
      R_value: n(plannedR),
      target_1: n(target1),
      target_2: n(target2),
      atr14_1h: n(h.atr14),
      atr14_15m: n(t.atr14),
    },
    metrics: {
      daily_close: n(d.last.close),
      daily_ema20: n(d.ema20),
      daily_ema50: n(d.ema50),
      daily_ema200: n(d.ema200),
      rsi14_1h: n(h.rsi14),
      rsi14_15m: n(t.rsi14),
      volume_ma20_15m: n(t.volumeMa20),
      last_volume_15m: n(t.last.volume),
    },
  };
}

let original;
try {
  original = await chart.getState();
  const benchmarkDaily = await getBarsWithTimeout(benchmark, "D", 260, Math.max(barTimeoutMs, 45000));
  const results = [];
  for (const symbol of symbols) {
    try {
      console.error(`Scanning ${symbol}...`);
      results.push(await scanSymbol(symbol, benchmarkDaily));
    } catch (error) {
      if (error.code === "ETIMEDOUT") await disconnect().catch(() => {});
      results.push({ symbol, status: "NO_TRADE", error: error.message });
    }
  }
  if (original?.symbol) {
    try {
      await chart.setSymbol({ symbol: original.symbol });
      await chart.setTimeframe({ timeframe: original.resolution });
    } catch {}
  }
  console.log(JSON.stringify({
    success: true,
    generated_at: new Date().toISOString(),
    strategy: "MTF Trend Pullback + ATR Risk System",
    benchmark,
    symbols_scanned: symbols.length,
    results,
  }, null, 2));
} finally {
  await disconnect();
}
