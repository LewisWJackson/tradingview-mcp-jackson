/**
 * trading-alerts-runner.js
 *
 * Connects to TradingView Desktop via CDP, deploys the VWAP+EMA(8)+RSI(3)
 * Pine Script indicator, evaluates the current trading signal, and creates
 * TradingView price alerts for buy/sell conditions.
 *
 * Usage:
 *   node trading-alerts-runner.js [--symbol XRPUSDT] [--loop] [--interval 60]
 *
 * Flags:
 *   --symbol   Override the chart symbol (default: uses whatever is on chart)
 *   --loop     Run repeatedly on an interval (default: run once)
 *   --interval Seconds between loop iterations (default: 60)
 *   --no-pine  Skip Pine Script deployment (if already loaded)
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

// ── Core modules (direct CDP access — no MCP overhead) ─────────────────────
import * as chart from "./src/core/chart.js";
import * as data from "./src/core/data.js";
import * as pine from "./src/core/pine.js";
import * as alerts from "./src/core/alerts.js";
import { disconnect } from "./src/connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PINE_SRC = readFileSync(
  path.join(__dirname, "pine", "vwap-ema-rsi-alerts.pine"),
  "utf8",
);

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const SYMBOL = getArg("--symbol");
const LOOP = hasFlag("--loop");
const INTERVAL_S = parseInt(getArg("--interval") || "60", 10);
const SKIP_PINE = hasFlag("--no-pine");

// ── Indicator calculations (mirrors scalper-run.js) ────────────────────────
function calcEMA(closes, period) {
  const k = 2 / (period + 1);
  let ema = closes[0];
  for (let i = 1; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}

function calcRSI(closes, period = 3) {
  if (closes.length < period + 1) return 50;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcVWAP(candles) {
  let cumTPV = 0,
    cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  }
  return cumVol === 0 ? candles[candles.length - 1].close : cumTPV / cumVol;
}

function getSignal(bars) {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(
    bars.map((b) => ({ high: b.high, low: b.low, close: b.close, vol: b.volume || 0 })),
  );

  const bullBias = last > vwap && last > ema8;
  const bearBias = last < vwap && last < ema8;

  let signal = "flat";
  if (bullBias && rsi3 < 30) signal = "buy";
  else if (bearBias && rsi3 > 70) signal = "sell";

  return { signal, last, ema8, rsi3, vwap, bullBias, bearBias };
}

// ── Deploy Pine Script into TradingView editor ─────────────────────────────
async function deployPine() {
  console.log("  Deploying Pine Script to TradingView editor...");
  await pine.ensurePineEditorOpen();
  await pine.setSource({ source: PINE_SRC });
  await new Promise((r) => setTimeout(r, 800));

  const compiled = await pine.smartCompile();
  if (!compiled.success) {
    const errors = await pine.getErrors();
    console.error("  Pine compile failed:", errors.errors || errors);
    return false;
  }
  console.log("  Pine Script compiled OK.");
  return true;
}

// ── Create TradingView price alert ─────────────────────────────────────────
async function createAlert(signal, price, indicators) {
  const { ema8, rsi3, vwap } = indicators;
  const direction = signal === "buy" ? "greater_than" : "less_than";
  // Offset by 0.1% so the alert fires on the next tick
  const alertPrice =
    signal === "buy"
      ? parseFloat((price * 1.001).toFixed(6))
      : parseFloat((price * 0.999).toFixed(6));

  const message =
    `${signal.toUpperCase()} Signal | Price: ${price} | ` +
    `RSI(3): ${rsi3.toFixed(2)} | VWAP: ${vwap.toFixed(4)} | EMA(8): ${ema8.toFixed(4)}`;

  console.log(`  Creating ${signal.toUpperCase()} alert @ ${alertPrice}...`);
  const result = await alerts.create({
    condition: direction,
    price: alertPrice,
    message,
  });
  return result;
}

// ── Main analysis + alert cycle ────────────────────────────────────────────
async function runCycle(deployedPine) {
  const ts = new Date().toISOString();
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Run: ${ts}`);

  // 1. Chart state
  const state = await chart.getState();
  const symbol = state.symbol || "unknown";
  const timeframe = state.resolution || "?";
  console.log(`  Chart: ${symbol} [${timeframe}]`);

  // 2. OHLCV bars — 30 bars is enough for EMA(8) warm-up + RSI(3)
  const ohlcvResult = await data.getOhlcv({ count: 30 });
  const bars = ohlcvResult?.bars || ohlcvResult?.data || [];

  if (bars.length < 10) {
    console.log("  Not enough OHLCV bars — chart may still be loading.");
    return { signal: "flat", deployed: deployedPine };
  }

  // 3. Compute signal
  const { signal, last, ema8, rsi3, vwap, bullBias, bearBias } =
    getSignal(bars);

  const bias = bullBias ? "BULL" : bearBias ? "BEAR" : "FLAT";
  console.log(
    `  Price:  ${last.toFixed(4)}  |  VWAP: ${vwap.toFixed(4)}  |  EMA(8): ${ema8.toFixed(4)}  |  RSI(3): ${rsi3.toFixed(1)}`,
  );
  console.log(`  Bias:   ${bias}  |  Signal: ${signal.toUpperCase()}`);

  // 4. Deploy Pine Script (first run only unless --no-pine skips entirely)
  if (!deployedPine && !SKIP_PINE) {
    const ok = await deployPine();
    deployedPine = ok;
  }

  // 5. Create alert if there is a signal
  if (signal === "buy" || signal === "sell") {
    const alertResult = await createAlert(signal, last, { ema8, rsi3, vwap });
    if (alertResult.success) {
      console.log(`  Alert created for ${signal.toUpperCase()} signal.`);
    } else {
      console.log(
        `  Alert creation returned: ${JSON.stringify(alertResult)}`,
      );
    }
  } else {
    console.log("  No signal — no alert created.");
  }

  return { signal, deployed: deployedPine };
}

// ── Entry point ─────────────────────────────────────────────────────────────
async function main() {
  console.log("\nTradingView Alert Runner — VWAP + EMA(8) + RSI(3)");
  console.log(`Strategy: Buy when price > VWAP & > EMA(8) and RSI(3) < 30`);
  console.log(`          Sell when price < VWAP & < EMA(8) and RSI(3) > 70\n`);

  if (SYMBOL) {
    console.log(`Setting chart symbol to ${SYMBOL}...`);
    await chart.setSymbol({ symbol: SYMBOL });
    await new Promise((r) => setTimeout(r, 1500));
  }

  let deployedPine = false;

  if (LOOP) {
    console.log(`Loop mode: every ${INTERVAL_S}s. Ctrl+C to stop.\n`);
    while (true) {
      const result = await runCycle(deployedPine);
      deployedPine = result.deployed;
      await new Promise((r) => setTimeout(r, INTERVAL_S * 1000));
    }
  } else {
    await runCycle(deployedPine);
  }

  await disconnect();
  console.log("\nDone.\n");
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
