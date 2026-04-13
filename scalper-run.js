import { existsSync, readFileSync, writeFileSync } from "fs";
import * as chart from "./src/core/chart.js";
import * as data from "./src/core/data.js";

// ── Config ───────────────────────────────────────────────────────
const rules = JSON.parse(readFileSync("rules.json", "utf8"));
const { watchlist, vix_filter, bias_criteria, exit_rules, risk_rules } = rules;

const SCAN_DELAY_MS = 3000;   // wait between symbol switches
const MIN_MOMENTUM_PCT = 0.10; // minimum candle move % to count as signal

// ── VIX Regime ───────────────────────────────────────────────────
function getVixRegime(vixLevel) {
  if (vixLevel > 40) return "extreme";
  if (vixLevel > 30) return "high";
  if (vixLevel > 20) return "elevated";
  return "normal";
}

function getSizeMultiplier(regime) {
  const map = { normal: 1.0, elevated: 0.5, high: 0.25, extreme: 0 };
  return map[regime] ?? 1.0;
}

function getStopLossPct(regime) {
  return regime === "elevated" ? 20 : 15; // widen stop in elevated VIX
}

// ── Indicators ───────────────────────────────────────────────────
function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.vol;
    cumVol += c.vol;
  }
  return cumVol === 0 ? candles[candles.length - 1].close : cumTPV / cumVol;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function avgVolume(candles, period = 20) {
  const slice = candles.slice(-period);
  return slice.reduce((s, c) => s + c.vol, 0) / slice.length;
}

// ── Signal Logic (mirrors rules.json bias_criteria) ───────────────
function getSignal(candles) {
  const closes = candles.map((c) => c.close);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const rsi = calcRSI(closes);
  const vwap = calcVWAP(candles);
  const avgVol = avgVolume(candles);
  const momentumPct = ((last.close - prev.close) / prev.close) * 100;
  const aboveVwap = last.close > vwap;
  const volumeOk = last.vol > avgVol;

  let signal = "flat";
  let skipReason = null;

  // Neutral / skip conditions
  if (rsi > 65) {
    skipReason = `RSI ${rsi.toFixed(1)} > 65 (overbought)`;
  } else if (rsi < 35) {
    skipReason = `RSI ${rsi.toFixed(1)} < 35 (oversold)`;
  } else if (Math.abs(momentumPct) < MIN_MOMENTUM_PCT) {
    skipReason = `Momentum ${momentumPct.toFixed(3)}% < ${MIN_MOMENTUM_PCT}% (chop)`;
  } else if (Math.abs((last.close - vwap) / vwap * 100) < 0.05) {
    skipReason = `Price within 0.05% of VWAP (indecision)`;
  } else if (!volumeOk) {
    skipReason = `Volume ${last.vol.toFixed(0)} below 20-bar avg ${avgVol.toFixed(0)} (low conviction)`;
  } else if (momentumPct >= MIN_MOMENTUM_PCT && aboveVwap) {
    signal = "call"; // bullish — buy CALL
  } else if (momentumPct <= -MIN_MOMENTUM_PCT && !aboveVwap) {
    signal = "put";  // bearish — buy PUT
  } else {
    skipReason = `VWAP conflict — momentum ${momentumPct > 0 ? "up" : "down"} but price ${aboveVwap ? "above" : "below"} VWAP`;
  }

  return { signal, skipReason, rsi, vwap, momentumPct, volumeOk, price: last.close };
}

// ── Market Hours Check ────────────────────────────────────────────
function isMarketOpen() {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h = est.getHours(), m = est.getMinutes();
  const totalMin = h * 60 + m;
  const openMin = 9 * 60 + 45;   // 9:45 AM (skip first 15 min)
  const closeMin = 15 * 60 + 30; // 3:30 PM (stop 30 min early)
  return totalMin >= openMin && totalMin <= closeMin;
}

