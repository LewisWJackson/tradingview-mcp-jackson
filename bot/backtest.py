"""Backtests all 3 strategies against 6 months of historical Alpaca data.

Runs two kinds of simulation:
  - Per-instrument standalone: each symbol trades alone against its own
    equity, isolating that strategy's raw performance (no correlation filter,
    since there's nothing else in the book to correlate against).
  - Combined portfolio: all 5 instruments trade against one shared equity
    pool, in chronological order, with the correlation filter engaged —
    this is the realistic "whole book" performance number.

Both use the exact same `bot.engine.evaluate` used by the live loop, so the
backtest reflects what the bot will actually do.
"""
import sys
from datetime import datetime, timezone

import pandas as pd
from dateutil.relativedelta import relativedelta

import config
from . import data_utils
from . import engine
from .portfolio import Portfolio
from .risk_manager import RiskManager

DEFAULT_INITIAL_CAPITAL = 100_000.0
DEFAULT_SLIPPAGE_PCT = 0.0005  # 0.05% per trade
DEFAULT_MONTHS_BACK = 6

# Below this many closed trades, an annualized Sharpe computed off a sparse,
# mostly-flat equity curve is dominated by discretization noise (long runs of
# exact-zero daily returns deflate the std and blow up |Sharpe|). We report it
# as N/A instead and judge low-sample strategies on expectancy / PF / drawdown.
MIN_TRADES_FOR_SHARPE = 30


def _apply_slippage(price, direction, slippage_pct, entering):
    """Buys execute slightly worse (higher fill); sells execute slightly worse (lower fill)."""
    paying_more = (direction == "long") == entering
    return price * (1 + slippage_pct) if paying_more else price * (1 - slippage_pct)


def _mark_to_market(portfolio, last_price, realized_equity):
    unrealized = 0.0
    for symbol, position in portfolio.positions.items():
        price = last_price.get(symbol, position["entry_price"])
        if position["direction"] == "long":
            unrealized += (price - position["entry_price"]) * position["qty"]
        else:
            unrealized += (position["entry_price"] - price) * position["qty"]
    return realized_equity + unrealized


def run_single_instrument_backtest(symbol, instrument_cfg, bars_df, initial_capital, slippage_pct, atr_period, halt_on_circuit_breaker=True):
    portfolio = Portfolio(correlation_filter=[])
    risk_manager = RiskManager(
        risk_per_trade=config.RISK_PER_TRADE,
        atr_period=atr_period,
        max_portfolio_drawdown=config.MAX_PORTFOLIO_DRAWDOWN,
    )
    equity = initial_capital
    peak_equity = equity
    trades = []
    equity_curve = []
    open_trade = None
    halted = False

    for i in range(len(bars_df)):
        if halted:
            break
        window = bars_df.iloc[: i + 1]
        ts = bars_df.index[i]
        last_price = {symbol: window["close"].iloc[-1]}

        result = engine.evaluate(symbol, instrument_cfg, window, portfolio, risk_manager, equity)

        if result and result["action"] == "open":
            fill_price = _apply_slippage(result["price"], result["direction"], slippage_pct, entering=True)
            portfolio.positions[symbol]["entry_price"] = fill_price
            open_trade = {
                "symbol": symbol,
                "direction": result["direction"],
                "entry_time": ts,
                "entry_price": fill_price,
                "qty": result["qty"],
                "exit_time": None,
                "exit_price": None,
                "pnl": None,
            }
            trades.append(open_trade)

        elif result and result["action"] in ("exit", "stop"):
            position = result["position"]
            fill_price = _apply_slippage(result["price"], position["direction"], slippage_pct, entering=False)
            if open_trade is not None and open_trade["exit_time"] is None:
                pnl = (
                    (fill_price - open_trade["entry_price"]) * position["qty"]
                    if position["direction"] == "long"
                    else (open_trade["entry_price"] - fill_price) * position["qty"]
                )
                open_trade.update({"exit_time": ts, "exit_price": fill_price, "pnl": pnl})
                equity += pnl
            open_trade = None

        mark_to_market_equity = _mark_to_market(portfolio, last_price, equity)
        peak_equity = max(peak_equity, mark_to_market_equity)
        equity_curve.append((ts, mark_to_market_equity))

        if halt_on_circuit_breaker and risk_manager.circuit_breaker_triggered(mark_to_market_equity, peak_equity):
            halted = True

    closed_trades = [t for t in trades if t["exit_time"] is not None]
    return {
        "trades": closed_trades,
        "equity_curve": equity_curve,
        "final_equity": equity_curve[-1][1] if equity_curve else initial_capital,
    }


