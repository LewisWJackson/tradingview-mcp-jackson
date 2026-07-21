"""What the live book looks like ANNUALISED — dispersion, not a single number.

A CAGR headline hides the thing that actually matters live: how much any single
year varies, how often you sit underwater, and how long the bad stretches last.
Live weights: SPY .5, QQQ .5, BTC .2, GLD .2 (regime_beta, cash->BIL when flat).
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252


def load(t):
    df = pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


px = pd.DataFrame({t: load(t) for t in ["SPY", "QQQ", "GLD", "BIL", "BTC-USD"]})
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
rets = px.pct_change().fillna(0.0)
cash = rets["BIL"].fillna(0.0)


def regime(a, sma=100):
    p = px[a]
    return rets[a].where((p > p.rolling(sma).mean()).shift(1).fillna(False), cash)


W = {"SPY": 0.5, "QQQ": 0.5, "BTC-USD": 0.2, "GLD": 0.2}
book = sum(w * regime(a) for a, w in W.items())
spy = rets["SPY"]


def summarise(r, label):
    r = r.dropna()
    n = len(r)
    cagr = (1 + r).prod() ** (TD / n) - 1
    vol = r.std() * np.sqrt(TD)
    eq = (1 + r).cumprod()
    dd_series = eq / eq.cummax() - 1
    dd = dd_series.min()
    # longest underwater stretch (trading days)
    underwater = (dd_series < -0.001).astype(int)
    longest, cur = 0, 0
    for v in underwater:
        cur = cur + 1 if v else 0
        longest = max(longest, cur)
    monthly = (1 + r).resample("ME").prod() - 1
    yearly = (1 + r).resample("YE").prod() - 1
    print(f"\n  {label}")
    print(f"    CAGR {cagr*100:5.1f}%   vol {vol*100:4.1f}%   maxDD {dd*100:6.1f}%")
    print(f"    best year {yearly.max()*100:6.1f}%   worst year {yearly.min()*100:6.1f}%   "
          f"median year {yearly.median()*100:5.1f}%")
    print(f"    losing months {(monthly < 0).mean()*100:4.1f}%   worst month {monthly.min()*100:6.1f}%   "
          f"longest underwater {longest} trading days (~{longest/21:.0f} months)")
    return yearly


print("=" * 84)
print("ANNUALISED — live-weight book (SPY .5 / QQQ .5 / BTC .2 / GLD .2), 1.4x gross")
print("=" * 84)

for lbl, sl in [("FULL WINDOW 2015-01 -> 2026-07 (all four sleeves live)", slice("2015-01-01", None)),
                ("BACKTEST WINDOW 2022-07 -> 2026-07 (the headline 48mo)", slice("2022-07-22", "2026-07-20"))]:
    print(f"\n--- {lbl} ---")
    yb = summarise(book[sl], "regime book")
    ys = summarise(spy[sl], "SPY buy & hold (benchmark)")

print("\n" + "=" * 84)
print("YEAR BY YEAR (calendar)")
print("=" * 84)
yb = (1 + book).resample("YE").prod() - 1
ys = (1 + spy).resample("YE").prod() - 1
print(f"  {'year':6s} {'book':>9s} {'SPY':>9s}   {'':s}")
for ts in yb.loc["2015":].index:
    y = ts.year
    b, s = yb.loc[ts] * 100, ys.loc[ts] * 100
    bar = "#" * max(0, int(b / 5))
    print(f"  {y:<6d} {b:8.1f}% {s:8.1f}%   {bar}")

print("\n" + "=" * 84)
print("DISPERSION OF ANNUAL OUTCOMES (rolling 1yr, 2015+) — the honest range")
print("=" * 84)
roll = (1 + book).rolling(TD).apply(np.prod, raw=True) - 1
roll = roll.loc["2015":].dropna()
for q in [5, 25, 50, 75, 95]:
    print(f"  {q:2d}th percentile 1-year return: {np.percentile(roll, q)*100:7.1f}%")
print(f"  share of 1-year windows negative : {(roll < 0).mean()*100:.1f}%")
