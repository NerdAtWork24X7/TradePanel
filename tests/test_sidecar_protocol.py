"""Sidecar JSON-RPC protocol tests (Phase 2 gate).

Unit tests cover framing/validation; the end-to-end test spawns the real
sidecar process with a temporary data directory and exercises the handshake,
correlation, error mapping, persistence round-trips and graceful shutdown.

No exchange order is submitted: trading is exercised only through its
"credentials missing" guard.
"""

from __future__ import annotations

import json
import os
import pathlib
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from backend.ipc import methods as rpc_methods  # noqa: E402
from backend.ipc.protocol import (  # noqa: E402
    MAX_MESSAGE_BYTES,
    MessageError,
    Notification,
    Request,
    parse_frame,
)
from backend.ipc.server import RpcServer  # noqa: E402


class FramingTests(unittest.TestCase):
    def test_request_and_notification(self):
        req = parse_frame(b'{"jsonrpc":"2.0","id":"a","method":"m","params":{"x":1}}')
        self.assertIsInstance(req, Request)
        self.assertEqual((req.id, req.method, req.params["x"]), ("a", "m", 1))

        note = parse_frame(b'{"jsonrpc":"2.0","method":"event.ping"}')
        self.assertIsInstance(note, Notification)
        self.assertEqual(note.params, {})

    def test_malformed_frames(self):
        cases = [
            b"not json",
            b"[]",
            b'{"id":"a","method":"m"}',
            b'{"jsonrpc":"2.0","method":""}',
            b'{"jsonrpc":"2.0","id":1.5,"method":"m"}',
            b'{"jsonrpc":"2.0","id":true,"method":"m"}',
            b'{"jsonrpc":"2.0","id":"a","method":"m","params":[]}',
            b"\xff\xfe",
        ]
        for raw in cases:
            parsed = parse_frame(raw)
            self.assertIsInstance(parsed, MessageError, raw)

    def test_numeric_ids_are_normalised(self):
        parsed = parse_frame(b'{"jsonrpc":"2.0","id":7,"method":"m"}')
        self.assertIsInstance(parsed, Request)
        self.assertEqual(parsed.id, "7")

    def test_oversized_frame_rejected_without_parsing(self):
        parsed = parse_frame(b"x" * (MAX_MESSAGE_BYTES + 1))
        self.assertIsInstance(parsed, MessageError)
        self.assertEqual(parsed.code, -32013)


class InProcessServerTests(unittest.TestCase):
    """Exercise shutdown/drain and trading serialisation without a subprocess."""

    def _start(self, registry, grace=3.0, workers=4):
        read_fd, write_fd = os.pipe()
        out_read, out_write = os.pipe()
        def safe_close(fd):
            try:
                os.close(fd)
            except OSError:
                pass

        self.addCleanup(lambda: safe_close(write_fd))
        self.addCleanup(lambda: safe_close(out_read))

        reader = os.fdopen(read_fd, "rb", buffering=0)
        writer = os.fdopen(out_write, "wb", buffering=0)
        server = RpcServer(
            reader, writer, registry=registry, max_workers=workers,
            shutdown_grace_s=grace,
        )
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        lines: queue.Queue[str] = queue.Queue()

        def pump():
            with os.fdopen(os.dup(out_read), "rb") as stream:
                for raw in stream:
                    lines.put(raw.decode("utf-8"))

        threading.Thread(target=pump, daemon=True).start()

        def send(payload):
            os.write(write_fd, (json.dumps(payload) + "\n").encode("utf-8"))

        return server, thread, lines, send, write_fd

    def test_shutdown_drains_in_flight_work(self):
        def slow_job(params, ctx):
            time.sleep(0.5)
            return {"done": True}

        registry = {
            "system.shutdown": rpc_methods.METHODS["system.shutdown"],
            "slow.job": rpc_methods.MethodSpec(slow_job, serialized=True),
        }
        server, thread, lines, send, write_fd = self._start(registry, grace=3.0)
        send({"jsonrpc": "2.0", "id": "slow", "method": "slow.job", "params": {}})
        time.sleep(0.05)
        started = time.time()
        send({"jsonrpc": "2.0", "id": "stop", "method": "system.shutdown", "params": {}})
        thread.join(timeout=5)
        elapsed = time.time() - started
        self.assertFalse(thread.is_alive(), "server must exit after shutdown")

        replies = {}
        deadline = time.time() + 3
        while len(replies) < 2 and time.time() < deadline:
            try:
                message = json.loads(lines.get(timeout=0.5))
            except queue.Empty:
                break
            replies[message.get("id")] = message
        self.assertIn("slow", replies, "in-flight work must finish and respond")
        self.assertIn("stop", replies)
        self.assertTrue(replies["slow"]["result"]["done"])
        self.assertGreaterEqual(elapsed, 0.45)

    def test_serialized_methods_do_not_overlap(self):
        active = {"now": 0, "max": 0}
        lock = threading.Lock()

        def job(params, ctx):
            with lock:
                active["now"] += 1
                active["max"] = max(active["max"], active["now"])
            time.sleep(0.25)
            with lock:
                active["now"] -= 1
            return {"ok": True}

        registry = {"slow.job": rpc_methods.MethodSpec(job, serialized=True)}
        server, thread, lines, send, write_fd = self._start(registry, workers=4)
        send({"jsonrpc": "2.0", "id": "a", "method": "slow.job", "params": {}})
        send({"jsonrpc": "2.0", "id": "b", "method": "slow.job", "params": {}})
        received = {}
        deadline = time.time() + 3
        while len(received) < 2 and time.time() < deadline:
            try:
                message = json.loads(lines.get(timeout=0.5))
            except queue.Empty:
                break
            received[message.get("id")] = message
        self.assertEqual(set(received), {"a", "b"})
        self.assertEqual(active["max"], 1, "serialized handlers must not overlap")
        server.request_restart_hint()
        thread.join(timeout=3)


