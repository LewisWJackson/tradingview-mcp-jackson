"""Continuous multi-strategy trading loop against the Alpaca API.

Checks each instrument at its own timeframe cadence, evaluates the shared
decision engine, submits orders, logs every fill to trades.csv, and logs
equity once per day to daily_pnl.csv. A 10% portfolio drawdown from peak
flattens everything and halts the loop until a human reviews it.
"""
import time
import traceback
from datetime import datetime, timezone

import config
from . import data_utils
from . import engine
from . import logger
from . import state
from .portfolio import Portfolio
from .risk_manager import RiskManager, calculate_atr


def _round_qty(asset_class, qty):
    if asset_class == "crypto":
        return round(qty, 6)
    return max(int(qty), 0)


def _submit_order(api, symbol, asset_class, qty, direction):
    """Submit a market order and WAIT for it to fill.

    Returns (filled_qty, avg_fill_price) on success, or None if the order was
    rejected/expired/timed out. Callers must roll back in-memory state on None:
    the engine records the position before the order is sent, so a silent
    rejection would otherwise leave the bot managing a position it does not own.
    """
    side = "buy" if direction == "long" else "sell"
    broker_symbol = data_utils.BROKER_SYMBOLS[symbol]

    if config.DRY_RUN:
        # Report the intended order and treat it as filled at the signal price, so
        # the loop's state machine stays coherent while nothing reaches the broker.
        print(f"  DRY_RUN — would submit {side} {qty} {broker_symbol} (market). Nothing sent.")
        return qty, None

    order = api.submit_order(
        symbol=broker_symbol,
        qty=qty,
        side=side,
        type="market",
        time_in_force="gtc" if asset_class == "crypto" else "day",
    )

    deadline = time.time() + config.ORDER_FILL_TIMEOUT_SECONDS
    while time.time() < deadline:
        try:
            o = api.get_order(order.id)
        except Exception:
            traceback.print_exc()
            time.sleep(config.ORDER_POLL_SECONDS)
            continue

        status = getattr(o, "status", "")
        if status == "filled":
            return float(o.filled_qty), float(o.filled_avg_price)
        if status in ("rejected", "canceled", "expired"):
            print(f"  ORDER {status.upper()}: {side} {qty} {broker_symbol}")
            return None
        time.sleep(config.ORDER_POLL_SECONDS)

    print(f"  ORDER TIMEOUT after {config.ORDER_FILL_TIMEOUT_SECONDS}s: {side} {qty} {broker_symbol}; cancelling")
    try:
        api.cancel_order(order.id)
    except Exception:
        traceback.print_exc()
    return None


def _account_equity(api):
    return float(api.get_account().equity)


def _reconcile_open_positions(api, portfolio, risk_manager):
    """Rebuild in-memory position state from the broker on startup.

    Stops are rebuilt through engine.entry_stop_price so they match whatever the
    instrument's sizing mode implies. This previously used hard_stop_price
    unconditionally (~1 ATR) even for fixed-fractional positions that trade an
    8-ATR backstop — so every restart re-armed the tight stop that this project
    already traced to a -100% wipeout, and normal noise would flush the book.
    """
    try:
        broker_positions = api.list_positions()
    except Exception:
        traceback.print_exc()
        return

    equity = _account_equity(api)
    for pos in broker_positions:
        symbol = data_utils.FROM_BROKER_SYMBOL.get(pos.symbol)
        if symbol is None:
            continue
        instrument_cfg = config.INSTRUMENTS[symbol]
        direction = "long" if float(pos.qty) > 0 else "short"
        entry_price = float(pos.avg_entry_price)
        qty = abs(float(pos.qty))

        # ATR is required to rebuild a fixed-fractional stop, so fetch real bars.
        atr = None
        try:
            df = data_utils.fetch_recent_bars(
                api, symbol, instrument_cfg["asset_class"], instrument_cfg["timeframe"],
                engine.warmup_bars(instrument_cfg, config.ATR_PERIOD),
            )
            if not df.empty:
                atr = calculate_atr(df, period=config.ATR_PERIOD).iloc[-1]
        except Exception:
            traceback.print_exc()

        stop_price = engine.entry_stop_price(
            instrument_cfg, entry_price, atr, direction, risk_manager, equity, qty
        )
        trailing_mult = instrument_cfg["params"].get("trailing_atr_mult")
        portfolio.open_position(symbol, direction, qty, entry_price, stop_price, atr=atr, trailing_atr_mult=trailing_mult)
        print(f"Reconciled broker position: {symbol} {direction} qty={qty} entry={entry_price} stop={stop_price}")


