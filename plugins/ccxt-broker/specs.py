"""The venues this broker plugin can serve, read from ``specs.json``.

One process handles one venue: the manifest names it (`--venue`, or the app's plugin id
when the package was started without one), and every ccxt id, network and credential
field of that venue comes from here. The Node installer and ``build.py`` read the same
file, so a venue is added once.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

CATALOG = Path(__file__).resolve().parent / "specs.json"
MARKET_LABELS = {"futures": "perpetual futures", "spot": "spot"}
NETWORKS = ("testnet", "live")


class SpecError(RuntimeError):
    """The bundled venue catalog is missing or malformed."""


@dataclass(frozen=True)
class Venue:
    id: str
    code: str
    name: str
    markets: dict[str, str]
    networks: tuple[str, ...]
    passphrase: bool
    description: str
    setup: str

    @property
    def default_market(self) -> str:
        return "futures" if "futures" in self.markets else "spot"

    @property
    def default_network(self) -> str:
        return "testnet" if "testnet" in self.networks else "live"

    @property
    def market_label(self) -> str:
        return MARKET_LABELS.get(self.default_market, self.default_market)

    def ccxt_id(self, market: str) -> str:
        try:
            return self.markets[market]
        except KeyError as exc:
            raise SpecError(f"{self.name} does not trade {market}") from exc


def _parse(entry: dict[str, Any]) -> Venue:
    markets = {str(key): str(value) for key, value in (entry.get("markets") or {}).items() if value}
    networks = tuple(value for value in entry.get("networks", []) if value in NETWORKS)
    if not markets or not networks:
        raise SpecError(f"{entry.get('id')}: a venue needs markets and networks")
    unknown = set(markets) - {"spot", "futures"}
    if unknown:
        raise SpecError(f"{entry.get('id')}: unknown market {sorted(unknown)[0]}")
    code = str(entry["code"]).upper()
    if not (2 <= len(code) <= 16) or not all(c.isalnum() or c == "_" for c in code):
        raise SpecError(f"{entry.get('id')}: {code} is not an exchange code")
    return Venue(
        id=str(entry["id"]),
        code=code,
        name=str(entry["name"]),
        markets=markets,
        networks=networks,
        passphrase=bool(entry.get("passphrase", False)),
        description=str(entry.get("description") or ""),
        setup=str(entry.get("setup") or ""),
    )


@lru_cache(maxsize=1)
def catalog() -> dict[str, Any]:
    try:
        raw = json.loads(CATALOG.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SpecError(f"Cannot read {CATALOG}: {exc}") from exc
    venues = raw.get("venues") if isinstance(raw, dict) else None
    if not isinstance(venues, list) or not venues:
        raise SpecError(f"{CATALOG} has no venues")
    return raw


@lru_cache(maxsize=1)
def venues() -> tuple[Venue, ...]:
    return tuple(_parse(entry) for entry in catalog()["venues"])


def venue(venue_id: str | None = None) -> Venue:
    """The venue by id; without one, the plugin's id from the environment, else the first."""
    wanted = str(venue_id or "").strip().lower()
    if not wanted:
        import os  # noqa: PLC0415 - only needed when the entry point names no venue

        wanted = (os.environ.get("OPENTRADER_PLUGIN_ID") or "").strip().lower()
    for item in venues():
        if item.id == wanted:
            return item
    if not wanted:
        return venues()[0]
    raise SpecError(f"Unknown venue {wanted!r}; expected one of {', '.join(v.id for v in venues())}")
