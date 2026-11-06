"""ccxt broker normalisation tests with an in-memory market catalogue."""

from __future__ import annotations

import os
import unittest
from decimal import Decimal
from unittest import mock

from backend.Core.models import OrderParams
from backend.Exchange import ccxt_broker


class FakeClient:
    def __init__(self, markets: dict[str, dict]) -> None:
        self.markets = markets


def market(
    symbol: str,
    base: str,
    quote: str,
    *,
    contract: bool,
    amount: float,
    price: float,
    contract_size: float = 1.0,
    min_amount: float = 0.0,
    min_cost: float = 0.0,
) -> dict:
    return {
        "symbol": symbol,
        "id": symbol.replace("/", "").replace(":", ""),
        "base": base,
        "quote": quote,
        "spot": not contract,
        "swap": contract,
        "future": False,
        "contract": contract,
        "active": True,
        "precision": {"amount": amount, "price": price},
        "limits": {
            "amount": {"min": min_amount or None},
            "cost": {"min": min_cost or None},
        },
        "contractSize": contract_size,
    }


class BrokerUnitTests(unittest.TestCase):
    def setUp(self):
        ccxt_broker.reset_clients()
        self.markets = {
            "BTC/USDT:USDT": market(
                "BTC/USDT:USDT", "BTC", "USDT", contract=True, amount=0.001, price=0.1,
                contract_size=0.01, min_amount=0.001, min_cost=5,
            ),
            "BTC/USDC:USDC": market(
                "BTC/USDC:USDC", "BTC", "USDC", contract=True, amount=0.001, price=0.1,
            ),
            "ETH/USDT:USDT": market(
                "ETH/USDT:USDT", "ETH", "USDT", contract=True, amount=0.01, price=0.01,
            ),
            "BTC/USDT": market(
                "BTC/USDT", "BTC", "USDT", contract=False, amount=0.000001, price=0.1,
            ),
        }
        self.broker = ccxt_broker.CcxtBroker("binance", "futures", "live")
        self.broker._public = FakeClient(self.markets)

    def tearDown(self):
        ccxt_broker.reset_clients()

    def test_market_prefers_usdt(self):
        resolved = self.broker.market_for("BTC")
        self.assertEqual(resolved["symbol"], "BTC/USDT:USDT")

    def test_contract_conversion_uses_contract_size(self):
        info = self.broker.instrument("BTC")
        self.assertEqual(info.contract_size, Decimal("0.01"))
        self.assertEqual(info.sz_decimals, 5)  # 0.001 contracts * 0.01 BTC
        contracts, base_qty = self.broker.round_quantity("BTC", 0.0012)
        self.assertAlmostEqual(contracts, 0.12)
        self.assertAlmostEqual(base_qty, 0.0012)

    def test_below_step_is_rejected(self):
        with self.assertRaises(ccxt_broker.BrokerInputError):
            self.broker.round_quantity("BTC", 0.0000001)

    def test_minimum_notional_is_enforced(self):
        with self.assertRaises(ccxt_broker.BrokerInputError):
            self.broker.round_quantity("BTC", 0.001, limit_price=100.0)

    def test_price_rounding_uses_tick_size(self):
        self.assertAlmostEqual(self.broker.round_price("BTC", 96.75915071108538), 96.8)
        self.assertAlmostEqual(self.broker.round_price("ETH", 123.456), 123.46)

    def test_spot_short_is_rejected_before_touching_the_api(self):
        spot = ccxt_broker.CcxtBroker("binance", "spot", "live")
        spot._public = FakeClient(self.markets)
        result = spot.place_order(
            OrderParams(
                coin="BTC", is_buy=False, qty=0.001,
                limit_price=100.0, tp_price=110.0, sl_price=90.0,
            )
        )
        self.assertFalse(result.success)
        self.assertIn("Spot markets support buy entries only", result.error or "")

    def test_decimals_helper_handles_tick_sizes(self):
        self.assertEqual(ccxt_broker._decimals(Decimal("0.1")), 1)
        self.assertEqual(ccxt_broker._decimals(Decimal("0.00001")), 5)
        self.assertEqual(ccxt_broker._decimals(Decimal("1")), 0)


@unittest.skipUnless(
    os.environ.get("TRADEPANEL_LIVE_MARKET_CHECK") == "1",
    "set TRADEPANEL_LIVE_MARKET_CHECK=1 to smoke-test public venue metadata",
)
class BrokerCatalogTests(unittest.TestCase):
    def test_public_market_metadata_loads_for_every_exchange(self):
        """Live public endpoint smoke: no credentials, no orders."""
        failures: dict[str, str] = {}
        for spec in ccxt_broker.specs.EXCHANGES:
            for market_name in spec.markets:
                try:
                    broker = ccxt_broker.CcxtBroker(spec.id, market_name, spec.default_network)
                    info = broker.instrument("BTC")
                    self.assertTrue(info.symbol)
                    self.assertGreaterEqual(info.price_decimals, 0)
                except ccxt_broker.BrokerInputError:
                    # Some venues do not list a BTC market in this market type.
                    continue
                except Exception as exc:  # noqa: BLE001 - report the venue, not the test
                    failures[f"{spec.id}/{market_name}"] = f"{type(exc).__name__}: {exc}"
        self.assertEqual(failures, {})


if __name__ == "__main__":
    unittest.main()
