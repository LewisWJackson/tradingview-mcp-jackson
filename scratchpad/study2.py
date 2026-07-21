"""Robustness extensions for the non-trend sleeve study.

(A) Split-half: is the 3-sleeve Sharpe lift present in BOTH 2007-16 and 2017-26,
    or a single-period fluke?
(B) Carry variant: IEF vs AGG vs TLT as the bond-carry sleeve -- pick the robust one.
(C) BTC question: does adding a BTC regime-trend sleeve (2015+) help?
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252


def load(t):
    df = pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


tickers = ["SPY", "QQQ", "GLD", "IEF", "TLT", "AGG", "BIL", "BTC-USD"]
px = pd.DataFrame({t: load(t) for t in tickers}).loc["2007-05-30":]
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
rets = px.pct_change().fillna(0.0)
cash = rets["BIL"]


def regime(asset, sma=100):
    p = px[asset]
    sig = (p > p.rolling(sma).mean()).shift(1).fillna(False)
    return rets[asset].where(sig, cash)


trend = 0.35 * regime("SPY") + 0.35 * regime("QQQ") + 0.30 * regime("GLD")
equity = 0.5 * rets["SPY"] + 0.5 * rets["QQQ"]


def inv_vol_rp(df, lookback=60):
    vol = df.rolling(lookback).std().shift(1)
    w = (1.0 / vol)
    w = w.div(w.sum(axis=1), axis=0)
    marks = w.resample("ME").last().reindex(w.index, method="ffill").shift(1).ffill()
    marks = marks.fillna(1.0 / df.shape[1])
    return (df * marks).sum(axis=1)


def stats(r):
    r = r.dropna()
    n = len(r)
    cagr = (1 + r).prod() ** (TD / n) - 1
    ex = r - cash.reindex(r.index).fillna(0)
    sharpe = ex.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    dn = r[r < 0].std()
    sortino = ex.mean() / dn * np.sqrt(TD) if dn > 0 else np.nan
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    return cagr, sharpe, sortino, dd


def show(label, r):
    c, s, so, d = stats(r)
    print(f"  {label:30s} CAGR {c*100:5.1f}%  Sharpe {s:.2f}  Sortino {so:.2f}  MaxDD {d*100:6.1f}%")


# ---------- (B) carry variant ----------
print("=" * 78)
print("(B) CARRY SLEEVE VARIANT  -- 3-sleeve RP {trend, equity, <carry>}, full window")
print("=" * 78)
for carry_name in ["IEF", "AGG", "TLT"]:
    corr = trend.corr(rets[carry_name])
    port = inv_vol_rp(pd.DataFrame({"t": trend, "e": equity, "c": rets[carry_name]}))
    c, s, so, d = stats(port)
    print(f"  carry={carry_name:4s} (corr-to-trend {corr:+.2f})   "
          f"CAGR {c*100:5.1f}%  Sharpe {s:.2f}  Sortino {so:.2f}  MaxDD {d*100:6.1f}%")
print("  baseline trend book alone:")
show("trend only", trend)

# ---------- (A) split-half robustness ----------
print("\n" + "=" * 78)
print("(A) SPLIT-HALF ROBUSTNESS  -- is the 3-sleeve Sharpe lift in BOTH halves?")
print("=" * 78)
bond = rets["IEF"]
three = inv_vol_rp(pd.DataFrame({"t": trend, "e": equity, "c": bond}))
for lbl, sl in [("2007-2016", slice("2007", "2016")), ("2017-2026", slice("2017", "2026"))]:
    print(f"\n  --- {lbl} ---")
    show("trend only", trend[sl])
    show("3-sleeve RP", three[sl])

# ---------- (C) BTC sleeve, 2015+ ----------
print("\n" + "=" * 78)
print("(C) ADD BTC REGIME-TREND SLEEVE  -- window 2015-01 -> now")
print("=" * 78)
btc_trend = regime("BTC-USD")
sl = slice("2015-01-01", None)
trend4 = (0.30 * regime("SPY") + 0.30 * regime("QQQ") +
          0.25 * regime("GLD") + 0.15 * btc_trend)   # bot-like weights incl BTC
print(f"  corr(BTC-trend, equity-anchor) = {btc_trend[sl].corr(equity[sl]):+.2f}   "
      f"corr(BTC-trend, trend-book) = {btc_trend[sl].corr(trend[sl]):+.2f}")
show("trend book (no BTC)", trend[sl])
show("trend book (+BTC sleeve)", trend4[sl])
four = inv_vol_rp(pd.DataFrame({"t": trend4, "e": equity, "c": bond}))[sl]
show("3-sleeve RP +BTC-trend", four)
three_since15 = three[sl]
show("3-sleeve RP (no BTC)", three_since15)
