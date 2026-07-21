"""Trend following strategy for commodities (GLD, USO) via EMA crossover.

Commodities move in cleaner, longer waves than indices, so a slow 50/200 EMA
crossover on the 4-hour chart avoids getting whipsawed by intraday noise.
"""


def generate_signal(df, position, params):
    fast_period = params.get("fast_ema", 50)
    slow_period = params.get("slow_ema", 200)

    if len(df) < slow_period + 2:
        return None

    closes = df["close"]
    fast_ema = closes.ewm(span=fast_period, adjust=False).mean()
    slow_ema = closes.ewm(span=slow_period, adjust=False).mean()

    prev_fast, prev_slow = fast_ema.iloc[-2], slow_ema.iloc[-2]
    curr_fast, curr_slow = fast_ema.iloc[-1], slow_ema.iloc[-1]

    crossed_up = prev_fast <= prev_slow and curr_fast > curr_slow
    crossed_down = prev_fast >= prev_slow and curr_fast < curr_slow

    if position is None:
        if crossed_up:
            return "long"
        if crossed_down:
            return "short"
        return None

    if position["direction"] == "long" and crossed_down:
        return "exit"
    if position["direction"] == "short" and crossed_up:
        return "exit"
    return None


def warmup_bars(params):
    return params.get("slow_ema", 200) + 2
