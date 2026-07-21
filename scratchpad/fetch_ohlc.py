"""Fetch full OHLC daily bars (candlestick patterns need more than closes).

Each bar's O/H/L/C is scaled by adjclose/close so the series is total-return
consistent while each candle's geometry (body vs wicks) is preserved exactly —
a per-bar multiplicative factor cannot change body/wick RATIOS.
"""
import csv, json, os, time, urllib.request

OUT = os.path.join(os.path.dirname(__file__), "ohlc")
os.makedirs(OUT, exist_ok=True)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")
TICKERS = ["SPY", "QQQ", "IWM", "GLD", "BTC-USD"]


def fetch(tk):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{tk}"
           f"?range=25y&interval=1d&events=div%7Csplit")
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=40) as r:
        d = json.load(r)
    res = d["chart"]["result"][0]
    q = res["indicators"]["quote"][0]
    adj = res["indicators"]["adjclose"][0]["adjclose"]
    rows = {}
    for i, t in enumerate(res["timestamp"]):
        o, h, l, c, v, a = q["open"][i], q["high"][i], q["low"][i], q["close"][i], q["volume"][i], adj[i]
        if None in (o, h, l, c, a) or c == 0:
            continue
        f = a / c                      # same factor across O/H/L/C -> geometry preserved
        rows[time.strftime("%Y-%m-%d", time.gmtime(t))] = (o * f, h * f, l * f, a, v or 0)
    return sorted(rows.items())


for tk in TICKERS:
    rows = fetch(tk)
    with open(os.path.join(OUT, f"{tk}.csv"), "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date", "open", "high", "low", "close", "volume"])
        for d, (o, h, l, c, v) in rows:
            w.writerow([d, o, h, l, c, v])
    print(f"{tk:8s} {len(rows):5d} bars  {rows[0][0]} -> {rows[-1][0]}")
