"""Offline tests for Core.workspace_indicators (legacy studies on any exchange)."""

from __future__ import annotations

import math
import unittest
from unittest import mock

from Core import workspace_indicators as wi
from Indicator import config as indicator_config


def make_candles(count: int = 500, step: int = 300, base: float = 100.0) -> list[dict]:
    out = []
    price = base
    for i in range(count):
        wave = math.sin(i / 18.0) * 0.004
        open_ = price
        close = max(0.1, price * (1 + wave))
        high = max(open_, close) * 1.0015
        low = min(open_, close) * 0.9985
        out.append({
            "time": 1700000000 - (count - i) * step,
            "open": open_, "high": high, "low": low, "close": close,
            "volume": 10.0 + (i % 13),
        })
        price = close
    return out


class WorkspaceIndicatorTests(unittest.TestCase):
    def setUp(self):
        wi.clear_cache()
        self.candles = make_candles()
        self.config = {
            **indicator_config.DEFAULT_CONFIG,
            "fvg": {"gap_pct": 0.1, "enabled": True},
            "sessions": {
                "asian_start": "01:00", "asian_end": "07:00",
                "london_start": "08:00", "london_end": "14:00",
                "ny_am_start": "13:30", "ny_am_end": "16:00",
                "ny_pm_start": "16:00", "ny_pm_end": "20:00",
            },
            "ema_ribbon": {"ma_type": "EMA", "length1": 5, "length2": 10,
                           "length3": 20, "enabled": True},
            "volume_profile": {"length": 100, "rows": 12, "enabled": True},
            "hl_ema": {"length": 10, "enabled": True},
            "adx": {"length": 14, "pane_height": 120, "levels": [20, 25],
                    "show_di_lines": True, "enabled": True},
        }
        self.patches = [
            mock.patch.object(indicator_config, "load_indicator_config", return_value=self.config),
            mock.patch.object(wi, "_cache", {}),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()

    def _fetch(self, exchange, market, symbol, timeframe, limit=600, **_kw):
        return {"ok": True, "candles": self.candles[-limit:], "aggregated_from": None}

    def test_all_studies_compute(self):
        flags = {key: True for key in wi.ALL_FLAGS}
        with mock.patch.object(wi.market_data, "fetch_candles", side_effect=self._fetch):
            out = wi.compute_workspace_indicators("binance", "spot", "BTC/USDT", "5m", flags)
        self.assertTrue(out["ok"])
        self.assertEqual(set(out["sessions"]), {"asian", "london", "ny_am", "ny_pm"})
        self.assertTrue(out["sessions"]["asian"])
        self.assertEqual(set(out["fvg"]), {"bullish", "bearish"})
        self.assertGreater(len(out["ribbon"]["line1"]), 400)
        self.assertEqual(out["ribbon"]["ma_type"], "EMA")
        self.assertEqual(len(out["vp"]["rows"]), 12)
        self.assertGreater(out["vp"]["max_volume"], 0)
        self.assertGreater(out["vp"]["poc_price"], 0)
        self.assertTrue(out["daily_vp"])
        self.assertGreater(len(out["hl_ema"]["ema_high"]), 400)
        self.assertGreater(len(out["adx"]["adx"]), 100)
        self.assertEqual(out["adx"]["levels"], [20, 25])
        self.assertTrue(out["adx"]["show_di_lines"])

    def test_only_requested_studies_run(self):
        with mock.patch.object(wi.market_data, "fetch_candles", side_effect=self._fetch) as fetch:
            out = wi.compute_workspace_indicators(
                "okx", "spot", "SOL/USDT", "1h", {"hl_ema": True})
        self.assertIn("hl_ema", out)
        self.assertNotIn("adx", out)
        self.assertNotIn("sessions", out)
        self.assertEqual(fetch.call_count, 1)

    def test_empty_flags_short_circuit(self):
        with mock.patch.object(wi.market_data, "fetch_candles") as fetch:
            out = wi.compute_workspace_indicators(
                "binance", "spot", "BTC/USDT", "5m", {})
        self.assertTrue(out["empty"])
        fetch.assert_not_called()

    def test_one_failure_does_not_break_the_payload(self):
        flags = {key: True for key in wi.ALL_FLAGS}
        with mock.patch.object(wi.market_data, "fetch_candles", side_effect=self._fetch), \
             mock.patch.object(wi, "_compute_fvg_impl", side_effect=RuntimeError("boom")):
            out = wi.compute_workspace_indicators("binance", "spot", "BTC/USDT", "5m", flags)
        self.assertIsNone(out["fvg"])
        self.assertTrue(out["sessions"])
        self.assertGreater(len(out["ribbon"]["line1"]), 0)

    def test_cache_returns_same_payload(self):
        flags = {"hl_ema": True}
        with mock.patch.object(wi.market_data, "fetch_candles", side_effect=self._fetch) as fetch:
            first = wi.compute_workspace_indicators("binance", "spot", "BTC/USDT", "5m", flags)
            second = wi.compute_workspace_indicators("binance", "spot", "BTC/USDT", "5m", flags)
        self.assertEqual(fetch.call_count, 1)
        self.assertIs(first, second)


if __name__ == "__main__":
    unittest.main()
