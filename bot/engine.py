"""Per-bar decision engine shared by the live loop and the backtester.

Keeping this logic in one place guarantees the backtest simulates the exact
same entry/exit/stop/correlation rules the live bot trades with.
"""
import importlib

import pandas as pd

from .risk_manager import calculate_atr

_STRATEGY_MODULES = {
    "mean_reversion": "bot.strategies.mean_reversion",
    "momentum_breakout": "bot.strategies.momentum_breakout",
    "trend_following": "bot.strategies.trend_following",
    "regime_beta": "bot.strategies.regime_beta",
    "buy_hold": "bot.strategies.buy_hold",
}


def _strategy_module(name):
    return importlib.import_module(_STRATEGY_MODULES[name])


def warmup_bars(instrument_cfg, atr_period=14):
    """Bars this instrument needs before it can produce a signal.

    Asks the strategy itself rather than guessing from param names. The old live
    loop inferred this from `slow_ema`/`lookback`, which regime_beta does not use
    — so it silently fetched 45 bars for a rule needing 101 and never signalled.
    """
    strategy = _strategy_module(instrument_cfg["strategy"])
    params = instrument_cfg["params"]
    required = strategy.warmup_bars(params) if hasattr(strategy, "warmup_bars") else 0
    # ATR (and the engine's own 2-bar minimum) are needed regardless of strategy.
    return max(required, atr_period + 1, 2)


def entry_stop_price(instrument_cfg, entry_price, atr, direction, risk_manager, equity, qty):
    """The stop this instrument's sizing mode implies — the single source of truth.

    Both new entries and startup reconciliation MUST use this. Reconciliation used
    to rebuild stops with hard_stop_price (~1 ATR) regardless of config, which
    re-armed the tight stop on fixed-fractional positions after every restart —
    the exact 1-ATR failure mode this project already traced to a -100% wipeout.
    """
    params = instrument_cfg["params"]
    if params.get("sizing") == "fixed_fractional":
        return risk_manager.atr_stop_price(entry_price, atr, direction, params.get("stop_atr_mult", 8.0))
    return risk_manager.hard_stop_price(entry_price, equity, qty, direction)


def evaluate(symbol, instrument_cfg, df, portfolio, risk_manager, equity):
    """Advance one bar for `symbol`. Returns a dict describing any action taken, or None."""
    if len(df) < 2:
        return None

    strategy = _strategy_module(instrument_cfg["strategy"])
    params = instrument_cfg["params"]

    atr = calculate_atr(df, period=risk_manager.atr_period).iloc[-1]
    price = df["close"].iloc[-1]
    bar_low = df["low"].iloc[-1]
    bar_high = df["high"].iloc[-1]

    position = portfolio.get(symbol)

    # 1. Stops take priority over signals — a position never rides past its stop.
    if position is not None:
        stopped_out = (
            bar_low <= position["stop_price"]
            if position["direction"] == "long"
            else bar_high >= position["stop_price"]
        )
        if stopped_out:
            closed = portfolio.close_position(symbol)
            return {"action": "stop", "symbol": symbol, "price": closed["stop_price"], "position": closed}

        if position["trailing_atr_mult"]:
            position["stop_price"] = risk_manager.update_trailing_stop(
                position["stop_price"], price, atr, position["direction"], position["trailing_atr_mult"]
            )

    # 2. Strategy-driven exit/entry signal.
    signal = strategy.generate_signal(df, position, params)

    if position is not None and signal == "exit":
        closed = portfolio.close_position(symbol)
        return {"action": "exit", "symbol": symbol, "price": price, "position": closed}

    if position is None and signal in ("long", "short"):
        if portfolio.blocks_new_position(symbol, signal):
            return {"action": "blocked", "symbol": symbol, "price": price}
        if pd.isna(atr) or atr <= 0:
            return None
        if params.get("sizing") == "fixed_fractional":
            # Deploy a fixed fraction of equity; the strategy's own exit is the
            # primary risk control, with a wide ATR stop as a disaster backstop.
            qty = risk_manager.fixed_fractional_size(equity, price, params.get("allocation", 0.95))
        else:
            qty = risk_manager.position_size(equity, atr, params.get("stop_atr_mult", 1.0))
        stop_price = entry_stop_price(instrument_cfg, price, atr, signal, risk_manager, equity, qty)
        if qty <= 0:
            return None
        trailing_mult = params.get("trailing_atr_mult")
        portfolio.open_position(symbol, signal, qty, price, stop_price, atr, trailing_mult)
        return {
            "action": "open",
            "symbol": symbol,
            "direction": signal,
            "price": price,
            "qty": qty,
            "stop_price": stop_price,
        }

    return None
