"""Entry point for the Trade_Panel trading panel.

Usage:
    python main.py
"""

import sys
import logging
import os

os.environ["QTWEBENGINE_DISABLE_GPU"] = "0"
# -- GPU acceleration flags --
# NOTE: On Wayland, aggressive GPU compositing flags (Vulkan, zero-copy,
# oop-rasterization) cause xdg_surface buffer-size mismatches that crash
# the app.  Use safe defaults; users on X11 can override via env var.
if "QTWEBENGINE_CHROMIUM_FLAGS" not in os.environ:
   os.environ["QTWEBENGINE_CHROMIUM_FLAGS"] = (
         "--enable-gpu-rasterization --ignore-gpu-blocklist"
     )

# Prefer hardware acceleration; only fall back to software if the user opts in.
if "QT_QUICK_BACKEND" not in os.environ:
    os.environ["QT_QUICK_BACKEND"] = "rhi"

from PySide6.QtWidgets import QApplication

from UI.main_window import MainWindow
from UI.styles import configure_app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-25s %(levelname)-7s %(message)s",
    )
    app = QApplication(sys.argv)
    configure_app(app)
    window = MainWindow()
    window.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
