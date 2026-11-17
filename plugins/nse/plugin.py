#!/usr/bin/env python3
"""TradePanel NSE datafeed plugin for OpenTrader (Plugin API 2).

Starts from `OPENTRADER_PLUGIN_ADDR` / `OPENTRADER_PLUGIN_TOKEN` when the app
launches it, or reads a connection file in development (`--connection-file`).
No credentials are used: this plugin only serves public market data.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, IO

from nse_source import NseSource, PluginError

PLUGIN_ID = "nse"
API = 2
VERSION = "1.2.0"
HELLO_TIMEOUT = 12.0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def local_app_data() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


DEFAULT_CONNECTION_FILE = local_app_data() / "OpenTraderPlugins" / "nse-dev.json"


class Rpc:
    """Newline-delimited JSON-RPC 2.0 over one local socket."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._reader: IO[str] = sock.makefile("r", encoding="utf-8", newline="\n")
        self._writer: IO[str] = sock.makefile("w", encoding="utf-8", newline="\n")
        self._write_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._handlers: tuple[Callable[[Any, str, dict[str, Any]], None], Callable[[str, dict[str, Any]], None]] | None = None
        self._queued: list[dict[str, Any]] = []
        self._next = 0
        self._closed = False
        self._thread = threading.Thread(target=self._read, name="nse-rpc", daemon=True)
        self._thread.start()

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        with self._write_lock:
            if self._closed:
                return
            try:
                self._writer.write(line + "\n")
                self._writer.flush()
            except (BrokenPipeError, ValueError, OSError):
                self._closed = True

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)

    def respond(self, request_id: Any, result: Any = None, error: dict[str, Any] | None = None) -> None:
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            message["error"] = error
        else:
            message["result"] = result if result is not None else {}
        self.send(message)

    def request(self, method: str, params: dict[str, Any], timeout: float) -> Any:
        with self._id_lock:
            self._next += 1
            request_id = f"plugin-{self._next}"
        event = threading.Event()
        slot: dict[str, Any] = {}
        self._pending[request_id] = (event, slot)
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        try:
            if not event.wait(timeout):
                raise PluginError(f"The app did not answer {method} within {timeout:.0f}s")
        finally:
            self._pending.pop(request_id, None)
        if "error" in slot:
            error = slot["error"] or {}
            raise PluginError(str(error.get("message") or error), int(error.get("code") or -32000))
        return slot.get("result")

    def run(self, on_request: Callable[[Any, str, dict[str, Any]], None],
            on_notification: Callable[[str, dict[str, Any]], None]) -> None:
        self._handlers = (on_request, on_notification)
        with self._id_lock:
            queued, self._queued = self._queued, []
        for message in queued:
            self._dispatch(message)
        while not self._closed:
            self._thread.join(timeout=0.5)

    def _read(self) -> None:
        for line in self._reader:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                log(f"[protocol] bad JSON line: {line[:200]}")
                continue
            if not isinstance(message, dict):
                continue
            if "method" not in message:
                pending = self._pending.get(str(message.get("id")))
                if pending:
                    pending[1].update(message)
                    pending[0].set()
                continue
            if self._handlers is None:
                self._queued.append(message)
                continue
            self._dispatch(message)
        self._closed = True

    def _dispatch(self, message: dict[str, Any]) -> None:
        handlers = self._handlers
        if handlers is None:
            return
        method = str(message.get("method") or "")
        params = message.get("params") or {}
        if not isinstance(params, dict):
            params = {}
        if "id" in message:
            handlers[0](message["id"], method, params)
        else:
            handlers[1](method, params)

    def close(self) -> None:
        self._closed = True
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        for stream in (self._reader, self._writer):
            try:
                stream.close()
            except (OSError, ValueError):
                pass
        try:
            self._sock.close()
        except OSError:
            pass


