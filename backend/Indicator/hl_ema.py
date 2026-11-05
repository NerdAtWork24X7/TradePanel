"""EMA of highs and lows indicator.

Computes an EMA over candle highs and a second EMA over candle lows for a
configurable length (default 20). Both series are returned aligned to the
candle timestamps so the chart can render them as overlay lines.
"""

from __future__ import annotations

import logging
import sqlite3

import pandas as pd
from pandas.errors import DatabaseError

from backend.Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── Config ───────────────────────────────────────────────────────────────────
_hl_ema_length: int = 20


def set_hl_ema_length(length: int) -> None:
    """Set the EMA length used for both the high and low series (2–500)."""
    global _hl_ema_length
    _hl_ema_length = max(2, min(500, int(length)))


def get_hl_ema_length() -> int:
    return _hl_ema_length


# ── Public API ───────────────────────────────────────────────────────────────

def compute_hl_ema(
    coin: str,
    timeframe: str,
    length: int | None = None,
) -> dict:
    """Compute EMA(length) of candle highs and lows.

    Args:
        coin: Trading pair (e.g. "BTC").
        timeframe: Candle interval of the display chart (e.g. "5m", "1h").
        length: Override EMA length. Falls back to the global config.

    Returns:
        {
            "ema_high": [{"time": int, "value": float}, ...],
            "ema_low":  [{"time": int, "value": float}, ...],
            "length": int,
        }
    """
    _length = int(length or _hl_ema_length)
    try:
        return _compute_hl_ema_impl(coin, timeframe, _length)
    except (sqlite3.OperationalError, DatabaseError):
        # No cached data for this coin yet — expected, not an error
        return {"ema_high": [], "ema_low": [], "length": _length}
    except Exception as e:
        log.error("High/Low EMA computation failed for %s %s: %s", coin, timeframe, e)
        return {"ema_high": [], "ema_low": [], "length": _length}


# ── Internal ─────────────────────────────────────────────────────────────────

def _compute_hl_ema_impl(coin: str, timeframe: str, length: int, df=None) -> dict:
    if df is None:
        df = load_candles_df(coin, timeframe, columns=["time", "high", "low"])
    empty = {"ema_high": [], "ema_low": [], "length": length}
    if df.empty:
        return empty

    ema_high = df["high"].ewm(span=length, adjust=False).mean()
    ema_low = df["low"].ewm(span=length, adjust=False).mean()

    high_points: list[dict] = []
    low_points: list[dict] = []
    for i in range(len(df)):
        hv = ema_high.iloc[i]
        lv = ema_low.iloc[i]
        # Keep both series index-aligned if a bar has a missing value.
        if pd.isna(hv) or pd.isna(lv):
            continue
        t = int(df["time"].iloc[i])
        high_points.append({"time": t, "value": round(float(hv), 8)})
        low_points.append({"time": t, "value": round(float(lv), 8)})

    return {"ema_high": high_points, "ema_low": low_points, "length": length}
