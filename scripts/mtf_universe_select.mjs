#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as chart from "../src/core/chart.js";
import * as data from "../src/core/data.js";
import { disconnect } from "../src/connection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const configPath = resolve(root, "config", "mtf_paper_config.json");
const defaultUniversePath = resolve(root, "config", "universe.default.json");
const dataDir = resolve(root, "paper-data");
const latestCandidatesPath = resolve(dataDir, "latest-candidates.json");
const latestCandidatesProgressPath = resolve(dataDir, "latest-candidates-progress.json");

const args = process.argv.slice(2);
const config = readJson(configPath, {});
const universePath = resolve(root, argValue("--universe", config.universe_path || defaultUniversePath));
const benchmark = argValue("--benchmark", config.benchmark || "SP:SPX");
const topN = Number(argValue("--top", config.preselect_top_n || config.max_symbols_per_run || 8));
const maxSymbols = Number(argValue("--max", config.preselect_max_symbols || 120));
const minScore = Number(argValue("--min-score", config.preselect_min_score ?? 0));
const symbolsArg = argValue("--symbols", null);
const saveLatest = args.includes("--save-latest");
let loadedUniverseTotal = 0;
let rotationOffset = 0;

const settings = {
  minStockAvgVolume20: Number(config.preselect_min_stock_avg_volume20 || 1_000_000),
  minStockPrice: Number(config.preselect_min_stock_price || 5),
  maxAtrPct: Number(config.preselect_max_atr_pct || 12),
  minAtrPct: Number(config.preselect_min_atr_pct || 0.5),
};
const symbolTimeoutMs = Number(config.preselect_symbol_timeout_ms || 30_000);
const benchmarkTimeoutMs = Number(config.preselect_benchmark_timeout_ms || 45_000);
const benchmarkByAssetClass = {
  stock: benchmark,
  etf: benchmark,
  crypto: "BITSTAMP:BTCUSD",
  forex: "TVC:DXY",
  commodity: "TVC:GOLD",
  ...(config.benchmark_by_asset_class || {}),
};
const fallbackBenchmarkByAssetClass = {
  crypto: "BITSTAMP:ETHUSD",
  commodity: "TVC:SILVER",
  ...(config.fallback_benchmark_by_asset_class || {}),
};

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const hit = args.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function n(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function uniqueSymbols(symbols) {
  const seen = new Set();
  const exclude = new Set((config.exclude_symbols || []).map((symbol) => symbol.toUpperCase()));
  const prefixes = config.exclude_prefixes || [];
  return (symbols || []).map((symbol) => String(symbol).trim()).filter(Boolean).filter((symbol) => {
    const upper = symbol.toUpperCase();
    if (seen.has(upper)) return false;
    seen.add(upper);
    if (exclude.has(upper)) return false;
    if (upper === benchmark.toUpperCase()) return false;
    if (prefixes.some((prefix) => upper.startsWith(prefix.toUpperCase()))) return false;
    return true;
  });
}

function loadUniverseSymbols() {
  const universe = readJson(universePath, { symbols: [] });
  let symbols = symbolsArg ? uniqueSymbols(symbolsArg.split(",")) : uniqueSymbols(universe.symbols || []);
  const allocationInfo = activeAllocation();
  if (allocationInfo.strict && config.preselect_filter_unallocated_classes !== false) {
    const allowed = new Set(Object.entries(allocationInfo.allocation)
      .filter(([, quota]) => Number(quota || 0) > 0)
      .map(([cls]) => cls));
    if (allowed.size) symbols = symbols.filter((symbol) => allowed.has(assetClass(symbol)));
  }
  loadedUniverseTotal = symbols.length;

  const rotate = !symbolsArg && config.preselect_rotate_universe !== false && symbols.length > maxSymbols;
  if (rotate) {
    const minutes = Math.max(15, Number(config.preselect_rotation_minutes || 60));
    const bucket = Math.floor(Date.now() / (minutes * 60 * 1000));
    rotationOffset = (bucket * maxSymbols) % symbols.length;
    symbols = symbols.slice(rotationOffset).concat(symbols.slice(0, rotationOffset));
  }

  return symbols.slice(0, maxSymbols);
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

function tickerPart(symbol) {
  return String(symbol).split(":").pop().toUpperCase();
}

function normalizeTimeframe(timeframe) {
  const value = String(timeframe).toUpperCase();
  if (value === "D") return "1D";
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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

function rawCandidateSlice(results, limit = topN) {
  return results
    .filter((result) => result.status === "CANDIDATE")
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function candidateSlice(results, limit = topN) {
  if (!config.preselect_diversify) return rawCandidateSlice(results, limit);

  const pool = rawCandidateSlice(results, results.length);
  const allocationInfo = activeAllocation();
  const allocation = allocationInfo.allocation;
  const strict = allocationInfo.strict;
  const selected = [];
  const seen = new Set();

  for (const [cls, quotaRaw] of Object.entries(allocation)) {
    const quota = Math.max(0, Number(quotaRaw || 0));
    if (!quota) continue;
    for (const candidate of pool.filter((item) => item.asset_class === cls).slice(0, quota)) {
      if (seen.has(candidate.symbol)) continue;
      selected.push(candidate);
      seen.add(candidate.symbol);
      if (selected.length >= limit) return selected;
    }
  }

  const allowed = new Set(Object.entries(allocation).filter(([, quota]) => Number(quota || 0) > 0).map(([cls]) => cls));
  for (const candidate of pool) {
    if (seen.has(candidate.symbol)) continue;
    if (strict && allowed.size && !allowed.has(candidate.asset_class)) continue;
    selected.push(candidate);
    seen.add(candidate.symbol);
    if (selected.length >= limit) break;
  }

  return selected;
}

function isWeekendMode(date = new Date()) {
  if (config.preselect_force_weekend_mode === true) return true;
  if (config.preselect_force_weekend_mode === false) return false;
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function activeAllocation() {
  const weekend = isWeekendMode();
  const normalAllocation = config.preselect_allocation || {
    stock: 3,
    etf: 1,
    crypto: 3,
    forex: 2,
    commodity: 1,
  };
  const weekendAllocation = config.preselect_weekend_allocation || { crypto: topN };
  const allocation = weekend ? weekendAllocation : normalAllocation;
  return {
    allocation,
    mode: weekend ? "weekend_24h" : "multi_asset",
    strict: weekend ? config.preselect_weekend_allocation_strict !== false : Boolean(config.preselect_allocation_strict),
  };
}

function activeMinScore() {
  const allocationInfo = activeAllocation();
  if (allocationInfo.mode === "weekend_24h" && config.preselect_weekend_min_score != null) {
    return Number(config.preselect_weekend_min_score);
  }
  return minScore;
}

function countStatuses(results) {
  const counts = {};
  for (const result of results || []) {
    const key = result.status || "UNKNOWN";
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function writeProgress(payload) {
  if (!saveLatest) return;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(latestCandidatesProgressPath, JSON.stringify(payload, null, 2), "utf8");
}

async function getDailyBarsWithTimeout(symbol, count, timeoutMs) {
  try {
    return await withTimeout(getDailyBars(symbol, count), timeoutMs, `Daily data for ${symbol}`);
  } catch (error) {
    if (error.code === "ETIMEDOUT") {
      await disconnect().catch(() => {});
    }
    throw error;
  }
}

async function waitForState({ symbol, timeframe } = {}, timeoutMs = 20000) {
  const wantTicker = symbol ? tickerPart(symbol) : null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const state = await chart.getState();
      const gotTicker = tickerPart(state.symbol || "");
      const symbolOk = !wantTicker || gotTicker === wantTicker;
      const timeframeOk = !timeframe || normalizeTimeframe(state.resolution) === normalizeTimeframe(timeframe);
      if (symbolOk && timeframeOk) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
        return state;
      }
    } catch {}
    await sleep(300);
  }
  throw new Error(`Chart did not reach requested state symbol=${symbol || "*"} timeframe=${timeframe || "*"}`);
}

async function getDailyBars(symbol, count = 260) {
  await chart.setSymbol({ symbol });
  await waitForState({ symbol });
  await chart.setTimeframe({ timeframe: "D" });
  await waitForState({ symbol, timeframe: "D" });
  const result = await data.getOhlcv({ count, summary: false });
  return result.bars;
}

function assetClass(symbol) {
  if (/BITSTAMP:|BINANCE:/i.test(symbol)) return "crypto";
  if (/^FX:/i.test(symbol)) return "forex";
  if (/^TVC:/i.test(symbol)) return "commodity";
  if (/AMEX:SPY|NASDAQ:QQQ|AMEX:IWM|AMEX:DIA|AMEX:SMH|AMEX:XL|AMEX:GLD|AMEX:SLV|AMEX:USO|NASDAQ:TLT/i.test(symbol)) return "etf";
  return "stock";
}

function benchmarkForSymbol(symbol) {
  const cls = assetClass(symbol);
  let selected = benchmarkByAssetClass[cls] || benchmark;
  if (selected && selected.toUpperCase() === symbol.toUpperCase()) {
    selected = fallbackBenchmarkByAssetClass[cls] || benchmark;
  }
  return selected || benchmark;
}

function barStats(bars) {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume || 0);
  const ema50Values = emaSeries(closes, 50);
  const atr14 = atr(bars, 14);
  const close = closes.at(-1);
  const recent60 = bars.slice(-60);
  const high60 = Math.max(...recent60.map((bar) => bar.high));
  const low60 = Math.min(...recent60.map((bar) => bar.low));
  return {
    last: bars.at(-1),
    prev: bars.at(-2),
    closes,
    volumes,
    ema20: ema(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    ema50Series: ema50Values,
    rsi14: rsi(closes, 14),
    atr14,
    atr_pct: close && atr14 ? (atr14 / close) * 100 : null,
    volumeMa20: sma(volumes, 20),
    roc20: roc(closes, 20),
    roc60: roc(closes, 60),
    distance_from_60d_high_pct: close && high60 ? ((close - high60) / high60) * 100 : null,
    distance_from_60d_low_pct: close && low60 ? ((close - low60) / low60) * 100 : null,
  };
}

function scoreSymbol(symbol, bars, benchmarkBars, benchmarkSymbol = benchmark) {
  const d = barStats(bars);
  const b = barStats(benchmarkBars);
  const cls = assetClass(symbol);
  const isStockLike = cls === "stock" || cls === "etf";
  const basePenalties = [];

  if (!d.last || d.closes.length < 220) {
    return { symbol, asset_class: cls, score: -999, status: "REJECT", reasons: ["insufficient_history"] };
  }

  if (isStockLike && d.last.close < settings.minStockPrice) basePenalties.push("low_price");
  if (cls === "stock" && d.volumeMa20 != null && d.volumeMa20 < settings.minStockAvgVolume20) basePenalties.push("low_avg_volume20");
  if (d.atr_pct != null && d.atr_pct > settings.maxAtrPct) basePenalties.push("atr_too_high");
  if (d.atr_pct != null && d.atr_pct < settings.minAtrPct && cls !== "forex") basePenalties.push("atr_too_low");

  const ema50Up = d.ema50Series.at(-1) != null && d.ema50Series.at(-11) != null && d.ema50Series.at(-1) > d.ema50Series.at(-11);
  const ema50Down = d.ema50Series.at(-1) != null && d.ema50Series.at(-11) != null && d.ema50Series.at(-1) < d.ema50Series.at(-11);
  const rs20 = Number.isFinite(d.roc20) && Number.isFinite(b.roc20) ? d.roc20 - b.roc20 : null;
  const rs60 = Number.isFinite(d.roc60) && Number.isFinite(b.roc60) ? d.roc60 - b.roc60 : null;

  const longReasons = [];
  const longPenalties = [...basePenalties];
  let longScore = 0;
  if (d.last.close > d.ema200) { longScore += 20; longReasons.push("above_ema200"); } else longPenalties.push("below_ema200");
  if (d.ema50 > d.ema200) { longScore += 15; longReasons.push("ema50_above_ema200"); }
  if (d.ema20 > d.ema50) { longScore += 15; longReasons.push("ema20_above_ema50"); }
  if (ema50Up) { longScore += 10; longReasons.push("ema50_slope_up"); }
  if (rs20 != null && rs20 > 0) { longScore += Math.min(15, rs20); longReasons.push("rs20_positive"); }
  if (rs60 != null && rs60 > 0) { longScore += Math.min(15, rs60 / 2); longReasons.push("rs60_positive"); }
  if (d.rsi14 != null && d.rsi14 >= 45 && d.rsi14 <= 68) { longScore += 10; longReasons.push("rsi_constructive"); }
  else if (d.rsi14 != null && d.rsi14 > 78) { longScore -= 8; longPenalties.push("rsi_overheated"); }
  if (d.distance_from_60d_high_pct != null && d.distance_from_60d_high_pct > -12) { longScore += 8; longReasons.push("near_60d_high"); }
  if (d.atr_pct != null && d.atr_pct >= settings.minAtrPct && d.atr_pct <= settings.maxAtrPct) { longScore += 7; longReasons.push("atr_in_range"); }
  longScore -= longPenalties.length * 12;

  const shortReasons = [];
  const shortPenalties = [...basePenalties];
  let shortScore = 0;
  if (d.last.close < d.ema200) { shortScore += 20; shortReasons.push("below_ema200"); } else shortPenalties.push("above_ema200");
  if (d.ema50 < d.ema200) { shortScore += 15; shortReasons.push("ema50_below_ema200"); }
  if (d.ema20 < d.ema50) { shortScore += 15; shortReasons.push("ema20_below_ema50"); }
  if (ema50Down) { shortScore += 10; shortReasons.push("ema50_slope_down"); }
  if (d.roc20 != null && d.roc20 < 0) { shortScore += Math.min(15, Math.abs(d.roc20)); shortReasons.push("roc20_negative"); }
  if (rs20 != null && rs20 < 0) { shortScore += Math.min(15, Math.abs(rs20)); shortReasons.push("rs20_negative"); }
  if (rs60 != null && rs60 < 0) { shortScore += Math.min(15, Math.abs(rs60) / 2); shortReasons.push("rs60_negative"); }
  if (d.rsi14 != null && d.rsi14 >= 32 && d.rsi14 <= 55) { shortScore += 10; shortReasons.push("rsi_bearish_reset"); }
  else if (d.rsi14 != null && d.rsi14 < 22) { shortScore -= 8; shortPenalties.push("rsi_oversold"); }
  if (d.distance_from_60d_low_pct != null && d.distance_from_60d_low_pct < 12) { shortScore += 8; shortReasons.push("near_60d_low"); }
  if (d.atr_pct != null && d.atr_pct >= settings.minAtrPct && d.atr_pct <= settings.maxAtrPct) { shortScore += 7; shortReasons.push("atr_in_range"); }
  shortScore -= shortPenalties.length * 12;

  const side = shortScore > longScore ? "SHORT" : "LONG";
  const score = side === "SHORT" ? shortScore : longScore;
  const reasons = side === "SHORT" ? shortReasons : longReasons;
  const penalties = side === "SHORT" ? shortPenalties : longPenalties;
  const hardReject = penalties.includes("low_price") || penalties.includes("low_avg_volume20");
  const status = hardReject || score < activeMinScore() ? "REJECT" : "CANDIDATE";

  return {
    symbol,
    asset_class: cls,
    benchmark: benchmarkSymbol,
    side,
    status,
    score: n(score, 2),
    long_score: n(longScore, 2),
    short_score: n(shortScore, 2),
    reasons,
    penalties,
    metrics: {
      close: n(d.last.close),
      ema20: n(d.ema20),
      ema50: n(d.ema50),
      ema200: n(d.ema200),
      rsi14: n(d.rsi14),
      atr_pct: n(d.atr_pct),
      roc20: n(d.roc20),
      roc60: n(d.roc60),
      relative_strength_20d_vs_benchmark: n(rs20),
      relative_strength_60d_vs_benchmark: n(rs60),
      avg_volume20: n(d.volumeMa20, 0),
      distance_from_60d_high_pct: n(d.distance_from_60d_high_pct),
      distance_from_60d_low_pct: n(d.distance_from_60d_low_pct),
    },
  };
}

async function main() {
  const startedAt = new Date().toISOString();
  const allocationInfo = activeAllocation();
  const original = await chart.getState().catch(() => null);
  const symbols = loadUniverseSymbols();
  if (!symbols.length) throw new Error(`No universe symbols found in ${universePath}`);

  const results = [];
  writeProgress({
    success: true,
    phase: "benchmark",
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    universe_path: universePath,
    benchmark,
    selection_mode: allocationInfo.mode,
    allocation: allocationInfo.allocation,
    min_score: activeMinScore(),
    universe_total_symbols: loadedUniverseTotal,
    rotation_offset: rotationOffset,
    symbols_considered: symbols.length,
    completed: 0,
    current_symbol: benchmark,
    status_counts: {},
    candidates: [],
  });

  const benchmarkBarsBySymbol = new Map();
  async function getBenchmarkBarsForSymbol(symbol) {
    const selectedBenchmark = benchmarkForSymbol(symbol);
    const key = selectedBenchmark.toUpperCase();
    if (!benchmarkBarsBySymbol.has(key)) {
      benchmarkBarsBySymbol.set(key, await getDailyBarsWithTimeout(selectedBenchmark, 260, benchmarkTimeoutMs));
    }
    return { benchmarkSymbol: selectedBenchmark, bars: benchmarkBarsBySymbol.get(key) };
  }

  for (let index = 0; index < symbols.length; index++) {
    const symbol = symbols[index];
    try {
      console.error(`Preselecting ${index + 1}/${symbols.length} ${symbol}...`);
      writeProgress({
        success: true,
        phase: "scanning",
        generated_at: new Date().toISOString(),
        started_at: startedAt,
        universe_path: universePath,
        benchmark,
        selection_mode: allocationInfo.mode,
        allocation: allocationInfo.allocation,
        min_score: activeMinScore(),
        universe_total_symbols: loadedUniverseTotal,
        rotation_offset: rotationOffset,
        symbols_considered: symbols.length,
        completed: index,
        current_symbol: symbol,
        status_counts: countStatuses(results),
        candidates: candidateSlice(results),
      });
      const bars = await getDailyBarsWithTimeout(symbol, 260, symbolTimeoutMs);
      const symbolBenchmark = await getBenchmarkBarsForSymbol(symbol);
      results.push(scoreSymbol(symbol, bars, symbolBenchmark.bars, symbolBenchmark.benchmarkSymbol));
    } catch (error) {
      results.push({ symbol, status: "ERROR", score: -999, error: error.message });
    }
    writeProgress({
      success: true,
      phase: "scanning",
      generated_at: new Date().toISOString(),
      started_at: startedAt,
      universe_path: universePath,
      benchmark,
      selection_mode: allocationInfo.mode,
      allocation: allocationInfo.allocation,
      min_score: activeMinScore(),
      universe_total_symbols: loadedUniverseTotal,
      rotation_offset: rotationOffset,
      symbols_considered: symbols.length,
      completed: index + 1,
      current_symbol: symbol,
      status_counts: countStatuses(results),
      candidates: candidateSlice(results),
    });
  }

  const candidates = candidateSlice(results);

  const output = {
    success: true,
    generated_at: new Date().toISOString(),
    started_at: startedAt,
    universe_path: universePath,
    benchmark,
    selection_mode: allocationInfo.mode,
    allocation: allocationInfo.allocation,
    allocation_strict: allocationInfo.strict,
    min_score: activeMinScore(),
    universe_total_symbols: loadedUniverseTotal,
    rotation_offset: rotationOffset,
    symbols_considered: symbols.length,
    candidates_requested: topN,
    candidates,
    results: results.sort((a, b) => b.score - a.score),
  };

  if (saveLatest) {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(latestCandidatesPath, JSON.stringify(output, null, 2), "utf8");
    writeProgress({
      ...output,
      phase: "complete",
      completed: symbols.length,
      current_symbol: null,
      status_counts: countStatuses(results),
    });
  }

  if (original?.symbol) {
    try {
      await chart.setSymbol({ symbol: original.symbol });
      await chart.setTimeframe({ timeframe: original.resolution });
    } catch {}
  }

  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(JSON.stringify({ success: false, error: error.message }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnect();
  });
