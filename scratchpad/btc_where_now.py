"""Where are we in the BTC cycle RIGHT NOW, measured against prior cycles.

Aligns each cycle by days-since-peak so the current decline can be read
like-for-like against the ones that completed.
"""
import os
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
btc = pd.read_csv(os.path.join(DATA, "BTC-USD.csv"), parse_dates=["date"]).set_index("date")["adjclose"]
btc = btc.asfreq("D").ffill()

CYCLES = [
    ("2013-17 cycle", "2017-12-16", "2018-12-15"),
    ("2021 cycle",    "2021-11-08", "2022-11-21"),
    ("current",       "2025-10-06", None),
]

now = btc.index[-1]
print("=" * 92)
print("BTC CYCLE POSITION — aligned by days since peak")
print("=" * 92)
print(f"{'cycle':16s} {'peak date':12s} {'peak':>10s} {'bottom':12s} {'days':>6s} {'depth':>8s}")
print("-" * 92)
rows = []
for lbl, pk, bt in CYCLES:
    pkd = pd.Timestamp(pk)
    ppk = btc.loc[pkd]
    if bt:
        btd = pd.Timestamp(bt)
        pbt = btc.loc[btd]
        days = (btd - pkd).days
        print(f"{lbl:16s} {pk:12s} {ppk:10,.0f} {bt:12s} {days:6d} {pbt/ppk-1:+7.0%}")
        rows.append((lbl, pkd, ppk, btd, pbt, days))
    else:
        cur = btc.iloc[-1]
        days = (now - pkd).days
        print(f"{lbl:16s} {pk:12s} {ppk:10,.0f} {'(ongoing)':12s} {days:6d} {cur/ppk-1:+7.0%}  <-- now")
        cur_days, cur_pk, cur_px = days, ppk, cur

print("\n" + "=" * 92)
print(f"LIKE-FOR-LIKE: where were prior cycles at day {cur_days} of their decline?")
print("=" * 92)
print(f"{'cycle':16s} {'drawdown @ this day':>22s} {'days left to bottom':>21s} {'further fall':>14s}")
print("-" * 92)
for lbl, pkd, ppk, btd, pbt, days in rows:
    at = btc.loc[pkd + pd.Timedelta(days=cur_days)]
    print(f"{lbl:16s} {at/ppk-1:21.0%} {days-cur_days:20d}d {pbt/at-1:+13.0%}")
print(f"{'current':16s} {cur_px/cur_pk-1:21.0%} {'?':>20s} {'?':>13s}")

print("\n" + "=" * 92)
print("WHAT THE PATTERN IMPLIES FROM HERE (not a forecast — an analogue)")
print("=" * 92)
sma200 = btc.rolling(200).mean().iloc[-1]
print(f"  price now            {cur_px:>12,.0f}")
print(f"  200-day SMA          {sma200:>12,.0f}   price is {(cur_px/sma200-1):+.1%} vs SMA "
      f"-> bot is {'LONG' if cur_px > sma200 else 'FLAT'}")
print(f"  this cycle's peak    {cur_pk:>12,.0f}")
print()
for lbl, pkd, ppk, btd, pbt, days in rows:
    depth = pbt / ppk - 1
    print(f"  if this repeats {lbl:14s} (depth {depth:+.0%}, {days}d): "
          f"bottom ~{cur_pk*(1+depth):>10,.0f} around {(pd.Timestamp('2025-10-06')+pd.Timedelta(days=days)).date()}")
print()
print(f"  mean prior depth {sum(p/k-1 for _,_,k,_,p,_ in rows)/len(rows):+.0%}, "
      f"mean duration {sum(d for *_ ,d in rows)//len(rows)}d "
      f"-> implies ~{cur_pk*(1+sum(p/k-1 for _,_,k,_,p,_ in rows)/len(rows)):,.0f} "
      f"around {(pd.Timestamp('2025-10-06')+pd.Timedelta(days=sum(d for *_ ,d in rows)//len(rows))).date()}")

print("\n  BOT RE-ENTRY: it buys when price closes back above the 200-day SMA.")
print(f"  That is currently {sma200:,.0f} and falling as the decline ages —")
print("  the trigger comes to meet price rather than price having to climb all the way back.")
