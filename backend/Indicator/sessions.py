"""Session box indicator — Asian, London, NY AM, NY PM session ranges.

Computes the high/low of the first 30-minute candle in each trading session
using cached candle data from SQLite.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone, timedelta

import pandas as pd

from backend.Core.utils import load_candles_df

log = logging.getLogger(__name__)

# ── Session definitions (UTC HH:MM) ──────────────────────────────────────────
DEFAULT_SESSION_STARTS = {
    "asian":  {"name": "Asian",  "start": "01:00", "end": "07:00", "color": "#FFD700"},
    "london": {"name": "London", "start": "08:00", "end": "14:00", "color": "#7B68EE"},
    "ny_am":  {"name": "NY AM",  "start": "13:30", "end": "16:00", "color": "#FF6347"},
    "ny_pm":  {"name": "NY PM",  "start": "16:00", "end": "20:00", "color": "#00CED1"},
}

SESSIONS = {k: dict(v) for k, v in DEFAULT_SESSION_STARTS.items()}


def configure_session_starts(starts: dict[str, dict]) -> None:
    """Override session start/end times (HH:MM strings). Only known session keys accepted."""
    for key, vals in starts.items():
        if key not in SESSIONS:
            continue
        if "start" in vals:
            SESSIONS[key]["start"] = vals["start"]
        if "end" in vals:
            SESSIONS[key]["end"] = vals["end"]


def get_session_starts() -> dict[str, dict]:
    return {k: dict(v) for k, v in SESSIONS.items()}


def _parse_hhmm(value: str) -> tuple[int, int]:
    """Parse a HH:MM string into (hour, minute)."""
    try:
        parts = value.split(":")
        return int(parts[0]) % 24, int(parts[1]) % 60
    except Exception:
        return 0, 0


# ── Helpers ──────────────────────────────────────────────────────────────────

def _parse_timeframe_minutes(tf: str) -> int | None:
    mapping = {
        "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
        "1h": 60, "2h": 120, "4h": 240, "6h": 360,
        "8h": 480, "12h": 720, "1d": 1440, "1w": 10080, "1M": 43200,
    }
    return mapping.get(tf)


def _get_session_start_utc(date: datetime, session_key: str) -> datetime:
    h, m = _parse_hhmm(SESSIONS[session_key]["start"])
    return datetime(
        date.year, date.month, date.day,
        h, m, 0,
        tzinfo=timezone.utc,
    )


def _get_session_end_utc(date: datetime, session_key: str) -> datetime:
    """Return the configured end time for high/low calculation (UTC)."""
    h, m = _parse_hhmm(SESSIONS[session_key]["end"])
    end = datetime(
        date.year, date.month, date.day,
        h, m, 0,
        tzinfo=timezone.utc,
    )
    start = _get_session_start_utc(date, session_key)
    if end <= start:
        end += timedelta(days=1)
    return end


def _find_session_high_low(
    df: pd.DataFrame,
    session_start_ts: int,
    session_end_ts: int,
) -> dict | None:
    """Return the high/low of all candles within the session start/end window."""
    mask = (df["time"] >= session_start_ts) & (df["time"] <= session_end_ts)
    session_candles = df[mask]
    if session_candles.empty:
        return None
    return {
        "time": int(session_start_ts),
        "high": float(session_candles["high"].max()),
        "low": float(session_candles["low"].min()),
    }


# ── Public API ───────────────────────────────────────────────────────────────

def compute_session_boxes(
    coin: str,
    timeframe: str,
    visible_start_ts: int | None = None,
    visible_end_ts: int | None = None,
) -> dict[str, list[dict]]:
    """Compute session boxes from cached candle data.

    Returns a dict mapping session keys to lists of box data:
        {"asian": [...], "london": [...], "ny_am": [...], "ny_pm": [...]}
    """
    try:
        return _compute_session_boxes_impl(coin, timeframe, visible_start_ts, visible_end_ts)
    except Exception as e:
        log.error("Session box computation failed for %s %s: %s", coin, timeframe, e)
        return {key: [] for key in SESSIONS}


# ── Internal ─────────────────────────────────────────────────────────────────

def _next_session_start(current_date: datetime.date, current_key: str) -> tuple[datetime.date, str, datetime]:
    """Return (date, key, datetime) of the next session start after the given session."""
    # Sort sessions by start time to determine the next session in the daily cycle.
    ordered = sorted(
        SESSIONS.items(),
        key=lambda item: _parse_hhmm(item[1]["start"])[0] * 60 + _parse_hhmm(item[1]["start"])[1],
    )
    keys = [k for k, _ in ordered]
    try:
        idx = keys.index(current_key)
    except ValueError:
        idx = -1

    if 0 <= idx < len(keys) - 1:
        next_key = keys[idx + 1]
        next_date = current_date
    else:
        next_key = keys[0]
        next_date = current_date + timedelta(days=1)

    h, m = _parse_hhmm(SESSIONS[next_key]["start"])
    next_dt = datetime(
        next_date.year, next_date.month, next_date.day,
        h, m, 0,
        tzinfo=timezone.utc,
    )
    return next_date, next_key, next_dt


def _compute_session_boxes_impl(
    coin: str,
    timeframe: str,
    visible_start_ts: int | None,
    visible_end_ts: int | None,
    df=None,
) -> dict[str, list[dict]]:
    tf_minutes = _parse_timeframe_minutes(timeframe)
    if tf_minutes is None:
        log.warning("Cannot parse timeframe: %s", timeframe)
        return {key: [] for key in SESSIONS}

    if df is None:
        df = load_candles_df(coin, timeframe)

    if df.empty:
        return {key: [] for key in SESSIONS}

    min_ts = int(df["time"].min())
    max_ts = int(df["time"].max())

    if visible_start_ts is not None:
        min_ts = max(min_ts, visible_start_ts - 86400 * 7)
    if visible_end_ts is not None:
        max_ts = min(max_ts, visible_end_ts + 86400)

    start_date = datetime.fromtimestamp(min_ts, tz=timezone.utc).date()
    end_date = datetime.fromtimestamp(max_ts, tz=timezone.utc).date()

    results = {key: [] for key in SESSIONS}

    current_date = start_date
    while current_date <= end_date:
        for session_key, session_cfg in SESSIONS.items():
            session_start = _get_session_start_utc(current_date, session_key)
            session_start_ts = int(session_start.timestamp())

            if session_start_ts > max_ts:
                continue
            if session_start_ts < min_ts - 1800:
                continue

            session_end = _get_session_end_utc(current_date, session_key)
            session_end_ts = int(session_end.timestamp())

            candle = _find_session_high_low(df, session_start_ts, session_end_ts)
            if candle:
                _, _, next_start_dt = _next_session_start(current_date, session_key)
                next_start_ts = int(next_start_dt.timestamp())
                # Clamp box end to available data range.
                end_time = min(next_start_ts, max_ts)

                box = {
                    "time": candle["time"],
                    "high": candle["high"],
                    "low": candle["low"],
                    "end_time": end_time,
                    "color": session_cfg["color"],
                    "name": session_cfg["name"],
                }
                results[session_key].append(box)

        current_date += timedelta(days=1)

    return results
