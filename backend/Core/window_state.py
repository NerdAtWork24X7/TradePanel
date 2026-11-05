"""Window state persistence — save/restore UI state across sessions.

Stores the selected coin, timeframe, favorites, trade panel values, and
toggle states in data/window_state.json.
"""

from __future__ import annotations

import json
import logging

from backend.Core.config import DATA_DIR

log = logging.getLogger(__name__)

STATE_FILE = DATA_DIR / "window_state.json"


def load_window_state() -> dict:
    """Load saved window state, returning defaults for missing keys."""
    defaults = {
        "coin": "",
        "timeframe": "5m",
        "favorites": [],
        "risk": "10",
        "is_short": False,
        "hyperliquid": False,
        "fvg_enabled": False,
        "limit": "",
        "tp": "",
        "sl": "",
        "vwap_visible": False,
        "session_asian_visible": False,
        "session_london_visible": False,
        "session_ny_am_visible": False,
        "session_ny_pm_visible": False,
        "fvg_chart_visible": False,
    }
    if STATE_FILE.exists():
        try:
            with open(STATE_FILE, "r") as f:
                saved = json.load(f)
            defaults.update(saved)
        except Exception as e:
            log.error("Failed to load window state: %s", e)
    return defaults


def save_window_state(state: dict) -> None:
    """Persist window state to disk."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    log.debug("Window state saved.")
