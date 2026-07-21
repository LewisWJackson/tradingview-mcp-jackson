"""Exit triggers — is there a BETTER "get out" rule than the moving average?

This is the right question to ask of this project. Everything it has established
says the edge is DRAWDOWN CONTROL, not alpha. So the highest-value remaining
question is not "what should I buy" but "what should get me out".

Eleven candidate exit rules, each long SPY while the condition is calm and in
T-bills while it is not. Judged on: risk-adjusted return, drawdown, how much
whipsaw they cause, and — the thing that actually matters — what they did in the
three crises (2008, 2020, 2022).

Selection discipline as before: IS 2001-2013, OOS 2014-2026, so a rule that only
looks good in-sample is exposed.
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TD = 252
COST = 0.0005


def load(t):
    return pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"]).set_index("date")["adjclose"]


px = pd.DataFrame({t: load(t) for t in ["SPY", "VIX", "HYG", "IEF", "BIL"]})
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
spy, vix = px["SPY"], px["VIX"]
ret = spy.pct_change().fillna(0.0)
cash = px["BIL"].pct_change().fillna(0.0)

# ---- candidate "stay invested" conditions (True = in the market) ----
sma = {n: spy.rolling(n).mean() for n in (50, 100, 200)}
mo10 = spy.resample("ME").last().rolling(10).mean().reindex(spy.index, method="ffill")
rv20 = ret.rolling(20).std() * np.sqrt(TD)
peak = spy.cummax()
dd = spy / peak - 1
mom12 = spy / spy.shift(252) - 1
credit = (px["HYG"] / px["IEF"])
credit_ma = credit.rolling(100).mean()

RULES = {
    "always invested (B&H)":      pd.Series(True, index=spy.index),
    "close > 50-day SMA":         spy > sma[50],
    "close > 100-day SMA (bot)":  spy > sma[100],
    "close > 200-day SMA":        spy > sma[200],
    "close > 10-month SMA":       spy > mo10,
    "VIX < 20":                   vix < 20,
    "VIX < 25":                   vix < 25,
    "VIX < 30":                   vix < 30,
    "VIX < its own 50d MA":       vix < vix.rolling(50).mean(),
    "realized vol < 20%":         rv20 < 0.20,
    "drawdown < 10%":             dd > -0.10,
    "12-1 momentum > 0":          mom12 > 0,
    "credit (HYG/IEF) > 100d MA": credit > credit_ma,
    "200SMA AND VIX<30":          (spy > sma[200]) & (vix < 30),
    "200SMA OR VIX<20":           (spy > sma[200]) | (vix < 20),
}


def run(cond):
    sig = cond.shift(1).fillna(False).astype(float)      # lag: no lookahead
    turn = sig.diff().abs().fillna(0.0)
    r = sig * ret + (1 - sig) * cash - turn * COST
    return r, sig


def stats(r, sig=None, sl=None):
    if sl is not None:
        r = r[sl]
        sig = sig[sl] if sig is not None else None
    r = r.dropna()
    eq = (1 + r).cumprod()
    cagr = eq.iloc[-1] ** (TD / len(r)) - 1
    sh = r.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    ddm = (eq / eq.cummax() - 1).min()
    expo = sig.mean() * 100 if sig is not None else 100.0
    trips = int(sig.diff().abs().sum() / 2) if sig is not None else 0
    return cagr * 100, sh, ddm * 100, expo, trips


IS, OOS = slice("2001", "2013"), slice("2014", "2026")
print("=" * 112)
print("EXIT TRIGGERS — long SPY when the condition holds, T-bills when it does not")
print("=" * 112)
print(f"{'rule':30s} | {'FULL 2001-2026':^32s} | {'IS Sharpe':>9s} {'OOS Sharpe':>10s} | {'expo':>6s} {'trips':>6s}")
print(f"{'':30s} | {'CAGR':>8s} {'Sharpe':>8s} {'maxDD':>8s} |{'':>9s} {'':>10s} | {'':>6s} {'':>6s}")
print("-" * 112)
results = {}
for name, cond in RULES.items():
    r, sig = run(cond)
    c, s, d, e, t = stats(r, sig)
    _, is_s, *_ = stats(r, sig, IS)
    _, oos_s, *_ = stats(r, sig, OOS)
    results[name] = (r, sig)
    print(f"{name:30s} | {c:7.1f}% {s:8.2f} {d:7.1f}% | {is_s:9.2f} {oos_s:10.2f} | {e:5.0f}% {t:6d}")

print("\n" + "=" * 112)
print("THE TEST THAT MATTERS — what each rule did in the three crises (total return)")
print("=" * 112)
CRISES = {"2008 GFC": ("2007-10-09", "2009-03-09"),
          "2020 COVID": ("2020-02-19", "2020-03-23"),
          "2022 bear": ("2022-01-03", "2022-10-12")}
print(f"{'rule':30s} " + "".join(f"{k:>14s}" for k in CRISES) + f"{'avg':>10s}")
print("-" * 112)
for name, (r, sig) in results.items():
    cells, vals = "", []
    for k, (a, b) in CRISES.items():
        v = (1 + r.loc[a:b]).prod() - 1
        vals.append(v)
        cells += f"{v*100:13.1f}%"
    print(f"{name:30s} {cells}{np.mean(vals)*100:9.1f}%")

print("\n" + "=" * 112)
print("WHIPSAW COST — how the rule behaves when there is NO crisis (2013 & 2017: calm bulls)")
print("=" * 112)
print(f"{'rule':30s} {'2013':>10s} {'2017':>10s} {'2024':>10s}   (B&H is the benchmark row)")
print("-" * 112)
for name, (r, sig) in results.items():
    row = f"{name:30s}"
    for y in ["2013", "2017", "2024"]:
        row += f"{((1+r.loc[y]).prod()-1)*100:9.1f}%"
    print(row)
