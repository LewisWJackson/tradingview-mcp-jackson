"""Phase 3 — the dip-buy edge as an OVERLAY rather than a standalone strategy.

Phase 2's failure is diagnostic, not just negative: the count edge is REAL
(+0.5%/5d, t~3.6) but the standalone strategy sits in cash ~88% of the time
waiting for dips, and the equity risk premium it forfeits while waiting is bigger
than the edge it harvests. Classic: timing subtracts value.

So don't sit in cash. Stay in the trend book and use the count only to SIZE UP
into confirmed dips — harvesting the edge without giving up beta.

Overlay: while the regime book is long an asset AND a count signal has fired in
the last N days, scale that sleeve's weight by `boost`.
"""
import os
import numpy as np
import pandas as pd

OHLC = os.path.join(os.path.dirname(__file__), "ohlc")
DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252
COST = 0.0005
W = {"SPY": 0.5, "QQQ": 0.5, "BTC-USD": 0.2, "GLD": 0.2}


def load(sym):
    return pd.read_csv(os.path.join(OHLC, f"{sym}.csv"), parse_dates=["date"]).set_index("date")["close"]


px = pd.DataFrame({s: load(s) for s in W})
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
bil = pd.read_csv(os.path.join(DATA, "BIL.csv"), parse_dates=["date"]).set_index("date")["adjclose"]
cash = bil.reindex(px.index).ffill().pct_change().fillna(0.0)
rets = px.pct_change().fillna(0.0)


def signals(sym):
    c = px[sym]
    sma200, sma20, sma100 = c.rolling(200).mean(), c.rolling(20).mean(), c.rolling(100).mean()
    regime = (c > sma100).shift(1).fillna(False)
    down = c < c.shift(1)
    run = down.groupby((~down).cumsum()).cumsum()
    trig = ((run >= 3) & (c > sma200) & (sma200 > sma200.shift(20)) & (c < sma20)).shift(1).fillna(False)
    return regime, trig


def book(boost=1.0, hold=5):
    total = pd.Series(0.0, index=px.index)
    prev_w = pd.Series(0.0, index=px.index)
    weights = {}
    for sym, w in W.items():
        regime, trig = signals(sym)
        # a boost window is active for `hold` days after a trigger
        active = trig.rolling(hold, min_periods=1).max().fillna(0).astype(bool)
        wt = pd.Series(0.0, index=px.index)
        wt[regime] = w
        wt[regime & active] = w * boost
        weights[sym] = wt
        total += wt * rets[sym]
    wdf = pd.DataFrame(weights)
    gross = wdf.sum(axis=1)
    total += (1 - gross).clip(lower=0) * cash          # uninvested earns T-bills
    turn = wdf.diff().abs().sum(axis=1).fillna(0.0)
    return total - turn * COST, gross


def stats(r):
    r = r.dropna()
    yrs = len(r) / TD
    cagr = (1 + r).prod() ** (1 / yrs) - 1
    sh = r.mean() / r.std() * np.sqrt(TD)
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    return cagr * 100, sh, dd * 100


print("=" * 96)
print("PHASE 3 — count signal as a SIZING OVERLAY on the regime book (2015-2026)")
print("=" * 96)
print(f"{'variant':34s} {'CAGR':>8s} {'Sharpe':>8s} {'maxDD':>8s} {'avg gross':>10s}")
print("-" * 96)

sl = slice("2015-01-01", None)
base_r, base_g = book(boost=1.0)
b = stats(base_r[sl])
print(f"{'regime book (no overlay)':34s} {b[0]:7.1f}% {b[1]:8.2f} {b[2]:7.1f}% {base_g[sl].mean():9.2f}x")

for boost in [1.25, 1.5, 2.0]:
    for hold in [5, 10]:
        r, g = book(boost=boost, hold=hold)
        s = stats(r[sl])
        d_sh = s[1] - b[1]
        flag = "  <-- better" if d_sh > 0.02 else ("  worse" if d_sh < -0.02 else "  ~flat")
        print(f"{f'boost {boost}x for {hold}d':34s} {s[0]:7.1f}% {s[1]:8.2f} {s[2]:7.1f}% "
              f"{g[sl].mean():9.2f}x{flag}")

print("\n" + "=" * 96)
print("CONTROL — is any gain just extra exposure? Compare vs simply raising base weights")
print("=" * 96)
for mult in [1.05, 1.10, 1.15]:
    saved = dict(W)
    for k in W:
        W[k] = saved[k] * mult
    r, g = book(boost=1.0)
    s = stats(r[sl])
    print(f"{f'all weights x{mult} (no overlay)':34s} {s[0]:7.1f}% {s[1]:8.2f} {s[2]:7.1f}% {g[sl].mean():9.2f}x")
    for k in W:
        W[k] = saved[k]
