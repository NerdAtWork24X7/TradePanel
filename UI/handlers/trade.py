"""Trade action handler — box sync, Update Order, Set Order.

Pure business logic: applies drawn-box levels, interacts with the
exchange client. No Qt signals — caller manages threading and UI updates.
"""

from __future__ import annotations

import logging
import math

from Core import calculations
from Core.models import OrderParams
from Exchange.hyperliquid import HyperliquidClient

log = logging.getLogger(__name__)


class TradeHandler:
    """Handles trade input sync and order placement logic.

    Receives a toolbar reference for reading inputs and updating display.
    """

    def __init__(self, toolbar) -> None:
        self.toolbar = toolbar

    # ── Drawn box → trade inputs ─────────────────────────────────────────────

    def apply_levels(
        self, entry: float, tp: float, sl: float, *, short: bool
    ) -> bool:
        """Apply entry/TP/SL from a drawn position box to the trade inputs.

        Returns False when the levels are unusable (non-finite, non-positive,
        or directionally inconsistent) so the caller can ignore the box.
        """
        if not all(math.isfinite(v) and v > 0 for v in (entry, tp, sl)):
            return False
        if entry == sl:
            return False
        if short and not (tp < entry < sl):
            return False
        if not short and not (sl < entry < tp):
            return False
        self.toolbar.set_limit(str(entry))
        self.toolbar.set_tp(str(tp))
        self.toolbar.set_sl(str(sl))
        self.toolbar.set_direction(short=short)
        self.recalculate_qty()
        return True

    # ── Qty & Risk ───────────────────────────────────────────────────────────

    def recalculate_qty(self) -> None:
        """Read Limit/SL/Risk from toolbar and compute Qty."""
        try:
            risk = float(self.toolbar.risk_text())
            entry = float(self.toolbar.limit_text())
            sl = float(self.toolbar.sl_text())
            coin = self.toolbar.current_coin()
            sz_decimals = HyperliquidClient.get_sz_decimals(coin)
            qty = calculations.calculate_qty(
                risk, entry, sl, self.toolbar.is_short(), sz_decimals
            )
            self.toolbar.set_qty(str(qty))
        except (ValueError, ZeroDivisionError, TypeError):
            pass

    # ── Order Placement ──────────────────────────────────────────────────────

    def update_order(self, coin: str, is_short: bool) -> tuple[bool, str]:
        """Update TP/SL on Hyperliquid for an existing position.

        Returns (success, message).
        """
        try:
            tp = float(self.toolbar.tp_text())
            sl = float(self.toolbar.sl_text())
        except (ValueError, TypeError) as e:
            return False, f"Invalid TP/SL: {e}"

        if tp <= 0 or sl <= 0:
            return False, "TP and SL must be positive"

        client = HyperliquidClient()
        pos = client.get_position(coin)
        qty = abs(pos.size)
        if qty <= 0:
            return False, f"No open position for {coin}"

        mid_price = client.get_mid_price(coin)
        if mid_price and mid_price > 0:
            precision = calculations.detect_price_precision(mid_price)
            tp = round(tp, precision)
            sl = round(sl, precision)
            log.info("Rounded TP/SL to %d decimals: tp=%s sl=%s", precision, tp, sl)

        is_long = not is_short
        result = client.update_tp_sl(coin, is_long, qty, tp, sl)
        if result.success:
            msg = f"TP/SL updated for {coin}: tp={tp} sl={sl}"
            log.info(msg)
            return True, msg
        else:
            msg = f"TP/SL update failed for {coin}: {result.error}"
            log.error(msg)
            return False, msg

    def place_order(self, coin: str, is_buy: bool) -> tuple[bool, str]:
        """Place a limit order with TP/SL on Hyperliquid.

        Returns (success, message).
        """
        try:
            limit_price = float(self.toolbar.limit_text())
            tp_price = float(self.toolbar.tp_text())
            sl_price = float(self.toolbar.sl_text())
            qty = float(self.toolbar.qty_text())
        except (ValueError, TypeError) as e:
            return False, f"Invalid order parameters: {e}"

        client = HyperliquidClient()
        mid_price = client.get_mid_price(coin)
        if mid_price and mid_price > 0:
            precision = calculations.detect_price_precision(mid_price)
            limit_price = round(limit_price, precision)
            tp_price = round(tp_price, precision)
            sl_price = round(sl_price, precision)
            log.info(
                "Rounded prices to %d decimals (mid=%s): limit=%s tp=%s sl=%s",
                precision, mid_price, limit_price, tp_price, sl_price,
            )

        params = OrderParams(
            coin=coin,
            is_buy=is_buy,
            qty=qty,
            limit_price=limit_price,
            tp_price=tp_price,
            sl_price=sl_price,
        )
        result = client.place_order(params)
        if result.success:
            log.info("Order placed successfully.")
            return True, "Order placed"
        else:
            log.error("Order failed: %s", result.error)
            return False, f"Order failed: {result.error}"
