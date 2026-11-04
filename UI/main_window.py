"""Main window — slim orchestrator.

Creates widgets and handlers, wires Qt signals, and manages
window state persistence. All business logic lives in handlers.
"""

from __future__ import annotations

import json
import logging
import webbrowser
import os

from PySide6.QtCore import QSize, QTimer, Signal, Slot
from PySide6.QtGui import QKeySequence, QShortcut

from PySide6.QtWidgets import QMainWindow, QMessageBox, QVBoxLayout, QWidget

from Core.config import WINDOW_TITLE, WINDOW_WIDTH, WINDOW_HEIGHT
from Core import coin_service, alert_service
from Core.window_state import load_window_state, save_window_state
from UI.workspace_view import WorkspaceWidget
from UI.handlers import TradeHandler, PositionHandler
from Core.utils import DaemonThreadPoolExecutor
from UI.toolbar import Toolbar
from UI.styles import BG_DARK

log = logging.getLogger(__name__)


class MainWindow(QMainWindow):
    """Top-level application window — pure orchestrator."""

    # Thread-safe delivery signals (JSON from background threads)
    _positionReady = Signal(str)
    _orderResult = Signal(bool, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(WINDOW_TITLE)
        self.resize(WINDOW_WIDTH, WINDOW_HEIGHT)

        self._lock_size = False
        QTimer.singleShot(0, self._lock_window_size)

        # ── State ──
        self._alerts = alert_service.load_alerts()
        self._coins = coin_service.load_coins()

        # ── Widgets ──
        self._toolbar = Toolbar()
        self._workspace = WorkspaceWidget()

        # ── Handlers ──
        self._trade = TradeHandler(self._toolbar)
        self._position = PositionHandler(self._toolbar, self._positionReady)

        # ── Shared thread pool for order/position network calls ──
        self._order_executor = DaemonThreadPoolExecutor(max_workers=4, thread_name_prefix="order_")

        # ── Layout ──
        central = QWidget()
        central.setObjectName("centralWidget")
        central.setStyleSheet(f"#centralWidget {{ background-color: {BG_DARK}; }}")

        # The multi-chart analysis workspace is the only chart view.
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(8)
        root.addWidget(self._toolbar)
        root.addWidget(self._workspace, 1)
        self.setCentralWidget(central)

        # ── Populate & Wire ──
        self._toolbar.set_coins(self._coins)
        self._wire_signals()
        self._wire_thread_signals()

        # Workspace → Qt (trade inputs, focused instrument, indicator settings)
        self._workspace.positionDrawingChanged.connect(self._on_position_drawing_changed)
        self._workspace.focusedChartChanged.connect(self._on_focused_chart_changed)
        self._workspace.configRequested.connect(self._on_config_clicked)
        self._workspace.topBarToggleRequested.connect(self._toggle_top_bar)
        self._workspace.loadFailed.connect(self._on_workspace_load_failed)
        self._workspace.credentialsChanged.connect(self._on_credentials_changed)

        self._top_bar_shortcut = QShortcut(QKeySequence('Ctrl+Shift+T'), self)
        self._top_bar_shortcut.activated.connect(self._toggle_top_bar)

        # ── Restore state ──
        self._restore_window_state()
        self.setWindowTitle("Trade Panel — Multi-Chart")


    def _toggle_top_bar(self) -> None:
        visible = not self._toolbar.isVisible()
        self._toolbar.setVisible(visible)

    def _on_credentials_changed(self, keys) -> None:
        """Apply freshly saved credentials without restarting the app."""
        keys = [str(k) for k in (keys or [])]
        if any(k.startswith("HL_") for k in keys):
            try:
                from Exchange.hyperliquid import HyperliquidClient
                HyperliquidClient.reset()
            except Exception as exc:      # pragma: no cover - defensive
                log.debug("Could not reset Hyperliquid client: %s", exc)

    # ── Thread-safe signal wiring ────────────────────────────────────────────

    def _wire_thread_signals(self) -> None:
        self._positionReady.connect(self._apply_position)
        self._orderResult.connect(self._show_order_result)

    # ── Signal wiring ────────────────────────────────────────────────────────

    def _wire_signals(self) -> None:
        t = self._toolbar

        # Toolbar ↔ focused workspace panel
        t.coinChanged.connect(self._on_coin_changed)
        t.timeframeChanged.connect(self._on_timeframe_changed)
        t.centerChartClicked.connect(self._workspace.center_focused)

        # Trading
        t.updateOrderClicked.connect(self._on_update_order)
        t.setOrderClicked.connect(self._on_set_order)

        # Alerts
        t.setAlertClicked.connect(self._on_set_alert)
        t.openBrowserClicked.connect(self._on_open_browser)
        t.refreshCoinsClicked.connect(self._on_refresh_coins)
        t.addFavoriteClicked.connect(self._on_add_favorite)
        t.favoriteClicked.connect(self._on_favorite_clicked)

        # Load position
        t.readOrderClicked.connect(self._on_load_position)

    # ── Slots: Focused chart / workspace ─────────────────────────────────────

    def _on_workspace_load_failed(self, message: str) -> None:
        QMessageBox.warning(
            self,
            "Multi-chart workspace",
            f"{message}\n\nRun the app from the repository with `python main.py` "
            "(or ./start.sh) so the workspace web assets are available.",
        )

    def _on_focused_chart_changed(self, symbol: str, exchange: str,
                                  market: str, timeframe: str) -> None:
        """Keep the Qt trade inputs/coin selector aligned with the active panel."""
        base = (symbol or "").split("/")[0]
        t = self._toolbar
        t.blockSignals(True)
        idx = t.Coin_List.findText(base)
        if idx < 0 and base:
            # The panel may show an instrument outside the Hyperliquid/Binance
            # list; keep the trade panel aligned with the focused chart.
            t.Coin_List.addItem(base)
            idx = t.Coin_List.findText(base)
        if idx >= 0:
            t.Coin_List.setCurrentIndex(idx)
        if timeframe:
            tf_idx = t.TF_Select.findText(timeframe)
            if tf_idx >= 0:
                t.TF_Select.setCurrentIndex(tf_idx)
        t.blockSignals(False)
        if idx >= 0:
            self._on_load_position()

    # ── Slots: Coin / Timeframe ──────────────────────────────────────────────

    def _on_coin_changed(self, coin: str) -> None:
        if coin:
            self._workspace.set_focused_coin(coin)
            self._on_load_position()

    def _on_timeframe_changed(self, tf: str) -> None:
        if tf:
            self._workspace.set_focused_timeframe(tf)

    # ── Slots: Trading ───────────────────────────────────────────────────────

    def _on_position_drawing_changed(
        self, direction: str, entry: float, tp: float, sl: float
    ) -> None:
        """Sync trade inputs from the box the user selected, drew, or edited."""
        self._trade.apply_levels(entry, tp, sl, short=(direction == "short"))

    def _on_update_order(self) -> None:
        coin = self._toolbar.current_coin()
        if not coin or not self._toolbar.Hyperliquid.isChecked():
            return

        def _do():
            try:
                success, msg = self._trade.update_order(coin, self._toolbar.is_short())
                self._orderResult.emit(success, msg)
            except Exception as e:
                log.error("Update order failed for %s: %s", coin, e)
                self._orderResult.emit(False, str(e))

        self._order_executor.submit(_do)

    def _show_order_result(self, success: bool, msg: str) -> None:
        box = QMessageBox(self)
        box.setWindowTitle("Order Updated" if success else "Order Update Failed")
        box.setText("Order was successfully updated" if success else f"Order was not updated: {msg}")
        box.setIcon(QMessageBox.Icon.Information if success else QMessageBox.Icon.Warning)
        box.exec()

    def _on_set_order(self) -> None:
        coin = self._toolbar.current_coin()
        if not coin:
            return

        def _do():
            try:
                self._trade.place_order(coin, not self._toolbar.is_short())
            except Exception as e:
                log.error("Place order failed for %s: %s", coin, e)

        self._order_executor.submit(_do)

    # ── Slots: Alerts / Browser / Coins ──────────────────────────────────────

    def _on_set_alert(self) -> None:
        coin = self._toolbar.current_coin()
        high_text = self._toolbar.fvg_high()
        low_text = self._toolbar.fvg_low()

        self._alerts = alert_service.load_alerts()

        if high_text and low_text:
            try:
                alert_service.update_fvg(self._alerts, coin, float(high_text), float(low_text))
            except ValueError:
                log.warning("Invalid FVG values: high=%s low=%s", high_text, low_text)

        alert_service.save_alerts(self._alerts)

    def _on_open_browser(self) -> None:
        coin = self._toolbar.current_coin()
        alert_data = self._alerts.get(coin)
        if alert_data:
            self._toolbar.set_fvg(alert_data.fvg.high, alert_data.fvg.low)
        else:
            try:
                from Core.config import ALERTS_FILE
                with open(ALERTS_FILE, "r") as f:
                    data = json.load(f)
                if coin in data:
                    self._toolbar.set_fvg(data[coin]["FVG"]["high"], data[coin]["FVG"]["low"])
            except Exception:
                pass

        if self._toolbar.Hyperliquid.isChecked():
            url = f"https://app.hyperliquid.xyz/trade/{coin}"
            chrome_path = os.environ.get("BROWSER_PATH", "")
            if chrome_path and os.path.exists(chrome_path):
                try:
                    webbrowser.get(chrome_path + " %s").open(url)
                except Exception as e:
                    log.warning("Failed to open browser at %s: %s", chrome_path, e)
                    webbrowser.open(url)
            else:
                webbrowser.open(url)

    def _on_refresh_coins(self) -> None:
        try:
            coins = coin_service.refresh_coins()
            self._coins = coins
            self._toolbar.set_coins(coins)
            self._toolbar.show_refresh_success(len(coins))
        except Exception as e:
            log.error("Coin refresh failed: %s", e)
            self._toolbar.show_refresh_failure()

    def _on_add_favorite(self) -> None:
        self._toolbar.add_favorite(self._toolbar.current_coin())

    def _on_favorite_clicked(self, coin: str) -> None:
        # Update the coin dropdown — this triggers coinChanged which
        # reloads the chart and fetches the open position.
        idx = self._toolbar.Coin_List.findText(coin)
        if idx >= 0:
            self._toolbar.Coin_List.setCurrentIndex(idx)
        else:
            self._workspace.set_focused_coin(coin)
            self._on_load_position()

    # ── Slots: Position ──────────────────────────────────────────────────────

    def _on_load_position(self) -> None:
        coin = self._toolbar.current_coin()
        if coin:
            self._position.fetch_position(coin)

    @Slot(str)
    def _apply_position(self, payload: str) -> None:
        self._position.apply_position(
            payload,
            recalculate_qty_fn=self._trade.recalculate_qty,
        )

    # ── Slots: Config Dialog ─────────────────────────────────────────────────

    def _on_config_clicked(self) -> None:
        from UI.config_dialog import IndicatorConfigDialog
        from Indicator.config import save_indicator_config

        dlg = IndicatorConfigDialog(self)
        if dlg.exec() == IndicatorConfigDialog.DialogCode.Accepted:
            cfg = dlg.result_config()
            save_indicator_config(cfg)
            self._workspace.apply_indicator_config(cfg)

    # ── Window State ─────────────────────────────────────────────────────────

    def _restore_window_state(self) -> None:
        state = load_window_state()
        t = self._toolbar

        t.blockSignals(True)
        if state.get("coin"):
            idx = t.Coin_List.findText(state["coin"])
            if idx >= 0:
                t.Coin_List.setCurrentIndex(idx)

        if state.get("timeframe"):
            idx = t.TF_Select.findText(state["timeframe"])
            if idx >= 0:
                t.TF_Select.setCurrentIndex(idx)
        t.blockSignals(False)

        for coin in state.get("favorites", []):
            t.add_favorite(coin)

        if state.get("risk"):
            t.Risk.setPlainText(state["risk"])
        t.set_direction(state.get("is_short", False))
        if state.get("limit"):
            t.set_limit(state["limit"])
        if state.get("tp"):
            t.set_tp(state["tp"])
        if state.get("sl"):
            t.set_sl(state["sl"])

        t.Hyperliquid.setChecked(state.get("hyperliquid", False))

    def _save_window_state(self) -> None:
        t = self._toolbar
        state = {
            "coin": t.current_coin(),
            "timeframe": t.current_timeframe(),
            "favorites": t._fav_coins.copy(),
            "risk": t.risk_text(),
            "is_short": t.is_short(),
            "hyperliquid": t.Hyperliquid.isChecked(),
            "limit": t.limit_text(),
            "tp": t.tp_text(),
            "sl": t.sl_text(),
        }

        save_window_state(state)

    # ── Size Management ──────────────────────────────────────────────────────

    def _lock_window_size(self) -> None:
        self.setMinimumSize(QSize(1280, 720))
        self._lock_size = True

    def closeEvent(self, event) -> None:
        try:
            self._save_window_state()
        except Exception as e:
            log.error("Failed to save window state: %s", e)

        # Shutdown all background executors and cancel queued work so worker
        # threads exit promptly instead of blocking interpreter shutdown.
        try:
            self._order_executor.shutdown(wait=False, cancel_futures=True)
        except Exception:
            pass
        try:
            self._position.shutdown()
        except Exception:
            pass
        try:
            self._workspace.shutdown()
        except Exception:
            pass

        super().closeEvent(event)
