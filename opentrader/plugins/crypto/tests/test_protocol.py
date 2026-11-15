"""Transport and method-dispatch tests for the plugin's JSON-RPC layer."""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crypto_source import PluginError  # noqa: E402
from plugin import CryptoPlugin, Rpc  # noqa: E402


class ManifestTests(unittest.TestCase):
    def test_manifest_matches_the_code(self):
        import json
        from pathlib import Path

        manifest = json.loads((Path(__file__).resolve().parents[1] / "opentrader-plugin.json").read_text(encoding="utf-8"))
        import plugin

        self.assertEqual(manifest["version"], plugin.VERSION)
        self.assertEqual(manifest["api"], plugin.API)
        self.assertEqual(manifest["runtime"]["entry"], "plugin.py")
        self.assertIn("datafeed", manifest["provides"])
        self.assertIn("broker", manifest["provides"])
        self.assertIn("HYPERLIQUID", manifest["exchanges"])
        self.assertEqual(len(manifest["exchanges"]), 9)
        secret = [f for f in manifest["settings"] if f["key"] == "privateKey"][0]
        self.assertEqual(secret["type"], "secret")
        self.assertEqual([f for f in manifest["settings"] if f["key"] == "network"][0]["default"], "testnet")


class FakeRpc:
    def __init__(self):
        self.responses: list[tuple] = []
        self.notifications: list[tuple] = []

    def respond(self, request_id, result=None, error=None):
        self.responses.append((request_id, result, error))

    def notify(self, method, params=None):
        self.notifications.append((method, params))


class StubSource:
    def __init__(self):
        self.subscribed = None
        self.configured = None

    def search(self, query):
        return [{"ticker": f"BINANCE:{query.upper()}", "description": "x", "type": "crypto"}]

    def symbol_info(self, ticker):
        return {"timezone": "Etc/UTC"}

    def bars(self, ticker, resolution, frm, to, count):
        return [[frm, 1, 2, 0.5, 1.5, 10]][-count:]

    def configure(self, settings):
        self.configured = settings

    def subscribe(self, tickers):
        self.subscribed = tickers

    def start(self, emit):
        self.emit = emit

    def stop(self):
        pass


