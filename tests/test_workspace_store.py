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
                     "indicators": [
                         {"id": "rsi", "inputs": {"length": 9},
                          "plots": {"plot0": {"color": "#ff0000", "lineWidth": 2}},
                          "visible": True},
                     ],
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
        self.assertEqual(chart["indicators"][0]["id"], "rsi")
        self.assertEqual(chart["indicators"][0]["inputs"]["length"], 9)
        self.assertEqual(chart["indicators"][0]["plots"]["plot0"]["color"], "#ff0000")
        self.assertTrue(chart["showVolume"])
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
                     "indicators": [
                         {"id": "rsi", "inputs": {"length": 9999}, "visible": False},
                         {"id": "rsi", "inputs": {"length": 3}},
                         {"id": "../evil", "inputs": {}},
                         {"id": "macd", "inputs": {"fastLength": "12", "slowLength": True}},
                     ]},
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
        self.assertEqual([item["id"] for item in chart["indicators"]], ["rsi", "rsi", "macd"])
        self.assertEqual(chart["indicators"][0]["inputs"]["length"], 9999)
        self.assertFalse(chart["indicators"][0]["visible"])
        self.assertEqual(chart["indicators"][1]["inputs"]["length"], 3)
        self.assertEqual(chart["indicators"][2]["inputs"]["fastLength"], "12")
        self.assertTrue(chart["indicators"][2]["inputs"]["slowLength"])
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

    def test_new_drawing_model_round_trips(self):
        payload = {
            "id": "dw-1",
            "kind": "fib-retracement",
            "points": [{"time": 1700000000, "price": 100.5}, {"time": 1700003600, "price": 120.25}],
            "style": {
                "color": "#f23645",
                "width": 2,
                "lineStyle": "dashed",
                "transparency": 80,
                "levels": [{"coeff": 0.618, "color": "#089981", "visible": True}],
                "nested": {"bogus": object()},
            },
            "text": "swing",
            "locked": True,
            "hidden": True,
            "visibility": {"ranges": [{"from": 1, "to": 5}]},
        }
        store = ws._store({"workspaces": [{
            "id": "w",
            "charts": [{"id": "c1", "drawings": [
                payload,
                {"id": "bad-kind", "kind": "script", "points": [{"time": 1, "price": 2}]},
                {"id": "no-points", "kind": "trend-line", "points": []},
                {"id": "bad-point", "kind": "trend-line", "points": [{"time": "x", "price": 2}]},
                {"id": "brush", "kind": "brush", "points": [
                    {"time": 1700000000 + i, "price": 100 + i} for i in range(600)
                ]},
            ]}],
            "syncGroups": [],
        }]})
        drawings = store["workspaces"][0]["charts"][0]["drawings"]
        self.assertEqual([d["id"] for d in drawings], ["dw-1", "brush"])
        fib = drawings[0]
        self.assertEqual(fib["kind"], "fib-retracement")
        self.assertEqual(fib["points"][1]["price"], 120.25)
        self.assertEqual(fib["style"]["color"], "#f23645")
        self.assertEqual(fib["style"]["levels"][0]["coeff"], 0.618)
        self.assertNotIn("nested", fib["style"])
        self.assertEqual(fib["text"], "swing")
        self.assertTrue(fib["locked"] and fib["hidden"])
        self.assertEqual(fib["visibility"]["ranges"][0]["to"], 5)
        self.assertEqual(len(drawings[1]["points"]), ws.MAX_DRAWING_POINTS)

    def test_new_charts_start_without_studies(self):
        store = ws.default_store()
        chart = store["workspaces"][0]["charts"][0]
        self.assertEqual(chart["indicators"], [])
        self.assertTrue(chart["showVolume"])

    def test_alerts_are_validated_and_survive_a_round_trip(self):
        payload = {
            "version": 1,
            "active": "w1",
            "alerts": [
                {"id": "a-1", "exchange": "binance", "market": "spot",
                 "symbol": "btc/usdt", "timeframe": "5m",
                 "price": 69000.5, "condition": "crossing-up",
                 "frequency": "repeating", "note": "  breakout  ", "enabled": True,
                 "createdAt": 1700000000000},
                {"id": "a-2", "exchange": "bybit", "market": "nonsense",
                 "symbol": "eth/usdt", "price": 3800, "condition": "nope",
                 "frequency": "nope"},
                {"id": "a-3", "exchange": "nowhere", "symbol": "BTC/USDT", "price": 10},
                {"id": "a-4", "exchange": "binance", "symbol": "SOL/USDT", "price": 0},
                {"id": "a-1", "exchange": "binance", "symbol": "XRP/USDT", "price": 2},
                {"id": "bad id!", "exchange": "okx", "symbol": "SOL/USDT", "price": 190},
                "junk",
            ],
            "workspaces": [{"id": "w1", "name": "One", "charts": []}],
        }
        saved = ws.save_store(payload)
        loaded = ws.load_store()
        self.assertEqual(saved, loaded)
        alerts = loaded["alerts"]
        self.assertEqual(len(alerts), 3)
        first, second, third = alerts
        self.assertEqual(first["symbol"], "BTC/USDT")
        self.assertEqual(first["condition"], "crossing-up")
        self.assertEqual(first["frequency"], "repeating")
        self.assertEqual(first["note"], "breakout")
        self.assertEqual(first["timeframe"], "5m")
        self.assertEqual(second["market"], "spot")
        self.assertEqual(second["condition"], "crossing")
        self.assertEqual(second["frequency"], "once")
        self.assertEqual(second["enabled"], True)
        self.assertTrue(third["id"].startswith("a-"))
        self.assertEqual(third["exchange"], "okx")

    def test_alerts_default_to_an_empty_list(self):
        self.assertEqual(ws.default_store()["alerts"], [])
        store = ws._store({"workspaces": [{"id": "w", "charts": []}]})
        self.assertEqual(store["alerts"], [])


    def test_atomic_write_leaves_no_temp_file(self):
        ws.save_store(ws.default_store())
        leftovers = [p for p in Path(self.tmp.name).parent.glob("*.tmp*")]
        self.assertEqual(leftovers, [])


if __name__ == "__main__":
    unittest.main()