def run_combined_backtest(bars_by_symbol, initial_capital, slippage_pct, atr_period, halt_on_circuit_breaker=True):
    portfolio = Portfolio(correlation_filter=config.CORRELATION_FILTER)
    risk_manager = RiskManager(
        risk_per_trade=config.RISK_PER_TRADE,
        atr_period=atr_period,
        max_portfolio_drawdown=config.MAX_PORTFOLIO_DRAWDOWN,
    )
    equity = initial_capital
    peak_equity = equity
    trades = []
    equity_curve = []
    last_price = {}
    open_trade_by_symbol = {}
    halted = False

    events = []
    for symbol, df in bars_by_symbol.items():
        for i, ts in enumerate(df.index):
            events.append((ts, symbol, i))
    events.sort(key=lambda e: (e[0], e[1]))

    for ts, symbol, i in events:
        if halted:
            break
        instrument_cfg = config.INSTRUMENTS[symbol]
        window = bars_by_symbol[symbol].iloc[: i + 1]
        last_price[symbol] = window["close"].iloc[-1]

        result = engine.evaluate(symbol, instrument_cfg, window, portfolio, risk_manager, equity)

        if result and result["action"] == "open":
            fill_price = _apply_slippage(result["price"], result["direction"], slippage_pct, entering=True)
            portfolio.positions[symbol]["entry_price"] = fill_price
            trade = {
                "symbol": symbol,
                "direction": result["direction"],
                "entry_time": ts,
                "entry_price": fill_price,
                "qty": result["qty"],
                "exit_time": None,
                "exit_price": None,
                "pnl": None,
            }
            trades.append(trade)
            open_trade_by_symbol[symbol] = trade

        elif result and result["action"] in ("exit", "stop"):
            position = result["position"]
            fill_price = _apply_slippage(result["price"], position["direction"], slippage_pct, entering=False)
            trade = open_trade_by_symbol.pop(symbol, None)
            if trade is not None:
                pnl = (
                    (fill_price - trade["entry_price"]) * position["qty"]
                    if position["direction"] == "long"
                    else (trade["entry_price"] - fill_price) * position["qty"]
                )
                trade.update({"exit_time": ts, "exit_price": fill_price, "pnl": pnl})
                equity += pnl

        mark_to_market_equity = _mark_to_market(portfolio, last_price, equity)
        peak_equity = max(peak_equity, mark_to_market_equity)
        equity_curve.append((ts, mark_to_market_equity))

        if halt_on_circuit_breaker and risk_manager.circuit_breaker_triggered(mark_to_market_equity, peak_equity):
            halted = True

    closed_trades = [t for t in trades if t["exit_time"] is not None]
    return {
        "trades": closed_trades,
        "equity_curve": equity_curve,
        "final_equity": equity_curve[-1][1] if equity_curve else initial_capital,
    }


