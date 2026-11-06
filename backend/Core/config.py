"""Centralized configuration for the Trade_Panel trading panel.

All paths, credentials, and default values live here.
Override via environment variables where noted.
"""

import os
import sys
from pathlib import Path

from dotenv import load_dotenv

# ── Resolve base directory (works frozen & dev) ──────────────────────────────
if getattr(sys, "frozen", False):
    # Running as PyInstaller bundle
    _BASE_DIR = Path(sys.executable).resolve().parent          # dir next to exe (writable)
else:
    # backend/Core/config.py → repo root (data/, keys/ and frontend/ live there)
    _BASE_DIR = Path(__file__).resolve().parents[2]

# Credentials live in keys/ (gitignored). Fall back to the legacy root .env.
# The Tauri shell sets TRADEPANEL_KEYS_DIR and TRADEPANEL_IGNORE_ENV_FILE so
# secrets come from the OS keyring instead of the plaintext file.
_env_keys_dir = os.environ.get("TRADEPANEL_KEYS_DIR")
KEYS_DIR = Path(_env_keys_dir).expanduser() if _env_keys_dir else _BASE_DIR / "keys"
if os.environ.get("TRADEPANEL_IGNORE_ENV_FILE") != "1":
    _env_file = KEYS_DIR / ".env"
    if not _env_file.exists():
        _env_file = _BASE_DIR / ".env"
    if _env_file.exists():
        load_dotenv(_env_file)

# ── Paths ────────────────────────────────────────────────────────────────────
ROOT_DIR = _BASE_DIR
# The Tauri shell owns the writable data directory (OS app-data location) and
# passes it to the sidecar. Unset means the legacy layout next to the code/exe.
_data_override = os.environ.get("TRADEPANEL_DATA_DIR")
DATA_DIR = Path(_data_override).expanduser() if _data_override else ROOT_DIR / "data"
COINS_FILE = DATA_DIR / "coins.json"


# ── Trading defaults ─────────────────────────────────────────────────────────
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
