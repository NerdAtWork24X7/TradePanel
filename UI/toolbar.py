"""Top toolbar: coin selector, timeframe, action buttons, favorites."""

from __future__ import annotations

from PySide6.QtCore import QTimer, Signal
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QFrame, QGridLayout, QHBoxLayout, QLabel,
    QPlainTextEdit, QPushButton, QSizePolicy, QVBoxLayout, QWidget,
)


from Core.config import TIMEFRAMES, DEFAULT_TIMEFRAME
from UI.styles import (
    ACCENT,
    BG_PANEL,
    BORDER,
    HAIRLINE,
    TEXT_BUTTON_STYLE,
    TEXT_MUTED,
    TEXT_TERTIARY,
    COMBOBOX_STYLE,
    CENTER_BUTTON_STYLE,
)


class Toolbar(QWidget):
    """Top toolbar containing coin selection, trade panel, FVG, and favorites.

    Signals:
        coinChanged(coin: str)
        timeframeChanged(tf: str)
        updateOrderClicked()
        setOrderClicked()
        setAlertClicked()
        openBrowserClicked()
        refreshCoinsClicked()
        addFavoriteClicked()
        favoriteClicked(coin: str)
        centerChartClicked()
    """

    coinChanged = Signal(str)
    timeframeChanged = Signal(str)
    updateOrderClicked = Signal()
    setOrderClicked = Signal()
    setAlertClicked = Signal()
    openBrowserClicked = Signal()
    refreshCoinsClicked = Signal()
    addFavoriteClicked = Signal()
    favoriteClicked = Signal(str)
    centerChartClicked = Signal()
    readOrderClicked = Signal()

    MAX_FAVORITES = 12

    @staticmethod
    def _label_style(color: str = TEXT_TERTIARY) -> str:
        return (
            f"color: {color}; font-size: 9px; font-weight: 600;"
            "letter-spacing: 1px; text-transform: uppercase; background: transparent;"
        )

    @staticmethod
    def _card_style() -> str:
        return (
            f"QFrame {{ background-color: {BG_PANEL}; border: 1px solid {HAIRLINE};"
            f" border-radius: 12px; }}"
        )

    def __init__(self, parent=None):
        super().__init__(parent)
        self._fav_coins: list[str] = []
        self._fav_buttons: list[QPushButton] = []
        self._build_ui()

    # ── Public API ───────────────────────────────────────────────────────────

    def set_coins(self, coins: list[str], selected: str | None = None) -> None:
        self.Coin_List.blockSignals(True)
        current = selected or self.Coin_List.currentText()
        self.Coin_List.clear()
        for c in coins:
            self.Coin_List.addItem(c)
        idx = self.Coin_List.findText(current)
        if idx >= 0:
            self.Coin_List.setCurrentIndex(idx)
        self.Coin_List.blockSignals(False)

    def current_coin(self) -> str:
        return self.Coin_List.currentText()

    def current_timeframe(self) -> str:
        return self.TF_Select.currentText()

    def show_refresh_success(self, count: int) -> None:
        self.Refresh_Coins.setText(f"Refresh ✓ ({count})")
        QTimer.singleShot(2000, lambda: self.Refresh_Coins.setText("Refresh Coins"))

    def show_refresh_failure(self) -> None:
        self.Refresh_Coins.setText("Refresh ✗")
        QTimer.singleShot(2000, lambda: self.Refresh_Coins.setText("Refresh Coins"))

    # ── FVG alert inputs (kept for API compatibility) ──────────────────────────

    def fvg_high(self) -> str:
        return getattr(self, "FVG_High", None).toPlainText().strip() if hasattr(self, "FVG_High") else ""

    def fvg_low(self) -> str:
        return getattr(self, "FVG_Low", None).toPlainText().strip() if hasattr(self, "FVG_Low") else ""

    def set_fvg(self, high: float, low: float) -> None:
        if hasattr(self, "FVG_High"):
            self.FVG_High.setPlainText(str(high))
        if hasattr(self, "FVG_Low"):
            self.FVG_Low.setPlainText(str(low))

    # ── Trade inputs ─────────────────────────────────────────────────────────

    def limit_text(self) -> str: return self.Limit.toPlainText().strip()
    def tp_text(self) -> str: return self.TP.toPlainText().strip()
    def sl_text(self) -> str: return self.SL.toPlainText().strip()
    def qty_text(self) -> str: return self.qty.toPlainText().strip()
    def risk_text(self) -> str: return self.Risk.toPlainText().strip()

    def set_limit(self, v: str) -> None: self.Limit.setPlainText(v)
    def set_tp(self, v: str) -> None: self.TP.setPlainText(v)
    def set_sl(self, v: str) -> None: self.SL.setPlainText(v)
    def set_qty(self, v: str) -> None: self.qty.setPlainText(v)

    def is_short(self) -> bool:
        return self.Long_Short.isChecked()

    def set_direction(self, short: bool) -> None:
        self.Long_Short.setChecked(short)

    # ── Build UI ─────────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        toolbar = QHBoxLayout()
        toolbar.setSpacing(6)

        # ── Coin group ──
        toolbar.addWidget(self._build_coin_group())
        # ── Trade panel ──
        toolbar.addWidget(self._build_trade_panel())
        # ── Order buttons ──
        toolbar.addWidget(self._build_order_buttons())
        # ── Alert buttons ──
        toolbar.addWidget(self._build_alert_buttons())
        # ── Favorites ──
        toolbar.addWidget(self._build_favorites(), 1)

        root.addLayout(toolbar)

    def _build_coin_group(self) -> QFrame:
        frame = QFrame()
        frame.setFrameShape(QFrame.Shape.NoFrame)
        frame.setStyleSheet(self._card_style())
        frame.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Preferred)
        lay = QGridLayout(frame)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setHorizontalSpacing(2)
        lay.setVerticalSpacing(3)

        self.Coim_Label = QLabel("COIN")
        self.Coim_Label.setStyleSheet(self._label_style())
        self.Coin_List = QComboBox()
        self.Coin_List.setMinimumWidth(60)
        self.Coin_List.setMaxVisibleItems(20)
        self.Coin_List.setStyleSheet(COMBOBOX_STYLE)
        self.Coin_List.currentIndexChanged.connect(
            lambda: self.coinChanged.emit(self.Coin_List.currentText())
        )

        coin_layout = QHBoxLayout()
        coin_layout.setSpacing(2)
        coin_layout.addWidget(self.Coim_Label)
        coin_layout.addWidget(self.Coin_List)
        
        self.tf_label = QLabel("TF")
        self.tf_label.setStyleSheet(self._label_style())
        self.TF_Select = QComboBox()
        self.TF_Select.addItems(TIMEFRAMES)
        self.TF_Select.setCurrentText(DEFAULT_TIMEFRAME)
        self.TF_Select.setFixedWidth(58)
        self.TF_Select.setSizePolicy(QSizePolicy.Policy.Fixed, QSizePolicy.Policy.Fixed)
        self.TF_Select.setStyleSheet(COMBOBOX_STYLE)
        self.TF_Select.currentIndexChanged.connect(
            lambda: self.timeframeChanged.emit(self.TF_Select.currentText())
        )

        self.center_btn = QPushButton("\u2302")
        self.center_btn.setFixedSize(28, 28)
        self.center_btn.setStyleSheet(CENTER_BUTTON_STYLE)
        self.center_btn.setToolTip("Center chart to latest")
        self.center_btn.clicked.connect(self.centerChartClicked)
     
        tf_layout = QHBoxLayout()
        tf_layout.setSpacing(1)
        tf_layout.addWidget(self.tf_label)
        tf_layout.addWidget(self.TF_Select)
        tf_layout.addWidget(self.center_btn)

        self.Hyperliquid = QCheckBox("Hyperliquid")
        self.Hyperliquid.setStyleSheet(
            f"QCheckBox {{ color: {TEXT_TERTIARY}; font-size: 10px; spacing: 6px; }}"
        )

        self.Refresh_Coins = QPushButton("Refresh Coins")
        self.Refresh_Coins.setStyleSheet(TEXT_BUTTON_STYLE)
        self.Refresh_Coins.clicked.connect(self.refreshCoinsClicked)

        self.Open_Browser_button = QPushButton("Open Browser")
        self.Open_Browser_button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.Open_Browser_button.clicked.connect(self.openBrowserClicked)

        lay.addLayout(coin_layout, 0, 0, 1, 1)
        lay.addWidget(self.tf_label, 0, 1)
        lay.addLayout(tf_layout, 0, 1)
        lay.addWidget(self.Hyperliquid, 1, 0)
        lay.addWidget(self.Open_Browser_button, 1, 1)
        lay.addWidget(self.Refresh_Coins, 2, 0, 1, 2)
        return frame

    def _build_trade_panel(self) -> QFrame:
        frame = QFrame()
        frame.setFrameShape(QFrame.Shape.NoFrame)
        frame.setStyleSheet(self._card_style())
        lay = QGridLayout(frame)
        lay.setContentsMargins(8, 6, 8, 6)
        lay.setSpacing(4)

        self.TP = QPlainTextEdit(); self.TP.setFixedHeight(31); self.TP.setMinimumWidth(40); self.TP.setFixedWidth(120)
        self.qty = QPlainTextEdit(); self.qty.setFixedHeight(31); self.qty.setMinimumWidth(40); self.qty.setFixedWidth(120)
        self.Limit = QPlainTextEdit(); self.Limit.setFixedHeight(31); self.Limit.setMinimumWidth(40); self.Limit.setFixedWidth(120)
        self.SL = QPlainTextEdit(); self.SL.setFixedHeight(31); self.SL.setMinimumWidth(40); self.SL.setFixedWidth(120)
        self.SL_Label = QLabel("SL")
        self.Limit_Label = QLabel("LIM")
        self.TP_Label = QLabel("TP")
        self.qty_Label = QLabel("QTY")
        for _lbl in (self.SL_Label, self.Limit_Label, self.TP_Label, self.qty_Label):
            _lbl.setStyleSheet(self._label_style())
        self.Long_Short = QCheckBox()
        self.Long_Short.toggled.connect(self._on_direction_toggled)
        self.Long_Short_State = QLabel("Long")
        self.Long_Short_State.setFont(QFont("", -1, QFont.Weight.Bold))
        self.Long_Short_State.setStyleSheet(
            f"color: #10B981; font-size: 11px; font-weight: 700; letter-spacing: 1px;"
        )
        self.Risk_Label = QLabel("RISK")
        self.Risk_Label.setStyleSheet(self._label_style())
        self.Risk = QPlainTextEdit(); self.Risk.setFixedHeight(31); self.Risk.setMinimumWidth(40); self.Risk.setFixedWidth(120)
        self.Risk.setPlainText("10")

        lay.addWidget(self.qty_Label, 0, 0); lay.addWidget(self.qty, 0, 1)
        lay.addWidget(self.Risk_Label, 0, 2); lay.addWidget(self.Risk, 0, 3)
        lay.addWidget(self.Long_Short, 0, 4)
        self.Read_Order_Button = QPushButton("Read order")
        self.Read_Order_Button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.Read_Order_Button.clicked.connect(self.readOrderClicked)
        ls_state_layout = QHBoxLayout()
        ls_state_layout.setSpacing(4)
        ls_state_layout.addWidget(self.Long_Short_State)
        ls_state_layout.addWidget(self.Read_Order_Button)
        lay.addLayout(ls_state_layout, 0, 5, 1, 2)
        lay.addWidget(self.Limit_Label, 1, 0); lay.addWidget(self.Limit, 1, 1)
        lay.addWidget(self.TP_Label, 1, 2); lay.addWidget(self.TP, 1, 3)
        lay.addWidget(self.SL_Label, 1, 4); lay.addWidget(self.SL, 1, 5)
        lay.setColumnStretch(1, 1); lay.setColumnStretch(3, 1); lay.setColumnStretch(5, 1)
        return frame

    def _build_order_buttons(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(3)

        self.Update_Order_Button = QPushButton("Update Order")
        self.Update_Order_Button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.Update_Order_Button.clicked.connect(self.updateOrderClicked)

        self.Set_Order_Button = QPushButton("Set Order")
        self.Set_Order_Button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.Set_Order_Button.clicked.connect(self.setOrderClicked)

        lay.addWidget(self.Update_Order_Button)
        lay.addWidget(self.Set_Order_Button)
        return w

    def _build_alert_buttons(self) -> QWidget:
        w = QWidget()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(3)

        self.AddFav_Button = QPushButton("Add Favourite")
        self.AddFav_Button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.AddFav_Button.clicked.connect(self.addFavoriteClicked)

        self.SetAlert_Button = QPushButton("Set Alert")
        self.SetAlert_Button.setStyleSheet(TEXT_BUTTON_STYLE)
        self.SetAlert_Button.clicked.connect(self.setAlertClicked)

        lay.addWidget(self.AddFav_Button)
        lay.addWidget(self.SetAlert_Button)
        return w

    def _build_favorites(self) -> QFrame:
        frame = QFrame()
        frame.setFrameShape(QFrame.Shape.NoFrame)
        frame.setStyleSheet(self._card_style())
        frame.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        lay = QGridLayout(frame)
        lay.setContentsMargins(8, 6, 8, 6)
        lay.setSpacing(4)

        for i in range(self.MAX_FAVORITES):
            btn = QPushButton(f"Fav{i + 1}")
            btn.setMinimumHeight(24)
            self._style_fav_button(btn, assigned=False)
            idx = i + 1
            btn.clicked.connect(lambda _, n=idx: self._on_fav_clicked(n))
            self._fav_buttons.append(btn)
            lay.addWidget(btn, i // 6, i % 6)
        return frame

    # ── Private slots ────────────────────────────────────────────────────────

    def _on_direction_toggled(self, checked: bool) -> None:
        self.Long_Short_State.setText("Short" if checked else "Long")
        color = "#DC2626" if checked else "#10B981"
        self.Long_Short_State.setStyleSheet(
            f"color: {color}; font-size: 11px; font-weight: 700; letter-spacing: 1px;"
        )

    def _on_fav_clicked(self, index: int) -> None:
        btn = self._fav_buttons[index - 1]
        text = btn.text()
        if text.startswith("Fav"):
            return
        self.favoriteClicked.emit(text)

    # ── Favorites management ─────────────────────────────────────────────────

    def _style_fav_button(self, btn: QPushButton, assigned: bool) -> None:
        if assigned:
            btn.setStyleSheet(
                f"QPushButton {{ background-color: rgba(245, 196, 0, 0.10);"
                f" color: {ACCENT}; border: 1px solid {ACCENT}; border-radius: 6px;"
                " font-family: 'JetBrains Mono', 'DejaVu Sans Mono', monospace;"
                " font-size: 10px; padding: 3px 6px; }}"
                f"QPushButton:hover {{ background-color: rgba(245, 196, 0, 0.18); }}"
            )
        else:
            btn.setStyleSheet(
                f"QPushButton {{ background-color: transparent; color: {TEXT_MUTED};"
                f" border: 1px solid {HAIRLINE}; border-radius: 6px; font-size: 10px;"
                " padding: 3px 6px; }"
                f"QPushButton:hover {{ color: {TEXT_TERTIARY}; border-color: {BORDER}; }}"
            )

    def add_favorite(self, coin: str) -> None:
        if not coin or coin in self._fav_coins:
            return
        if len(self._fav_coins) >= self.MAX_FAVORITES:
            return
        self._fav_coins.append(coin)
        idx = len(self._fav_coins) - 1
        self._fav_buttons[idx].setText(coin)
        self._style_fav_button(self._fav_buttons[idx], assigned=True)