def compute_metrics(trades, equity_curve, initial_capital, periods_per_year=252):
    """Backtest performance metrics.

    `periods_per_year` sets the annualization factor for the daily Sharpe: 252
    for equities (trading-day calendar) and 365 for 24/7 crypto. The annualized
    Sharpe is only reported once there are at least MIN_TRADES_FOR_SHARPE closed
    trades; below that it is returned as None (see the constant's rationale).

    `expectancy` (mean PnL per trade) and `trade_sharpe` (mean/std of per-trade
    PnL, no annualization) are robust at low trade counts and are the intended
    primary scorecard alongside total_return, profit_factor, and max_drawdown.
    """
    if not equity_curve:
        return {
            "total_trades": 0,
            "win_rate": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "profit_factor": 0.0,
            "expectancy": 0.0,
            "trade_sharpe": None,
            "max_drawdown": 0.0,
            "sharpe_ratio": None,
            "total_return": 0.0,
        }

    if not trades:
        # No CLOSED trades, but the equity curve is still real — a buy-and-hold
        # anchor sleeve (bot/strategies/buy_hold.py) holds one open position and
        # never exits, so every trade-based stat is undefined while mark-to-market
        # return and drawdown are perfectly well defined. Zeroing these (the old
        # behavior) silently reported a held sleeve as "0.0% return, 0.0% DD".
        equity_series = pd.Series(
            [e for _, e in equity_curve], index=pd.DatetimeIndex([t for t, _ in equity_curve])
        )
        daily_equity = equity_series.resample("1D").last().ffill().dropna()
        running_max = daily_equity.cummax()
        max_drawdown = float(((running_max - daily_equity) / running_max).max()) if len(daily_equity) else 0.0
        final_equity = equity_curve[-1][1]
        return {
            "total_trades": 0,
            "win_rate": 0.0,
            "avg_win": 0.0,
            "avg_loss": 0.0,
            "profit_factor": 0.0,
            "expectancy": 0.0,
            "trade_sharpe": None,
            "max_drawdown": max_drawdown,
            "sharpe_ratio": None,
            "total_return": (final_equity - initial_capital) / initial_capital,
        }

    pnls = [t["pnl"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]

    win_rate = len(wins) / len(pnls)
    avg_win = sum(wins) / len(wins) if wins else 0.0
    avg_loss = sum(losses) / len(losses) if losses else 0.0
    gross_profit = sum(wins)
    gross_loss = abs(sum(losses))
    profit_factor = gross_profit / gross_loss if gross_loss > 0 else float("inf")

    # Per-trade stats — no zero-day dilution, no annualization guesswork.
    expectancy = sum(pnls) / len(pnls)
    pnl_series = pd.Series(pnls, dtype="float64")
    trade_sharpe = (
        pnl_series.mean() / pnl_series.std(ddof=1)
        if len(pnls) > 1 and pnl_series.std(ddof=1) > 0
        else None
    )

    equity_series = pd.Series(
        [e for _, e in equity_curve], index=pd.DatetimeIndex([t for t, _ in equity_curve])
    )
    daily_equity = equity_series.resample("1D").last().ffill().dropna()
    daily_returns = daily_equity.pct_change().dropna()

    drawdown_series = (daily_equity / daily_equity.cummax()) - 1
    max_drawdown = abs(drawdown_series.min()) if not drawdown_series.empty else 0.0

    # Annualized Sharpe is only meaningful with enough trades to populate the
    # equity curve; below the threshold the mostly-zero daily series makes it
    # noise, so we withhold it rather than report a misleading number.
    if (
        len(pnls) >= MIN_TRADES_FOR_SHARPE
        and len(daily_returns) > 1
        and daily_returns.std(ddof=1) > 0
    ):
        sharpe_ratio = (daily_returns.mean() / daily_returns.std(ddof=1)) * (periods_per_year ** 0.5)
    else:
        sharpe_ratio = None

    final_equity = equity_curve[-1][1]
    total_return = (final_equity - initial_capital) / initial_capital

    return {
        "total_trades": len(pnls),
        "win_rate": win_rate,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "profit_factor": profit_factor,
        "expectancy": expectancy,
        "trade_sharpe": trade_sharpe,
        "max_drawdown": max_drawdown,
        "sharpe_ratio": sharpe_ratio,
        "total_return": total_return,
    }


def _fmt_metric_row(label, m):
    def num(value, spec):
        return "N/A" if value is None else format(value, spec)

    return [
        label,
        m["total_trades"],
        f"{m['win_rate']:.1%}",
        f"${m['avg_win']:.2f}",
        f"${m['avg_loss']:.2f}",
        f"{m['profit_factor']:.2f}",
        f"${m['expectancy']:.2f}",
        num(m["trade_sharpe"], ".2f"),
        f"{m['max_drawdown']:.1%}",
        num(m["sharpe_ratio"], ".2f"),
        f"{m['total_return']:.1%}",
    ]


def _print_summary(per_instrument_metrics, combined_metrics, months_back):
    header = [
        "Instrument", "Trades", "Win Rate", "Avg Win", "Avg Loss", "Profit Factor",
        "Expectancy", "Trade Sharpe", "Max DD", "Sharpe", "Total Return",
    ]
    rows = [_fmt_metric_row(symbol, m) for symbol, m in per_instrument_metrics.items()]
    rows.append(_fmt_metric_row("COMBINED", combined_metrics))

    widths = [max(len(str(row[i])) for row in ([header] + rows)) for i in range(len(header))]
    print(f"\nBACKTEST SUMMARY ({months_back} months, correlation filter active on COMBINED row)")
    print(" | ".join(h.ljust(widths[i]) for i, h in enumerate(header)))
    print("-+-".join("-" * w for w in widths))
    for row in rows:
        print(" | ".join(str(v).ljust(widths[i]) for i, v in enumerate(row)))


def _plot_equity_curves(per_instrument_results, combined_result, out_path, months_back):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(12, 6))
    for symbol, result in per_instrument_results.items():
        if not result["equity_curve"]:
            continue
        times, values = zip(*result["equity_curve"])
        ax.plot(times, values, label=symbol, alpha=0.6, linewidth=1)

    if combined_result["equity_curve"]:
        times, values = zip(*combined_result["equity_curve"])
        ax.plot(times, values, label="COMBINED", color="black", linewidth=2.5)

    ax.set_title(f"Backtest Equity Curves — {months_back} Months")
    ax.set_xlabel("Date")
    ax.set_ylabel("Equity ($)")
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(out_path, dpi=150)
    plt.close(fig)
    print(f"\nEquity curve chart saved to {out_path}")


