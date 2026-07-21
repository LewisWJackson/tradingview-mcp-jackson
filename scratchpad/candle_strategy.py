"""Phase 2 — is the candle-COUNT bounce edge out-of-sample real, and is it tradeable?

The event study said: candlestick FORMATIONS have no edge (several negative), but
candle COUNTS (consecutive down closes, TD Sequential 9) do — and the 200-SMA /
higher-timeframe context amplifies them. That is the "buy the dip in a confirmed
uptrend" effect.

An event-study edge is necessary, not sufficient. Two things kill most of them:
  1. it does not survive out-of-sample
  2. it is smaller than the cost of harvesting it
Both are tested here, with the strategy compared to buy & hold on identical windows.
"""
import os
import numpy as np
import pandas as pd

OHLC = os.path.join(os.path.dirname(__file__), "ohlc")
SYMBOLS = ["SPY", "QQQ", "IWM", "GLD", "BTC-USD"]
COST = 0.0005          # 5bps per side, same assumption as the rest of the project
TD_ = 252


def load(sym):
    df = pd.read_csv(os.path.join(OHLC, f"{sym}.csv"), parse_dates=["date"]).set_index("date")
    c = df["close"]
    f = pd.DataFrame(index=df.index)
    f["close"] = c
    f["ret"] = c.pct_change().fillna(0.0)
    sma200, sma20 = c.rolling(200).mean(), c.rolling(20).mean()
    f["above_200"] = c > sma200
    f["rising"] = sma200 > sma200.shift(20)
    f["pullback"] = c < sma20
    f["above_20"] = c > sma20
    wk = c.resample("W").last()
    f["htf_up"] = (wk > wk.rolling(20).mean()).reindex(c.index, method="ffill").fillna(False)
    down = c < c.shift(1)
    run = down.groupby((~down).cumsum()).cumsum()
    f["down_3"] = run >= 3
    f["down_4"] = run >= 4
    td = c < c.shift(4)
    f["td9"] = td.groupby((~td).cumsum()).cumsum() >= 9
    return f.dropna()


panel = {s: load(s) for s in SYMBOLS}


def entries(f, trigger):
    return (f[trigger] & f["above_200"] & f["rising"] & f["htf_up"] & f["pullback"]).fillna(False)


def run_strategy(f, trigger, exit_rule, hold=5):
    """Long-only bounce trades. Signal on bar t -> enter at t+1 close (no lookahead)."""
    sig = entries(f, trigger).shift(1).fillna(False)
    ret = f["ret"].values
    above20 = f["above_20"].values
    n = len(f)
    pos = np.zeros(n)
    i = 0
    trades = []
    while i < n:
        if sig.iloc[i] and pos[i] == 0:
            entry = i
            j = i
            while j < n - 1:
                j += 1
                pos[j] = 1
                if exit_rule == "hold" and (j - entry) >= hold:
                    break
                if exit_rule == "above20" and above20[j]:
                    break
                if exit_rule == "hold20" and ((j - entry) >= 20 or above20[j]):
                    break
            trades.append((entry, j, float(np.prod(1 + ret[entry + 1:j + 1]) - 1)))
            i = j + 1
        else:
            i += 1
    gross = pos * ret
    turns = np.abs(np.diff(np.concatenate([[0], pos])))
    strat = gross - turns * COST
    return pd.Series(strat, index=f.index), pos, trades


def stats(r, pos=None):
    r = pd.Series(r).dropna()
    if len(r) == 0 or (1 + r).prod() <= 0:
        return None
    yrs = len(r) / TD_
    cagr = (1 + r).prod() ** (1 / yrs) - 1
    sharpe = r.mean() / r.std() * np.sqrt(TD_) if r.std() > 0 else np.nan
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    expo = float(np.mean(pos)) * 100 if pos is not None else 100.0
    return cagr * 100, sharpe, dd * 100, expo


print("=" * 100)
print("PHASE 2a — OUT-OF-SAMPLE SPLIT  (in-sample 2001-2013 | out-of-sample 2014-2026)")
print("=" * 100)
print(f"{'trigger / exit':28s} {'window':>10s} {'CAGR':>8s} {'Sharpe':>8s} {'maxDD':>8s} {'expo':>7s} {'trades':>7s}")
print("-" * 100)

for trigger in ["down_3", "down_4", "td9"]:
    for exit_rule in ["hold", "above20"]:
        for lbl, sl in [("IS 01-13", slice("2001", "2013")), ("OOS 14-26", slice("2014", "2026"))]:
            rs, ns, ts = [], [], 0
            for s in SYMBOLS:
                f = panel[s].loc[sl]
                if len(f) < 300:
                    continue
                r, pos, trades = run_strategy(f, trigger, exit_rule)
                rs.append(r)
                ns.append(pos)
                ts += len(trades)
            if not rs:
                continue
            # equal-weight across symbols traded
            comb = pd.concat(rs, axis=1).fillna(0.0).mean(axis=1)
            expo = np.mean([np.mean(p) for p in ns]) * 100
            st = stats(comb)
            print(f"{trigger + ' / ' + exit_rule:28s} {lbl:>10s} {st[0]:7.1f}% {st[1]:8.2f} {st[2]:7.1f}% "
                  f"{expo:6.1f}% {ts:7d}")
    print()

print("=" * 100)
print("PHASE 2b — VS BUY & HOLD, same window, per symbol (best variant: down_3 / exit above20)")
print("=" * 100)
print(f"{'symbol':10s} {'strategy CAGR':>14s} {'Sharpe':>8s} {'maxDD':>8s} {'expo':>7s} | "
      f"{'B&H CAGR':>9s} {'Sharpe':>8s} {'maxDD':>8s}")
print("-" * 100)
for s in SYMBOLS:
    f = panel[s]
    r, pos, trades = run_strategy(f, "down_3", "above20")
    st = stats(r, pos)
    bh = stats(f["ret"])
    print(f"{s:10s} {st[0]:13.1f}% {st[1]:8.2f} {st[2]:7.1f}% {st[3]:6.1f}% | "
          f"{bh[0]:8.1f}% {bh[1]:8.2f} {bh[2]:7.1f}%")

print("\n" + "=" * 100)
print("PHASE 2c — DOES THE COST ASSUMPTION KILL IT?  (down_3 / above20, all symbols pooled)")
print("=" * 100)
for cost_bps in [0, 5, 10, 20]:
    globals()["COST"] = cost_bps / 10000.0
    rs, ns = [], []
    for s in SYMBOLS:
        r, pos, _ = run_strategy(panel[s], "down_3", "above20")
        rs.append(r); ns.append(pos)
    comb = pd.concat(rs, axis=1).fillna(0.0).mean(axis=1)
    st = stats(comb)
    print(f"  cost {cost_bps:2d}bps/side -> CAGR {st[0]:6.2f}%   Sharpe {st[1]:5.2f}   maxDD {st[2]:6.1f}%")
