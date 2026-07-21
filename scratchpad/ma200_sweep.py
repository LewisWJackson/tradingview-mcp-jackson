"""200-day MA bounce — full combinatorial sweep, with the multiple-testing guard.

"Run the combos" is the right instinct AND the classic way to manufacture an edge:
search enough rules and the best one always looks good. The defence is not to
search less, it is to make selection honest:

    1. score every combo IN-SAMPLE            (2001-2013)
    2. pick the winner by IS rank only
    3. judge it OUT-OF-SAMPLE                 (2014-2026)
    4. THE DECIDING TEST: across all combos, does IS rank predict OOS at all?
       If the IS->OOS correlation is ~0, the "best" rule is a lottery winner,
       not an edge — and no amount of further searching fixes that.

Also reports the expected best-by-chance, so a good-looking winner can be
compared against what noise alone would have produced.
"""
import os
import itertools
import numpy as np
import pandas as pd

OHLC = os.path.join(os.path.dirname(__file__), "ohlc")
SYMBOLS = ["SPY", "QQQ", "IWM", "GLD", "BTC-USD"]
TD = 252
COST = 0.0005


def load(sym):
    df = pd.read_csv(os.path.join(OHLC, f"{sym}.csv"), parse_dates=["date"]).set_index("date")
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    f = pd.DataFrame(index=df.index)
    f["ret"] = c.pct_change().fillna(0.0)
    sma200 = c.rolling(200).mean()
    sma20, sma50 = c.rolling(20).mean(), c.rolling(50).mean()
    f["sma200"], f["close"] = sma200, c
    f["rising"] = sma200 > sma200.shift(20)
    f["dist"] = (c - sma200) / sma200                      # % above/below the 200
    f["touch"] = (l <= sma200) & (c > sma200)              # wick through, close back above
    f["reclaim"] = (c > sma200) & (c.shift(1) <= sma200.shift(1))
    f["above20"] = c > sma20
    f["above50"] = c > sma50

    body = (c - o).abs()
    lower = c.combine(o, min) - l
    upper = h - c.combine(o, max)
    rng = (h - l).replace(0, np.nan)
    f["hammer"] = (lower >= 2 * body) & (upper <= body) & (body / rng < 0.4)
    f["engulf"] = (c.shift(1) < o.shift(1)) & (c > o) & (c >= o.shift(1)) & (o <= c.shift(1))

    down = c < c.shift(1)
    run = down.groupby((~down).cumsum()).cumsum()
    f["down_2"], f["down_3"], f["down_4"] = run >= 2, run >= 3, run >= 4
    td = c < c.shift(4)
    f["td9"] = td.groupby((~td).cumsum()).cumsum() >= 9

    delta = c.diff()
    up = delta.clip(lower=0).rolling(14).mean()
    dn = (-delta.clip(upper=0)).rolling(14).mean()
    f["rsi"] = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    f["rsi_os"] = f["rsi"] < 40
    f["none"] = True
    return f


panel = {s: load(s) for s in SYMBOLS}

# ---- the grid ----
PROX = {"within_1%": 0.01, "within_2%": 0.02, "within_3%": 0.03, "within_5%": 0.05,
        "touch200": "touch", "reclaim200": "reclaim", "any_dist": None}
TRIG = ["none", "down_2", "down_3", "down_4", "td9", "hammer", "engulf", "rsi_os"]
HOLD = [3, 5, 10, 20]

COMBOS = list(itertools.product(PROX, TRIG, HOLD))


def signal(f, prox, trig):
    base = f["rising"].fillna(False)
    p = PROX[prox]
    if p == "touch":
        m = f["touch"].fillna(False)
    elif p == "reclaim":
        m = f["reclaim"].fillna(False)
    elif p is None:
        m = (f["dist"] > 0).fillna(False)
    else:
        m = ((f["dist"].abs() <= p) & (f["dist"] > -p)).fillna(False)
    return base & m & f[trig].fillna(False)


def evaluate(prox, trig, hold, sl):
    """Equal-weight across symbols; in-market for `hold` days after each signal."""
    rs, expo = [], []
    for s in SYMBOLS:
        f = panel[s].loc[sl]
        if len(f) < 300:
            continue
        sig = signal(f, prox, trig).shift(1).fillna(False)
        pos = sig.rolling(hold, min_periods=1).max().fillna(0.0)
        turn = pos.diff().abs().fillna(0.0)
        rs.append(pos * f["ret"] - turn * COST)
        expo.append(pos.mean())
    if not rs:
        return None
    r = pd.concat(rs, axis=1).fillna(0.0).mean(axis=1)
    if r.std() == 0:
        return None
    sharpe = r.mean() / r.std() * np.sqrt(TD)
    cagr = (1 + r).prod() ** (TD / len(r)) - 1
    return sharpe, cagr * 100, float(np.mean(expo)) * 100


IS, OOS = slice("2001", "2013"), slice("2014", "2026")
rows = []
for prox, trig, hold in COMBOS:
    a = evaluate(prox, trig, hold, IS)
    b = evaluate(prox, trig, hold, OOS)
    if a and b:
        rows.append({"combo": f"{prox} + {trig} + {hold}d",
                     "prox": prox, "trig": trig, "hold": hold,
                     "is_sharpe": a[0], "is_cagr": a[1],
                     "oos_sharpe": b[0], "oos_cagr": b[1], "expo": b[2]})

