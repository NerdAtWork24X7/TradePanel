"""Exchange catalogue and credential validation (no network)."""

from __future__ import annotations

import os
import unittest
from unittest import mock

from backend.Exchange import specs
from backend.ipc.credentials import CredentialStore


class ExchangeCatalogTests(unittest.TestCase):
    def test_every_chart_exchange_has_credentials(self):
        ids = {spec.id for spec in specs.EXCHANGES}
        self.assertEqual(
            ids,
            {
                "hyperliquid",
                "binance",
                "bybit",
                "okx",
                "gate",
                "bitget",
                "kucoin",
                "coinbase",
                "kraken",
            },
        )
        for spec in specs.EXCHANGES:
            self.assertTrue(spec.fields, spec.id)
            self.assertTrue(spec.markets, spec.id)
            self.assertTrue(spec.networks, spec.id)
            self.assertIn(spec.default_network, spec.networks)

    def test_ccxt_ids_match_the_chart_market(self):
        self.assertEqual(specs.ccxt_id("binance", "futures"), "binanceusdm")
        self.assertEqual(specs.ccxt_id("binance", "spot"), "binance")
        self.assertEqual(specs.ccxt_id("kucoin", "futures"), "kucoinfutures")
        self.assertEqual(specs.ccxt_id("hyperliquid", "futures"), "hyperliquid")
        with self.assertRaises(ValueError):
            specs.ccxt_id("coinbase", "futures")

    def test_hl_keys_stay_backwards_compatible(self):
        self.assertIn(("HL_ADDRESS", "Wallet address", False, "Hyperliquid"), specs.FIELDS)
        self.assertIn(("HL_PRIVATE_KEY", "Private key", True, "Hyperliquid"), specs.FIELDS)
        self.assertEqual(specs.field_exchange("HL_PRIVATE_KEY"), "hyperliquid")

    def test_network_validation_respects_venue_support(self):
        self.assertEqual(specs.validate_credential("BINANCE_NETWORK", "testnet"), None)
        self.assertEqual(specs.validate_credential("BINANCE_NETWORK", "live"), None)
        with self.assertRaises(ValueError):
            specs.validate_credential("KUCOIN_NETWORK", "testnet")
        with self.assertRaises(ValueError):
            specs.validate_credential("BINANCE_NETWORK", "demo")

    def test_api_secret_allows_line_breaks_only_when_multiline(self):
        pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----"
        self.assertEqual(specs.validate_credential("COINBASE_API_SECRET", pem), None)
        with self.assertRaises(ValueError):
            specs.validate_credential("BINANCE_API_SECRET", "abc\ndef")
        with self.assertRaises(ValueError):
            specs.validate_credential("BINANCE_API_SECRET", "")

    def test_configured_and_network_reads_environment(self):
        with mock.patch.dict(
            os.environ,
            {
                "BINANCE_API_KEY": "key-12345678",
                "BINANCE_API_SECRET": "secret-12345678",
                "BINANCE_NETWORK": "live",
            },
            clear=False,
        ):
            self.assertTrue(specs.required_configured("binance"))
            self.assertEqual(specs.network("binance"), "live")
            self.assertEqual(specs.missing_keys("binance"), [])
        with mock.patch.dict(
            os.environ, {"BINANCE_API_KEY": "", "BINANCE_API_SECRET": ""}, clear=False
        ):
            self.assertFalse(specs.required_configured("binance"))
            self.assertIn("API key", specs.missing_keys("binance"))


class CredentialApplyTests(unittest.TestCase):
    def test_apply_sets_network_and_trading_credentials(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            store = CredentialStore()
            changed = store.apply(
                {
                    "BINANCE_API_KEY": "key-12345678",
                    "BINANCE_API_SECRET": "secret-12345678",
                    "BINANCE_NETWORK": "testnet",
                },
                [],
            )
            self.assertEqual(
                changed,
                ["BINANCE_API_KEY", "BINANCE_API_SECRET", "BINANCE_NETWORK"],
            )
            self.assertEqual(specs.network("binance"), "testnet")
            self.assertTrue(specs.required_configured("binance"))
            described = {item["key"]: item for item in store.describe()}
            self.assertEqual(described["BINANCE_NETWORK"]["value"], "testnet")
            self.assertEqual(described["BINANCE_API_KEY"]["value"], "")

    def test_apply_rejects_unsupported_network(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            store = CredentialStore()
            with self.assertRaises(Exception):
                store.apply({"KUCOIN_NETWORK": "testnet"}, [])


if __name__ == "__main__":
    unittest.main()
