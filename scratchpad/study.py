"""Non-trend sleeve study.

Question: can the validated regime-beta TREND book be improved by stacking a
genuine NON-trend return source onto it? The battle-test showed you cannot
diversify trend with more trend (corr ~0.48). Here we test the two non-trend
sources that are cleanly buildable with clean daily data:

  - equity_anchor : static buy&hold SPY/QQQ beta (always on) -- recaptures the
                    bull upside the regime filter gives up.
  - bond_carry    : static buy&hold IEF term premium (HELD, not trend-traded --
                    fixing the category error that sank the earlier naive test).

Construction is the professional playbook: inverse-vol risk parity, monthly
rebalance. We report raw metrics AND a vol-matched view (every portfolio scaled
to 10% annual vol) so drawdowns compare at equal risk. Honest stress rows for
2008 / 2020 / 2022 (2022 is where stock-bond diversification broke).
"""
import os
import numpy as np
import pandas as pd

DATA = os.path.join(os.path.dirname(__file__), "data")
TRADING_DAYS = 252


def load(ticker):
    df = pd.read_csv(os.path.join(DATA, f"{ticker}.csv"), parse_dates=["date"])
    return df.set_index("date")["adjclose"]


# ---- assemble aligned adjusted-close panel ----
tickers = ["SPY", "QQQ", "GLD", "IEF", "TLT", "AGG", "BIL", "BTC-USD"]
px = pd.DataFrame({t: load(t) for t in tickers})

START = "2007-05-30"   # BIL inception -> real T-bill cash rate available
px = px.loc[START:]
# Business-day close-to-close; forward-fill crypto gaps onto the equity calendar
px = px.reindex(pd.bdate_range(px.index.min(), px.index.max())).ffill()

rets = px.pct_change().fillna(0.0)
cash = rets["BIL"]                       # daily T-bill total return (the risk-free sleeve)


def regime_stream(asset, sma=100):
    """Long the asset while adj-close > SMA (signal lagged 1 day), else earn cash."""
    p = px[asset]
    sig = (p > p.rolling(sma).mean()).shift(1).fillna(False)
    r = rets[asset].where(sig, cash)
    return r


# ---- SLEEVES (each a 1x daily return stream) ----
# trend book: mirror the bot's relative weights among full-window assets, sum=1
trend = 0.35 * regime_stream("SPY") + 0.35 * regime_stream("QQQ") + 0.30 * regime_stream("GLD")
equity_anchor = 0.5 * rets["SPY"] + 0.5 * rets["QQQ"]     # static beta, always on
bond_carry = rets["IEF"]                                   # static term premium, HELD

sleeves = pd.DataFrame({"trend": trend, "equity_anchor": equity_anchor, "bond_carry": bond_carry})


# ---- portfolio builders ----
def growth(r):
    return (1 + r).cumprod()


def inv_vol_rp(cols, lookback=60, rebal="ME"):
    """Inverse-vol risk parity, weights sum to 1, rebalanced monthly (no lookahead)."""
    sub = sleeves[cols]
    vol = sub.rolling(lookback).std().shift(1)
    w = (1.0 / vol)
    w = w.div(w.sum(axis=1), axis=0)
    # hold weights fixed within each month (rebalance on month-end marks)
    marks = w.resample(rebal).last().reindex(w.index, method="ffill")
    marks = marks.shift(1).ffill().fillna(1.0 / len(cols))   # lag so weights are known
    port = (sub * marks).sum(axis=1)
    return port


def fixed_blend(weights, rebal="ME"):
    """Static weighted blend of sleeves, rebalanced monthly."""
    cols = list(weights)
    sub = sleeves[cols]
    w = pd.DataFrame(index=sub.index, columns=cols, dtype=float)
    for c in cols:
        w[c] = weights[c]
    return (sub * w).sum(axis=1)


