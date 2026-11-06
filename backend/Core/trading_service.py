"""Qt-free trading operations shared by the desktop shell and the sidecar.

Two transport adapters cover every chart exchange:

* Hyperliquid **perpetuals** keep the native SDK client, which already encodes
  the venue's trigger-order and precision rules.
* Every other connection (all spot markets and the remaining venues) uses
  :mod:`backend.Exchange.ccxt_broker`, a ccxt-backed broker.

The module never touches Qt, never logs secrets, and keeps the original
"replace open orders for the coin" semantics for bracket submissions.
"""

from __future__ import annotations

import logging
import math
from typing import Any

from backend.Core import calculations, config
from backend.Core.models import OrderParams
from backend.Exchange import specs
from backend.Exchange.ccxt_broker import (
    BrokerError,
    BrokerInputError,
    BrokerUnavailable,
    broker as _ccxt_broker,
    reset_clients as _reset_ccxt_clients,
)
from backend.Exchange.hyperliquid import HyperliquidClient

log = logging.getLogger(__name__)

_COIN_RE_MAX = 40


class TradingUnavailable(RuntimeError):
    """Raised when credentials are missing, invalid or the venue is offline."""


class TradingInputError(ValueError):
    """Raised when order inputs are missing, non-finite or inconsistent."""


def _exchange(exchange: str, market: str) -> specs.ExchangeSpec:
    try:
        spec = specs.exchange(exchange)
    except ValueError as exc:
        raise TradingInputError(str(exc)) from exc
    if market not in spec.markets:
        raise TradingInputError(f"{spec.name} does not support {market} trading")
    return spec


def _uses_native_hyperliquid(exchange: str, market: str) -> bool:
    return exchange == "hyperliquid" and market == "futures"


def _broker(exchange: str, market: str):
    try:
        return _ccxt_broker(exchange, market)
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc


def reset_client() -> None:
    """Drop cached SDK clients so credential/network edits apply live."""
    try:
        HyperliquidClient.reset()
    except Exception:  # pragma: no cover - defensive
        log.debug("Hyperliquid client reset failed", exc_info=True)
    _reset_ccxt_clients()


def credentials_configured(
    exchange: str = specs.DEFAULT_EXCHANGE,
    market: str = specs.DEFAULT_MARKET,
) -> bool:
    """True when the active venue's required credentials are present."""
    try:
        spec = _exchange(exchange, market)
    except TradingInputError:
        return False
    if _uses_native_hyperliquid(exchange, market):
        key = (config.HL_PRIVATE_KEY or "").strip()
        return bool(key) and key != "YOUR_PRIVATE_KEY_HERE"
    return specs.required_configured(spec.id)


