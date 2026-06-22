/**
 * Strategy Backtester — v2.0
 *
 * Enhancements over v1:
 *  - Entry at next-bar OPEN (not close)
 *  - 0.35% round-trip commission (0.175% per side, TASI standard)
 *  - Trailing stop after Target1 (trail at 1×ATR from breakeven)
 *  - All indicators pre-computed in O(n) — no per-bar re-slicing
 *  - 2000-bar support (caller fetches via Yahoo Finance)
 *  - Parameter sweep across minScore × holdBars grid
 *  - Portfolio-level simulation (capital-constrained, max N positions)
 *  - Extended stats: max drawdown, per-trade Sharpe, win/loss streaks
 */

import { emaArray, scoreBias } from "../scripts/tasi_screener.mjs";

export const COMMISSION = (+process.env.COST_RT || 0.0011) / 2;  // Derayah 0.11% RT default (env override)

// ── Series helpers (all O(n)) ─────────────────────────────────────────────────

function rsiSeriesLocal(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

// Returns array of { hist, prevHist } — matches the object scoreBias expects
function macdHistSeries(closes) {
  const e12   = emaArray(closes, 12);
  const e26   = emaArray(closes, 26);
  const diff  = e12.map((v, i) => v - e26[i]);
  const sig   = emaArray(diff.slice(25), 9); // signal starts at bar 25
  const n     = closes.length;
  const out   = new Array(n).fill(null);
  // sig[j] corresponds to diff[25 + j]
  for (let j = 0; j < sig.length; j++) {
    const i = 25 + j;
    if (i >= n) break;
    const hist     = diff[i] - sig[j];
    const prevHist = j > 0 ? diff[i - 1] - sig[j - 1] : null;
    out[i] = { hist, prevHist };
  }
  return out;
}

// Wilder ATR series
function atrSeries(highs, lows, closes, period = 14) {
  const n   = closes.length;
  const tr  = new Array(n);
  tr[0]     = highs[0] - lows[0];
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    );
  }
  const out  = new Array(n).fill(null);
  let rma    = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = rma;
  for (let i = period + 1; i < n; i++) {
    rma    = (rma * (period - 1) + tr[i]) / period;
    out[i] = rma;
  }
  return out;
}

