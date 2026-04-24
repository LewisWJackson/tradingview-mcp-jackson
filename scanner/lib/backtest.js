/**
 * Multi-Strategy Backtest Engine
 * Tests multiple indicator combinations against historical OHLCV data.
 * Compares win rates, profit factors, and R:R across strategies.
 */

import * as bridge from './tv-bridge.js';
import { loadWeights } from './learning/weight-adjuster.js';
import { resolveSymbol, inferCategory } from './symbol-resolver.js';

// ═══════════════════════════════════════════════════
// CORE CALCULATORS
// ═══════════════════════════════════════════════════

function calcATR(bars, period = 14) {
  const atrs = [];
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    atrs.push(tr);
  }
  if (atrs.length < period) return atrs.reduce((a, b) => a + b, 0) / (atrs.length || 1);
  let atr = atrs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < atrs.length; i++) {
    atr = (atrs[i] + atr * (period - 1)) / period;
  }
  return atr;
}

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcSMA(values, period) {
  const sma = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { sma.push(null); continue; }
    const slice = values.slice(i - period + 1, i + 1);
    sma.push(slice.reduce((a, b) => a + b, 0) / period);
  }
  return sma;
}

function calcRSI(closes, period = 14) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return rsi;

  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change; else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calcBollingerBands(closes, period = 20, mult = 2) {
  const sma = calcSMA(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (sma[i] == null) { upper.push(null); lower.push(null); continue; }
    const slice = closes.slice(Math.max(0, i - period + 1), i + 1);
    const std = Math.sqrt(slice.reduce((s, v) => s + (v - sma[i]) ** 2, 0) / slice.length);
    upper.push(sma[i] + std * mult);
    lower.push(sma[i] - std * mult);
  }
  return { sma, upper, lower };
}

function calcSupertrend(bars, period = 10, multiplier = 3) {
  const closes = bars.map(b => b.close);
  const highs = bars.map(b => b.high);
  const lows = bars.map(b => b.low);

  const atrArr = new Array(bars.length).fill(0);
  // Simple ATR calculation
  for (let i = period; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += Math.max(highs[j] - lows[j], Math.abs(highs[j] - closes[j - 1]), Math.abs(lows[j] - closes[j - 1]));
    }
    atrArr[i] = sum / period;
  }

  const upperBand = [], lowerBand = [], supertrend = [], direction = [];
  for (let i = 0; i < bars.length; i++) {
    const hl2 = (highs[i] + lows[i]) / 2;
    upperBand[i] = hl2 + multiplier * atrArr[i];
    lowerBand[i] = hl2 - multiplier * atrArr[i];

    if (i === 0) { supertrend[i] = upperBand[i]; direction[i] = -1; continue; }

    // Bands clamping
    if (lowerBand[i] < lowerBand[i - 1] && closes[i - 1] > lowerBand[i - 1]) lowerBand[i] = lowerBand[i - 1];
    if (upperBand[i] > upperBand[i - 1] && closes[i - 1] < upperBand[i - 1]) upperBand[i] = upperBand[i - 1];

    if (direction[i - 1] === 1) {
      direction[i] = closes[i] < lowerBand[i] ? -1 : 1;
    } else {
      direction[i] = closes[i] > upperBand[i] ? 1 : -1;
    }
    supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i];
  }
  return { supertrend, direction }; // direction: 1 = bullish, -1 = bearish
}

function calcADX(bars, period = 14) {
  const adx = new Array(bars.length).fill(null);
  if (bars.length < period * 2 + 1) return adx;

  const pDM = [], mDM = [], tr = [];
  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    pDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    mDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }

  let smoothTR = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPDM = pDM.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMDM = mDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];
  for (let i = period; i < tr.length; i++) {
    if (i > period) {
      smoothTR = smoothTR - smoothTR / period + tr[i];
      smoothPDM = smoothPDM - smoothPDM / period + pDM[i];
      smoothMDM = smoothMDM - smoothMDM / period + mDM[i];
    }
    const pDI = smoothTR > 0 ? (smoothPDM / smoothTR) * 100 : 0;
    const mDI = smoothTR > 0 ? (smoothMDM / smoothTR) * 100 : 0;
    const diSum = pDI + mDI;
    dx.push(diSum > 0 ? Math.abs(pDI - mDI) / diSum * 100 : 0);
  }

  if (dx.length >= period) {
    let adxVal = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    adx[period * 2] = adxVal;
    for (let i = period; i < dx.length; i++) {
      adxVal = (adxVal * (period - 1) + dx[i]) / period;
      adx[period + i + 1] = adxVal;
    }
  }
  return adx;
}