def _client() -> HyperliquidClient:
    if not credentials_configured("hyperliquid", "futures"):
        raise TradingUnavailable(
            "Hyperliquid private key is not configured. Add it in Settings → Exchange."
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


def _coin(coin: str) -> str:
    value = str(coin or "").strip()
    if not value or len(value) > _COIN_RE_MAX:
        raise TradingInputError("Invalid coin")
    return value


def _hl_coin(coin: str) -> str:
    """Hyperliquid's SDK addresses coins by base symbol (BTC), not BTC/USDC."""
    return coin.split("/", 1)[0]


def _round_to_exchange(coin: str, *prices: float) -> tuple[float, ...]:
    """Backward-compatible alias for the Hyperliquid perp precision rule."""
    return _round_hl(coin, *prices)


def _round_hl(coin: str, *prices: float) -> tuple[float, ...]:
    sz = HyperliquidClient.get_sz_decimals(coin)
    rounded = tuple(calculations.round_exchange_price(price, sz) for price in prices)
    log.info("Rounded prices to HL precision (szDecimals=%d): %s", sz, rounded)
    return rounded


def _round_broker(broker, coin: str, qty: float, *prices: float) -> tuple[float, tuple[float, ...]]:
    """Round base quantity (not contracts) and price levels to the venue tick."""
    _contracts, base_qty = broker.round_quantity(coin, qty, prices[0])
    rounded = tuple(broker.round_price(coin, price) for price in prices)
    return base_qty, rounded


def _collapse_guard(limit: float, tp: float, sl: float) -> None:
    if sl == limit:
        raise TradingInputError(
            "Entry and stop-loss collapse at the exchange price tick — widen the levels"
        )
    if tp in (limit, sl):
        raise TradingInputError(
            "Take-profit is too close to another level for the exchange price tick"
        )


def place_order(
    exchange: str,
    market: str,
    coin: str,
    is_buy: bool,
    qty: float,
    limit_price: float,
    tp_price: float,
    sl_price: float,
) -> tuple[bool, str]:
    """Place a limit order with TP/SL. Returns ``(success, message)``."""
    spec = _exchange(exchange, market)
    coin = _coin(coin)
    qty = _positive("qty", qty)
    limit_price = _positive("limit_price", limit_price)
    tp_price = _positive("tp_price", tp_price)
    sl_price = _positive("sl_price", sl_price)
    if sl_price == limit_price:
        raise TradingInputError("Entry and stop-loss must differ")

    if _uses_native_hyperliquid(exchange, market):
        coin = _hl_coin(coin)
        client = _client()
        limit_price, tp_price, sl_price = _round_hl(coin, limit_price, tp_price, sl_price)
        _collapse_guard(limit_price, tp_price, sl_price)
        result = client.place_order(
            OrderParams(
                coin=coin,
                is_buy=bool(is_buy),
                qty=qty,
                limit_price=limit_price,
                tp_price=tp_price,
                sl_price=sl_price,
            )
        )
        if result.success:
            log.info("Order placed for %s", coin)
            return True, "Order placed"
        log.error("Order failed for %s: %s", coin, result.error)
        return False, f"Order failed: {result.error}"

    adapter = _broker(exchange, market)
    try:
        base_qty, (limit_price, tp_price, sl_price) = _round_broker(
            adapter, coin, qty, limit_price, tp_price, sl_price
        )
        _collapse_guard(limit_price, tp_price, sl_price)
        result = adapter.place_order(
            OrderParams(
                coin=coin,
                is_buy=bool(is_buy),
                qty=base_qty,
                limit_price=limit_price,
                tp_price=tp_price,
                sl_price=sl_price,
            )
        )
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerError as exc:
        return False, f"{spec.name} order failed: {exc}"
    if result.success:
        if result.error:
            log.warning("Order placed with a warning on %s: %s", spec.name, result.error)
            return True, f"Order placed. {result.error}"
        log.info("Order placed for %s on %s", coin, spec.name)
        return True, "Order placed"
    log.error("Order failed for %s on %s: %s", coin, spec.name, result.error)
    return False, f"Order failed: {result.error}"


def update_tp_sl(
    exchange: str,
    market: str,
    coin: str,
    is_short: bool,
    tp: float,
    sl: float,
) -> tuple[bool, str]:
    """Update TP/SL on an existing position. Returns ``(success, message)``."""
    spec = _exchange(exchange, market)
    coin = _coin(coin)
    tp = _positive("tp", tp)
    sl = _positive("sl", sl)

    if _uses_native_hyperliquid(exchange, market):
        coin = _hl_coin(coin)
        client = _client()
        pos = client.get_position(coin)
        qty = abs(pos.size)
        if qty <= 0:
            return False, f"No open position for {coin}"
        tp, sl = _round_hl(coin, tp, sl)
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

    adapter = _broker(exchange, market)
    try:
        pos = adapter.position(coin)
        qty = abs(pos.size)
        if qty <= 0:
            return False, f"No open position for {coin} on {spec.name}"
        rounded_tp = adapter.round_price(coin, tp)
        rounded_sl = adapter.round_price(coin, sl)
        if rounded_tp == rounded_sl:
            raise TradingInputError(
                "TP and SL collapse at the exchange price tick — widen the levels"
            )
        result = adapter.update_tp_sl(coin, not bool(is_short), qty, rounded_tp, rounded_sl)
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerError as exc:
        return False, f"{spec.name} TP/SL update failed: {exc}"
    if result.success:
        message = f"TP/SL updated for {coin}: tp={rounded_tp} sl={rounded_sl}"
        if result.error:
            message += f" (warning: {result.error})"
        log.info(message)
        return True, message
    return False, f"TP/SL update failed for {coin}: {result.error}"


def position_snapshot(
    exchange: str,
    market: str,
    coin: str,
) -> dict:
    """Return the open position (or a no-position payload) for *coin*."""
    spec = _exchange(exchange, market)
    coin = _coin(coin)

    if _uses_native_hyperliquid(exchange, market):
        coin = _hl_coin(coin)
        client = _client()
        pos = client.get_position(coin)
        return _snapshot_payload(pos.coin, pos)

    adapter = _broker(exchange, market)
    try:
        pos = adapter.position(coin)
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerError as exc:
        raise TradingUnavailable(str(exc)) from exc
    payload = _snapshot_payload(pos.coin or coin.split("/")[0], pos)
    if spec.markets.get(market) and not payload["has_position"] and market == "spot":
        payload["note"] = "Spot accounts do not report positions; use Read order after a fill."
    return payload


def _snapshot_payload(coin: str, pos) -> dict:
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
        "coin": coin,
        "has_position": bool(pos.has_position),
        "entry": entry,
        "tp": tp,
        "sl": sl,
        "size": pos.size,
        "pnl": pos.unrealized_pnl,
    }