// Volume ratio vs 20-bar SMA (matches volumeCheck shape: { ratio, ok })
function volRatioSeries(volumes, period = 20) {
  const out = new Array(volumes.length).fill(null);
  for (let i = period; i < volumes.length; i++) {
    const mean = volumes.slice(i - period, i).reduce((a, b) => a + (b || 0), 0) / period;
    const ratio = mean > 0 ? (volumes[i] || 0) / mean : 1;
    out[i] = { ratio: Math.round(ratio * 100) / 100, ok: ratio >= 1.5 };
  }
  return out;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

function calcMaxDrawdown(equity) {
  let peak = equity[0] ?? 100, maxDD = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak > 0 ? (peak - v) / peak * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return Math.round(maxDD * 100) / 100;
}

// Per-trade Sharpe (trade returns treated as a return series)
function calcSharpe(pcts) {
  if (pcts.length < 4) return null;
  const mean = pcts.reduce((a, b) => a + b, 0) / pcts.length;
  const std  = Math.sqrt(pcts.reduce((a, b) => a + (b - mean) ** 2, 0) / pcts.length);
  return std === 0 ? null : Math.round((mean / std) * 100) / 100;
}

function calcStreaks(trades) {
  let maxW = 0, maxL = 0, cw = 0, cl = 0;
  for (const t of trades) {
    if (t.pct > 0) { cw++; cl = 0; if (cw > maxW) maxW = cw; }
    else            { cl++; cw = 0; if (cl > maxL) maxL = cl; }
  }
  return { maxWinStreak: maxW, maxLossStreak: maxL };
}

function buildStats(trades, params) {
  const wins    = trades.filter(t => t.pct > 0);
  const losses  = trades.filter(t => t.pct <= 0);
  const winRate = Math.round(wins.length / trades.length * 100);
  const avg     = v => Math.round(v.reduce((s, t) => s + t.pct, 0) / v.length * 100) / 100;
  const avgReturn    = avg(trades);
  const avgWin       = wins.length   ? avg(wins)   : 0;
  const avgLoss      = losses.length ? avg(losses) : 0;
  const profitFactor = losses.length && avgLoss
    ? Math.round(Math.abs((avgWin * wins.length) / (avgLoss * losses.length)) * 100) / 100
    : null;

  let cum = 100;
  const equity = trades.map(t => {
    cum = +(cum * (1 + t.pct / 100)).toFixed(2);
    return cum;
  });

  const byOutcome = {};
  trades.forEach(t => { byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1; });
  const { maxWinStreak, maxLossStreak } = calcStreaks(trades);

  return {
    allTrades: trades,
    trades:    trades.slice(-10),
    equity,
    stats: {
      total: trades.length, wins: wins.length, losses: losses.length,
      winRate, avgReturn, avgWin, avgLoss, profitFactor,
      maxDrawdown:  calcMaxDrawdown(equity),
      sharpe:       calcSharpe(trades.map(t => t.pct)),
      maxWinStreak, maxLossStreak,
      byOutcome,
      params: { ...params, commission: '0.35%' },
    },
  };
}

// ── Indicator pre-computation (call once per bar set) ─────────────────────────

export function prepareIndicators(bars) {
  const closes  = bars.map(b => b.close);
  const highs   = bars.map(b => b.high);
  const lows    = bars.map(b => b.low);
  const volumes = bars.map(b => b.volume ?? 0);
  return {
    opens:  bars.map(b => b.open ?? b.close),
    times:  bars.map(b => b.time),
    closes, highs, lows,
    e13s:   emaArray(closes, 13),
    e34s:   emaArray(closes, 34),
    e89s:   emaArray(closes, 89),
    e200s:  emaArray(closes, 200),
    rsiS:   rsiSeriesLocal(closes, 14),
    macdS:  macdHistSeries(closes),
    atrS:   atrSeries(highs, lows, closes, 14),
    volS:   volRatioSeries(volumes, 20),
  };
}

// ── Core simulation (uses pre-computed indicators) ────────────────────────────

export function simulateTrades(ind, bars, { minScore = 7, holdBars = 40 } = {}) {
  const { opens, times, closes, e13s, e34s, e89s, e200s, rsiS, macdS, atrS, volS } = ind;
  const trades = [];
  let inTrade = false, entry = null;
  let trailingActive = false, trailingStop = null;

  for (let i = 200; i < bars.length - 1; i++) {
    if (!inTrade) {
      const emas    = { ema13: e13s[i], ema34: e34s[i], ema89: e89s[i], ema200: e200s[i] };
      const rsiVal  = rsiS[i] ?? 50;
      const macdObj = macdS[i] ?? { hist: 0, prevHist: null };
      const volObj  = volS[i]  ?? { ratio: 1, ok: false };
      const atrVal  = atrS[i];

      if (!atrVal) continue;

      const scored = scoreBias(emas, rsiVal, macdObj, volObj, closes[i]);
      if (scored.bullish_score < minScore) continue;

      const rawEntry   = opens[i + 1];
      const entryPrice = rawEntry * (1 + COMMISSION);

      entry = {
        i, date: new Date(times[i] * 1000).toISOString().slice(0, 10),
        price: entryPrice, rawEntry,
        stop:    entryPrice - 1.5 * atrVal,
        target1: entryPrice + 1.5 * atrVal,
        target2: entryPrice + 3   * atrVal,
        atr: atrVal, score: scored.bullish_score,
      };
      inTrade = true; trailingActive = false; trailingStop = entry.stop;

    } else {
      const bar    = bars[i];
      const atrNow = atrS[i] ?? entry.atr;
      let outcome = null, exitPrice = null;

      // Advance trailing stop
      if (trailingActive) {
        const candidate = bar.close - atrNow;
        if (candidate > trailingStop) trailingStop = candidate;
      }

      const activeStop = trailingActive ? trailingStop : entry.stop;

      if (bar.low <= activeStop) {
        outcome = trailingActive ? 'trailed' : 'stop';
        exitPrice = activeStop;
      }

      // Target1 hit → activate trailing from breakeven instead of exiting
      if (!outcome && !trailingActive && bar.high >= entry.target1) {
        trailingActive = true;
        trailingStop   = entry.price; // trail from breakeven
      }

      if (!outcome && bar.high >= entry.target2) {
        outcome = 'target2'; exitPrice = entry.target2;
      }

      if (!outcome && i - entry.i >= holdBars) {
        outcome = 'timeout'; exitPrice = bar.close;
      }

      if (outcome) {
        const netExit = exitPrice * (1 - COMMISSION);
        const pct     = (netExit - entry.rawEntry) / entry.rawEntry * 100;
        trades.push({
          ...entry,
          exit_date:  new Date(times[i] * 1000).toISOString().slice(0, 10),
          exit_price: +netExit.toFixed(4),
          outcome, pct: Math.round(pct * 100) / 100,
          bars_held: i - entry.i, trailed: trailingActive,
        });
        inTrade = false; entry = null; trailingActive = false; trailingStop = null;
      }
    }
  }
  return trades;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function runBacktest(bars, params = {}) {
  const { minScore = 7, holdBars = 40 } = params;
  if (!bars || bars.length < 210) {
    return { error: 'Need 210+ bars for a meaningful backtest', trades: [], allTrades: [], stats: null, equity: [] };
  }
  const ind    = prepareIndicators(bars);
  const trades = simulateTrades(ind, bars, { minScore, holdBars });
  if (!trades.length) {
    return { trades: [], allTrades: [], stats: { total: 0, winRate: 0, avgReturn: 0, profitFactor: null, maxDrawdown: 0, sharpe: null, maxWinStreak: 0, maxLossStreak: 0, byOutcome: {}, params: { minScore, holdBars, commission: '0.35%' } }, equity: [] };
  }
  return buildStats(trades, { minScore, holdBars });
}

// Parameter sweep: 9 combinations (minScore × holdBars), indicators computed once
export function sweepParams(bars) {
  if (!bars || bars.length < 210) return [];
  const ind     = prepareIndicators(bars);
  const results = [];
  for (const minScore of [5, 6, 7]) {
    for (const holdBars of [20, 40, 60]) {
      const trades = simulateTrades(ind, bars, { minScore, holdBars });
      if (trades.length < 3) continue;
      const r = buildStats(trades, { minScore, holdBars });
      results.push({
        minScore, holdBars,
        ...r.stats,
        finalEquity: r.equity.at(-1) ?? 100,
      });
    }
  }
  return results.sort((a, b) => (b.profitFactor ?? 0) - (a.profitFactor ?? 0));
}

// Portfolio simulation: capital-constrained, max N concurrent positions
export function simulatePortfolio(allTrades, { capital = 100000, maxPositions = 5 } = {}) {
  if (!allTrades.length) return { trades: [], equity: [], stats: null };

  const posSize = capital / maxPositions;
  const sorted  = [...allTrades].sort((a, b) => a.date.localeCompare(b.date));

  let cash = capital;
  const active    = []; // open positions
  const closed    = []; // completed
  const snapshots = []; // portfolio value at each event

  const releaseExpired = (beforeDate) => {
    const done = active.filter(p => p.exitDate <= beforeDate);
    done.forEach(p => {
      const idx = active.indexOf(p);
      if (idx > -1) active.splice(idx, 1);
      cash += p.allocated * (1 + p.pct / 100);
      closed.push(p);
    });
  };

  for (const signal of sorted) {
    releaseExpired(signal.date);

    if (active.length < maxPositions && cash >= posSize * 0.5) {
      const allocated = Math.min(posSize, cash);
      active.push({
        sym:      signal.sym ?? 'UNKNOWN',
        entryDate: signal.date,
        exitDate:  signal.exit_date,
        pct:       signal.pct,
        allocated,
        score:     signal.score,
        outcome:   signal.outcome,
      });
      cash -= allocated;
    }

    const portfolioValue = cash + active.reduce((s, p) => s + p.allocated, 0);
    snapshots.push({ date: signal.date, value: portfolioValue });
  }

  // Close any remaining positions at their recorded returns
  active.forEach(p => { cash += p.allocated * (1 + p.pct / 100); closed.push(p); });

  const finalValue  = cash;
  const totalReturn = (finalValue - capital) / capital * 100;
  const equity      = snapshots.map(s => Math.round(s.value / capital * 10000) / 100); // normalised to 100

  const pcts = closed.map(p => p.pct);
  const wins = closed.filter(p => p.pct > 0);
  const { maxWinStreak, maxLossStreak } = calcStreaks(closed.map(p => ({ pct: p.pct })));

  return {
    trades:       closed.slice(-20),
    equity,
    snapshots,
    stats: {
      symbols:      [...new Set(closed.map(p => p.sym))].length,
      totalTrades:  closed.length,
      winRate:      closed.length ? Math.round(wins.length / closed.length * 100) : 0,
      totalReturn:  Math.round(totalReturn * 100) / 100,
      capitalStart: capital,
      capitalEnd:   Math.round(finalValue),
      maxDrawdown:  calcMaxDrawdown(equity),
      sharpe:       calcSharpe(pcts),
      avgReturn:    pcts.length ? Math.round(pcts.reduce((a, b) => a + b, 0) / pcts.length * 100) / 100 : 0,
      maxWinStreak, maxLossStreak,
    },
  };
}