// ═══════════════════════════════════════════════════
// TRADE EXECUTION ENGINE
// ═══════════════════════════════════════════════════

function executeTrades(signals, bars, options = {}) {
  const slMult = options.slMultiplier || 2.5;
  const tpRatios = options.tpRatios || [1.5, 2.5, 4.0]; // R multiples
  const maxConcurrent = 1; // One trade at a time

  const trades = [];
  let openTrade = null;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];

    // Check if open trade hits SL or TP
    if (openTrade) {
      if (openTrade.direction === 'long') {
        if (bar.low <= openTrade.sl) {
          closeTrade(openTrade, bar, i, openTrade.sl, 'SL_HIT');
          trades.push({ ...openTrade });
          openTrade = null;
        } else if (bar.high >= openTrade.tp2) {
          closeTrade(openTrade, bar, i, openTrade.tp2, 'TP2_HIT');
          trades.push({ ...openTrade });
          openTrade = null;
        } else if (!openTrade.tp1Hit && bar.high >= openTrade.tp1) {
          openTrade.tp1Hit = true;
          // Move SL to breakeven after TP1
          openTrade.sl = openTrade.entry;
        }
      } else {
        if (bar.high >= openTrade.sl) {
          closeTrade(openTrade, bar, i, openTrade.sl, 'SL_HIT');
          trades.push({ ...openTrade });
          openTrade = null;
        } else if (bar.low <= openTrade.tp2) {
          closeTrade(openTrade, bar, i, openTrade.tp2, 'TP2_HIT');
          trades.push({ ...openTrade });
          openTrade = null;
        } else if (!openTrade.tp1Hit && bar.low <= openTrade.tp1) {
          openTrade.tp1Hit = true;
          openTrade.sl = openTrade.entry;
        }
      }
      // Track MFE/MAE
      if (openTrade) {
        const fav = openTrade.direction === 'long' ? bar.high - openTrade.entry : openTrade.entry - bar.low;
        const adv = openTrade.direction === 'long' ? openTrade.entry - bar.low : bar.high - openTrade.entry;
        if (fav > (openTrade.mfe || 0)) openTrade.mfe = fav;
        if (adv > (openTrade.mae || 0)) openTrade.mae = adv;
      }
      continue; // skip signal check while in trade
    }

    // Check for signal at this bar
    const signal = signals[i];
    if (!signal || signal === 0) continue;

    const entry = bar.close;
    const atr = calcATR(bars.slice(Math.max(0, i - 15), i + 1), 14);
    if (atr <= 0) continue;

    const slDist = atr * slMult;
    const dir = signal > 0 ? 'long' : 'short';

    openTrade = {
      direction: dir,
      entry,
      entryBar: i,
      entryTime: bar.time,
      atr,
      sl: dir === 'long' ? entry - slDist : entry + slDist,
      tp1: dir === 'long' ? entry + slDist * tpRatios[0] : entry - slDist * tpRatios[0],
      tp2: dir === 'long' ? entry + slDist * tpRatios[1] : entry - slDist * tpRatios[1],
      tp3: dir === 'long' ? entry + slDist * tpRatios[2] : entry - slDist * tpRatios[2],
      tp1Hit: false,
      mfe: 0,
      mae: 0,
    };
  }

  // Close remaining open trade
  if (openTrade) {
    const lastBar = bars[bars.length - 1];
    closeTrade(openTrade, lastBar, bars.length - 1, lastBar.close, 'OPEN');
    trades.push({ ...openTrade });
  }

  return trades;
}

function closeTrade(trade, bar, barIdx, price, result) {
  trade.exitPrice = price;
  trade.exitBar = barIdx;
  trade.exitTime = bar.time;
  trade.result = result;
  trade.holdingBars = barIdx - trade.entryBar;
  if (trade.direction === 'long') {
    trade.pnl = ((price - trade.entry) / trade.entry) * 100;
  } else {
    trade.pnl = ((trade.entry - price) / trade.entry) * 100;
  }
  trade.rr = trade.atr > 0 ? Math.abs(price - trade.entry) / (trade.atr * 2.5) : 0;
}

