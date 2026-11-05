"""TradePanel Python sidecar.

Usage (spawned by the Tauri shell, never by the user directly):

    tradepanel-backend [--stdio]

* ``--stdio`` (default) speaks JSON-RPC 2.0 over stdin/stdout, one frame per line.
* ``--self-check`` imports the full backend surface and exits non-zero on failure.
  Used by build scripts to smoke-test the PyInstaller bundle.
* ``--version`` prints the backend/protocol version to stderr.

stdout is defended before any backend module is imported: fd 1 is duplicated for
the protocol writer and the original descriptor is redirected to stderr. Stray
``print()`` calls from dependencies therefore land on stderr and can never
corrupt the framing.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
from pathlib import Path
from typing import BinaryIO


def _defend_stdout() -> BinaryIO:
    """Reserve the real stdout for protocol frames; send stray output to stderr."""
    try:
        protocol_fd = os.dup(1)
    except OSError:
        # No usable stdout (should not happen when spawned by Tauri).
        return os.fdopen(2, "wb", buffering=0)  # type: ignore[return-value]
    try:
        os.dup2(2, 1)
    except OSError:
        pass
    try:
        sys.stdout = sys.stderr
    except Exception:
        pass
    return os.fdopen(protocol_fd, "wb", buffering=0)


def _ensure_project_root_on_path() -> None:
    """Dev mode: ``python backend/sidecar.py`` needs the repo root importable."""
    if getattr(sys, "frozen", False):
        return
    root = Path(__file__).resolve().parent.parent
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))


def _configure_logging() -> None:
    level = os.environ.get("TRADEPANEL_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(
        level=getattr(logging, level, logging.INFO),
        format="%(asctime)s %(levelname)-7s %(name)-28s %(message)s",
        stream=sys.stderr,
    )
    # Third-party HTTP clients are noisy at INFO; keep warnings and errors.
    for noisy in ("urllib3", "requests", "hyperliquid", "httpx"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def _self_check() -> int:
    from backend.ipc import methods
    from backend.ipc.protocol import PROTOCOL_VERSION
    from Core import market_data, workspace_store

    exchanges = market_data.exchanges_meta()
    layouts = list(workspace_store.LAYOUTS)
    required = {
        "system.hello", "market.get_candles", "market.get_tick",
        "workspace.load", "workspace.save", "trading.place_order",
    }
    missing = required - set(methods.METHODS)
    if missing:
        print(f"Missing RPC methods: {sorted(missing)}", file=sys.stderr)
        return 2
    if not exchanges or not layouts:
        print("Market metadata unavailable", file=sys.stderr)
        return 3
    print(
        f"OK protocol={PROTOCOL_VERSION} methods={len(methods.METHODS)} "
        f"exchanges={len(exchanges)} layouts={len(layouts)}",
        file=sys.stderr,
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--stdio", action="store_true",
                        help="speak JSON-RPC over stdin/stdout (default)")
    parser.add_argument("--self-check", action="store_true",
                        help="import the backend and exit")
    parser.add_argument("--version", action="store_true")
    args = parser.parse_args(argv)

    _ensure_project_root_on_path()
    _configure_logging()

    if args.version:
        from backend.ipc.methods import BACKEND_VERSION
        from backend.ipc.protocol import PROTOCOL_VERSION
        print(
            f"tradepanel-backend {BACKEND_VERSION} (protocol {PROTOCOL_VERSION})",
            file=sys.stderr,
        )
        return 0
    if args.self_check:
        return _self_check()

    writer = _defend_stdout()

    from backend.ipc.server import RpcServer

    def _interrupt(_signum, _frame):
        raise KeyboardInterrupt

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _interrupt)
        except (ValueError, OSError):  # pragma: no cover - non-main thread
            pass

    server = RpcServer(sys.stdin.buffer, writer)
    try:
        return server.serve_forever()
    finally:
        try:
            writer.flush()
            writer.close()
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(main())
