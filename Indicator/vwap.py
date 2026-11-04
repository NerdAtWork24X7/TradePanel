"""VWAP indicator — Volume-Weighted Average Price computation.

Uses pandas-ta VWAP which computes:
    VWAP = cumulative(typical_price * volume) / cumulative(volume)
Resets per anchor period (D for intraday, W for daily+).
"""

from __future__ import annotations

import logging

import pandas as pd
import pandas_ta as ta

from Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── Anchor config ────────────────────────────────────────────────────────────
_vwap_anchor_intraday: str = "D"
_vwap_anchor_daily: str = "W"


def set_vwap_anchor_intraday(anchor: str) -> None:
    global _vwap_anchor_intraday
    _vwap_anchor_intraday = anchor or "D"


def get_vwap_anchor_intraday() -> str:
    return _vwap_anchor_intraday


def set_vwap_anchor_daily(anchor: str) -> None:
    global _vwap_anchor_daily
    _vwap_anchor_daily = anchor or "W"


def get_vwap_anchor_daily() -> str:
    return _vwap_anchor_daily


# ── Public API ───────────────────────────────────────────────────────────────

def compute_vwap(coin: str, timeframe: str) -> list[dict]:
    """Compute VWAP from cached candles.

    Returns list of {"time": int, "value": float} dicts for LightweightCharts.
    """
    try:
        return _compute_vwap_impl(coin, timeframe)
    except Exception as e:
        log.error("VWAP computation failed for %s %s: %s", coin, timeframe, e)
        return []


# ── Internal ─────────────────────────────────────────────────────────────────

def _compute_vwap_impl(coin: str, timeframe: str, df=None) -> list[dict]:
    if df is None:
        df = load_candles_df(coin, timeframe)

    if df.empty:
        return []

    intraday = timeframe in (
        "1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h",
    )

    df["datetime"] = pd.to_datetime(df["time"], unit="s", utc=True)
    df = df.set_index("datetime")

    anchor = get_vwap_anchor_intraday() if intraday else get_vwap_anchor_daily()
    vwap_series = ta.vwap(
        high=df["high"], low=df["low"],
        close=df["close"], volume=df["volume"],
        anchor=anchor,
    )
    df["vwap"] = vwap_series

    result = []
    for _, row in df.iterrows():
        if row["volume"] > 0 and pd.notna(row["vwap"]):
            result.append({
                "time": int(row["time"]),
                "value": round(float(row["vwap"]), 8),
            })
    return result
