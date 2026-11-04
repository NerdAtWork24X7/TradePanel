"""Coin list fetching and persistence.

Fetches the intersection of Hyperliquid and Binance USDT pairs,
and caches the result in data/coins.json.
"""

from __future__ import annotations

import json
import requests

from Core.config import COINS_FILE


def fetch_common_coins() -> list[str]:
    """Fetch coins that exist on both Hyperliquid and Binance (USDT pairs).

    Returns a sorted list of coin names using Hyperliquid naming.
    """
    # Hyperliquid coins
    hl_resp = requests.post(
        "https://api.hyperliquid.xyz/info",
        json={"type": "metaAndAssetCtxs"},
    )
    hl_resp.raise_for_status()
    hl_data = hl_resp.json()
    hl_coins = [asset["name"] for asset in hl_data[0]["universe"]]

    # Binance USDT coins
    bn_resp = requests.get("https://api.binance.com/api/v3/exchangeInfo")
    bn_resp.raise_for_status()
    bn_data = bn_resp.json()
    bn_coins = [
        s["baseAsset"]
        for s in bn_data["symbols"]
        if s["status"] == "TRADING" and s["quoteAsset"] == "USDT"
    ]

    # Intersection (case-insensitive, keep Hyperliquid naming)
    hl_lower_map = {c.lower(): c for c in hl_coins}
    intersection = sorted(
        [hl_lower_map[b.lower()] for b in set(bn_coins) if b.lower() in hl_lower_map]
    )
    return intersection


def load_coins() -> list[str]:
    """Load coin list from disk, or fetch if missing."""
    if COINS_FILE.exists():
        with open(COINS_FILE, "r") as f:
            data = json.load(f)
        return data.get("Hyperliquid", {}).get("coin", [])
    return fetch_common_coins()


def save_coins(coins: list[str]) -> None:
    """Persist coin list to disk."""
    COINS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(COINS_FILE, "w") as f:
        json.dump({"Hyperliquid": {"coin": coins}}, f, indent=2)
        f.write("\n")


def refresh_coins() -> list[str]:
    """Fetch fresh coin list and persist it. Returns the new list."""
    coins = fetch_common_coins()
    save_coins(coins)
    return coins
