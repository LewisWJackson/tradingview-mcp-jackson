"""Forward return expectations — daily, monthly, annualised, with an honest band.

A single expected number is the misleading part of any answer like this. What
matters is the DISTRIBUTION, so this reports:
  1. what the backtest actually did (three windows, with/without the BTC sleeve)
  2. a forward central estimate with each haircut stated explicitly
  3. a block-bootstrap band around it (blocks preserve autocorrelation/vol
     clustering, which an iid resample would destroy and make look too tight)
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252


def load(t):
    return pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"]).set_index("date")["adjclose"]


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


def geo(r):
    r = r.dropna()
    n = len(r)
    tot = (1 + r).prod()
    d = tot ** (1 / n) - 1
    return d * 100, ((1 + d) ** 21 - 1) * 100, ((1 + d) ** TD - 1) * 100


print("=" * 88)
print("1. WHAT THE BACKTEST DID (compound/geometric — the rate that actually compounds)")
print("=" * 88)
print(f"{'series / window':38s} {'daily':>9s} {'monthly':>10s} {'annual':>10s}")
print("-" * 88)
for lbl, r, sl in [
    ("live book  2015->2026", book, slice("2015-01-01", None)),
    ("live book  2022->2026 (48mo)", book, slice("2022-07-22", "2026-07-20")),
    ("live book  2007->2026 (longest)", book, slice("2007-05-30", None)),
    ("ex-BTC     2015->2026", book_noBTC, slice("2015-01-01", None)),
    ("ex-BTC     2007->2026", book_noBTC, slice("2007-05-30", None)),
    ("SPY buy&hold 2015->2026", rets["SPY"], slice("2015-01-01", None)),
]:
    d, m, a = geo(r[sl])
    print(f"{lbl:38s} {d:8.3f}% {m:9.2f}% {a:9.1f}%")

# ---------- 2. forward estimate, haircuts stated ----------
print("\n" + "=" * 88)
print("2. FORWARD CENTRAL ESTIMATE — each haircut explicit")
print("=" * 88)
base_d, base_m, base_a = geo(book.loc["2015":])
print(f"  start: backtest 2015-2026 annual                       {base_a:6.1f}%")
nob_d, nob_m, nob_a = geo(book_noBTC.loc["2015":])
print(f"  haircut 1 — BTC at historical magnitude will not repeat")
print(f"              ex-BTC book                                 {nob_a:6.1f}%")
print(f"  haircut 2 — allow a MODEST BTC contribution (not 2017)")
print(f"              add back ~1/3 of the BTC delta              {nob_a + (base_a-nob_a)/3:6.1f}%")
mid = nob_a + (base_a - nob_a) / 3
print(f"  haircut 3 — execution: slippage/timing not yet measured")
print(f"              (Stage 3 pending) assume ~1pt drag          {mid-1:6.1f}%")
mid -= 1
print(f"  haircut 4 — window was bull-dominated; regime filter's")
print(f"              bear payoff is untested in its favour       (no further cut; two-sided)")
d_est = (1 + mid / 100) ** (1 / TD) - 1
m_est = (1 + d_est) ** 21 - 1
print(f"\n  CENTRAL FORWARD ESTIMATE:  daily {d_est*100:.3f}%   monthly {m_est*100:.2f}%   annual {mid:.1f}%")

# ---------- 3. the band ----------
print("\n" + "=" * 88)
print("3. THE BAND — block bootstrap of 1-year outcomes (10,000 draws, 21-day blocks)")
print("=" * 88)
r = book.loc["2015":].dropna().values
rng = np.random.default_rng(7)
BLOCK, NYR, NSIM = 21, TD, 10000
nblocks = NYR // BLOCK + 1
starts = rng.integers(0, len(r) - BLOCK, size=(NSIM, nblocks))
sims = np.empty(NSIM)
for i in range(NSIM):
    path = np.concatenate([r[s:s + BLOCK] for s in starts[i]])[:NYR]
    sims[i] = np.prod(1 + path) - 1
# recentre the bootstrap on the forward estimate, keeping the shape of the distribution
shift = (1 + mid / 100) / (1 + np.median(sims))
sims_adj = (1 + sims) * shift - 1
qs = np.percentile(sims_adj, [5, 25, 50, 75, 95]) * 100
print(f"  1-YEAR outcome, recentred on the forward estimate:")
print(f"    5th pct {qs[0]:+7.1f}%   25th {qs[1]:+6.1f}%   MEDIAN {qs[2]:+6.1f}%   "
      f"75th {qs[3]:+6.1f}%   95th {qs[4]:+6.1f}%")
print(f"    probability of a LOSING year : {(sims_adj < 0).mean()*100:.0f}%")
print(f"    probability of >= +50%       : {(sims_adj >= 0.5).mean()*100:.0f}%")
print(f"    probability of <= -20%       : {(sims_adj <= -0.2).mean()*100:.0f}%")

m = (1 + book.loc["2015":]).resample("ME").prod() - 1
print(f"\n  MONTHLY reality check (actual history):")
print(f"    positive months {(m>0).mean()*100:.0f}%   median month {m.median()*100:+.2f}%   "
      f"worst {m.min()*100:+.1f}%   best {m.max()*100:+.1f}%")
