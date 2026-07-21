# Trading Bot

Python implementation of the 5-instrument, 3-strategy system from
*"How to Build a Trading Bot with Claude Fable."* Trades SPY, QQQ, BTC/USD,
GLD, and USO against the Alpaca Markets API with ATR-based position sizing
and a hard 1%-of-equity risk cap on every trade.

```
bot/
  strategies/
    mean_reversion.py     # SPY, QQQ — 15-min, fade >1.5/1.8 std dev moves
    momentum_breakout.py  # BTC/USD — 1-hour, ride 20-period high/low breaks
    trend_following.py    # GLD, USO — 4-hour, 50/200 EMA crossover
  risk_manager.py          # ATR calc, position sizing, stops, circuit breaker
  portfolio.py             # open positions + correlation filter state
  engine.py                # shared per-bar decision logic (live + backtest)
  data_utils.py            # Alpaca client, historical/live bar fetching
  logger.py                # trades.csv / daily_pnl.csv writers
  main.py                  # continuous live/paper trading loop
  backtest.py              # 6-month historical simulation + report
config.py                  # instruments, strategy params, risk limits
.env.example                # Alpaca key template
```

## Setup

1. `pip install -r requirements.txt`
2. Copy `.env.example` to `.env` and fill in your Alpaca **paper trading** keys
   (sign up free at alpaca.markets).
3. Review `config.py` — instrument list, strategy parameters, and risk limits
   all live there.

## Step 2 — Backtest before you trade

```
python -m bot.backtest
```

Pulls 6 months of historical bars per instrument at its own timeframe, runs
each strategy standalone plus a combined multi-asset simulation with the
correlation filter engaged, applies 0.05% slippage per trade, and prints a
summary table (trades, win rate, avg win/loss, profit factor, max drawdown,
Sharpe ratio, total return). Saves `backtest_results.png` with per-instrument
and combined equity curves. Any strategy with a negative Sharpe ratio is
flagged in the output — adjust its parameters before paper trading it.

## Step 3 — Paper trade for 2+ weeks

Make sure `.env` points at `https://paper-api.alpaca.markets`, then:

```
python -m bot.main
```

Runs forever, checking each instrument at its own timeframe. Every closed
trade is appended to `trades.csv`; equity is appended to `daily_pnl.csv` once
per day at UTC rollover. Watch these files to confirm entries/exits, position
sizing, stops, and the correlation filter are all behaving as expected before
risking real money.

## Step 4 — Daily briefings

Set up two Claude Cowork routines that read `trades.csv` / `daily_pnl.csv` and
the current Alpaca positions, and post a morning (7am) and evening (9pm)
summary to Telegram or Slack — see the source guide for the exact prompts.

## Step 5 — Go live (only after paper trading succeeds)

Swap `.env` to your live Alpaca keys (`https://api.alpaca.markets`) and run
the bot on a VPS under a process manager (PM2 or systemd) so it restarts
automatically if it crashes. Start with an amount you're fully prepared to
lose — the 1% risk-per-trade rule means a $10,000 account risks $100/trade.

## Risk rules (enforced in `risk_manager.py` / `portfolio.py`)

- **1% max risk per trade** — ATR-based position sizing means a 1-ATR
  adverse move always costs exactly 1% of equity; that distance *is* the
  hard stop.
- **Trailing stops only tighten** — 2x ATR (BTC) / 3x ATR (GLD, USO) trailing
  stops ratchet in the position's favor and never loosen past the original
  hard stop.
- **Correlation filter** — no new BTC/USD long while SPY and QQQ are both
  already long, to avoid doubling up on risk-on exposure.
- **Circuit breaker** — a 10% drawdown from the equity peak flattens every
  position and halts the loop until a human reviews what happened.

## Disclaimer

Educational reference implementation, not investment advice. Trading
involves real financial risk; past performance does not guarantee future
results. Never trade with money you can't afford to lose. Backtest and
paper trade extensively — for at least 2 weeks — before using real money.
