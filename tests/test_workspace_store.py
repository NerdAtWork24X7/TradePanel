"""Offline tests for Core.workspace_store validation and persistence."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.Core import workspace_store as ws


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        os.unlink(self.tmp.name)
        self.patch = mock.patch.object(ws, "WORKSPACES_FILE", Path(self.tmp.name))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass
        for suffix in (".corrupt",):
            try:
                os.unlink(self.tmp.name + suffix)
            except OSError:
                pass

    def test_default_store_shape(self):
        store = ws.default_store()
        self.assertEqual(store["version"], 1)
        workspace = store["workspaces"][0]
        self.assertEqual(workspace["layout"], "4")
        self.assertEqual(len(workspace["charts"]), 4)
        self.assertEqual([c["symbol"] for c in workspace["charts"]],
                         ["BTC/USDT", "BTC/USDT", "ETH/USDT", "SOL/USDT"])
        self.assertEqual(workspace["charts"][0]["groupId"], "g-red")
        self.assertEqual(len(workspace["syncGroups"]), 2)

    def test_round_trip_is_stable(self):
        payload = {
            "version": 1, "active": "w1",
            "workspaces": [{
                "id": "w1", "name": "Scalping", "layout": "custom",
                "columns": [0.6, 0.4], "rows": [0.5, 0.5],
                "charts": [
                    {"id": "c1", "exchange": "bybit", "market": "futures",
                     "symbol": "eth/usdt", "timeframe": "1h", "chartType": "hollow",
                     "priceScaleMode": "percentage", "referenceMode": "custom",
                     "referenceTime": 1700000000, "groupId": "g1",
                     "indicators": {"rsi": {"enabled": True, "length": 9}},
                     "drawings": [{"tool": "trend", "points": [
                         {"time": 1700000000, "price": 100},
                         {"time": 1700003600, "price": 110}]}]},
                ],
                "syncGroups": [{"id": "g1", "name": "One", "color": "#2962FF",
                                "enabled": True,
                                "settings": {"crosshair": False, "nearestPolicy": "closest"}}],
                "globalSettings": {"zoom": False},
            }],
        }
        saved = ws.save_store(payload)
        loaded = ws.load_store()
        self.assertEqual(saved, loaded)
        chart = loaded["workspaces"][0]["charts"][0]
        self.assertEqual(chart["exchange"], "bybit")
        self.assertEqual(chart["market"], "futures")
        self.assertEqual(chart["symbol"], "ETH/USDT")
        self.assertEqual(chart["chartType"], "hollow")
        self.assertEqual(chart["priceScaleMode"], "percentage")
        self.assertEqual(chart["referenceMode"], "custom")
        self.assertEqual(chart["referenceTime"], 1700000000)
        self.assertEqual(chart["indicators"]["rsi"]["length"], 9)
        self.assertEqual(len(chart["drawings"]), 1)
        self.assertFalse(loaded["workspaces"][0]["syncGroups"][0]["settings"]["crosshair"])

    def test_hostile_payload_is_clamped(self):
        payload = {
            "active": "missing",
            "workspaces": [{
                "id": "x" * 100, "name": "", "layout": "bogus",
                "charts": [
                    {"id": "a", "exchange": "evil", "market": "perp",
                     "symbol": "  btc/usdt ", "timeframe": "7m",
                     "chartType": "candle", "groupId": "nope",
                     "indicators": {"rsi": {"enabled": True, "length": 9999},
                                    "macd": {"enabled": 1}}},
                    {"id": "a", "exchange": "binance", "symbol": "ETH/USDT",
                     "timeframe": "1h"},
                    "junk",
                ],
                "syncGroups": [{"id": "g1", "color": 42}, {"id": "g1", "name": "dup"}],
                "columns": [0, 0], "rows": [-1, 3],
            }],
        }
        store = ws._store(payload)
        workspace = store["workspaces"][0]
        self.assertEqual(store["active"], workspace["id"])
        self.assertEqual(len(workspace["charts"]), 2)
        self.assertNotEqual(workspace["charts"][0]["id"], workspace["charts"][1]["id"])
        chart = workspace["charts"][0]
        self.assertEqual(chart["exchange"], "binance")
        self.assertEqual(chart["market"], "spot")
        self.assertEqual(chart["symbol"], "BTC/USDT")
        self.assertEqual(chart["timeframe"], "5m")
        self.assertEqual(chart["chartType"], "candlestick")
        self.assertIsNone(chart["groupId"])
        self.assertEqual(chart["indicators"]["rsi"]["length"], 500)
        self.assertFalse(chart["indicators"]["macd"]["enabled"])
        self.assertEqual(len(workspace["syncGroups"]), 1)
        for tracks in (workspace["columns"], workspace["rows"]):
            self.assertAlmostEqual(sum(tracks), 1.0, places=5)
            self.assertTrue(all(0.0 < v <= 1.0 for v in tracks))

    def test_duplicate_chart_ids_are_made_unique(self):
        store = ws._store({"workspaces": [{
            "id": "w", "charts": [{"id": "c1"}, {"id": "c1"}, {"id": "c1"}],
            "syncGroups": [],
        }]})
        ids = [c["id"] for c in store["workspaces"][0]["charts"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_group_assignment_is_cleared_when_group_missing(self):
        store = ws._store({"workspaces": [{
            "id": "w", "charts": [{"id": "c1", "groupId": "ghost"}],
            "syncGroups": [{"id": "real"}],
        }]})
        self.assertIsNone(store["workspaces"][0]["charts"][0]["groupId"])

    def test_corrupt_file_is_preserved_and_defaults_returned(self):
        with open(self.tmp.name, "w") as f:
            f.write("{not json")
        store = ws.load_store()
        self.assertEqual(store["version"], 1)
        self.assertTrue(os.path.exists(self.tmp.name + ".corrupt"))

    def test_last_workspace_cannot_be_deleted(self):
        store = ws.default_store()
        with self.assertRaises(ValueError):
            ws.delete_workspace(store, store["workspaces"][0]["id"])

    def test_delete_switches_active_workspace(self):
        store = ws.save_store({
            "version": 1, "active": "w1",
            "workspaces": [
                {"id": "w1", "name": "A", "charts": [{"id": "c1"}], "syncGroups": []},
                {"id": "w2", "name": "B", "charts": [{"id": "c1"}], "syncGroups": []},
            ],
        })
        result = ws.delete_workspace(store, "w1")
        self.assertEqual(result["active"], "w2")
        self.assertEqual([w["id"] for w in result["workspaces"]], ["w2"])

    def test_drawings_are_sanitized(self):
        store = ws._store({"workspaces": [{
            "id": "w",
            "charts": [{"id": "c1", "drawings": [
                {"tool": "hline", "points": [{"time": 0, "price": 1}]},
                {"tool": "unknown", "points": []},
                {"tool": "text", "points": [{"time": 1, "price": 2}], "text": "x" * 500},
                "junk",
            ]}],
            "syncGroups": [],
        }]})
        drawings = store["workspaces"][0]["charts"][0]["drawings"]
        self.assertEqual([d["tool"] for d in drawings], ["hline", "text"])
        self.assertEqual(len(drawings[1]["text"]), 120)

    def test_indicator_defaults_are_complete(self):
        store = ws.default_store()
        indicators = store["workspaces"][0]["charts"][0]["indicators"]
        self.assertEqual(set(indicators), set(ws.DEFAULT_INDICATORS))
        for key, conf in indicators.items():
            self.assertIn("enabled", conf)
            for param in ws.DEFAULT_INDICATORS[key]:
                if param != "enabled":
                    self.assertIn(param, conf)

    def test_atomic_write_leaves_no_temp_file(self):
        ws.save_store(ws.default_store())
        leftovers = [p for p in Path(self.tmp.name).parent.glob("*.tmp*")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
