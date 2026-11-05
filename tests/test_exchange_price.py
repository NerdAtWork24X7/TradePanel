"""Hyperliquid perp price-precision rounding tests (no network)."""

from __future__ import annotations

import unittest
from unittest import mock

from backend.Core import calculations, trading_service
from backend.Exchange.hyperliquid import HyperliquidClient


class ExchangePricePrecisionTests(unittest.TestCase):
    def test_decimal_places_follow_sz_decimals(self):
        self.assertEqual(calculations.price_decimals(5), 1)   # BTC
        self.assertEqual(calculations.price_decimals(4), 2)   # ETH
        self.assertEqual(calculations.price_decimals(0), 6)
        self.assertEqual(calculations.price_decimals(7), 0)   # clamp at zero

    def test_rounds_to_tick_and_five_significant_figures(self):
        cases = [
            (96.75915071108538, 5, 96.8),       # BTC: 1 dp
            (97.2737621818553, 4, 97.27),       # ETH: 2 dp
            (96.2760168013456, 4, 96.28),
            (150.123456789, 2, 150.12),         # 5 sig figs wins over 4 dp
            (0.012345678, 0, 0.012346),         # 6 dp
            (0.000001234567, 0, 0.000001),
            (96000.123456, 5, 96000.0),         # 5 sig figs caps the integer part
            (1234.56789, 4, 1234.6),
        ]
        for price, sz_decimals, expected in cases:
            with self.subTest(price=price, sz=sz_decimals):
                self.assertEqual(
                    calculations.round_exchange_price(price, sz_decimals), expected
                )

    def test_already_valid_prices_are_unchanged(self):
        self.assertEqual(calculations.round_exchange_price(96.8, 5), 96.8)
        self.assertEqual(calculations.round_exchange_price(97.27, 4), 97.27)

    def test_float_noise_is_removed(self):
        self.assertEqual(calculations.round_exchange_price(0.1 + 0.2, 5), 0.3)

    def test_rpc_payload_shape(self):
        with mock.patch.object(HyperliquidClient, "get_sz_decimals", return_value=5):
            payload = trading_service.price_precision(" BTC ")
        self.assertEqual(payload, {
            "coin": "BTC",
            "sz_decimals": 5,
            "price_decimals": 1,
            "price_sig_figs": 5,
        })

    def test_order_rounding_uses_cached_exchange_meta(self):
        with mock.patch.object(HyperliquidClient, "get_sz_decimals", return_value=5):
            self.assertEqual(
                trading_service._round_to_exchange("BTC", 96.75915071108538),
                (96.8,),
            )


if __name__ == "__main__":
    unittest.main()
