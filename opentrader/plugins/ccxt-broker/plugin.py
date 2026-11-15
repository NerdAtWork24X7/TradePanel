#!/usr/bin/env python3
"""TradePanel CCXT broker for OpenTrader: one exchange per installed plugin.

Protocol: OpenTrader Plugin API 2 (plugins/PROTOCOL.md). The process either
  * is started by the app (`process` runtime): the address and token arrive in
    OPENTRADER_PLUGIN_ADDR / OPENTRADER_PLUGIN_TOKEN, and the venue in `--venue`, or
  * runs by itself (`external` runtime, development): it reads the connection file the app
    writes while the plugin is enabled (`--connection-file`, default
    {localAppData}/OpenTraderPlugins/ccxt-broker-dev.json).

Nothing here logs a credential. The API key only travels from the app's `plugin.configure`
message (which the app fills from the OS credential store) into the venue's ccxt client.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable, IO

from ccxt_broker import BrokerError, CcxtBroker
from specs import SpecError, Venue, venue as find_venue

API = 2
VERSION = "0.1.0"
HELLO_TIMEOUT = 12.0


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def local_app_data() -> Path:
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    return Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")


DEFAULT_CONNECTION_FILE = local_app_data() / "OpenTraderPlugins" / "ccxt-broker-dev.json"


class Rpc:
    """One JSON-RPC 2.0 line stream: requests, notifications and their answers."""

    def __init__(self, sock: socket.socket):
        self._sock = sock
        self._reader: IO[str] = sock.makefile("r", encoding="utf-8", newline="\n")
        self._writer: IO[str] = sock.makefile("w", encoding="utf-8", newline="\n")
        self._write_lock = threading.Lock()
        self._id_lock = threading.Lock()
        self._pending: dict[str, tuple[threading.Event, dict[str, Any]]] = {}
        self._handlers: tuple[Callable[[Any, str, dict[str, Any]], None], Callable[[str, dict[str, Any]], None]] | None = None
        # Messages that arrive between `hello` and `run`: the app may send its first
        # requests as soon as it answered, before the plugin hands its handlers over.
        self._queued: list[dict[str, Any]] = []
        self._next = 0
        self._closed = False
        # The reader runs from the start: `hello` is a request whose answer must be read
        # before the plugin can hand its handlers over.
        self._thread = threading.Thread(target=self._read, name="broker-rpc", daemon=True)
        self._thread.start()

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(message, separators=(",", ":"), ensure_ascii=False)
        with self._write_lock:
            if self._closed:
                return
            try:
                self._writer.write(line + "\n")
                self._writer.flush()
            except (BrokenPipeError, ValueError):
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
                raise BrokerError(f"The app did not answer {method} within {timeout:.0f}s")
        finally:
            self._pending.pop(request_id, None)
        if "error" in slot:
            error = slot["error"] or {}
            raise BrokerError(str(error.get("message") or error), int(error.get("code") or -32000))
        return slot.get("result")

    def run(
        self,
        on_request: Callable[[Any, str, dict[str, Any]], None],
        on_notification: Callable[[str, dict[str, Any]], None],
    ) -> None:
        """Serve the stream with `on_request` / `on_notification` until it closes."""
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
                request_id = str(message.get("id"))
                pending = self._pending.get(request_id)
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
        # Wake a reader blocked on the stream before closing it.
        try:
            self._sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        for closable in (self._reader, self._writer):
            try:
                closable.close()
            except (OSError, ValueError):
                pass
        try:
            self._sock.close()
        except OSError:
            pass


class BrokerPlugin:
    """The plugin's method table over one venue's broker."""

    def __init__(self, rpc: Rpc, venue: Venue):
        self._rpc = rpc
        self._venue = venue
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="broker-call")
        self._closed = False
        self._settings: dict[str, str] = {}
        self._broker = CcxtBroker(
            venue,
            log=lambda message: rpc.notify("log", {"level": "info", "message": message}),
            notify=self._notice,
            event=self._event,
        )

    # ── messages ─────────────────────────────────────────────────────────────

    def on_request(self, request_id: Any, method: str, params: dict[str, Any]) -> None:
        def run() -> None:
            try:
                result = self._call(method, params)
            except BrokerError as exc:
                self._rpc.respond(request_id, error={"code": exc.code, "message": str(exc)})
            except Exception as exc:  # noqa: BLE001 - a bug must not take the connection down
                log(f"[error] {method}: {exc!r}")
                self._rpc.respond(request_id, error={"code": -32000, "message": str(exc)})
            else:
                self._rpc.respond(request_id, result=result)

        try:
            self._pool.submit(run)
        except RuntimeError:  # the pool is shut down: the app is going away
            pass

    def on_notification(self, method: str, params: dict[str, Any]) -> None:
        if method == "plugin.configure":
            settings = params.get("settings") or {}
            self._pool.submit(self.configure, {str(k): str(v) for k, v in settings.items()})
            return
        if method == "broker.watchQuote":
            tickers = params.get("tickers") or []
            self._broker.watch_quote([str(ticker) for ticker in tickers])

    def _call(self, method: str, params: dict[str, Any]) -> Any:
        if method == "ping":
            return {}
        if method == "broker.state":
            return self._broker.state()
        if method == "broker.resolveSymbol":
            symbol = str(params.get("symbol") or "")
            return {"ticker": self._broker.resolve_symbol(symbol, str(params.get("ticker") or symbol))}
        if method == "broker.selectAccount":
            return {}
        if method == "broker.place":
            return {"orderId": self._broker.place(dict(params))}
        if method == "broker.modify":
            self._broker.modify(str(params.get("orderId") or ""), dict(params))
            return {}
        if method == "broker.cancel":
            self._broker.cancel(str(params.get("orderId") or ""))
            return {}
        if method == "broker.closePosition":
            self._broker.close_position(
                str(params.get("positionId") or ""),
                float(params["qty"]) if params.get("qty") is not None else None,
            )
            return {}
        if method == "broker.setPositionBrackets":
            self._broker.set_position_brackets(
                str(params.get("positionId") or ""),
                float(params["takeProfit"]) if params.get("takeProfit") is not None else None,
                float(params["stopLoss"]) if params.get("stopLoss") is not None else None,
            )
            return {}
        raise BrokerError(f"{method} is not a method of this plugin", -32601)

    # ── configuration ────────────────────────────────────────────────────────

    def configure(self, settings: dict[str, str]) -> None:
        self._settings = settings
        try:
            self._broker.configure(settings)
        except BrokerError as exc:
            self._notice("error", str(exc))
            return
        self._broker.start()

    # ── output ───────────────────────────────────────────────────────────────

    def _notice(self, level: str, message: str) -> None:
        if not self._closed:
            self._rpc.notify("broker.notice", {"level": level, "message": message})

    def _event(self, payload: dict[str, Any]) -> None:
        if self._closed:
            return
        if "__state__" in payload:
            self._rpc.notify("broker.state", payload["__state__"])
        elif "__quote__" in payload:
            self._rpc.notify("broker.quote", payload["__quote__"])
        else:
            self._rpc.notify("broker.event", payload)

    def close(self) -> None:
        self._closed = True
        self._broker.stop()
        self._pool.shutdown(wait=False, cancel_futures=True)


def connect_from_env() -> tuple[str, str] | None:
    addr = os.environ.get("OPENTRADER_PLUGIN_ADDR")
    token = os.environ.get("OPENTRADER_PLUGIN_TOKEN")
    if addr and token:
        return addr, token
    return None


def read_connection_file(path: Path) -> tuple[str, str] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    host, port, token = data.get("host"), data.get("port"), data.get("token")
    if not host or not port or not token:
        return None
    return f"{host}:{port}", str(token)


def open_socket(addr: str, token: str | None, connection_file: Path | None, venue_id: str) -> tuple[Rpc, dict[str, Any]] | None:
    host, _, port = addr.rpartition(":")
    try:
        sock = socket.create_connection((host or "127.0.0.1", int(port)), timeout=10.0)
    except (OSError, ValueError) as exc:
        log(f"[connect] {addr}: {exc}")
        return None
    sock.settimeout(None)
    rpc = Rpc(sock)
    try:
        hello = rpc.request("hello", {
            "plugin": os.environ.get("OPENTRADER_PLUGIN_ID") or venue_id,
            "token": token or "",
            "api": API,
            "version": VERSION,
        }, HELLO_TIMEOUT)
    except BrokerError as exc:
        log(f"[connect] handshake refused: {exc}")
        rpc.close()
        if connection_file is not None:
            try:
                connection_file.unlink()
            except OSError:
                pass
        return None
    return rpc, hello if isinstance(hello, dict) else {}


def serve(connection: Path | None, venue: Venue) -> int:
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
        opened = open_socket(addr, token, connection, venue.id)
        if opened is None:
            stopping.wait(2.0)
            continue
        rpc, hello = opened
        current[:] = [rpc]
        log(f"[connect] {venue.name}: connected to OpenTrader (api {hello.get('api', '?')})")
        plugin = BrokerPlugin(rpc, venue)
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
    parser = argparse.ArgumentParser(description="TradePanel CCXT broker plugin for OpenTrader")
    parser.add_argument("--venue", default=None, help="the venue this package serves (its plugin id)")
    parser.add_argument("--connection-file", type=Path, default=None,
                        help=f"the app's connection file (default {DEFAULT_CONNECTION_FILE})")
    parser.add_argument("--version", action="store_true", help="print the version and exit")
    args = parser.parse_args(argv)
    if args.version:
        print(VERSION)
        return 0
    try:
        venue = find_venue(args.venue)
    except SpecError as exc:
        print(exc, file=sys.stderr)
        return 2
    return serve(args.connection_file or DEFAULT_CONNECTION_FILE, venue)


if __name__ == "__main__":
    raise SystemExit(main())
