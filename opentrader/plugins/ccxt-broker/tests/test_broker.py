"""CCXT broker tests: symbols, precision, state mapping and order commands, offline.

The ccxt client is faked at the module boundary (``ccxt_broker._ccxt``), so nothing here
touches a network or a key. The fakes keep ccxt's shapes: unified market symbols, contract
sizes, precision helpers and the unified order dictionaries.
"""

from __future__ import annotations

import math
import sys
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import ccxt_broker  # noqa: E402
import specs  # noqa: E402
from ccxt_broker import BrokerInput, BrokerUnavailable, CcxtBroker, bracket_levels, parse_ticker  # noqa: E402


class FakeExchangeError(Exception):
    pass


class AuthenticationError(FakeExchangeError):
    pass


class InsufficientFunds(FakeExchangeError):
    pass


def market(symbol: str, base: str, quote: str, kind: str, amount_step: float, price_step: float, contract: float = 1.0) -> dict:
    return {
        "id": symbol.replace("/", "").replace(":", ""),
        "symbol": symbol,
        "base": base,
        "quote": quote,
        "spot": kind == "spot",
        "swap": kind == "swap",
        "active": True,
        "type": kind,
        "contractSize": contract if kind != "spot" else None,
        "precision": {"amount": amount_step, "price": price_step},
        "limits": {"amount": {"min": amount_step}, "cost": {"min": 5.0}},
    }


FUTURES = {
    "BTC/USDT:USDT": market("BTC/USDT:USDT", "BTC", "USDT", "swap", 0.001, 0.1),
    "ETH/USDT:USDT": market("ETH/USDT:USDT", "ETH", "USDT", "swap", 0.01, 0.01, contract=0.1),
}
SPOT = {
    "BTC/USDT": market("BTC/USDT", "BTC", "USDT", "spot", 0.00001, 0.1),
}


class FakeClient:
    """A ccxt exchange: markets, balances, positions, orders, trades and the order calls."""

    def __init__(self, options: dict | None = None):
        self.options = options or {}
        self.has = {"editOrder": True}
        self.sandbox = False
        self.markets: dict[str, dict] = {}
        self.balance = {
            "total": {"USDT": 1000.0, "BTC": 0.5},
            "free": {"USDT": 800.0, "BTC": 0.5},
            "used": {"USDT": 200.0},
        }
        self.positions: list[dict] = []
        self.open_orders: list[dict] = []
        self.trades: list[dict] = []
        self.tickers: dict[str, dict] = {}
        self.calls: list[tuple] = []
        self.fail_balance: Exception | None = None

    def set_sandbox_mode(self, enabled: bool) -> None:
        self.sandbox = enabled
        self.options["sandboxMode"] = enabled

    def load_markets(self) -> dict[str, dict]:
        self.markets = dict(FUTURES) if (self.options.get("options") or {}).get("defaultType") == "swap" else dict(SPOT)
        return self.markets

    # ── precision (ccxt's own helpers: the step is the market's) ─────────────

    def _step(self, symbol: str, key: str) -> float:
        return float(self.markets[symbol]["precision"][key])

    def amount_to_precision(self, symbol: str, amount: float) -> str:
        step = self._step(symbol, "amount")
        return f"{math.floor(float(amount) / step + 1e-9) * step:.12f}"

    def price_to_precision(self, symbol: str, price: float) -> str:
        step = self._step(symbol, "price")
        return f"{round(float(price) / step) * step:.12f}"

    # ── account ──────────────────────────────────────────────────────────────

    def fetch_balance(self, params: dict | None = None) -> dict:
        if self.fail_balance is not None:
            raise self.fail_balance
        self.calls.append(("fetch_balance",))
        return self.balance

    def fetch_positions(self, symbols: list[str] | None = None, params: dict | None = None) -> list[dict]:
        self.calls.append(("fetch_positions", symbols))
        return list(self.positions)

    def fetch_open_orders(self, symbol: str | None = None, since=None, limit=None, params: dict | None = None) -> list[dict]:
        self.calls.append(("fetch_open_orders", symbol))
        return [row for row in self.open_orders if symbol is None or row.get("symbol") == symbol]

    def fetch_my_trades(self, symbol: str | None = None, since=None, limit=None, params: dict | None = None) -> list[dict]:
        self.calls.append(("fetch_my_trades", symbol))
        return [row for row in self.trades if symbol is None or row.get("symbol") == symbol]

    def fetch_ticker(self, symbol: str) -> dict:
        self.calls.append(("fetch_ticker", symbol))
        return self.tickers.get(symbol, {"bid": 29999.5, "ask": 30000.5, "last": 30000.0})

    # ── orders ───────────────────────────────────────────────────────────────

    def create_order(self, symbol: str, type: str, side: str, amount: float, price=None, params: dict | None = None) -> dict:
        self.calls.append(("create_order", symbol, type, side, amount, price, dict(params or {})))
        return {"id": f"oid-{len(self.calls)}"}

    def edit_order(self, order_id: str, symbol: str, type: str, side: str, amount: float, price=None, params: dict | None = None) -> dict:
        self.calls.append(("edit_order", order_id, symbol, type, side, amount, price))
        return {"id": order_id}

    def cancel_order(self, order_id: str, symbol: str | None = None, params: dict | None = None) -> dict:
        self.calls.append(("cancel_order", order_id, symbol))
        return {"id": order_id}


