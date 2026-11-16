#!/usr/bin/env python3
"""Package each venue's broker as a zip for Settings > Plugins > Install from file.

    python plugins/ccxt-broker/build.py            # every venue
    python plugins/ccxt-broker/build.py --venue okx

The archive holds the generated ``opentrader-plugin.json`` at its root (built from
``specs.json``, see ``manifests.py``) and the plugin's Python files. It prints the SHA-256
of each archive, which a plugin catalog needs next to the URL.
"""

from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "dist"
SKIP = {"__pycache__", "tests", ".venv", ".pytest_cache", "dist", "build.py", "manifests.py"}


def files() -> list[Path]:
    return [
        path
        for path in sorted(HERE.rglob("*"))
        if path.is_file() and not any(part in SKIP for part in path.relative_to(HERE).parts)
    ]


def build(venue_id: str | None = None) -> list[Path]:
    import manifests  # noqa: PLC0415 - the generator owns the manifests

    all_manifests = manifests.read()
    if venue_id is not None and venue_id not in all_manifests:
        raise SystemExit(f"Unknown venue {venue_id!r}; expected one of {', '.join(all_manifests)}")
    wanted = {venue_id: all_manifests[venue_id]} if venue_id else all_manifests
    OUT.mkdir(parents=True, exist_ok=True)
    built: list[Path] = []
    for pid, manifest in wanted.items():
        target = OUT / f"{pid}-{manifest['version']}.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("opentrader-plugin.json", json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
            for path in files():
                archive.write(path, path.relative_to(HERE).as_posix())
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        print(f"{target}  ({target.stat().st_size} bytes)  sha256 {digest}")
        built.append(target)
    return built


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    venue_id = None
    if "--venue" in args:
        at = args.index("--venue")
        venue_id = args[at + 1] if at + 1 < len(args) else ""
    build(venue_id)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
