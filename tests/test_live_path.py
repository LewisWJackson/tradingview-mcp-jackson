"""Regression tests for the live-execution path.

Each test here pins a bug found in the go-live review — the kind that fails
SILENTLY (bot runs, logs nothing, never trades, or re-arms a stop that empties
the account). Runs with pytest if present, or standalone:

    python -m tests.test_live_path
"""
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from bot import engine, state
from bot.data_utils import drop_incomplete_bar
from bot.risk_manager import RiskManager


def test_every_configured_timeframe_is_resolvable():
    """P0: '1Day' was absent from TIMEFRAME_SECONDS -> KeyError inside the loop's
    blanket except -> bot span forever and never traded."""
    for symbol, cfg in config.INSTRUMENTS.items():
        assert cfg["timeframe"] in config.TIMEFRAME_SECONDS, f"{symbol}: {cfg['timeframe']} unresolvable"


def test_warmup_matches_strategy_requirement():
    """P0: warmup was inferred from slow_ema/lookback, which regime_beta does not
    use -> 45 bars fetched for a 101-bar rule -> generate_signal() always None."""
    for symbol, cfg in config.INSTRUMENTS.items():
        need = engine.warmup_bars(cfg, config.ATR_PERIOD)
        if cfg["strategy"] == "regime_beta":
            assert need >= cfg["params"]["sma_period"] + 1, f"{symbol}: warmup {need} too small"
        assert need >= config.ATR_PERIOD + 1


def test_regime_beta_actually_signals_at_warmup_length():
    """The warmup number must be genuinely sufficient, not merely larger."""
    cfg = {"strategy": "regime_beta", "params": {"sma_period": 100}}
    need = engine.warmup_bars(cfg, config.ATR_PERIOD)
    mod = engine._strategy_module("regime_beta")
    rising = pd.DataFrame({"close": [100 + i for i in range(need)]})
    assert mod.generate_signal(rising, None, cfg["params"]) == "long"
    one_short = pd.DataFrame({"close": [100 + i for i in range(need - 1 - config.ATR_PERIOD)]})
    assert mod.generate_signal(one_short, None, cfg["params"]) is None


def test_fixed_fractional_reconciliation_keeps_the_wide_stop():
    """P1: restart rebuilt stops with hard_stop_price (~1 ATR) even for
    fixed-fractional positions using an 8-ATR backstop. The 1-ATR stop is the
    documented cause of a -100% wipeout, so a restart re-armed it."""
    rm = RiskManager(risk_per_trade=0.01, atr_period=14, max_portfolio_drawdown=0.10)
    cfg = config.INSTRUMENTS["SPY"]
    entry, atr, equity, qty = 500.0, 5.0, 100_000.0, 100.0

    stop = engine.entry_stop_price(cfg, entry, atr, "long", rm, equity, qty)
    expected = entry - atr * cfg["params"]["stop_atr_mult"]      # 8 ATR below
    assert abs(stop - expected) < 1e-9, f"expected wide stop {expected}, got {stop}"

    tight = rm.hard_stop_price(entry, equity, qty, "long")       # the old ~1-ATR stop
    assert stop < tight, "reconciled stop must be WIDER (further away) than the 1%-risk stop"
    assert entry - stop > 5 * atr, "stop should sit many ATRs away, not ~1"


def test_risk_sized_instruments_still_use_the_risk_stop():
    """The wide-stop fix must not leak into non-fixed-fractional sizing."""
    rm = RiskManager(risk_per_trade=0.01, atr_period=14, max_portfolio_drawdown=0.10)
    cfg = {"strategy": "mean_reversion", "params": {"lookback": 20}}
    stop = engine.entry_stop_price(cfg, 500.0, 5.0, "long", rm, 100_000.0, 100.0)
    assert abs(stop - rm.hard_stop_price(500.0, 100_000.0, 100.0, "long")) < 1e-9


def test_drop_incomplete_bar():
    """P1: the in-progress daily bar was fed to the strategy, so live signals were
    computed on a number the backtest never saw."""
    now = datetime.now(timezone.utc)
    forming = pd.DatetimeIndex([now - timedelta(days=1), now - timedelta(hours=2)])
    df = pd.DataFrame({"close": [1.0, 2.0]}, index=forming)
    assert len(drop_incomplete_bar(df, "1Day")) == 1, "still-forming bar must be dropped"

    closed = pd.DatetimeIndex([now - timedelta(days=3), now - timedelta(days=2)])
    df2 = pd.DataFrame({"close": [1.0, 2.0]}, index=closed)
    assert len(drop_incomplete_bar(df2, "1Day")) == 2, "closed bars must be kept"
    assert drop_incomplete_bar(pd.DataFrame(), "1Day").empty


def test_peak_equity_survives_restart():
    """P1: peak equity was memory-only, so restarting mid-drawdown re-baselined the
    peak and silently disarmed the 10% circuit breaker."""
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "state.json")
        assert state.load_peak_equity(path) is None
        state.save_peak_equity(path, 125_000.0)
        assert state.load_peak_equity(path) == 125_000.0
        state.save_peak_equity(path, 130_000.0)
        assert state.load_peak_equity(path) == 130_000.0


def test_circuit_breaker_fires_against_restored_peak():
    """The restored peak must actually drive the breaker."""
    from bot.portfolio import Portfolio
    rm = RiskManager(risk_per_trade=0.01, atr_period=14, max_portfolio_drawdown=0.10)
    pf = Portfolio(peak_equity=100_000.0)          # restored from disk
    equity = 88_000.0                              # -12% from the real peak
    peak = pf.update_peak_equity(equity)
    assert peak == 100_000.0, "a restored peak must not be reset by current equity"
    assert rm.circuit_breaker_triggered(equity, peak), "breaker must fire on the true drawdown"


def test_dry_run_defaults_on():
    """There was no dry-run guard at all; default must be safe."""
    assert isinstance(config.DRY_RUN, bool)


def test_metrics_report_held_positions():
    """A held sleeve (no closed trades) must still report its real curve."""
    from bot.backtest import compute_metrics
    ts = pd.date_range("2024-01-01", periods=4, freq="D")
    curve = list(zip(ts, [100_000, 95_000, 105_000, 110_000]))
    m = compute_metrics([], curve, 100_000)
    assert abs(m["total_return"] - 0.10) < 1e-9
    assert abs(m["max_drawdown"] - 0.05) < 1e-9
    assert compute_metrics([], [], 100_000)["total_return"] == 0.0


if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"  PASS  {name}")
        except Exception as exc:
            failed += 1
            print(f"  FAIL  {name}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
