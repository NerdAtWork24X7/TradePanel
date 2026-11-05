"""Qt-free trading operations shared by the desktop UI and the Tauri sidecar.

This module is the single implementation of "act on Hyperliquid" behaviour:
price-precision rounding, TP/SL updates, limit order placement and position
snapshots. It never touches Qt, so it can be exercised headlessly and published
through the sidecar's JSON-RPC surface.

The functions keep the exact semantics of the original ``UI/handlers`` code:
``place_order`` replaces existing open orders for the coin (the SDK wrapper
skips placement when an identical order + TP + SL already exists), and
``update_tp_sl`` cancels and re-creates trigger orders only when they differ.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from backend.Core import calculations, config
from backend.Core.models import OrderParams
from backend.Exchange.hyperliquid import HyperliquidClient

log = logging.getLogger(__name__)

_COIN_RE_MAX = 20


class TradingUnavailable(RuntimeError):
    """Raised when credentials are missing or invalid."""


class TradingInputError(ValueError):
    """Raised when order inputs are missing, non-finite or inconsistent."""


def reset_client() -> None:
    """Drop the cached Hyperliquid SDK client so new credentials apply live."""
    try:
        HyperliquidClient.reset()
    except Exception:  # pragma: no cover - defensive
        log.debug("Hyperliquid client reset failed", exc_info=True)


def credentials_configured() -> bool:
    """True when a usable Hyperliquid private key is present."""
    key = (config.HL_PRIVATE_KEY or "").strip()
    return bool(key) and key != "YOUR_PRIVATE_KEY_HERE"


def _client() -> HyperliquidClient:
    if not credentials_configured():
        raise TradingUnavailable(
            "Hyperliquid private key is not configured. Add it in Settings → Credentials."
        )
    try:
        return HyperliquidClient()
    except RuntimeError as exc:
        raise TradingUnavailable(str(exc)) from exc


def _positive(name: str, value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise TradingInputError(f"{name} must be a number") from exc
    if not math.isfinite(number) or number <= 0:
        raise TradingInputError(f"{name} must be a positive finite number")
    return number


def _round_to_exchange(coin: str, *prices: float) -> tuple[float, ...]:
    """Round prices to the coin's Hyperliquid perp tick (5 sig figs, 6-szDecimals dp)."""
    sz = HyperliquidClient.get_sz_decimals(coin)
    rounded = tuple(calculations.round_exchange_price(p, sz) for p in prices)
    log.info("Rounded prices to HL precision (szDecimals=%d): %s", sz, rounded)
    return rounded


def place_order(
    coin: str,
    is_buy: bool,
    qty: float,
    limit_price: float,
    tp_price: float,
    sl_price: float,
) -> tuple[bool, str]:
    """Place a limit order with TP/SL. Returns ``(success, message)``."""
    coin = str(coin or "").strip()
    if not coin or len(coin) > _COIN_RE_MAX:
        raise TradingInputError("Invalid coin")
    qty = _positive("qty", qty)
    limit_price = _positive("limit_price", limit_price)
    tp_price = _positive("tp_price", tp_price)
    sl_price = _positive("sl_price", sl_price)
    if sl_price == limit_price:
        raise TradingInputError("Entry and stop-loss must differ")

    client = _client()
    limit_price, tp_price, sl_price = _round_to_exchange(
        coin, limit_price, tp_price, sl_price
    )
    if sl_price == limit_price:
        raise TradingInputError(
            "Entry and stop-loss collapse at the exchange price tick — widen the levels"
        )
    if tp_price in (limit_price, sl_price):
        raise TradingInputError(
            "Take-profit is too close to another level for the exchange price tick"
        )
    params = OrderParams(
        coin=coin,
        is_buy=bool(is_buy),
        qty=qty,
        limit_price=limit_price,
        tp_price=tp_price,
        sl_price=sl_price,
    )
    result = client.place_order(params)
    if result.success:
        log.info("Order placed for %s", coin)
        return True, "Order placed"
    log.error("Order failed for %s: %s", coin, result.error)
    return False, f"Order failed: {result.error}"


