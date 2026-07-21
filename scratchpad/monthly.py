"""Per-month return profile of the live book.

The arithmetic mean of monthly returns OVERSTATES what you actually compound —
the geometric (compound) monthly rate is the honest "average month". Both are
reported, plus the distribution, because with this much skew the average month
is not a month you should expect to have.
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
book_noBTC = sum(w * regime(a) for a, w in W.items() if a != "BTC-USD")
spy = rets["SPY"]


def monthly_profile(r, label):
    r = r.dropna()
    m = (1 + r).resample("ME").prod() - 1
    n = len(m)
    arith = m.mean()
    geo = (1 + r).prod() ** (1 / n) - 1          # the rate you actually compound
    print(f"\n  {label}   ({n} months)")
    print(f"    compound (geometric) avg month : {geo*100:6.2f}%   <-- the honest number")
    print(f"    arithmetic mean month          : {arith*100:6.2f}%")
    print(f"    median month                   : {m.median()*100:6.2f}%")
    print(f"    positive months                : {(m > 0).mean()*100:5.1f}%")
    print(f"    best / worst month             : {m.max()*100:+6.1f}% / {m.min()*100:+6.1f}%")
    print(f"    monthly std dev                : {m.std()*100:6.2f}%")
    p = np.percentile(m, [10, 25, 50, 75, 90]) * 100
    print(f"    month percentiles 10/25/50/75/90: {p[0]:5.1f} {p[1]:5.1f} {p[2]:5.1f} {p[3]:5.1f} {p[4]:5.1f}")
    return m


print("=" * 84)
print("PER-MONTH RETURN — live-weight book (SPY .5 / QQQ .5 / BTC .2 / GLD .2)")
print("=" * 84)

for lbl, sl in [("2015-01 -> 2026-07  (all four sleeves)", slice("2015-01-01", None)),
                ("2022-07 -> 2026-07  (the headline 48mo)", slice("2022-07-22", "2026-07-20"))]:
    print(f"\n--- {lbl} ---")
    monthly_profile(book[sl], "live book")
    monthly_profile(book_noBTC[sl], "same book, BTC sleeve REMOVED")
    monthly_profile(spy[sl], "SPY buy & hold")

print("\n" + "=" * 84)
print("HOW OFTEN DOES IT CLEAR THE ORIGINAL 10%/MONTH GOAL?")
print("=" * 84)
m = ((1 + book.loc["2015":]).resample("ME").prod() - 1)
for thresh in [0.10, 0.05, 0.02, 0.0]:
    print(f"  months >= {thresh*100:4.0f}% : {(m >= thresh).mean()*100:5.1f}%  "
          f"({int((m >= thresh).sum())} of {len(m)})")
print()
streak = best = 0
for v in m:
    streak = streak + 1 if v > 0 else 0
    best = max(best, streak)
lose = worst = 0
for v in m:
    lose = lose + 1 if v <= 0 else 0
    worst = max(worst, lose)
print(f"  longest winning streak : {best} months")
print(f"  longest losing streak  : {worst} months")
