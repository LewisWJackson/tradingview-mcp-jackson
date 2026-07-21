"""Mean reversion strategy for range-bound index ETFs (SPY, QQQ).

Fades moves more than `std_dev_threshold` standard deviations from the
rolling mean, expecting a revert; exits once price is back near the mean.

Optional trend filter (`trend_ma_period`): when set, only take reversions that
ALIGN with the longer trend — buy dips only while price is above the trend MA
(an uptrend), sell rips only while below it (a downtrend). This suppresses the
"catching a falling knife" trades — fading a sustained move against you — which
are the dominant loss source when the filter is off.
"""
import pandas as pd


def generate_signal(df, position, params):
    lookback = params.get("lookback", 20)
    threshold = params.get("std_dev_threshold", 1.5)
    exit_threshold = params.get("exit_std_dev", 0.25)
    trend_ma_period = params.get("trend_ma_period")  # None disables the filter

    if len(df) < lookback + 1:
        return None

    closes = df["close"]
    mean = closes.rolling(lookback).mean().iloc[-1]
    stdev = closes.rolling(lookback).std().iloc[-1]

    if pd.isna(stdev) or stdev == 0:
        return None

    price = closes.iloc[-1]
    z_score = (price - mean) / stdev

    # Exit logic (return to the mean) is unaffected by the trend filter — an
    # open position always gets to close on its own signal.
    if position is not None:
        if abs(z_score) <= exit_threshold:
            return "exit"
        return None

    # Entry: optionally gate by trend alignment.
    long_ok = short_ok = True
    if trend_ma_period:
        if len(df) < trend_ma_period + 1:
            return None
        trend_ma = closes.rolling(trend_ma_period).mean().iloc[-1]
        if pd.isna(trend_ma):
            return None
        uptrend = price > trend_ma
        long_ok = uptrend        # only buy dips while in an uptrend
        short_ok = not uptrend   # only sell rips while in a downtrend

    if z_score <= -threshold and long_ok:
        return "long"
    if z_score >= threshold and short_ok:
        return "short"
    return None


def warmup_bars(params):
    return max(params.get("lookback", 20), params.get("trend_ma_period") or 0) + 1