function computeStats(trades, strategyName) {
  const closed = trades.filter(t => t.result !== 'OPEN');
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl <= 0);
  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const maxDrawdown = computeMaxDrawdown(closed);
  const avgHold = closed.length > 0 ? closed.reduce((s, t) => s + (t.holdingBars || 0), 0) / closed.length : 0;

  return {
    strategy: strategyName,
    totalTrades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? Math.round((wins.length / closed.length) * 100 * 10) / 10 : 0,
    totalPnl: Math.round(totalPnl * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: avgLoss > 0 ? Math.round((avgWin * wins.length) / (avgLoss * losses.length) * 100) / 100 : wins.length > 0 ? Infinity : 0,
    expectancy: closed.length > 0 ? Math.round(totalPnl / closed.length * 100) / 100 : 0,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    avgHoldingBars: Math.round(avgHold * 10) / 10,
    tp1HitRate: closed.length > 0 ? Math.round(closed.filter(t => t.tp1Hit || t.result === 'TP2_HIT').length / closed.length * 100) : 0,
  };
}

function computeMaxDrawdown(trades) {
  let peak = 0, equity = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD;
}

// ═══════════════════════════════════════════════════
// STRATEGIES
// ═══════════════════════════════════════════════════

/**
 * Strategy 1: EMA Cross (9/21)
 * Classic momentum crossover
 */
function stratEMACross(bars, opts = {}) {
  const fast = opts.fast || 9;
  const slow = opts.slow || 21;
  const closes = bars.map(b => b.close);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);

  const signals = new Array(bars.length).fill(0);
  for (let i = Math.max(fast, slow) + 1; i < bars.length; i++) {
    const prevAbove = emaFast[i - 1] > emaSlow[i - 1];
    const currAbove = emaFast[i] > emaSlow[i];
    if (!prevAbove && currAbove) signals[i] = 1;  // Bullish cross
    if (prevAbove && !currAbove) signals[i] = -1; // Bearish cross
  }
  return signals;
}

/**
 * Strategy 2: EMA Cross + RSI Filter
 * Only take EMA cross when RSI confirms (not overbought for longs, not oversold for shorts)
 */
