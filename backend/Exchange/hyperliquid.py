"""Hyperliquid exchange wrapper.

Encapsulates order placement logic so the UI never touches SDK objects directly.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

from eth_account import Account
from hyperliquid.info import Info
from hyperliquid.exchange import Exchange
from hyperliquid.utils import constants as hl_constants

from backend.Core import config
from backend.Core.models import OrderParams

# Also make OrderParams available from this module for backward compat

log = logging.getLogger(__name__)


def _make_info(base_url: str) -> Info:
    """Build a REST-only SDK client.

    ``Info`` starts a ``WebsocketManager`` thread (and its ping thread) unless
    ``skip_ws`` is set. Those threads are non-daemon, so the interpreter can
    never exit while they are alive — which used to leave the sidecar running
    forever and hang application shutdown. This backend only uses the HTTP
    endpoints (meta, mids, user state, open orders), so the socket is wasted
    anyway.
    """
    return Info(base_url, skip_ws=True)


@dataclass
class UpdateTpSlResult:
    """Result of updating TP/SL on an existing position."""
    success: bool
    cancel_response: dict | None = None
    tp_response: dict | None = None
    sl_response: dict | None = None
    error: str | None = None


@dataclass
class OrderResult:
    """Result of placing an order."""
    success: bool
    limit_response: dict | None = None
    sl_response: dict | None = None
    tp_response: dict | None = None
    error: str | None = None


@dataclass
class PositionData:
    """Open position data for a single coin."""
    coin: str
    entry_price: float | None = None
    size: float = 0.0        # positive = long, negative = short
    unrealized_pnl: float = 0.0
    tp_price: float | None = None
    sl_price: float | None = None
    has_position: bool = False
    mark_price: float | None = None  # current mid price (optional)


class HyperliquidClient:
    """Thin wrapper around the Hyperliquid SDK.

    The client is implemented as a singleton so the underlying Info/Exchange
    objects and the szDecimals cache are reused across the application. This
    avoids creating a new network-backed SDK object on every trade/position
    query.
    """

    # Cached szDecimals per coin: {"BTC": 5, "ETH": 4, ...}
    _sz_decimals_cache: dict[str, int] = {}
    _sz_decimals_lock = threading.RLock()
    _instance: HyperliquidClient | None = None
    _instance_lock = threading.Lock()

    def __new__(cls, private_key: str | None = None):
        with cls._instance_lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
            return cls._instance

    def __init__(self, private_key: str | None = None):
        # Avoid re-initialising the singleton; the SDK objects are stateful and
        # expensive to recreate.
        if getattr(self, "_initialized", False):
            return
        key = private_key or config.HL_PRIVATE_KEY
        if not key:
            raise RuntimeError(
                "Hyperliquid private key is not configured (set HL_PRIVATE_KEY)."
            )
        try:
            wallet = Account.from_key(key)
        except Exception as e:
            raise RuntimeError(
                "Failed to initialize Hyperliquid wallet (private key invalid)"
            ) from e
        self._info = _make_info(hl_constants.TESTNET_API_URL)
        self._exchange = Exchange(wallet, hl_constants.TESTNET_API_URL)
        self._address = config.HL_ADDRESS
        self._ensure_sz_decimals()
        self._initialized = True
        
    @classmethod
    def reset(cls) -> None:
        """Drop the cached SDK client so updated credentials take effect."""
        with cls._instance_lock:
            cls._instance = None
        with cls._sz_decimals_lock:
            cls._sz_decimals_cache.clear()

    @classmethod
    def _ensure_sz_decimals(cls) -> None:
        """Fetch and cache szDecimals for every coin from info.meta()."""
        with cls._sz_decimals_lock:
            if cls._sz_decimals_cache:
                return

        # Fetch outside the lock so other threads are not blocked during I/O.
        try:
            info = getattr(cls._instance, "_info", None) if cls._instance is not None else None
            if info is None:
                info = _make_info(hl_constants.TESTNET_API_URL)
            meta = info.meta()
        except Exception as e:
            log.error("Failed to fetch szDecimals meta: %s", e)
            return

        with cls._sz_decimals_lock:
            if cls._sz_decimals_cache:
                return
            try:
                for asset in meta.get("universe", []):
                    name = asset.get("name", "")
                    sz = asset.get("szDecimals", 0)
                    cls._sz_decimals_cache[name] = sz
                log.info("Cached szDecimals for %d coins", len(cls._sz_decimals_cache))
            except Exception as e:
                log.error("Failed to cache szDecimals: %s", e)

    @classmethod
    def get_sz_decimals(cls, coin: str) -> int:
        """Return the quantity decimal precision for *coin* (e.g. BTC=5, ETH=4)."""
        with cls._sz_decimals_lock:
            if not cls._sz_decimals_cache:
                cls._ensure_sz_decimals()
            return cls._sz_decimals_cache.get(coin, 4)  # sensible default

    def get_mid_price(self, coin: str) -> float | None:
        """Fetch the current mid-market price for *coin* from Hyperliquid.

        Returns the mid price, or None on failure.
        """
        try:
            mids = self._info.all_mids()
            if mids and coin in mids:
                return float(mids[coin])
            # Fallback: try with coin name variations
            for key, val in mids.items():
                if key.upper() == coin.upper():
                    return float(val)
            log.warning("No mid price found for %s in HL response", coin)
            return None
        except Exception as e:
            log.error("Failed to fetch mid price for %s: %s", coin, e)
            return None

    def get_position(self, coin: str) -> PositionData:
        """Fetch open position + TP/SL trigger orders for *coin*.

        Returns a PositionData with entry price, size, unrealized PnL,
        and any attached take-profit / stop-loss trigger prices.
        """
        result = PositionData(coin=coin)

        try:
            state = self._info.user_state(self._address)
            if not state or "assetPositions" not in state:
                return result

            # Find the position for the requested coin
            for ap in state["assetPositions"]:
                pos = ap.get("position", {})
                if pos.get("coin") != coin:
                    continue
                entry_px = pos.get("entryPx")
                result.entry_price = float(entry_px) if entry_px else None
                result.size = float(pos.get("szi", "0"))
                result.unrealized_pnl = float(pos.get("unrealizedPnl", "0"))
                result.has_position = result.size != 0.0
                break

            # Fetch frontend open orders to find TP/SL triggers.
            #
            # Strategy: collect ALL position TP/SL trigger prices first, then
            # assign SL vs TP based on position direction:
            #   - Long:  lower trigger = SL, higher = TP  (SL stops you out below)
            #   - Short: lower trigger = TP, higher = SL  (SL stops you out above)
            #
            # This handles trailing stop-loss correctly: when a trailing SL
            # moves above entry for a long, it's still the lower of the two
            # triggers (SL < TP always).
            trigger_prices: list[float] = []

            orders = self._info.frontend_open_orders(self._address)
            if orders:
                for o in orders:
                    if o.get("coin") != coin:
                        continue
                    if not o.get("isTrigger"):
                        continue
                    trigger_px = o.get("triggerPx")
                    if not trigger_px:
                        continue
                    price = float(trigger_px)

                    log.debug(
                        "Trigger order for %s: triggerPx=%s sz=%s triggerCondition=%s orderType=%s isPositionTpsl=%s",
                        coin, trigger_px, o.get("sz"),
                        o.get("triggerCondition"), o.get("orderType"),
                        o.get("isPositionTpsl"),
                    )
                    trigger_prices.append(price)

            if len(trigger_prices) == 2 and result.has_position:
                low, high = sorted(trigger_prices)
                if result.size > 0:
                    # Long: lower price = SL, higher price = TP
                    result.sl_price = low
                    result.tp_price = high
                else:
                    # Short: lower price = TP, higher price = SL
                    result.sl_price = high
                    result.tp_price = low
            elif len(trigger_prices) == 1 and result.has_position and result.entry_price:
                # Only one trigger — use entry-price heuristic as fallback
                price = trigger_prices[0]
                if result.size > 0:
                    if price > result.entry_price:
                        result.tp_price = price
                    else:
                        result.sl_price = price
                else:
                    if price < result.entry_price:
                        result.tp_price = price
                    else:
                        result.sl_price = price
            elif trigger_prices and not result.has_position:
                # No position yet — first trigger = TP, second = SL
                result.tp_price = trigger_prices[0]
                if len(trigger_prices) > 1:
                    result.sl_price = trigger_prices[1]

        except Exception as e:
            log.error("Failed to fetch position for %s: %s", coin, e)

        return result

    @staticmethod
    def _close_side_str(is_buy: bool) -> str:
        """Return the string side used to close a position ("A" or "B")."""
        return "A" if is_buy else "B"

    @staticmethod
    def _entry_side_str(is_buy: bool) -> str:
        """Return the string side used to open a position ("B" or "A")."""
        return "B" if is_buy else "A"

    @staticmethod
    def _same_value(a: float, b: float, tolerance: float = 1e-9) -> bool:
        """Compare two floats with a small tolerance."""
        return abs(a - b) <= tolerance

    def _is_same_trigger(
        self, order: dict, coin: str, side: str, qty: float, trigger_px: float
    ) -> bool:
        """Check whether *order* matches the requested trigger order."""
        if not order or order.get("coin") != coin:
            return False
        if not order.get("isTrigger"):
            return False
        if order.get("side") != side:
            return False
        try:
            order_sz = float(order.get("sz") or 0)
            order_px = float(order.get("triggerPx") or 0)
        except (TypeError, ValueError):
            return False
        return self._same_value(order_sz, qty) and self._same_value(order_px, trigger_px)

    def update_tp_sl(self, coin: str, is_buy: bool, qty: float, tp_price: float, sl_price: float) -> UpdateTpSlResult:
        """Update TP/SL trigger orders for *coin*, skipping if unchanged.

        Compares the requested TP/SL against currently open trigger orders.
        If they are identical, no new orders are created. Otherwise,
        existing trigger orders for the coin are cancelled and replaced.

        Args:
            coin: Coin symbol (e.g. "BTC").
            is_buy: True if the position is long (TP/SL will be sell-side).
            qty: Position size.
            tp_price: New take-profit price.
            sl_price: New stop-loss price.

        Returns:
            UpdateTpSlResult with exchange responses or error message.
        """
        try:
            close_side = self._close_side_str(is_buy)

            # Fetch open trigger orders for this coin
            orders = self._info.frontend_open_orders(self._address)
            trigger_orders = [
                o for o in (orders or [])
                if o.get("coin") == coin and o.get("isTrigger")
            ]

            # Find distinct matching orders for TP and SL
            matched_oids: set[int | str] = set()
            for target_price in (tp_price, sl_price):
                for o in trigger_orders:
                    if o.get("oid") in matched_oids:
                        continue
                    if self._is_same_trigger(o, coin, close_side, qty, target_price):
                        matched_oids.add(o.get("oid"))
                        break

            if len(matched_oids) == 2:
                log.info("TP/SL for %s unchanged; skipping update", coin)
                return UpdateTpSlResult(success=True)

            # Cancel all open trigger orders for this coin
            cancel_resp = None
            for o in trigger_orders:
                oid = o.get("oid")
                if oid is not None:
                    cancel_resp = self._exchange.cancel(coin, oid)
                    log.info("Cancelled trigger order %s for %s", oid, coin)

            close_side_bool = not is_buy  # closing side is opposite of position direction

            # Place new stop-loss trigger
            sl_resp = self._exchange.order(
                coin,
                close_side_bool,
                qty,
                sl_price,
                {"trigger": {"triggerPx": float(sl_price), "isMarket": True, "tpsl": "sl"}},
                reduce_only=True,
            )
            log.info("Placed new SL order for %s", coin)

            # Place new take-profit trigger
            tp_resp = self._exchange.order(
                coin,
                close_side_bool,
                qty,
                tp_price,
                {"trigger": {"triggerPx": float(tp_price), "isMarket": True, "tpsl": "tp"}},
                reduce_only=True,
            )
            log.info("Placed new TP order for %s", coin)

            return UpdateTpSlResult(
                success=True,
                cancel_response=cancel_resp,
                tp_response=tp_resp,
                sl_response=sl_resp,
            )
        except Exception as e:
            log.error("TP/SL update failed: %s", e)
            return UpdateTpSlResult(success=False, error=str(e))

    def _is_same_limit(
        self, order: dict, coin: str, side: str, qty: float, limit_price: float
    ) -> bool:
        """Check whether *order* matches the requested limit order."""
        if not order or order.get("coin") != coin:
            return False
        if order.get("isTrigger"):
            return False
        if order.get("side") != side:
            return False
        try:
            order_sz = float(order.get("sz") or 0)
            order_px = float(order.get("limitPx") or 0)
        except (TypeError, ValueError):
            return False
        return self._same_value(order_sz, qty) and self._same_value(order_px, limit_price)

    def place_order(self, params: OrderParams) -> OrderResult:
        """Place a limit order with TP and SL triggers, skipping duplicates.

        If an identical limit order and matching TP/SL triggers already
        exist, no new orders are submitted. Otherwise, existing open
        orders for the coin are cancelled and replaced.

        Args:
            params: Order parameters (coin, side, qty, prices).

        Returns:
            OrderResult with exchange responses or error message.
        """
        try:
            orders = self._info.frontend_open_orders(self._address) or []
            entry_side = self._entry_side_str(params.is_buy)
            close_side = self._close_side_str(params.is_buy)

            # Look for an matching limit order
            same_limit = any(
                self._is_same_limit(o, params.coin, entry_side, params.qty, params.limit_price)
                for o in orders
            )

            # Look for matching TP/SL triggers (closing side)
            same_tp = any(
                self._is_same_trigger(o, params.coin, close_side, params.qty, params.tp_price)
                for o in orders
            )
            same_sl = any(
                self._is_same_trigger(o, params.coin, close_side, params.qty, params.sl_price)
                for o in orders
            )

            if same_limit and same_tp and same_sl:
                log.info(
                    "Identical open order for %s already exists; skipping placement",
                    params.coin,
                )
                return OrderResult(success=True)

            # Cancel any existing open orders for this coin before replacing them
            for o in orders:
                if o.get("coin") != params.coin:
                    continue
                oid = o.get("oid")
                if oid is not None:
                    self._exchange.cancel(params.coin, oid)
                    log.info("Cancelled order %s for %s", oid, params.coin)

            # Limit entry order
            limit_resp = self._exchange.order(
                params.coin,
                params.is_buy,
                params.qty,
                params.limit_price,
                {"limit": {"tif": "Gtc"}},
            )
            log.info("Placed limit order for %s", params.coin)

            # Stop-loss trigger
            sl_resp = self._exchange.order(
                params.coin,
                not params.is_buy,
                params.qty,
                params.sl_price,
                {"trigger": {"triggerPx": params.sl_price, "isMarket": True, "tpsl": "sl"}},
            )
            log.info("Placed SL trigger for %s", params.coin)

            # Take-profit trigger
            tp_resp = self._exchange.order(
                params.coin,
                not params.is_buy,
                params.qty,
                params.tp_price,
                {"trigger": {"triggerPx": params.tp_price, "isMarket": True, "tpsl": "tp"}},
            )
            log.info("Placed TP trigger for %s", params.coin)

            return OrderResult(
                success=True,
                limit_response=limit_resp,
                sl_response=sl_resp,
                tp_response=tp_resp,
            )
        except Exception as e:
            log.error("Order placement failed: %s", e)
            return OrderResult(success=False, error=str(e))
