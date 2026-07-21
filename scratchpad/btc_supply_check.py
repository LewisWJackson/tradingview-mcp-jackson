"""Recompute BTC supply mechanics from first principles, and measure the price
multiples from MY OWN data with each metric explicitly labelled.

Written because the previous write-up made two mistakes:
  1. quoted ~25% post-2012-halving inflation (it is ~12.5% — 25% is the PRE-halving rate)
  2. mixed halving->CYCLE PEAK multiples (from a web source) with halving->+2YR
     multiples (computed here) in the same table, as if they were one series
"""
import os
import pandas as pd

BLOCKS_PER_YEAR = 6 * 24 * 365          # 10-min blocks
HALVINGS = [
    ("2012-11-28", 210_000, 25.0),
    ("2016-07-09", 420_000, 12.5),
    ("2020-05-11", 630_000, 6.25),
    ("2024-04-19", 840_000, 3.125),
    ("2028-03-01", 1_050_000, 1.5625),   # projected
]

print("=" * 92)
print("SUPPLY MECHANICS FROM FIRST PRINCIPLES")
print("=" * 92)
print(f"{'halving':12s} {'new reward':>11s} {'supply then':>13s} {'infl BEFORE':>12s} "
      f"{'infl AFTER':>11s} {'pts removed':>12s}")
print("-" * 92)

supply = 0.0
prev_reward = 50.0
rows = []
for date, block, new_reward in HALVINGS:
    supply = 0.0
    r = 50.0
    b = 0
    while b < block:
        supply += 210_000 * r
        r /= 2
        b += 210_000
    infl_before = prev_reward * BLOCKS_PER_YEAR / supply * 100
    infl_after = new_reward * BLOCKS_PER_YEAR / supply * 100
    removed = infl_before - infl_after
    rows.append((date, new_reward, supply, infl_before, infl_after, removed))
    print(f"{date:12s} {new_reward:11.4f} {supply/1e6:12.2f}M {infl_before:11.2f}% "
          f"{infl_after:10.2f}% {removed:11.2f}pt")
    prev_reward = new_reward

print("\n  IMPULSE DECAY (percentage points of annual supply growth removed):")
base = rows[0][5]
for date, _, _, _, _, rem in rows:
    print(f"    {date[:4]}  {rem:6.2f}pt   ({base/rem:5.1f}x smaller than 2012)")

# ---- price multiples, each metric labelled ----
DATA = os.path.join(os.path.dirname(__file__), "data")
btc = pd.read_csv(os.path.join(DATA, "BTC-USD.csv"), parse_dates=["date"]).set_index("date")["adjclose"]
btc = btc.asfreq("D").ffill()

PEAKS = {"2016-07-09": "2017-12-16", "2020-05-11": "2021-11-08", "2024-04-19": "2025-10-06"}

print("\n" + "=" * 92)
print("PRICE MULTIPLES — MEASURED HERE, TWO DIFFERENT METRICS (do not mix them)")
print("=" * 92)
print(f"{'halving':12s} {'price':>10s} | {'+2yr':>9s} {'mult':>7s} | {'cycle peak':>12s} {'mult':>7s}")
print("-" * 92)
for h, pk in PEAKS.items():
    hd = pd.Timestamp(h)
    if hd < btc.index[0]:
        print(f"{h:12s} {'(pre-data)':>10s} |")
        continue
    p0 = btc.loc[hd]
    d2 = hd + pd.DateOffset(years=2)
    m2 = btc.loc[d2] / p0 if d2 <= btc.index[-1] else float("nan")
    ppk = btc.loc[pd.Timestamp(pk)]
    print(f"{h:12s} {p0:10,.0f} | {btc.loc[d2] if d2<=btc.index[-1] else 0:9,.0f} "
          f"{m2:6.1f}x | {ppk:12,.0f} {ppk/p0:6.1f}x")

print("\n  NOTE: the widely-quoted 93x / 30x / 8x / 2x series is halving -> CYCLE PEAK,")
print("  and the 2012 figure predates this price data entirely. The +2yr column above is")
print("  the like-for-like series computed here. They are NOT the same measurement.")
