"""Method dispatch of the plugin's JSON-RPC face, over a stub broker (no socket, no venue)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import plugin  # noqa: E402
import specs  # noqa: E402
from ccxt_broker import BrokerError  # noqa: E402


class FakeRpc:
    def __init__(self):
        self.responses: list[tuple] = []
        self.notifications: list[tuple] = []

    def respond(self, request_id, result=None, error=None):
        self.responses.append((request_id, result, error))

    def notify(self, method, params=None):
        self.notifications.append((method, params))


class StubBroker:
    """The methods the plugin calls, recording what it asked for."""

    def __init__(self):
        self.calls: list[tuple] = []
        self.settings: dict[str, str] | None = None
        self.watched: list[str] = []
        self.started = 0

    def state(self):
        return {"connected": True}

    def resolve_symbol(self, symbol, ticker=""):
        self.calls.append(("resolve", symbol, ticker))
        return "BYBIT:BTC/USDT.P"

    def place(self, ticket):
        self.calls.append(("place", ticket))
        return "77"

    def modify(self, order_id, ticket):
        self.calls.append(("modify", order_id, ticket))

    def cancel(self, order_id):
        self.calls.append(("cancel", order_id))

    def close_position(self, position_id, qty):
        self.calls.append(("close", position_id, qty))

    def set_position_brackets(self, position_id, take_profit, stop_loss):
        self.calls.append(("brackets", position_id, take_profit, stop_loss))

    def watch_quote(self, tickers):
        self.watched = list(tickers)

    def configure(self, settings):
        self.settings = dict(settings)

    def start(self):
        self.started += 1

    def stop(self):
        pass


def plugin_with_stub() -> tuple[plugin.BrokerPlugin, StubBroker, FakeRpc]:
    rpc = FakeRpc()
    instance = plugin.BrokerPlugin(rpc, specs.venue("bybit"))
    stub = StubBroker()
    instance._broker = stub
    return instance, stub, rpc


class DispatchTests(unittest.TestCase):
    def test_every_broker_method_maps_onto_the_broker(self):
        instance, stub, _ = plugin_with_stub()
        self.assertEqual(instance._call("broker.state", {}), {"connected": True})
        self.assertEqual(
            instance._call("broker.resolveSymbol", {"symbol": "BYBIT:BTC/USDT.P", "ticker": "BTC/USDT.P"}),
            {"ticker": "BYBIT:BTC/USDT.P"},
        )
        self.assertEqual(instance._call("broker.place", {"ticker": "BYBIT:BTC/USDT.P", "side": "buy", "type": "market", "qty": 1}), {"orderId": "77"})
        instance._call("broker.modify", {"orderId": "7", "ticker": "BYBIT:BTC/USDT.P"})
        instance._call("broker.cancel", {"orderId": "7"})
        instance._call("broker.closePosition", {"positionId": "pos:BYBIT:BTC/USDT.P", "qty": None})
        instance._call("broker.setPositionBrackets", {"positionId": "pos:BYBIT:BTC/USDT.P", "takeProfit": 2.0, "stopLoss": None})
        self.assertEqual(stub.calls[0][0], "resolve")
        self.assertEqual(stub.calls[1][0], "place")
        self.assertEqual(stub.calls[2][:2], ("modify", "7"))
        self.assertEqual(stub.calls[3], ("cancel", "7"))
        self.assertEqual(stub.calls[4], ("close", "pos:BYBIT:BTC/USDT.P", None))
        self.assertEqual(stub.calls[5], ("brackets", "pos:BYBIT:BTC/USDT.P", 2.0, None))

    def test_an_unknown_method_is_refused_with_the_protocol_code(self):
        instance, _, _ = plugin_with_stub()
        with self.assertRaises(BrokerError) as raised:
            instance._call("broker.explode", {})
        self.assertEqual(raised.exception.code, -32601)

    def test_configure_and_watch_quote_are_notifications(self):
        instance, stub, _ = plugin_with_stub()
        instance.on_notification("plugin.configure", {"settings": {"apiKey": "k", "market": "spot"}})
        instance._pool.shutdown(wait=True)
        self.assertEqual(stub.settings, {"apiKey": "k", "market": "spot"})
        self.assertEqual(stub.started, 1)
        instance.on_notification("broker.watchQuote", {"tickers": ["BYBIT:BTC/USDT.P"]})
        self.assertEqual(stub.watched, ["BYBIT:BTC/USDT.P"])

    def test_a_request_is_answered_in_the_background(self):
        instance, _, rpc = plugin_with_stub()
        instance.on_request("1", "ping", {})
        instance._pool.shutdown(wait=True)
        self.assertEqual(rpc.responses, [("1", {}, None)])

    def test_a_broker_refusal_keeps_its_code(self):
        instance, stub, rpc = plugin_with_stub()

        def refuse(_ticket):
            raise BrokerError("no funds", -32000)

        stub.place = refuse
        instance.on_request("2", "broker.place", {"ticker": "BYBIT:BTC/USDT.P"})
        instance._pool.shutdown(wait=True)
        self.assertEqual(rpc.responses[-1][0], "2")
        self.assertEqual(rpc.responses[-1][2], {"code": -32000, "message": "no funds"})


if __name__ == "__main__":
    unittest.main()