portfolios = {
    "SPY buy&hold": rets["SPY"],
    "60/40 SPY/IEF": 0.6 * rets["SPY"] + 0.4 * rets["IEF"],
    "Trend book (1x)": sleeves["trend"],
    "Trend + BondCarry (RP)": inv_vol_rp(["trend", "bond_carry"]),
    "Trend + Equity (RP)": inv_vol_rp(["trend", "equity_anchor"]),
    "3-sleeve RP (all)": inv_vol_rp(["trend", "equity_anchor", "bond_carry"]),
}


# ---- metrics ----
def ann_vol(r):
    return r.std() * np.sqrt(TRADING_DAYS)


def metrics(r):
    r = r.dropna()
    n = len(r)
    cagr = (1 + r).prod() ** (TRADING_DAYS / n) - 1
    vol = ann_vol(r)
    excess = r - cash.reindex(r.index).fillna(0)
    sharpe = excess.mean() / r.std() * np.sqrt(TRADING_DAYS) if r.std() > 0 else np.nan
    downside = r[r < 0].std()
    sortino = excess.mean() / downside * np.sqrt(TRADING_DAYS) if downside > 0 else np.nan
    eq = (1 + r).cumprod()
    dd = (eq / eq.cummax() - 1).min()
    calmar = cagr / abs(dd) if dd < 0 else np.nan
    corr = r.corr(rets["SPY"].reindex(r.index))
    return dict(CAGR=cagr, Vol=vol, Sharpe=sharpe, Sortino=sortino,
                MaxDD=dd, Calmar=calmar, CorrSPY=corr)


def vol_matched(r, target=0.10):
    """Scale to constant target vol using trailing realized vol (funded at cash)."""
    rv = r.rolling(20).std().shift(1) * np.sqrt(TRADING_DAYS)
    lev = (target / rv).clip(upper=3.0).fillna(1.0)
    return lev * r + (1 - lev) * cash.reindex(r.index).fillna(0)


print("=" * 92)
print(f"NON-TREND SLEEVE STUDY   window {px.index.min().date()} -> {px.index.max().date()}   (unlevered risk parity)")
print("=" * 92)

rows = []
for name, r in portfolios.items():
    m = metrics(r)
    rows.append((name, m))
    print(f"{name:26s}  CAGR {m['CAGR']*100:5.1f}%  Vol {m['Vol']*100:4.1f}%  "
          f"Sharpe {m['Sharpe']:.2f}  Sortino {m['Sortino']:.2f}  "
          f"MaxDD {m['MaxDD']*100:6.1f}%  Calmar {m['Calmar']:.2f}  CorrSPY {m['CorrSPY']:.2f}")

print("\n--- VOL-MATCHED to 10% annual vol (drawdown at EQUAL risk) ---")
for name, r in portfolios.items():
    m = metrics(vol_matched(r))
    print(f"{name:26s}  CAGR {m['CAGR']*100:5.1f}%  Vol {m['Vol']*100:4.1f}%  "
          f"Sharpe {m['Sharpe']:.2f}  MaxDD {m['MaxDD']*100:6.1f}%  Calmar {m['Calmar']:.2f}")

print("\n--- SLEEVE CORRELATION MATRIX (are these genuinely different sources?) ---")
print(sleeves.corr().round(2).to_string())

print("\n--- STRESS YEARS (calendar-year total return) ---")
stress = ["2008", "2018", "2020", "2022", "2025"]
hdr = "  ".join(f"{y:>7s}" for y in stress)
print(f"{'':26s}  {hdr}")
for name, r in portfolios.items():
    cells = []
    for y in stress:
        ry = r.loc[y] if y in r.index.strftime("%Y") else None
        yr = (1 + r[r.index.strftime("%Y") == y]).prod() - 1
        cells.append(f"{yr*100:6.1f}%")
    print(f"{name:26s}  {'  '.join(cells)}")

# ---- save equity curves for plotting ----
out = pd.DataFrame({name: growth(r) for name, r in portfolios.items()})
out.to_csv(os.path.join(os.path.dirname(__file__), "study_curves.csv"))
print(f"\nsaved curves -> study_curves.csv   final $1 -> " +
      "  ".join(f"{n}:${growth(r).iloc[-1]:.1f}" for n, r in portfolios.items()))
