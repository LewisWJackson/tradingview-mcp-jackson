"""Central configuration for the multi-strategy Alpaca trading bot."""
import os

from dotenv import load_dotenv

load_dotenv()

ALPACA_API_KEY = os.getenv("ALPACA_API_KEY", "")
ALPACA_SECRET_KEY = os.getenv("ALPACA_SECRET_KEY", "")
ALPACA_BASE_URL = os.getenv("ALPACA_BASE_URL", "https://paper-api.alpaca.markets")

# Risk management — non-negotiable, applies across every instrument.
RISK_PER_TRADE = 0.01  # 1% of equity risked per trade
ATR_PERIOD = 14
MAX_PORTFOLIO_DRAWDOWN = 0.10  # circuit breaker: flatten everything and halt

# Live-loop bookkeeping
TRADES_LOG_PATH = "trades.csv"
DAILY_PNL_LOG_PATH = "daily_pnl.csv"
LOOP_INTERVAL_SECONDS = 60
STATE_PATH = "bot_state.json"  # peak equity etc., so restarts don't lose drawdown history

# DRY_RUN=True logs the order it WOULD submit and sends nothing. Default True:
# until this session there was no dry-run guard at all in the Python bot — the
# only thing between the code and real orders was ALPACA_BASE_URL. Set the env
# var DRY_RUN=false to actually submit.
DRY_RUN = os.getenv("DRY_RUN", "true").strip().lower() not in ("false", "0", "no")

# Order fill confirmation: how long to wait for a submitted order to fill before
# treating it as failed and rolling the in-memory position back.
ORDER_FILL_TIMEOUT_SECONDS = 60
ORDER_POLL_SECONDS = 2

INSTRUMENTS = {
    # Regime-filtered beta (validated OOS + battle-tested across assets and 123yr):
    # own the asset while it's above its trend SMA, step to cash below it.
    # Fixed-fractional sizing; the regime flip is the real exit, the wide ATR stop
    # is only a disaster backstop. Allocations size combined equity beta (SPY+QQQ,
    # highly correlated) ~= 1x, plus smaller uncorrelated BTC and GLD diversifier
    # sleeves. USO removed: the oil ETF is structurally broken (contango decay,
    # -95% buy&hold drawdown 2010-2026) — no strategy fixes a wealth-destroying
    # instrument. GLD is on regime_beta (clean-data battle test: cuts drawdown,
    # Sharpe up) as an equity-uncorrelated diversifier.
    "SPY": {
        "asset_class": "us_equity",
        "strategy": "regime_beta",
        "timeframe": "1Day",
        "params": {"sma_period": 100, "sizing": "fixed_fractional", "allocation": 0.5, "stop_atr_mult": 8.0},
    },
    "QQQ": {
        "asset_class": "us_equity",
        "strategy": "regime_beta",
        "timeframe": "1Day",
        "params": {"sma_period": 100, "sizing": "fixed_fractional", "allocation": 0.5, "stop_atr_mult": 8.0},
    },
    "BTC/USD": {
        "asset_class": "crypto",
        "strategy": "regime_beta",
        "timeframe": "1Day",
        "params": {"sma_period": 100, "sizing": "fixed_fractional", "allocation": 0.2, "stop_atr_mult": 8.0},
    },
    "GLD": {
        "asset_class": "us_equity",
        "strategy": "regime_beta",
        "timeframe": "1Day",
        "params": {"sma_period": 100, "sizing": "fixed_fractional", "allocation": 0.2, "stop_atr_mult": 8.0},
    },
}

# --- OPTIONAL non-trend sleeve (OFF — enabled, measured, and reverted) ------
# A static buy-and-hold IEF bond-carry sleeve (term premium, corr -0.06 to the
# trend book). Full study + the live-book measurement: docs/NON_TREND_SLEEVE.md.
#
# It WAS enabled at allocation 0.15 and backtested on dividend-adjusted data. On
# the live book the result was effectively a NO-OP: Sharpe +0.00 (48mo) to +0.04
# (since 2007), CAGR +0.2..+0.6pts, while max drawdown AND Calmar got consistently
# WORSE (48mo DD -11.3% -> -11.9%, Calmar 2.60 -> 2.50; gross 1.4x -> 1.55x). It is
# far weaker here than in the risk-parity study because this book ALREADY carries
# GLD and BTC as uncorrelated diversifiers. It does buy real deflationary-bust
# insurance (2008 -4.6% -> -2.2%) at a real inflationary cost (2022 -17.3% -> -19.3%).
#
# Reverted: this book's edge IS drawdown efficiency, and the anchor degrades it for
# a Sharpe gain that rounds to zero. To re-enable, add to INSTRUMENTS:
#
#   "IEF": {
#       "asset_class": "us_equity",
#       "strategy": "buy_hold",
#       "timeframe": "1Day",
#       # small static anchor; never stopped out (wide stop = held forever)
#       "params": {"sizing": "fixed_fractional", "allocation": 0.15, "stop_atr_mult": 999.0},
#   },
#
# NOTE: evaluate any carry/anchor sleeve on DIVIDEND-ADJUSTED data. Alpaca bars are
# unadjusted, and for a bond ETF the coupon IS the return (harness showed IEF at
# -1.5% over 48mo where its true total return was +3.8%).
NON_TREND_SLEEVE_ENABLED = False

# If every symbol in `leaders` is already long, block new long entries on `blocked`.
# Prevents doubling up on correlated risk-on exposure (e.g. SPY + QQQ + BTC all long at once).
CORRELATION_FILTER = [
    {"leaders": ["SPY", "QQQ"], "blocked": ["BTC/USD"], "direction": "long"},
]

TIMEFRAME_SECONDS = {
    "15Min": 15 * 60,
    "1Hour": 60 * 60,
    "4Hour": 4 * 60 * 60,
    # The live book trades daily bars. Its absence here raised KeyError('1Day')
    # inside the loop's blanket except, so the bot span forever and never traded.
    "1Day": 24 * 60 * 60,
}
