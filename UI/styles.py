"""Shared Qt styles and color constants.

Amber Terminal Noir: near-black surfaces, hairline borders, a rationed amber
accent, and a mono readout face for numeric/trade data.
"""

from PySide6.QtGui import QFont, QFontDatabase

# ── Color palette ────────────────────────────────────────────────────────────
BG_DARK = "#0A0A0A"
BG_PANEL = "#121212"
BG_SURFACE_ALT = "#141414"
BORDER = "#2A2A2A"
HAIRLINE = "rgba(255, 255, 255, 0.1)"
TEXT_PRIMARY = "#FFFFFF"
TEXT_SECONDARY = "#71717A"
TEXT_TERTIARY = "#A1A1AA"
TEXT_MUTED = "#52525B"
ACCENT = "#F5C400"
ACCENT_ALT = "#FF5A3C"
SUCCESS = "#10B981"
DANGER = "#DC2626"

# ── Typography ───────────────────────────────────────────────────────────────
DISPLAY_FAMILIES = ("Clash Grotesk", "Inter", "Noto Sans", "DejaVu Sans")
BODY_FAMILIES = ("Satoshi", "Inter", "Noto Sans", "DejaVu Sans")
MONO_FAMILIES = ("JetBrains Mono", "DejaVu Sans Mono", "Consolas", "Liberation Mono")

_DISPLAY_STACK = ", ".join(f'"{f}"' for f in DISPLAY_FAMILIES)
_BODY_STACK = ", ".join(f'"{f}"' for f in BODY_FAMILIES)
_MONO_STACK = ", ".join(f'"{f}"' for f in MONO_FAMILIES)


def _first_installed(candidates: tuple[str, ...], fallback: str) -> str:
    try:
        families = set(QFontDatabase.families())
    except Exception:
        return fallback
    for name in candidates:
        if name in families:
            return name
    return fallback


def ui_font(kind: str = "body", size: int = 10, weight: QFont.Weight = QFont.Weight.Normal) -> QFont:
    """Return a QFont using the first installed family in the design stack."""
    if kind == "display":
        family = _first_installed(DISPLAY_FAMILIES, "DejaVu Sans")
    elif kind == "mono":
        family = _first_installed(MONO_FAMILIES, "DejaVu Sans Mono")
    else:
        family = _first_installed(BODY_FAMILIES, "DejaVu Sans")
    font = QFont(family, size)
    font.setWeight(weight)
    return font


def configure_app(app) -> None:
    """Apply the global dark palette, typography and stylesheet to QApplication."""
    try:
        app.setStyle("Fusion")
    except Exception:
        pass
    app.setFont(ui_font("body", 10))
    app.setStyleSheet(APP_QSS)


# ── QSS snippets ─────────────────────────────────────────────────────────────

COMBOBOX_STYLE = f"""
    QComboBox {{
        background-color: {BG_DARK};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 6px;
        padding: 3px 8px;
        font-family: {_MONO_STACK};
        font-size: 11px;
        combobox-popup: 0;
    }}
    QComboBox:hover {{ border-color: #3A3A3A; }}
    QComboBox:focus {{ border-color: {ACCENT}; }}
    QComboBox::drop-down {{ border: none; width: 16px; }}
    QComboBox QAbstractItemView {{
        background-color: {BG_PANEL};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        selection-background-color: {BG_SURFACE_ALT};
        selection-color: {TEXT_PRIMARY};
        outline: none;
    }}
"""

CENTER_BUTTON_STYLE = f"""
    QPushButton {{
        background-color: {BG_PANEL};
        color: {TEXT_TERTIARY};
        border: 1px solid {HAIRLINE};
        border-radius: 6px;
        font-size: 13px;
    }}
    QPushButton:hover {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
        border-color: #3A3A3A;
    }}
    QPushButton:focus {{ border-color: {ACCENT}; }}
"""

TEXT_BUTTON_STYLE = f"""
    QPushButton {{
        background-color: transparent;
        color: {TEXT_TERTIARY};
        border: 1px solid {HAIRLINE};
        border-radius: 8px;
        padding: 4px 10px;
        font-size: 11px;
    }}
    QPushButton:hover {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
        border-color: #3A3A3A;
    }}
    QPushButton:focus {{ border-color: {ACCENT}; }}
    QPushButton:disabled {{ color: {TEXT_MUTED}; border-color: #1C1C1C; }}
"""

PRIMARY_BUTTON_STYLE = f"""
    QPushButton {{
        background-color: {ACCENT};
        color: #000000;
        border: 1px solid {ACCENT};
        border-radius: 8px;
        padding: 6px 14px;
        font-size: 11px;
        font-weight: 600;
    }}
    QPushButton:hover {{ background-color: #FFD21F; border-color: #FFD21F; }}
    QPushButton:pressed {{ background-color: #D9AD00; border-color: #D9AD00; }}
    QPushButton:focus {{ border-color: #FFFFFF; }}
"""

