// Fyers intraday scalper — VWAP + RSI(3) + EMA(8) on 1-min candles.
//
// NSE equivalent of scalper-run.js (BitGet). Trades ONE equity long-only,
// INTRADAY (MIS): buy to enter, sell to square off. Same signal logic.
//
//   Config via env or defaults below. Honors FYERS_DRY_RUN — orders are
//   simulated until you set FYERS_DRY_RUN=false in .env.
//
//   Run:  node fyers-scalper.js
//
// Safeguards: hard stop-loss (FYERS_SL_PCT, default 0.5%) and an auto
// square-off at end of run so no position is ever left open.
//
// ⚠️  Real NSE money when DRY_RUN is off.

import { existsSync, readFileSync, writeFileSync } from "fs";
import {
  DRY_RUN,
  getHistory,
  getPositions,
  getQuotes,
  placeOrder,
} from "./fyers-client.js";

const SYMBOL = process.env.FYERS_SYMBOL || "NSE:SBIN-EQ";
// Hard safety cap: never trade more than 1 share, whatever FYERS_QTY says.
const MAX_QTY = 1;
const QTY = Math.min(parseInt(process.env.FYERS_QTY || "1", 10) || 1, MAX_QTY);
const BASE_INTERVAL_MS = 10_000; // 10 seconds between checks
const BASE_TICKS = parseInt(process.env.FYERS_TICKS || "6", 10);
// Hard stop-loss: exit immediately if price falls this % below entry. 0 disables.
const STOP_LOSS_PCT = parseFloat(process.env.FYERS_SL_PCT || "0.5") / 100;
// RSI(3) sanity bounds for the momentum filter (see getSignal).
const RSI_OVERBOUGHT = parseFloat(process.env.FYERS_RSI_OB || "70");
const RSI_OVERSOLD = parseFloat(process.env.FYERS_RSI_OS || "30");

// --simulate: feed a scripted price path to prove the buy → stop-loss →
// square-off branches fire, without touching the exchange or live data.
const SIMULATE = process.argv.includes("--simulate") || process.env.FYERS_SIMULATE === "true";
if (SIMULATE) process.env.FYERS_DRY_RUN = "true"; // hard guarantee: never live

// Scripted ticks (used only in --simulate). Designed to exercise every branch:
//   1 BUY @100 → long   2 drop to 99.40 → STOP-LOSS (0.5% = 99.50) → flat
//   3 BUY @100 → long   4 flat @100.10 → run ends LONG → auto square-off
const SCENARIO = [
  { signal: "buy", last: 100.0, ema8: 99.8, rsi3: 25, vwap: 99.9 },
  { signal: "flat", last: 99.4, ema8: 99.9, rsi3: 40, vwap: 99.95 },
  { signal: "buy", last: 100.0, ema8: 99.8, rsi3: 25, vwap: 99.9 },
  { signal: "flat", last: 100.1, ema8: 100.0, rsi3: 55, vwap: 100.0 },
];

// Simulation runs the scripted ticks fast; real runs use the configured pace.
const INTERVAL_MS = SIMULATE ? 400 : BASE_INTERVAL_MS;
const TOTAL_TICKS = SIMULATE ? SCENARIO.length : BASE_TICKS;

// ── Indicators (identical math to scalper-run.js) ───────────────────
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
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
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

function getSignal(candles) {
  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const ema8 = calcEMA(closes, 8);
  const rsi3 = calcRSI(closes, 3);
  const vwap = calcVWAP(candles);

  const bullBias = last > vwap && last > ema8;
  const bearBias = last < vwap && last < ema8;

  // Momentum with an RSI sanity filter: go WITH the trend unless RSI says the
  // move is exhausted. Buy an uptrend while RSI is below overbought; sell a
  // downtrend while RSI is above oversold. Thresholds are configurable.
  let signal = "flat";
  if (bullBias && rsi3 < RSI_OVERBOUGHT) signal = "buy";
  else if (bearBias && rsi3 > RSI_OVERSOLD) signal = "sell";

  return { signal, last, ema8, rsi3, vwap };
}

