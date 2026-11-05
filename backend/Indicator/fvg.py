"""Fair Value Gap (FVG) indicator — detection and caching.

A **bullish FVG** exists when candle[i-1].high < candle[i+1].low.
A **bearish FVG** exists when candle[i-1].low > candle[i+1].high.
Only **unmitigated** gaps are returned.
"""

from __future__ import annotations

import logging
import threading
import time as _time

import numpy as np

from backend.Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── FVG Cache ────────────────────────────────────────────────────────────────
# Keyed by (coin, timeframe, gap_pct) → (timestamp, data)
_fvg_cache: dict[tuple, tuple[float, dict]] = {}
_fvg_cache_lock = threading.Lock()
FVG_CACHE_TTL = 30  # seconds
_MAX_FVG_CACHE_ENTRIES = 200  # bound memory growth


def _prune_fvg_cache(now: float) -> None:
    """Remove expired entries and enforce a size cap on the FVG cache."""
    global _fvg_cache
    expired = [k for k, (ts, _) in _fvg_cache.items() if (now - ts) >= FVG_CACHE_TTL]
    for k in expired:
        del _fvg_cache[k]
    while len(_fvg_cache) > _MAX_FVG_CACHE_ENTRIES:
        oldest_key = next(iter(_fvg_cache))
        del _fvg_cache[oldest_key]

# ── Gap percentage config ───────────────────────────────────────────────────
_fvg_gap_pct_config: float = 0.5


def set_fvg_gap_pct(value: float) -> None:
    """Store the current gap percentage (clamped to 0–10)."""
    global _fvg_gap_pct_config
    _fvg_gap_pct_config = max(0.0, min(10.0, value))


def get_fvg_gap_pct() -> float:
    """Return the current configured gap percentage."""
    return _fvg_gap_pct_config


def invalidate_fvg_cache(
    coin: str | None = None,
    timeframe: str | None = None,
) -> None:
    """Invalidate FVG cache entries.

    If coin and timeframe are given, only matching entries are removed.
    Otherwise the entire cache is cleared.
    """
    with _fvg_cache_lock:
        if coin is not None and timeframe is not None:
            keys_to_remove = [
                k for k in _fvg_cache if k[0] == coin and k[1] == timeframe
            ]
            for k in keys_to_remove:
                del _fvg_cache[k]
        else:
            _fvg_cache.clear()


# ── Public API ───────────────────────────────────────────────────────────────

def compute_fvg(
    coin: str,
    timeframe: str,
    gap_pct: float = 0.05,
) -> dict:
    """Detect unmitigated Fair Value Gaps from cached candles.

    Args:
        coin: Trading pair coin name (e.g. "BTC").
        timeframe: Candle interval (e.g. "5m", "1h").
        gap_pct: Minimum gap size as a **percentage** of price level.
                 0.5 means 0.5 % (e.g. a $300 gap on a $60,000 asset).

    Returns:
        {"bullish": [...], "bearish": [...]}
    """
    cache_key = (coin, timeframe, gap_pct)
    now = _time.time()

    with _fvg_cache_lock:
        _prune_fvg_cache(now)
        cached = _fvg_cache.get(cache_key)
        if cached and (now - cached[0]) < FVG_CACHE_TTL:
            log.debug("FVG cache hit for %s %s pct=%.2f", coin, timeframe, gap_pct)
            return cached[1]

    try:
        result = _compute_fvg_impl(coin, timeframe, gap_pct)
    except Exception as e:
        log.error("FVG computation failed for %s %s: %s", coin, timeframe, e)
        result = {"bullish": [], "bearish": []}

    with _fvg_cache_lock:
        _fvg_cache[cache_key] = (now, result)

    return result


# ── Internal ─────────────────────────────────────────────────────────────────

def _compute_fvg_impl(coin: str, timeframe: str, gap_pct: float, df=None) -> dict:
    if df is None:
        df = load_candles_df(coin, timeframe, columns=["time", "open", "high", "low", "close"])

    if len(df) < 3:
        return {"bullish": [], "bearish": []}

    times = df["time"].values
    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values

    bullish_gaps: list[dict] = []
    bearish_gaps: list[dict] = []
    n = len(df)

    # Vectorized mitigation scan: running min/max of closes from each index
    running_min = np.minimum.accumulate(closes[::-1])[::-1]
    running_max = np.maximum.accumulate(closes[::-1])[::-1]

    for i in range(1, n - 1):
        mid_high = highs[i]
        mid_low = lows[i]
        mid_range = mid_high - mid_low

        if mid_range <= 0:
            continue

        prev_high = highs[i - 1]
        next_low = lows[i + 1]
        prev_low = lows[i - 1]
        next_high = highs[i + 1]

        # Bullish FVG: prev high < next low
        if prev_high < next_low:
            gap_size = next_low - prev_high
            gap_high = next_low
            gap_low = prev_high
            if prev_high > 0 and (gap_size / prev_high) * 100 >= gap_pct:
                # closes from i+2 to end never below gap_low (treat no future closes as unmitigated)
                mitigated = (i + 2 < n) and (running_min[i + 2] < gap_low)
                if not mitigated:
                    bullish_gaps.append({
                        "time": int(times[i]),
                        "high": float(gap_high),
                        "low": float(gap_low),
                        "end_time": int(times[-1]),
                    })

        # Bearish FVG: prev low > next high
        if prev_low > next_high:
            gap_size = prev_low - next_high
            gap_high = prev_low
            gap_low = next_high
            if prev_low > 0 and (gap_size / prev_low) * 100 >= gap_pct:
                # closes from i+2 to end never above gap_high (treat no future closes as unmitigated)
                mitigated = (i + 2 < n) and (running_max[i + 2] > gap_high)
                if not mitigated:
                    bearish_gaps.append({
                        "time": int(times[i]),
                        "high": float(gap_high),
                        "low": float(gap_low),
                        "end_time": int(times[-1]),
                    })

    return {"bullish": bullish_gaps, "bearish": bearish_gaps}
