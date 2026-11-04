"""Alert data persistence.

Reads/writes data/alerts.json.
"""

from __future__ import annotations

import json

from Core import config
from Core.models import CoinAlert


def load_alerts() -> dict[str, CoinAlert]:
    """Load all coin alerts from disk."""
    if not config.ALERTS_FILE.exists():
        return {}
    with open(config.ALERTS_FILE, "r") as f:
        raw = json.load(f)
    return {coin: CoinAlert.from_dict(data) for coin, data in raw.items()}


def save_alerts(alerts: dict[str, CoinAlert]) -> None:
    """Persist alerts to disk."""
    config.ALERTS_FILE.parent.mkdir(parents=True, exist_ok=True)
    raw = {coin: alert.to_dict() for coin, alert in alerts.items()}
    with open(config.ALERTS_FILE, "w") as f:
        json.dump(raw, f, indent=2)
        f.write("\n")


def get_or_create_alert(alerts: dict[str, CoinAlert], coin: str) -> CoinAlert:
    """Return existing alert for *coin*, or create a blank one."""
    if coin not in alerts:
        alerts[coin] = CoinAlert()
    return alerts[coin]


def update_fvg(alerts: dict[str, CoinAlert], coin: str, high: float, low: float) -> None:
    """Update FVG levels for a coin."""
    alert = get_or_create_alert(alerts, coin)
    alert.fvg.high = high
    alert.fvg.low = low
