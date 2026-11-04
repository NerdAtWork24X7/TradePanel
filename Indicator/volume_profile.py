"""Volume Profile indicator.

Computes horizontal volume histograms (volume-at-price) from cached candles.

Two modes:
  1. **Legacy single-profile** – one overall profile from the last *N* candles
     (``compute_volume_profile``).
  2. **Daily Volume Profile** – a separate volume profile for each full UTC
     day, rendered as per-day histograms inside the day's box.  Results are
     cached so that completed historical days are never recomputed
     (``compute_daily_volume_profiles``).

Uses a canvas-based approach for rendering.
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone, timedelta
from typing import Any

import pandas as pd

from Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── Volume Profile config ────────────────────────────────────────────────────
_vp_length: int = 100           # number of candles to include (legacy)
_vp_rows: int = 24              # number of price rows (bins)


def set_vp_length(length: int) -> None:
    """Set number of candles to use for volume profile (clamped 10–5000)."""
    global _vp_length
    _vp_length = max(10, min(5000, int(length)))


def get_vp_length() -> int:
    return _vp_length


def set_vp_rows(rows: int) -> None:
    """Set number of price rows/bins (clamped 5–100)."""
    global _vp_rows
    _vp_rows = max(5, min(100, int(rows)))


def get_vp_rows() -> int:
    return _vp_rows


# ── Helpers ──────────────────────────────────────────────────────────────────

def _compute_bins(
    df: pd.DataFrame,
    n_rows: int,
) -> dict:
    """Compute volume-profile bins from a *DataFrame* of candles.

    Returns ``{"rows": [...], "max_volume": float, "poc_price": float}``.
    """
    if df.empty:
        return {"rows": [], "max_volume": 0, "poc_price": 0}

    overall_high = float(df["high"].max())
    overall_low = float(df["low"].min())

    if overall_high == overall_low:
        total_vol = float(df["volume"].sum())
        return {
            "rows": [{
                "price_high": overall_high,
                "price_low": overall_low,
                "volume": total_vol,
                "buy_volume": total_vol / 2,
                "sell_volume": total_vol / 2,
            }],
            "max_volume": total_vol,
            "poc_price": overall_high,
        }

    bin_size = (overall_high - overall_low) / n_rows
    bins = []
    for i in range(n_rows):
        bins.append({
            "price_low": overall_low + i * bin_size,
            "price_high": overall_low + (i + 1) * bin_size,
            "volume": 0.0,
            "buy_volume": 0.0,
            "sell_volume": 0.0,
        })

    for _, candle in df.iterrows():
        c_high = candle["high"]
        c_low = candle["low"]
        c_close = candle["close"]
        c_open = candle["open"]
        c_vol = candle["volume"]

        if c_vol <= 0:
            continue

        is_bullish = c_close >= c_open
        buy_pct = (c_close - c_low) / (c_high - c_low) if c_high > c_low else 0.5
        buy_pct = max(0.0, min(1.0, buy_pct))

        for b in bins:
            overlap_high = min(c_high, b["price_high"])
            overlap_low = max(c_low, b["price_low"])

            if overlap_high > overlap_low:
                fraction = (overlap_high - overlap_low) / (c_high - c_low) if c_high > c_low else 1.0
                vol = c_vol * fraction

                b["volume"] += vol
                if is_bullish:
                    b["buy_volume"] += vol * buy_pct
                    b["sell_volume"] += vol * (1 - buy_pct)
                else:
                    b["buy_volume"] += vol * (1 - buy_pct)
                    b["sell_volume"] += vol * buy_pct

    max_volume = max((b["volume"] for b in bins), default=0)
    poc_idx = max(range(len(bins)), key=lambda i: bins[i]["volume"])
    poc_price = bins[poc_idx]["price_low"] + bin_size / 2 if max_volume > 0 else 0

    for b in bins:
        b["volume"] = round(b["volume"], 4)
        b["buy_volume"] = round(b["buy_volume"], 4)
        b["sell_volume"] = round(b["sell_volume"], 4)
        b["price_high"] = round(b["price_high"], 8)
        b["price_low"] = round(b["price_low"], 8)

    return {
        "rows": bins,
        "max_volume": round(max_volume, 4),
        "poc_price": round(poc_price, 8),
    }


# ── Daily Volume Profile Cache ─────────────────────────────────────────────

# Cache keyed by (coin, timeframe) → {date_str: {profile, candle_count, last_ts}}
# Bounded to avoid unbounded memory growth on long-running sessions.
_MAX_DAILY_VP_COINS = 50  # max distinct (coin, timeframe) entries
_daily_vp_cache: dict[str, dict[str, dict[str, Any]]] = {}
_daily_vp_lock = threading.Lock()


def _prune_daily_vp_cache() -> None:
    """Evict oldest entries if the cache grows beyond the coin limit."""
    global _daily_vp_cache
    while len(_daily_vp_cache) > _MAX_DAILY_VP_COINS:
        oldest_key = next(iter(_daily_vp_cache))
        del _daily_vp_cache[oldest_key]


def _cache_key(coin: str, timeframe: str) -> str:
    return f"{coin}:{timeframe}"


def invalidate_daily_vp_cache(
    coin: str | None = None,
    timeframe: str | None = None,
) -> None:
    """Clear daily VP cache.  No args → clear everything."""
    with _daily_vp_lock:
        if coin is None and timeframe is None:
            _daily_vp_cache.clear()
            return
        if coin is not None and timeframe is not None:
            _daily_vp_cache.pop(_cache_key(coin, timeframe), None)
            return
        if coin is not None:
            prefix = f"{coin}:"
            for k in [k for k in _daily_vp_cache if k.startswith(prefix)]:
                del _daily_vp_cache[k]


def compute_daily_volume_profiles(
    coin: str,
    timeframe: str,
    rows: int | None = None,
) -> list[dict]:
    """Compute a separate volume profile for **each full UTC day**.

    Completed historical days are cached so that only the current (still-
    forming) day is recomputed on subsequent calls.

    Returns:
        A list of day-profile dicts sorted chronologically::

            [
                {
                    "date": "2024-01-15",
                    "start_time": 1705276800,
                    "end_time": 1705363199,
                    "rows": [{price_low, price_high, volume, buy_volume, sell_volume}, ...],
                    "max_volume": float,
                    "poc_price": float,
                },
                ...
            ]
    """
    try:
        return _compute_daily_vp_impl(coin, timeframe, rows)
    except Exception as e:
        log.error("Daily VP computation failed for %s %s: %s", coin, timeframe, e)
        return []


def _compute_daily_vp_impl(
    coin: str,
    timeframe: str,
    rows: int | None,
    df=None,
) -> list[dict]:
    n_rows = rows or _vp_rows
    key = _cache_key(coin, timeframe)

    if df is None:
        df = load_candles_df(coin, timeframe)

    if df.empty:
        return []

    df["time"] = df["time"].astype(int)
    df["date_str"] = pd.to_datetime(df["time"], unit="s", utc=True).dt.strftime("%Y-%m-%d")

    with _daily_vp_lock:
        if key not in _daily_vp_cache:
            _prune_daily_vp_cache()
            _daily_vp_cache[key] = {}

    results: list[dict] = []

    for date_str, day_df in df.groupby("date_str"):
        candle_count = len(day_df)
        last_ts = int(day_df["time"].max())

        with _daily_vp_lock:
            coin_cache = _daily_vp_cache[key]
            cached = coin_cache.get(date_str)
            if cached and cached["candle_count"] == candle_count and cached["last_ts"] == last_ts:
                profile = cached["profile"]
            else:
                profile = _compute_bins(day_df, n_rows)
                coin_cache[date_str] = {
                    "profile": profile,
                    "candle_count": candle_count,
                    "last_ts": last_ts,
                }
                log.debug("Daily VP cache miss for %s %s – computed", coin, date_str)

        dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        start_ts = int(dt.timestamp())
        end_ts = int((dt + timedelta(days=1)).timestamp()) - 1

        results.append({
            "date": date_str,
            "start_time": start_ts,
            "end_time": end_ts,
            "rows": profile["rows"],
            "max_volume": profile["max_volume"],
            "poc_price": profile["poc_price"],
        })

    return results


# ── Legacy single-profile API ───────────────────────────────────────────────

def compute_volume_profile(
    coin: str,
    timeframe: str,
    length: int | None = None,
    rows: int | None = None,
) -> dict:
    """Compute volume profile from cached candles (legacy single-profile mode).

    Args:
        coin: Trading pair (e.g. "BTC").
        timeframe: Candle interval (e.g. "5m", "1h").
        length: Override number of candles. Falls back to global config.
        rows: Override number of price bins. Falls back to global config.

    Returns:
        {
            "rows": [...],
            "max_volume": float,
            "poc_price": float,
        }
    """
    try:
        return _compute_vp_impl(coin, timeframe, length, rows)
    except Exception as e:
        log.error("Volume profile computation failed for %s %s: %s", coin, timeframe, e)
        return {"rows": [], "max_volume": 0, "poc_price": 0}


def _compute_vp_impl(
    coin: str,
    timeframe: str,
    length: int | None,
    rows: int | None,
    df=None,
) -> dict:
    n_candles = length or _vp_length
    n_rows = rows or _vp_rows

    if df is None:
        df = load_candles_df(coin, timeframe)

    if df.empty:
        return {"rows": [], "max_volume": 0, "poc_price": 0}

    df = df.tail(n_candles).reset_index(drop=True)
    return _compute_bins(df, n_rows)


# ── Session Volume Profile ─────────────────────────────────────────────────

from Indicator.sessions import SESSIONS


def _parse_hhmm(value: str) -> tuple[int, int]:
    try:
        parts = value.split(":")
        return int(parts[0]) % 24, int(parts[1]) % 60
    except Exception:
        return 0, 0


_session_vp_cache: dict = {}
_session_vp_cache_ts: float = 0


def _get_current_session_info() -> dict | None:
    """Determine which trading session is active right now (UTC).
    
    Returns {key, name, start_ts, end_ts, color} or None if between sessions.
    Cached for 1 second to avoid recomputation on rapid calls.
    """
    import time
    now = time.time()
    global _session_vp_cache_ts
    if _session_vp_cache and (now - _session_vp_cache_ts) < 1.0:
        return _session_vp_cache.get("result")
    
    from datetime import datetime, timezone, timedelta
    now_dt = datetime.now(timezone.utc)
    now_ts = int(now_dt.timestamp())
    
    if not SESSIONS:
        _session_vp_cache["result"] = None
        _session_vp_cache_ts = now
        return None
    
    # Sort sessions by start time
    ordered = sorted(
        SESSIONS.items(),
        key=lambda item: _parse_hhmm(item[1]["start"])[0] * 60 + _parse_hhmm(item[1]["start"])[1],
    )
    
    # Build today's session start timestamps
    today_sessions = []
    for key, cfg in ordered:
        h, m = _parse_hhmm(cfg["start"])
        start_dt = datetime(now_dt.year, now_dt.month, now_dt.day, h, m, 0, tzinfo=timezone.utc)
        today_sessions.append((key, cfg, int(start_dt.timestamp())))
    
    # Find current session: whose start <= now < next start
    for i, (key, cfg, start_ts) in enumerate(today_sessions):
        if i < len(today_sessions) - 1:
            next_start_ts = today_sessions[i + 1][2]
        else:
            # Last session of the day — next is first session of next day
            next_h, next_m = _parse_hhmm(ordered[0][1]["start"])
            next_dt = datetime(now_dt.year, now_dt.month, now_dt.day, next_h, next_m, 0, tzinfo=timezone.utc) + timedelta(days=1)
            next_start_ts = int(next_dt.timestamp())
        
        if start_ts <= now_ts < next_start_ts:
            result = {
                "key": key,
                "name": cfg.get("name", key),
                "start_ts": start_ts,
                "end_ts": next_start_ts,
                "color": cfg.get("color", "#888888"),
            }
            _session_vp_cache["result"] = result
            _session_vp_cache_ts = now
            return result
    
    # Between midnight and first session — no active session
    _session_vp_cache["result"] = None
    _session_vp_cache_ts = now
    return None


def compute_session_volume_profile(
    coin: str,
    timeframe: str,
    rows: int | None = None,
) -> dict | None:
    """Compute a volume profile for the currently active trading session only.

    Returns a dict with session info and volume profile bins, or ``None`` if
    no session is active (e.g. between midnight and the first session start)::

        {
            "session_key": "london",
            "session_name": "London",
            "start_time": 1700000000,
            "end_time": 1700000000,
            "color": "#7B68EE",
            "rows": [...],
            "max_volume": float,
            "poc_price": float,
        }
    """
    try:
        return _compute_session_vp_impl(coin, timeframe, rows)
    except Exception as e:
        log.error("Session VP computation failed for %s %s: %s", coin, timeframe, e)
        return None


def _compute_session_vp_impl(
    coin: str,
    timeframe: str,
    rows: int | None,
    df=None,
) -> dict | None:
    from datetime import datetime, timezone
    
    n_rows = rows or 100
    session_info = _get_current_session_info()
    if session_info is None:
        return None
    
    if df is None:
        df = load_candles_df(coin, timeframe)
    if df.empty:
        return None
    
    df["time"] = df["time"].astype(int)
    
    now_ts = int(datetime.now(timezone.utc).timestamp())
    
    # Filter candles: from session start to either next session start or now
    end_ts = min(session_info["end_ts"], now_ts)
    mask = (df["time"] >= session_info["start_ts"]) & (df["time"] < end_ts)
    session_df = df[mask].copy()
    
    if session_df.empty:
        return None
    
    profile = _compute_bins(session_df, n_rows)
    
    latest_candle_ts = int(session_df["time"].max())
    
    return {
        "session_key": session_info["key"],
        "session_name": session_info["name"],
        "start_time": session_info["start_ts"],
        "end_time": latest_candle_ts,
        "color": session_info["color"],
        "rows": profile["rows"],
        "max_volume": profile["max_volume"],
        "poc_price": profile["poc_price"],
    }