class StubBroker:
    def __init__(self):
        self.placed = None
        self.modified = None
        self.cancelled = None
        self.closed = None
        self.brackets = None
        self.watch = None
        self.started = False

    def configure(self, settings):
        self.settings = settings

    def start(self):
        self.started = True

    def stop(self):
        pass

    def state(self):
        return {"connected": False}

    def resolve_symbol(self, symbol, ticker):
        return "HYPERLIQUID:BTC/USDC.P"

    def place(self, ticket):
        self.placed = ticket
        return "42"

    def modify(self, order_id, ticket):
        self.modified = (order_id, ticket)

    def cancel(self, order_id):
        self.cancelled = order_id

    def close_position(self, position_id, qty):
        self.closed = (position_id, qty)

    def set_position_brackets(self, position_id, tp, sl):
        self.brackets = (position_id, tp, sl)

    def watch_quote(self, tickers):
        self.watch = tickers

    def ticker_of_coin(self, coin):
        return f"HYPERLIQUID:{coin}"


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FakeRpc()
        self.source = StubSource()
        self.broker = StubBroker()
        self.plugin = CryptoPlugin(self.rpc, self.source, self.broker)

    def call(self, method, params=None):
        try:
            return self.plugin._call(method, params or {})
        finally:
            self.plugin.close()

    def test_data_methods(self):
        self.assertEqual(self.call("data.search", {"query": "btc"})["symbols"][0]["ticker"], "BINANCE:BTC")
        self.assertEqual(self.call("data.symbolInfo", {"ticker": "BINANCE:BTC/USDT"})["timezone"], "Etc/UTC")

    def test_bars_use_from_and_to(self):
        result = self.call("data.bars", {"ticker": "B", "resolution": "1", "from": 60, "to": 120, "countBack": 1})
        self.assertEqual(result["bars"][-1][0], 60.0)

    def test_broker_place_returns_the_order_id(self):
        self.assertEqual(self.call("broker.place", {"ticker": "HYPERLIQUID:BTC", "qty": 1}), {"orderId": "42"})
        self.assertEqual(self.broker.placed["ticker"], "HYPERLIQUID:BTC")

    def test_broker_partial_close_passes_none_for_the_whole_position(self):
        self.call("broker.closePosition", {"positionId": "pos:BTC"})
        self.assertEqual(self.broker.closed, ("pos:BTC", None))
        self.plugin = CryptoPlugin(self.rpc, self.source, self.broker)
        self.call("broker.closePosition", {"positionId": "pos:BTC", "qty": 0.5})
        self.assertEqual(self.broker.closed, ("pos:BTC", 0.5))

    def test_unknown_method_is_not_found(self):
        with self.assertRaises(PluginError) as caught:
            self.call("broker.nope")
        self.assertEqual(caught.exception.code, -32601)

    def test_success_and_error_answers(self):
        self.plugin = CryptoPlugin(self.rpc, self.source, self.broker)
        self.plugin.on_request("r1", "ping", {})
        self.plugin._pool.shutdown(wait=True)
        self.assertEqual(self.rpc.responses[0], ("r1", {}, None))

        self.plugin = CryptoPlugin(self.rpc, self.source, self.broker)
        self.plugin._call = lambda _method, _params: (_ for _ in ()).throw(PluginError("no keys", -32001))
        self.plugin.on_request("r2", "broker.place", {})
        self.plugin._pool.shutdown(wait=True)
        self.assertEqual(self.rpc.responses[-1][2], {"code": -32001, "message": "no keys"})

    def test_configure_is_applied_to_both_sides(self):
        self.plugin.on_notification("plugin.configure", {"settings": {"network": "testnet", "pollSeconds": "5"}})
        self.plugin._pool.shutdown(wait=True)
        self.assertEqual(self.source.configured["pollSeconds"], "5")
        self.assertEqual(self.broker.settings["network"], "testnet")
        self.assertTrue(self.broker.started)

    def test_subscribe_and_watch_quote_replace_their_sets(self):
        self.plugin.on_notification("data.subscribe", {"tickers": ["BINANCE:BTC/USDT"]})
        self.plugin.on_notification("broker.watchQuote", {"tickers": ["HYPERLIQUID:BTC"]})
        self.assertEqual(self.source.subscribed, ["BINANCE:BTC/USDT"])
        self.assertEqual(self.broker.watch, ["HYPERLIQUID:BTC"])

    def test_broker_payloads_are_routed(self):
        self.plugin._broker_event({"__state__": {"connected": True}})
        self.plugin._broker_event({"__quote__": {"ticker": "X"}})
        self.plugin._broker_event({"kind": "placed", "ticker": "X"})
        self.assertEqual([m for m, _ in self.rpc.notifications], ["broker.state", "broker.quote", "broker.event"])


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.plugin_sock, self.app_sock = socket.socketpair()
        self.rpc = Rpc(self.plugin_sock)
        self.app = self.app_sock.makefile("r", encoding="utf-8", newline="\n")

    def tearDown(self):
        self.rpc.close()
        try:
            self.app.close()
        except OSError:
            pass
        self.app_sock.close()

    def read(self):
        line = self.app.readline()
        self.assertTrue(line, "the plugin closed the stream")
        return json.loads(line)

    def test_request_waits_for_its_answer_and_a_notification_does_not(self):
        def app():
            hello = self.read()
            self.assertEqual(hello["method"], "hello")
            self.app_sock.sendall((json.dumps({"jsonrpc": "2.0", "id": hello["id"], "result": {"api": 2}}) + "\n").encode())
            note = self.read()
            self.assertEqual(note["method"], "data.quote")

        thread = threading.Thread(target=app, daemon=True)
        thread.start()
        reader = threading.Thread(target=self.rpc.run, args=(lambda *_: None, lambda *_: None), daemon=True)
        reader.start()
        result = self.rpc.request("hello", {"api": 2}, timeout=2)
        self.assertEqual(result, {"api": 2})
        self.rpc.notify("data.quote", {"ticker": "X"})
        thread.join(timeout=2)

    def test_a_request_from_the_app_gets_a_response(self):
        seen = []

        def on_request(request_id, method, params):
            seen.append((request_id, method, params))
            self.rpc.respond(request_id, result={"ok": True})

        def on_notification(method, params):
            seen.append((method, params))

        thread = threading.Thread(target=self.rpc.run, args=(on_request, on_notification), daemon=True)
        thread.start()
        self.app_sock.sendall((json.dumps({"jsonrpc": "2.0", "id": 7, "method": "data.search", "params": {"query": "x"}}) + "\n").encode())
        answer = self.read()
        self.assertEqual(answer["id"], 7)
        self.assertEqual(answer["result"], {"ok": True})
        self.app_sock.sendall((json.dumps({"jsonrpc": "2.0", "method": "data.subscribe", "params": {"tickers": []}}) + "\n").encode())
        time.sleep(0.1)
        self.assertEqual(seen[0][1], "data.search")

    def test_bad_json_is_skipped(self):
        def on_request(request_id, method, params):
            self.fail("no request should be dispatched")

        thread = threading.Thread(target=self.rpc.run, args=(on_request, lambda m, p: None), daemon=True)
        thread.start()
        self.app_sock.sendall(b"not json\n")
        self.app_sock.sendall((json.dumps({"jsonrpc": "2.0", "method": "ping"}) + "\n").encode())
        time.sleep(0.1)
        self.assertTrue(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
