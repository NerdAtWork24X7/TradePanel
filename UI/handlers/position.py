"""Position loading handler — fetch from Hyperliquid and apply to UI.

Contains the background thread logic and the position→UI application.
"""

from __future__ import annotations

import json
import logging
from Core import calculations
from Core.utils import DaemonThreadPoolExecutor
from Exchange.hyperliquid import HyperliquidClient

log = logging.getLogger(__name__)


class PositionHandler:
    """Handles position fetching and application to the toolbar.

    Usage:
        handler.fetch_position(coin)                          # spawns thread
        handler.apply_position(payload_json)                  # on main thread
    """

    def __init__(self, toolbar, position_signal) -> None:
        self.toolbar = toolbar
        self._position_signal = position_signal    # Signal(str) — for thread-safe delivery
        # Bounded thread pool for network calls; owned by this handler.
        self._executor = DaemonThreadPoolExecutor(max_workers=2, thread_name_prefix="position_")

    def shutdown(self) -> None:
        """Release the background thread pool. Call once before destruction."""
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ── Position loading ─────────────────────────────────────────────────────

    def fetch_position(self, coin: str) -> None:
        """Spawn background thread to fetch position from Hyperliquid."""
        from Core.config import HL_PRIVATE_KEY
        if not HL_PRIVATE_KEY or HL_PRIVATE_KEY == "YOUR_PRIVATE_KEY_HERE":
            log.warning("No Hyperliquid private key configured — cannot load position.")
            return

        def _fetch():
            try:
                client = HyperliquidClient()
                pos = client.get_position(coin)
                if pos.has_position:
                    log.info(
                        "Loaded HL position for %s: entry=%s size=%s tp=%s sl=%s pnl=%s",
                        coin, pos.entry_price, pos.size,
                        pos.tp_price, pos.sl_price, pos.unrealized_pnl,
                    )
                    payload = json.dumps({
                        "coin": pos.coin,
                        "entry": pos.entry_price,
                        "tp": pos.tp_price,
                        "sl": pos.sl_price,
                        "size": pos.size,
                        "pnl": pos.unrealized_pnl,
                    })
                    self._position_signal.emit(payload)
                else:
                    log.info("No open position for %s on Hyperliquid.", coin)
            except Exception as e:
                log.error("Failed to load position from Hyperliquid: %s", e)

        self._executor.submit(_fetch)

    def apply_position(self, payload: str, recalculate_qty_fn) -> None:
        """Apply position data (from JSON payload) to the toolbar.

        Args:
            payload: JSON string with coin, entry, tp, sl, size, pnl.
            recalculate_qty_fn: Callable to trigger qty recalculation.
        """
        try:
            data = json.loads(payload)
        except (json.JSONDecodeError, TypeError):
            return

        coin = data.get("coin", "")
        if coin != self.toolbar.current_coin():
            return

        entry = data.get("entry")
        tp = data.get("tp")
        sl = data.get("sl")
        size = data.get("size", 0)
        is_short = size < 0

        # Calculate defaults if missing
        if entry and not tp and not sl:
            if is_short:
                _, tp, sl = calculations.quick_short_params(entry)
            else:
                _, tp, sl = calculations.quick_long_params(entry)
            log.info(
                "Calculated default TP=%s SL=%s for %s position",
                tp, sl, "SHORT" if is_short else "LONG",
            )

        # Fill toolbar
        if entry:
            self.toolbar.set_limit(str(round(entry, 6)))
        if tp:
            self.toolbar.set_tp(str(round(tp, 6)))
        if sl:
            self.toolbar.set_sl(str(round(sl, 6)))
        self.toolbar.set_direction(is_short)

        recalculate_qty_fn()

        log.info(
            "Position applied: %s %s entry=%s tp=%s sl=%s",
            "SHORT" if is_short else "LONG", coin, entry, tp, sl,
        )