class FakeCcxt:
    def __init__(self, client: FakeClient):
        self.client = client

    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)

        def factory(options=None):
            self.client.options = options or {}
            return self.client

        return factory


def make_broker(
    venue_id: str = "bybit",
    market: str = "futures",
    network: str = "live",
    client: FakeClient | None = None,
) -> tuple[CcxtBroker, FakeClient, list, list]:
    client = client or FakeClient()
    events: list[dict] = []
    notices: list[tuple[str, str]] = []
    venue = specs.venue(venue_id)
    broker = CcxtBroker(
        venue,
        log=lambda _message: None,
        notify=lambda level, message: notices.append((level, message)),
        event=events.append,
    )
    with mock.patch.object(ccxt_broker, "_ccxt", lambda: FakeCcxt(client)):
        broker.configure({
            "apiKey": "key",
            "apiSecret": "secret",
            "passphrase": "phrase",
            "network": network,
            "market": market,
            "pollSeconds": "3",
        })
    return broker, client, events, notices


def position(side: str = "long", contracts: float = 0.02, entry: float = 30000.0) -> dict:
    return {
        "symbol": "BTC/USDT:USDT",
        "contracts": contracts if side == "long" else -contracts,
        "contractSize": 1.0,
        "side": side,
        "entryPrice": entry,
        "markPrice": entry + 1000,
        "unrealizedPnl": 20.0,
    }


def trigger(order_id: str, price: float, kind: str = "stop") -> dict:
    return {
        "id": order_id,
        "symbol": "BTC/USDT:USDT",
        "side": "sell",
        "type": kind,
        "amount": 0.02,
        "filled": 0.0,
        "price": None,
        "triggerPrice": price,
        "status": "open",
        "timestamp": int(time.time() * 1000),
        "timeInForce": None,
    }


