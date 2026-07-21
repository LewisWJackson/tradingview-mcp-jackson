"""Test the claim: "buy BTC at the start of the cycle, 2 years -> 3-5x".

Three separate questions, because the claim bundles them:
  1. HISTORICALLY, what did 2 years from a cycle bottom actually return?
  2. HOW SENSITIVE is that to getting the timing wrong? (you cannot see the
     bottom in real time — that is the entire problem with predictive timing)
  3. WHAT IS THE BASELINE — what does a random 2-year hold return, and what
     drawdown must be survived either way?
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
btc = pd.read_csv(os.path.join(DATA, "BTC-USD.csv"), parse_dates=["date"]).set_index("date")["adjclose"]
btc = btc.asfreq("D").ffill()

# cycle lows visible in this data window (Yahoo BTC starts 2014-09)
BOTTOMS = {
    "2015 bottom": "2015-01-14",
    "2018 bottom": "2018-12-15",
    "2022 bottom": "2022-11-21",
}
HALVINGS = {"2016 halving": "2016-07-09", "2020 halving": "2020-05-11", "2024 halving": "2024-04-19"}


def fwd(date, years=2):
    d0 = pd.Timestamp(date)
    d1 = d0 + pd.DateOffset(years=years)
    if d1 > btc.index[-1] or d0 < btc.index[0]:
        return None
    return btc.loc[d1] / btc.loc[d0]


print("=" * 88)
print("1. TWO-YEAR MULTIPLE FROM EACH CYCLE BOTTOM  (the claim: 3-5x)")
print("=" * 88)
print(f"{'anchor':16s} {'date':12s} {'price':>12s} {'+2yr price':>12s} {'MULTIPLE':>10s}")
print("-" * 88)
for lbl, d in BOTTOMS.items():
    m = fwd(d)
    if m:
        p0 = btc.loc[pd.Timestamp(d)]
        print(f"{lbl:16s} {d:12s} {p0:12,.0f} {p0*m:12,.0f} {m:9.1f}x")
print()
for lbl, d in HALVINGS.items():
    m = fwd(d)
    if m:
        p0 = btc.loc[pd.Timestamp(d)]
        print(f"{lbl:16s} {d:12s} {p0:12,.0f} {p0*m:12,.0f} {m:9.1f}x")

print("\n" + "=" * 88)
print("2. TIMING SENSITIVITY — what if you are early or late?")
print("=" * 88)
print(f"{'anchor':16s}" + "".join(f"{f'{o:+d}mo':>10s}" for o in [-6, -3, 0, 3, 6, 12]))
print("-" * 88)
for lbl, d in BOTTOMS.items():
    row = f"{lbl:16s}"
    for off in [-6, -3, 0, 3, 6, 12]:
        m = fwd(pd.Timestamp(d) + pd.DateOffset(months=off))
        row += f"{(f'{m:.1f}x' if m else '--'):>10s}"
    print(row)

print("\n" + "=" * 88)
print("3. BASELINE — every possible 2-year hold, not just the good ones")
print("=" * 88)
mult = (btc.shift(-730) / btc).dropna()
q = np.percentile(mult, [5, 25, 50, 75, 95])
print(f"  all {len(mult)} start dates, 2-year multiple:")
print(f"    5th {q[0]:.2f}x   25th {q[1]:.2f}x   MEDIAN {q[2]:.2f}x   75th {q[3]:.2f}x   95th {q[4]:.2f}x")
print(f"    share of start dates losing money : {(mult < 1).mean()*100:.0f}%")
print(f"    share achieving >= 3x             : {(mult >= 3).mean()*100:.0f}%")
print(f"    share achieving >= 5x             : {(mult >= 5).mean()*100:.0f}%")

print("\n  DRAWDOWN YOU MUST SURVIVE (max peak-to-trough within each 2-yr hold):")
dds = []
for i in range(0, len(btc) - 730, 30):
    w = btc.iloc[i:i + 730]
    dds.append((w / w.cummax() - 1).min())
dds = np.array(dds) * 100
print(f"    median {np.median(dds):.0f}%    worst {dds.min():.0f}%    "
      f"share of windows with a >50% drawdown: {(dds <= -50).mean()*100:.0f}%")

print("\n" + "=" * 88)
print("4. WHERE ARE WE NOW?")
print("=" * 88)
peak = btc.loc["2025-01-01":].max()
peak_d = btc.loc["2025-01-01":].idxmax()
now = btc.iloc[-1]
sma200 = btc.rolling(200).mean().iloc[-1]
print(f"  cycle peak      {peak:,.0f}  on {peak_d.date()}")
print(f"  now             {now:,.0f}   ({now/peak-1:+.1%} from peak, "
      f"{(btc.index[-1]-peak_d).days} days into the decline)")
print(f"  200-day SMA     {sma200:,.0f}   -> price is {'ABOVE' if now>sma200 else 'BELOW'} it "
      f"(bot is {'LONG' if now>sma200 else 'FLAT'})")
print(f"\n  prior cycle declines ran ~12 months to -77%/-85% bottoms.")
print(f"  a -77% decline from this peak would be {peak*0.23:,.0f}; -85% would be {peak*0.15:,.0f}.")
