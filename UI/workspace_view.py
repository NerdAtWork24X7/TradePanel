"""Embedded multi-chart workspace view.

``WorkspaceWidget`` hosts ``UI/web/workspace.html`` in a single QWebEngineView
(one Chromium renderer for all charts) and is embedded in the main window's
chart area. It exposes a QWebChannel bridge:

    JS → Python   requestCandles / requestTick / searchSymbols (async)
                  meta / loadStore / saveStore (QWebChannel callbacks)
    Python → JS   dataReady(reqId, payload)

All exchange I/O and persistence lives in ``Core``; the widget only marshals.
"""

from __future__ import annotations

import json
import logging
import shutil
from PySide6.QtCore import QObject, QTimer, QUrl, Signal, Slot
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEnginePage, QWebEngineSettings
from PySide6.QtWebEngineWidgets import QWebEngineView
from PySide6.QtWidgets import QVBoxLayout, QWidget

from Core import credentials, market_data, workspace_indicators, workspace_store
from Indicator import config as indicator_config
from Core.config import BUNDLED_WEB_DIR, WEB_DIR
from Core.utils import DaemonThreadPoolExecutor

log = logging.getLogger(__name__)

_WEB_ASSETS = ("workspace.html", "workspace.js", "chart_sync.js",
               "lightweight-charts.standalone.production.js")


def _dump(payload: dict) -> str:
    return json.dumps(payload, separators=(",", ":"), allow_nan=False, default=float)


class WorkspacePage(QWebEnginePage):
    """Page that forwards JS console output to the Python logger."""

    def javaScriptConsoleMessage(self, level, message, line, source):  # noqa: N802
        prefix = source.rsplit("/", 1)[-1] if source else "workspace"
        text = f"[workspace:{prefix}:{line}] {message}"
        if level == QWebEnginePage.JavaScriptConsoleMessageLevel.ErrorMessageLevel:
            log.error(text)
        elif level == QWebEnginePage.JavaScriptConsoleMessageLevel.WarningMessageLevel:
            log.warning(text)
        else:
            log.debug(text)


