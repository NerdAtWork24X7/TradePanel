#!/usr/bin/env python3
"""Package the crypto plugin as a zip for Settings > Plugins > Install from file.

    python plugins/crypto/build.py

The archive holds `opentrader-plugin.json` at its root and the plugin's Python files. It
prints its SHA-256, which a plugin catalog needs next to the URL.
"""

from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "dist"
SKIP = {"__pycache__", "tests", ".venv", ".pytest_cache", "dist", "build.py"}


def main() -> int:
    manifest = json.loads((HERE / "opentrader-plugin.json").read_text(encoding="utf-8"))
    OUT.mkdir(parents=True, exist_ok=True)
    target = OUT / f"crypto-{manifest['version']}.zip"
    files = [
        path for path in sorted(HERE.rglob("*"))
        if path.is_file() and not any(part in SKIP for part in path.relative_to(HERE).parts)
    ]
    with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in files:
            archive.write(path, path.relative_to(HERE).as_posix())
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    print(f"{target}  ({target.stat().st_size} bytes, {len(files)} files)")
    print(f"sha256 {digest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