// ── Pull data from TradingView ────────────────────────────────────
async function getSymbolData(symbol) {
  await chart.setSymbol({ symbol });
  await new Promise((r) => setTimeout(r, SCAN_DELAY_MS)); // wait for chart to load

  const ohlcv = await data.getOHLCV({ count: 30 });
  if (!ohlcv.success || !ohlcv.bars?.length) return null;

  return ohlcv.bars.map((b) => ({
    ts: b.time,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    vol: b.volume,
  }));
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  console.log(`\n📈 Options Scalper — ${rules.strategy.name}`);
  console.log(`Watchlist: ${watchlist.join(", ")}\n`);

  // ── Step 1: Check VIX regime ─────────────────────────────────
  console.log("🔍 Checking VIX...");
  const vixCandles = await getSymbolData("VIX");
  const vixLevel = vixCandles ? vixCandles[vixCandles.length - 1].close : 20;
  const regime = getVixRegime(vixLevel);
  const sizeMultiplier = getSizeMultiplier(regime);
  const stopLossPct = getStopLossPct(regime);
  const regimeInfo = vix_filter.regimes[regime];

  console.log(`VIX: ${vixLevel.toFixed(2)} → Regime: ${regime.toUpperCase()}`);
  console.log(`Action: ${regimeInfo.action}\n`);

  if (regime === "extreme") {
    console.log("🚫 VIX above 40 — no trades today. Exiting.\n");
    process.exit(0);
  }

  // ── Step 2: Check market hours ────────────────────────────────
  if (!isMarketOpen()) {
    console.log("🕐 Outside trading hours (9:45 AM – 3:30 PM EST) — exiting.\n");
    process.exit(0);
  }

  // ── Step 3: Scan each symbol ──────────────────────────────────
  const log = [];
  const tradableSymbols = regime === "high"
    ? watchlist.filter((s) => ["AMZN", "MSFT"].includes(s)) // high VIX = only most liquid
    : watchlist.filter((s) => s !== "VIX");

  console.log(`Scanning ${tradableSymbols.length} symbols (VIX regime: ${regime})...\n`);

  for (const symbol of tradableSymbols) {
    const ts = new Date().toISOString();
    console.log(`── ${symbol} ──`);

    const candles = await getSymbolData(symbol);
    if (!candles || candles.length < 22) {
      console.log(`  ⚠️  Not enough data — skipping\n`);
      continue;
    }

    const { signal, skipReason, rsi, vwap, momentumPct, price } = getSignal(candles);

    console.log(`  Price: $${price.toFixed(2)} | RSI: ${rsi.toFixed(1)} | VWAP: $${vwap.toFixed(2)} | Momentum: ${momentumPct.toFixed(3)}%`);

    const entry = {
      timestamp: ts,
      symbol,
      price,
      rsi: parseFloat(rsi.toFixed(2)),
      vwap: parseFloat(vwap.toFixed(2)),
      momentumPct: parseFloat(momentumPct.toFixed(4)),
      vixLevel: parseFloat(vixLevel.toFixed(2)),
      vixRegime: regime,
      signal,
      action: null,
    };

    if (signal === "flat" || skipReason) {
      console.log(`  ⏭  Skip — ${skipReason}\n`);
      entry.action = "skip";
      entry.skipReason = skipReason;
    } else {
      const instrument = signal === "call" ? "CALL" : "PUT";
      const direction = signal === "call" ? "bullish" : "bearish";

      console.log(`  ✅ Signal: ${instrument} (${direction})`);
      console.log(`  📋 Entry: Buy ATM ${instrument} — nearest expiry`);
      console.log(`  🎯 Exit: +25% profit target | -${stopLossPct}% stop | 5-min time stop`);
      console.log(`  📏 Size multiplier: ${sizeMultiplier}x (VIX regime: ${regime})`);

      // ── BROKER EXECUTION PLACEHOLDER ──────────────────────────
      // Connect your broker API here (Tradier, Schwab, IBKR, etc.)
      // Example shape:
      //   await broker.buyOption({ symbol, type: signal, expiry: "0DTE", strike: "ATM" });
      // ──────────────────────────────────────────────────────────

      entry.action = `buy_${signal}`;
      entry.instrument = `ATM ${instrument}`;
      entry.sizeMultiplier = sizeMultiplier;
      entry.profitTargetPct = 25;
      entry.stopLossPct = stopLossPct;
      entry.timeStopMinutes = 5;
      console.log();
    }

    log.push(entry);
  }

  // ── Step 4: Save log ──────────────────────────────────────────
  const existing = existsSync("safety-check-log.json")
    ? JSON.parse(readFileSync("safety-check-log.json", "utf8"))
    : [];
  writeFileSync("safety-check-log.json", JSON.stringify([...existing, ...log], null, 2));

  const signals = log.filter((e) => e.action?.startsWith("buy_"));
  console.log(`\n📊 Scan complete — ${signals.length} signal(s) across ${log.length} symbols.`);
  if (signals.length) {
    console.log("Signals:");
    signals.forEach((e) => console.log(`  ${e.symbol}: ${e.instrument} | RSI ${e.rsi} | Momentum ${e.momentumPct}%`));
  }
  console.log();
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
