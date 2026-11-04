# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for Trade_Panel trading panel."""

import sys
from pathlib import Path

block_cipher = None

ROOT = Path(".")

a = Analysis(
    ["main.py"],
    pathex=[str(ROOT)],
    binaries=[],
    datas=[
        ("UI/web", "UI/web"),
    ],
    hiddenimports=[
        "main",
        "Core",
        "Core.config",
        "Core.models",
        "Core.calculations",
        "Core.coin_service",
        "Core.candle_service",
        "Core.credentials",
        "Core.alert_service",
        "Core.window_state",
        "Core.market_data",
        "Core.workspace_store",
        "Core.workspace_indicators",
        "Core.utils",
        "Indicator",
        "Indicator.fvg",
        "Indicator.vwap",
        "Indicator.sessions",
        "Indicator.ema_ribbon",
        "Indicator.hl_ema",
        "Indicator.volume_profile",
        "Indicator.adx",
        "Indicator.config",
        "Exchange",
        "Exchange.hyperliquid",
        "UI",
        "UI.main_window",
        "UI.workspace_view",
        "UI.toolbar",
        "UI.styles",
        "UI.config_dialog",
        "UI.handlers",
        "UI.handlers.trade",
        "UI.handlers.position",
        "PySide6.QtWidgets",
        "PySide6.QtCore",
        "PySide6.QtGui",
        "PySide6.QtWebEngineCore",
        "PySide6.QtWebEngineWidgets",
        "PySide6.QtWebChannel",
        "dotenv",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="Trade_Panel",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    icon=None,  # Add .ico/.png path here if you have one
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="Trade_Panel",
)