// ── NSE market hours (09:15–15:30 IST) ──────────────────────────────
function isMarketOpen() {
  // Shift real UTC epoch by +5:30, then read UTC getters as IST wall-clock.
  const ist = new Date(Date.now() + 330 * 60_000);
  const day = ist.getUTCDay(); // 0=Sun … 6=Sat
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return day >= 1 && day <= 5 && mins >= 555 && mins <= 930; // 09:15–15:30
}

// Are we already long this symbol? (real positions only; dry-run stays local)
async function isHolding() {
  if (DRY_RUN) return null; // caller falls back to local flag
  const res = await getPositions();
  const p = (res.netPositions || []).find((x) => x.symbol === SYMBOL);
  return p ? p.netQty > 0 : false;
}

// ── Main loop ───────────────────────────────────────────────────────
async function main() {
  console.log(`\n🇮🇳 Fyers Scalper — VWAP + RSI(3) + EMA(8)`);
  console.log(
    `Symbol: ${SYMBOL} | Qty: ${QTY} | ${TOTAL_TICKS} ticks × ${INTERVAL_MS / 1000}s`,
  );
  console.log(`DRY_RUN: ${DRY_RUN}${DRY_RUN ? " (orders simulated)" : " — LIVE ORDERS"}`);
  if (SIMULATE) console.log(`🧪 SIMULATE — scripted price path, no exchange/live data\n`);
  else console.log("");

  if (!SIMULATE && !isMarketOpen()) {
    console.log("⏸  NSE is closed (trades 09:15–15:30 IST, Mon–Fri).");
    if (!DRY_RUN) {
      console.log("   Refusing to run live outside market hours. Exiting.\n");
      return;
    }
    console.log("   Continuing in DRY_RUN for testing.\n");
  }

  const log = [];
  let holding = false; // local state for dry-run
  let entryPrice = 0; // fill price of the open long, for stop-loss math

  // Place a square-off SELL and record it. Returns true on success.
  async function flatten(px, reason, extra = {}) {
    console.log(`  → SELL ${QTY} ${SYMBOL} (${reason})`);
    const res = await placeOrder({ symbol: SYMBOL, qty: QTY, side: -1, type: 2, productType: "INTRADAY" });
    const ok = res.s === "ok";
    log.push({
      timestamp: new Date().toISOString(),
      symbol: SYMBOL,
      price: px,
      side: "sell",
      reason,
      orderId: res.id || (res.dryRun ? "DRY_RUN" : res.message),
      orderPlaced: ok,
      dryRun: !!res.dryRun,
      ...extra,
    });
    if (ok) console.log(`  ✅ ${res.dryRun ? "SIMULATED" : "PLACED"} — exit`);
    else console.log(`  ❌ Square-off rejected: ${res.message || JSON.stringify(res)}`);
    return ok;
  }

  for (let i = 1; i <= TOTAL_TICKS; i++) {
    const ts = new Date().toISOString();

    let signal, last, ema8, rsi3, vwap;
    if (SIMULATE) {
      ({ signal, last, ema8, rsi3, vwap } = SCENARIO[i - 1]);
    } else {
      const candles = await getHistory(SYMBOL, "1", 1);
      if (candles.length < 10) {
        console.log(`[${i}/${TOTAL_TICKS}] ⏭  Not enough candles yet (${candles.length}).\n`);
        if (i < TOTAL_TICKS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
        continue;
      }
      ({ signal, last, ema8, rsi3, vwap } = getSignal(candles));
    }

    const live = SIMULATE ? null : await isHolding();
    const isLong = live === null ? holding : live;

    console.log(`[${i}/${TOTAL_TICKS}] ${ts}`);
    console.log(
      `  Price: ${last.toFixed(2)} | EMA8: ${ema8.toFixed(2)} | RSI3: ${rsi3.toFixed(1)} | VWAP: ${vwap.toFixed(2)}`,
    );
    console.log(`  Position: ${isLong ? "LONG" : "FLAT"} | Signal: ${signal.toUpperCase()}`);

    // ── Hard stop-loss: overrides signal, exits immediately ──────────
    if (isLong && STOP_LOSS_PCT > 0 && entryPrice > 0 && last <= entryPrice * (1 - STOP_LOSS_PCT)) {
      const lossPct = ((last - entryPrice) / entryPrice) * 100;
      console.log(`  🛑 STOP-LOSS hit — entry ${entryPrice.toFixed(2)} → ${last.toFixed(2)} (${lossPct.toFixed(2)}%)`);
      if (await flatten(last, "stop-loss", { entryPrice, lossPct })) {
        holding = false;
        entryPrice = 0;
      }
      if (i < TOTAL_TICKS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }

    const entry = { tick: i, timestamp: ts, symbol: SYMBOL, price: last, ema8, rsi3, vwap, signal, orderPlaced: false };

    let side, label;
    if (signal === "buy" && !isLong) {
      side = 1; // Buy
      label = `BUY ${QTY} ${SYMBOL}`;
      holding = true;
    } else if (signal === "sell" && isLong) {
      side = -1; // Sell (square off)
      label = `SELL ${QTY} ${SYMBOL}`;
      holding = false;
    } else {
      const reason =
        signal === "flat"
          ? "no signal — conditions not met"
          : `signal=${signal} but position=${isLong ? "LONG" : "FLAT"}`;
      console.log(`  ⏭  Skip — ${reason}\n`);
      entry.skipped = true;
      entry.skipReason = reason;
      log.push(entry);
      if (i < TOTAL_TICKS) await new Promise((r) => setTimeout(r, INTERVAL_MS));
      continue;
    }

    console.log(`  → ${label}`);
    entry.side = side === 1 ? "buy" : "sell";

    const res = await placeOrder({ symbol: SYMBOL, qty: QTY, side, type: 2, productType: "INTRADAY" });
    const ok = res.s === "ok";
    entry.orderId = res.id || (res.dryRun ? "DRY_RUN" : res.message);
    entry.orderPlaced = ok;
    entry.dryRun = !!res.dryRun;

    if (ok) {
      console.log(`  ✅ ${res.dryRun ? "SIMULATED" : "PLACED"} — ${entry.orderId}`);
      if (side === 1) entryPrice = last; // opened long — arm stop-loss
      else entryPrice = 0; // closed long
    } else {
      console.log(`  ❌ Rejected: ${res.message || JSON.stringify(res)}`);
      holding = side === 1 ? false : true; // revert local state
    }

    log.push(entry);
    if (i < TOTAL_TICKS) {
      console.log(`  ⏱  Next in ${INTERVAL_MS / 1000}s...\n`);
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  }

  // ── Auto square-off: never leave a position open at the end ─────────
  const live = SIMULATE ? null : await isHolding();
  const stillLong = live === null ? holding : live;
  if (stillLong) {
    console.log(`\n🔔 Run ended while still LONG — auto squaring off.`);
    let px = entryPrice;
    if (!SIMULATE) {
      try {
        const q = await getQuotes(SYMBOL);
        px = q.d?.[0]?.v?.lp ?? entryPrice;
      } catch {}
    }
    await flatten(px, "end-of-run square-off");
    holding = false;
    entryPrice = 0;
  }

  // Report
  const placed = log.filter((e) => e.orderPlaced).length;
  console.log(`\n✅ Done — ${placed}/${TOTAL_TICKS} orders ${DRY_RUN ? "simulated" : "placed"}.`);
  if (!SIMULATE) {
    try {
      const q = await getQuotes(SYMBOL);
      const ltp = q.d?.[0]?.v?.lp;
      if (ltp != null) console.log(`   ${SYMBOL} LTP: ${ltp}`);
    } catch {}
  }
  console.log("");

  const existing = existsSync("safety-check-log.json")
    ? JSON.parse(readFileSync("safety-check-log.json", "utf8"))
    : [];
  writeFileSync("safety-check-log.json", JSON.stringify([...existing, ...log], null, 2));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
