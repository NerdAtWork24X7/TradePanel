"""Build each venue's ``opentrader-plugin.json`` from ``specs.json``.

The plugin itself is one program; the app identifies a broker by its manifest, so each
venue is packaged with its own manifest (id, exchange code, credential fields, setup
steps). ``manifests.json`` holds all of them, written by::

    python plugins/ccxt-broker/manifests.py --write

and checked against this generator by the tests: edit ``specs.json``, not the artifact.
``build.py`` and the Node installer read the artifact, so neither repeats this logic.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from specs import Venue, catalog, venues

OUT = Path(__file__).resolve().parent / "manifests.json"
API = 2
MARKET_LABELS = {"futures": "Perpetual futures", "spot": "Spot"}
NETWORK_LABELS = {"testnet": "Testnet (paper)", "live": "Live — real funds"}


def settings_for(venue: Venue) -> list[dict[str, Any]]:
    """The fields the user fills in, in the order the Exchanges tab shows them."""
    fields: list[dict[str, Any]] = [
        {
            "key": "apiKey",
            "label": "API key",
            "type": "secret",
            "default": "",
            "help": f"The {venue.name} API key. Give it trading and read permission, never withdrawals. Stored in the operating system's credential store.",
        },
        {
            "key": "apiSecret",
            "label": "API secret",
            "type": "secret",
            "default": "",
            "help": f"The secret that goes with the {venue.name} API key. Stored in the operating system's credential store.",
        },
    ]
    if venue.passphrase:
        fields.append({
            "key": "passphrase",
            "label": "API passphrase",
            "type": "secret",
            "default": "",
            "help": "The passphrase chosen when the API key was created. Stored in the operating system's credential store.",
        })
    # Both fields always show, even with one choice: the pane states which network and
    # market the venue trades, and the broker card reads the market from them.
    fields.append({
        "key": "network",
        "label": "Network",
        "type": "select",
        "default": venue.default_network,
        "options": [{"value": item, "label": NETWORK_LABELS[item]} for item in venue.networks],
        "help": "Testnet trades paper funds on the venue's test network. Live orders are still confirmed by OpenTrader before they are sent.",
    })
    fields.append({
        "key": "market",
        "label": "Market",
        "type": "select",
        "default": venue.default_market,
        "options": [{"value": item, "label": MARKET_LABELS[item]} for item in venue.markets],
        "help": "One market per broker: switch it here and the account follows. Spot is long-only and has no position brackets.",
    })
    fields.append({
        "key": "pollSeconds",
        "label": "Refresh (seconds)",
        "type": "number",
        "default": "3",
        "help": "How often the account, its orders and the ticket's quotes are refreshed.",
    })
    return fields


def manifest_for(venue: Venue, raw: dict[str, Any] | None = None) -> dict[str, Any]:
    meta = raw or catalog()
    return {
        "id": venue.id,
        "name": venue.name,
        "version": str(meta.get("version") or "0.1.0"),
        "publisher": str(meta.get("publisher") or "TradePanel"),
        "description": venue.description,
        "api": API,
        "provides": ["broker"],
        # A broker's venue: the Exchanges tab files this card under that exchange.
        "exchange": venue.code,
        "runtime": {"type": "process", "entry": "plugin.py", "args": ["--venue", venue.id]},
        "settings": settings_for(venue),
        "setup": venue.setup,
        "homepage": str(meta.get("homepage") or ""),
        "platforms": [],
    }


def all_manifests() -> dict[str, dict[str, Any]]:
    raw = catalog()
    return {venue.id: manifest_for(venue, raw) for venue in venues()}


def read() -> dict[str, dict[str, Any]]:
    """The generated manifests: one per venue, keyed by plugin id."""
    try:
        return json.loads(OUT.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SystemExit(f"Cannot read {OUT}: {exc} (run `python {Path(__file__).name} --write`)") from exc


def main(argv: list[str] | None = None) -> int:
    import sys

    args = list(sys.argv[1:] if argv is None else argv)
    manifests = all_manifests()
    if "--venue" in args:
        wanted = args[args.index("--venue") + 1] if args.index("--venue") + 1 < len(args) else ""
        for venue_id, manifest in manifests.items():
            if venue_id == wanted:
                print(json.dumps(manifest, indent=2, ensure_ascii=False))
                return 0
        print(f"Unknown venue {wanted!r}; expected one of {', '.join(manifests)}", file=sys.stderr)
        return 1
    if "--write" in args:
        OUT.write_text(json.dumps(manifests, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"Wrote {OUT} ({len(manifests)} venues)")
        return 0
    print(json.dumps(manifests, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
