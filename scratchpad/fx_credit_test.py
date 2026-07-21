"""Do FX carry or CREDIT offer a genuinely different return source?

Same bar every other sleeve had to clear: (1) low correlation to the trend book
AND to equity, (2) a standalone risk premium worth harvesting, (3) it must not
fall apart in exactly the crises it is supposed to cushion.

Sleeves tested:
  DBV  - G10 FX carry (long high-yielders / short low-yielders) -- the real thing
  FXY  - yen, the classic funding currency (risk-off proxy)
  UUP  - dollar index
  HYG  - high yield credit
  LQD  - investment grade credit
  HYG-IEF - the CREDIT PREMIUM isolated (credit return minus duration)
"""
import csv, json, os, time, urllib.request
import numpy as np, pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA, exist_ok=True)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
TD = 252
NEW = ["DBV", "FXY", "UUP", "HYG", "LQD", "EMB"]


def fetch(tk):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}"
           f"?range=25y&interval=1d&events=div%7Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    rows = {}
    for t, a in zip(res["timestamp"], res["indicators"]["adjclose"][0]["adjclose"]):
        if a is not None:
            rows[time.strftime("%Y-%m-%d", time.gmtime(t))] = a
    return sorted(rows.items())


for tk in NEW:
    p = os.path.join(DATA, f"{tk}.csv")
    if not os.path.exists(p):
        rows = fetch(tk)
        with open(p, "w", newline="") as f:
            w = csv.writer(f); w.writerow(["date", "adjclose"]); w.writerows(rows)
        print(f"fetched {tk:5s} {len(rows)} bars {rows[0][0]} -> {rows[-1][0]}")
        time.sleep(0.4)


def load(t):
    df = pd.read_csv(os.path.join(DATA, f"{t}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


core = ["SPY", "QQQ", "GLD", "IEF", "BIL"]
px = pd.DataFrame({t: load(t) for t in core + NEW}).loc["2007-05-30":]
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()
rets = px.pct_change().fillna(0.0)
cash = rets["BIL"]


def regime(a, sma=100):
    p = px[a]
    return rets[a].where((p > p.rolling(sma).mean()).shift(1).fillna(False), cash)


trend = 0.5 * regime("SPY") + 0.5 * regime("QQQ") + 0.2 * regime("GLD")
equity = 0.5 * rets["SPY"] + 0.5 * rets["QQQ"]

sleeves = {
    "FX carry (DBV)": rets["DBV"],
    "Yen / funding (FXY)": rets["FXY"],
    "Dollar (UUP)": rets["UUP"],
    "High yield credit (HYG)": rets["HYG"],
    "IG credit (LQD)": rets["LQD"],
    "EM debt (EMB)": rets["EMB"],
    "CREDIT PREMIUM (HYG-IEF)": rets["HYG"] - rets["IEF"],
    "[ref] bond carry (IEF)": rets["IEF"],
}


def stats(r):
    r = r.dropna()
    cagr = (1 + r).prod() ** (TD / len(r)) - 1
    ex = r - cash.reindex(r.index).fillna(0)
    sh = ex.mean() / r.std() * np.sqrt(TD) if r.std() > 0 else np.nan
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    return cagr, sh, dd


print("\n" + "=" * 104)
print("FX & CREDIT AS NON-TREND SLEEVES   (2007-05 -> 2026-07, dividend-adjusted)")
print("=" * 104)
print(f"{'sleeve':28s} {'CAGR':>7s} {'Sharpe':>7s} {'MaxDD':>8s} | {'corr EQUITY':>11s} {'corr TREND':>10s} | "
      f"{'2008':>7s} {'2020':>7s} {'2022':>7s}")
print("-" * 104)
for name, r in sleeves.items():
    c, sh, dd = stats(r)
    ce = r.corr(equity); ct = r.corr(trend)
    yr = lambda y: ((1 + r[r.index.strftime("%Y") == y]).prod() - 1) * 100
    print(f"{name:28s} {c*100:6.1f}% {sh:7.2f} {dd*100:7.1f}% | {ce:11.2f} {ct:10.2f} | "
          f"{yr('2008'):6.1f}% {yr('2020'):6.1f}% {yr('2022'):6.1f}%")

print("\n--- CRISIS CORRELATION: does the diversification hold when you need it? ---")
print("(correlation to equity in calm years vs in the crisis itself)")
for name in ["FX carry (DBV)", "High yield credit (HYG)", "CREDIT PREMIUM (HYG-IEF)", "[ref] bond carry (IEF)"]:
    r = sleeves[name]
    calm = r[r.index.strftime("%Y").isin(["2013", "2014", "2017", "2019", "2021"])]
    crisis = r[r.index.strftime("%Y").isin(["2008", "2020", "2022"])]
    ec = equity.reindex(calm.index); ex = equity.reindex(crisis.index)
    print(f"  {name:28s} calm {calm.corr(ec):+.2f}   crisis {crisis.corr(ex):+.2f}")
