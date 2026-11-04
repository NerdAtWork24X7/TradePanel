"""Centralized configuration for the Trade_Panel trading panel.

All paths, credentials, and default values live here.
Override via environment variables where noted.
"""

import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

# ── Resolve base directory (works frozen & dev) ──────────────────────────────
if getattr(sys, "frozen", False):
    # Running as PyInstaller bundle
    _BASE_DIR = Path(sys.executable).resolve().parent          # dir next to exe (writable)
    _INTERNAL = Path(sys._MEIPASS).resolve()                   # bundled read-only files
else:
    _BASE_DIR = Path(__file__).resolve().parent.parent
    _INTERNAL = _BASE_DIR

# Credentials live in keys/ (gitignored). Fall back to the legacy root .env.
KEYS_DIR = _BASE_DIR / "keys"
_env_file = KEYS_DIR / ".env"
if not _env_file.exists():
    _env_file = _BASE_DIR / ".env"
if _env_file.exists():
    load_dotenv(_env_file)

# ── Paths ────────────────────────────────────────────────────────────────────
ROOT_DIR = _BASE_DIR
DATA_DIR = ROOT_DIR / "data"
WEB_DIR = ROOT_DIR / "UI" / "web"            # writable web dir (next to exe)
BUNDLED_WEB_DIR = _INTERNAL / "UI" / "web"     # bundled web assets (read-only in frozen)
COINS_FILE = DATA_DIR / "coins.json"
ALERTS_FILE = DATA_DIR / "alerts.json"



_SAFE_TF_RE = re.compile(r"^[A-Za-z0-9]+$")


def candles_db_path(timeframe: str) -> Path:
    """Return the per-timeframe database path.

    e.g. data/candles_5m.db, data/candles_1m.db

    The timeframe is validated to prevent path traversal / injection.
    """
    if not isinstance(timeframe, str) or not _SAFE_TF_RE.fullmatch(timeframe):
        raise ValueError(f"Invalid timeframe: {timeframe!r}")
    return DATA_DIR / f"candles_{timeframe}.db"

# ── Window defaults ──────────────────────────────────────────────────────────
WINDOW_TITLE = "Trade Panel"
WINDOW_WIDTH = 1920
WINDOW_HEIGHT = 1080

# ── Trading defaults ─────────────────────────────────────────────────────────
DEFAULT_RISK = 10.0
DEFAULT_TIMEFRAME = "5m"
TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w", "1M"]

# Percentage offsets for quick Long/Short buttons
LONG_TP_PCT = 1.01      # +1%
LONG_SL_PCT = 0.995     # -0.5%
SHORT_TP_PCT = 0.99     # -1%
SHORT_SL_PCT = 1.005    # +0.5%

# ── Exchange credentials (loaded from .env) ─────────────────────────────────
HL_PRIVATE_KEY = ""
HL_ADDRESS = ""


def refresh_credentials() -> None:
    """Re-read credential globals from ``os.environ``.

    Called at import and after the UI writes ``keys/.env`` so new keys apply
    without restarting the app.
    """
    global HL_PRIVATE_KEY, HL_ADDRESS
    HL_PRIVATE_KEY = os.environ.get("HL_PRIVATE_KEY", "")
    HL_ADDRESS = os.environ.get("HL_ADDRESS", "")


refresh_credentials()

# ── Chart ────────────────────────────────────────────────────────────────────
REALTIME_UPDATE_INTERVAL_MS = 2000
