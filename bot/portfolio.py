"""Tracks open positions, equity peak, and cross-instrument correlation state."""


class Portfolio:
    def __init__(self, correlation_filter=None, peak_equity=None):
        self.positions = {}
        self.correlation_filter = correlation_filter or []
        # Seeded from the persisted state file on restart so a drawdown in
        # progress is not forgotten (which would disarm the circuit breaker).
        self.peak_equity = peak_equity

    def is_open(self, symbol):
        return symbol in self.positions

    def get(self, symbol):
        return self.positions.get(symbol)

    def open_position(self, symbol, direction, qty, entry_price, stop_price, atr, trailing_atr_mult=None):
        self.positions[symbol] = {
            "direction": direction,
            "qty": qty,
            "entry_price": entry_price,
            "stop_price": stop_price,
            "atr": atr,
            "trailing_atr_mult": trailing_atr_mult,
        }

    def close_position(self, symbol):
        return self.positions.pop(symbol, None)

    def update_peak_equity(self, equity):
        if self.peak_equity is None or equity > self.peak_equity:
            self.peak_equity = equity
        return self.peak_equity

    def blocks_new_position(self, symbol, direction):
        """True if a correlation rule forbids opening `direction` on `symbol` right now."""
        for rule in self.correlation_filter:
            if symbol not in rule["blocked"] or direction != rule["direction"]:
                continue
            leaders_aligned = all(
                self.is_open(leader) and self.positions[leader]["direction"] == rule["direction"]
                for leader in rule["leaders"]
            )
            if leaders_aligned:
                return True
        return False

    def flatten_all(self):
        symbols = list(self.positions.keys())
        for symbol in symbols:
            self.close_position(symbol)
        return symbols
