"""
Kraken Pro Volume Profile Bot — Patrick Nill MSE System
========================================================
Strategy : Nill MSE (Market Structure → Support/Resistance → Entry trigger)
  M — Market Structure  : close > SMA200 on 15m = bullish macro bias
  S — Support/Resistance: previous 24H Volume Profile zones (POC / VAH / VAL)
                          "Business Zones" where institutions transacted
  E — Entry trigger     : price touches VAL zone + bullish bar close
                          + volume spike (1.5× MA) + RSI 30–70

Exchange  : Kraken Pro (spot EUR pairs, no leverage — BaFin compliant)
Timeframe : 15m candles
Pairs     : BTC/EUR, ETH/EUR, SOL/EUR
VP Session: previous 96 × 15m bars = 24H rolling Volume Profile
Entry     : price within zone_tolerance% of VAL, bar closes bullish
Stop      : VAL − 1.5 × ATR (structural invalidation below the zone)
Management:
  Phase 1 (price < POC) : hold initial stop
  Phase 2 (price ≥ POC) : move stop to breakeven, trail at ATR×3
  Phase 3 (price ≥ VAH) : tighten trail to ATR×2
Paper     : Default ON — set PAPER_TRADE=false in .env to go live

Dependencies:
  pip install ccxt pandas numpy python-dotenv requests

Windows compat:
  No fcntl — PID lock uses os.kill(pid, 0)
  UTF-8 stdout reconfigured (fixes cp932 on Japanese Windows)

Database  : kraken_vp_bot.db (SQLite, WAL mode)
Log       : kraken_vp_bot.log
"""

import os
import sys
import time
import sqlite3
import logging
import argparse
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import ccxt
import numpy as np
import pandas as pd
from dotenv import load_dotenv
import requests

# ─────────────────────────────────────────────────────────────
# 0.  PATHS & LOGGING
# ─────────────────────────────────────────────────────────────
BASE_DIR  = Path(__file__).parent
DB_PATH   = BASE_DIR / "kraken_vp_bot.db"
LOG_PATH  = BASE_DIR / "kraken_vp_bot.log"
LOCK_PATH = BASE_DIR / "kraken_vp_bot.pid"

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except AttributeError:
    pass  # non-reconfigurable stream (piped)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    handlers=[
        logging.FileHandler(LOG_PATH, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ],
)
log = logging.getLogger("kraken-vp")


# ─────────────────────────────────────────────────────────────
# 1.  LOCK (Windows-compatible, no fcntl)
# ─────────────────────────────────────────────────────────────
def acquire_lock():
    if LOCK_PATH.exists():
        try:
            old_pid = int(LOCK_PATH.read_text().strip())
            os.kill(old_pid, 0)          # OSError if process is dead
            log.critical(f"Already running PID {old_pid}. Exiting.")
            sys.exit(1)
        except (ValueError, OSError):
            pass                         # stale lock — overwrite
    LOCK_PATH.write_text(str(os.getpid()))


def release_lock():
    LOCK_PATH.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────
# 2.  ENVIRONMENT & CONFIG
# ─────────────────────────────────────────────────────────────
load_dotenv(BASE_DIR / ".env")

KRAKEN_API_KEY    = os.getenv("KRAKEN_API_KEY", "")
KRAKEN_SECRET_KEY = os.getenv("KRAKEN_SECRET_KEY", "")
TELEGRAM_TOKEN    = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID  = os.getenv("TELEGRAM_CHAT_ID", "")
PAPER_TRADE       = os.getenv("PAPER_TRADE", "true").lower() != "false"

CFG = {
    # ── Pairs (Kraken EUR spot) ───────────────────────────────
    "pairs": ["BTC/EUR", "ETH/EUR", "SOL/EUR"],

    # ── Timeframe ─────────────────────────────────────────────
    "timeframe":    "15m",
    "candle_limit": 320,           # 320 × 15m ≈ 80H — covers SMA200 + VP session

    # ── Volume Profile ────────────────────────────────────────
    "session_bars":      96,       # 96 × 15m = 24H rolling VP session
    "vp_bins":           120,      # price level resolution
    "value_area_pct":    0.70,     # 70% of volume = Value Area
    "zone_tolerance_pct": 0.50,   # price within 0.5% of VAL = "at the zone"

    # ── Trend filter ──────────────────────────────────────────
    "sma_trend_window": 200,       # SMA200 on 15m ≈ 50H macro trend

    # ── Volume gate ───────────────────────────────────────────
    "vol_ma_window":  20,
    "vol_min_ratio":  1.5,         # volume must be ≥ 1.5× its 20-bar MA

    # ── RSI ───────────────────────────────────────────────────
    "rsi_period": 14,
    "rsi_min":    30,              # not in free-fall
    "rsi_max":    70,              # not overbought

    # ── ATR ───────────────────────────────────────────────────
    "atr_window":      14,
    "atr_stop_mult":   1.5,        # stop = VAL − 1.5 × ATR
    "atr_trail_mult":  3.0,        # trail multiplier once price above POC
    "atr_tight_mult":  2.0,        # tighter trail once price above VAH

    # ── Position sizing ───────────────────────────────────────
    "base_invest_frac":  0.68,     # fraction of capital as base allocation
    "profit_reinvest":   0.65,     # 65% of profit gets reinvested
    "max_risk_per_trade": 0.015,   # max 1.5% capital loss per stop-out
    "initial_capital":   30.0,     # EUR starting capital
    "min_order_eur":     5.0,      # minimum order size

    # ── Risk management ───────────────────────────────────────
    "max_positions":   3,          # max simultaneous open positions
    "dd_warning_pct":  0.15,       # 15% per-pair DD → halve sizing
    "dd_pause_pct":    0.23,       # 23% per-pair DD → no new entries
    "global_dd_pause": 0.20,       # 20% portfolio DD → no new entries at all
    "cooldown_bars":   4,          # bars to wait after a loss

    # ── Fees (Kraken Pro taker) ───────────────────────────────
    "fee_rate": 0.0026,            # 0.26% taker — conservative estimate

    # ── Timing ───────────────────────────────────────────────
    "poll_seconds": 30,            # main loop sleep between full scans
}


