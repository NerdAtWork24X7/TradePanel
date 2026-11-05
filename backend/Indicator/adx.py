"""ADX (Average Directional Index) indicator.

Computes the classic ADX, +DI, and -DI lines using Wilder's smoothing.
Default length is 14 (TradingView default). The ADX measures trend strength
while +DI / -DI measure directional pressure.

Returns ``{adx, plus_di, minus_di, length, levels}`` where each series is a
list of ``{time, value}`` points ready for LightweightCharts ``addLineSeries``.
"""

from __future__ import annotations

import logging

import numpy as np

from backend.Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── ADX config ───────────────────────────────────────────────────────────────
_adx_length: int = 14
_adx_pane_height: int = 160
_adx_show_di_lines: bool = False
_adx_levels: list[float] = [20.0, 25.0]


def set_adx_length(length: int) -> None:
    """Set the ADX/DI smoothing length (clamped 2–200)."""
    global _adx_length
    _adx_length = max(2, min(200, int(length)))


def get_adx_length() -> int:
    return _adx_length


def set_adx_pane_height(height: int) -> None:
    """Set the ADX subchart pane height in pixels (clamped 60-400)."""
    global _adx_pane_height
    _adx_pane_height = max(60, min(400, int(height)))


def get_adx_pane_height() -> int:
    return _adx_pane_height


def set_adx_show_di_lines(enabled: bool) -> None:
    """Persist the user's +/- DI visibility preference (default False)."""
    global _adx_show_di_lines
    _adx_show_di_lines = bool(enabled)


def get_adx_show_di_lines() -> bool:
    return _adx_show_di_lines


def get_adx_levels() -> list[float]:
    """Default reference levels drawn on the ADX pane (TradingView: 20, 25)."""
    return list(_adx_levels)


# ── Public API ───────────────────────────────────────────────────────────────

def compute_adx(
    coin: str,
    timeframe: str,
    length: int | None = None,
) -> dict:
    """Compute ADX, +DI and -DI for cached candles.

    Args:
        coin: Trading pair (e.g. "BTC").
        timeframe: Candle interval (e.g. "5m", "1h").
        length: Override ADX length. Falls back to global config.

    Returns:
        {
            "adx":      [{"time": int, "value": float}, ...],
            "plus_di":  [{"time": int, "value": float}, ...],
            "minus_di": [{"time": int, "value": float}, ...],
            "length":   int,
            "levels":   [float, ...],
        }
    """
    _length = length or _adx_length
    empty = {
        "adx": [],
        "plus_di": [],
        "minus_di": [],"length": _length,
            "pane_height": _adx_pane_height,
            "levels": list(_adx_levels),
    }
    try:
        return _compute_adx_impl(coin, timeframe, _length)
    except Exception as e:
        log.error("ADX computation failed for %s %s: %s", coin, timeframe, e)
        return empty


# ── Internal ─────────────────────────────────────────────────────────────────

