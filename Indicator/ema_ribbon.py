"""3-line Moving Average Ribbon indicator.

Computes 3 moving averages with configurable type (EMA/SMA) and base length.
The three lines use: base_length, base_length * 2, base_length * 3.

Returns data suitable for LightweightCharts line series.
"""

from __future__ import annotations

import logging

import pandas as pd

from Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── Ribbon config ────────────────────────────────────────────────────────────
_ribbon_ma_type: str = "EMA"        # "EMA" or "SMA"
_ribbon_lengths: list[int] = [20, 40, 60]  # individual lengths for each line


def set_ribbon_ma_type(ma_type: str) -> None:
    """Set the MA type for the ribbon ('EMA' or 'SMA')."""
    global _ribbon_ma_type
    _ribbon_ma_type = ma_type.upper() if ma_type.upper() in ("EMA", "SMA") else "EMA"


def get_ribbon_ma_type() -> str:
    return _ribbon_ma_type


def set_ribbon_lengths(lengths: list[int]) -> None:
    """Set individual lengths for each ribbon line (clamped 2–500 each)."""
    global _ribbon_lengths
    _ribbon_lengths = [max(2, min(500, int(l))) for l in lengths]


def get_ribbon_lengths() -> list[int]:
    return list(_ribbon_lengths)


# ── Helpers ──────────────────────────────────────────────────────────────────

def _compute_ma(series: pd.Series, period: int, ma_type: str) -> pd.Series:
    """Compute EMA or SMA over the given series."""
    if ma_type == "SMA":
        return series.rolling(window=period, min_periods=period).mean()
    else:  # EMA
        return series.ewm(span=period, adjust=False).mean()


# ── Public API ───────────────────────────────────────────────────────────────

def compute_ema_ribbon(
    coin: str,
    timeframe: str,
    ma_type: str | None = None,
    lengths: list[int] | None = None,
) -> dict:
    """Compute a 3-line MA ribbon from cached candles.

    Args:
        coin: Trading pair (e.g. "BTC").
        timeframe: Candle interval (e.g. "5m", "1h").
        ma_type: Override MA type ("EMA" or "SMA"). Falls back to global config.
        lengths: Override lengths for each line. Falls back to global config.

    Returns:
        {
            "line1": [{"time": int, "value": float}, ...],
            "line2": [{"time": int, "value": float}, ...],
            "line3": [{"time": int, "value": float}, ...],
            "lengths": [int, int, int],
            "ma_type": str,
        }
    """
    try:
        return _compute_ribbon_impl(coin, timeframe, ma_type, lengths)
    except Exception as e:
        log.error("EMA ribbon computation failed for %s %s: %s", coin, timeframe, e)
        fallback_lengths = lengths or _ribbon_lengths
        return {"line1": [], "line2": [], "line3": [], "lengths": fallback_lengths, "ma_type": ma_type or _ribbon_ma_type}


# ── Internal ─────────────────────────────────────────────────────────────────

def _compute_ribbon_impl(
    coin: str,
    timeframe: str,
    ma_type: str | None,
    lengths: list[int] | None,
    df=None,
) -> dict:
    mt = ma_type or _ribbon_ma_type
    lens = lengths or _ribbon_lengths

    if df is None:
        df = load_candles_df(coin, timeframe, columns=["time", "close"])

    if df.empty:
        return {"line1": [], "line2": [], "line3": [], "lengths": lens, "ma_type": mt}

    result = {}
    for idx, period in enumerate(lens):
        ma = _compute_ma(df["close"], period, mt)
        valid = pd.notna(ma)
        line_df = df.loc[valid, ["time"]].copy()
        line_df["value"] = ma[valid].round(8)
        line_data = [
            {"time": int(row["time"]), "value": float(row["value"])}
            for _, row in line_df.iterrows()
        ]
        result[f"line{idx + 1}"] = line_data

    result["lengths"] = lens
    result["ma_type"] = mt
    return result
