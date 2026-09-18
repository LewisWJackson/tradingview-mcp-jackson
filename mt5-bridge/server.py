"""
MT5 bridge server. Runs under the Wine Python installed inside the
MetaTrader 5.app bundled Wine prefix. Exposes the official MetaTrader5
package over a local HTTP/JSON API so the Node MCP server (running
natively on macOS, outside Wine) can talk to a live MT5 terminal.

Started by src/core/mt5.js via: wine C:\Python311\python.exe server.py [port]
"""
import os
import sys
import time
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import MetaTrader5 as mt5

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SCRIPT_DIR, "..", ".env.mt5")
TERMINAL_PATH = r"C:\Program Files\MetaTrader 5\terminal64.exe"
DEFAULT_PORT = 6789

TIMEFRAME_MAP = {
    "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5, "M15": mt5.TIMEFRAME_M15,
    "M30": mt5.TIMEFRAME_M30, "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
    "D1": mt5.TIMEFRAME_D1, "W1": mt5.TIMEFRAME_W1, "MN1": mt5.TIMEFRAME_MN1,
}

ORDER_TYPE_MAP = {
    "buy": mt5.ORDER_TYPE_BUY, "sell": mt5.ORDER_TYPE_SELL,
    "buy_limit": mt5.ORDER_TYPE_BUY_LIMIT, "sell_limit": mt5.ORDER_TYPE_SELL_LIMIT,
    "buy_stop": mt5.ORDER_TYPE_BUY_STOP, "sell_stop": mt5.ORDER_TYPE_SELL_STOP,
}


