#!/usr/bin/env node
/**
 * VWAP + Volume Profile Intraday Analyzer
 *
 * Connects to TradingView via MCP tools (CDP port 9222) and produces
 * a structured trade plan based on rules.json.
 *
 * Usage:  node intraday-analyzer.js
 *         node intraday-analyzer.js --symbol NIFTY1!
 *         node intraday-analyzer.js --timeframe 5
 *
 * This script is meant to be run alongside Claude Code + TradingView MCP.
 * It reads chart data through the MCP server's tool handlers.
 */

import { readFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const rules = JSON.parse(
  readFileSync(new URL("rules.json", import.meta.url), "utf8")
);

// ── CLI args ────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}
const SYMBOL = flag("symbol") || rules.watchlist[0];
const TIMEFRAME = flag("timeframe") || rules.default_timeframe;

// ── MCP client ──────────────────────────────────────────────────
let client;

async function connect() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/server.js"],
  });
  client = new Client({ name: "intraday-analyzer", version: "1.0.0" });
  await client.connect(transport);
}

async function call(tool, params = {}) {
  const result = await client.callTool({ name: tool, arguments: params });
  const text = result.content?.find((c) => c.type === "text")?.text;
  return text ? JSON.parse(text) : result;
}

// ── Data collection ─────────────────────────────────────────────
async function gatherData() {
  const [quote, state] = await Promise.all([
    call("quote_get"),
    call("chart_get_state"),
  ]);

  const [studyValues, ohlcvSummary, ohlcvBars] = await Promise.all([
    call("data_get_study_values"),
    call("data_get_ohlcv", { count: 50, summary: true }),
    call("data_get_ohlcv", { count: 20 }),
  ]);

  let pineLines = null;
  let pineLabels = null;
  let pineTables = null;
  try {
    [pineLines, pineLabels, pineTables] = await Promise.all([
      call("data_get_pine_lines"),
      call("data_get_pine_labels"),
      call("data_get_pine_tables"),
    ]);
  } catch {
    // Pine graphics may not be available if no custom indicators
  }

  return { quote, state, studyValues, ohlcvSummary, ohlcvBars, pineLines, pineLabels, pineTables };
}

// ── Analysis engine ─────────────────────────────────────────────
function analyzeVWAP(data) {
  const { quote, studyValues } = data;
  const price = quote?.last ?? quote?.close;
  const studies = studyValues?.studies || [];

  let vwap = null;
  let upperBand1 = null;
  let lowerBand1 = null;
  let upperBand2 = null;
  let lowerBand2 = null;

  function parseNum(s) {
    return Number(String(s).replace(/,/g, "").replace(/[^\d.\-]/g, ""));
  }

  for (const study of studies) {
    const nameLower = (study.name || "").toLowerCase();
    const vals = study.values || {};
    const keysLower = Object.keys(vals).map((k) => k.toLowerCase());
    const nameMatch = nameLower.includes("vwap") || nameLower.includes("anchored");
    const keyMatch = keysLower.some((k) => k.includes("vwap"));

    if (nameMatch || keyMatch) {
      const entries = Object.entries(vals);
      const vwapEntry = entries.find(([k]) => k.toLowerCase().includes("vwap"));
      if (vwapEntry) {
        vwap = parseNum(vwapEntry[1]);
      }
      for (const [k, v] of entries) {
        const kl = k.toLowerCase();
        if (kl.includes("vwap")) continue;
        const n = parseNum(v);
        if (isNaN(n)) continue;
        if ((kl.includes("inner") || kl.includes("1")) && kl.includes("upper")) upperBand1 = n;
        else if ((kl.includes("inner") || kl.includes("1")) && kl.includes("lower")) lowerBand1 = n;
        else if ((kl.includes("outer") || kl.includes("2")) && kl.includes("upper")) upperBand2 = n;
        else if ((kl.includes("outer") || kl.includes("2")) && kl.includes("lower")) lowerBand2 = n;
        else if (kl.includes("upper") && !upperBand1) upperBand1 = n;
        else if (kl.includes("lower") && !lowerBand1) lowerBand1 = n;
      }
      if (!vwap && !upperBand1 && !lowerBand1) {
        const allNums = entries.map(([, v]) => parseNum(v)).filter((n) => !isNaN(n));
        if (allNums.length >= 1) vwap = allNums[0];
      }
    }
  }

  if (!vwap || !price) {
    return { position: "unknown", vwap: null, price, distPct: null };
  }

  const distPct = ((price - vwap) / vwap) * 100;
  let position;
  if (upperBand2 && price >= upperBand2) position = "extended_above_2σ";
  else if (upperBand1 && price >= upperBand1) position = "above_1σ";
  else if (price > vwap) position = "above_vwap";
  else if (lowerBand2 && price <= lowerBand2) position = "extended_below_2σ";
  else if (lowerBand1 && price <= lowerBand1) position = "below_1σ";
  else position = "below_vwap";

  return { position, vwap, price, distPct: distPct.toFixed(2), upperBand1, lowerBand1, upperBand2, lowerBand2 };
}