APP_QSS = f"""
    QWidget {{
        color: {TEXT_PRIMARY};
        font-family: {_BODY_STACK};
        font-size: 12px;
        selection-background-color: rgba(245, 196, 0, 0.28);
        selection-color: {TEXT_PRIMARY};
    }}
    QMainWindow, QDialog {{
        background-color: {BG_DARK};
    }}
    QLabel {{
        background: transparent;
        color: {TEXT_SECONDARY};
    }}
    QPlainTextEdit, QLineEdit, QSpinBox, QDoubleSpinBox {{
        background-color: {BG_DARK};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 6px;
        padding: 3px 6px;
        font-family: {_MONO_STACK};
        font-size: 11px;
    }}
    QPlainTextEdit:hover, QLineEdit:hover, QSpinBox:hover, QDoubleSpinBox:hover {{
        border-color: #3A3A3A;
    }}
    QPlainTextEdit:focus, QLineEdit:focus, QSpinBox:focus, QDoubleSpinBox:focus {{
        border-color: {ACCENT};
    }}
    QPushButton {{
        background-color: {BG_PANEL};
        color: {TEXT_TERTIARY};
        border: 1px solid {HAIRLINE};
        border-radius: 8px;
        padding: 5px 10px;
        font-size: 11px;
    }}
    QPushButton:hover {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
        border-color: #3A3A3A;
    }}
    QPushButton:pressed {{ background-color: #1C1C1C; }}
    QPushButton:checked {{
        background-color: rgba(245, 196, 0, 0.10);
        border-color: {ACCENT};
        color: {ACCENT};
    }}
    QPushButton:focus {{ border-color: {ACCENT}; }}
    QPushButton:disabled {{ color: {TEXT_MUTED}; border-color: #1C1C1C; }}
    QCheckBox {{
        color: {TEXT_TERTIARY};
        spacing: 6px;
    }}
    QCheckBox::indicator {{
        width: 13px;
        height: 13px;
        border: 1px solid {BORDER};
        border-radius: 3px;
        background: {BG_DARK};
    }}
    QCheckBox::indicator:hover {{ border-color: #3A3A3A; }}
    QCheckBox::indicator:checked {{
        background: {ACCENT};
        border-color: {ACCENT};
    }}
    QSplitter::handle {{ background-color: {BORDER}; }}
    QScrollBar:vertical {{
        background: transparent;
        width: 8px;
        margin: 0;
    }}
    QScrollBar::handle:vertical {{
        background: {BORDER};
        border-radius: 4px;
        min-height: 28px;
    }}
    QScrollBar::handle:vertical:hover {{ background: #3A3A3A; }}
    QScrollBar:horizontal {{
        background: transparent;
        height: 8px;
        margin: 0;
    }}
    QScrollBar::handle:horizontal {{
        background: {BORDER};
        border-radius: 4px;
        min-width: 28px;
    }}
    QScrollBar::handle:horizontal:hover {{ background: #3A3A3A; }}
    QScrollBar::add-line, QScrollBar::sub-line {{ width: 0; height: 0; }}
    QScrollBar::add-page, QScrollBar::sub-page {{ background: transparent; }}
    QTabWidget::pane {{
        border: 1px solid {BORDER};
        background-color: {BG_DARK};
    }}
    QTabBar::tab {{
        background-color: {BG_PANEL};
        color: {TEXT_SECONDARY};
        border: 1px solid {BORDER};
        border-bottom: none;
        border-top-left-radius: 6px;
        border-top-right-radius: 6px;
        padding: 5px 14px;
        font-size: 11px;
        margin-right: 2px;
    }}
    QTabBar::tab:selected {{
        background-color: {BG_DARK};
        color: {TEXT_PRIMARY};
        border-bottom: 1px solid {ACCENT};
    }}
    QHeaderView::section {{
        background-color: {BG_PANEL};
        color: {TEXT_TERTIARY};
        padding: 5px;
        border: 1px solid {BORDER};
        font-size: 10px;
        font-weight: 600;
    }}
    QTableWidget {{
        background-color: {BG_DARK};
        alternate-background-color: #0E0E0E;
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        gridline-color: {BORDER};
        font-family: {_MONO_STACK};
        font-size: 11px;
    }}
    QTableWidget::item:selected {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
    }}
    QListWidget, QListView {{
        background-color: {BG_DARK};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 6px;
        outline: none;
    }}
    QListWidget::item, QListView::item {{
        padding: 4px 6px;
        border-bottom: 1px solid #1C1C1C;
    }}
    QListWidget::item:hover, QListView::item:hover {{ background-color: #0E0E0E; }}
    QListWidget::item:selected, QListView::item:selected {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
    }}
    QGroupBox {{
        background-color: {BG_PANEL};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 12px;
        margin-top: 12px;
        padding-top: 16px;
        font-size: 12px;
        font-weight: 600;
    }}
    QGroupBox::title {{
        subcontrol-origin: margin;
        left: 10px;
        padding: 0 6px;
        color: {TEXT_TERTIARY};
        letter-spacing: 0.5px;
    }}
    QToolTip {{
        background-color: {BG_SURFACE_ALT};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 6px;
        padding: 5px 8px;
    }}
    QMenu {{
        background-color: {BG_PANEL};
        color: {TEXT_PRIMARY};
        border: 1px solid {BORDER};
        border-radius: 8px;
        padding: 4px;
    }}
    QMenu::item {{ padding: 6px 18px; border-radius: 6px; }}
    QMenu::item:selected {{ background-color: {BG_SURFACE_ALT}; }}
"""
