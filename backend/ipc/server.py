"""Line-delimited JSON-RPC 2.0 server over the sidecar's stdio.

Design notes
------------
* stdout carries protocol frames only; diagnostics go to stderr (``sidecar.py``
  redirects fd 1 so stray ``print()`` calls cannot corrupt the stream).
* Requests are executed on a bounded thread pool; a single writer thread
  serialises responses so frames can never interleave.
* Trading methods are executed under one lock: two orders can never be
  submitted concurrently. Queued trading requests are rejected once shutdown
  has started.
* Request ids are remembered for a short window and duplicates are rejected.
  Together with the Rust layer's in-flight guard this makes an accidental
  double submit of the same frame a protocol error instead of a second order.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor
from queue import Full, Queue
from typing import BinaryIO

from backend.Core import credentials, market_data, trading_service

from .credentials import CredentialStore
from .methods import METHODS, Context, MethodSpec
from .protocol import (
    APP_ERROR,
    DUPLICATE_REQUEST,
    INTERNAL_ERROR,
    INVALID_PARAMS,
    MAX_INFLIGHT,
    MAX_MESSAGE_BYTES,
    MAX_TRACKED_IDS,
    METHOD_NOT_FOUND,
    MessageError,
    Notification,
    PAYLOAD_TOO_LARGE,
    Request,
    RpcError,
    SERVER_BUSY,
    SHUTTING_DOWN,
    UNAVAILABLE,
    dumps,
    notification,
    parse_frame,
    response_error,
    response_ok,
)

log = logging.getLogger(__name__)

_EOF = object()


class RpcServer:
    def __init__(
        self,
        reader: BinaryIO,
        writer: BinaryIO,
        *,
        registry: dict[str, MethodSpec] | None = None,
        max_workers: int = 12,
        shutdown_grace_s: float | None = None,
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._registry = registry if registry is not None else METHODS
        self._context = Context(
            credentials=CredentialStore(),
            started_at=time.time(),
            state_lock=threading.RLock(),
        )
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers, thread_name_prefix="rpc"
        )
        self._futures: set[Future] = set()
        self._futures_lock = threading.Lock()
        self._recent_ids: OrderedDict[str, None] = OrderedDict()
        self._ids_lock = threading.Lock()
        self._inflight = threading.BoundedSemaphore(MAX_INFLIGHT)
        self._trade_lock = threading.Lock()
        self._stopping = threading.Event()
        self._stop = threading.Event()
        self._write_queue: Queue[bytes | None] = Queue(maxsize=2048)
        self._writer_thread = threading.Thread(
            target=self._writer_loop, name="rpc-writer", daemon=True
        )
        self._grace = (
            shutdown_grace_s
            if shutdown_grace_s is not None
            else float(os.environ.get("TRADEPANEL_SHUTDOWN_GRACE_S", "10"))
        )
        self._exit_code = 0

    # ── Lifecycle ────────────────────────────────────────────────────────────

    def serve_forever(self) -> int:
        self._writer_thread.start()
        log.info(
            "Sidecar ready (protocol methods=%d, pid=%d)",
            len(self._registry), os.getpid(),
        )
        try:
            while not self._stop.is_set():
                frame = self._read_frame()
                if frame is _EOF:
                    log.info("stdin closed; shutting down")
                    break
                if frame is None:
                    continue
                if isinstance(frame, MessageError):
                    self._send(
                        response_error(frame.request_id, frame),
                        priority=True,
                    )
                    continue
                if isinstance(frame, Notification):
                    self._submit_notification(frame)
                    continue
                self._submit_request(frame)
                if frame.method == "system.shutdown":
                    self._begin_shutdown("client requested shutdown")
                    break
        except KeyboardInterrupt:  # pragma: no cover - signal path
            log.info("Interrupt received; shutting down")
            self._begin_shutdown("signal")
        except Exception:
            log.exception("Fatal sidecar read loop error")
            self._exit_code = 1
            self._begin_shutdown("fatal error")
        finally:
            self._finalise()
        return self._exit_code

    def request_restart_hint(self) -> None:
        """Used by tests/tools: stop accepting work and drain."""
        self._begin_shutdown("restart requested")

    def _begin_shutdown(self, reason: str) -> None:
        if self._stopping.is_set():
            return
        log.info("Shutdown started: %s", reason)
        self._stopping.set()

        deadline = time.time() + max(0.0, self._grace)
        while time.time() < deadline:
            with self._futures_lock:
                running = [f for f in self._futures if not f.done()]
            if not running:
                break
            time.sleep(0.02)
        else:
            with self._futures_lock:
                running = [f for f in self._futures if not f.done()]
            if running:
                log.warning(
                    "%d request(s) still running after %.1fs grace; exiting",
                    len(running), self._grace,
                )
        self._stop.set()

    def _finalise(self) -> None:
        self._stopping.set()
        self._executor.shutdown(wait=False, cancel_futures=True)
        self._send(None)                       # writer sentinel
        self._writer_thread.join(timeout=5)
        try:
            if hasattr(self._writer, "flush"):
                self._writer.flush()
        except Exception:
            pass

    def close(self) -> None:
        self._begin_shutdown("close")
        self._finalise()

    # ── I/O ──────────────────────────────────────────────────────────────────

    def _read_frame(self):
        try:
            raw = self._reader.readline(MAX_MESSAGE_BYTES + 1)
        except (ValueError, OSError) as exc:
            log.error("stdin read failed: %s", exc)
            return _EOF
        if not raw:
            return _EOF
        if isinstance(raw, str):
            raw = raw.encode("utf-8", "replace")
        if len(raw) > MAX_MESSAGE_BYTES or not raw.endswith(b"\n"):
            # Drain the rest of an oversized line without buffering it.
            while raw and not raw.endswith(b"\n"):
                raw = self._reader.readline(MAX_MESSAGE_BYTES + 1)
            return MessageError(
                PAYLOAD_TOO_LARGE,
                f"Message exceeds {MAX_MESSAGE_BYTES} bytes",
            )
        return parse_frame(raw.rstrip(b"\r\n"))

    def _writer_loop(self) -> None:
        while True:
            item = self._write_queue.get()
            if item is None:
                break
            try:
                view = memoryview(item)
                while view:
                    written = self._writer.write(view)
                    if written is None:
                        break
                    view = view[written:]
                self._writer.flush()
            except Exception as exc:  # stdout gone: nothing can be delivered
                log.error("stdout write failed: %s", exc)
                self._exit_code = 1
                self._stop.set()
                break
        try:
            self._writer.flush()
        except Exception:
            pass

    def _send(self, payload: dict | None, *, priority: bool = False) -> None:
        if payload is None:
            try:
                self._write_queue.put(None, timeout=5)
            except Full:
                log.error("Writer queue full while closing")
            return
        try:
            frame = dumps(payload) + b"\n"
        except (TypeError, ValueError) as exc:
            log.error("Response is not JSON serialisable: %s", exc)
            frame = dumps(
                response_error(
                    str(payload.get("id")) if payload.get("id") else None,
                    RpcError(INTERNAL_ERROR, "Response serialisation failed"),
                )
            ) + b"\n"
        try:
            if priority:
                self._write_queue.put(frame, timeout=5)
            else:
                self._write_queue.put(frame, timeout=5)
        except Full:
            log.error("Writer queue full; dropping a response")

    # ── Dispatch ─────────────────────────────────────────────────────────────

    def _track_id(self, request_id: str) -> bool:
        with self._ids_lock:
            if request_id in self._recent_ids:
                return False
            self._recent_ids[request_id] = None
            while len(self._recent_ids) > MAX_TRACKED_IDS:
                self._recent_ids.popitem(last=False)
            return True

    def _submit_request(self, request: Request) -> None:
        if not self._track_id(request.id):
            self._send(
                response_error(
                    request.id,
                    RpcError(DUPLICATE_REQUEST, "Duplicate request id"),
                )
            )
            return
        if not self._inflight.acquire(blocking=False):
            self._send(
                response_error(
                    request.id,
                    RpcError(SERVER_BUSY, "Too many concurrent requests"),
                )
            )
            return
        spec = self._registry.get(request.method)
        try:
            future = self._executor.submit(self._handle_request, request, spec)
        except RuntimeError:
            self._inflight.release()
            self._send(
                response_error(request.id, RpcError(SHUTTING_DOWN, "Server is stopping"))
            )
            return
        with self._futures_lock:
            self._futures.add(future)
        future.add_done_callback(self._on_future_done)

    def _on_future_done(self, future: Future) -> None:
        self._inflight.release()
        with self._futures_lock:
            self._futures.discard(future)

    def _submit_notification(self, note: Notification) -> None:
        if not self._inflight.acquire(blocking=False):
            log.warning("Dropping notification %s: server busy", note.method)
            return
        try:
            future = self._executor.submit(self._handle_notification, note)
        except RuntimeError:
            self._inflight.release()
            return
        with self._futures_lock:
            self._futures.add(future)
        future.add_done_callback(self._on_future_done)

    def _handle_notification(self, note: Notification) -> None:
        spec = self._registry.get(note.method)
        if spec is None:
            log.warning("Unknown notification method: %s", note.method)
            return
        try:
            spec.handler(note.params, self._context)
        except Exception:
            log.exception("Notification handler failed: %s", note.method)

    def _handle_request(self, request: Request, spec: MethodSpec | None) -> None:
        if spec is None:
            self._send(
                response_error(
                    request.id,
                    RpcError(METHOD_NOT_FOUND, f"Unknown method: {request.method}"),
                )
            )
            return
        if self._stopping.is_set() and not spec.allow_during_shutdown:
            self._send(
                response_error(
                    request.id,
                    RpcError(SHUTTING_DOWN, "Backend is shutting down"),
                )
            )
            return

        try:
            if spec.serialized:
                with self._trade_lock:
                    if self._stopping.is_set():
                        raise RpcError(SHUTTING_DOWN, "Backend is shutting down")
                    result = spec.handler(request.params, self._context)
            else:
                result = spec.handler(request.params, self._context)
        except RpcError as exc:
            self._send(response_error(request.id, exc))
            return
        except credentials.CredentialError as exc:
            self._send(response_error(request.id, RpcError(INVALID_PARAMS, str(exc))))
            return
        except trading_service.TradingUnavailable as exc:
            self._send(response_error(request.id, RpcError(UNAVAILABLE, str(exc))))
            return
        except trading_service.TradingInputError as exc:
            self._send(response_error(request.id, RpcError(INVALID_PARAMS, str(exc))))
            return
        except market_data.MarketDataError as exc:
            self._send(response_error(request.id, RpcError(APP_ERROR, str(exc))))
            return
        except ValueError as exc:
            self._send(response_error(request.id, RpcError(INVALID_PARAMS, str(exc))))
            return
        except Exception:
            log.exception("Method failed: %s", request.method)
            self._send(
                response_error(
                    request.id,
                    RpcError(INTERNAL_ERROR, "Internal backend error"),
                )
            )
            return

        try:
            self._send(response_ok(request.id, result))
        except Exception:
            log.exception("Failed to send response for %s", request.method)

    # ── Outbound notifications ───────────────────────────────────────────────

    def notify(self, method: str, params: dict) -> None:
        self._send(notification(method, params))