def update_tp_sl(coin: str, is_short: bool, tp: float, sl: float) -> tuple[bool, str]:
    """Update TP/SL on an existing position. Returns ``(success, message)``."""
    coin = str(coin or "").strip()
    if not coin or len(coin) > _COIN_RE_MAX:
        raise TradingInputError("Invalid coin")
    tp = _positive("tp", tp)
    sl = _positive("sl", sl)

    client = _client()
    pos = client.get_position(coin)
    qty = abs(pos.size)
    if qty <= 0:
        return False, f"No open position for {coin}"

    tp, sl = _round_to_exchange(coin, tp, sl)
    if tp == sl:
        raise TradingInputError(
            "TP and SL collapse at the exchange price tick — widen the levels"
        )
    result = client.update_tp_sl(coin, not bool(is_short), qty, tp, sl)
    if result.success:
        msg = f"TP/SL updated for {coin}: tp={tp} sl={sl}"
        log.info(msg)
        return True, msg
    msg = f"TP/SL update failed for {coin}: {result.error}"
    log.error(msg)
    return False, msg


def position_snapshot(coin: str) -> dict:
    """Return the open position (or a no-position payload) for *coin*.

    Missing TP/SL on an open position are filled with the same quick-parameter
    defaults the Qt panel used, so the trade inputs stay actionable.
    """
    coin = str(coin or "").strip()
    if not coin or len(coin) > _COIN_RE_MAX:
        raise TradingInputError("Invalid coin")
    client = _client()
    pos = client.get_position(coin)
    entry = pos.entry_price
    tp = pos.tp_price
    sl = pos.sl_price
    is_short = pos.size < 0
    if entry and not tp and not sl:
        if is_short:
            _, tp, sl = calculations.quick_short_params(entry)
        else:
            _, tp, sl = calculations.quick_long_params(entry)
        log.info(
            "Calculated default TP=%s SL=%s for %s position",
            tp, sl, "SHORT" if is_short else "LONG",
        )
    return {
        "coin": pos.coin,
        "has_position": bool(pos.has_position),
        "entry": entry,
        "tp": tp,
        "sl": sl,
        "size": pos.size,
        "pnl": pos.unrealized_pnl,
    }


def open_orders(coin: str) -> list[dict]:
    """Read-only reconciliation helper: open orders for *coin*."""
    coin = str(coin or "").strip()
    if not coin or len(coin) > _COIN_RE_MAX:
        raise TradingInputError("Invalid coin")
    client = _client()
    orders = client._info.frontend_open_orders(client._address) or []
    out = []
    for order in orders:
        if order.get("coin") != coin:
            continue
        out.append(
            {
                "oid": order.get("oid"),
                "side": order.get("side"),
                "size": order.get("sz"),
                "limitPrice": order.get("limitPx"),
                "triggerPrice": order.get("triggerPx"),
                "isTrigger": bool(order.get("isTrigger")),
                "reduceOnly": bool(order.get("reduceOnly")),
                "timestamp": order.get("timestamp"),
            }
        )
    return out


def sz_decimals(coin: str) -> int:
    return HyperliquidClient.get_sz_decimals(str(coin or "").strip())


def price_precision(coin: str) -> dict[str, int | str]:
    """Exchange price precision for *coin*, shared with the UI formatters."""
    name = str(coin or "").strip()
    sz = HyperliquidClient.get_sz_decimals(name)
    return {
        "coin": name,
        "sz_decimals": sz,
        "price_decimals": calculations.price_decimals(sz),
        "price_sig_figs": calculations.PRICE_SIG_FIGS,
    }


def calculate_qty(risk: float, entry: float, sl: float, is_short: bool, coin: str) -> float:
    """Risk-based quantity, rounded with the coin's exchange precision."""
    risk = _positive("risk", risk)
    entry = _positive("entry", entry)
    sl = _positive("sl", sl)
    if entry == sl:
        raise TradingInputError("Entry and stop-loss are the same — infinite risk")
    return calculations.calculate_qty(
        risk, entry, sl, bool(is_short), sz_decimals(coin)
    )