class NsePlugin:
    """The datafeed methods of this plugin, dispatched from the app's requests."""

    def __init__(self, rpc: Rpc, source: NseSource | None = None):
        self._rpc = rpc
        self._source = source or NseSource(log=self._notice)
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="nse-call")
        self._closed = False

    def _notice(self, message: str) -> None:
        if not self._closed:
            self._rpc.notify("log", {"level": "info", "message": message})

    def on_request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        def run() -> None:
            try:
                result = self._call(method, params)
            except PluginError as e:
                self._rpc.respond(request_id, error={"code": e.code, "message": str(e)})
            except Exception as e:  # noqa: BLE001 - a bug must not take the connection down
                log(f"[error] {method}: {e!r}")
                self._rpc.respond(request_id, error={"code": -32000, "message": str(e)})
            else:
                self._rpc.respond(request_id, result=result)

        try:
            self._pool.submit(run)
        except RuntimeError:  # the pool is shut down: the app is going away
            pass

    def on_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "plugin.configure":
            raw = params.get("settings")
            settings = raw if isinstance(raw, dict) else {}
            self._source.configure({str(k): str(v) for k, v in settings.items()})
        elif method == "data.subscribe":
            try:
                self._source.subscribe([str(t) for t in (params.get("tickers") or [])])
            except PluginError as e:
                self._notice(str(e))

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ping":
            return {}
        if method == "data.search":
            return {"symbols": self._source.search(str(params.get("query") or ""))}
        if method == "data.symbolInfo":
            return self._source.symbol_info(str(params.get("ticker") or ""))
        if method == "data.refreshSymbols":
            return self._source.refresh_symbols()
        if method == "data.bars":
            return {"bars": self._source.bars(
                str(params.get("ticker") or ""),
                str(params.get("resolution") or "1D"),
                float(params.get("from") or 0),
                float(params.get("to") or 0),
                min(50_000, max(1, int(params.get("countBack") or 500))),
            )}
        raise PluginError(f"{method} is not a method of this plugin", -32601)

    def start(self) -> None:
        self._source.warm()
        self._source.start(self._emit_quote)

    def _emit_quote(self, quote: dict[str, Any]) -> None:
        if not self._closed:
            self._rpc.notify("data.quote", quote)

    def close(self) -> None:
        self._closed = True
        self._source.stop()
        self._pool.shutdown(wait=False, cancel_futures=True)


def connect_from_env() -> tuple[str, str] | None:
    addr = os.environ.get("OPENTRADER_PLUGIN_ADDR")
    token = os.environ.get("OPENTRADER_PLUGIN_TOKEN")
    return (addr, token) if addr and token else None


def read_connection_file(path: Path) -> tuple[str, str] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    host = str(data.get("host") or "127.0.0.1")
    port = data.get("port")
    token = str(data.get("token") or "")
    if not port or not token:
        return None
    return f"{host}:{port}", token


def open_socket(addr: str, token: str | None, connection: Path | None) -> tuple[Rpc, dict[str, Any]] | None:
    host, _, port = addr.rpartition(":")
    try:
        sock = socket.create_connection((host or "127.0.0.1", int(port)), timeout=5)
    except (OSError, ValueError):
        return None
    sock.settimeout(None)
    rpc = Rpc(sock)
    try:
        hello = rpc.request("hello", {
            "plugin": PLUGIN_ID, "token": token or "", "api": API, "version": VERSION,
        }, timeout=HELLO_TIMEOUT)
    except PluginError as e:
        log(f"[connect] hello refused: {e}")
        rpc.close()
        return None
    return rpc, hello if isinstance(hello, dict) else {}


def serve(connection: Path | None) -> int:
    stopping = threading.Event()
    current: list[Rpc] = []

    def on_signal(_signum: int, _frame: Any) -> None:
        stopping.set()
        if current:
            current[0].close()

    signal.signal(signal.SIGINT, on_signal)
    signal.signal(signal.SIGTERM, on_signal)

    warned = False
    while not stopping.is_set():
        found = connect_from_env()
        if not found and connection is not None:
            found = read_connection_file(connection)
            if not found and not warned:
                warned = True
                log(f"[connect] waiting for {connection} (enable the plugin in OpenTrader)")
        if not found:
            stopping.wait(2.0)
            continue
        addr, token = found
        opened = open_socket(addr, token, connection)
        if opened is None:
            stopping.wait(2.0)
            continue
        rpc, _ = opened
        current[:] = [rpc]
        plugin = NsePlugin(rpc)
        plugin.start()
        try:
            rpc.run(plugin.on_request, plugin.on_notification)
        finally:
            plugin.close()
            rpc.close()
            log("[connect] disconnected")
            if connect_from_env():
                break  # the app's process is going away; its supervisor restarts it
            stopping.wait(1.0)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TradePanel NSE datafeed plugin for OpenTrader")
    parser.add_argument("--connection-file", type=Path, default=None,
                        help=f"the app's connection file (default {DEFAULT_CONNECTION_FILE})")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    args = parser.parse_args(argv)
    if args.version:
        print(VERSION)
        return 0
    return serve(args.connection_file or DEFAULT_CONNECTION_FILE)


if __name__ == "__main__":
    raise SystemExit(main())
