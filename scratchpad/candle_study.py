"""Candlestick + candle-count confluence — event study.

The hypothesis (top-down, "play the bounce"):
  HIGH TIMEFRAME  weekly trend up  ->  drill down to daily
  CONTEXT         daily close above the 200-day SMA
  PULLBACK        price has dipped (below the 20-day SMA)
  TRIGGER         a bullish candlestick reversal and/or an exhaustion COUNT
  CONFLUENCE      only act when several of the above align

Tested the way the price-patterns skill demands: codified, measured against the
UNCONDITIONAL baseline, before any strategy is built on it. If a signal's forward
return does not beat simply being in the market, nothing downstream can save it.

Note on statistics: forward windows overlap, so effective sample size is far below
raw n and t-stats are optimistic. Treat small edges as noise.
"""
import os
import numpy as np
import pandas as pd

OHLC = os.path.join(os.path.dirname(__file__), "ohlc")
SYMBOLS = ["SPY", "QQQ", "IWM", "GLD", "BTC-USD"]
HORIZONS = [1, 3, 5, 10, 20]


def load(sym):
    df = pd.read_csv(os.path.join(OHLC, f"{sym}.csv"), parse_dates=["date"]).set_index("date")
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    body = (c - o).abs()
    rng = (h - l).replace(0, np.nan)
    upper = h - c.combine(o, max)
    lower = c.combine(o, min) - l
    green, red = c > o, c < o
    prev_body = body.shift(1)

    f = pd.DataFrame(index=df.index)
    f["close"] = c

    # ---- §7 candlestick formations (bullish only: we are buying dips) ----
    f["hammer"] = (lower >= 2 * body) & (upper <= body) & (body / rng < 0.4)
    f["bull_engulf"] = red.shift(1) & green & (c >= o.shift(1)) & (o <= c.shift(1)) & (body > prev_body)
    f["piercing"] = (red.shift(1) & green & (o < c.shift(1)) &
                     (c > (o.shift(1) + c.shift(1)) / 2) & (c < o.shift(1)))
    f["morning_star"] = (red.shift(2) & (body.shift(1) < prev_body.shift(1) * 0.6) &
                         green & (c > (o.shift(2) + c.shift(2)) / 2))
    f["doji"] = (body / rng) < 0.1

    # ---- §9 candle counting ----
    down = c < c.shift(1)
    run = down.groupby((~down).cumsum()).cumsum()
    for n in (3, 4, 5):
        f[f"down_{n}"] = run >= n
    # TD Sequential buy setup: 9 consecutive closes < close 4 bars earlier
    td = c < c.shift(4)
    f["td9"] = td.groupby((~td).cumsum()).cumsum() >= 9

    # ---- context / confluence filters ----
    sma200, sma20 = c.rolling(200).mean(), c.rolling(20).mean()
    f["above_200"] = c > sma200
    f["sma200_rising"] = sma200 > sma200.shift(20)
    f["pullback"] = c < sma20                       # an actual dip, not a breakout
    wk = c.resample("W").last()                     # genuine HIGHER TIMEFRAME read
    wk_up = (wk > wk.rolling(20).mean()).reindex(c.index, method="ffill")
    f["htf_up"] = wk_up.fillna(False)

    # ---- forward returns ----
    for k in HORIZONS:
        f[f"fwd{k}"] = c.shift(-k) / c - 1
    return f


panel = {s: load(s) for s in SYMBOLS}

TRIGGERS = ["hammer", "bull_engulf", "piercing", "morning_star", "doji",
            "down_3", "down_4", "down_5", "td9"]


def evaluate(mask_fn, label, symbols=SYMBOLS):
    """Pool signal-days across symbols and compare forward returns to baseline."""
    rows = []
    for s in symbols:
        f = panel[s]
        m = mask_fn(f)
        sub = f.loc[m, [f"fwd{k}" for k in HORIZONS]]
        base = f[[f"fwd{k}" for k in HORIZONS]]
        rows.append((sub, base))
    sig = pd.concat([r[0] for r in rows])
    base = pd.concat([r[1] for r in rows])
    n = len(sig.dropna(how="all"))
    if n < 30:
        return None
    out = {"label": label, "n": n}
    for k in HORIZONS:
        s_ = sig[f"fwd{k}"].dropna()
        b_ = base[f"fwd{k}"].dropna()
        edge = s_.mean() - b_.mean()
        t = edge / (s_.std() / np.sqrt(len(s_))) if len(s_) > 1 and s_.std() > 0 else np.nan
        out[k] = (s_.mean() * 100, b_.mean() * 100, edge * 100, t, (s_ > 0).mean() * 100)
    return out


def show(results, title):
    print("\n" + "=" * 104)
    print(title)
    print("=" * 104)
    print(f"{'signal':22s} {'n':>6s} " + "".join(f"{'+'+str(k)+'d edge':>12s}" for k in HORIZONS))
    print(f"{'':22s} {'':>6s} " + "".join(f"{'(t-stat)':>12s}" for k in HORIZONS))
    print("-" * 104)
    for r in results:
        if r is None:
            continue
        line = f"{r['label']:22s} {r['n']:6d} "
        tline = f"{'':22s} {'':>6s} "
        for k in HORIZONS:
            _, _, edge, t, _ = r[k]
            line += f"{edge:+11.3f}%"
            tline += f"{('('+format(t,'.1f')+')'):>12s}"
        print(line)
        print(tline)


# ---- 1. raw triggers, no context ----
res = [evaluate(lambda f, t=t: f[t].fillna(False), t) for t in TRIGGERS]
show(res, "1. RAW TRIGGERS — edge vs unconditional baseline (all symbols pooled)")

# ---- 2. + the 200-day MA context the user asked for ----
res2 = [evaluate(lambda f, t=t: f[t].fillna(False) & f["above_200"].fillna(False),
                 t + " >200SMA") for t in TRIGGERS]
show(res2, "2. + DAILY CLOSE ABOVE 200-DAY SMA")

# ---- 3. full top-down confluence stack ----
def stack(f, t):
    return (f[t].fillna(False) & f["above_200"].fillna(False) & f["sma200_rising"].fillna(False)
            & f["htf_up"].fillna(False) & f["pullback"].fillna(False))


res3 = [evaluate(lambda f, t=t: stack(f, t), t + " FULL") for t in TRIGGERS]
show(res3, "3. FULL CONFLUENCE — weekly up + >200SMA rising + pullback + trigger")

# ---- 4. context alone, no candle trigger at all (the control) ----
print("\n" + "=" * 104)
print("4. CONTROL — context ALONE, no candlestick/count trigger whatsoever")
print("=" * 104)
ctrl = [
    evaluate(lambda f: f["above_200"].fillna(False), "above 200SMA only"),
    evaluate(lambda f: f["above_200"].fillna(False) & f["pullback"].fillna(False), "above200 + pullback"),
    evaluate(lambda f: (f["above_200"] & f["sma200_rising"] & f["htf_up"] & f["pullback"]).fillna(False),
             "full context, NO candle"),
]
show([c for c in ctrl if c], "   (same table, context-only)")
