"""Stage 2 — does the LIVE path produce the same signals as the BACKTEST?

The live loop and the backtester share engine.evaluate, so the decision logic is
identical by construction. What is NOT guaranteed identical is the DATA each one
feeds it: the live path fetches a short warmup window and drops the in-progress
bar; the backtester pulls a long history. A feed gap, an off-by-one in the warmup
window, or a stale bar would silently change live behaviour while every backtest
still looked perfect.

This compares them directly, on the same dates:

  1. BAR PARITY    — identical OHLC on every overlapping date?
  2. SIGNAL PARITY — identical regime verdict (close > SMA) on every date where
                     BOTH windows can compute it?
  3. TRADE REPLAY  — what the engine actually did over the recent window, so the
                     current live signal can be read in context.

    python -m bot.parity              # default 12-month backtest window
    python -m bot.parity --months 24
"""
import argparse
from datetime import datetime, timezone

import pandas as pd
from dateutil.relativedelta import relativedelta

import config
from . import data_utils, engine
from .portfolio import Portfolio
from .risk_manager import RiskManager


def _live_bars(api, symbol, cfg):
    """Exactly what the live loop feeds the engine."""
    need = engine.warmup_bars(cfg, config.ATR_PERIOD)
    return data_utils.fetch_recent_bars(api, symbol, cfg["asset_class"], cfg["timeframe"], need)


def _backtest_bars(api, symbol, cfg, months):
    end = datetime.now(timezone.utc)
    start = end - relativedelta(months=months)
    # Bars use the RAW symbol ("BTC/USD"); only the orders/positions API uses the
    # concatenated broker form ("BTCUSD"). backtest.py and the live loop both pass
    # the raw symbol here, so parity must too.
    df = data_utils.fetch_bars(api, symbol, cfg["asset_class"], cfg["timeframe"], start, end)
    return data_utils.drop_incomplete_bar(df, cfg["timeframe"])


def _norm_index(df):
    idx = pd.DatetimeIndex(df.index)
    if idx.tz is None:
        idx = idx.tz_localize("UTC")
    return df.set_axis(idx.tz_convert("UTC").normalize(), axis=0)


def compare(symbol, cfg, live, back):
    live, back = _norm_index(live), _norm_index(back)
    common = live.index.intersection(back.index)
    out = {"symbol": symbol, "live_bars": len(live), "back_bars": len(back), "common": len(common)}

    if len(common) == 0:
        out["bar_mismatch"] = None
        out["signal_mismatch"] = None
        return out, None

    # 1. bar parity on overlapping dates
    cols = [c for c in ("open", "high", "low", "close") if c in live.columns and c in back.columns]
    l, b = live.loc[common, cols], back.loc[common, cols]
    diff = (l - b).abs()
    out["bar_mismatch"] = int((diff > 1e-6).any(axis=1).sum())
    out["max_abs_diff"] = float(diff.max().max())

    # 2. signal parity where BOTH can compute the SMA
    sma_n = cfg["params"].get("sma_period", 100)
    lsig = (live["close"] > live["close"].rolling(sma_n).mean()).reindex(common)
    bsig = (back["close"] > back["close"].rolling(sma_n).mean()).reindex(common)
    both = lsig.notna() & bsig.notna()
    # rolling() yields NaN only before warmup; align on where each series is valid
    valid = common[(live["close"].rolling(sma_n).mean().reindex(common).notna()) &
                   (back["close"].rolling(sma_n).mean().reindex(common).notna())]
    out["signal_compared"] = len(valid)
    out["signal_mismatch"] = int((lsig.loc[valid] != bsig.loc[valid]).sum()) if len(valid) else 0
    mismatches = valid[(lsig.loc[valid] != bsig.loc[valid])] if len(valid) else []
    return out, mismatches


def replay(symbol, cfg, bars):
    """Run the real engine over the bars and return the trade list."""
    pf = Portfolio(correlation_filter=[])
    rm = RiskManager(risk_per_trade=config.RISK_PER_TRADE, atr_period=config.ATR_PERIOD,
                     max_portfolio_drawdown=config.MAX_PORTFOLIO_DRAWDOWN)
    equity, events = 100_000.0, []
    for i in range(len(bars)):
        r = engine.evaluate(symbol, cfg, bars.iloc[: i + 1], pf, rm, equity)
        if r and r["action"] in ("open", "exit", "stop"):
            events.append((bars.index[i], r["action"], float(r["price"])))
    return events, pf.get(symbol) is not None


def main():
    ap = argparse.ArgumentParser(description="Live-vs-backtest signal parity check.")
    ap.add_argument("--months", type=int, default=12)
    args = ap.parse_args()

    api = data_utils.get_api()
    print("=" * 92)
    print(f"STAGE 2 PARITY — live data path vs {args.months}-month backtest path")
    print("=" * 92)

    total_bar_mm = total_sig_mm = 0
    for symbol, cfg in config.INSTRUMENTS.items():
        live = _live_bars(api, symbol, cfg)
        back = _backtest_bars(api, symbol, cfg, args.months)
        res, mismatches = compare(symbol, cfg, live, back)

        print(f"\n{symbol}")
        print(f"  bars: live={res['live_bars']}  backtest={res['back_bars']}  overlapping={res['common']}")
        if res["common"]:
            print(f"  bar parity   : {res['bar_mismatch']} mismatched bars "
                  f"(max abs diff {res['max_abs_diff']:.8f})")
            print(f"  signal parity: {res['signal_mismatch']} mismatches over {res['signal_compared']} comparable dates")
            total_bar_mm += res["bar_mismatch"]
            total_sig_mm += res["signal_mismatch"]
            if res["signal_mismatch"]:
                for ts in list(mismatches)[:5]:
                    print(f"     MISMATCH {ts.date()}")

        events, holding = replay(symbol, cfg, _norm_index(back))
        recent = events[-4:]
        print(f"  engine replay: {len(events)} actions over {args.months}mo; "
              f"currently {'HOLDING' if holding else 'FLAT'}")
        for ts, action, price in recent:
            print(f"     {ts.date()}  {action:5s} @ {price:,.2f}")

    print("\n" + "=" * 92)
    if total_bar_mm == 0 and total_sig_mm == 0:
        print("RESULT: PARITY CLEAN — the live window and the backtest agree on every")
        print("        overlapping bar and every comparable signal. Live decisions will")
        print("        match backtested decisions given the same data.")
    else:
        print(f"RESULT: DIVERGENCE — {total_bar_mm} bar mismatches, {total_sig_mm} signal mismatches.")
        print("        Do NOT proceed to paper submission until these are explained.")
    return 0 if (total_bar_mm == 0 and total_sig_mm == 0) else 1


if __name__ == "__main__":
    raise SystemExit(main())