function analyzeVolumeProfile(data) {
  const { pineLines, pineLabels, pineTables, studyValues } = data;
  const levels = { poc: null, vah: null, val: null, hvns: [], lvns: [] };
  const context = { dayType: null, trend: null, priceZone: null, ibPosition: null, yPOC: null };

  function parseNum(s) {
    return Number(String(s).replace(/,/g, "").replace(/[^\d.\-]/g, ""));
  }

  // Primary: parse pine tables (WillyAlgo format: "POC | 80730.0")
  if (pineTables?.studies) {
    for (const study of Object.values(pineTables.studies)) {
      const tables = study.tables || (Array.isArray(study) ? study : []);
      for (const table of tables) {
        for (const row of (table.rows || [])) {
          const [key, val] = String(row).split("|").map((s) => s.trim());
          if (!key || !val) continue;
          const kl = key.toLowerCase();
          if (kl === "poc") levels.poc = parseNum(val);
          else if (kl === "vah") levels.vah = parseNum(val);
          else if (kl === "val") levels.val = parseNum(val);
          else if (kl === "day type") context.dayType = val;
          else if (kl === "trend") context.trend = val;
          else if (kl === "price zone") context.priceZone = val;
          else if (kl === "ib position") context.ibPosition = val;
        }
      }
    }
  }

  // Fallback: check pine labels for POC/VAH/VAL text
  const allLabels = [];
  if (pineLabels?.studies) {
    for (const study of Object.values(pineLabels.studies)) {
      if (Array.isArray(study)) allLabels.push(...study);
      else if (study.labels) allLabels.push(...study.labels);
    }
  }

  for (const label of allLabels) {
    const txt = (label.text || label.label || "").toUpperCase();
    const price = label.price ?? label.y;
    if (!levels.poc && txt.includes("POC") && !txt.includes("YPOC")) levels.poc = price;
    else if (!levels.vah && txt.includes("VAH")) levels.vah = price;
    else if (!levels.val && txt.includes("VAL") && !txt.includes("VALUE")) levels.val = price;
    else if (txt.includes("HVN")) levels.hvns.push(price);
    else if (txt.includes("LVN")) levels.lvns.push(price);
    else if (txt === "YPOC" || txt.includes("YPOC")) context.yPOC = price;
  }

  // Fallback: check study values for POC/VAH/VAL keys
  if (!levels.poc || !levels.vah || !levels.val) {
    for (const study of (studyValues?.studies || [])) {
      for (const [k, v] of Object.entries(study.values || {})) {
        const kl = k.toLowerCase();
        const n = parseNum(v);
        if (isNaN(n)) continue;
        if (!levels.poc && kl.includes("poc")) levels.poc = n;
        else if (!levels.vah && kl.includes("vah")) levels.vah = n;
        else if (!levels.val && kl.includes("val") && !kl.includes("value")) levels.val = n;
      }
    }
  }

  return { ...levels, context };
}