class SymbolTests(unittest.TestCase):
    def test_parses_the_plugin_symbols_and_bare_assets(self):
        self.assertEqual(parse_ticker("BINANCE:BTC/USDT.P"), ("BINANCE", "BTC", "USDT", True))
        self.assertEqual(parse_ticker("BYBIT:ETH/USDC"), ("BYBIT", "ETH", "USDC", False))
        self.assertEqual(parse_ticker("BTC"), (None, "BTC", None, False))
        self.assertEqual(parse_ticker("BTC/USDT:USDT"), (None, "BTC", "USDT", False))

    def test_maps_another_venue_chart_to_this_venue(self):
        broker, *_ = make_broker()
        self.assertEqual(broker.resolve_symbol("BINANCE:BTC/USDT.P", "BTC/USDT.P"), "BYBIT:BTC/USDT.P")
        # A spot chart trades this broker's configured market (perpetual futures here).
        self.assertEqual(broker.resolve_symbol("BINANCE:ETH/USDC", "ETH/USDC"), "BYBIT:ETH/USDT.P")
        self.assertIsNone(broker.resolve_symbol("BINANCE:DOGE/USDT.P", "DOGE/USDT.P"))

    def test_bracket_levels_follow_the_side(self):
        self.assertEqual(bracket_levels("buy", 100.0, [120.0, 90.0]), (120.0, 90.0))
        self.assertEqual(bracket_levels("sell", 100.0, [120.0, 90.0]), (90.0, 120.0))
        self.assertEqual(bracket_levels("buy", 100.0, [110.0]), (110.0, None))
        self.assertEqual(bracket_levels("buy", 100.0, [95.0]), (None, 95.0))
        self.assertEqual(bracket_levels("buy", 0.0, [95.0]), (95.0, None))


class StateTests(unittest.TestCase):
    def test_the_state_names_the_account_and_its_position(self):
        broker, client, _, _ = make_broker()
        client.positions = [position()]
        client.open_orders = [trigger("t1", 32000.0), trigger("t2", 28000.0)]
        client.trades = [{
            "id": "f1",
            "order": "e1",
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "amount": 0.02,
            "price": 30000.0,
            "timestamp": int(time.time() * 1000),
            "fee": {"cost": 0.5},
            "info": {"realizedPnl": "1.5"},
        }]
        broker._refresh()
        state = broker.state()
        self.assertTrue(state["connected"])
        self.assertEqual(state["account"]["currency"], "USDT")
        self.assertEqual(state["account"]["isDemo"], False)
        self.assertAlmostEqual(state["account"]["equity"], 1020.0)
        self.assertEqual(state["positionMode"], "netting")
        self.assertEqual(len(state["positions"]), 1)
        row = state["positions"][0]
        self.assertEqual(row["ticker"], "BYBIT:BTC/USDT.P")
        self.assertEqual(row["side"], "buy")
        self.assertAlmostEqual(row["qty"], 0.02)
        self.assertEqual(row["takeProfit"], 32000.0)
        self.assertEqual(row["stopLoss"], 28000.0)
        self.assertEqual(len(state["orders"]), 3)
        working = [order for order in state["orders"] if order["status"] == "working"]
        self.assertEqual(len(working), 2)
        self.assertEqual(working[0]["type"], "stop")
        self.assertEqual(len(state["executions"]), 1)
        self.assertEqual(state["executions"][0]["commission"], 0.5)
        self.assertEqual(state["executions"][0]["realizedPnl"], 1.5)

    def test_contract_size_turns_contracts_into_base_units(self):
        broker, client, _, _ = make_broker()
        client.positions = [{
            "symbol": "ETH/USDT:USDT",
            "contracts": 10.0,
            "contractSize": 0.1,
            "side": "short",
            "entryPrice": 2000.0,
            "markPrice": 1900.0,
            "unrealizedPnl": 100.0,
        }]
        broker._refresh()
        row = broker.state()["positions"][0]
        self.assertEqual(row["ticker"], "BYBIT:ETH/USDT.P")
        self.assertEqual(row["side"], "sell")
        self.assertAlmostEqual(row["qty"], 1.0)

    def test_testnet_marks_the_account_demo(self):
        broker, client, _, _ = make_broker(network="testnet")
        self.assertTrue(client.sandbox)
        broker._refresh()
        self.assertTrue(broker.state()["account"]["isDemo"])

    def test_spot_capabilities_are_long_only_but_still_modifiable(self):
        broker, *_ = make_broker(market="spot")
        broker._refresh()
        capabilities = broker.state()["capabilities"]
        self.assertEqual(capabilities["orderTypes"], ["market", "limit"])
        self.assertFalse(capabilities["brackets"])
        self.assertFalse(capabilities["positionBrackets"])
        self.assertEqual(broker.state()["positions"], [])

    def test_missing_keys_never_connect_and_warn_once(self):
        notices: list[tuple[str, str]] = []
        venue = specs.venue("okx")
        broker = CcxtBroker(venue, log=lambda _m: None, notify=lambda level, message: notices.append((level, message)), event=lambda _e: None)
        broker.configure({"apiKey": "", "apiSecret": "", "network": "live", "market": "futures"})
        broker._refresh()
        broker._refresh()
        self.assertFalse(broker.state()["connected"])
        self.assertEqual(len(notices), 1)
        self.assertIn("passphrase", notices[0][1])

    def test_rejected_credentials_become_a_connection_error(self):
        broker, client, _, _ = make_broker()
        client.fail_balance = AuthenticationError("bad key")
        with self.assertRaises(BrokerUnavailable):
            broker._refresh()

    def test_watched_tickers_produce_broker_quotes(self):
        broker, client, events, _ = make_broker()
        client.tickers["BTC/USDT:USDT"] = {"bid": 29999.5, "ask": 30000.5, "last": 30000.0}
        broker.watch_quote(["BYBIT:BTC/USDT.P"])
        broker._refresh()
        quotes = [event["__quote__"] for event in events if "__quote__" in event]
        self.assertEqual(quotes[-1], {"ticker": "BYBIT:BTC/USDT.P", "bid": 29999.5, "ask": 30000.5, "last": 30000.0})


