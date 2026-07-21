---
name: trading-fundamentals
description: Reference knowledge base for designing, tuning, or diagnosing algorithmic trading strategies — chart pattern concepts, indicator families and the market regime each suits, risk management fundamentals, and how to read backtest metrics (win rate, profit factor, Sharpe ratio, max drawdown) to figure out what's wrong. Consult this whenever proposing a new strategy, choosing or adjusting indicator parameters (lookback lengths, thresholds, EMA periods), reviewing a Pine Script strategy or indicator, or explaining why a strategy is underperforming in a backtest — even if the user doesn't use words like "strategy" or "indicator" explicitly (e.g. "why did this lose money," "what should I change," "is this the right timeframe for this"). Curated from babypips.com's School of Pipsology, adapted for building/tuning systematic strategies rather than discretionary trading.
---

# Trading Fundamentals — Strategy Design Reference

This is a working reference, not a course. It exists so that before proposing a new
strategy, changing a parameter, or explaining a backtest result, there's a shared
vocabulary for *why* a given approach fits (or doesn't fit) the market behavior it's
being pointed at.

Source note: the concepts below are a curated, original summary inspired by
[babypips.com's "School of Pipsology"](https://www.babypips.com/learn), adapted here
for systematic/algorithmic strategy design rather than discretionary trading. It is
not a copy of that material — for a fuller, beginner-oriented treatment of any of
these topics, go to the source.

## 1. Chart Pattern Concepts

These describe recurring price *shapes* that reflect shifts in supply/demand. They
matter for strategy design mainly as a sanity check: does the price action driving a
signal actually look like the regime the strategy assumes?

- **Support / resistance** — price levels where buying or selling pressure has
  repeatedly reversed or paused a move. The more times a level is tested without
  breaking, the more traders treat it as real, which becomes self-reinforcing.
- **Trend channels** — a sustained move bounded by a rising or falling pair of
  parallel lines (upper/lower). A channel is trending price organized enough for
  trend-following logic to have an edge.
- **Continuation patterns** (flags, pennants, triangles, wedges) — a pause inside a
  trend before it resumes in the same direction. Breakout strategies are essentially
  betting that a continuation pattern is currently forming and about to resolve.
- **Reversal patterns** (double top/bottom, head and shoulders, rounding tops) — a
  trend running out of momentum and turning. Mean-reversion strategies are implicitly
  betting the current move is exhausted, i.e. that a reversal (even a minor one) is
  close.

## 2. Indicator Families and the Market Condition Each Fits

Every indicator is a lens on price, and every lens is well-suited to some conditions
and actively misleading in others. The single most common cause of a strategy
underperforming isn't a bad formula — it's a good formula pointed at the wrong regime.

**Trend-following indicators** — assume the current direction is likely to persist.
- Moving averages (SMA/EMA) and MA crossovers: smooth out noise to reveal direction;
  lag behind sharp reversals by construction.
- MACD: a moving-average-of-differences that reacts faster than a raw crossover while
  still fundamentally trend-based.
- ADX: measures trend *strength* (not direction) — useful as a filter to avoid running
  trend logic in a directionless market.

**Mean-reversion / oscillator indicators** — assume price overextends and snaps back.
- RSI, stochastics: bounded oscillators that flag "stretched" conditions
  (overbought/oversold) relative to recent range.
- Bollinger Bands / standard-deviation bands: flag price that has moved an unusual
  distance from its rolling average — the same idea `bot/strategies/mean_reversion.py`
  implements directly with a rolling SMA + std-dev z-score.
- These indicators are naturally suited to *ranging* markets and get run over in
  sustained trends, because "overbought" can just mean "still going up."

**Volatility indicators** — describe how much price is moving, not which way.
- ATR (Average True Range): average bar-to-bar range: the basis for volatility-adjusted
  position sizing and stop distance (see `bot/risk_manager.py`).
- Bollinger Band width / rolling std dev: widening bands signal expanding volatility
  (often preceding a breakout); tightening bands ("squeeze") often precede one.

**Volume** — confirms whether a move has real participation behind it, which is why
`bot/strategies/momentum_breakout.py` requires volume above a multiple of its recent
average before trusting a breakout — a breakout on thin volume is far more likely to
be a false start that reverses.

## 3. Risk Management Fundamentals

Strategy logic decides *when* to trade; risk management decides *how big* and *how
much can go wrong*. A mediocre strategy with disciplined risk management usually
survives; a great strategy without it usually doesn't.

- **Position sizing** — sizing a trade off its stop distance (rather than a fixed
  share count) keeps risk constant in dollar terms across instruments with very
  different volatility. This is what ATR-based sizing does: size = (equity × risk%) /
  ATR, so a 1-ATR adverse move always costs the same fraction of equity regardless of
  how volatile the instrument is.
- **Risk-per-trade** — the fraction of equity a single trade can lose if its stop is
  hit. Keeping this small and constant (1% is a common default) means no single trade,
  or even a losing streak, can meaningfully damage the account.
- **Risk:reward ratio** — the size of a typical win relative to a typical loss. A
  strategy can have a win rate under 50% and still be profitable if its average winner
  is large enough relative to its average loser (this is exactly what "profit factor"
  in a backtest report is measuring).
- **Correlation risk** — several positions that are nominally "different trades" but
  driven by the same underlying factor (e.g. broad risk-on sentiment) behave like one
  oversized position when they move together. A correlation filter (see
  `bot/portfolio.py`) exists to stop the strategy from unknowingly stacking correlated
  exposure under the appearance of diversification.
- **Drawdown limits / circuit breakers** — a hard ceiling on how far equity can fall
  from its peak before trading halts entirely. This exists because strategies can look
  fine in aggregate metrics while still having tail scenarios that compound losses
  quickly; a circuit breaker forces a human review before that compounds further.

## 4. Mapping Concepts to This Repo's Strategy Archetypes

`bot/strategies/` implements three archetypes. Each is a bet on a specific market
regime, and each fails in a specific, predictable way when that regime isn't present.

**Mean reversion** (`mean_reversion.py` — SPY/QQQ, rolling SMA + std-dev bands)
- Fits: ranging, choppy, or mildly noisy markets that oscillate around a stable mean.
- Fails: sustained trends. A "1.5 std dev below the mean" long entry that's actually
  the start of a real downtrend produces stopped-out fades over and over — the
  strategy keeps calling the top of a decline that keeps declining.
- Commonly tuned: the std-dev threshold (wider = fewer, higher-conviction entries;
  narrower = more, lower-conviction entries — QQQ's 1.8 vs. SPY's 1.5 in this repo is
  exactly this trade-off), the lookback window (longer = smoother/slower mean), and
  the exit threshold (how close to the mean counts as "reverted").

**Momentum breakout** (`momentum_breakout.py` — BTC/USD, N-period high/low + volume)
- Fits: markets prone to sharp, sustained directional moves once a level breaks —
  crypto and other assets without the mean-reverting "specialist"/market-maker
  dynamics that keep equity indices range-bound.
- Fails: choppy, range-bound conditions, where price pokes above/below the recent
  range repeatedly without following through — every "breakout" is a false start that
  immediately reverses (this shows up in a backtest as a low win rate with a poor
  profit factor, since losers are roughly as large as winners but far more frequent).
- Commonly tuned: the lookback window (shorter = more breakouts, more false signals;
  longer = fewer, more significant levels), the volume-confirmation multiplier
  (stricter filtering trades quantity for quality), and the trailing-stop ATR
  multiplier (how much room a winning trade gets before giving profit back).

**Trend following** (`trend_following.py` — GLD/USO, EMA crossover)
- Fits: assets that move in long, clean waves with relatively low noise — commodities
  and other slower, macro-driven markets rather than intraday-noisy ones.
- Fails: whipsaw conditions, where price oscillates across the crossover level
  repeatedly without establishing a real trend, generating a string of small losses.
  Also fails silently when it's simply *undertested* — a slow crossover (e.g. 50/200)
  needs a long history to even fire once, so a short backtest window can show "zero
  trades" that looks like "no signal" but is really "not enough data" (see
  `bot/backtest.py`'s thin-sample warning).
- Commonly tuned: the fast/slow period pair (a wider gap = fewer, more significant
  crossovers; a narrower gap = faster reaction but more whipsaw), and the trailing-stop
  ATR multiplier (trend strategies typically want more trailing room than mean
  reversion, since the entire thesis is "let the winner run").

## 5. Diagnosing a Backtest

Given a metrics table (trades, win rate, avg win/loss, profit factor, max drawdown,
Sharpe ratio, total return), here's what to suspect first, roughly in the order to
check them:

- **Very few trades** → check data sufficiency before concluding anything about the
  strategy itself. A slow indicator (long EMA, long lookback) run over a short window
  can produce almost no signals — that's a data problem, not a strategy verdict.
- **Negative Sharpe ratio** → risk-adjusted returns were negative over the period.
  Before touching parameters, ask whether the regime during the tested window actually
  matched what the strategy assumes (e.g. a mean-reversion strategy tested across a
  strongly trending period is close to a stacked deck against it).
- **Low win rate + profit factor > 1** → normal and often healthy for breakout/trend
  strategies — many small losses, offset by a few large winners. Don't "fix" the win
  rate at the expense of the winners that are actually carrying the strategy.
- **High win rate + profit factor < 1** → the strategy wins often but the losses,
  when they happen, are large enough to erase the gains. Look at stop placement and
  trailing-stop distance first — this pattern usually means stops are too loose or
  aren't being respected.
- **High max drawdown relative to total return** → check position sizing and the
  correlation filter before assuming the entry/exit logic is broken. A string of
  correlated losses hits much harder than the same number of independent ones.
- **Combined portfolio metrics much worse than the average of the per-instrument
  ones** → the correlation filter or shared-equity interaction between instruments is
  doing something worth inspecting directly, rather than a flaw in any single
  strategy.
