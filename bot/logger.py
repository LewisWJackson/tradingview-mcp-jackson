"""CSV trade & daily P&L logging for the live/paper trading loop."""
import csv
import os
from datetime import datetime, timezone

TRADE_FIELDS = ["timestamp", "instrument", "direction", "entry_price", "exit_price", "profit_loss", "position_size"]
PNL_FIELDS = ["date", "equity", "daily_pnl", "daily_pnl_pct"]


def _ensure_header(path, fields):
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        with open(path, "w", newline="") as f:
            csv.DictWriter(f, fieldnames=fields).writeheader()


def log_trade(path, instrument, direction, entry_price, exit_price, profit_loss, position_size):
    _ensure_header(path, TRADE_FIELDS)
    with open(path, "a", newline="") as f:
        csv.DictWriter(f, fieldnames=TRADE_FIELDS).writerow(
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "instrument": instrument,
                "direction": direction,
                "entry_price": entry_price,
                "exit_price": exit_price,
                "profit_loss": profit_loss,
                "position_size": position_size,
            }
        )


def log_daily_pnl(path, equity, daily_pnl, daily_pnl_pct):
    _ensure_header(path, PNL_FIELDS)
    with open(path, "a", newline="") as f:
        csv.DictWriter(f, fieldnames=PNL_FIELDS).writerow(
            {
                "date": datetime.now(timezone.utc).date().isoformat(),
                "equity": equity,
                "daily_pnl": daily_pnl,
                "daily_pnl_pct": daily_pnl_pct,
            }
        )
