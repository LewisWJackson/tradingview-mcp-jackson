"""Alpaca API client and historical/live bar fetch helpers."""
from datetime import datetime, timedelta, timezone

import pandas as pd
from alpaca_trade_api import REST, TimeFrame, TimeFrameUnit

import config

_ALPACA_TIMEFRAMES = {
    "15Min": TimeFrame(15, TimeFrameUnit.Minute),
    "1Hour": TimeFrame(1, TimeFrameUnit.Hour),
    "4Hour": TimeFrame(4, TimeFrameUnit.Hour),
    "1Day": TimeFrame(1, TimeFrameUnit.Day),
}

BROKER_SYMBOLS = {symbol: symbol.replace("/", "") for symbol in config.INSTRUMENTS}
FROM_BROKER_SYMBOL = {broker: symbol for symbol, broker in BROKER_SYMBOLS.items()}


def get_api():
    return REST(
        key_id=config.ALPACA_API_KEY,
        secret_key=config.ALPACA_SECRET_KEY,
        base_url=config.ALPACA_BASE_URL,
    )


def fetch_bars(api, symbol, asset_class, timeframe_name, start, end=None, limit=None):
    """Return an OHLCV DataFrame (open/high/low/close/volume) sorted ascending by time."""
    tf = _ALPACA_TIMEFRAMES[timeframe_name]
    kwargs = {"timeframe": tf, "start": start.isoformat()}
    if end is not None:
        kwargs["end"] = end.isoformat()
    if limit is not None:
        kwargs["limit"] = limit

    if asset_class == "crypto":
        bars = api.get_crypto_bars(symbol, **kwargs)
    else:
        # Free Alpaca data plans only permit the IEX feed for recent data;
        # the default SIP feed 403s with "subscription does not permit
        # querying recent SIP data" once the requested range reaches "now".
        kwargs["feed"] = "iex"
        bars = api.get_bars(symbol, **kwargs)

    df = bars.df
    if df is None or df.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume"])

    if isinstance(df.index, pd.MultiIndex):
        df = df.xs(symbol, level=0)

    return df[["open", "high", "low", "close", "volume"]].sort_index()


def drop_incomplete_bar(df, timeframe_name):
    """Drop a still-forming final bar.

    The backtest evaluates on CLOSED bars. Live, the most recent daily bar is
    mid-session for most of the trading day, so signalling off it means acting on
    a different number than the backtest ever saw. Conservative rule: if the bar's
    period has not fully elapsed, drop it.
    """
    if df.empty:
        return df
    seconds_per_bar = config.TIMEFRAME_SECONDS[timeframe_name]
    last_start = df.index[-1]
    if last_start.tzinfo is None:
        last_start = last_start.tz_localize("UTC")
    if last_start + timedelta(seconds=seconds_per_bar) > datetime.now(timezone.utc):
        return df.iloc[:-1]
    return df


def fetch_recent_bars(api, symbol, asset_class, timeframe_name, bars_needed):
    """Enough CLOSED bars to satisfy the strategy's warmup, plus a buffer.

    `bars_needed` must come from engine.warmup_bars() — deriving it from param
    names silently under-fetched for regime_beta (45 bars for a 101-bar rule).
    Calendar padding: equities trade ~5 of 7 days, so ask for extra wall-clock.
    """
    seconds_per_bar = config.TIMEFRAME_SECONDS[timeframe_name]
    calendar_factor = 7.0 / 5.0 if asset_class != "crypto" else 1.0
    padded_bars = int((bars_needed + 30) * calendar_factor) + 5
    start = datetime.now(timezone.utc) - timedelta(seconds=seconds_per_bar * padded_bars)
    df = fetch_bars(api, symbol, asset_class, timeframe_name, start)
    return drop_incomplete_bar(df, timeframe_name)


def is_market_open(api, asset_class):
    if asset_class == "crypto":
        return True
    return api.get_clock().is_open