function analyzePriceAction(data) {
  const { ohlcvBars } = data;
  const bars = ohlcvBars?.bars || [];
  if (bars.length < 5) return { trend: "insufficient_data", patterns: [] };

  const recent = bars.slice(-10);
  const highs = recent.map((b) => b.high);
  const lows = recent.map((b) => b.low);
  const closes = recent.map((b) => b.close);

  let higherHighs = 0;
  let lowerLows = 0;
  for (let i = 1; i < highs.length; i++) {
    if (highs[i] > highs[i - 1]) higherHighs++;
    if (lows[i] < lows[i - 1]) lowerLows++;
  }

  let trend;
  if (higherHighs >= 3 && lowerLows <= 1) trend = "uptrend";
  else if (lowerLows >= 3 && higherHighs <= 1) trend = "downtrend";
  else trend = "ranging";

  const patterns = [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (last && prev) {
    const lastO = last.open;
    const lastC = last.close;
    const lastH = last.high;
    const lastL = last.low;
    const prevO = prev.open;
    const prevC = prev.close;

    const body = Math.abs(lastC - lastO);
    const range = lastH - lastL;

    if (range > 0 && body / range < 0.3) {
      const upperWick = lastH - Math.max(lastO, lastC);
      const lowerWick = Math.min(lastO, lastC) - lastL;
      if (lowerWick > body * 2) patterns.push("hammer");
      if (upperWick > body * 2) patterns.push("shooting_star");
    }

    if (lastC > lastO && prevC < prevO && lastC > prevO && lastO < prevC)
      patterns.push("bullish_engulfing");
    if (lastC < lastO && prevC > prevO && lastC < prevO && lastO > prevC)
      patterns.push("bearish_engulfing");

    if (
      Math.max(lastO, lastC) <= Math.max(prevO, prevC) &&
      Math.min(lastO, lastC) >= Math.min(prevO, prevC)
    )
      patterns.push("inside_bar");
  }

  return { trend, patterns, higherHighs, lowerLows };
}

function determineBias(vwapAnalysis, vpLevels, priceAction) {
  let bullishScore = 0;
  let bearishScore = 0;

  if (["above_vwap", "above_1σ"].includes(vwapAnalysis.position)) bullishScore += 2;
  if (["below_vwap", "below_1σ"].includes(vwapAnalysis.position)) bearishScore += 2;
  if (vwapAnalysis.position === "extended_above_2σ") bearishScore += 1; // overextended
  if (vwapAnalysis.position === "extended_below_2σ") bullishScore += 1; // overextended

  if (vpLevels.poc && vwapAnalysis.price) {
    if (vwapAnalysis.price > vpLevels.poc) bullishScore += 1;
    else bearishScore += 1;
  }

  if (priceAction.trend === "uptrend") bullishScore += 2;
  if (priceAction.trend === "downtrend") bearishScore += 2;

  const diff = bullishScore - bearishScore;
  if (diff >= 3) return "strongly_bullish";
  if (diff >= 1) return "bullish";
  if (diff <= -3) return "strongly_bearish";
  if (diff <= -1) return "bearish";
  return "neutral";
}

function findSetups(bias, vwapAnalysis, vpLevels, priceAction) {
  const setups = [];
  const price = vwapAnalysis.price;
  if (!price) return setups;

  // Trend continuation
  if (
    (bias.includes("bullish") && vwapAnalysis.position === "above_vwap") ||
    (bias.includes("bullish") && priceAction.patterns.includes("hammer"))
  ) {
    setups.push({
      type: "trend_continuation",
      direction: "long",
      trigger: `Pullback to VWAP (${vwapAnalysis.vwap?.toFixed(2)}) with bullish PA`,
      target: vpLevels.vah
        ? `VAH ${vpLevels.vah.toFixed(2)}`
        : `VWAP +1σ ${vwapAnalysis.upperBand1?.toFixed(2) || "N/A"}`,
      stop: vpLevels.val
        ? `Below VAL ${vpLevels.val.toFixed(2)}`
        : `Below VWAP ${vwapAnalysis.vwap?.toFixed(2)}`,
    });
  }

  if (
    (bias.includes("bearish") && vwapAnalysis.position === "below_vwap") ||
    (bias.includes("bearish") && priceAction.patterns.includes("shooting_star"))
  ) {
    setups.push({
      type: "trend_continuation",
      direction: "short",
      trigger: `Rally to VWAP (${vwapAnalysis.vwap?.toFixed(2)}) with bearish PA`,
      target: vpLevels.val
        ? `VAL ${vpLevels.val.toFixed(2)}`
        : `VWAP -1σ ${vwapAnalysis.lowerBand1?.toFixed(2) || "N/A"}`,
      stop: vpLevels.vah
        ? `Above VAH ${vpLevels.vah.toFixed(2)}`
        : `Above VWAP ${vwapAnalysis.vwap?.toFixed(2)}`,
    });
  }

  // Mean reversion
  if (vwapAnalysis.position === "extended_below_2σ" && !bias.includes("strongly_bearish")) {
    setups.push({
      type: "mean_reversion",
      direction: "long",
      trigger: `Price at VWAP -2σ — look for bullish reversal candle on 5m`,
      target: `VWAP ${vwapAnalysis.vwap?.toFixed(2)}`,
      stop: `Below swing low`,
    });
  }

  if (vwapAnalysis.position === "extended_above_2σ" && !bias.includes("strongly_bullish")) {
    setups.push({
      type: "mean_reversion",
      direction: "short",
      trigger: `Price at VWAP +2σ — look for bearish reversal candle on 5m`,
      target: `VWAP ${vwapAnalysis.vwap?.toFixed(2)}`,
      stop: `Above swing high`,
    });
  }

  // Breakout
  if (vpLevels.vah && price > vpLevels.vah * 0.998 && price < vpLevels.vah * 1.005) {
    setups.push({
      type: "breakout",
      direction: "long",
      trigger: `Price near VAH (${vpLevels.vah.toFixed(2)}) — watch for breakout + retest`,
      target: `Next resistance / VWAP +2σ`,
      stop: `Below VAH ${vpLevels.vah.toFixed(2)}`,
    });
  }

  if (vpLevels.val && price < vpLevels.val * 1.002 && price > vpLevels.val * 0.995) {
    setups.push({
      type: "breakout",
      direction: "short",
      trigger: `Price near VAL (${vpLevels.val.toFixed(2)}) — watch for breakdown + retest`,
      target: `Next support / VWAP -2σ`,
      stop: `Above VAL ${vpLevels.val.toFixed(2)}`,
    });
  }

  return setups;
}

// ── Main ────────────────────────────────────────────────────────
async function run() {
  console.log("═══════════════════════════════════════════════════════");
  console.log("  VWAP + Volume Profile Intraday Analyzer");
  console.log(`  Symbol: ${SYMBOL}  |  Timeframe: ${TIMEFRAME}m`);
  console.log(`  ${new Date().toLocaleString()}`);
  console.log("═══════════════════════════════════════════════════════\n");

  await connect();

  console.log("Gathering chart data...\n");
  const data = await gatherData();

  const vwapResult = analyzeVWAP(data);
  const vpLevels = analyzeVolumeProfile(data);
  const paResult = analyzePriceAction(data);
  const bias = determineBias(vwapResult, vpLevels, paResult);
  const setups = findSetups(bias, vwapResult, vpLevels, paResult);

  // Report
  const s = data.ohlcvSummary;
  console.log("── Price Summary ──────────────────────────────────────");
  console.log(`  Open:    ${s?.open ?? "N/A"}    High: ${s?.high ?? "N/A"}`);
  console.log(`  Low:     ${s?.low ?? "N/A"}    Close: ${s?.close ?? "N/A"}`);
  console.log(`  Range:   ${s?.range ?? "N/A"}    Change: ${s?.change_pct ?? "N/A"}`);
  console.log(`  Avg Vol: ${s?.avg_volume ?? "N/A"}`);
  console.log();

  console.log("── VWAP Analysis ──────────────────────────────────────");
  console.log(`  Price:    ${vwapResult.price ?? "N/A"}`);
  if (vwapResult.vwap) {
    console.log(`  VWAP:     ${vwapResult.vwap}`);
    console.log(`  Position: ${vwapResult.position} (${vwapResult.distPct}% from VWAP)`);
    if (vwapResult.upperBand1) console.log(`  ±1σ:      ${vwapResult.upperBand1} / ${vwapResult.lowerBand1}`);
    if (vwapResult.upperBand2) console.log(`  ±2σ:      ${vwapResult.upperBand2} / ${vwapResult.lowerBand2}`);
  } else {
    console.log("  VWAP:     ⚠ Not detected — add VWAP indicator to chart");
  }
  console.log();

  console.log("── Volume Profile Levels ──────────────────────────────");
  console.log(`  POC: ${vpLevels.poc ?? "not detected"}`);
  console.log(`  VAH: ${vpLevels.vah ?? "not detected"}`);
  console.log(`  VAL: ${vpLevels.val ?? "not detected"}`);
  if (vpLevels.hvns.length) console.log(`  HVNs: ${vpLevels.hvns.join(", ")}`);
  if (vpLevels.lvns.length) console.log(`  LVNs: ${vpLevels.lvns.join(", ")}`);
  if (vpLevels.context?.yPOC) console.log(`  yPOC: ${vpLevels.context.yPOC}`);
  const ctx = vpLevels.context;
  if (ctx?.dayType || ctx?.trend || ctx?.priceZone) {
    const parts = [];
    if (ctx.dayType) parts.push(`Day: ${ctx.dayType}`);
    if (ctx.trend) parts.push(`Trend: ${ctx.trend}`);
    if (ctx.priceZone) parts.push(ctx.priceZone);
    if (ctx.ibPosition) parts.push(ctx.ibPosition);
    console.log(`  WillyAlgo: ${parts.join(" | ")}`);
  }
  console.log();

  console.log("── Price Action ───────────────────────────────────────");
  console.log(`  Trend: ${paResult.trend}`);
  console.log(`  Patterns: ${paResult.patterns.length ? paResult.patterns.join(", ") : "none"}`);
  console.log();

  console.log("── SESSION BIAS ───────────────────────────────────────");
  console.log(`  >>> ${bias.toUpperCase().replace(/_/g, " ")} <<<`);
  console.log();

  if (setups.length === 0) {
    console.log("── No actionable setups right now ──────────────────────");
    console.log("  Wait for price to reach a key level with confirmation.");
  } else {
    console.log(`── ${setups.length} Setup(s) Identified ──────────────────────────`);
    for (const s of setups) {
      console.log(`\n  [${s.type.toUpperCase()}] ${s.direction.toUpperCase()}`);
      console.log(`  Trigger: ${s.trigger}`);
      console.log(`  Target:  ${s.target}`);
      console.log(`  Stop:    ${s.stop}`);
    }
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Remember: R:R min 1.5:1 | Risk 1% | Max 3 losses = done");
  console.log("═══════════════════════════════════════════════════════\n");

  await client.close();
}

run().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
