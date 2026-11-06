"""Exchange catalog shared by the settings UI, credentials and trading layer.

The catalog lives in ``shared/exchanges.json`` so the Rust shell (OS keyring)
and the Python sidecar agree on credential keys, labels and networks. The
Tauri shell embeds the same file at compile time; the sidecar loads it from the
repository or the PyInstaller bundle.

No secret value is ever read at import time.
"""

from __future__ import annotations

import json
import os
import re
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

MARKET_LABELS = {"spot": "Spot", "futures": "Perpetual"}
DEFAULT_EXCHANGE = "hyperliquid"
DEFAULT_MARKET = "futures"
NETWORKS = ("testnet", "live")


class SpecError(RuntimeError):
    """The bundled exchange catalog is missing or malformed."""


@dataclass(frozen=True)
class ExchangeField:
    key: str
    label: str
    secret: bool
    kind: str
    multiline: bool = False


@dataclass(frozen=True)
class ExchangeSpec:
    id: str
    name: str
    prefix: str
    markets: dict[str, str]
    passphrase: bool
    wallet: bool
    networks: tuple[str, ...]
    fields: tuple[ExchangeField, ...]

    @property
    def default_network(self) -> str:
        return "testnet" if "testnet" in self.networks else self.networks[0]

    def required_fields(self) -> tuple[ExchangeField, ...]:
        return tuple(field for field in self.fields if field.kind != "choice")

    def network_field(self) -> ExchangeField | None:
        return next((field for field in self.fields if field.kind == "choice"), None)


def _catalog_path() -> Path:
    candidates: list[Path] = []
    override = os.environ.get("TRADEPANEL_EXCHANGE_CATALOG")
    if override:
        candidates.append(Path(override).expanduser())
    bundled = getattr(sys, "_MEIPASS", None)
    if bundled:
        candidates.append(Path(bundled) / "shared" / "exchanges.json")
    candidates.append(Path(__file__).resolve().parents[2] / "shared" / "exchanges.json")
    candidates.append(Path(sys.executable).resolve().parent / "shared" / "exchanges.json")
    for path in candidates:
        if path.is_file():
            return path
    raise SpecError(
        "shared/exchanges.json is missing; rebuild the app or restore the file"
    )


