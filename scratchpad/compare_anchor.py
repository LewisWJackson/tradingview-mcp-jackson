"""Live book WITH vs WITHOUT the IEF anchor, on dividend-adjusted (total-return) data.

The bot harness measures IEF on unadjusted Alpaca price bars, which discards the
coupon -- i.e. the entire return a bond-carry sleeve exists to harvest. This
re-measures the same book on total-return data.

Book = live config: SPY .5, QQQ .5, BTC .2, GLD .2 (regime_beta, cash->BIL when
flat) + IEF .15 (buy_hold, always on). Gross 1.4x -> 1.55x.
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252


def load(t):
    df = pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


px = pd.DataFrame({t: load(t) for t in ["SPY", "QQQ", "GLD", "IEF", "BIL", "BTC-USD"]})
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
rets = px.pct_change().fillna(0.0)
cash = rets["BIL"].fillna(0.0)


def regime(a, sma=100):
    p = px[a]
    return rets[a].where((p > p.rolling(sma).mean()).shift(1).fillna(False), cash)


W = {"SPY": 0.5, "QQQ": 0.5, "BTC-USD": 0.2, "GLD": 0.2}
ANCHOR_W = 0.15

trend_book = sum(w * regime(a) for a, w in W.items())
anchor = rets["IEF"]
with_anchor = trend_book + ANCHOR_W * anchor


def stats(r):
    r = r.dropna()
    n = len(r)
    cagr = (1 + r).prod() ** (TD / n) - 1
    tot = (1 + r).prod() - 1
    ex = r - cash.reindex(r.index).fillna(0)
    sharpe = ex.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    dn = r[r < 0].std()
    sortino = ex.mean() / dn * np.sqrt(TD) if dn > 0 else np.nan
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    return tot, cagr, sharpe, sortino, dd, cagr / abs(dd) if dd < 0 else np.nan


def row(label, r):
    t, c, s, so, d, cal = stats(r)
    print(f"  {label:26s} Total {t*100:7.1f}%  CAGR {c*100:5.1f}%  Sharpe {s:.2f}  "
          f"Sortino {so:.2f}  MaxDD {d*100:6.1f}%  Calmar {cal:.2f}")


# --- the coupon gap the harness misses ---
w48 = slice("2022-07-22", "2026-07-20")
ief_tr = (1 + rets["IEF"][w48]).prod() - 1
print("=" * 96)
print("IEF MEASUREMENT GAP (2022-07-22 -> 2026-07-20)")
print("=" * 96)
print(f"  Alpaca price-only (bot harness, no coupons) : -1.5%")
print(f"  Dividend-adjusted TOTAL return (correct)    : {ief_tr*100:+.1f}%")
print(f"  -> the harness understates the carry sleeve by ~{(ief_tr*100)+1.5:.1f} points over 4 years")

for label, sl in [("48-MONTH (matches harness window)", w48),
                  ("SINCE BTC DATA (2015-01 ->)", slice("2015-01-01", None)),
                  ("FULL WINDOW (2007-05 ->)", slice("2007-05-30", None))]:
    print("\n" + "=" * 96)
    print(f"{label}   —   live book WITH vs WITHOUT the IEF anchor")
    print("=" * 96)
    tb, wa = trend_book[sl], with_anchor[sl]
    row("trend book (no anchor)", tb)
    row("+ IEF anchor 0.15", wa)
    t0, c0, s0, so0, d0, cal0 = stats(tb)
    t1, c1, s1, so1, d1, cal1 = stats(wa)
    print(f"  delta: Sharpe {s1-s0:+.2f}   Sortino {so1-so0:+.2f}   "
          f"MaxDD {(d1-d0)*100:+.1f}pts   CAGR {(c1-c0)*100:+.1f}pts   Calmar {cal1-cal0:+.2f}")

# --- stress years ---
print("\n" + "=" * 96)
print("STRESS YEARS (calendar-year return)")
print("=" * 96)
years = ["2008", "2020", "2022", "2025"]
print(f"  {'':26s}" + "".join(f"{y:>10s}" for y in years))
for label, r in [("trend book (no anchor)", trend_book), ("+ IEF anchor 0.15", with_anchor)]:
    cells = "".join(f"{((1+r[r.index.strftime('%Y')==y]).prod()-1)*100:9.1f}%" for y in years)
    print(f"  {label:26s}{cells}")
