"""Two-panel figure: growth of $1, and rolling 1yr Sharpe (trend vs 3-sleeve)
showing the non-trend sleeve's help is regime-dependent (great pre-2016 bond
bull, a drag in the 2017-26 rate-rising / 2022 regime)."""
import os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252


def load(t):
    df = pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


px = pd.DataFrame({t: load(t) for t in ["SPY", "QQQ", "GLD", "IEF", "BIL"]}).loc["2007-05-30":]
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
rets = px.pct_change().fillna(0.0)
cash = rets["BIL"]


def regime(a, sma=100):
    p = px[a]
    return rets[a].where((p > p.rolling(sma).mean()).shift(1).fillna(False), cash)


trend = 0.35 * regime("SPY") + 0.35 * regime("QQQ") + 0.30 * regime("GLD")
equity = 0.5 * rets["SPY"] + 0.5 * rets["QQQ"]
bond = rets["IEF"]

sl = pd.DataFrame({"t": trend, "e": equity, "c": bond})
vol = sl.rolling(60).std().shift(1)
w = (1.0 / vol).div((1.0 / vol).sum(axis=1), axis=0)
marks = w.resample("ME").last().reindex(w.index, method="ffill").shift(1).ffill().fillna(1 / 3)
three = (sl * marks).sum(axis=1)


def roll_sharpe(r, win=TD):
    ex = r - cash
    return ex.rolling(win).mean() / r.rolling(win).std() * np.sqrt(TD)


fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(13, 9), gridspec_kw={"height_ratios": [2, 1]})

for name, r, c in [("SPY buy&hold", rets["SPY"], "#888"),
                   ("Trend book (1x)", trend, "#1f77b4"),
                   ("3-sleeve RP (trend+equity+bond carry)", three, "#d62728")]:
    ax1.plot((1 + r).cumprod(), label=name, color=c, lw=1.6)
ax1.set_yscale("log")
ax1.set_title("Non-trend sleeve study — growth of $1 (2007–2026, dividend-adjusted)", fontsize=12, weight="bold")
ax1.legend(loc="upper left"); ax1.grid(alpha=0.3)

ax2.plot(roll_sharpe(trend), label="Trend book", color="#1f77b4", lw=1.4)
ax2.plot(roll_sharpe(three), label="3-sleeve RP", color="#d62728", lw=1.4)
ax2.axhline(0, color="k", lw=0.6)
ax2.axvspan(pd.Timestamp("2007-05-30"), pd.Timestamp("2016-12-31"), color="green", alpha=0.06)
ax2.axvspan(pd.Timestamp("2017-01-01"), px.index.max(), color="orange", alpha=0.06)
ax2.text(pd.Timestamp("2011-01-01"), ax2.get_ylim()[1]*0.8 if False else 2.3, "bond bull:\nsleeve WINS", fontsize=9, color="green")
ax2.text(pd.Timestamp("2020-06-01"), 2.3, "rate-rise / 2022:\ntrend alone wins", fontsize=9, color="#cc7000")
ax2.set_title("Rolling 1-year Sharpe — the sleeve's edge is regime-dependent, not robust", fontsize=11)
ax2.legend(loc="lower left"); ax2.grid(alpha=0.3)

plt.tight_layout()
out = os.path.join(os.path.dirname(__file__), "..", "non_trend_sleeve.png")
plt.savefig(out, dpi=110, bbox_inches="tight")
print("saved", os.path.abspath(out))