class OrderTests(unittest.TestCase):
    def test_market_entry_rounds_the_contracts_and_places_both_brackets(self):
        broker, client, events, _ = make_broker()
        order_id = broker.place({
            "ticker": "BYBIT:BTC/USDT.P",
            "side": "buy",
            "type": "market",
            "qty": 0.0204,
            "takeProfit": 32000.0,
            "stopLoss": 28000.0,
        })
        self.assertTrue(order_id)
        creates = [call for call in client.calls if call[0] == "create_order"]
        self.assertEqual(len(creates), 3)
        entry = creates[0]
        self.assertEqual(entry[1:5], ("BTC/USDT:USDT", "market", "buy", 0.02))
        self.assertEqual(creates[1][6]["takeProfitPrice"], 32000.0)
        self.assertTrue(creates[1][6]["reduceOnly"])
        self.assertEqual(creates[1][3], "sell")
        self.assertEqual(creates[2][6]["stopLossPrice"], 28000.0)
        placed = [event for event in events if event.get("kind") == "placed"]
        self.assertEqual(placed[0]["ticker"], "BYBIT:BTC/USDT.P")
        self.assertAlmostEqual(placed[0]["qty"], 0.02)

    def test_limit_order_uses_the_venue_price_tick(self):
        broker, client, _, _ = make_broker()
        broker.place({
            "ticker": "BYBIT:BTC/USDT.P",
            "side": "sell",
            "type": "limit",
            "qty": 0.02,
            "limitPrice": 30000.04,
        })
        create = next(call for call in client.calls if call[0] == "create_order")
        self.assertEqual(create[2], "limit")
        self.assertAlmostEqual(create[5], 30000.0)
        self.assertEqual(create[6]["timeInForce"], "GTC")

    def test_a_stop_entry_carries_the_trigger_price(self):
        broker, client, _, _ = make_broker()
        broker.place({
            "ticker": "BYBIT:BTC/USDT.P",
            "side": "buy",
            "type": "stop",
            "qty": 0.02,
            "stopPrice": 31000.0,
        })
        create = next(call for call in client.calls if call[0] == "create_order")
        self.assertEqual(create[2], "market")
        self.assertEqual(create[6]["triggerPrice"], 31000.0)

    def test_a_quantity_below_the_step_is_refused_before_the_venue_sees_it(self):
        broker, client, _, _ = make_broker()
        with self.assertRaises(BrokerInput):
            broker.place({
                "ticker": "BYBIT:BTC/USDT.P",
                "side": "buy",
                "type": "market",
                "qty": 0.0004,
            })
        self.assertFalse([call for call in client.calls if call[0] == "create_order"])

    def test_a_spot_sell_is_sent_without_brackets(self):
        broker, client, _, _ = make_broker(market="spot")
        broker.place({
            "ticker": "BYBIT:BTC/USDT",
            "side": "sell",
            "type": "market",
            "qty": 0.5,
        })
        creates = [call for call in client.calls if call[0] == "create_order"]
        self.assertEqual(len(creates), 1)
        self.assertEqual(creates[0][1:4], ("BTC/USDT", "market", "sell"))

    def test_modify_edits_a_limit_order_in_place(self):
        broker, client, _, _ = make_broker()
        client.open_orders = [{
            "id": "7",
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "type": "limit",
            "amount": 0.02,
            "filled": 0.0,
            "price": 30000.0,
            "status": "open",
            "timestamp": int(time.time() * 1000),
        }]
        broker._refresh()
        broker.modify("7", {
            "ticker": "BYBIT:BTC/USDT.P",
            "side": "buy",
            "type": "limit",
            "qty": 0.03,
            "limitPrice": 30500.0,
        })
        edit = next(call for call in client.calls if call[0] == "edit_order")
        self.assertEqual(edit[1], "7")
        self.assertAlmostEqual(edit[6], 30500.0)
        self.assertAlmostEqual(edit[5], 0.03)

    def test_modify_replaces_an_order_when_the_venue_cannot_edit(self):
        broker, client, _, _ = make_broker()
        client.has = {"editOrder": False}
        client.open_orders = [{
            "id": "7",
            "symbol": "BTC/USDT:USDT",
            "side": "buy",
            "type": "limit",
            "amount": 0.02,
            "price": 30000.0,
            "status": "open",
        }]
        broker._refresh()
        broker.modify("7", {
            "ticker": "BYBIT:BTC/USDT.P",
            "side": "buy",
            "type": "limit",
            "qty": 0.02,
            "limitPrice": 30500.0,
        })
        self.assertTrue([call for call in client.calls if call[0] == "cancel_order"])
        self.assertTrue([call for call in client.calls if call[0] == "create_order"])

    def test_cancel_and_partial_close(self):
        broker, client, _, _ = make_broker()
        client.open_orders = [trigger("t1", 32000.0)]
        client.positions = [position()]
        broker._refresh()
        broker.cancel("t1")
        self.assertEqual([call for call in client.calls if call[0] == "cancel_order"][-1][1], "t1")
        broker.close_position("pos:BYBIT:BTC/USDT.P", 0.01)
        close = [call for call in client.calls if call[0] == "create_order"][-1]
        self.assertEqual(close[1:4], ("BTC/USDT:USDT", "market", "sell"))
        self.assertAlmostEqual(close[4], 0.01)
        self.assertTrue(close[6]["reduceOnly"])

    def test_setting_brackets_replaces_the_old_triggers(self):
        broker, client, _, _ = make_broker()
        client.positions = [position()]
        client.open_orders = [trigger("old", 32000.0)]
        broker._refresh()
        broker.set_position_brackets("pos:BYBIT:BTC/USDT.P", 33000.0, 29000.0)
        self.assertIn(("cancel_order", "old", "BTC/USDT:USDT"), client.calls)
        creates = [call for call in client.calls if call[0] == "create_order"]
        self.assertEqual(creates[-2][6]["takeProfitPrice"], 33000.0)
        self.assertEqual(creates[-1][6]["stopLossPrice"], 29000.0)

    def test_an_order_without_an_id_is_a_refusal(self):
        broker, client, _, _ = make_broker()
        client.create_order = lambda *args, **kwargs: {}
        with self.assertRaises(ccxt_broker.BrokerError):
            broker.place({"ticker": "BYBIT:BTC/USDT.P", "side": "buy", "type": "market", "qty": 0.02})


if __name__ == "__main__":
    unittest.main()