def open_orders(exchange: str, market: str, coin: str) -> list[dict]:
    """Read-only reconciliation helper: open orders for *coin*."""
    _exchange(exchange, market)
    coin = _coin(coin)

    if _uses_native_hyperliquid(exchange, market):
        coin = _hl_coin(coin)
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

    adapter = _broker(exchange, market)
    try:
        return adapter.open_orders(coin)
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerError as exc:
        raise TradingUnavailable(str(exc)) from exc


def test_connection(exchange: str, market: str) -> dict:
    """Fetch the account balance to prove the stored key works on the venue."""
    spec = _exchange(exchange, market)
    adapter = _broker(exchange, market)
    try:
        result = adapter.balance()
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerError as exc:
        raise TradingUnavailable(str(exc)) from exc
    result["label"] = f"{spec.name} {specs.MARKET_LABELS.get(market, market)}"
    return result


def sz_decimals(
    exchange: str = specs.DEFAULT_EXCHANGE,
    market: str = specs.DEFAULT_MARKET,
    coin: str = "",
) -> int:
    # Backwards compatibility: sz_decimals("BTC") from the old single-venue API.
    if coin == "" and exchange not in specs.EXCHANGE_BY_ID:
        coin, exchange, market = exchange, specs.DEFAULT_EXCHANGE, specs.DEFAULT_MARKET
    name = _coin(coin)
    _exchange(exchange, market)
    if _uses_native_hyperliquid(exchange, market):
        return HyperliquidClient.get_sz_decimals(_hl_coin(name))
    adapter = _broker(exchange, market)
    try:
        return adapter.instrument(name).sz_decimals
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc


def price_precision(
    exchange: str = specs.DEFAULT_EXCHANGE,
    market: str = specs.DEFAULT_MARKET,
    coin: str = "",
) -> dict[str, int | str]:
    """Exchange price precision for *coin*, shared with the UI formatters.

    ``price_precision("BTC")`` keeps working for the original single-venue API.
    """
    if coin == "" and exchange not in specs.EXCHANGE_BY_ID:
        coin, exchange, market = exchange, specs.DEFAULT_EXCHANGE, specs.DEFAULT_MARKET
    name = _coin(coin)
    _exchange(exchange, market)
    if _uses_native_hyperliquid(exchange, market):
        size = HyperliquidClient.get_sz_decimals(_hl_coin(name))
        return {
            "coin": _hl_coin(name),
            "sz_decimals": size,
            "price_decimals": calculations.price_decimals(size),
            "price_sig_figs": calculations.PRICE_SIG_FIGS,
        }
    adapter = _broker(exchange, market)
    try:
        info = adapter.instrument(name)
    except BrokerInputError as exc:
        raise TradingInputError(str(exc)) from exc
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    return {
        "coin": name,
        "sz_decimals": info.sz_decimals,
        "price_decimals": info.price_decimals,
        # Non-Hyperliquid venues publish a fixed tick, not a sig-fig rule;
        # 15 digits leaves the tick rounding as the only constraint.
        "price_sig_figs": 15,
    }


def calculate_qty(
    risk: float,
    entry: float,
    sl: float,
    is_short: bool,
    coin: str,
    exchange: str = specs.DEFAULT_EXCHANGE,
    market: str = specs.DEFAULT_MARKET,
) -> float:
    """Risk-based quantity, rounded with the coin's exchange precision."""
    risk = _positive("risk", risk)
    entry = _positive("entry", entry)
    sl = _positive("sl", sl)
    if entry == sl:
        raise TradingInputError("Entry and stop-loss are the same — infinite risk")
    return calculations.calculate_qty(
        risk, entry, sl, bool(is_short), sz_decimals(exchange, market, coin)
    )


def list_coins(exchange: str, market: str) -> list[str]:
    """Tradable base symbols for the active venue (public market data)."""
    _exchange(exchange, market)
    adapter = _broker(exchange, market)
    try:
        return adapter.instruments()
    except BrokerUnavailable as exc:
        raise TradingUnavailable(str(exc)) from exc
    except BrokerError as exc:
        raise TradingUnavailable(str(exc)) from exc


def exchange_catalog() -> list[dict]:
    """Static metadata for the settings surface (no credentials)."""
    return specs.catalog()
