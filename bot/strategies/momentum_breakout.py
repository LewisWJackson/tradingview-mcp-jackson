"""Momentum breakout strategy for trending crypto (BTC/USD).

Rides breakouts of the prior N-period high/low, confirmed by volume, instead
of fading them — crypto trends harder than indices do.
"""


def generate_signal(df, position, params):
    lookback = params.get("lookback", 20)
    volume_multiplier = params.get("volume_multiplier", 1.5)

    if len(df) < lookback + 1:
        return None

    window = df.iloc[-(lookback + 1):-1]
    prior_high = window["high"].max()
    prior_low = window["low"].min()
    avg_volume = window["volume"].mean()

    price = df["close"].iloc[-1]
    volume = df["volume"].iloc[-1]
    volume_confirmed = avg_volume > 0 and volume >= volume_multiplier * avg_volume

    breakout_up = price > prior_high and volume_confirmed
    breakout_down = price < prior_low and volume_confirmed

    if position is None:
        if breakout_up:
            return "long"
        if breakout_down:
            return "short"
        return None

    if position["direction"] == "long" and breakout_down:
        return "exit"
    if position["direction"] == "short" and breakout_up:
        return "exit"
    return None


def warmup_bars(params):
    return params.get("lookback", 20) + 1