@lru_cache(maxsize=1)
def _load() -> tuple[ExchangeSpec, ...]:
    path = _catalog_path()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SpecError(f"Cannot read {path}: {exc}") from exc
    entries = raw.get("exchanges") if isinstance(raw, dict) else None
    if not isinstance(entries, list) or not entries:
        raise SpecError(f"{path} has no exchanges")
    out: list[ExchangeSpec] = []
    for entry in entries:
        try:
            markets = {
                str(market): str(ccxt_id)
                for market, ccxt_id in (entry.get("markets") or {}).items()
                if ccxt_id
            }
            networks = tuple(
                value for value in entry.get("networks", []) if value in NETWORKS
            )
            fields = tuple(
                ExchangeField(
                    key=str(field["key"]),
                    label=str(field["label"]),
                    secret=bool(field.get("secret")),
                    kind=str(field.get("kind", "text")),
                    multiline=bool(field.get("multiline", False)),
                )
                for field in entry.get("fields", [])
            )
            if not markets or not fields or not networks:
                raise ValueError("missing markets, fields or networks")
            out.append(
                ExchangeSpec(
                    id=str(entry["id"]),
                    name=str(entry["name"]),
                    prefix=str(entry["prefix"]),
                    markets=markets,
                    passphrase=bool(entry.get("passphrase", False)),
                    wallet=bool(entry.get("wallet", False)),
                    networks=networks,
                    fields=fields,
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise SpecError(f"Invalid exchange entry in {path}: {exc}") from exc
    return tuple(out)


EXCHANGES: tuple[ExchangeSpec, ...] = _load()
EXCHANGE_BY_ID: dict[str, ExchangeSpec] = {spec.id: spec for spec in EXCHANGES}
FIELD_BY_KEY: dict[str, ExchangeField] = {
    field.key: field for spec in EXCHANGES for field in spec.fields
}
FIELD_EXCHANGE: dict[str, str] = {
    field.key: spec.id for spec in EXCHANGES for field in spec.fields
}

# (env key, label, secret, group) — order defines the settings UI order.
FIELDS: tuple[tuple[str, str, bool, str], ...] = tuple(
    (field.key, field.label, field.secret, spec.name)
    for spec in EXCHANGES
    for field in spec.fields
)
SECRET_KEYS = frozenset(key for key, _label, secret, _group in FIELDS if secret)
KNOWN_KEYS = frozenset(FIELD_BY_KEY)

_HEX64 = re.compile(r"^(?:0x)?[0-9a-fA-F]{64}$")
_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")


def exchange(exchange_id: str) -> ExchangeSpec:
    spec = EXCHANGE_BY_ID.get(str(exchange_id or "").strip().lower())
    if spec is None:
        raise ValueError(f"Unknown exchange: {exchange_id}")
    return spec


def ccxt_id(exchange_id: str, market: str) -> str:
    spec = exchange(exchange_id)
    if market not in spec.markets:
        raise ValueError(f"{spec.name} does not support {market} trading")
    return spec.markets[market]


def supports_market(exchange_id: str, market: str) -> bool:
    spec = EXCHANGE_BY_ID.get(str(exchange_id or "").strip().lower())
    return bool(spec and market in spec.markets)


def default_network(exchange_id: str) -> str:
    return exchange(exchange_id).default_network


def network(exchange_id: str) -> str:
    """Active network from the environment, falling back to the safe default."""
    spec = exchange(exchange_id)
    field = spec.network_field()
    value = (os.environ.get(field.key, "") if field else "").strip().lower()
    return value if value in spec.networks else spec.default_network


def required_configured(exchange_id: str) -> bool:
    spec = exchange(exchange_id)
    return all(os.environ.get(field.key, "").strip() for field in spec.required_fields())


def missing_keys(exchange_id: str) -> list[str]:
    spec = exchange(exchange_id)
    return [
        field.label
        for field in spec.required_fields()
        if not os.environ.get(field.key, "").strip()
    ]


def credential_values(exchange_id: str) -> dict[str, str]:
    """Raw credential values for the ccxt client. Never log the result."""
    spec = exchange(exchange_id)
    out: dict[str, str] = {}
    for field in spec.required_fields():
        value = os.environ.get(field.key, "")
        if value:
            out[field.key] = value
    return out


def field_kind(key: str) -> str:
    field = FIELD_BY_KEY.get(key)
    return field.kind if field else "text"


def field_exchange(key: str) -> str:
    return FIELD_EXCHANGE.get(key, "")


def field_multiline(key: str) -> bool:
    field = FIELD_BY_KEY.get(key)
    return bool(field and field.multiline)


def validate_credential(key: str, value: str) -> None:
    """Validate a value without writing it anywhere."""
    field = FIELD_BY_KEY.get(key)
    if field is None:
        raise ValueError(f"Unknown credential: {key}")
    text = str(value)
    if field.kind == "choice":
        spec = exchange(FIELD_EXCHANGE[key])
        if text not in spec.networks:
            raise ValueError(
                f"{spec.name} network must be one of: {', '.join(spec.networks)}"
            )
        return
    if key == "HL_PRIVATE_KEY":
        if not _HEX64.fullmatch(text):
            raise ValueError(
                "Hyperliquid private key must be 64 hex characters (optional 0x prefix)"
            )
        return
    if key == "HL_ADDRESS":
        if not _ADDRESS.fullmatch(text):
            raise ValueError("Wallet address must be 0x followed by 40 hex characters")
        return
    controls = [ch for ch in text if ord(ch) < 0x20 or ord(ch) == 0x7F]
    if controls and not (field.multiline and all(ch in "\r\n\t" for ch in controls)):
        raise ValueError(f"{field.label} contains control characters")
    if not text.strip():
        raise ValueError(f"{field.label} must not be empty")
    limit = 4096 if field.secret and field.multiline else 512
    if len(text) > limit:
        raise ValueError(f"{field.label} is too long")
    if field.kind == "text" and len(text.strip()) < 8:
        # Exchange API keys are long; this catches accidental paste truncation
        # without imposing a format the venues do not document.
        raise ValueError(f"{field.label} looks too short")


def catalog() -> list[dict]:
    """Public exchange metadata for the settings UI (no secrets)."""
    out: list[dict] = []
    for spec in EXCHANGES:
        out.append(
            {
                "id": spec.id,
                "name": spec.name,
                "markets": [
                    {"id": market, "label": MARKET_LABELS.get(market, market.title()), "ccxt": ccxt}
                    for market, ccxt in spec.markets.items()
                ],
                "networks": list(spec.networks),
                "default_network": spec.default_network,
                "passphrase": spec.passphrase,
                "wallet": spec.wallet,
            }
        )
    return out
