"""Fetch a wide ETF universe for cross-sectional momentum.

Breadth is the whole point: cross-sectional ranking is meaningless on 4 assets.
Sectors + broad US + style + international + bonds + real assets + industries,
chosen for long history rather than for what happened to work.
"""
import csv, json, os, time, urllib.request

OUT = os.path.join(os.path.dirname(__file__), "universe")
os.makedirs(OUT, exist_ok=True)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

TICKERS = [
    # US sectors
    "XLB", "XLE", "XLF", "XLI", "XLK", "XLP", "XLU", "XLV", "XLY",
    # broad US + size + style
    "SPY", "QQQ", "IWM", "DIA", "MDY", "IWD", "IWF",
    # international
    "EFA", "EEM", "EWJ", "EWG", "EWU", "EWZ", "EWH", "EWA", "EWC", "EWW", "FXI",
    # fixed income
    "TLT", "IEF", "SHY", "LQD", "TIP", "AGG", "HYG",
    # real assets
    "GLD", "SLV", "DBC", "VNQ", "IYR", "GDX",
    # industries
    "SMH", "IBB", "XBI", "KRE", "XRT", "XHB", "OIH",
    # cash proxy
    "BIL",
]


def fetch(tk):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}"
           f"?range=25y&interval=1d&events=div%7Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    rows = {}
    for t, a in zip(res["timestamp"], adj):
        if a is not None:
            rows[time.strftime("%Y-%m-%d", time.gmtime(t))] = a
    return sorted(rows.items())


ok, bad = 0, []
for tk in TICKERS:
    p = os.path.join(OUT, f"{tk}.csv")
    if os.path.exists(p):
        ok += 1
        continue
    try:
        rows = fetch(tk)
        if len(rows) < 500:
            bad.append((tk, f"only {len(rows)} bars"))
            continue
        with open(p, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "adjclose"])
            w.writerows(rows)
        print(f"  {tk:6s} {len(rows):5d} bars  {rows[0][0]} -> {rows[-1][0]}")
        ok += 1
        time.sleep(0.35)
    except Exception as e:
        bad.append((tk, str(e)[:60]))

print(f"\nfetched/cached {ok} of {len(TICKERS)}")
for tk, why in bad:
    print(f"  FAILED {tk}: {why}")
