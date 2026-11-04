"""Indicator configuration dialog.

Allows tweaking indicator parameters (FVG, VWAP, Sessions, Lines).
Config persistence is handled by Indicator.config.
"""

from __future__ import annotations

import logging

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QDialog, QGridLayout, QGroupBox, QHBoxLayout, QLabel,
    QPlainTextEdit, QPushButton, QVBoxLayout, QWidget, QScrollArea,
    QComboBox, QSizePolicy,
)

from Indicator.config import load_indicator_config
from UI.styles import (
    ACCENT,
    BG_DARK,
    BG_PANEL,
    BG_SURFACE_ALT,
    BORDER,
    DANGER,
    HAIRLINE,
    SUCCESS,
    TEXT_MUTED,
    TEXT_PRIMARY,
    TEXT_SECONDARY,
    TEXT_TERTIARY,
)

log = logging.getLogger(__name__)


class _FieldRow:
    """Helper: label + small text edit for a single parameter."""

    def __init__(self, label: str, value, width: int = 60):
        self.label = QLabel(label)
        self.label.setStyleSheet(f"color: {TEXT_SECONDARY}; font-size: 10px; font-weight: 600; letter-spacing: 0.4px; background: transparent;")
        self.label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self.edit = QPlainTextEdit()
        self.edit.setPlainText(str(value))
        self.edit.setFixedHeight(28)
        self.edit.setMinimumWidth(width)
        self.edit.setSizePolicy(QSizePolicy.Policy.MinimumExpanding, QSizePolicy.Policy.Fixed)
        self.edit.setStyleSheet(f"""
            QPlainTextEdit {{
                background-color: {BG_DARK};
                color: {TEXT_PRIMARY};
                border: 1px solid {BORDER};
                border-radius: 6px;
                font-family: 'JetBrains Mono', 'DejaVu Sans Mono', monospace;
                font-size: 11px;
                padding: 2px 6px;
            }}
            QPlainTextEdit:focus {{ border-color: {ACCENT}; }}
        """)

    def value(self):
        return self.edit.toPlainText().strip()

    def float_value(self, default: float = 0.0) -> float:
        try:
            return float(self.edit.toPlainText().strip())
        except ValueError:
            return default