function stratEMACrossRSI(bars, opts = {}) {
  const fast = opts.fast || 9;
  const slow = opts.slow || 21;
  const rsiPeriod = opts.rsiPeriod || 14;

  const closes = bars.map(b => b.close);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const rsi = calcRSI(closes, rsiPeriod);

  const signals = new Array(bars.length).fill(0);
  for (let i = Math.max(fast, slow, rsiPeriod) + 1; i < bars.length; i++) {
    const prevAbove = emaFast[i - 1] > emaSlow[i - 1];
    const currAbove = emaFast[i] > emaSlow[i];
    if (rsi[i] == null) continue;

    // Long: EMA cross up + RSI < 65 (not overbought)
    if (!prevAbove && currAbove && rsi[i] < 65) signals[i] = 1;
    // Short: EMA cross down + RSI > 35 (not oversold)
    if (prevAbove && !currAbove && rsi[i] > 35) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 3: EMA Cross + RSI + Volume
 * Triple confirmation: trend cross + momentum + volume spike
 */
function stratEMACrossRSIVolume(bars, opts = {}) {
  const fast = opts.fast || 9;
  const slow = opts.slow || 21;

  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const rsi = calcRSI(closes, 14);
  const volSMA = calcSMA(volumes, 20);

  const signals = new Array(bars.length).fill(0);
  for (let i = 25; i < bars.length; i++) {
    const prevAbove = emaFast[i - 1] > emaSlow[i - 1];
    const currAbove = emaFast[i] > emaSlow[i];
    if (rsi[i] == null || volSMA[i] == null) continue;

    const volConfirm = volumes[i] > volSMA[i] * 1.2; // Volume 20% above average

    if (!prevAbove && currAbove && rsi[i] < 65 && rsi[i] > 30 && volConfirm) signals[i] = 1;
    if (prevAbove && !currAbove && rsi[i] > 35 && rsi[i] < 70 && volConfirm) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 4: RSI Mean Reversion
 * Buy oversold, sell overbought — works best in ranging markets
 */
function stratRSIMeanReversion(bars, opts = {}) {
  const period = opts.rsiPeriod || 14;
  const oversold = opts.oversold || 30;
  const overbought = opts.overbought || 70;

  const closes = bars.map(b => b.close);
  const rsi = calcRSI(closes, period);

  const signals = new Array(bars.length).fill(0);
  for (let i = period + 2; i < bars.length; i++) {
    if (rsi[i] == null || rsi[i - 1] == null) continue;
    // Buy: RSI crosses UP from below oversold
    if (rsi[i - 1] < oversold && rsi[i] >= oversold) signals[i] = 1;
    // Sell: RSI crosses DOWN from above overbought
    if (rsi[i - 1] > overbought && rsi[i] <= overbought) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 5: RSI(2) Connors Mean Reversion
 * Very short period RSI — well-backtested by Larry Connors
 */
function stratRSI2(bars) {
  const closes = bars.map(b => b.close);
  const rsi2 = calcRSI(closes, 2);
  const ema200 = calcEMA(closes, 200);

  const signals = new Array(bars.length).fill(0);
  for (let i = 202; i < bars.length; i++) {
    if (rsi2[i] == null) continue;
    // Long: Price above EMA200 (uptrend) + RSI(2) < 10 (extreme oversold)
    if (closes[i] > ema200[i] && rsi2[i] < 10) signals[i] = 1;
    // Short: Price below EMA200 (downtrend) + RSI(2) > 90 (extreme overbought)
    if (closes[i] < ema200[i] && rsi2[i] > 90) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 6: MACD Cross + EMA Trend Filter
 * MACD signal cross with EMA 50 trend confirmation
 */
function stratMACDTrend(bars) {
  const closes = bars.map(b => b.close);
  const { macdLine, signalLine, histogram } = calcMACD(closes);
  const ema50 = calcEMA(closes, 50);

  const signals = new Array(bars.length).fill(0);
  for (let i = 52; i < bars.length; i++) {
    const prevAbove = macdLine[i - 1] > signalLine[i - 1];
    const currAbove = macdLine[i] > signalLine[i];

    // Long: MACD crosses above signal + Price above EMA50
    if (!prevAbove && currAbove && closes[i] > ema50[i]) signals[i] = 1;
    // Short: MACD crosses below signal + Price below EMA50
    if (prevAbove && !currAbove && closes[i] < ema50[i]) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 7: Bollinger Band Bounce + RSI
 * Mean reversion at BB extremes with RSI confirmation
 */
function stratBBRSI(bars) {
  const closes = bars.map(b => b.close);
  const { upper, lower } = calcBollingerBands(closes, 20, 2);
  const rsi = calcRSI(closes, 14);

  const signals = new Array(bars.length).fill(0);
  for (let i = 22; i < bars.length; i++) {
    if (upper[i] == null || rsi[i] == null) continue;

    // Long: Price touches lower BB + RSI < 35
    if (closes[i] <= lower[i] && rsi[i] < 35) signals[i] = 1;
    // Short: Price touches upper BB + RSI > 65
    if (closes[i] >= upper[i] && rsi[i] > 65) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 8: Supertrend
 * Simple trend following with built-in SL
 */
function stratSupertrend(bars, opts = {}) {
  const period = opts.period || 10;
  const mult = opts.multiplier || 3;
  const { direction } = calcSupertrend(bars, period, mult);

  const signals = new Array(bars.length).fill(0);
  for (let i = period + 2; i < bars.length; i++) {
    if (direction[i - 1] === -1 && direction[i] === 1) signals[i] = 1;  // Flip to bullish
    if (direction[i - 1] === 1 && direction[i] === -1) signals[i] = -1; // Flip to bearish
  }
  return signals;
}

/**
 * Strategy 9: Supertrend + RSI Filter
 * Trend flip + RSI confirmation
 */
function stratSupertrendRSI(bars) {
  const closes = bars.map(b => b.close);
  const { direction } = calcSupertrend(bars, 10, 3);
  const rsi = calcRSI(closes, 14);

  const signals = new Array(bars.length).fill(0);
  for (let i = 16; i < bars.length; i++) {
    if (rsi[i] == null) continue;
    if (direction[i - 1] === -1 && direction[i] === 1 && rsi[i] < 60) signals[i] = 1;
    if (direction[i - 1] === 1 && direction[i] === -1 && rsi[i] > 40) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 10: EMA Cross + ADX Trend Filter
 * Only trade EMA cross when ADX confirms a trending market
 */
function stratEMACrossADX(bars) {
  const closes = bars.map(b => b.close);
  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const adx = calcADX(bars, 14);

  const signals = new Array(bars.length).fill(0);
  for (let i = 30; i < bars.length; i++) {
    const prevAbove = ema9[i - 1] > ema21[i - 1];
    const currAbove = ema9[i] > ema21[i];
    if (adx[i] == null || adx[i] < 20) continue; // Only trade when ADX > 20 (trending)

    if (!prevAbove && currAbove) signals[i] = 1;
    if (prevAbove && !currAbove) signals[i] = -1;
  }
  return signals;
}

/**
 * Strategy 11: Swing Break + Pullback (SMC-like)
 * Identifies swing highs/lows, waits for break, then entries on pullback
 */
function stratSwingBreakPullback(bars) {
  const signals = new Array(bars.length).fill(0);
  const lookback = 5;

  // Find swing points
  const swingHighs = [], swingLows = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    if (isHigh) swingHighs.push({ idx: i, price: bars[i].high });
    if (isLow) swingLows.push({ idx: i, price: bars[i].low });
  }

  // Detect breaks and pullbacks
  let lastBreakHigh = null, lastBreakLow = null;

  for (let i = lookback * 2; i < bars.length; i++) {
    // Check for break above swing high
    const recentHigh = swingHighs.filter(s => s.idx < i && s.idx > i - 50).pop();
    if (recentHigh && bars[i].close > recentHigh.price && !lastBreakHigh) {
      lastBreakHigh = { price: recentHigh.price, bar: i };
      lastBreakLow = null;
    }

    // Check for break below swing low
    const recentLow = swingLows.filter(s => s.idx < i && s.idx > i - 50).pop();
    if (recentLow && bars[i].close < recentLow.price && !lastBreakLow) {
      lastBreakLow = { price: recentLow.price, bar: i };
      lastBreakHigh = null;
    }

    // Pullback entry after break high (buy the dip)
    if (lastBreakHigh && i > lastBreakHigh.bar + 1 && i < lastBreakHigh.bar + 10) {
      if (bars[i].low <= lastBreakHigh.price * 1.005 && bars[i].close > lastBreakHigh.price) {
        signals[i] = 1;
        lastBreakHigh = null;
      }
    }

    // Pullback entry after break low (sell the rally)
    if (lastBreakLow && i > lastBreakLow.bar + 1 && i < lastBreakLow.bar + 10) {
      if (bars[i].high >= lastBreakLow.price * 0.995 && bars[i].close < lastBreakLow.price) {
        signals[i] = -1;
        lastBreakLow = null;
      }
    }
  }
  return signals;
}

/**
 * Strategy 12: Combined Best — EMA + RSI Div + Volume + ADX filter
 * The "research optimal" combination
 */
function stratCombinedBest(bars) {
  const closes = bars.map(b => b.close);
  const volumes = bars.map(b => b.volume);

  const ema9 = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi = calcRSI(closes, 14);
  const adx = calcADX(bars, 14);
  const volSMA = calcSMA(volumes, 20);

  // RSI divergence detection
  function hasRSIDivergence(idx, type) {
    if (idx < 20 || rsi[idx] == null) return false;
    // Simple divergence: check last 15 bars for price/RSI divergence
    for (let j = idx - 15; j < idx - 3; j++) {
      if (rsi[j] == null) continue;
      if (type === 'bullish') {
        if (closes[idx] < closes[j] && rsi[idx] > rsi[j] && rsi[idx] < 40) return true;
      } else {
        if (closes[idx] > closes[j] && rsi[idx] < rsi[j] && rsi[idx] > 60) return true;
      }
    }
    return false;
  }

  const signals = new Array(bars.length).fill(0);
  for (let i = 30; i < bars.length; i++) {
    if (rsi[i] == null || volSMA[i] == null) continue;

    const emaCrossUp = ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i];
    const emaCrossDown = ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i];
    const trendUp = ema9[i] > ema21[i];
    const trendDown = ema9[i] < ema21[i];
    const trending = adx[i] != null && adx[i] > 20;
    const volOK = volumes[i] > volSMA[i] * 1.1;

    // Scoring system (2+ points needed)
    let longScore = 0, shortScore = 0;

    if (emaCrossUp) longScore += 2;
    else if (trendUp) longScore += 1;
    if (emaCrossDown) shortScore += 2;
    else if (trendDown) shortScore += 1;

    if (rsi[i] < 35) longScore += 1;
    if (rsi[i] > 65) shortScore += 1;

    if (hasRSIDivergence(i, 'bullish')) longScore += 1.5;
    if (hasRSIDivergence(i, 'bearish')) shortScore += 1.5;

    if (volOK) { longScore += 0.5; shortScore += 0.5; }
    if (trending) { longScore += 0.5; shortScore += 0.5; }

    if (longScore >= 3 && longScore > shortScore) signals[i] = 1;
    if (shortScore >= 3 && shortScore > longScore) signals[i] = -1;
  }
  return signals;
}

// ═══════════════════════════════════════════════════
// STRATEGY REGISTRY
// ═══════════════════════════════════════════════════

const STRATEGIES = {
  'EMA_Cross_9_21':        { fn: stratEMACross, label: 'EMA 9/21 Cross' },
  'EMA_Cross_RSI':         { fn: stratEMACrossRSI, label: 'EMA Cross + RSI Filter' },
  'EMA_Cross_RSI_Volume':  { fn: stratEMACrossRSIVolume, label: 'EMA Cross + RSI + Volume' },
  'RSI_Mean_Reversion':    { fn: stratRSIMeanReversion, label: 'RSI(14) Mean Reversion' },
  'RSI2_Connors':          { fn: stratRSI2, label: 'RSI(2) Connors' },
  'MACD_Trend':            { fn: stratMACDTrend, label: 'MACD Cross + EMA50 Trend' },
  'BB_RSI':                { fn: stratBBRSI, label: 'Bollinger Bands + RSI' },
  'Supertrend':            { fn: stratSupertrend, label: 'Supertrend (10,3)' },
  'Supertrend_RSI':        { fn: stratSupertrendRSI, label: 'Supertrend + RSI Filter' },
  'EMA_Cross_ADX':         { fn: stratEMACrossADX, label: 'EMA Cross + ADX Trend Filter' },
  'Swing_Break_Pullback':  { fn: stratSwingBreakPullback, label: 'Swing Break + Pullback (SMC-like)' },
  'Combined_Best':         { fn: stratCombinedBest, label: 'Combined: EMA + RSI Div + Vol + ADX' },
};

// ═══════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════

/**
 * Run backtest for a single strategy on given bars.
 */
export function backtestStrategy(bars, strategyKey, options = {}) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) return { error: `Bilinmeyen strateji: ${strategyKey}` };

  const signals = strat.fn(bars, options);
  const trades = executeTrades(signals, bars, options);
  return computeStats(trades, strat.label);
}

/**
 * Run ALL strategies on given bars and return comparison table.
 */
export function backtestAllStrategies(bars, options = {}) {
  const results = [];
  for (const [key, strat] of Object.entries(STRATEGIES)) {
    try {
      const signals = strat.fn(bars, options);
      const trades = executeTrades(signals, bars, options);
      const stats = computeStats(trades, strat.label);
      stats.key = key;
      results.push(stats);
    } catch (e) {
      results.push({ key, strategy: strat.label, error: e.message });
    }
  }

  // Sort by expectancy (best first)
  results.sort((a, b) => (b.expectancy || -999) - (a.expectancy || -999));
  return results;
}

/**
 * Run backtest comparison across multiple SL multipliers.
 */
export function backtestSLComparison(bars, strategyKey, slMultipliers = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0]) {
  const strat = STRATEGIES[strategyKey];
  if (!strat) return { error: `Bilinmeyen strateji: ${strategyKey}` };

  const results = [];
  for (const slMult of slMultipliers) {
    const signals = strat.fn(bars);
    const trades = executeTrades(signals, bars, { slMultiplier: slMult });
    const stats = computeStats(trades, `${strat.label} (SL: ${slMult}x)`);
    stats.slMultiplier = slMult;
    results.push(stats);
  }
  return results;
}

/**
 * Backtest a symbol by fetching OHLCV from TradingView.
 * Supports both single strategy and all-strategy comparison.
 */
export async function runBacktest(symbol, timeframe, options = {}) {
  // Ogrenilmis agirliklari yukle
  const weights = loadWeights();
  const slMultFromWeights = weights.slMultiplierOverrides?.[timeframe];
  const minRRFromWeights = weights.gradeThresholds?.minRR;
  const bareSym = ((symbol || '').includes(':') ? symbol.split(':')[1] : symbol || '').toUpperCase();
  const symbolAdjustment = weights.symbolAdjustments?.[bareSym] || null;
  const symbolRule = weights.symbolRules?.[bareSym] || null;

  // Final SL carpani: options > weights > default
  const slMultiplier = options.slMultiplier ?? slMultFromWeights ?? 2.5;
  const effectiveOptions = { ...options, slMultiplier };

  // Sembolu borsa ile cozumle (BA → NYSE:BA, BTCUSDT → BINANCE:BTCUSDT)
  const category = options.category || inferCategory(bareSym);
  const resolvedSymbol = resolveSymbol(bareSym, category);

  await bridge.setSymbol(resolvedSymbol);
  await bridge.setTimeframe(timeframe);
  await new Promise(r => setTimeout(r, 3000));

  const ohlcv = await bridge.getOhlcv(options.bars || 500, false);
  if (!ohlcv || !ohlcv.bars || ohlcv.bars.length < 50) {
    return { error: 'Yetersiz veri', symbol: resolvedSymbol };
  }

  const bars = ohlcv.bars;
  const barCount = bars.length;
  const dateRange = {
    from: bars[0].time ? new Date(bars[0].time * 1000).toISOString().split('T')[0] : '?',
    to: bars[bars.length - 1].time ? new Date(bars[bars.length - 1].time * 1000).toISOString().split('T')[0] : '?',
  };

  const learningContext = {
    slMultiplierUsed: slMultiplier,
    slMultiplierSource: options.slMultiplier != null ? 'options' : slMultFromWeights != null ? 'weights' : 'default',
    minRRUsed: minRRFromWeights ?? null,
    symbolAdjustment,
    symbolRule,
    weightsVersion: weights.version || null,
    learningState: weights.learningState || null,
  };

  let result;

  if (options.compareAll) {
    // Compare all strategies
    result = {
      mode: 'compare_all',
      symbol: resolvedSymbol,
      timeframe,
      barCount,
      dateRange,
      slMultiplier,
      strategies: backtestAllStrategies(bars, effectiveOptions),
      learningContext,
    };
  } else if (options.compareSL) {
    // Compare SL multipliers for one strategy
    result = {
      mode: 'compare_sl',
      symbol: resolvedSymbol,
      timeframe,
      barCount,
      dateRange,
      strategy: options.strategy || 'EMA_Cross_RSI_Volume',
      slComparison: backtestSLComparison(bars, options.strategy || 'EMA_Cross_RSI_Volume'),
      learningContext,
    };
  } else {
    // Single strategy backtest
    const stratKey = options.strategy || 'EMA_Cross_9_21';
    result = {
      mode: 'single',
      symbol: resolvedSymbol,
      timeframe,
      barCount,
      dateRange,
      ...backtestStrategy(bars, stratKey, effectiveOptions),
      learningContext,
    };
  }

  return result;
}

/**
 * Get list of available strategies.
 */
export function getAvailableStrategies() {
  return Object.entries(STRATEGIES).map(([key, s]) => ({ key, label: s.label }));
}

// Legacy export for backward compatibility
export function backtestEMACross(bars, options = {}) {
  const signals = stratEMACross(bars, { fast: options.fastEMA, slow: options.slowEMA });
  const trades = executeTrades(signals, bars, { slMultiplier: options.slMultiplier || 2.5 });
  return computeStats(trades, `EMA ${options.fastEMA || 9}/${options.slowEMA || 21} Crossover`);
}