# ─────────────────────────────────────────────────────────────
# 3.  DATABASE
# ─────────────────────────────────────────────────────────────
class DB:
    """SQLite persistence — thread-safe WAL mode, single persistent connection.

    Extra fields vs bot_v5:
      poc_price, vah_price, val_price — stored at entry to track position vs zones
      tp1_hit  — 1 once price reaches POC (breakeven stop activated)
    """

    def __init__(self):
        self._lock = threading.Lock()
        self._con  = sqlite3.connect(
            str(DB_PATH),
            check_same_thread=False,
            detect_types=sqlite3.PARSE_DECLTYPES,
        )
        self._con.row_factory = sqlite3.Row
        self._con.execute("PRAGMA journal_mode=WAL")
        self._init()

    def _init(self):
        with self._lock:
            self._con.executescript("""
                CREATE TABLE IF NOT EXISTS positions (
                    pair            TEXT    PRIMARY KEY,
                    in_position     INTEGER NOT NULL DEFAULT 0,
                    entry_price     REAL    DEFAULT 0,
                    position_units  REAL    DEFAULT 0,
                    highest_price   REAL    DEFAULT 0,
                    stop_loss       REAL    DEFAULT 0,
                    entry_time      TEXT    DEFAULT '',
                    invest_eur      REAL    DEFAULT 0,
                    bars_since_loss INTEGER DEFAULT 0,
                    current_capital REAL    DEFAULT 0,
                    peak_equity     REAL    DEFAULT 0,
                    dd_warned       INTEGER DEFAULT 0,
                    poc_price       REAL    DEFAULT 0,
                    vah_price       REAL    DEFAULT 0,
                    val_price       REAL    DEFAULT 0,
                    tp1_hit         INTEGER DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS trades (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts          DATETIME DEFAULT (datetime('now')),
                    pair        TEXT     NOT NULL,
                    side        TEXT     NOT NULL,
                    units       REAL     NOT NULL,
                    price       REAL     NOT NULL,
                    invest_eur  REAL     NOT NULL,
                    net_pnl_pct REAL     DEFAULT 0,
                    exit_reason TEXT     DEFAULT '',
                    paper       INTEGER  NOT NULL DEFAULT 1
                );
            """)
        log.info(f"Database ready: {DB_PATH.name}")

    def get_position(self, pair: str) -> dict:
        with self._lock:
            row = self._con.execute(
                "SELECT * FROM positions WHERE pair=?", (pair,)
            ).fetchone()
        if row is None:
            default = {
                "pair":            pair,
                "in_position":     0,
                "entry_price":     0.0,
                "position_units":  0.0,
                "highest_price":   0.0,
                "stop_loss":       0.0,
                "entry_time":      "",
                "invest_eur":      0.0,
                "bars_since_loss": 0,
                "current_capital": CFG["initial_capital"],
                "peak_equity":     CFG["initial_capital"],
                "dd_warned":       0,
                "poc_price":       0.0,
                "vah_price":       0.0,
                "val_price":       0.0,
                "tp1_hit":         0,
            }
            self.save_position(default)
            return default
        return dict(row)

    def save_position(self, pos: dict):
        with self._lock:
            self._con.execute("""
                INSERT INTO positions
                    (pair, in_position, entry_price, position_units,
                     highest_price, stop_loss, entry_time, invest_eur,
                     bars_since_loss, current_capital, peak_equity, dd_warned,
                     poc_price, vah_price, val_price, tp1_hit)
                VALUES
                    (:pair, :in_position, :entry_price, :position_units,
                     :highest_price, :stop_loss, :entry_time, :invest_eur,
                     :bars_since_loss, :current_capital, :peak_equity, :dd_warned,
                     :poc_price, :vah_price, :val_price, :tp1_hit)
                ON CONFLICT(pair) DO UPDATE SET
                    in_position     = excluded.in_position,
                    entry_price     = excluded.entry_price,
                    position_units  = excluded.position_units,
                    highest_price   = excluded.highest_price,
                    stop_loss       = excluded.stop_loss,
                    entry_time      = excluded.entry_time,
                    invest_eur      = excluded.invest_eur,
                    bars_since_loss = excluded.bars_since_loss,
                    current_capital = excluded.current_capital,
                    peak_equity     = excluded.peak_equity,
                    dd_warned       = excluded.dd_warned,
                    poc_price       = excluded.poc_price,
                    vah_price       = excluded.vah_price,
                    val_price       = excluded.val_price,
                    tp1_hit         = excluded.tp1_hit
            """, {**pos, "tp1_hit": pos.get("tp1_hit", 0)})
            self._con.commit()

    def log_trade(
        self,
        pair: str,
        side: str,
        units: float,
        price: float,
        invest_eur: float,
        net_pnl_pct: float = 0.0,
        exit_reason: str = "",
        paper: bool = True,
    ):
        with self._lock:
            self._con.execute("""
                INSERT INTO trades
                    (pair, side, units, price, invest_eur, net_pnl_pct, exit_reason, paper)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (pair, side, units, price, invest_eur,
                  net_pnl_pct, exit_reason, int(paper)))
            self._con.commit()

    def count_open_positions(self) -> int:
        with self._lock:
            row = self._con.execute(
                "SELECT COUNT(*) FROM positions WHERE in_position=1"
            ).fetchone()
        return row[0] if row else 0

    def total_portfolio_equity(self) -> tuple[float, float]:
        with self._lock:
            row = self._con.execute(
                "SELECT SUM(current_capital), SUM(peak_equity) FROM positions"
            ).fetchone()
        return (row[0] or 0.0), (row[1] or 0.0)


# ─────────────────────────────────────────────────────────────
# 4.  CANDLE FETCHER (Kraken via ccxt)
# ─────────────────────────────────────────────────────────────
class CandleFetcher:
    """Fetches OHLCV from Kraken via ccxt with 3× retry + exponential backoff.

    The same exchange instance is shared with KrakenTrader so we
    benefit from ccxt's built-in rate-limiter (enableRateLimit=True).
    """

    def __init__(self):
        self.exchange = ccxt.kraken({
            "apiKey":          KRAKEN_API_KEY,
            "secret":          KRAKEN_SECRET_KEY,
            "enableRateLimit": True,
        })

    def get_candles(self, symbol: str) -> Optional[pd.DataFrame]:
        backoff = 2
        for attempt in range(1, 4):
            try:
                bars = self.exchange.fetch_ohlcv(
                    symbol,
                    CFG["timeframe"],
                    limit=CFG["candle_limit"],
                )
                if not bars:
                    log.warning(f"{symbol}: empty OHLCV response.")
                    return None

                df = pd.DataFrame(
                    bars,
                    columns=["ts", "open", "high", "low", "close", "volume"],
                )
                df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
                df = df.set_index("ts").sort_index()
                for col in ("open", "high", "low", "close", "volume"):
                    df[col] = pd.to_numeric(df[col])

                log.debug(
                    f"{symbol}: fetched {len(df)} bars "
                    f"(latest close: {df['close'].iloc[-1]:.4f})"
                )
                return df

            except Exception as e:
                if attempt < 3:
                    log.warning(
                        f"{symbol}: fetch error (attempt {attempt}/3) — {e}. "
                        f"Retry in {backoff}s..."
                    )
                    time.sleep(backoff)
                    backoff *= 2
                else:
                    log.error(f"{symbol}: fetch failed after 3 attempts — {e}")
                    return None


# ─────────────────────────────────────────────────────────────
# 5.  VOLUME PROFILE ENGINE
# ─────────────────────────────────────────────────────────────
class VolumeProfileEngine:
    """Calculates Volume Profile from OHLCV using proportional volume distribution.

    For each candle, volume is distributed uniformly across the bar's high-low
    range into price bins. This approximates the true price-at-volume histogram
    that Nill reads on his Footprint / Volume Profile charts.

    Returns: (poc_price, vah_price, val_price)
      POC = Point of Control   — price level with the most traded volume
      VAH = Value Area High    — upper edge of the 70% volume zone
      VAL = Value Area Low     — lower edge of the 70% volume zone
    """

    def calculate(
        self,
        df: pd.DataFrame,
        bins: int = None,
        value_area_pct: float = None,
    ) -> Optional[tuple[float, float, float]]:
        bins          = bins          or CFG["vp_bins"]
        value_area_pct = value_area_pct or CFG["value_area_pct"]

        if df is None or len(df) < 10:
            return None

        price_min = df["low"].min()
        price_max = df["high"].max()

        if price_max <= price_min:
            return None

        # Price level boundaries — bins+1 edges define bins intervals
        levels = np.linspace(price_min, price_max, bins + 1)
        vol_at = np.zeros(bins)

        for _, row in df.iterrows():
            lo, hi, vol = float(row["low"]), float(row["high"]), float(row["volume"])
            bar_range = hi - lo

            if bar_range < 1e-10:
                # Zero-range doji: assign all volume to the nearest bin
                idx = int((lo - price_min) / (price_max - price_min) * (bins - 1))
                idx = max(0, min(bins - 1, idx))
                vol_at[idx] += vol
                continue

            # Distribute volume proportionally to bin overlap with bar range
            for i in range(bins):
                overlap_lo = max(lo, levels[i])
                overlap_hi = min(hi, levels[i + 1])
                if overlap_hi > overlap_lo:
                    vol_at[i] += vol * (overlap_hi - overlap_lo) / bar_range

        # POC: bin with the highest accumulated volume
        poc_idx   = int(np.argmax(vol_at))
        poc_price = (levels[poc_idx] + levels[poc_idx + 1]) / 2.0

        # Value Area: expand outward from POC until value_area_pct is covered
        total_vol  = vol_at.sum()
        if total_vol == 0:
            return None
        target_vol = total_vol * value_area_pct

        va_lo = poc_idx
        va_hi = poc_idx
        va_vol = vol_at[poc_idx]

        while va_vol < target_vol:
            can_up   = va_hi + 1 < bins
            can_down = va_lo - 1 >= 0
            if not can_up and not can_down:
                break

            vol_up   = vol_at[va_hi + 1] if can_up   else -1.0
            vol_down = vol_at[va_lo - 1] if can_down else -1.0

            # Always expand toward the higher-volume side first (Nill's rule)
            if vol_up >= vol_down:
                va_hi += 1
                va_vol += vol_at[va_hi]
            else:
                va_lo -= 1
                va_vol += vol_at[va_lo]

        vah_price = float(levels[va_hi + 1])
        val_price = float(levels[va_lo])

        return poc_price, vah_price, val_price


# ─────────────────────────────────────────────────────────────
# 6.  INDICATOR ENGINE
# ─────────────────────────────────────────────────────────────
class IndicatorEngine:
    """Pure pandas/numpy indicators for 15m bars.

    Returns {"live": {...}, "closed": {...}}
      live   = bar[-1]  (forming, for live price checks)
      closed = bar[-2]  (last confirmed closed bar — signals use this only)

    Indicators: SMA200 (trend), ATR14, RSI14, Volume MA20.
    """

    MIN_BARS = CFG["sma_trend_window"] + 15  # 215 — ensures SMA200 is valid

    def calculate(self, df: pd.DataFrame) -> Optional[dict]:
        if df is None or len(df) < self.MIN_BARS:
            log.warning(
                f"Not enough bars for indicators "
                f"(have {len(df) if df is not None else 0}, need {self.MIN_BARS})"
            )
            return None

        close  = df["close"]
        high   = df["high"]
        low    = df["low"]
        volume = df["volume"]

        # SMA200 — macro trend filter
        sma200 = close.rolling(window=CFG["sma_trend_window"]).mean()

        # ATR (True Range, simple rolling mean — no EWM, matches Nill's plain ATR)
        prev_close = close.shift(1)
        tr = pd.concat([
            high - low,
            (high - prev_close).abs(),
            (low  - prev_close).abs(),
        ], axis=1).max(axis=1)
        atr = tr.rolling(window=CFG["atr_window"]).mean()

        # RSI14 (simple rolling mean of gains/losses)
        delta    = close.diff()
        gain     = delta.clip(lower=0)
        loss     = (-delta).clip(lower=0)
        avg_gain = gain.rolling(window=CFG["rsi_period"]).mean()
        avg_loss = loss.rolling(window=CFG["rsi_period"]).mean()
        rs       = avg_gain / avg_loss.replace(0, np.nan)
        rsi      = 100.0 - (100.0 / (1.0 + rs))

        # Volume MA20
        vol_ma = volume.rolling(window=CFG["vol_ma_window"]).mean()

        def _bar(i: int) -> dict:
            return {
                "ts":     df.index[i],
                "open":   float(df["open"].iloc[i]),
                "high":   float(high.iloc[i]),
                "low":    float(low.iloc[i]),
                "close":  float(close.iloc[i]),
                "volume": float(volume.iloc[i]),
                "sma200": float(sma200.iloc[i]) if not pd.isna(sma200.iloc[i]) else None,
                "atr":    float(atr.iloc[i])    if not pd.isna(atr.iloc[i])    else None,
                "rsi":    float(rsi.iloc[i])    if not pd.isna(rsi.iloc[i])    else None,
                "vol_ma": float(vol_ma.iloc[i]) if not pd.isna(vol_ma.iloc[i]) else None,
            }

        return {"live": _bar(-1), "closed": _bar(-2)}


# ─────────────────────────────────────────────────────────────
# 7.  SIGNAL ENGINE
# ─────────────────────────────────────────────────────────────
class SignalEngine:
    """Entry and sizing logic — Nill MSE translated to hard math.

    Entry gates (all must pass, evaluated on the last CLOSED 15m bar):
      M  close > SMA200                     — bullish macro
      S  price within zone_tolerance of VAL — at the Business Zone
         price must be ≤ POC               — true pullback, not breakout
      E1 close > open                       — bullish rejection bar
      E2 volume ≥ 1.5 × vol_ma             — institutional footprint
      E3 RSI in [30, 70]                    — momentum valid, not extreme
      +  portfolio guards (max_positions, DD, cooldown)
    """

    def _dd_now(self, pos: dict) -> float:
        peak = pos.get("peak_equity") or CFG["initial_capital"]
        cap  = pos.get("current_capital", CFG["initial_capital"])
        return max(0.0, (peak - cap) / peak) if peak > 0 else 0.0

    def entry_signal(
        self,
        closed: dict,
        vp_zones: Optional[tuple],
        open_positions: int,
        global_dd: float,
        pos: dict,
    ) -> tuple[bool, str]:
        """Returns (True, 'ok') or (False, reason_string)."""

        # All required indicators must be present
        required = ("close", "open", "sma200", "atr", "rsi", "volume", "vol_ma")
        if any(closed.get(k) is None for k in required):
            return False, "missing_indicators"

        if vp_zones is None:
            return False, "no_vp_zones"

        poc, vah, val = vp_zones

        # ── Portfolio guards ──────────────────────────────────
        if open_positions >= CFG["max_positions"]:
            return False, "max_positions"
        if global_dd >= CFG["global_dd_pause"]:
            return False, "global_dd_pause"
        if self._dd_now(pos) >= CFG["dd_pause_pct"]:
            return False, "pair_dd_pause"
        if pos.get("bars_since_loss", 0) < CFG["cooldown_bars"]:
            return False, "cooldown"

        c = closed

        # ── M: Macro trend bullish ────────────────────────────
        if c["close"] <= c["sma200"]:
            return False, "below_sma200"

        # ── S: Price at Value Area Low (Business Zone support) ─
        tol = CFG["zone_tolerance_pct"] / 100.0
        at_zone = (
            abs(c["close"] - val) / val <= tol   # touching VAL from above
            or c["close"] < val                   # briefly dipped below VAL
        )
        if not at_zone:
            return False, "not_at_zone"

        # Price must be at or below POC (pullback trade, not a breakout)
        if c["close"] > poc:
            return False, "price_above_poc"

        # ── E: Entry triggers ─────────────────────────────────
        # E1: Bullish bar — buyers absorbed sellers at the zone
        if c["close"] <= c["open"]:
            return False, "bearish_bar"

        # E2: Volume spike — institutional footprint at the zone
        if c["volume"] < c["vol_ma"] * CFG["vol_min_ratio"]:
            return False, "low_volume"

        # E3: RSI in healthy range — momentum confirms, not extreme
        if not (CFG["rsi_min"] <= c["rsi"] <= CFG["rsi_max"]):
            return False, "rsi_out_of_range"

        return True, "ok"

    def invest_amount(
        self,
        closed: dict,
        pos: dict,
        vp_zones: tuple,
    ) -> float:
        """Dynamic position size capped by ATR risk at the zone stop.

        Base formula:
          base = initial_capital + profit × profit_reinvest
          raw  = min(base, capital × base_invest_frac) × dd_scale

        ATR risk cap:
          stop_dist = entry_price − (VAL − atr_stop_mult × ATR)
          risk_eur  = capital × max_risk_per_trade
          risk_based = risk_eur / stop_dist × entry_price
          final = min(raw, risk_based)

        Wide stops (high ATR, price far from VAL) → smaller lot.
        Tight stops (small ATR, price on VAL) → approaches base formula.
        """
        dd      = self._dd_now(pos)
        cap     = pos.get("current_capital", CFG["initial_capital"])
        initial = CFG["initial_capital"]

        dd_scale = 0.5 if dd >= CFG["dd_warning_pct"] else 1.0
        if dd_scale < 1.0:
            log.info(
                f"  invest_amount: DD={dd:.1%} >= warning threshold "
                f"({CFG['dd_warning_pct']:.0%}) — sizing halved."
            )

        profit = max(0.0, cap - initial)
        base   = initial + profit * CFG["profit_reinvest"]
        raw    = min(base, cap * CFG["base_invest_frac"]) * dd_scale

        # ATR risk-based cap
        atr = closed.get("atr")
        if atr and vp_zones:
            _, _, val = vp_zones
            stop_price = max(val - atr * CFG["atr_stop_mult"], 0.0)
            stop_dist  = closed["close"] - stop_price
            if stop_dist > 1e-8:
                risk_eur   = cap * CFG["max_risk_per_trade"]
                risk_units = risk_eur / stop_dist
                risk_based = risk_units * closed["close"]
                if risk_based < raw:
                    log.info(
                        f"  invest_amount: risk-based cap {risk_based:.2f} EUR "
                        f"< formula {raw:.2f} EUR — applying risk cap."
                    )
                raw = min(raw, risk_based)

        return max(0.0, min(raw, cap - CFG["min_order_eur"]))


# ─────────────────────────────────────────────────────────────
# 8.  KRAKEN TRADER
# ─────────────────────────────────────────────────────────────
class KrakenTrader:
    """Wraps ccxt Kraken — real spot orders or paper-trade simulation."""

    def __init__(self, exchange: ccxt.kraken):
        self.exchange = exchange

    def get_price(self, symbol: str) -> Optional[float]:
        try:
            ticker = self.exchange.fetch_ticker(symbol)
            return float(ticker["last"])
        except Exception as e:
            log.error(f"get_price {symbol}: {e}")
            return None

    def get_balance(self, currency: str) -> float:
        """Return free balance for a currency (e.g. 'ETH', 'BTC')."""
        try:
            balance = self.exchange.fetch_balance()
            return float(balance.get(currency, {}).get("free", 0.0))
        except Exception as e:
            log.error(f"get_balance {currency}: {e}")
            return 0.0

    def buy(self, symbol: str, eur: float, price: float) -> Optional[dict]:
        """Market buy. Returns {"id": order_id, "units": float} or None."""
        # Estimate units (fee deducted on quote side on Kraken)
        units_est = (eur * (1 - CFG["fee_rate"])) / price if price > 0 else 0.0

        if PAPER_TRADE:
            log.info(
                f"  [PAPER] BUY {symbol} EUR {eur:.2f} "
                f"@ {price:.4f} ≈ {units_est:.6f} units"
            )
            return {"id": f"PAPER-BUY-{int(time.time())}", "units": units_est}

        try:
            # Check Kraken minimum order amount
            market     = self.exchange.market(symbol)
            min_amount = (market.get("limits") or {}).get("amount", {}).get("min", 0) or 0
            if units_est < min_amount:
                log.warning(
                    f"{symbol}: estimated units {units_est:.8f} "
                    f"below Kraken minimum {min_amount}"
                )
                return None

            order = self.exchange.create_market_buy_order(symbol, units_est)
            actual_units = float(order.get("filled") or units_est)
            log.info(
                f"  [LIVE] BUY {symbol} units={actual_units:.6f} "
                f"orderId={order['id']}"
            )
            return {"id": order["id"], "units": actual_units}

        except Exception as e:
            log.error(f"buy {symbol}: {e}")
            return None

    def sell(self, symbol: str, units: float) -> Optional[str]:
        """Market sell by exact coin amount. Returns orderId or paper ID."""
        if PAPER_TRADE:
            log.info(f"  [PAPER] SELL {symbol} units={units:.6f}")
            return f"PAPER-SELL-{int(time.time())}"

        # Strip trailing zeros to avoid Kraken rejection
        safe_units = float(f"{units:.8f}")
        if safe_units <= 0:
            log.warning(f"{symbol}: sell called with zero units, skipping.")
            return None

        try:
            order = self.exchange.create_market_sell_order(symbol, safe_units)
            log.info(
                f"  [LIVE] SELL {symbol} units={safe_units:.8f} "
                f"orderId={order['id']}"
            )
            return order["id"]
        except Exception as e:
            log.error(f"sell {symbol}: {e}")
            return None


# ─────────────────────────────────────────────────────────────
# 9.  TELEGRAM NOTIFIER
# ─────────────────────────────────────────────────────────────
class Telegram:
    """Telegram HTML notifications with 1 retry on failure."""

    BASE = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"

    def send(self, text: str) -> bool:
        if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
            log.debug(f"Telegram not configured — would send: {text[:80]}")
            return False
        for attempt in range(1, 3):
            try:
                r = requests.post(
                    f"{self.BASE}/sendMessage",
                    json={
                        "chat_id":    TELEGRAM_CHAT_ID,
                        "text":       text,
                        "parse_mode": "HTML",
                    },
                    timeout=10,
                )
                r.raise_for_status()
                return True
            except Exception as e:
                if attempt < 2:
                    log.warning(f"Telegram send error (attempt {attempt}/2): {e}")
                    time.sleep(2)
                else:
                    log.error(f"Telegram send failed: {e}")
        return False

    def _now(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    def dd_warning_alert(self, symbol: str, dd_pct: float, capital: float):
        self.send(
            f"<b>DD WARNING</b> {symbol}\n"
            f"Drawdown: <b>{dd_pct:.1%}</b> — position sizing halved.\n"
            f"Capital: {capital:.2f} EUR\n"
            f"<i>{self._now()}</i>"
        )

    def global_dd_alert(self, global_dd: float, total_cap: float, peak_total: float):
        self.send(
            f"<b>GLOBAL DD PAUSE</b>\n"
            f"Portfolio drawdown: <b>{global_dd:.1%}</b> "
            f"(>{CFG['global_dd_pause']:.0%})\n"
            f"Total: {total_cap:.2f} EUR (peak: {peak_total:.2f} EUR)\n"
            f"No new entries until recovery.\n"
            f"<i>{self._now()}</i>"
        )

    def entry_alert(
        self,
        symbol: str,
        price: float,
        invest: float,
        units: float,
        stop: float,
        rsi: float,
        poc: float,
        vah: float,
        val: float,
        paper: bool,
    ):
        mode = "[PAPER]" if paper else "[LIVE]"
        self.send(
            f"<b>BUY {mode}</b> {symbol}\n"
            f"Price: <b>{price:.4f} EUR</b>  |  Invest: {invest:.2f} EUR\n"
            f"Units: {units:.6f}  |  Stop: {stop:.4f}\n"
            f"<b>VP Zones:</b>\n"
            f"  VAL (support): {val:.4f}\n"
            f"  POC (magnet):  {poc:.4f}\n"
            f"  VAH (target):  {vah:.4f}\n"
            f"RSI: {rsi:.1f}\n"
            f"<i>{self._now()}</i>"
        )

    def exit_alert(
        self,
        symbol: str,
        exit_price: float,
        entry_price: float,
        units: float,
        pnl_pct: float,
        reason: str,
        paper: bool,
    ):
        mode = "[PAPER]" if paper else "[LIVE]"
        sign = "+" if pnl_pct >= 0 else ""
        self.send(
            f"<b>SELL {mode}</b> {symbol}\n"
            f"Exit: <b>{exit_price:.4f} EUR</b>  |  Entry: {entry_price:.4f}\n"
            f"Units: {units:.6f}  |  PnL: <b>{sign}{pnl_pct:.2f}%</b>\n"
            f"Reason: {reason}\n"
            f"<i>{self._now()}</i>"
        )

    def stop_raised(self, symbol: str, old_stop: float, new_stop: float, price: float):
        """Only send if stop moved more than 0.5% to avoid spam."""
        if old_stop <= 0 or new_stop <= 0:
            return
        move_pct = abs(new_stop - old_stop) / old_stop * 100
        if move_pct < 0.5:
            return
        self.send(
            f"<b>TRAIL STOP RAISED</b> {symbol}\n"
            f"Stop: {old_stop:.4f} → <b>{new_stop:.4f}</b>  (+{move_pct:.2f}%)\n"
            f"Price: {price:.4f}"
        )

    def heartbeat(self, pair_states: list[dict], paper: bool):
        mode = "PAPER" if paper else "LIVE"
        now  = self._now()
        lines = [f"<b>Kraken VP Bot [{mode}]</b>  {now}", ""]
        for s in pair_states:
            status  = "IN " if s["in_position"] else "OUT"
            poc_str = f" | POC {s['poc']:.2f}" if s["poc"] > 0 else ""
            lines.append(
                f"<b>{s['pair']}</b> {status} | "
                f"RSI {s['rsi']:.1f} | "
                f"ATR% {s['atr_pct']:.2f}%{poc_str} | "
                f"Cap {s['capital']:.2f} EUR"
            )
        self.send("\n".join(lines))


# ─────────────────────────────────────────────────────────────
# 10. BOT ENGINE
# ─────────────────────────────────────────────────────────────
class BotEngine:
    """Main trading loop — poll all pairs, manage positions, execute orders.

    Per-pair state machine:
      OUT → entry_signal on closed 15m bar → IN
      IN  → 3-phase stop management on every poll → if stop hit → OUT

    3-phase stop management (Nill's zone-to-zone trade management):
      Phase 1 (price < POC):  hold initial stop at VAL − 1.5×ATR
      Phase 2 (price ≥ POC):  move stop to breakeven; trail at ATR×3
      Phase 3 (price ≥ VAH):  tighten trail to ATR×2 (lock in profits)
    """

    def __init__(self):
        self.db       = DB()
        self.fetcher  = CandleFetcher()
        self.vpeng    = VolumeProfileEngine()
        self.indeng   = IndicatorEngine()
        self.sigeng   = SignalEngine()
        self.trader   = KrakenTrader(self.fetcher.exchange)
        self.telegram = Telegram()

        self.last_candle_ts: dict[str, str] = {}
        self.last_heartbeat = datetime.min.replace(tzinfo=timezone.utc)
        self._global_dd_alerted = False

        mode = "PAPER TRADE" if PAPER_TRADE else "*** LIVE TRADE — REAL MONEY ***"
        log.info(f"Kraken VP Bot ready | Mode: {mode}")

    # ──────────────────────────────────────────────────────────
    # VOLUME PROFILE SESSION
    # ──────────────────────────────────────────────────────────
    def _get_vp_zones(self, df: pd.DataFrame) -> Optional[tuple]:
        """Build Volume Profile from the previous 24H session.

        Uses the 96 closed bars immediately before the live (forming) bar.
        df.iloc[-1] is live; df.iloc[-97:-1] = 96 closed bars = 24H.
        """
        n = CFG["session_bars"]
        session_df = df.iloc[-(n + 1):-1]   # 96 closed bars
        if len(session_df) < 20:
            log.warning("Not enough session bars for Volume Profile.")
            return None
        return self.vpeng.calculate(session_df)

    # ──────────────────────────────────────────────────────────
    # CORE PER-PAIR LOGIC
    # ──────────────────────────────────────────────────────────
    def _process_pair(
        self,
        symbol: str,
        open_positions: int,
        global_dd: float,
    ) -> tuple[dict, Optional[dict]]:
        pos = self.db.get_position(symbol)

        # 1. Fetch candles
        df = self.fetcher.get_candles(symbol)
        if df is None or df.empty:
            log.warning(f"{symbol}: no candle data, skipping.")
            return pos, None

        # 2. Build Volume Profile zones from previous 24H session
        vp_zones = self._get_vp_zones(df)

        # 3. Calculate indicators
        ind = self.indeng.calculate(df)
        if ind is None:
            log.warning(f"{symbol}: indicator calc failed, skipping.")
            return pos, None

        live          = ind["live"]
        closed        = ind["closed"]
        current_price = live["close"]

        # 4. Mark-to-market: update peak equity using live price
        if pos["in_position"] and pos["position_units"] > 0:
            mtm = (
                pos["current_capital"]
                - pos["invest_eur"]
                + pos["position_units"] * current_price
            )
            if mtm > pos["peak_equity"]:
                pos["peak_equity"] = mtm

        # 5. DD warning alert (fires once per crossing)
        dd_now = self.sigeng._dd_now(pos)
        if dd_now >= CFG["dd_warning_pct"] and not pos.get("dd_warned"):
            pos["dd_warned"] = 1
            self.telegram.dd_warning_alert(symbol, dd_now, pos["current_capital"])
            log.warning(f"{symbol}: DD warning {dd_now:.1%} — sizing halved.")
        elif dd_now < CFG["dd_warning_pct"] and pos.get("dd_warned"):
            pos["dd_warned"] = 0   # reset for next crossing

        # ── IN POSITION: 3-phase stop management ──────────────
        if pos["in_position"]:
            atr = closed.get("atr") or 0.0
            poc = pos.get("poc_price", 0.0)
            vah = pos.get("vah_price", 0.0)

            # Track highest price (for trailing stop ratchet)
            if current_price > pos["highest_price"]:
                pos["highest_price"] = current_price

            new_stop = pos["stop_loss"]

            if poc > 0 and current_price >= poc:
                # Phase 2: price reached POC — activate breakeven + trail
                if not pos.get("tp1_hit"):
                    pos["tp1_hit"] = 1
                    breakeven = pos["entry_price"]
                    if breakeven > pos["stop_loss"]:
                        log.info(
                            f"{symbol}: POC reached — stop moved to breakeven "
                            f"{breakeven:.4f}"
                        )
                        pos["stop_loss"] = breakeven
                        self.telegram.stop_raised(
                            symbol, pos["stop_loss"], breakeven, current_price
                        )

                if atr > 0:
                    mult = CFG["atr_tight_mult"] if (vah > 0 and current_price >= vah) \
                           else CFG["atr_trail_mult"]
                    trail = pos["highest_price"] - atr * mult
                    new_stop = max(trail, pos["stop_loss"])

            # Stop ratchets up only — never down
            if new_stop > pos["stop_loss"]:
                old_stop = pos["stop_loss"]
                pos["stop_loss"] = new_stop
                self.telegram.stop_raised(symbol, old_stop, new_stop, current_price)
                log.info(
                    f"{symbol}: stop raised {old_stop:.4f} → {new_stop:.4f} "
                    f"(price={current_price:.4f})"
                )

            # Check exit
            if current_price <= pos["stop_loss"]:
                pos = self._execute_exit(
                    symbol, pos, current_price, "trailing_stop"
                )

        # ── OUT OF POSITION: check entry on new closed bar ─────
        elif str(closed["ts"]) != str(self.last_candle_ts.get(symbol, "")):
            pos["bars_since_loss"] = min(
                pos.get("bars_since_loss", 0) + 1,
                CFG["cooldown_bars"] + 1,
            )
            self.last_candle_ts[symbol] = str(closed["ts"])

            if vp_zones:
                poc, vah, val = vp_zones
                vol_ratio = closed["volume"] / (closed["vol_ma"] or 1)
                log.info(
                    f"{symbol}: bar {closed['ts']} | "
                    f"close={closed['close']:.4f} | "
                    f"VAL={val:.4f} POC={poc:.4f} VAH={vah:.4f} | "
                    f"RSI={closed.get('rsi', 0):.1f} | "
                    f"vol={vol_ratio:.2f}x | "
                    f"bars_since_loss={pos['bars_since_loss']}"
                )
            else:
                log.info(
                    f"{symbol}: bar {closed['ts']} | "
                    f"close={closed['close']:.4f} | "
                    f"RSI={closed.get('rsi', 0):.1f} | "
                    f"VP zones unavailable"
                )

            if global_dd >= CFG["global_dd_pause"]:
                log.warning(
                    f"{symbol}: global DD={global_dd:.1%} ≥ "
                    f"global_dd_pause={CFG['global_dd_pause']:.0%} — no new entries."
                )

            ok, reason = self.sigeng.entry_signal(
                closed, vp_zones, open_positions, global_dd, pos
            )

            if ok:
                invest = self.sigeng.invest_amount(closed, pos, vp_zones)
                if invest >= CFG["min_order_eur"]:
                    pos = self._execute_entry(
                        symbol, pos, closed, vp_zones, current_price, invest
                    )
                else:
                    log.info(
                        f"{symbol}: invest {invest:.2f} EUR < min "
                        f"{CFG['min_order_eur']:.2f} EUR — skipping."
                    )
            elif reason not in (
                "missing_indicators", "cooldown", "not_at_zone",
                "price_above_poc", "below_sma200",
            ):
                # Only log non-routine blocks to keep logs clean
                log.debug(f"{symbol}: entry blocked — {reason}")

        return pos, ind

    # ──────────────────────────────────────────────────────────
    # ENTRY EXECUTION
    # ──────────────────────────────────────────────────────────
    def _execute_entry(
        self,
        symbol: str,
        pos: dict,
        closed: dict,
        vp_zones: tuple,
        price: float,
        invest: float,
    ) -> dict:
        poc, vah, val = vp_zones
        atr  = closed.get("atr") or 0.0
        stop = max(val - atr * CFG["atr_stop_mult"], 0.0)

        result = self.trader.buy(symbol, invest, price)
        if result is None:
            log.error(f"{symbol}: buy order failed.")
            return pos

        units = result["units"]
        if units <= 0:
            log.warning(f"{symbol}: received 0 units from buy — skipping.")
            return pos

        pos.update({
            "in_position":    1,
            "entry_price":    price,
            "position_units": units,
            "highest_price":  price,
            "stop_loss":      stop,
            "entry_time":     datetime.now(timezone.utc).isoformat(),
            "invest_eur":     invest,
            "current_capital": pos["current_capital"] - invest,
            "poc_price":      poc,
            "vah_price":      vah,
            "val_price":      val,
            "tp1_hit":        0,
        })
        if pos["current_capital"] > pos["peak_equity"]:
            pos["peak_equity"] = pos["current_capital"]

        self.db.save_position(pos)
        self.db.log_trade(
            pair=symbol, side="buy", units=units, price=price,
            invest_eur=invest, paper=PAPER_TRADE,
        )
        self.telegram.entry_alert(
            symbol=symbol, price=price, invest=invest, units=units,
            stop=stop, rsi=closed.get("rsi", 0.0),
            poc=poc, vah=vah, val=val, paper=PAPER_TRADE,
        )
        log.info(
            f"{symbol}: ENTRY | price={price:.4f} | invest={invest:.2f} EUR | "
            f"units={units:.6f} | stop={stop:.4f} | "
            f"VAL={val:.4f} POC={poc:.4f} VAH={vah:.4f}"
        )
        return pos

    # ──────────────────────────────────────────────────────────
    # EXIT EXECUTION
    # ──────────────────────────────────────────────────────────
    def _execute_exit(
        self,
        symbol: str,
        pos: dict,
        exit_price: float,
        reason: str,
    ) -> dict:
        entry_price = pos["entry_price"]
        units       = pos["position_units"]
        invest_eur  = pos["invest_eur"]

        if units <= 0:
            log.warning(f"{symbol}: exit called but units=0 — clearing position.")
        else:
            order_id = self.trader.sell(symbol, units)
            if order_id is None:
                log.error(f"{symbol}: sell failed — NOT clearing to avoid orphan position.")
                return pos

        gross      = units * exit_price
        fee_exit   = gross * CFG["fee_rate"]
        net_exit   = gross - fee_exit

        # PnL includes entry fee in cost basis (matches bot_v5 bug fix)
        fee_entry  = invest_eur * CFG["fee_rate"]
        cost_basis = invest_eur + fee_entry
        pnl_eur    = net_exit - cost_basis
        pnl_pct    = (pnl_eur / cost_basis * 100.0) if cost_basis > 0 else 0.0

        new_capital = pos["current_capital"] + net_exit
        bars_after  = 0 if pnl_eur < 0 else (CFG["cooldown_bars"] + 1)

        pos.update({
            "in_position":    0,
            "entry_price":    0.0,
            "position_units": 0.0,
            "highest_price":  0.0,
            "stop_loss":      0.0,
            "entry_time":     "",
            "invest_eur":     0.0,
            "current_capital": new_capital,
            "bars_since_loss": bars_after,
            "poc_price":      0.0,
            "vah_price":      0.0,
            "val_price":      0.0,
            "tp1_hit":        0,
        })
        if new_capital > pos["peak_equity"]:
            pos["peak_equity"] = new_capital

        self.db.save_position(pos)
        self.db.log_trade(
            pair=symbol, side="sell", units=units, price=exit_price,
            invest_eur=invest_eur, net_pnl_pct=pnl_pct,
            exit_reason=reason, paper=PAPER_TRADE,
        )
        self.telegram.exit_alert(
            symbol=symbol, exit_price=exit_price, entry_price=entry_price,
            units=units, pnl_pct=pnl_pct, reason=reason, paper=PAPER_TRADE,
        )
        log.info(
            f"{symbol}: EXIT ({reason}) | entry={entry_price:.4f} | "
            f"exit={exit_price:.4f} | pnl={pnl_pct:+.2f}% | "
            f"new_capital={new_capital:.2f} EUR"
        )
        return pos

    # ──────────────────────────────────────────────────────────
    # MAIN LOOP
    # ──────────────────────────────────────────────────────────
    def run_loop(self):
        pairs = CFG["pairs"]
        mode  = "PAPER TRADE" if PAPER_TRADE else "LIVE TRADE"

        self.telegram.send(
            f"<b>Kraken VP Bot started [{mode}]</b>\n"
            f"Strategy: Nill MSE — Volume Profile Business Zones (15m)\n"
            f"Pairs: {', '.join(pairs)}\n"
            f"Entry: VAL zone + bullish bar + vol spike | Stop: VAL − 1.5×ATR\n"
            f"<i>{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}</i>"
        )
        log.info(f"Watching: {', '.join(pairs)}")

        while True:
            # Compute portfolio context once per loop (shared across all pairs)
            open_positions        = self.db.count_open_positions()
            total_cap, peak_total = self.db.total_portfolio_equity()
            global_dd = (
                max(0.0, (peak_total - total_cap) / peak_total)
                if peak_total > 0 else 0.0
            )

            # Global DD alert (fires once per threshold crossing)
            if global_dd >= CFG["global_dd_pause"] and not self._global_dd_alerted:
                self._global_dd_alerted = True
                self.telegram.global_dd_alert(global_dd, total_cap, peak_total)
                log.warning(
                    f"GLOBAL DD PAUSE: portfolio DD={global_dd:.1%} — "
                    "no new entries until recovery."
                )
            elif global_dd < CFG["global_dd_pause"] and self._global_dd_alerted:
                self._global_dd_alerted = False

            pair_states = []
            for sym in pairs:
                try:
                    pos, ind = self._process_pair(sym, open_positions, global_dd)
                    self.db.save_position(pos)

                    rsi = atr_pct = 0.0
                    if ind is not None:
                        rsi_c   = ind["closed"].get("rsi")
                        atr_c   = ind["closed"].get("atr")
                        close_c = ind["closed"].get("close", 1) or 1
                        rsi     = rsi_c if rsi_c is not None else 0.0
                        atr_pct = (atr_c / close_c * 100) if atr_c else 0.0

                    pair_states.append({
                        "pair":        sym,
                        "in_position": pos["in_position"],
                        "rsi":         rsi,
                        "atr_pct":     atr_pct,
                        "capital":     pos["current_capital"],
                        "poc":         pos.get("poc_price", 0.0),
                    })

                except Exception as e:
                    log.error(f"{sym}: unhandled error — {e}", exc_info=True)

                time.sleep(1)   # gentle rate limiting between pairs

            # Hourly heartbeat
            now_utc = datetime.now(tz=timezone.utc)
            if (now_utc - self.last_heartbeat).total_seconds() >= 3600:
                self.telegram.heartbeat(pair_states, PAPER_TRADE)
                self.last_heartbeat = now_utc

            time.sleep(CFG["poll_seconds"])


# ─────────────────────────────────────────────────────────────
# 11. ENTRY POINT
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Kraken VP Bot — Nill MSE Volume Profile Strategy"
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Override PAPER_TRADE env var → go live (requires manual confirmation)",
    )
    args = parser.parse_args()

    if args.live:
        confirm = input(
            "*** WARNING: LIVE MODE — REAL MONEY ON KRAKEN ***\n"
            "Type 'YES I UNDERSTAND' to continue: "
        )
        if confirm.strip() != "YES I UNDERSTAND":
            print("Aborted.")
            sys.exit(0)
        PAPER_TRADE = False

    log.info("=" * 60)
    log.info("  KRAKEN VP BOT  —  Nill MSE Volume Profile Strategy")
    log.info("  Timeframe : 15m  |  Session VP : 24H rolling")
    log.info("  Entry     : VAL zone + bullish bar + volume spike")
    log.info("  Stop      : VAL − 1.5 × ATR  |  Trail: ATR×3 / ATR×2")
    log.info(f"  Mode      : {'PAPER TRADE' if PAPER_TRADE else '*** LIVE TRADE ***'}")
    log.info(f"  Start     : {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    log.info("=" * 60)

    acquire_lock()
    try:
        bot = BotEngine()
        bot.run_loop()
    except KeyboardInterrupt:
        log.info("Stopped by user (KeyboardInterrupt).")
        Telegram().send("<b>Kraken VP Bot stopped.</b>")
    finally:
        release_lock()
