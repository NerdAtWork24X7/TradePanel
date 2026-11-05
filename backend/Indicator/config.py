"""Indicator configuration persistence.

Stores FVG, VWAP, Session, and Line visibility settings
in data/indicator_config.json.
"""

from __future__ import annotations

import json
import logging

from backend.Core.config import DATA_DIR

log = logging.getLogger(__name__)

CONFIG_FILE = DATA_DIR / "indicator_config.json"

# ── Defaults ─────────────────────────────────────────────────────────────────
DEFAULT_CONFIG = {
    "fvg": {
        "gap_pct": 0.5,
        "enabled": False,
    },
    "vwap": {
        "anchor_intraday": "D",
        "anchor_daily": "W",
        "enabled": False,
    },
    "sessions": {
        "asian_start": "01:00",
        "asian_end": "07:00",
        "london_start": "08:00",
        "london_end": "14:00",
        "ny_am_start": "13:30",
        "ny_am_end": "16:00",
        "ny_pm_start": "16:00",
        "ny_pm_end": "20:00",
        "asian_enabled": False,
        "london_enabled": False,
        "ny_am_enabled": False,
        "ny_pm_enabled": False,
    },
    "ema_ribbon": {
        "ma_type": "EMA",
        "length1": 20,
        "length2": 40,
        "length3": 60,
        "enabled": False,
    },
    "volume_profile": {
        "length": 100,
        "rows": 24,
        "enabled": False,
    },
    "session_vp": {
        "enabled": False,
    },
    "hl_ema": {
        "length": 20,
        "enabled": False,
    },
    "adx": {
        "length": 14,
        "pane_height": 160,
        "levels": [25],
        "show_di_lines": False,
        "enabled": False,
    },
}


def _parse_hhmm(value: str) -> tuple[int, int]:
    """Parse a HH:MM string into (hour, minute)."""
    try:
        parts = value.split(":")
        return int(parts[0]) % 24, int(parts[1]) % 60
    except Exception:
        return 0, 0


def _migrate_session_config(sessions: dict) -> None:
    """Convert legacy hour/min/duration keys into HH:MM strings and strip them."""
    for key in ("asian", "london", "ny_am", "ny_pm"):
        start_key = f"{key}_start"
        end_key = f"{key}_end"
        start_h_key = f"{key}_start_hour"
        start_m_key = f"{key}_start_min"
        end_h_key = f"{key}_end_hour"
        end_m_key = f"{key}_end_min"
        dur_key = f"{key}_duration_hours"

        if start_h_key in sessions or start_m_key in sessions:
            h = int(sessions.pop(start_h_key, 0))
            m = int(sessions.pop(start_m_key, 0))
            sessions[start_key] = f"{h:02d}:{m:02d}"

        if end_h_key in sessions or end_m_key in sessions:
            h = int(sessions.pop(end_h_key, 0))
            m = int(sessions.pop(end_m_key, 0))
            sessions[end_key] = f"{h:02d}:{m:02d}"
        elif dur_key in sessions and start_key in sessions:
            # Derive end time from start + duration for very old configs.
            start_h, start_m = _parse_hhmm(sessions[start_key])
            start_min = start_h * 60 + start_m
            end_min = start_min + int(float(sessions[dur_key]) * 60)
            h, m = (end_min // 60) % 24, end_min % 60
            sessions[end_key] = f"{h:02d}:{m:02d}"

        sessions.pop(dur_key, None)


def load_indicator_config() -> dict:
    """Load indicator config from disk, falling back to defaults."""
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r") as f:
                saved = json.load(f)
            loaded = _deep_merge(DEFAULT_CONFIG.copy(), saved)
            _migrate_session_config(loaded.get("sessions", {}))
            return loaded
        except Exception as e:
            log.error("Failed to load indicator config: %s", e)
    return json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy


def save_indicator_config(cfg: dict) -> None:
    """Persist indicator config to disk."""
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(CONFIG_FILE, "w") as f:
        json.dump(cfg, f, indent=2)


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge override into base."""
    for key, value in override.items():
        if key in base and isinstance(base[key], dict) and isinstance(value, dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base