def load_creds():
    creds = {}
    with open(ENV_PATH, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            creds[k.strip()] = v.strip()
    return creds


def ensure_connected():
    ti = mt5.terminal_info()
    if ti is not None and ti.connected:
        return True
    creds = load_creds()
    return mt5.initialize(
        path=TERMINAL_PATH,
        login=int(creds["MT5_LOGIN"]),
        password=creds["MT5_PASSWORD"],
        server=creds["MT5_SERVER"],
    )


def as_dict(x):
    return x._asdict() if x is not None else None


def as_list(xs):
    return [x._asdict() for x in xs] if xs is not None else []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _send(self, obj, status=200):
        body = json.dumps(obj, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, msg, status=400):
        self._send({"success": False, "error": msg}, status)

    def _body(self):
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw) if raw else {}

    def _require_connected(self):
        if not ensure_connected():
            self._error("mt5 connect failed: %s" % (mt5.last_error(),), 502)
            return False
        return True

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        qs = {k: v[0] for k, v in parse_qs(parsed.query).items()}
        try:
            if path == "/health":
                connected = ensure_connected()
                self._send({
                    "success": True,
                    "connected": connected,
                    "terminal": as_dict(mt5.terminal_info()),
                    "account": as_dict(mt5.account_info()),
                })
                return

            if not self._require_connected():
                return

            if path == "/account":
                self._send({"success": True, "account": as_dict(mt5.account_info())})

            elif path == "/positions":
                symbol = qs.get("symbol")
                positions = mt5.positions_get(symbol=symbol) if symbol else mt5.positions_get()
                self._send({"success": True, "positions": as_list(positions)})

            elif path == "/orders":
                symbol = qs.get("symbol")
                orders = mt5.orders_get(symbol=symbol) if symbol else mt5.orders_get()
                self._send({"success": True, "orders": as_list(orders)})

            elif path == "/quote":
                symbol = qs.get("symbol")
                if not symbol:
                    return self._error("symbol required")
                mt5.symbol_select(symbol, True)
                tick = mt5.symbol_info_tick(symbol)
                if tick is None:
                    return self._error("no tick for %s: %s" % (symbol, mt5.last_error()), 404)
                self._send({"success": True, "quote": as_dict(tick)})

            elif path == "/symbol_info":
                symbol = qs.get("symbol")
                if not symbol:
                    return self._error("symbol required")
                mt5.symbol_select(symbol, True)
                info = mt5.symbol_info(symbol)
                if info is None:
                    return self._error("unknown symbol %s" % symbol, 404)
                self._send({"success": True, "symbol_info": as_dict(info)})

            elif path == "/ohlcv":
                symbol = qs.get("symbol")
                tf = qs.get("timeframe", "M15").upper()
                count = int(qs.get("count", 100))
                if not symbol:
                    return self._error("symbol required")
                if tf not in TIMEFRAME_MAP:
                    return self._error("unknown timeframe %s, use one of %s" % (tf, list(TIMEFRAME_MAP)))
                mt5.symbol_select(symbol, True)
                rates = mt5.copy_rates_from_pos(symbol, TIMEFRAME_MAP[tf], 0, min(count, 5000))
                if rates is None:
                    return self._error("no rates: %s" % (mt5.last_error(),), 404)
                bars = [
                    {
                        "time": int(r["time"]), "open": float(r["open"]), "high": float(r["high"]),
                        "low": float(r["low"]), "close": float(r["close"]),
                        "tick_volume": int(r["tick_volume"]), "spread": int(r["spread"]),
                        "real_volume": int(r["real_volume"]),
                    }
                    for r in rates
                ]
                self._send({"success": True, "symbol": symbol, "timeframe": tf, "bars": bars})

            elif path == "/history_deals":
                days = int(qs.get("days", 7))
                to_t = time.time()
                from_t = to_t - days * 86400
                deals = mt5.history_deals_get(from_t, to_t)
                self._send({"success": True, "deals": as_list(deals)})

            elif path == "/history_orders":
                days = int(qs.get("days", 7))
                to_t = time.time()
                from_t = to_t - days * 86400
                orders = mt5.history_orders_get(from_t, to_t)
                self._send({"success": True, "orders": as_list(orders)})

            else:
                self._error("not found", 404)
        except Exception as e:
            self._error(str(e), 500)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            body = self._body()
            if not self._require_connected():
                return

            if path == "/order":
                symbol = body["symbol"]
                order_type = body["type"]
                volume = float(body["volume"])
                price = body.get("price")
                sl = body.get("sl")
                tp = body.get("tp")
                comment = body.get("comment", "claude-code")
                deviation = int(body.get("deviation", 20))
                dry_run = bool(body.get("dry_run", False))

                if order_type not in ORDER_TYPE_MAP:
                    return self._error("unknown order type %s" % order_type)

                mt5.symbol_select(symbol, True)
                is_market = order_type in ("buy", "sell")
                if is_market:
                    tick = mt5.symbol_info_tick(symbol)
                    if tick is None:
                        return self._error("no tick for %s" % symbol)
                    price = tick.ask if order_type == "buy" else tick.bid
                    action = mt5.TRADE_ACTION_DEAL
                else:
                    if price is None:
                        return self._error("price required for pending orders")
                    action = mt5.TRADE_ACTION_PENDING

                request = {
                    "action": action,
                    "symbol": symbol,
                    "volume": volume,
                    "type": ORDER_TYPE_MAP[order_type],
                    "price": float(price),
                    "deviation": deviation,
                    "comment": comment,
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": mt5.ORDER_FILLING_IOC,
                }
                if sl is not None:
                    request["sl"] = float(sl)
                if tp is not None:
                    request["tp"] = float(tp)

                if dry_run:
                    self._send({"success": True, "dry_run": True, "request": request})
                    return

                result = mt5.order_send(request)
                self._send({
                    "success": result.retcode == mt5.TRADE_RETCODE_DONE,
                    "result": as_dict(result),
                    "request": request,
                })

            elif path == "/position/close":
                ticket = int(body["ticket"])
                volume = body.get("volume")
                positions = mt5.positions_get(ticket=ticket)
                if not positions:
                    return self._error("no open position with ticket %s" % ticket, 404)
                pos = positions[0]
                close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
                tick = mt5.symbol_info_tick(pos.symbol)
                price = tick.bid if close_type == mt5.ORDER_TYPE_SELL else tick.ask
                close_volume = float(volume) if volume else pos.volume
                request = {
                    "action": mt5.TRADE_ACTION_DEAL,
                    "symbol": pos.symbol,
                    "volume": close_volume,
                    "type": close_type,
                    "position": ticket,
                    "price": price,
                    "deviation": 20,
                    "comment": "claude-code-close",
                    "type_time": mt5.ORDER_TIME_GTC,
                    "type_filling": mt5.ORDER_FILLING_IOC,
                }
                result = mt5.order_send(request)
                self._send({"success": result.retcode == mt5.TRADE_RETCODE_DONE, "result": as_dict(result)})

            elif path == "/position/modify":
                ticket = int(body["ticket"])
                sl = body.get("sl")
                tp = body.get("tp")
                positions = mt5.positions_get(ticket=ticket)
                if not positions:
                    return self._error("no open position with ticket %s" % ticket, 404)
                pos = positions[0]
                request = {
                    "action": mt5.TRADE_ACTION_SLTP,
                    "symbol": pos.symbol,
                    "position": ticket,
                    "sl": float(sl) if sl is not None else pos.sl,
                    "tp": float(tp) if tp is not None else pos.tp,
                }
                result = mt5.order_send(request)
                self._send({"success": result.retcode == mt5.TRADE_RETCODE_DONE, "result": as_dict(result)})

            elif path == "/order/cancel":
                ticket = int(body["ticket"])
                request = {"action": mt5.TRADE_ACTION_REMOVE, "order": ticket}
                result = mt5.order_send(request)
                self._send({"success": result.retcode == mt5.TRADE_RETCODE_DONE, "result": as_dict(result)})

            elif path == "/order/modify":
                ticket = int(body["ticket"])
                price = body.get("price")
                sl = body.get("sl")
                tp = body.get("tp")
                orders = mt5.orders_get(ticket=ticket)
                if not orders:
                    return self._error("no pending order with ticket %s" % ticket, 404)
                o = orders[0]
                request = {
                    "action": mt5.TRADE_ACTION_MODIFY,
                    "order": ticket,
                    "price": float(price) if price is not None else o.price_open,
                    "sl": float(sl) if sl is not None else o.sl,
                    "tp": float(tp) if tp is not None else o.tp,
                }
                result = mt5.order_send(request)
                self._send({"success": result.retcode == mt5.TRADE_RETCODE_DONE, "result": as_dict(result)})

            else:
                self._error("not found", 404)
        except Exception as e:
            self._error(str(e), 500)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_PORT
    ok = ensure_connected()
    sys.stderr.write("mt5-bridge: initial connect=%s\n" % ("ok" if ok else "FAILED: %s" % (mt5.last_error(),)))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    sys.stderr.write("mt5-bridge: listening on 127.0.0.1:%d\n" % port)
    server.serve_forever()