class IndicatorConfigDialog(QDialog):
    """Modal dialog for tweaking indicator parameters."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("Indicator Config")
        self.setMinimumWidth(640)
        self.setStyleSheet(f"""
            QDialog {{
                background-color: {BG_DARK};
            }}
            QGroupBox {{
                background-color: {BG_PANEL};
                color: {TEXT_PRIMARY};
                font-size: 12px;
                font-weight: 600;
                border: 1px solid {HAIRLINE};
                border-radius: 12px;
                margin-top: 12px;
                padding-top: 16px;
            }}
            QGroupBox::title {{
                subcontrol-origin: margin;
                left: 10px;
                padding: 0 6px;
                color: {TEXT_TERTIARY};
                letter-spacing: 0.5px;
            }}
            QLabel {{
                color: {TEXT_SECONDARY};
                font-size: 11px;
                background: transparent;
            }}
        """)
        self._cfg = load_indicator_config()
        self._build_ui()

    def _build_ui(self) -> None:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.Shape.NoFrame)
        scroll.setStyleSheet(f"QScrollArea {{ background: {BG_DARK}; border: none; }}")

        content = QWidget()
        content.setStyleSheet(f"background-color: {BG_DARK};")
        layout = QVBoxLayout(content)
        layout.setSpacing(8)

        layout.addWidget(self._build_fvg_group())
        layout.addWidget(self._build_vwap_group())
        layout.addWidget(self._build_session_group())
        layout.addWidget(self._build_ema_ribbon_group())
        layout.addWidget(self._build_volume_profile_group())
        layout.addWidget(self._build_hl_ema_group())
        layout.addWidget(self._build_adx_group())
        layout.addStretch()

        scroll.setWidget(content)

        btn_layout = QHBoxLayout()
        btn_layout.addStretch()

        save_btn = QPushButton("Save")
        save_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: {ACCENT}; color: #000000;
                font-weight: 600; font-size: 12px;
                padding: 7px 24px; border-radius: 8px;
                border: 1px solid {ACCENT};
            }}
            QPushButton:hover {{ background-color: #FFD21F; border-color: #FFD21F; }}
            QPushButton:focus {{ border-color: #FFFFFF; }}
        """)
        save_btn.clicked.connect(self._on_save)

        cancel_btn = QPushButton("Cancel")
        cancel_btn.setStyleSheet(f"""
            QPushButton {{
                background-color: transparent; color: {TEXT_TERTIARY};
                border: 1px solid {HAIRLINE};
                font-size: 12px; padding: 7px 24px; border-radius: 8px;
            }}
            QPushButton:hover {{ background-color: {BG_SURFACE_ALT}; color: {TEXT_PRIMARY}; }}
            QPushButton:focus {{ border-color: {ACCENT}; }}
        """)
        cancel_btn.clicked.connect(self.reject)

        btn_layout.addWidget(cancel_btn)
        btn_layout.addWidget(save_btn)

        root = QVBoxLayout(self)
        root.addWidget(scroll)
        root.addLayout(btn_layout)

    # ── Group Builders ───────────────────────────────────────────────────────

    def _build_fvg_group(self) -> QGroupBox:
        group = QGroupBox("Fair Value Gap (FVG)")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("fvg", {})

        self._fvg_gap = _FieldRow("Gap %", cfg.get("gap_pct", 0.5), 60)
        lay.addWidget(self._fvg_gap.label, 0, 0)
        lay.addWidget(self._fvg_gap.edit, 0, 1)
        note = QLabel("(Min gap size as % of price, e.g. 0.5 = 0.5%)")
        note.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note, 0, 2)
        return group

    def _build_vwap_group(self) -> QGroupBox:
        group = QGroupBox("VWAP")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("vwap", {})

        self._vwap_anchor_intra = _FieldRow("Intraday anchor", cfg.get("anchor_intraday", "D"), 40)
        self._vwap_anchor_daily = _FieldRow("Daily+ anchor", cfg.get("anchor_daily", "W"), 40)

        lay.addWidget(self._vwap_anchor_intra.label, 0, 0)
        lay.addWidget(self._vwap_anchor_intra.edit, 0, 1)
        note1 = QLabel("(D=day, W=week)")
        note1.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note1, 0, 2)
        lay.addWidget(self._vwap_anchor_daily.label, 1, 0)
        lay.addWidget(self._vwap_anchor_daily.edit, 1, 1)
        return group

    def _build_session_group(self) -> QGroupBox:
        group = QGroupBox("Session Boxes")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("sessions", {})

        sessions = [
            ("Asian", "#FFD700", "asian", "01:00", "07:00"),
            ("London", "#7B68EE", "london", "08:00", "14:00"),
            ("NY AM", "#FF6347", "ny_am", "13:30", "16:00"),
            ("NY PM", "#00CED1", "ny_pm", "16:00", "20:00"),
        ]

        header_start = QLabel("Start")
        header_start.setStyleSheet(f"color: {TEXT_SECONDARY}; font-size: 10px; font-weight: 600; letter-spacing: 0.4px; background: transparent;")
        header_end = QLabel("End")
        header_end.setStyleSheet(f"color: {TEXT_SECONDARY}; font-size: 10px; font-weight: 600; letter-spacing: 0.4px; background: transparent;")
        lay.addWidget(header_start, 0, 1)
        lay.addWidget(header_end, 0, 2)

        for row, (name, color, key, def_start, def_end) in enumerate(sessions, start=1):
            lbl = QLabel(name)
            lbl.setStyleSheet(f"color: {color}; font-size: 11px; font-weight: bold;")
            lay.addWidget(lbl, row, 0)

            start_val = cfg.get(f"{key}_start", def_start)
            end_val = cfg.get(f"{key}_end", def_end)

            start_field = _FieldRow("", start_val, 60)
            end_field = _FieldRow("", end_val, 60)

            lay.addWidget(start_field.edit, row, 1)
            lay.addWidget(end_field.edit, row, 2)

            # Store references for saving
            setattr(self, f"_{key}_start", start_field)
            setattr(self, f"_{key}_end", end_field)

        note = QLabel("Start/End define the window used for the session high/low. The box extends to the next session's start. (All times in UTC)")
        note.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        note.setWordWrap(True)
        lay.addWidget(note, len(sessions) + 1, 0, 1, 3)
        return group

    # ── EMA Ribbon Group ────────────────────────────────────────────────────

    def _build_ema_ribbon_group(self) -> QGroupBox:
        group = QGroupBox("MA Ribbon (3 Lines)")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("ema_ribbon", {})

        # MA Type selector
        type_label = QLabel("MA Type")
        type_label.setStyleSheet(f"color: {TEXT_SECONDARY}; font-size: 10px; font-weight: 600; letter-spacing: 0.4px; background: transparent;")
        type_label.setAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        self._ribbon_ma_type = QComboBox()
        self._ribbon_ma_type.addItems(["EMA", "SMA"])
        self._ribbon_ma_type.setCurrentText(cfg.get("ma_type", "EMA"))
        self._ribbon_ma_type.setFixedHeight(28)
        self._ribbon_ma_type.setFixedWidth(80)
        self._ribbon_ma_type.setStyleSheet(f"""
            QComboBox {{
                background-color: {BG_DARK};
                color: {TEXT_PRIMARY};
                border: 1px solid {BORDER};
                border-radius: 6px;
                font-size: 11px;
                padding: 2px 6px;
            }}
            QComboBox:focus {{ border-color: {ACCENT}; }}
            QComboBox::drop-down {{ border: none; }}
            QComboBox QAbstractItemView {{
                background-color: {BG_PANEL};
                color: {TEXT_PRIMARY};
                selection-background-color: {BG_SURFACE_ALT};
            }}
        """)
        lay.addWidget(type_label, 0, 0)
        lay.addWidget(self._ribbon_ma_type, 0, 1)
        note = QLabel("(Type: EMA or SMA)")
        note.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note, 0, 2)

        # Line 1 Length
        self._ribbon_length1 = _FieldRow("Line 1 Length", cfg.get("length1", 20), 60)
        lay.addWidget(self._ribbon_length1.label, 1, 0)
        lay.addWidget(self._ribbon_length1.edit, 1, 1)
        color1 = QLabel("(Blue)")
        color1.setStyleSheet("color: #2196F3; font-size: 10px;")
        lay.addWidget(color1, 1, 2)

        # Line 2 Length
        self._ribbon_length2 = _FieldRow("Line 2 Length", cfg.get("length2", 40), 60)
        lay.addWidget(self._ribbon_length2.label, 2, 0)
        lay.addWidget(self._ribbon_length2.edit, 2, 1)
        color2 = QLabel("(Orange)")
        color2.setStyleSheet("color: #FF9800; font-size: 10px;")
        lay.addWidget(color2, 2, 2)

        # Line 3 Length
        self._ribbon_length3 = _FieldRow("Line 3 Length", cfg.get("length3", 60), 60)
        lay.addWidget(self._ribbon_length3.label, 3, 0)
        lay.addWidget(self._ribbon_length3.edit, 3, 1)
        color3 = QLabel("(Purple)")
        color3.setStyleSheet("color: #9C27B0; font-size: 10px;")
        lay.addWidget(color3, 3, 2)

        return group

    # ── Volume Profile Group ─────────────────────────────────────────────────

    def _build_volume_profile_group(self) -> QGroupBox:
        group = QGroupBox("Volume Profile")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("volume_profile", {})

        self._vp_length = _FieldRow("Candle Length", cfg.get("length", 100), 60)
        lay.addWidget(self._vp_length.label, 0, 0)
        lay.addWidget(self._vp_length.edit, 0, 1)
        note1 = QLabel("(Number of candles to analyse)")
        note1.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note1, 0, 2)

        self._vp_rows = _FieldRow("Price Rows", cfg.get("rows", 24), 60)
        lay.addWidget(self._vp_rows.label, 1, 0)
        lay.addWidget(self._vp_rows.edit, 1, 1)
        note2 = QLabel("(Number of horizontal price bins)")
        note2.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note2, 1, 2)

        return group

    # ── High/Low EMA Group ──────────────────────────────────────────────────

    def _build_hl_ema_group(self) -> QGroupBox:
        group = QGroupBox("High/Low EMA")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("hl_ema", {})

        self._hl_ema_length = _FieldRow("EMA Length", cfg.get("length", 20), 60)
        lay.addWidget(self._hl_ema_length.label, 0, 0)
        lay.addWidget(self._hl_ema_length.edit, 0, 1)
        note = QLabel("(EMA length applied to both candle highs and lows, default 20)")
        note.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note, 0, 2)
        return group

    # ── ADX Group ────────────────────────────────────────────────────────

    def _build_adx_group(self) -> QGroupBox:
        group = QGroupBox("ADX (Average Directional Index)")
        lay = QGridLayout(group)
        lay.setSpacing(4)
        cfg = self._cfg.get("adx", {})

        self._adx_length = _FieldRow("Length", cfg.get("length", 14), 60)
        lay.addWidget(self._adx_length.label, 0, 0)
        lay.addWidget(self._adx_length.edit, 0, 1)
        note = QLabel("(Default 14 — Wilder smoothing window. Reference levels drawn at 20 and 25.)")
        note.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note, 0, 2)

        self._adx_pane_height = _FieldRow("Pane Height (px)", cfg.get("pane_height", 160), 60)
        lay.addWidget(self._adx_pane_height.label, 1, 0)
        lay.addWidget(self._adx_pane_height.edit, 1, 1)
        note2 = QLabel("(Subchart pane height in pixels; range 60-400, default 160.)")
        note2.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note2, 1, 2)

        self._adx_show_di = self._make_toggle("Show +/- DI lines", cfg.get("show_di_lines", False))
        lay.addWidget(self._adx_show_di["label"], 2, 0)
        lay.addWidget(self._adx_show_di["btn"], 2, 1)
        note3 = QLabel("(Off by default: only ADX line + 25 reference shown.)")
        note3.setStyleSheet(f"color: {TEXT_MUTED}; font-size: 10px; background: transparent;")
        lay.addWidget(note3, 2, 2)
        return group

    # ── Helpers ──────────────────────────────────────────────────────────────

    def _make_toggle(self, label: str, checked: bool) -> dict:
        lbl = QLabel(label)
        lbl.setStyleSheet(f"color: {TEXT_PRIMARY}; font-size: 11px; background: transparent;")
        btn = QPushButton("On" if checked else "Off")
        btn.setCheckable(True)
        btn.setChecked(checked)
        btn.setFixedWidth(50)
        btn.setFixedHeight(26)
        self._apply_toggle_style(btn, checked)
        btn.toggled.connect(lambda c: self._apply_toggle_style(btn, c))
        return {"label": lbl, "btn": btn}

    @staticmethod
    def _parse_hhmm(value: str, default_h: int, default_m: int) -> tuple[int, int]:
        """Parse a HH:MM string, falling back to defaults on error."""
        value = (value or "").strip()
        if not value:
            return default_h, default_m
        try:
            parts = value.split(":")
            h = int(parts[0])
            m = int(parts[1]) if len(parts) > 1 else 0
            return h % 24, m % 60
        except (ValueError, IndexError):
            return default_h, default_m

    @staticmethod
    def _apply_toggle_style(btn: QPushButton, checked: bool) -> None:
        if checked:
            btn.setText("On")
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: rgba(16, 185, 129, 0.14);
                    border: 1px solid {SUCCESS}; border-radius: 6px;
                    color: {SUCCESS}; font-size: 11px; font-weight: 600;
                }}
            """)
        else:
            btn.setText("Off")
            btn.setStyleSheet(f"""
                QPushButton {{
                    background-color: rgba(220, 38, 38, 0.12);
                    border: 1px solid {DANGER}; border-radius: 6px;
                    color: {DANGER}; font-size: 11px; font-weight: 600;
                }}
            """)

    # ── Save ─────────────────────────────────────────────────────────────────

    def _on_save(self) -> None:
        self._cfg["fvg"]["gap_pct"] = self._fvg_gap.float_value(0.5)
        self._cfg["vwap"]["anchor_intraday"] = self._vwap_anchor_intra.value() or "D"
        self._cfg["vwap"]["anchor_daily"] = self._vwap_anchor_daily.value() or "W"

        for key in ("asian", "london", "ny_am", "ny_pm"):
            start_field = getattr(self, f"_{key}_start")
            end_field = getattr(self, f"_{key}_end")
            start_h, start_m = self._parse_hhmm(start_field.value(), 0, 0)
            end_h, end_m = self._parse_hhmm(end_field.value(), 0, 0)
            self._cfg["sessions"][f"{key}_start"] = f"{start_h:02d}:{start_m:02d}"
            self._cfg["sessions"][f"{key}_end"] = f"{end_h:02d}:{end_m:02d}"
            # Legacy keys are no longer saved; config.py migrates them on load.

        # EMA Ribbon
        self._cfg["ema_ribbon"]["ma_type"] = self._ribbon_ma_type.currentText()
        self._cfg["ema_ribbon"]["length1"] = int(self._ribbon_length1.float_value(20))
        self._cfg["ema_ribbon"]["length2"] = int(self._ribbon_length2.float_value(40))
        self._cfg["ema_ribbon"]["length3"] = int(self._ribbon_length3.float_value(60))

        # Volume Profile
        self._cfg["volume_profile"]["length"] = int(self._vp_length.float_value(100))
        self._cfg["volume_profile"]["rows"] = int(self._vp_rows.float_value(24))

        # High/Low EMA
        self._cfg["hl_ema"]["length"] = int(self._hl_ema_length.float_value(20))

        # ADX
        self._cfg["adx"]["length"] = int(self._adx_length.float_value(14))
        self._cfg["adx"]["pane_height"] = int(self._adx_pane_height.float_value(160))
        self._cfg["adx"]["show_di_lines"] = bool(self._adx_show_di["btn"].isChecked())

        self.accept()

    def result_config(self) -> dict:
        """Return the config dict (only valid after accept)."""
        return self._cfg
