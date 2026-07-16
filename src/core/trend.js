/**
 * Trend detection computed directly from OHLCV price data — no indicators
 * required on the chart. Combines EMA slope (direction), ADX/DMI (strength),
 * and swing-pivot structure (HH/HL vs LH/LL) into a single verdict for the
 * current chart's symbol/timeframe.
 */
import * as chart from "./chart.js";
import { getOhlcv } from "./data.js";

const DEFAULT_BARS = 150;
const MIN_BARS = 60;

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function wilderSmooth(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum;
  for (let i = period; i < values.length; i++) {
    sum = out[i - 1] - out[i - 1] / period + values[i];
    out[i] = sum;
  }
  return out;
}

// Wilder's ADX/+DI/-DI (standard 14-period trend-strength oscillator).
function calcADX(bars, period = 14) {
  const highs = bars.map((b) => b.high);
  const lows = bars.map((b) => b.low);
  const closes = bars.map((b) => b.close);
  const len = bars.length;

  const plusDM = [0];
  const minusDM = [0];
  const tr = [0];
  for (let i = 1; i < len; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1]),
      ),
    );
  }

  const trSmooth = wilderSmooth(tr, period);
  const plusDMSmooth = wilderSmooth(plusDM, period);
  const minusDMSmooth = wilderSmooth(minusDM, period);

  const plusDI = new Array(len).fill(null);
  const minusDI = new Array(len).fill(null);
  const dx = new Array(len).fill(null);
  for (let i = period; i < len; i++) {
    if (!trSmooth[i]) continue;
    plusDI[i] = (100 * plusDMSmooth[i]) / trSmooth[i];
    minusDI[i] = (100 * minusDMSmooth[i]) / trSmooth[i];
    const diSum = plusDI[i] + minusDI[i];
    dx[i] = diSum ? (100 * Math.abs(plusDI[i] - minusDI[i])) / diSum : 0;
  }

  const dxValues = dx.filter((v) => v !== null);
  const adxSmooth = wilderSmooth(dxValues, period);
  const adxValues = adxSmooth.filter((v) => v !== null).map((v) => v / period);

  return {
    adx: adxValues.length ? Math.round(adxValues[adxValues.length - 1] * 100) / 100 : null,
    plusDI: plusDI[len - 1] !== null ? Math.round(plusDI[len - 1] * 100) / 100 : null,
    minusDI: minusDI[len - 1] !== null ? Math.round(minusDI[len - 1] * 100) / 100 : null,
  };
}

// Fractal swing pivots: a bar whose high/low is the extreme within `lookback` bars either side.
function findSwings(bars, lookback = 3) {
  const swings = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    const high = bars[i].high;
    const low = bars[i].low;
    if (window.every((b) => b.high <= high)) {
      swings.push({ type: "high", price: high, time: bars[i].time });
    }
    if (window.every((b) => b.low >= low)) {
      swings.push({ type: "low", price: low, time: bars[i].time });
    }
  }
  return swings;
}

function classifyStructure(swings) {
  const highs = swings.filter((s) => s.type === "high").slice(-2);
  const lows = swings.filter((s) => s.type === "low").slice(-2);

  let highSeq = null;
  if (highs.length === 2) highSeq = highs[1].price > highs[0].price ? "HH" : "LH";
  let lowSeq = null;
  if (lows.length === 2) lowSeq = lows[1].price > lows[0].price ? "HL" : "LL";

  let structure = "insufficient_data";
  if (highSeq && lowSeq) {
    if (highSeq === "HH" && lowSeq === "HL") structure = "bullish (HH/HL)";
    else if (highSeq === "LH" && lowSeq === "LL") structure = "bearish (LH/LL)";
    else structure = "mixed/ranging";
  }

  return {
    structure,
    last_swing_high: highs[highs.length - 1] || null,
    last_swing_low: lows[lows.length - 1] || null,
    sequence: [highSeq, lowSeq].filter(Boolean).join("/") || null,
  };
}