df = pd.DataFrame(rows).sort_values("is_sharpe", ascending=False)
print("=" * 104)
print(f"200-DAY MA BOUNCE — FULL SWEEP: {len(df)} combinations tested")
print("=" * 104)
print(f"\nTOP 12 BY IN-SAMPLE SHARPE (selection on IS only), with their OOS result:\n")
print(f"{'combo':34s} {'IS Sharpe':>10s} {'IS CAGR':>9s} | {'OOS Sharpe':>11s} {'OOS CAGR':>9s} {'expo':>7s}")
print("-" * 104)
for _, r in df.head(12).iterrows():
    print(f"{r['combo']:34s} {r['is_sharpe']:10.2f} {r['is_cagr']:8.1f}% | "
          f"{r['oos_sharpe']:11.2f} {r['oos_cagr']:8.1f}% {r['expo']:6.1f}%")

# ---- benchmark ----
bh = []
for s in SYMBOLS:
    f = panel[s].loc[OOS]
    bh.append(f["ret"])
bhr = pd.concat(bh, axis=1).fillna(0.0).mean(axis=1)
bh_sharpe = bhr.mean() / bhr.std() * np.sqrt(TD)
bh_cagr = ((1 + bhr).prod() ** (TD / len(bhr)) - 1) * 100
print("-" * 104)
print(f"{'BUY & HOLD (equal-weight, OOS)':34s} {'':10s} {'':9s} | {bh_sharpe:11.2f} {bh_cagr:8.1f}% {100.0:6.1f}%")

# ---- THE DECIDING TEST ----
print("\n" + "=" * 104)
print("THE DECIDING TEST — does in-sample rank predict out-of-sample performance?")
print("=" * 104)
c_p = df["is_sharpe"].corr(df["oos_sharpe"])
c_s = df["is_sharpe"].rank().corr(df["oos_sharpe"].rank())   # rank corr, no scipy needed
print(f"  correlation IS Sharpe vs OOS Sharpe : pearson {c_p:+.3f}   spearman {c_s:+.3f}")
top10 = df.head(max(1, len(df) // 10))
bot10 = df.tail(max(1, len(df) // 10))
print(f"  mean OOS Sharpe of the BEST 10% in-sample : {top10['oos_sharpe'].mean():+.3f}")
print(f"  mean OOS Sharpe of the WORST 10% in-sample: {bot10['oos_sharpe'].mean():+.3f}")
print(f"  mean OOS Sharpe across ALL combos         : {df['oos_sharpe'].mean():+.3f}")
print(f"  combos beating buy&hold OOS Sharpe ({bh_sharpe:.2f})   : "
      f"{(df['oos_sharpe'] > bh_sharpe).sum()} of {len(df)} "
      f"({(df['oos_sharpe'] > bh_sharpe).mean()*100:.0f}%)")

print("\n  MULTIPLE-TESTING CONTEXT")
print(f"    with {len(df)} independent tries, the best result by pure chance is roughly")
print(f"    the {100*(1-1/len(df)):.1f}th percentile of the null — i.e. a 'winner' is expected")
print(f"    even when no edge exists. IS->OOS correlation is what separates the two.")

# ---- WHAT is the persistent structure? ----
print("\n" + "=" * 104)
print("WHAT IS THE IS->OOS CORRELATION ACTUALLY DETECTING?")
print("=" * 104)
print(f"  corr(EXPOSURE, OOS Sharpe)          : {df['expo'].corr(df['oos_sharpe']):+.3f}")
print(f"  corr(EXPOSURE, IS Sharpe)           : {df['expo'].corr(df['is_sharpe']):+.3f}")
print(f"  corr(IS Sharpe, OOS Sharpe)         : {df['is_sharpe'].corr(df['oos_sharpe']):+.3f}")
# partial: does IS rank still predict OOS once exposure is removed?
import numpy as np
def resid(y, x):
    x1 = np.c_[np.ones(len(x)), x]
    beta = np.linalg.lstsq(x1, y, rcond=None)[0]
    return y - x1 @ beta
r_is = resid(df["is_sharpe"].values, df["expo"].values)
r_oos = resid(df["oos_sharpe"].values, df["expo"].values)
print(f"  PARTIAL corr(IS, OOS | exposure)    : {np.corrcoef(r_is, r_oos)[0,1]:+.3f}   <-- edge after beta")

print("\n  BY PROXIMITY BUCKET (the actual 'bounce off the 200' question):")
g = df.groupby("prox").agg(n=("oos_sharpe","size"), oos=("oos_sharpe","mean"),
                           expo=("expo","mean")).sort_values("oos", ascending=False)
for k, r in g.iterrows():
    print(f"    {k:12s} n={int(r['n']):3d}  mean OOS Sharpe {r['oos']:+.3f}  mean exposure {r['expo']:5.1f}%")

print(f"\n  combos beating buy&hold OOS Sharpe ({bh_sharpe:.2f}): "
      f"{int((df['oos_sharpe'] > bh_sharpe).sum())} of {len(df)}")
best = df.loc[df['oos_sharpe'].idxmax()]
print(f"  single best OOS combo: {best['combo']}  (OOS Sharpe {best['oos_sharpe']:.2f}, "
      f"CAGR {best['oos_cagr']:.1f}%, exposure {best['expo']:.0f}%)")
