#!/usr/bin/env python3
"""Build Trade_Panel as a standalone executable using PyInstaller.

Usage:
    uv run --with pyinstaller build.py          # build for current OS
    uv run --with pyinstaller build.py --clean  # clean previous build first
"""

import shutil
import subprocess
import sys
import platform
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = ROOT / "Trade_Panel.spec"
DIST = ROOT / "dist"
BUILD = ROOT / "build"


def clean():
    """Remove previous build artifacts."""
    for d in (DIST, BUILD):
        if d.exists():
            print(f"Removing {d} ...")
            shutil.rmtree(d)


def ensure_data_dir():
    """Make sure data/ exists next to the output binary so runtime paths resolve."""
    out_dir = DIST / "Trade_Panel"
    data_dir = out_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)


def build():
    print(f"Building Trade_Panel on {platform.system()} {platform.machine()}")
    print(f"Python: {sys.version}")
    print()

    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm",
        str(SPEC),
    ]
    result = subprocess.run(cmd, cwd=ROOT)
    if result.returncode != 0:
        print("\nBuild FAILED")
        sys.exit(result.returncode)

    ensure_data_dir()

    exe_name = "Trade_Panel.exe" if platform.system() == "Windows" else "Trade_Panel"
    exe_path = DIST / "Trade_Panel" / exe_name
    print(f"\nDone! Executable: {exe_path}")
    print(f"Distributable folder: {DIST / 'Trade_Panel'}")
    print("\nTo distribute: zip/tar the entire 'dist/Trade_Panel/' folder.")
    print("Users need to place keys/.env (or a root .env) alongside the executable, or set env vars.")


if __name__ == "__main__":
    if "--clean" in sys.argv:
        clean()
    build()
