"""Play the trend, leveraged, with tight stops — the full grid.

The proposal: trade the 200-day trend, add leverage, use tight stops.
Three separate claims, tested together:

  LEVERAGE    scales return AND risk. Does it add edge, or just amplify?
              Modelled honestly: borrowing above 1x costs a financing rate.
  STOP WIDTH  the project's most documented failure mode was a ~1-ATR stop
              (it sat inside normal noise and produced a -100% wipeout on the
              old book). Re-tested here on the CURRENT trend strategy.
  RUIN        with leverage, path matters. A -50% drawdown needs +100% to
              recover; -100% is absorbing. Reported explicitly.

Long-only regime trend: long while close > 200-day SMA, flat below.
Stops are checked intraday against the bar LOW; a stop-out goes flat until
the regime signal re-fires (you do not get straight back in).
"""
import os
import numpy as np
import pandas as pd

OHLC = os.path.join(os.path.dirname(__file__), "ohlc")
DATA = os.path.join(os.path.dirname(__file__), "data")
SYMBOLS = ["SPY", "QQQ", "GLD", "BTC-USD"]
WEIGHTS = {"SPY": 0.35, "QQQ": 0.35, "GLD": 0.15, "BTC-USD": 0.15}   # sums to 1.0
TD = 252
COST = 0.0005
FINANCE = 0.05        # 5%/yr on the borrowed portion above 1x — leverage is not free


def load(sym):
    df = pd.read_csv(os.path.join(OHLC, f"{sym}.csv"), parse_dates=["date"]).set_index("date")
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    f = pd.DataFrame(index=df.index)
    f["close"], f["low"] = c, l
    f["ret"] = c.pct_change().fillna(0.0)
    f["regime"] = (c > c.rolling(200).mean()).shift(1).fillna(False)
    tr = pd.concat([h - l, (h - c.shift(1)).abs(), (l - c.shift(1)).abs()], axis=1).max(axis=1)
    f["atr"] = tr.rolling(14).mean()
    return f.dropna()


panel = {s: load(s) for s in SYMBOLS}


def simulate(f, stop_atr):
    """Return the daily return stream of a 1x long-only regime sleeve with an ATR stop."""
    c = f["close"].values
    lo = f["low"].values
    atr = f["atr"].values
    reg = f["regime"].values
    ret = f["ret"].values
    n = len(f)
    pos = np.zeros(n)
    out = np.zeros(n)
    stopped = False
    stop_px = np.nan
    for i in range(1, n):
        if pos[i - 1] == 0:
            if reg[i] and not stopped:
                pos[i] = 1.0
                stop_px = c[i - 1] - atr[i - 1] * stop_atr if stop_atr else -np.inf
            elif not reg[i]:
                stopped = False            # regime reset re-arms entry
        else:
            if stop_atr and lo[i] <= stop_px:
                # stopped intraday at the stop price
                out[i] = (stop_px / c[i - 1]) - 1
                pos[i] = 0.0
                stopped = True
                continue
            if not reg[i]:
                pos[i] = 0.0
            else:
                pos[i] = 1.0
                # stop is FIXED at entry (a disaster backstop, as the live bot uses),
                # NOT ratcheted — trailing it would make every width look tighter
                # than the strategy actually trades.
        out[i] = pos[i] * ret[i] if out[i] == 0 else out[i]
    turn = np.abs(np.diff(np.concatenate([[0.0], pos])))
    return pd.Series(out - turn * COST, index=f.index), pos


def book(stop_atr, lev):
    streams, poss = [], []
    for s in SYMBOLS:
        r, p = simulate(panel[s], stop_atr)
        streams.append(r * WEIGHTS[s])
        poss.append(pd.Series(p, index=panel[s].index) * WEIGHTS[s])
    r = pd.concat(streams, axis=1).fillna(0.0).sum(axis=1)
    gross = pd.concat(poss, axis=1).fillna(0.0).sum(axis=1)
    # leverage applied to the book; financing charged on the borrowed part actually used
    borrowed = (gross * lev - 1.0).clip(lower=0)
    return r * lev - borrowed * (FINANCE / TD), gross


def stats(r):
    r = r.dropna()
    eq = (1 + r).cumprod()
    ruined = bool((eq <= 0.01).any())
    if ruined:
        first = eq.index[(eq <= 0.01).argmax()]
        return None, None, -99.9, ruined, first
    yrs = len(r) / TD
    cagr = (eq.iloc[-1]) ** (1 / yrs) - 1
    sh = r.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    dd = (eq / eq.cummax() - 1).min()
    return cagr * 100, sh, dd * 100, ruined, None


print("=" * 100)
print("PLAY THE TREND, LEVERAGED, WITH TIGHT STOPS   (200-day regime, 2015-2026)")
print("=" * 100)
print("stop = ATR multiple on entry price; 'none' = regime exit only (the live bot's design)")
print(f"leverage financed at {FINANCE*100:.0f}%/yr on the borrowed portion\n")

STOPS = [(None, "none"), (8.0, "8 ATR"), (4.0, "4 ATR"), (2.0, "2 ATR"), (1.0, "1 ATR (tight)")]
LEVS = [1.0, 1.5, 2.0, 3.0]
sl = slice("2015-01-01", None)

print(f"{'stop':16s}" + "".join(f"{f'{L}x':>21s}" for L in LEVS))
print(f"{'':16s}" + "".join(f"{'CAGR / Sharpe / DD':>21s}" for L in LEVS))
print("-" * 100)
for sa, label in STOPS:
    line = f"{label:16s}"
    for L in LEVS:
        r, _ = book(sa, L)
        cagr, sh, dd, ruined, when = stats(r[sl])
        if ruined:
            line += f"{'RUIN ' + str(when.date()):>21s}"
        else:
            line += f"{f'{cagr:5.1f}% / {sh:4.2f} / {dd:5.1f}%':>21s}"
    print(line)

print("\n" + "=" * 100)
print("WHAT THE TIGHT STOP ACTUALLY DOES  (1x, no leverage — isolating the stop)")
print("=" * 100)
print(f"{'stop':16s} {'CAGR':>8s} {'Sharpe':>8s} {'maxDD':>8s} {'stop-outs':>11s}")
print("-" * 100)
for sa, label in STOPS:
    r, _ = book(sa, 1.0)
    cagr, sh, dd, _, _ = stats(r[sl])
    stops_hit = 0
    for s in SYMBOLS:
        _, p = simulate(panel[s].loc[sl], sa)
        stops_hit += int(np.sum((p[:-1] == 1) & (p[1:] == 0)))
    print(f"{label:16s} {cagr:7.1f}% {sh:8.2f} {dd:7.1f}% {stops_hit:11d}")