class WorkspaceBridge(QObject):
    """QWebChannel object shared with the workspace page."""

    dataReady = Signal(str, str)          # request id, JSON payload
    positionDrawing = Signal(str, float, float, float)
    focusedChart = Signal(str, str, str, str)
    configRequested = Signal()
    topBarToggleRequested = Signal()
    credentialsChanged = Signal(list)

    def __init__(self, window: "WorkspaceWidget") -> None:
        super().__init__(window)
        self._window = window
        if hasattr(window, "positionDrawingChanged"):
            self.positionDrawing.connect(window.positionDrawingChanged)
        if hasattr(window, "focusedChartChanged"):
            self.focusedChart.connect(window.focusedChartChanged)
        if hasattr(window, "configRequested"):
            self.configRequested.connect(window.configRequested)
        if hasattr(window, "credentialsChanged"):
            self.credentialsChanged.connect(window.credentialsChanged)

    # ── Metadata / persistence (synchronous) ─────────────────────────────

    @Slot(result=str)
    def indicatorConfig(self) -> str:
        try:
            cfg = indicator_config.load_indicator_config()
            return _dump({"ok": True, "config": cfg})
        except Exception as exc:
            log.error("indicatorConfig failed: %s", exc)
            return _dump({"ok": False, "config": {}})

    @Slot(str, str, str, str, str, str)
    def requestIndicators(self, req_id: str, exchange: str, market: str,
                          symbol: str, timeframe: str, flags_json: str) -> None:
        self._window.submit(self._indicators, req_id, exchange, market,
                            symbol, timeframe, flags_json)

    def _indicators(self, req_id: str, exchange: str, market: str,
                    symbol: str, timeframe: str, flags_json: str) -> None:
        try:
            flags = json.loads(flags_json or "{}")
            payload = workspace_indicators.compute_workspace_indicators(
                exchange, market, symbol, timeframe, flags)
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        self.dataReady.emit(req_id, _dump(payload))

    @Slot(str, float, float, float)
    def onPositionDrawingChanged(self, direction: str, entry: float,
                                 tp: float, sl: float) -> None:
        self.positionDrawing.emit(direction, entry, tp, sl)

    @Slot(str, str, str, str)
    def onFocusedChartChanged(self, symbol: str, exchange: str,
                              market: str, timeframe: str) -> None:
        self.focusedChart.emit(symbol, exchange, market, timeframe)

    @Slot()
    def onConfigRequested(self) -> None:
        self.configRequested.emit()

    @Slot(result=str)
    def credentialStatus(self) -> str:
        """Return credential metadata (never secret values)."""
        try:
            return _dump({"ok": True, "fields": credentials.status()})
        except Exception as exc:            # pragma: no cover - defensive
            log.error("credentialStatus failed: %s", exc)
            return _dump({"ok": False, "error": str(exc), "fields": []})

    @Slot(str, result=str)
    def saveCredentials(self, payload: str) -> str:
        """Persist credentials submitted by the workspace modal."""
        try:
            data = json.loads(payload or "{}")
            if not isinstance(data, dict):
                raise ValueError("Malformed credential payload")
            result = credentials.save(data.get("values") or {}, data.get("clear") or [])
        except Exception as exc:
            log.warning("saveCredentials failed: %s", exc)
            return _dump({"ok": False, "error": str(exc)})
        self.credentialsChanged.emit(result["keys"])
        return _dump({"ok": True, "keys": result["keys"],
                      "fields": credentials.status()})

    @Slot()
    def toggleTopBar(self) -> None:
        self._window.topBarToggleRequested.emit()

    @Slot(result=str)
    def meta(self) -> str:
        return _dump({
            "ok": True,
            "exchanges": market_data.exchanges_meta(),
            "timeframes": market_data.TIMEFRAMES,
            "aggregations": market_data.capabilities(),
            "layouts": ["1", "2h", "2v", "4", "6", "8", "custom"],
        })

    @Slot(result=str)
    def loadStore(self) -> str:
        try:
            store = workspace_store.load_store()
            return _dump({"ok": True, **store})
        except Exception as exc:            # pragma: no cover - defensive
            log.exception("load_store failed")
            return _dump({"ok": False, "error": str(exc),
                          "version": 1, "active": "ws-default",
                          "workspaces": workspace_store.default_store()["workspaces"]})

    @Slot(str, result=str)
    def saveStore(self, payload: str) -> str:
        try:
            raw = json.loads(payload)
            store = workspace_store.save_store(raw)
            return _dump({"ok": True, "store": store})
        except Exception as exc:
            log.error("save_store failed: %s", exc)
            return _dump({"ok": False, "error": str(exc)})

    # ── Market data (asynchronous) ───────────────────────────────────────

    @Slot(str, str, str, str, str, int, int)
    def requestCandles(self, req_id: str, exchange: str, market: str,
                       symbol: str, timeframe: str, limit: int, end_time: int) -> None:
        self._window.submit(self._fetch, req_id, exchange, market, symbol,
                            timeframe, int(limit or 600), int(end_time or 0))

    @Slot(str, str, str, str, str)
    def requestTick(self, req_id: str, exchange: str, market: str,
                    symbol: str, timeframe: str) -> None:
        self._window.submit(self._tick, req_id, exchange, market, symbol, timeframe)

    @Slot(str, str, str, str)
    def searchSymbols(self, req_id: str, exchange: str, market: str, query: str) -> None:
        self._window.submit(self._search, req_id, exchange, market, query)

    def _fetch(self, req_id: str, exchange: str, market: str,
               symbol: str, timeframe: str, limit: int, end_time: int) -> None:
        try:
            payload = market_data.fetch_candles(
                exchange, market, symbol, timeframe,
                limit=limit, end_time=end_time or None,
            )
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        self.dataReady.emit(req_id, _dump(payload))

    def _tick(self, req_id: str, exchange: str, market: str,
              symbol: str, timeframe: str) -> None:
        try:
            payload = market_data.fetch_tick(exchange, market, symbol, timeframe)
        except Exception as exc:
            payload = {"ok": False, "error": str(exc)}
        self.dataReady.emit(req_id, _dump(payload))

    def _search(self, req_id: str, exchange: str, market: str, query: str) -> None:
        try:
            payload = {
                "ok": True,
                "symbols": market_data.search_symbols(exchange, market, query or ""),
            }
        except Exception as exc:
            payload = {"ok": False, "error": str(exc), "symbols": []}
        self.dataReady.emit(req_id, _dump(payload))

    @Slot(str)
    def debug(self, message: str) -> None:
        log.debug("[workspace:js] %s", message)


