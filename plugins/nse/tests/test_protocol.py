"""Manifest, dispatch and transport tests for the NSE plugin's JSON-RPC layer."""

from __future__ import annotations

import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import plugin  # noqa: E402
from nse_source import NseSource, PluginError  # noqa: E402


class ManifestTests(unittest.TestCase):
    def test_manifest_matches_the_code(self):
        root = Path(__file__).resolve().parents[1]
        manifest = json.loads((root / "opentrader-plugin.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["id"], plugin.PLUGIN_ID)
        self.assertEqual(manifest["version"], plugin.VERSION)
        self.assertEqual(manifest["api"], plugin.API)
        self.assertEqual(manifest["runtime"]["entry"], "plugin.py")
        self.assertEqual(manifest["exchange"], "NSE")
        self.assertEqual(manifest["provides"], ["datafeed"])
        self.assertEqual(manifest["settings"][0]["key"], "pollSeconds")


class StubSource:
    def __init__(self):
        self.subscribed = None
        self.settings = None
        self.emitted = None

    def search(self, query):
        return [{"ticker": query.upper(), "description": "Reliance Industries", "type": "stock"}]

    def symbol_info(self, ticker):
        return {"description": ticker, "type": "stock"}

    def bars(self, ticker, resolution, frm, to, count):
        return [[frm, 1, 2, 0.5, 1.5, count]]

    def refresh_symbols(self):
        return {"symbols": 1}

    def configure(self, settings):
        self.settings = settings

    def subscribe(self, tickers):
        self.subscribed = tickers

    def warm(self):
        pass

    def start(self, emit):
        self.emitted = emit

    def stop(self):
        pass


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.plugin_sock, self.app_sock = socket.socketpair()
        self.rpc = plugin.Rpc(self.plugin_sock)
        self.source = StubSource()
        self.plugin = plugin.NsePlugin(self.rpc, self.source)

    def tearDown(self):
        self.plugin.close()
        self.rpc.close()
        self.app_sock.close()

    def test_only_datafeed_methods_are_served(self):
        self.assertEqual(self.plugin._call("ping", {}), {})
        self.assertEqual(self.plugin._call("data.search", {"query": "reliance"})["symbols"][0]["ticker"], "RELIANCE")
        self.assertEqual(self.plugin._call("data.symbolInfo", {"ticker": "RELIANCE"})["type"], "stock")
        self.assertEqual(self.plugin._call("data.refreshSymbols", {}), {"symbols": 1})
        self.assertEqual(self.plugin._call("data.bars", {"ticker": "RELIANCE", "countBack": 7})["bars"][0][5], 7)
        with self.assertRaises(PluginError):
            self.plugin._call("broker.place", {})

    def test_notifications_configure_and_replace_the_subscription(self):
        self.plugin.on_notification("plugin.configure", {"settings": {"pollSeconds": "15"}})
        self.plugin.on_notification("data.subscribe", {"tickers": ["RELIANCE", "TCS"]})
        self.assertEqual(self.source.settings, {"pollSeconds": "15"})
        self.assertEqual(self.source.subscribed, ["RELIANCE", "TCS"])
        self.plugin.on_notification("plugin.configure", {"settings": ["bad"]})
        self.assertEqual(self.source.settings, {})

    def test_a_bad_subscription_does_not_break_the_notification_reader(self):
        plugin.NsePlugin(self.rpc, NseSource()).on_notification("data.subscribe", {"tickers": ["../bad"]})

    def test_quotes_are_pushed_as_notifications(self):
        self.plugin.start()
        self.source.emitted({"ticker": "RELIANCE", "price": 1.0})
        self.app_sock.settimeout(2)
        line = self.app_sock.makefile("r", encoding="utf-8").readline()
        message = json.loads(line)
        self.assertEqual(message["method"], "data.quote")
        self.assertEqual(message["params"]["ticker"], "RELIANCE")


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.plugin_sock, self.app_sock = socket.socketpair()
        self.rpc = plugin.Rpc(self.plugin_sock)
        self.app = self.app_sock.makefile("r", encoding="utf-8", newline="\n")

    def tearDown(self):
        self.rpc.close()
        self.app.close()
        self.app_sock.close()

    def read(self):
        line = self.app.readline()
        self.assertTrue(line, "the plugin closed the stream")
        return json.loads(line)

    def test_hello_waits_for_its_answer_then_the_app_request_is_served(self):
        events = []

        def app():
            hello = self.read()
            events.append(hello["method"])
            self.assertEqual(hello["params"]["plugin"], "nse")
            self.assertEqual(hello["params"]["api"], 2)
            self.app_sock.sendall((json.dumps({
                "jsonrpc": "2.0", "id": hello["id"], "result": {"api": 2},
            }) + "\n").encode())
            self.app_sock.sendall((json.dumps({
                "jsonrpc": "2.0", "id": 42, "method": "data.search", "params": {"query": "tcs"},
            }) + "\n").encode())
            answer = self.read()
            events.append(answer)
            self.assertEqual(answer["id"], 42)
            self.assertEqual(answer["result"]["symbols"][0]["ticker"], "TCS")

        service = plugin.NsePlugin(self.rpc, StubSource())
        threading.Thread(target=self.rpc.run, args=(service.on_request, service.on_notification), daemon=True).start()
        client = threading.Thread(target=app, daemon=True)
        client.start()
        self.assertEqual(self.rpc.request("hello", {"plugin": "nse", "api": 2}, timeout=2), {"api": 2})
        client.join(timeout=3)
        self.assertFalse(client.is_alive(), "the app did not get its search answer")
        self.assertEqual(events[0], "hello")
        service.close()

    def test_a_request_from_the_app_is_dispatched(self):
        seen = []

        def on_request(request_id, method, params):
            seen.append(method)
            self.rpc.respond(request_id, result={"ok": True})

        threading.Thread(target=self.rpc.run, args=(on_request, lambda *_: None), daemon=True).start()
        self.app_sock.sendall((json.dumps({
            "jsonrpc": "2.0", "id": 7, "method": "data.search", "params": {"query": "x"},
        }) + "\n").encode())
        self.assertEqual(self.read()["result"], {"ok": True})
        self.app_sock.sendall((json.dumps({
            "jsonrpc": "2.0", "method": "data.subscribe", "params": {"tickers": []},
        }) + "\n").encode())
        time.sleep(0.1)
        self.assertEqual(seen, ["data.search"])


if __name__ == "__main__":
    unittest.main()