def run():
    api = data_utils.get_api()
    portfolio = Portfolio(
        correlation_filter=config.CORRELATION_FILTER,
        peak_equity=state.load_peak_equity(config.STATE_PATH),
    )
    risk_manager = RiskManager(
        risk_per_trade=config.RISK_PER_TRADE,
        atr_period=config.ATR_PERIOD,
        max_portfolio_drawdown=config.MAX_PORTFOLIO_DRAWDOWN,
    )

    _reconcile_open_positions(api, portfolio, risk_manager)

    last_checked = {symbol: 0.0 for symbol in config.INSTRUMENTS}
    day_start_equity = _account_equity(api)
    current_date = datetime.now(timezone.utc).date()
    halted = False

    mode = "DRY RUN (no orders will be sent)" if config.DRY_RUN else "LIVE ORDER SUBMISSION"
    print(f"[{datetime.now(timezone.utc).isoformat()}] Trading bot starting on {config.ALPACA_BASE_URL}")
    print(f"  MODE: {mode}")
    if portfolio.peak_equity is not None:
        print(f"  Restored peak equity {portfolio.peak_equity:.2f} from {config.STATE_PATH}")

    while not halted:
        try:
            equity = _account_equity(api)
            previous_peak = portfolio.peak_equity
            peak_equity = portfolio.update_peak_equity(equity)
            if peak_equity != previous_peak:
                state.save_peak_equity(config.STATE_PATH, peak_equity)

            if risk_manager.circuit_breaker_triggered(equity, peak_equity):
                print(f"CIRCUIT BREAKER: drawdown from peak {peak_equity:.2f} to {equity:.2f}. Flattening all positions.")
                for symbol in portfolio.flatten_all():
                    try:
                        api.close_position(data_utils.BROKER_SYMBOLS[symbol])
                    except Exception:
                        traceback.print_exc()
                halted = True
                break

            today = datetime.now(timezone.utc).date()
            if today != current_date:
                daily_pnl = equity - day_start_equity
                daily_pnl_pct = daily_pnl / day_start_equity if day_start_equity else 0.0
                logger.log_daily_pnl(config.DAILY_PNL_LOG_PATH, equity, daily_pnl, daily_pnl_pct)
                day_start_equity = equity
                current_date = today

            now = time.time()
            for symbol, instrument_cfg in config.INSTRUMENTS.items():
                asset_class = instrument_cfg["asset_class"]
                timeframe_name = instrument_cfg["timeframe"]
                interval = config.TIMEFRAME_SECONDS[timeframe_name]

                if now - last_checked[symbol] < interval:
                    continue
                if not data_utils.is_market_open(api, asset_class):
                    continue

                last_checked[symbol] = now

                # Ask the strategy how much history it needs. Inferring this from
                # param names under-fetched badly for regime_beta (45 vs 101 bars),
                # so generate_signal returned None forever and the bot never traded.
                bars_needed = engine.warmup_bars(instrument_cfg, config.ATR_PERIOD)
                df = data_utils.fetch_recent_bars(api, symbol, asset_class, timeframe_name, bars_needed)
                if len(df) < bars_needed:
                    print(f"  {symbol}: only {len(df)} closed bars, need {bars_needed} — skipping")
                    continue

                result = engine.evaluate(symbol, instrument_cfg, df, portfolio, risk_manager, equity)
                if result is None:
                    continue

                print(f"[{datetime.now(timezone.utc).isoformat()}] {symbol}: {result}")

                if result["action"] == "open":
                    qty = _round_qty(asset_class, result["qty"])
                    if qty <= 0:
                        portfolio.close_position(symbol)
                        continue
                    fill = _submit_order(api, symbol, asset_class, qty, result["direction"])
                    if fill is None:
                        # Order never filled — the engine already recorded this
                        # position, so drop it or the bot manages a phantom holding.
                        portfolio.close_position(symbol)
                        print(f"  {symbol}: entry not filled, in-memory position rolled back")
                        continue
                    filled_qty, fill_price = fill
                    position = portfolio.get(symbol)
                    if position is not None:
                        position["qty"] = filled_qty
                        if fill_price:   # record the real fill, not the signal-bar close
                            position["entry_price"] = fill_price

                elif result["action"] in ("exit", "stop"):
                    position = result["position"]
                    close_direction = "short" if position["direction"] == "long" else "long"
                    qty = _round_qty(asset_class, position["qty"])
                    if qty > 0:
                        closed = _submit_order(api, symbol, asset_class, qty, close_direction)
                        if closed is None:
                            # Exit did not fill: restore the position so the bot keeps
                            # managing (and retrying) it rather than going blind.
                            portfolio.open_position(
                                symbol, position["direction"], position["qty"], position["entry_price"],
                                position["stop_price"], position.get("atr"), position.get("trailing_atr_mult"),
                            )
                            print(f"  {symbol}: EXIT NOT FILLED — position restored, will retry")
                            continue
                        if closed[1]:
                            result["price"] = closed[1]   # log the real exit fill
                    profit_loss = (
                        (result["price"] - position["entry_price"]) * position["qty"]
                        if position["direction"] == "long"
                        else (position["entry_price"] - result["price"]) * position["qty"]
                    )
                    logger.log_trade(
                        config.TRADES_LOG_PATH,
                        symbol,
                        position["direction"],
                        position["entry_price"],
                        result["price"],
                        profit_loss,
                        position["qty"],
                    )

        except Exception:
            traceback.print_exc()

        time.sleep(config.LOOP_INTERVAL_SECONDS)


if __name__ == "__main__":
    run()
