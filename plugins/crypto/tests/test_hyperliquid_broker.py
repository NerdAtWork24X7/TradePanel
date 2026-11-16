"""Hyperliquid broker tests: naming, precision, bracket inference and SDK calls, offline."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crypto_source import CryptoSource, Market, PluginError, _Loaded  # noqa: E402
from hyperliquid_broker import (  # noqa: E402
    HyperliquidBroker,
    bracket_levels,
    coin_of,
    order_type_of,
    round_price,
    round_size,
)


class FakeData(CryptoSource):
    def __init__(self):
        super().__init__(log=lambda _m: None)

    def _ensure(self, venue, kind):
        item = _Loaded(client=None)
        m = {
            "symbol": "BTC/USDC:USDC", "base": "BTC", "quote": "USDC", "spot": False,
            "swap": True, "linear": True, "settle": "USDC", "precision": {"price": 1},
            "precisionMode": 2,
        }
        item.by_ticker["BTC/USDC.P"] = Market("HYPERLIQUID", "hyperliquid", "swap", "BTC/USDC.P", "BTC/USDC:USDC", m)
        item.by_ccxt["BTC/USDC:USDC"] = item.by_ticker["BTC/USDC.P"]
        return item


class FakeExchange:
    def __init__(self):
        self.calls: list[tuple] = []

    def market_open(self, coin, is_buy, sz, px=None, slippage=0.01):
        self.calls.append(("market_open", coin, is_buy, sz, px, slippage))
        return {"status": "ok", "response": {"data": {"statuses": [{"filled": {"oid": 11, "avgPx": "100"}}]}}}

    def market_close(self, coin, sz=None, px=None, slippage=0.01):
        self.calls.append(("market_close", coin, sz))
        return {"status": "ok", "response": {"data": {"statuses": [{"filled": {"oid": 12}}]}}}

    def order(self, coin, is_buy, sz, px, order_type, reduce_only=False, cloid=None):
        self.calls.append(("order", coin, is_buy, sz, px, order_type, reduce_only))
        return {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": 13}}]}}}

    def cancel(self, coin, oid):
        self.calls.append(("cancel", coin, oid))
        return {"status": "ok"}

    def modify_order(self, oid, coin, is_buy, sz, px, order_type, reduce_only=False, cloid=None):
        self.calls.append(("modify", oid, coin, is_buy, sz, px))
        return {"status": "ok", "response": {"data": {"statuses": [{"resting": {"oid": oid}}]}}}


class FakeInfo:
    def __init__(self, state=None, orders=None, mids=None):
        self._state = state or {"assetPositions": []}
        self._orders = orders or []
        self._mids = mids or {}

    def user_state(self, address):
        return self._state

    def frontend_open_orders(self, address):
        return self._orders

    def open_orders(self, address):
        return self._orders

    def user_fills(self, address):
        return []

    def all_mids(self):
        return self._mids

    def l2_snapshot(self, coin):
        return {"levels": [[{"px": "99.9"}], [{"px": "100.1"}]]}


def broker() -> HyperliquidBroker:
    b = HyperliquidBroker(FakeData(), log=lambda _m: None, notify=lambda _l, _m: None, event=lambda _p: None)
    b._universe = {"BTC": {"name": "BTC", "szDecimals": 5, "maxLeverage": 50}}
    b._address = "0xabc"
    b._info = FakeInfo()
    b._exchange = FakeExchange()
    b._online = True
    b._network = "testnet"
    b._settings = {"slippage": "0.5", "pollSeconds": "3"}
    return b


class NamingTests(unittest.TestCase):
    def test_coin_from_chart_ticker(self):
        self.assertEqual(coin_of("HYPERLIQUID:BTC/USDC.P"), "BTC")
        self.assertEqual(coin_of("HYPERLIQUID:BTC"), "BTC")
        self.assertEqual(coin_of("BTC/USDC.P"), "BTC")

    def test_position_ticker_is_the_data_ticker(self):
        self.assertEqual(broker().ticker_of_coin("BTC"), "HYPERLIQUID:BTC/USDC.P")

    def test_foreign_symbol_maps_by_base_asset(self):
        b = broker()
        self.assertEqual(b.resolve_symbol("BINANCE:BTCUSDT", "BTCUSDT"), "HYPERLIQUID:BTC/USDC.P")
        self.assertEqual(b.resolve_symbol("BINANCE:BTC/USDT", "BTC/USDT"), "HYPERLIQUID:BTC/USDC.P")
        self.assertIsNone(b.resolve_symbol("BINANCE:ETHUSDT", "ETHUSDT"))


class PrecisionTests(unittest.TestCase):
    def test_size_rounds_down_never_up(self):
        self.assertEqual(round_size(0.123456, 4), 0.1234)
        self.assertEqual(round_size(1.0, 0), 1.0)

    def test_size_below_step_is_refused(self):
        with self.assertRaises(PluginError):
            round_size(0.00001, 4)
        with self.assertRaises(PluginError):
            round_size(0, 4)

    def test_price_five_significant_figures(self):
        self.assertEqual(round_price(123_456.789, 5), 123_460.0)
        self.assertEqual(round_price(0.123456789, 2), 0.1235)
        self.assertEqual(round_price(100.123, 0), 100.12)


class LabelTests(unittest.TestCase):
    def test_order_type_from_row(self):
        self.assertEqual(order_type_of({"orderType": "Limit", "isTrigger": False}), "limit")
        self.assertEqual(order_type_of({"orderType": "Stop Market", "isTrigger": True}), "stop")
        self.assertEqual(order_type_of({"orderType": "Stop Limit", "isTrigger": True}), "stopLimit")

    def test_bracket_levels_by_side(self):
        self.assertEqual(bracket_levels(1.0, [90, 110]), (110, 90))
        self.assertEqual(bracket_levels(-1.0, [90, 110]), (90, 110))

    def test_single_trigger_uses_the_entry(self):
        self.assertEqual(bracket_levels(1.0, [110], entry=100), (110, None))
        self.assertEqual(bracket_levels(1.0, [90], entry=100), (None, 90))


class PlaceTests(unittest.TestCase):
    def test_market_order_uses_market_open_and_records_brackets(self):
        b = broker()
        oid = b.place({"ticker": "HYPERLIQUID:BTC/USDC.P", "side": "buy", "type": "market", "qty": 0.1,
                       "takeProfit": 120, "stopLoss": 90})
        self.assertEqual(oid, "11")
        call = b._exchange.calls[0]
        self.assertEqual(call[:4], ("market_open", "BTC", True, 0.1))
        self.assertAlmostEqual(call[5], 0.005)
        self.assertEqual(b._pending_brackets["BTC"], (120.0, 90.0))

    def test_limit_order_carries_a_rounded_price(self):
        b = broker()
        b.place({"ticker": "HYPERLIQUID:BTC", "side": "sell", "type": "limit", "qty": 0.25, "limitPrice": 123.456789})
        self.assertEqual(b._exchange.calls[0], ("order", "BTC", False, 0.25, 123.5, {"limit": {"tif": "Gtc"}}, False))

    def test_stop_orders_are_trigger_orders(self):
        b = broker()
        b.place({"ticker": "HYPERLIQUID:BTC", "side": "buy", "type": "stop", "qty": 0.1, "stopPrice": 110})
        self.assertEqual(b._exchange.calls[0][5], {"trigger": {"isMarket": True, "triggerPx": 110.0, "tpsl": "sl"}})

    def test_stop_limit_uses_a_limit_after_the_trigger(self):
        b = broker()
        b.place({"ticker": "HYPERLIQUID:BTC", "side": "buy", "type": "stopLimit", "qty": 0.1,
                 "stopPrice": 110, "limitPrice": 111})
        self.assertEqual(b._exchange.calls[0][4], 111.0)
        self.assertEqual(b._exchange.calls[0][5]["trigger"]["isMarket"], False)

    def test_sdk_refusal_becomes_a_plugin_error(self):
        b = broker()

        def refuse(*_a, **_k):
            return {"status": "ok", "response": {"data": {"statuses": [{"error": "Insufficient margin"}]}}}

        b._exchange.order = refuse
        with self.assertRaises(PluginError) as caught:
            b.place({"ticker": "HYPERLIQUID:BTC", "side": "buy", "type": "limit", "qty": 1, "limitPrice": 100})
        self.assertIn("Insufficient margin", str(caught.exception))

    def test_unknown_coin_is_refused_before_the_sdk(self):
        with self.assertRaises(PluginError):
            broker().place({"ticker": "HYPERLIQUID:DOGE", "side": "buy", "type": "market", "qty": 1})

    def test_modify_replaces_a_trigger_instead_of_modifying_it(self):
        b = broker()
        b.place({"ticker": "HYPERLIQUID:BTC", "side": "buy", "type": "stop", "qty": 0.1, "stopPrice": 110}, modify_oid="77")
        self.assertEqual(b._exchange.calls[0][0], "cancel")
        self.assertEqual(b._exchange.calls[1][0], "order")


class StateTests(unittest.TestCase):
    def state(self):
        return {
            "marginSummary": {"accountValue": "1000", "totalMarginUsed": "100", "totalNtlPos": "500"},
            "withdrawable": "900",
            "assetPositions": [{"position": {
                "coin": "BTC", "szi": "0.1", "entryPx": "100", "positionValue": "10",
                "unrealizedPnl": "0.5", "liquidationPx": "80", "leverage": {"value": 10},
            }}],
        }

    def test_account_and_positions_use_whole_symbols(self):
        b = broker()
        b._info = FakeInfo(state=self.state(), orders=[
            {"oid": 1, "coin": "BTC", "isTrigger": True, "triggerPx": "120", "orderType": "Take Profit Market"},
            {"oid": 2, "coin": "BTC", "isTrigger": True, "triggerPx": "90", "orderType": "Stop Market"},
        ], mids={"BTC": "101"})
        account, _ = b._account(self.state(), [])
        self.assertTrue(account["isDemo"])
        self.assertEqual(account["balance"], 1000.0)
        positions = b._positions(self.state(), b._info._orders, b._info._mids)
        self.assertEqual(positions[0]["ticker"], "HYPERLIQUID:BTC/USDC.P")
        self.assertEqual(positions[0]["side"], "buy")
        self.assertEqual((positions[0]["takeProfit"], positions[0]["stopLoss"]), (120.0, 90.0))

    def test_open_orders_become_wire_orders(self):
        b = broker()
        orders = [{"oid": 5, "coin": "BTC", "side": "B", "origSz": "1", "sz": "0.6",
                   "limitPx": "100", "isTrigger": False, "timestamp": 1, "orderType": "Limit"}]
        rows = b._orders(orders, [], [])
        self.assertEqual(rows[0]["id"], "5")
        self.assertEqual(rows[0]["filledQty"], 0.4)
        self.assertEqual(rows[0]["status"], "working")

    def test_fills_are_executions_and_filled_orders(self):
        b = broker()
        fills = [{"oid": 9, "coin": "BTC", "side": "A", "sz": "0.1", "px": "101", "time": 10,
                  "fee": "-0.01", "closedPnl": "0.2", "hash": "0x1", "tid": 1, "crossed": True}]
        executions = b._executions(fills)
        self.assertEqual(executions[0]["commission"], 0.01)
        self.assertEqual(executions[0]["realizedPnl"], 0.2)
        rows = b._orders([], fills, [])
        self.assertEqual(rows[0]["status"], "filled")
        self.assertAlmostEqual(rows[0]["avgFillPrice"], 101.0)


if __name__ == "__main__":
    unittest.main()