export async function getTrendSummary({ count } = {}) {
  const barCount = Math.max(count || DEFAULT_BARS, MIN_BARS);
  const [state, ohlcv] = await Promise.all([
    chart.getState(),
    getOhlcv({ count: barCount }),
  ]);

  const bars = ohlcv.bars;
  if (bars.length < MIN_BARS) {
    throw new Error(
      `Need at least ${MIN_BARS} bars for a reliable trend read, got ${bars.length}. Scroll back further on the chart or lower the timeframe.`,
    );
  }

  const closes = bars.map((b) => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const lastClose = closes[closes.length - 1];
  const lastEma20 = ema20[ema20.length - 1];
  const lastEma50 = ema50[ema50.length - 1];

  let direction = "mixed";
  if (lastEma20 !== null && lastEma50 !== null) {
    if (lastClose > lastEma20 && lastEma20 > lastEma50) direction = "up";
    else if (lastClose < lastEma20 && lastEma20 < lastEma50) direction = "down";
  }

  const { adx, plusDI, minusDI } = calcADX(bars);
  let strength = "unknown";
  if (adx !== null) {
    if (adx < 20) strength = "weak/choppy";
    else if (adx < 25) strength = "developing";
    else if (adx < 40) strength = "strong";
    else strength = "very strong";
  }

  const swings = findSwings(bars);
  const { structure, last_swing_high, last_swing_low, sequence } = classifyStructure(swings);

  const agreement = [
    direction === "up" && structure.startsWith("bullish"),
    direction === "down" && structure.startsWith("bearish"),
  ].some(Boolean);

  let verdict = "unclear / conflicting signals";
  if (adx !== null && adx < 20) {
    verdict = "no trend — ranging/choppy (ADX below 20)";
  } else if (direction === "up" && agreement) {
    verdict = `uptrend${strength === "strong" || strength === "very strong" ? " (confirmed)" : " (developing)"}`;
  } else if (direction === "down" && agreement) {
    verdict = `downtrend${strength === "strong" || strength === "very strong" ? " (confirmed)" : " (developing)"}`;
  } else if (direction !== "mixed") {
    verdict = `${direction}trend on EMAs but structure disagrees (${structure}) — treat with caution`;
  }

  return {
    success: true,
    symbol: state.symbol,
    timeframe: state.resolution,
    bar_count: bars.length,
    price: lastClose,
    ema: { ema20: round(lastEma20), ema50: round(lastEma50) },
    adx: { adx, plus_di: plusDI, minus_di: minusDI },
    structure: { classification: structure, sequence, last_swing_high, last_swing_low },
    direction,
    strength,
    verdict,
  };
}

function round(v) {
  return v === null || v === undefined ? null : Math.round(v * 10000) / 10000;
}

const DEFAULT_TIMEFRAMES = ["15", "60", "240", "D"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs getTrendSummary() across several timeframes for a symbol and checks
// whether they agree on direction. Switches the live chart's timeframe (and
// optionally symbol) per iteration, then restores the original chart state.
export async function getMultiTimeframeTrend({ symbol, timeframes, count } = {}) {
  const tfs = timeframes && timeframes.length ? timeframes : DEFAULT_TIMEFRAMES;

  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  if (symbol) {
    try {
      await chart.setSymbol({ symbol });
      await sleep(900);
    } catch (err) {
      throw new Error(`Could not set symbol '${symbol}': ${err.message}`);
    }
  }

  const perTimeframe = [];
  for (const tf of tfs) {
    try {
      await chart.setTimeframe({ timeframe: tf });
      await sleep(900);
      const summary = await getTrendSummary({ count });
      perTimeframe.push({ timeframe: tf, ...summary });
    } catch (err) {
      perTimeframe.push({ timeframe: tf, success: false, error: err.message });
    }
  }

  // Restore original chart state
  try {
    if (symbol && originalSymbol) await chart.setSymbol({ symbol: originalSymbol });
    if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
  } catch (_) {}

  const valid = perTimeframe.filter((r) => r.success !== false);
  const upCount = valid.filter((r) => r.direction === "up").length;
  const downCount = valid.filter((r) => r.direction === "down").length;
  const strongCount = valid.filter((r) => r.strength === "strong" || r.strength === "very strong").length;
  const chopCount = valid.filter((r) => r.strength === "weak/choppy").length;

  let alignment = "insufficient_data";
  let verdict = "not enough valid timeframe reads to judge alignment";
  if (valid.length) {
    if (upCount === valid.length) {
      alignment = "fully aligned bullish";
    } else if (downCount === valid.length) {
      alignment = "fully aligned bearish";
    } else if (upCount > downCount && upCount >= Math.ceil(valid.length * 0.66)) {
      alignment = "mostly aligned bullish";
    } else if (downCount > upCount && downCount >= Math.ceil(valid.length * 0.66)) {
      alignment = "mostly aligned bearish";
    } else {
      alignment = "conflicting";
    }

    const strongNote = strongCount === valid.length
      ? "all timeframes trending with strong+ ADX"
      : `${strongCount}/${valid.length} timeframes have strong+ ADX`;
    verdict = `${alignment} (${upCount} up / ${downCount} down / ${chopCount} choppy across ${valid.length} timeframes) — ${strongNote}`;
  }

  return {
    success: true,
    symbol: valid[0]?.symbol || symbol || originalSymbol || null,
    timeframes_checked: tfs,
    per_timeframe: perTimeframe,
    alignment,
    bullish_count: upCount,
    bearish_count: downCount,
    choppy_count: chopCount,
    strong_count: strongCount,
    verdict,
  };
}
