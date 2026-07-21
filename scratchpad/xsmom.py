"""Cross-sectional momentum — hold the strongest N of a wide ETF universe.

This is a DIFFERENT edge from the bot's time-series trend. Time-series asks
"is SPY above its own trend?". Cross-sectional asks "which 5 of these 47 are
strongest right now?" — a relative, not absolute, judgement. It is one of the
most robustly documented anomalies in finance and the one thing this project's
rejections have never covered.

Discipline carried over from the 208-combo sweep that caught the last idea out:
  - select on IN-SAMPLE only, judge OUT-OF-SAMPLE
  - report IS->OOS rank correlation (is selection meaningful, or a lottery?)
  - decompose against EXPOSURE (is the "edge" just time in market?)
  - benchmark against SPY, the equal-weight universe, AND the live regime book
  - costs on turnover, signals lagged, no lookahead
"""
import os
import itertools
import numpy as np
import pandas as pd

UNI = os.path.join(os.path.dirname(__file__), "universe")
TD = 252
COST = 0.0010          # 10bps per side — cross-sectional rotation turns over more

files = [f[:-4] for f in os.listdir(UNI) if f.endswith(".csv")]
RISKY = sorted([t for t in files if t != "BIL"])


def load(t):
    df = pd.read_csv(os.path.join(UNI, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


px = pd.DataFrame({t: load(t) for t in files})
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
px = px.loc["2007-05-30":]                    # BIL inception -> real cash rate
rets = px.pct_change()
cash_r = rets["BIL"].fillna(0.0)

sma200 = px[RISKY].rolling(200).mean()
above200 = px[RISKY] > sma200

month_ends = px.resample("ME").last().index
month_ends = [d for d in month_ends if d in px.index or True]


def build(lookback, skip, topn, absfilter):
    """Monthly-rebalanced equal-weight top-N by relative strength."""
    w = pd.DataFrame(0.0, index=px.index, columns=RISKY)
    me = px[RISKY].resample("ME").last()
    a200 = above200.resample("ME").last()
    mom = me.shift(skip) / me.shift(skip + lookback) - 1

    holdings = {}
    for i, d in enumerate(mom.index):
        if i < lookback + skip:
            continue
        m = mom.loc[d].dropna()
        if absfilter == "own200":
            ok = a200.loc[d].reindex(m.index).fillna(False)
            m = m[ok]
        m = m[m > -np.inf]
        picks = m.nlargest(topn).index.tolist()
        holdings[d] = picks

    # apply each month-end's picks to the FOLLOWING month (no lookahead)
    dates = sorted(holdings)
    for j, d in enumerate(dates):
        start = d + pd.Timedelta(days=1)
        end = dates[j + 1] if j + 1 < len(dates) else px.index[-1]
        picks = holdings[d]
        if not picks:
            continue
        seg = w.loc[start:end]
        if len(seg) == 0:
            continue
        w.loc[start:end, picks] = 1.0 / topn

    gross = w.sum(axis=1)
    port = (w * rets[RISKY]).sum(axis=1) + (1 - gross).clip(lower=0) * cash_r
    turn = w.diff().abs().sum(axis=1).fillna(0.0)
    return port - turn * COST, gross


def stats(r):
    r = r.dropna()
    if len(r) < 100:
        return None
    eq = (1 + r).cumprod()
    cagr = eq.iloc[-1] ** (TD / len(r)) - 1
    sh = r.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    dd = (eq / eq.cummax() - 1).min()
    return cagr * 100, sh, dd * 100


# ---------------- benchmarks ----------------
IS, OOS = slice("2007-06-01", "2016-12-31"), slice("2017-01-01", None)
spy = rets["SPY"]
eqw = rets[RISKY].mean(axis=1)


def regime_book():
    W = {"SPY": 0.35, "QQQ": 0.35, "GLD": 0.15, "IWM": 0.15}
    out = pd.Series(0.0, index=px.index)
    for s, wt in W.items():
        sig = (px[s] > px[s].rolling(200).mean()).shift(1).fillna(False)
        out += wt * rets[s].where(sig, cash_r)
    return out


book = regime_book()

# ---------------- the grid ----------------
GRID = list(itertools.product([1, 3, 6, 12], [0, 1], [3, 5, 8], ["none", "own200"]))
rows = []
for lb, sk, n, af in GRID:
    r, g = build(lb, sk, n, af)
    a, b = stats(r[IS]), stats(r[OOS])
    if a and b:
        rows.append({"combo": f"{lb}m/skip{sk}/top{n}/{af}", "lb": lb, "skip": sk,
                     "n": n, "af": af, "is_sharpe": a[1], "is_cagr": a[0],
                     "oos_cagr": b[0], "oos_sharpe": b[1], "oos_dd": b[2],
                     "expo": g[OOS].mean() * 100})

df = pd.DataFrame(rows).sort_values("is_sharpe", ascending=False)

print("=" * 106)
print(f"CROSS-SECTIONAL MOMENTUM — {len(RISKY)} ETFs, {len(df)} combos, monthly rebalance, 10bps/side")
print("=" * 106)
print("\nTOP 12 BY IN-SAMPLE SHARPE (2007-2016), with their OUT-OF-SAMPLE result (2017-2026):\n")
print(f"{'combo':26s} {'IS Sharpe':>10s} {'IS CAGR':>9s} | {'OOS CAGR':>9s} {'OOS Sharpe':>11s} {'OOS DD':>8s} {'expo':>7s}")
print("-" * 106)
for _, r in df.head(12).iterrows():
    print(f"{r['combo']:26s} {r['is_sharpe']:10.2f} {r['is_cagr']:8.1f}% | "
          f"{r['oos_cagr']:8.1f}% {r['oos_sharpe']:11.2f} {r['oos_dd']:7.1f}% {r['expo']:6.1f}%")

print("-" * 106)
for lbl, series in [("SPY buy & hold", spy), ("equal-weight universe", eqw),
                    ("LIVE regime book (200d)", book)]:
    a, b = stats(series[IS]), stats(series[OOS])
    print(f"{lbl:26s} {a[1]:10.2f} {a[0]:8.1f}% | {b[0]:8.1f}% {b[1]:11.2f} {b[2]:7.1f}% {100.0:6.1f}%")

# ---------------- the discipline ----------------
print("\n" + "=" * 106)
print("SELECTION DISCIPLINE")
print("=" * 106)
c = df["is_sharpe"].corr(df["oos_sharpe"])
cr = df["is_sharpe"].rank().corr(df["oos_sharpe"].rank())
print(f"  corr(IS Sharpe, OOS Sharpe)        : pearson {c:+.3f}   rank {cr:+.3f}")
print(f"  corr(EXPOSURE, OOS Sharpe)         : {df['expo'].corr(df['oos_sharpe']):+.3f}")


def resid(y, x):
    x1 = np.c_[np.ones(len(x)), x]
    return y - x1 @ np.linalg.lstsq(x1, y, rcond=None)[0]


print(f"  PARTIAL corr(IS, OOS | exposure)   : "
      f"{np.corrcoef(resid(df['is_sharpe'].values, df['expo'].values), resid(df['oos_sharpe'].values, df['expo'].values))[0,1]:+.3f}")
k = max(1, len(df) // 4)
print(f"  mean OOS Sharpe, best 25% in-sample: {df.head(k)['oos_sharpe'].mean():+.3f}")
print(f"  mean OOS Sharpe, worst 25%         : {df.tail(k)['oos_sharpe'].mean():+.3f}")
print(f"  mean OOS Sharpe, ALL combos        : {df['oos_sharpe'].mean():+.3f}")
bench_oos = stats(book[OOS])[1]
print(f"  combos beating the LIVE BOOK OOS ({bench_oos:.2f}) : "
      f"{int((df['oos_sharpe'] > bench_oos).sum())} of {len(df)}")

print("\n  MEAN OOS SHARPE BY PARAMETER (is any dimension robust, or is it noise?)")
for dim in ["lb", "skip", "n", "af"]:
    g = df.groupby(dim)["oos_sharpe"].mean()
    print(f"    {dim:5s} " + "   ".join(f"{k}: {v:+.2f}" for k, v in g.items()))

# ---------------- is it at least a DIVERSIFIER? ----------------
print("\n" + "=" * 106)
print("FINAL FAIR TEST — even at lower Sharpe, does it ADD as an uncorrelated sleeve?")
print("=" * 106)
best = df.loc[df["oos_sharpe"].idxmax()]
r_best, _ = build(int(best["lb"]), int(best["skip"]), int(best["n"]), best["af"])
print(f"  best OOS combo: {best['combo']}  (OOS Sharpe {best['oos_sharpe']:.2f})")
print(f"  corr(XS momentum, live regime book) OOS : {r_best[OOS].corr(book[OOS]):+.3f}")
print(f"  corr(XS momentum, SPY)              OOS : {r_best[OOS].corr(spy[OOS]):+.3f}")
print()
print(f"  {'blend':34s} {'CAGR':>8s} {'Sharpe':>8s} {'maxDD':>8s}")
print("  " + "-" * 62)
for wx in [0.0, 0.2, 0.3, 0.5]:
    blend = (1 - wx) * book + wx * r_best
    s = stats(blend[OOS])
    tag = "  <-- book alone" if wx == 0 else ("  better" if s[1] > stats(book[OOS])[1] + 0.01 else "  worse")
    print(f"  {f'{int((1-wx)*100)}% book / {int(wx*100)}% XS-mom':34s} {s[0]:7.1f}% {s[1]:8.2f} {s[2]:7.1f}%{tag}")