def _compute_adx_impl(coin: str, timeframe: str, length: int, df=None) -> dict:
    if df is None:
        df = load_candles_df(
            coin,
            timeframe,
            columns=["time", "open", "high", "low", "close"],
        )

    if len(df) < length * 2:
        return {
            "adx": [],
            "plus_di": [],
            "minus_di": [],
            "length": length,
            "levels": list(_adx_levels),
        }

    # Helper to convert a pandas Series of values to a chart point list.
    def to_points(times: np.ndarray, values: np.ndarray) -> list[dict]:
        out: list[dict] = []
        for t, v in zip(times, values):
            if np.isnan(v):
                continue
            out.append({"time": int(t), "value": round(float(v), 4)})
        return out

    times = df["time"].values
    highs = df["high"].values.astype(float)
    lows = df["low"].values.astype(float)
    closes = df["close"].values.astype(float)
    n = len(df)

    # ── 1. True Range, +DM, -DM ──────────────────────────────────────────
    tr = np.empty(n, dtype=float)
    plus_dm = np.empty(n, dtype=float)
    minus_dm = np.empty(n, dtype=float)

    # First bar has no prev high/low/close → zero contributions.
    tr[0] = highs[0] - lows[0]
    plus_dm[0] = 0.0
    minus_dm[0] = 0.0

    for i in range(1, n):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0

        h_l = highs[i] - lows[i]
        h_pc = abs(highs[i] - closes[i - 1])
        l_pc = abs(lows[i] - closes[i - 1])
        tr[i] = max(h_l, h_pc, l_pc)

    # ── 2. Wilder's smoothing seed = sum of first `length` bars ─────────
    seed_end = length  # exclusive
    tr_smooth = np.empty(n, dtype=float)
    plus_dm_smooth = np.empty(n, dtype=float)
    minus_dm_smooth = np.empty(n, dtype=float)

    if n < seed_end:
        return {
            "adx": [],
            "plus_di": [],
            "minus_di": [],
            "length": length,
            "levels": list(_adx_levels),
        }

    tr_smooth[seed_end - 1] = tr[:seed_end].sum()
    plus_dm_smooth[seed_end - 1] = plus_dm[:seed_end].sum()
    minus_dm_smooth[seed_end - 1] = minus_dm[:seed_end].sum()

    for i in range(seed_end, n):
        # Wilder smoothing: prev*(n-1)/n + current
        tr_smooth[i] = tr_smooth[i - 1] - (tr_smooth[i - 1] / length) + tr[i]
        plus_dm_smooth[i] = plus_dm_smooth[i - 1] - (plus_dm_smooth[i - 1] / length) + plus_dm[i]
        minus_dm_smooth[i] = minus_dm_smooth[i - 1] - (minus_dm_smooth[i - 1] / length) + minus_dm[i]

    # ── 3. +DI / -DI / DX ───────────────────────────────────────────────
    plus_di = np.full(n, np.nan, dtype=float)
    minus_di = np.full(n, np.nan, dtype=float)
    dx = np.full(n, np.nan, dtype=float)

    for i in range(seed_end - 1, n):
        if tr_smooth[i] <= 0:
            continue
        pdi = 100.0 * plus_dm_smooth[i] / tr_smooth[i]
        mdi = 100.0 * minus_dm_smooth[i] / tr_smooth[i]
        plus_di[i] = pdi
        minus_di[i] = mdi
        denom = pdi + mdi
        if denom > 0:
            dx[i] = 100.0 * abs(pdi - mdi) / denom

    # ── 4. ADX = Wilder's smoothing of DX over `length` periods ─────────
    # Seed with the average of the first `length` valid DX values.
    adx = np.full(n, np.nan, dtype=float)
    dx_seed_start = seed_end - 1
    dx_seed_end = dx_seed_start + length
    if dx_seed_end > n:
        return {
            "adx": [],
            "plus_di": to_points(times[seed_end - 1:], plus_di[seed_end - 1:]),
            "minus_di": to_points(times[seed_end - 1:], minus_di[seed_end - 1:]),
            "length": length,
            "levels": list(_adx_levels),
        }

    adx[dx_seed_end - 1] = np.nanmean(dx[dx_seed_start:dx_seed_end])
    for i in range(dx_seed_end, n):
        prev = adx[i - 1]
        if np.isnan(prev):
            continue
        adx[i] = prev - (prev / length) + (dx[i] / length)

    # ── 5. Build output points (skip pre-warmup NaNs) ────────────────────
    plus_di_pts = to_points(times[seed_end - 1:], plus_di[seed_end - 1:])
    minus_di_pts = to_points(times[seed_end - 1:], minus_di[seed_end - 1:])
    adx_pts = to_points(times[dx_seed_end - 1:], adx[dx_seed_end - 1:])

    return {
        "adx": adx_pts,
        "plus_di": plus_di_pts,
        "minus_di": minus_di_pts,
        "length": length,
        "levels": list(_adx_levels),
        "show_di_lines": False,
    }
