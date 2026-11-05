"""Hyperliquid SDK wiring tests (no network, no credentials)."""

from __future__ import annotations

import unittest
from unittest import mock

from Exchange import hyperliquid


class SdkClientWiringTests(unittest.TestCase):
    def test_info_is_created_without_a_websocket(self):
        """The SDK's websocket thread is non-daemon and blocks process exit.

        The backend only uses REST endpoints, so every ``Info`` must be built
        with ``skip_ws=True`` (see the close-hang regression).
        """
        with mock.patch.object(hyperliquid, "Info") as info:
            hyperliquid._make_info("https://example.invalid")
        info.assert_called_once_with("https://example.invalid", skip_ws=True)

    def test_sz_decimals_uses_the_websocket_free_factory(self):
        HyperliquidClient = hyperliquid.HyperliquidClient
        HyperliquidClient.reset()
        self.addCleanup(HyperliquidClient.reset)
        with mock.patch.object(hyperliquid, "Info") as info:
            info.return_value.meta.return_value = {
                "universe": [{"name": "BTC", "szDecimals": 5}]
            }
            self.assertEqual(HyperliquidClient.get_sz_decimals("BTC"), 5)
        for call in info.call_args_list:
            self.assertTrue(call.kwargs.get("skip_ws"), "Info must skip the websocket")


if __name__ == "__main__":
    unittest.main()
