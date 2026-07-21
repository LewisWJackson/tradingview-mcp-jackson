"""Fetch ETFs spanning a very wide liquidity range, with volume.

The capacity thesis says: edges survive where big money cannot go. If true, the
trend/regime rule should add MORE value as liquidity falls. This universe spans
roughly four orders of magnitude of daily dollar volume — from SPY (~$30bn/day)
down to single-country and frontier funds (<$1m/day) — so the thesis can be
tested for free before committing to paid stock-level data.
"""
import csv, json, os, time, urllib.request

OUT = os.path.join(os.path.dirname(__file__), "liq")
os.makedirs(OUT, exist_ok=True)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120 Safari/537.36")

TICKERS = [
    # mega-liquid
    "SPY", "QQQ", "IWM", "EFA", "EEM", "TLT", "GLD", "HYG", "XLK", "XLF", "XLE",
    # mid
    "EWJ", "EWZ", "FXI", "IYR", "SLV", "XBI", "KRE", "SMH", "GDX", "XRT", "DBC",
    # smaller / single country
    "EWG", "EWU", "EWC", "EWA", "EWW", "EWH", "EWS", "EWM", "EWY", "EWT",
    "EWP", "EWQ", "EWL", "EWN", "EWD", "EWK", "EWO", "EWI",
    # genuinely thin
    "IWC", "THD", "TUR", "ECH", "EIS", "EPU", "ARGT", "GREK", "EIRL", "NORW", "EPHE",
]


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
        c, v, a = q["close"][i], q["volume"][i], adj[i]
        if None in (c, a) or c == 0:
            continue
        rows[time.strftime("%Y-%m-%d", time.gmtime(t))] = (a, (v or 0) * c)
    return sorted(rows.items())


ok, bad = 0, []
for tk in TICKERS:
    p = os.path.join(OUT, f"{tk}.csv")
    if os.path.exists(p):
        ok += 1
        continue
    try:
        rows = fetch(tk)
        if len(rows) < 1200:
            bad.append((tk, f"{len(rows)} bars"))
            continue
        with open(p, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["date", "adjclose", "dollar_volume"])
            for d, (a, dv) in rows:
                w.writerow([d, a, dv])
        ok += 1
        time.sleep(0.3)
    except Exception as e:
        bad.append((tk, str(e)[:40]))

print(f"fetched/cached {ok} of {len(TICKERS)}")
for t, w in bad:
    print(f"  skipped {t}: {w}")
