# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the TradePanel Python sidecar.

One-folder by default: the shell spawns the executable directly, which gives a
single supervised process. A one-file build runs a bootloader parent plus a
Python child; killing the spawned parent then leaves an orphan, so it is only
available as an explicit debugging option via TRADEPANEL_BACKEND_ONEFILE=1.

console=True is required: windowed mode detaches stdio on Windows and would
break the JSON-RPC pipe. Tauri spawns the process without a console window.
"""

import os
from pathlib import Path

ROOT = Path(SPECPATH).resolve().parent.parent  # repo root

datas, binaries, hiddenimports = [], [], []
hiddenimports += [
    "backend",
    "backend.sidecar",
    "backend.ipc",
    "backend.ipc.server",
    "backend.ipc.methods",
    "backend.ipc.protocol",
    "backend.ipc.credentials",
    "backend.Core",
    "backend.Core.config",
    "backend.Core.models",
    "backend.Core.calculations",
    "backend.Core.coin_service",
    "backend.Core.credentials",
    "backend.Core.window_state",
    "backend.Core.market_data",
    "backend.Core.workspace_store",
    "backend.Core.trading_service",
    "backend.Exchange",
    "backend.Exchange.hyperliquid",
    "dotenv",
    "hyperliquid",
    "hyperliquid.info",
    "hyperliquid.exchange",
    "hyperliquid.utils",
    "eth_account",
    "requests",
]

a = Analysis(
    [str(ROOT / "backend" / "sidecar.py")],
    pathex=[str(ROOT)],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PySide6", "PyQt5", "PyQt6", "tkinter", "matplotlib", "IPython",
        "scipy", "notebook", "jupyter", "pytest",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

onefile = os.environ.get("TRADEPANEL_BACKEND_ONEFILE") == "1"

if not onefile:
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name="tradepanel-backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=False,
        name="tradepanel-backend",
    )
else:
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.datas,
        [],
        name="tradepanel-backend",
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=True,
        runtime_tmpdir=None,
    )