class WorkspaceWidget(QWidget):
    """Multi-chart workspace embedded in the main window's chart area."""

    loadFailed = Signal(str)
    positionDrawingChanged = Signal(str, float, float, float)
    focusedChartChanged = Signal(str, str, str, str)
    configRequested = Signal()
    topBarToggleRequested = Signal()
    credentialsChanged = Signal(list)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("workspaceWidget")
        self._shutdown = False
        self._loaded = False
        self._fullscreen_was_maximized = False
        self._executor = DaemonThreadPoolExecutor(max_workers=12,
                                                 thread_name_prefix="workspace")

        self._view = QWebEngineView(self)
        self._page = WorkspacePage(self._view)
        self._view.setPage(self._page)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addWidget(self._view)

        self._page.settings().setAttribute(
            QWebEngineSettings.WebAttribute.LocalContentCanAccessFileUrls, True)
        self._page.settings().setAttribute(
            QWebEngineSettings.WebAttribute.LocalContentCanAccessRemoteUrls, True)
        self._page.settings().setAttribute(
            QWebEngineSettings.WebAttribute.WebGLEnabled, True)
        self._page.fullScreenRequested.connect(self._on_fullscreen_requested)

        self._channel = QWebChannel(self._page)
        self._bridge = WorkspaceBridge(self)
        self._channel.registerObject("bridge", self._bridge)
        self._page.setWebChannel(self._channel)

        self._ensure_web_assets()
        self._view.setUrl(QUrl.fromLocalFile(str(WEB_DIR / "workspace.html")))
        self._page.loadFinished.connect(self._on_load_finished)

    # ── Plumbing ─────────────────────────────────────────────────────────

    def _ensure_web_assets(self) -> None:
        """Copy missing web assets into the writable web dir (frozen installs)."""
        WEB_DIR.mkdir(parents=True, exist_ok=True)
        source = BUNDLED_WEB_DIR if BUNDLED_WEB_DIR.exists() else WEB_DIR
        for name in _WEB_ASSETS:
            src = source / name
            dst = WEB_DIR / name
            if src.exists() and not dst.exists():
                try:
                    shutil.copy2(src, dst)
                except OSError as exc:
                    log.warning("Could not copy %s: %s", name, exc)

    def submit(self, fn, *args) -> None:
        if self._shutdown or self._executor is None:
            return
        self._executor.submit(fn, *args)

    @property
    def page(self) -> QWebEnginePage:
        return self._page

    def is_loaded(self) -> bool:
        return self._loaded

    # ── QWebChannel → JS helpers used by MainWindow ─────────────────────

    def set_focused_coin(self, coin: str) -> None:
        self._run_js("window.WS && WS.setFocusedCoin && WS.setFocusedCoin(%s)"
                     % json.dumps(coin))

    def set_focused_timeframe(self, timeframe: str) -> None:
        self._run_js("window.WS && WS.setFocusedTimeframe && WS.setFocusedTimeframe(%s)"
                     % json.dumps(timeframe))

    def center_focused(self) -> None:
        self._run_js("window.WS && WS.centerFocused && WS.centerFocused()")

    def apply_indicator_config(self, cfg: dict) -> None:
        workspace_indicators.clear_cache()
        self._run_js("window.WS && WS.setIndicatorConfig && WS.setIndicatorConfig(%s)"
                     % json.dumps(cfg))

    def _run_js(self, code: str) -> None:
        if not self._loaded or self._shutdown:
            return
        try:
            self._page.runJavaScript(code)
        except Exception as exc:
            log.debug("Workspace JS call failed: %s", exc)

    def set_active(self, active: bool) -> None:
        """Pause/resume workspace polling when the view is hidden/shown."""
        if not self._loaded:
            return
        try:
            self._page.runJavaScript(
                "window.WS && window.WS.setActive && window.WS.setActive(%s)"
                % ("true" if active else "false")
            )
        except Exception as exc:
            log.debug("Workspace setActive failed: %s", exc)

    def _on_load_finished(self, ok: bool) -> None:
        if not ok:
            log.error("Workspace page failed to load")
            self.loadFailed.emit("The workspace page could not be loaded from UI/web.")
            return
        self._loaded = True
        # Surface eager failures (e.g. a missing bundled asset) in the log.
        self._page.runJavaScript(
            "window.WS && window.WS.store ? 'ready' : 'not-ready'",
            lambda result: log.debug("Workspace page state: %s", result),
        )
        QTimer.singleShot(6000, self._verify_boot)

    def _verify_boot(self) -> None:
        if self._shutdown or not self._loaded:
            return
        self._page.runJavaScript(
            "!!(window.WS && window.WS.store)",
            self._on_boot_verified,
        )

    def _on_boot_verified(self, ok) -> None:
        if self._shutdown or ok:
            return
        log.error("Workspace boot did not complete (QWebChannel/bridge problem)")
        self.loadFailed.emit(
            "The workspace started but its bridge did not initialise. "
            "Check that UI/web/workspace.js and chart_sync.js exist and restart the app."
        )

    def _on_fullscreen_requested(self, request) -> None:
        # The workspace is embedded, so HTML fullscreen must promote the host
        # window; accepting the request alone would only fill the widget.
        window = self.window()
        try:
            if request.toggleOn():
                self._fullscreen_was_maximized = window.isMaximized()
                window.showFullScreen()
            elif self._fullscreen_was_maximized:
                window.showMaximized()
            else:
                window.showNormal()
        except Exception as exc:
            log.debug("Fullscreen toggle failed: %s", exc)
        request.accept()

    def shutdown(self) -> None:
        """Stop polling, persist state and release Chromium resources."""
        if self._shutdown:
            return
        self._shutdown = True
        try:
            self._page.runJavaScript("window.WS && window.WS.shutdown && window.WS.shutdown();")
        except Exception:
            pass
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)
            self._executor = None
        try:
            self._page.setWebChannel(None)
            self._view.setUrl(QUrl("about:blank"))
        except Exception:
            pass

