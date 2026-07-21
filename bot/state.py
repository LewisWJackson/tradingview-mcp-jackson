"""Tiny JSON state file so a restart does not forget risk history.

Positions are reconciled from the broker (the real source of truth), but peak
equity lives only in memory. Without persistence, restarting mid-drawdown
re-baselines the peak to current equity and the 10% circuit breaker silently
forgets how far down it already is — the one control that is supposed to stop a
bad run is the one a restart disarms.
"""
import json
import os
import traceback


def load(path):
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r") as f:
            return json.load(f) or {}
    except Exception:
        traceback.print_exc()
        return {}


def save(path, data):
    try:
        tmp = f"{path}.tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)   # atomic — never leaves a half-written state file
    except Exception:
        traceback.print_exc()


def load_peak_equity(path):
    value = load(path).get("peak_equity")
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def save_peak_equity(path, peak_equity):
    data = load(path)
    data["peak_equity"] = float(peak_equity)
    save(path, data)