def _min_bars_required(cfg):
    """Bars needed before the strategy can generate its first signal at all."""
    params = cfg["params"]
    return max(params.get("slow_ema", 0), params.get("lookback", 0), config.ATR_PERIOD) + 2


def run(initial_capital=DEFAULT_INITIAL_CAPITAL, months_back=DEFAULT_MONTHS_BACK, slippage_pct=DEFAULT_SLIPPAGE_PCT,
        halt_on_circuit_breaker=False):
    # Evaluation default: DON'T permanently halt on the circuit breaker. The
    # live bot flattens and stops after a 10% portfolio drawdown, but reusing
    # that in a backtest truncates the sample to "until the first bad drawdown"
    # (e.g. SPY halted 2 days into a 24-month window), which defeats the point
    # of measuring the strategy across the whole period. Pass --live-halt to
    # reproduce the live behavior instead.
    api = data_utils.get_api()
    end = datetime.now(timezone.utc)
    start = end - relativedelta(months=months_back)

    bars_by_symbol = {}
    for symbol, cfg in config.INSTRUMENTS.items():
        print(f"Fetching {months_back} months of {cfg['timeframe']} bars for {symbol}...")
        bars_by_symbol[symbol] = data_utils.fetch_bars(api, symbol, cfg["asset_class"], cfg["timeframe"], start, end)
        min_bars = _min_bars_required(cfg)
        bar_count = len(bars_by_symbol[symbol])
        if bar_count < min_bars * 3:
            print(
                f"  NOTE: {symbol} only has {bar_count} bars ({min_bars} needed just to fire once) — "
                f"results for this instrument are likely too thin a sample to trust."
            )

    per_instrument_results = {}
    per_instrument_metrics = {}
    for symbol, cfg in config.INSTRUMENTS.items():
        df = bars_by_symbol[symbol]
        result = run_single_instrument_backtest(
            symbol, cfg, df, initial_capital, slippage_pct, config.ATR_PERIOD,
            halt_on_circuit_breaker=halt_on_circuit_breaker,
        )
        per_instrument_results[symbol] = result
        periods = 365 if cfg["asset_class"] == "crypto" else 252
        per_instrument_metrics[symbol] = compute_metrics(
            result["trades"], result["equity_curve"], initial_capital, periods_per_year=periods
        )

    combined_result = run_combined_backtest(
        bars_by_symbol, initial_capital, slippage_pct, config.ATR_PERIOD,
        halt_on_circuit_breaker=halt_on_circuit_breaker,
    )
    # Combined curve is calendar-day and spans 24/7 crypto, so annualize on 365.
    combined_metrics = compute_metrics(
        combined_result["trades"], combined_result["equity_curve"], initial_capital, periods_per_year=365
    )

    mode = "live-halt (stops on 10% drawdown)" if halt_on_circuit_breaker else "eval (trades through drawdowns, full-window sample)"
    print(f"\nCircuit-breaker mode: {mode}")
    _print_summary(per_instrument_metrics, combined_metrics, months_back)
    _plot_equity_curves(per_instrument_results, combined_result, "backtest_results.png", months_back)

    # Judge the edge on per-trade expectancy, which is meaningful at low sample
    # sizes; negative expectancy means the strategy loses money per trade on
    # average regardless of how the (withheld) annualized Sharpe looks.
    negative_expectancy = [
        s for s, m in per_instrument_metrics.items()
        if m["total_trades"] > 0 and m["expectancy"] <= 0
    ]
    if negative_expectancy:
        print(f"\nFLAGGED — negative per-trade expectancy over the {months_back}-month backtest: {', '.join(negative_expectancy)}")
        print("These lose money per trade on average; fix entries/exits before paper or live trading.")

    low_sample = [
        s for s, m in per_instrument_metrics.items()
        if 0 < m["total_trades"] < MIN_TRADES_FOR_SHARPE
    ]
    if low_sample:
        print(f"\nNOTE — fewer than {MIN_TRADES_FOR_SHARPE} trades, so Sharpe is withheld as unreliable: {', '.join(low_sample)}")
        print("Judge these on expectancy, profit factor, and drawdown — not on a noisy Sharpe.")

    if combined_metrics["max_drawdown"] > 0.15:
        print(f"\nWARNING — combined portfolio max drawdown {combined_metrics['max_drawdown']:.1%} exceeds 15%.")

    return {"per_instrument": per_instrument_metrics, "combined": combined_metrics}


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Backtest the multi-strategy trading bot against Alpaca data.")
    parser.add_argument("--months", type=int, default=DEFAULT_MONTHS_BACK, help="Months of history to pull (default: 6)")
    parser.add_argument("--capital", type=float, default=DEFAULT_INITIAL_CAPITAL, help="Starting capital (default: 100000)")
    parser.add_argument("--slippage", type=float, default=DEFAULT_SLIPPAGE_PCT, help="Slippage per trade as a fraction (default: 0.0005)")
    parser.add_argument(
        "--live-halt",
        action="store_true",
        help="Permanently halt each backtest on the circuit breaker, as the live bot does "
             "(default: off — trade through drawdowns so the full window is sampled).",
    )
    args = parser.parse_args()

    run(
        initial_capital=args.capital,
        months_back=args.months,
        slippage_pct=args.slippage,
        halt_on_circuit_breaker=args.live_halt,
    )
