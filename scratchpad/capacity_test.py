"""THE CAPACITY TEST — does the trend edge strengthen where big money can't go?

This decides whether paid stock-level data is worth buying, using free data.

The thesis (the only structural retail advantage in the literature): edges survive
in places institutions are excluded from by size. If true, the SAME regime rule
should add MORE value as liquidity falls.

Measured per asset:
    edge = Sharpe(regime trend rule) - Sharpe(buy & hold)
then regressed against log10(median daily dollar volume).

  slope > 0  -> thesis SUPPORTED: illiquidity pays, paid data is justified
  slope ~ 0  -> thesis DEAD: the edge is the same everywhere, save the money
  slope < 0  -> thesis INVERTED: liquid is better, definitively stop
"""
import os
import numpy as np
import pandas as pd

LIQ = os.path.join(os.path.dirname(__file__), "liq")
TD = 252
COST = 0.0005

files = sorted(f[:-4] for f in os.listdir(LIQ) if f.endswith(".csv"))


def load(t):
    df = pd.read_csv(os.path.join(LIQ, f"{t}.csv"), parse_dates=["date"]).set_index("date")
    return df


rows = []
for t in files:
    df = load(t)
    df = df.loc["2007-01-01":]
    if len(df) < 2500:                      # need a decent common history
        continue
    c = df["adjclose"]
    ret = c.pct_change().fillna(0.0)
    sig = (c > c.rolling(200).mean()).shift(1).fillna(False)
    turn = sig.astype(float).diff().abs().fillna(0.0)
    strat = ret.where(sig, 0.0) - turn * COST

    bh_sh = ret.mean() / ret.std() * np.sqrt(TD)
    st_sh = strat.mean() / strat.std() * np.sqrt(TD)
    eq_b = (1 + ret).cumprod(); eq_s = (1 + strat).cumprod()
    dd_b = (eq_b / eq_b.cummax() - 1).min(); dd_s = (eq_s / eq_s.cummax() - 1).min()
    adv = df["dollar_volume"].median()
    rows.append({"ticker": t, "adv": adv, "log_adv": np.log10(max(adv, 1)),
                 "bh": bh_sh, "trend": st_sh, "edge": st_sh - bh_sh,
                 "dd_saved": (dd_s - dd_b) * 100, "n": len(df)})

d = pd.DataFrame(rows).sort_values("adv", ascending=False)

print("=" * 96)
print(f"CAPACITY TEST — regime trend edge vs liquidity, {len(d)} ETFs, 2007-2026")
print("=" * 96)
print(f"{'ticker':8s} {'median $vol/day':>16s} {'B&H Sh':>8s} {'trend Sh':>9s} {'EDGE':>8s} {'DD saved':>9s}")
print("-" * 96)
for _, r in d.iterrows():
    print(f"{r['ticker']:8s} {r['adv']/1e6:15.1f}M {r['bh']:8.2f} {r['trend']:9.2f} "
          f"{r['edge']:+8.2f} {r['dd_saved']:+8.1f}pt")

# ---- the regression that decides it ----
x, y = d["log_adv"].values, d["edge"].values
A = np.c_[np.ones(len(x)), x]
beta = np.linalg.lstsq(A, y, rcond=None)[0]
pred = A @ beta
ss_res = ((y - pred) ** 2).sum(); ss_tot = ((y - y.mean()) ** 2).sum()
r2 = 1 - ss_res / ss_tot
se = np.sqrt(ss_res / (len(x) - 2) / ((x - x.mean()) ** 2).sum())
tstat = beta[1] / se
corr = np.corrcoef(x, y)[0, 1]

print("\n" + "=" * 96)
print("THE DECIDING REGRESSION:  trend edge  ~  log10(daily dollar volume)")
print("=" * 96)
print(f"  slope        {beta[1]:+.4f} Sharpe per 10x liquidity   (t = {tstat:+.2f})")
print(f"  correlation  {corr:+.3f}      R^2 {r2:.3f}      n = {len(d)}")
print()
if tstat > 2:
    print("  => MORE liquid = BIGGER edge. Capacity thesis INVERTED.")
elif tstat < -2:
    print("  => LESS liquid = BIGGER edge. Capacity thesis SUPPORTED — paid data justified.")
else:
    print("  => NO RELATIONSHIP. The trend edge is the same everywhere on the liquidity")
    print("     spectrum. Illiquidity buys you nothing here — do NOT spend on stock data")
    print("     expecting the trend rule to work better in the small-cap corner.")

# ---- tercile view, easier to read than a slope ----
d["bucket"] = pd.qcut(d["log_adv"], 3, labels=["thin", "mid", "liquid"])
print("\n  BY LIQUIDITY TERCILE")
g = d.groupby("bucket", observed=True).agg(n=("edge", "size"), adv=("adv", "median"),
                                           bh=("bh", "mean"), trend=("trend", "mean"),
                                           edge=("edge", "mean"), dd=("dd_saved", "mean"))
for k, r in g.iterrows():
    print(f"    {k:7s} n={int(r['n']):2d}  median ${r['adv']/1e6:8.1f}M/day   "
          f"B&H {r['bh']:.2f} -> trend {r['trend']:.2f}   edge {r['edge']:+.2f}   DD {r['dd']:+.1f}pt")
