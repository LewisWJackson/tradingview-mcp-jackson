"""Regime-filtered beta: hold the index long only while it's above its trend SMA.

Owns beta in uptrends and steps to cash once price closes below the trend line,
sidestepping sustained downtrends. Long/flat only — shorting index ETFs lost
across every test in this project. The regime flip (price crossing back below
the SMA) is the real exit; any ATR hard stop should be set WIDE, as a disaster
backstop only, so a multi-week hold is never noise-stopped.

Validated out-of-sample (36mo daily, IS/OOS split): vs buy&hold it delivers
similar-or-better Sharpe at roughly half the max drawdown. It does NOT beat
buy&hold's raw return in a bull run — its job is drawdown control, not alpha.
"""
import pandas as pd


def generate_signal(df, position, params):
    sma_period = params.get("sma_period", 100)

    if len(df) < sma_period + 1:
        return None

    close = df["close"]
    sma = close.rolling(sma_period).mean().iloc[-1]
    if pd.isna(sma):
        return None

    price = close.iloc[-1]

    if position is None:
        return "long" if price > sma else None

    # Holding: exit to cash when the regime turns down.
    if price < sma:
        return "exit"
    return None


def warmup_bars(params):
    """Bars generate_signal needs before it can ever return a signal."""
    return params.get("sma_period", 100) + 1