class HardExitTests(unittest.TestCase):
    """Regression: a library thread must never keep the sidecar process alive."""

    def test_exit_now_ignores_non_daemon_threads(self):
        script = (
            "import sys, threading\n"
            f"sys.path.insert(0, {str(ROOT)!r})\n"
            "from backend.sidecar import _exit_now\n"
            "threading.Thread(target=threading.Event().wait, daemon=False).start()\n"
            "_exit_now(7)\n"
        )
        started = time.time()
        proc = subprocess.run(
            [sys.executable, "-c", script],
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(proc.returncode, 7)
        self.assertLess(time.time() - started, 5)


class _Sidecar:
    def __init__(self, data_dir: str) -> None:
        env = dict(os.environ)
        env.update(
            {
                "TRADEPANEL_DATA_DIR": data_dir,
                "TRADEPANEL_KEYS_DIR": str(pathlib.Path(data_dir) / "keys"),
                "TRADEPANEL_IGNORE_ENV_FILE": "1",
                "TRADEPANEL_LOG_LEVEL": "INFO",
                "PYTHONUNBUFFERED": "1",
            }
        )
        env.pop("HL_PRIVATE_KEY", None)
        env.pop("HL_ADDRESS", None)
        self.proc = subprocess.Popen(
            [sys.executable, str(ROOT / "backend" / "sidecar.py"), "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=str(ROOT),
        )
        self._lines: queue.Queue[str] = queue.Queue()
        self._stderr: list[str] = []
        self._raw_stdout: list[bytes] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()
        self._seq = 0

    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in self.proc.stdout:
            self._raw_stdout.append(raw)
            self._lines.put(raw.decode("utf-8"))

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in self.proc.stderr:
            self._stderr.append(raw.decode("utf-8", "replace"))

    def send(self, payload: dict) -> None:
        assert self.proc.stdin is not None
        data = json.dumps(payload).encode("utf-8") + b"\n"
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def next_message(self, timeout: float = 10) -> dict:
        line = self._lines.get(timeout=timeout)
        return json.loads(line)

    def rpc(self, method: str, params: dict | None = None, timeout: float = 15):
        self._seq += 1
        request_id = f"t-{self._seq}"
        self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": method,
                "params": params or {},
            }
        )
        deadline = time.time() + timeout
        while time.time() < deadline:
            message = self.next_message(timeout=max(0.1, deadline - time.time()))
            if message.get("id") == request_id:
                return message
        raise AssertionError(f"timeout waiting for {method}")

    def close(self, timeout: float = 15) -> int:
        if self.proc.poll() is None:
            try:
                self.send({"jsonrpc": "2.0", "id": "shutdown", "method": "system.shutdown"})
                self.proc.stdin.close()  # type: ignore[union-attr]
            except Exception:
                pass
        try:
            code = self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            raise
        self._close_streams()
        return code

    def _close_streams(self) -> None:
        for stream in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                stream.close()  # type: ignore[union-attr]
            except Exception:
                pass


class SidecarEndToEndTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = pathlib.Path(self._tmp.name)
        (self.data_dir / "data").mkdir()
        self.sidecar = _Sidecar(str(self.data_dir / "data"))

    def tearDown(self):
        try:
            if self.sidecar.proc.poll() is None:
                self.sidecar.proc.kill()
            self.sidecar.proc.wait(timeout=5)
        except Exception:
            pass
        finally:
            self.sidecar._close_streams()
            self._tmp.cleanup()

    # ── Handshake / errors ────────────────────────────────────────────────

    def test_handshake_and_ping(self):
        hello = self.sidecar.rpc("system.hello", {"protocol_version": 1})
        result = hello["result"]
        self.assertEqual(result["protocol_version"], 1)
        self.assertGreaterEqual(len(result["methods"]), 20)
        self.assertIn("market.get_candles", result["methods"])
        ping = self.sidecar.rpc("system.ping")
        self.assertTrue(ping["result"]["pong"])

    def test_protocol_mismatch_is_fatal_for_the_client(self):
        reply = self.sidecar.rpc("system.hello", {"protocol_version": 999})
        self.assertEqual(reply["error"]["code"], -32010)
        self.assertEqual(reply["error"]["data"]["expected"], 1)

    def test_unknown_method_and_bad_params(self):
        self.assertEqual(
            self.sidecar.rpc("market.nope")["error"]["code"], -32601
        )
        self.assertEqual(
            self.sidecar.rpc("market.get_candles", {"exchange": "binance"})["error"]["code"],
            -32602,
        )
        self.assertEqual(
            self.sidecar.rpc("market.get_candles", {
                "exchange": "binance", "market": "spot", "symbol": "BTC/USDT",
                "timeframe": "5m", "limit": "many",
            })["error"]["code"],
            -32602,
        )

    def test_malformed_json_gets_a_parse_error(self):
        self.sidecar.send_raw(b"{oops\n")
        reply = self.sidecar.next_message()
        self.assertEqual(reply["error"]["code"], -32700)
        self.assertIsNone(reply["id"])
        # The stream is still usable.
        self.assertTrue(self.sidecar.rpc("system.ping")["result"]["pong"])

    def test_duplicate_request_id_is_rejected(self):
        request = {"jsonrpc": "2.0", "id": "dup-1", "method": "system.ping"}
        self.sidecar.send(request)
        self.sidecar.send(request)
        replies = [self.sidecar.next_message(), self.sidecar.next_message()]
        codes = sorted(
            r.get("error", {}).get("code", 0) for r in replies
        )
        self.assertIn(-32012, codes)
        self.assertIn(0, codes)

    def test_concurrent_requests_are_correlated(self):
        ids = []
        for index in range(12):
            request_id = f"c-{index}"
            ids.append(request_id)
            self.sidecar.send(
                {"jsonrpc": "2.0", "id": request_id, "method": "system.ping"}
            )
        seen = {}
        deadline = time.time() + 15
        while len(seen) < len(ids) and time.time() < deadline:
            message = self.sidecar.next_message(timeout=10)
            if "id" in message:
                seen[message["id"]] = message
        self.assertEqual(set(seen), set(ids))
        self.assertTrue(all("result" in m for m in seen.values()))

    # ── Persistence round-trips (existing user-data formats) ─────────────

    def test_workspace_roundtrip_uses_the_override_dir(self):
        loaded = self.sidecar.rpc("workspace.load")["result"]
        self.assertTrue(loaded["ok"])
        store = {
            "version": 1,
            "active": "ws-test",
            "workspaces": [
                {
                    "id": "ws-test",
                    "name": "Test",
                    "layout": "1",
                    "charts": [
                        {
                            "id": "c1",
                            "exchange": "binance",
                            "market": "spot",
                            "symbol": "BTC/USDT",
                            "timeframe": "5m",
                        }
                    ],
                }
            ],
        }
        saved = self.sidecar.rpc("workspace.save", {"store": store})["result"]
        self.assertTrue(saved["ok"])
        path = self.data_dir / "data" / "workspaces.json"
        self.assertTrue(path.exists(), "workspaces.json must live in the override dir")
        again = self.sidecar.rpc("workspace.load")["result"]
        self.assertEqual(again["workspaces"][0]["id"], "ws-test")

    def test_window_state_and_alerts_roundtrip(self):
        state = {
            "coin": "ETH",
            "timeframe": "15m",
            "favorites": ["BTC", "ETH"],
            "risk": "25",
            "is_short": True,
            "hyperliquid": True,
            "limit": "2500",
            "tp": "2400",
            "sl": "2550",
            "sidebar_collapsed": True,
            "unknown_field": "dropped",
        }
        self.assertTrue(
            self.sidecar.rpc("settings.window_state.save", {"state": state})["result"]["ok"]
        )
        loaded = self.sidecar.rpc("settings.window_state.get")["result"]["state"]
        self.assertEqual(loaded["coin"], "ETH")
        self.assertEqual(loaded["favorites"], ["BTC", "ETH"])
        self.assertIs(loaded["sidebar_collapsed"], True)
        self.assertNotIn("unknown_field", loaded)

        self.assertTrue(
            self.sidecar.rpc("alerts.set", {"coin": "ETH", "high": 2600, "low": 2400})["result"]["ok"]
        )
        alert = self.sidecar.rpc("alerts.get", {"coin": "ETH"})["result"]
        self.assertEqual((alert["high"], alert["low"]), (2600.0, 2400.0))
        self.assertIsNone(self.sidecar.rpc("alerts.get", {"coin": "BTC"})["result"]["high"])

    def test_indicator_config_roundtrip(self):
        config = self.sidecar.rpc("indicator.get_config")["result"]["config"]
        self.assertIn("fvg", config)
        config["fvg"]["gap_pct"] = 1.25
        saved = self.sidecar.rpc("indicator.save_config", {"config": config})["result"]
        self.assertEqual(saved["config"]["fvg"]["gap_pct"], 1.25)
        self.assertTrue(
            (self.data_dir / "data" / "indicator_config.json").exists()
        )

    # ── Credentials / trading safety ──────────────────────────────────────

    def test_secrets_are_never_echoed_or_logged(self):
        secret = "0x" + "ab" * 32
        reply = self.sidecar.rpc(
            "system.set_credentials",
            {"values": {"HL_PRIVATE_KEY": secret, "HL_ADDRESS": "0x" + "cd" * 20}},
        )
        self.assertTrue(reply["result"]["set"]["HL_PRIVATE_KEY"])
        self.assertNotIn(secret, json.dumps(reply))
        self.assertNotIn("cd" * 20, json.dumps(reply))
        time.sleep(0.2)
        self.assertNotIn(secret, "".join(self.sidecar._stderr))

    def test_invalid_credentials_are_rejected(self):
        reply = self.sidecar.rpc(
            "system.set_credentials", {"values": {"HL_PRIVATE_KEY": "short"}}
        )
        self.assertEqual(reply["error"]["code"], -32602)

    def test_trading_without_credentials_is_unavailable(self):
        reply = self.sidecar.rpc(
            "trading.place_order",
            {
                "coin": "BTC", "is_buy": True, "qty": 0.001,
                "limit_price": 100, "tp_price": 101, "sl_price": 99,
            },
        )
        self.assertEqual(reply["error"]["code"], -32001)
        # Nothing was persisted by the rejected call.
        self.assertFalse((self.data_dir / "data" / "orders.json").exists())

    def test_shutdown_is_graceful_and_stdout_stays_pure(self):
        code = self.sidecar.close()
        self.assertEqual(code, 0)
        for raw in self.sidecar._raw_stdout:
            text = raw.decode("utf-8")
            self.assertTrue(text.endswith("\n"))
            json.loads(text)  # every stdout line must be a protocol frame


if __name__ == "__main__":
    unittest.main()
