"""Fetch dividend/split-adjusted daily closes from Yahoo's chart API (stdlib only).

No yfinance -> the live bot's websockets<11 pin is never touched. Caches one CSV
per ticker (date,adjclose) so the study reruns offline.
"""
import csv
import json
import os
import time
import urllib.request

OUT = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(OUT, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

TICKERS = ["SPY", "QQQ", "GLD", "IEF", "TLT", "AGG", "BIL", "SHY", "BTC-USD"]


def fetch(ticker):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{ticker}"
           f"?range=25y&interval=1d&events=div%7Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.load(r)
    res = data["chart"]["result"][0]
    ts = res["timestamp"]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    rows = []
    for t, a in zip(ts, adj):
        if a is None:
            continue
        d = time.strftime("%Y-%m-%d", time.gmtime(t))
        rows.append((d, a))
    # de-dupe by date keeping last
    seen = {}
    for d, a in rows:
        seen[d] = a
    return sorted(seen.items())


for tk in TICKERS:
    try:
        rows = fetch(tk)
        path = os.path.join(OUT, f"{tk}.csv")
        with open(path, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "adjclose"])
            w.writerows(rows)
        print(f"{tk:8s} {len(rows):5d} bars  {rows[0][0]} -> {rows[-1][0]}")
        time.sleep(0.5)
    except Exception as e:
        print(f"{tk:8s} FAILED: {e}")
