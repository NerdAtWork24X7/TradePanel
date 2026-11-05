"""Offline tests for Core.market_data (parsers, aggregation, caching, symbols).

Run: .venv/bin/python -m unittest discover -s tests -p 'test_*.py'
No network access is used: ``_get_json`` is monkeypatched per test.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path
import unittest
from unittest import mock

from backend.Core import market_data as md


class AggregationTests(unittest.TestCase):
    def test_week_buckets_start_monday_utc(self):
        # 2024-01-03 (Wed) and 2024-01-07 (Sun) belong to the same ISO week
        # starting 2024-01-01 (Mon); 2024-01-08 starts a new one.
        candles = [
            {"time": 1704240000, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 10},
            {"time": 1704585600, "open": 1.5, "high": 3, "low": 1, "close": 2, "volume": 5},
            {"time": 1704672000, "open": 2, "high": 4, "low": 1.8, "close": 3, "volume": 2},
        ]
        out = md._aggregate(candles, "week")
        self.assertEqual([c["time"] for c in out], [1704067200, 1704672000])
        self.assertEqual(out[0]["open"], 1)
        self.assertEqual(out[0]["high"], 3)
        self.assertEqual(out[0]["low"], 0.5)
        self.assertEqual(out[0]["close"], 2)
        self.assertEqual(out[0]["volume"], 15)
        self.assertEqual(out[1]["high"], 4)

    def test_month_buckets_are_calendar_months(self):
        candles = [
            {"time": 1704067200, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 1},   # Jan 1
            {"time": 1706745600, "open": 1.5, "high": 3, "low": 1, "close": 2.5, "volume": 2}, # Feb 1
        ]
        out = md._aggregate(candles, "month")
        self.assertEqual(len(out), 2)
        self.assertEqual(out[1]["time"], 1706745600)

    def test_aggregation_factors_are_derived_from_native_intervals(self):
        agg = md._CAPABILITIES["coinbase"]["spot"][1]
        self.assertEqual(agg["3m"], ("1m", 3))
        self.assertEqual(agg["30m"], ("15m", 2))
        self.assertEqual(agg["4h"], ("1h", 4))
        self.assertEqual(agg["1w"], ("1d", "week"))
        self.assertEqual(agg["1M"], ("1d", "month"))
        # Native intervals never appear in the aggregation map.
        self.assertNotIn("1h", agg)
        # Coinbase does not list 8h; no source interval divides it.
        self.assertNotIn("8h", md._CAPABILITIES["coinbase"]["spot"][0])

    def test_all_exchanges_offer_the_required_timeframes(self):
        required = set(md.TIMEFRAMES)
        for exchange in ("binance", "bybit", "okx", "coinbase", "kraken",
                         "kucoin", "gate", "bitget", "hyperliquid"):
            for market, (timeframes, _) in md._CAPABILITIES[exchange].items():
                self.assertEqual(set(timeframes), required,
                                 f"{exchange}/{market} missing intervals")


class ParserTests(unittest.TestCase):
    def _page(self, provider, market, native, tf, payload, limit=200, end_time=None):
        with mock.patch.object(md, "_get_json", return_value=payload), \
             mock.patch.object(md, "_throttle", lambda *a, **k: None):
            page, _next = provider._page(market, native, tf, limit, end_time)
        return page

    def test_binance(self):
        payload = [
            [1700000000000, "1.0", "2.0", "0.5", "1.5", "10.0", 0, "0", 0, "0", "0", "0"],
            [1700000300000, "1.5", "2.5", "1.0", "2.0", "11.0", 0, "0", 0, "0", "0", "0"],
        ]
        page = self._page(md.BinanceProvider(), "spot", "BTCUSDT", "5m", payload)
        self.assertEqual(len(page), 2)
        self.assertEqual(page[0]["time"], 1700000000)
        self.assertEqual(page[1]["close"], 2.0)

    def test_bybit_is_ascending_after_parse(self):
        payload = {"retCode": 0, "result": {"list": [
            ["1700000300000", "1.5", "2.5", "1.0", "2.0", "11.0"],
            ["1700000000000", "1.0", "2.0", "0.5", "1.5", "10.0"],
        ]}}
        page = self._page(md.BybitProvider(), "spot", "BTCUSDT", "5m", payload)
        self.assertEqual([c["time"] for c in page], [1700000000, 1700000300])

    def test_okx_uses_base_volume_per_market(self):
        payload = {"code": "0", "data": [
            ["1700000000000", "1", "2", "0.5", "1.5", "10", "20", "30", "0"],
        ]}
        spot = self._page(md.OkxProvider(), "spot", "BTC-USDT", "5m", payload)
        swap = self._page(md.OkxProvider(), "futures", "BTC-USDT-SWAP", "5m", payload)
        self.assertEqual(spot[0]["volume"], 10)
        self.assertEqual(swap[0]["volume"], 20)   # volCcy = base volume

    def test_coinbase_field_order(self):
        payload = [[1700000000, 0.5, 2.0, 1.0, 1.5, 10.0]]
        page = self._page(md.CoinbaseProvider(), "spot", "BTC-USD", "5m", payload)
        self.assertEqual(page[0], {"time": 1700000000, "open": 1.0, "high": 2.0,
                                   "low": 0.5, "close": 1.5, "volume": 10.0})

    def test_kraken_result_key_and_vwap_volume(self):
        payload = {"error": [], "result": {"XXBTZUSD": [
            [1700000000, "1.0", "2.0", "0.5", "1.5", "1.25", "10.0", 5],
        ], "last": 1700000000}}
        page = self._page(md.KrakenProvider(), "spot", "XBTUSD", "5m", payload)
        self.assertEqual(page[0]["volume"], 10.0)
        self.assertEqual(page[0]["close"], 1.5)

    def test_kucoin_spot_ohlc_order(self):
        payload = {"code": "200000", "data": [
            ["1700000000", "1.0", "1.5", "2.0", "0.5", "10.0", "15.0"],
        ]}
        page = self._page(md.KucoinProvider(), "spot", "BTC-USDT", "5m", payload)
        self.assertEqual(page[0], {"time": 1700000000, "open": 1.0, "high": 2.0,
                                   "low": 0.5, "close": 1.5, "volume": 10.0})

    def test_kucoin_futures_milliseconds(self):
        payload = {"code": "200000", "data": [
            [1700000000000, 1.0, 2.0, 0.5, 1.5, 10.0, 15.0],
        ]}
        page = self._page(md.KucoinProvider(), "futures", "XBTUSDTM", "5m", payload)
        self.assertEqual(page[0]["time"], 1700000000)
        self.assertEqual(page[0]["high"], 2.0)

    def test_gate_spot_column_order(self):
        payload = [["1700000000", "999999", "1.5", "2.0", "0.5", "1.0", "10.0", "true"]]
        page = self._page(md.GateProvider(), "spot", "BTC_USDT", "5m", payload)
        self.assertEqual(page[0], {"time": 1700000000, "open": 1.0, "high": 2.0,
                                   "low": 0.5, "close": 1.5, "volume": 10.0})

    def test_gate_futures_dict_payload(self):
        payload = [{"t": 1700000000, "o": "1.0", "h": "2.0", "l": "0.5", "c": "1.5", "v": 10}]
        page = self._page(md.GateProvider(), "futures", "BTC_USDT", "5m", payload)
        self.assertEqual(page[0]["close"], 1.5)
        self.assertEqual(page[0]["volume"], 10.0)

    def test_bitget(self):
        payload = {"code": "00000", "data": [
            ["1700000000000", "1.0", "2.0", "0.5", "1.5", "10.0", "15.0"],
        ]}
        page = self._page(md.BitgetProvider(), "spot", "BTCUSDT", "5m", payload)
        self.assertEqual(page[0]["close"], 1.5)

    def test_rest_errors_are_surfaced(self):
        with mock.patch.object(md, "_get_json", return_value={"retCode": 10001, "retMsg": "bad"}), \
             mock.patch.object(md, "_throttle", lambda *a, **k: None):
            with self.assertRaises(md.MarketDataError):
                md.BybitProvider()._page("spot", "BTCUSDT", "5m", 10, None)


class PaginationTests(unittest.TestCase):
    def test_provider_fetch_pages_backwards_and_dedupes(self):
        class Fake(md.Provider):
            id, name = "fake", "Fake"
            markets = ("spot",)
            native = {"spot": {"5m": "5m"}}
            calls = 0

            def _page(self, market, native_symbol, tf, limit, end_time):
                Fake.calls += 1
                end = end_time or 1_000_000
                page_limit = min(limit, 100)
                rows = [{"time": t, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 1}
                        for t in range(end - page_limit * 60 + 60, end + 1, 60)]
                rows = [r for r in rows if r["time"] > 0]
                return rows, (rows[0]["time"] - 1 if rows else None)

        page = Fake().fetch("spot", "X", "5m", 150, None)
        self.assertGreaterEqual(Fake.calls, 2)
        self.assertEqual(len(page), 150)
        self.assertTrue(all(page[i]["time"] < page[i + 1]["time"] for i in range(len(page) - 1)))

    def test_provider_fetch_stops_when_exchange_repeats(self):
        class Stuck(md.Provider):
            id, name = "stuck", "Stuck"
            markets = ("spot",)
            native = {"spot": {"5m": "5m"}}

            def _page(self, market, native_symbol, tf, limit, end_time):
                return ([{"time": 100, "open": 1, "high": 2, "low": 0.5, "close": 1.5, "volume": 1}], 99)

        page = Stuck().fetch("spot", "X", "5m", 10, None)
        self.assertEqual(len(page), 1)


class SymbolAndCacheTests(unittest.TestCase):
    def setUp(self):
        md.clear_cache()
        self.tmp = tempfile.NamedTemporaryFile(suffix=".json", delete=False)
        self.tmp.close()
        self.patches = [
            mock.patch.object(md, "CATALOG_FILE", Path(self.tmp.name)),
            mock.patch.object(md, "_catalog_disk", None),
            mock.patch.object(md, "_catalog_cache", {}),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        try:
            os.unlink(self.tmp.name)
        except OSError:
            pass

    def test_resolve_and_search(self):
        instruments = [
            md.Instrument("BTC/USDT", "BTCUSDT", "BTC", "USDT"),
            md.Instrument("ETH/USDT", "ETHUSDT", "ETH", "USDT"),
            md.Instrument("BTC/USD", "BTCUSD", "BTC", "USD"),
        ]
        with mock.patch.object(md, "_catalog", return_value=instruments):
            self.assertEqual(md.resolve_symbol("binance", "spot", "btc/usdt").native, "BTCUSDT")
            self.assertEqual(md.resolve_symbol("binance", "spot", "ethusdt").symbol, "ETH/USDT")
            results = md.search_symbols("binance", "spot", "btc")
            self.assertEqual(results[0]["symbol"], "BTC/USDT")
            self.assertTrue(all("BTC" in r["symbol"] for r in results))
            with self.assertRaises(md.MarketDataError):
                md.resolve_symbol("binance", "spot", "NOPE/USDT")

    def test_catalog_falls_back_to_disk_when_exchange_is_down(self):
        rows = [["BTC/USDT", "BTCUSDT", "BTC", "USDT"]]
        with open(self.tmp.name, "w") as f:
            import json
            json.dump({"binance|spot": {"ts": 1, "rows": rows}}, f)
        md._catalog_disk = None
        with mock.patch.object(md.BinanceProvider, "instruments", side_effect=RuntimeError("down")):
            instruments = md._catalog("binance", "spot")
        self.assertEqual(instruments[0].symbol, "BTC/USDT")

    def test_candle_cache_dedupes_and_serves_history(self):
        rows = [{"time": 1700000000 + i * 300, "open": 1, "high": 2, "low": 0.5,
                 "close": 1.5, "volume": 1} for i in range(100)]
        calls = {"n": 0}

        def fake_fetch(*args, **kwargs):
            calls["n"] += 1
            return rows

        with mock.patch.object(md, "_catalog", return_value=[md.Instrument("BTC/USDT", "BTCUSDT", "BTC", "USDT")]), \
             mock.patch.object(md.BinanceProvider, "fetch", side_effect=fake_fetch), \
             mock.patch.object(md, "CANDLE_TTL", 60):
            first = md.fetch_candles("binance", "spot", "BTC/USDT", "5m", limit=50)
            second = md.fetch_candles("binance", "spot", "BTC/USDT", "5m", limit=50)
            history = md.fetch_candles("binance", "spot", "BTC/USDT", "5m", limit=20,
                                       end_time=1700000000 + 40 * 300)
        self.assertEqual(calls["n"], 1)
        self.assertEqual(len(first["candles"]), 50)
        self.assertEqual(second["candles"][-1]["time"], first["candles"][-1]["time"])
        self.assertEqual(history["candles"][-1]["time"], 1700000000 + 40 * 300)
        self.assertLessEqual(len(history["candles"]), 20)

    def test_cache_merges_backfill_pages_without_losing_history(self):
        rows = [{"time": 1700000000 + i * 300, "open": 1, "high": 2, "low": 0.5,
                 "close": 1.5, "volume": 1} for i in range(100)]
        key = ("binance", "spot", "BTCUSDT", "5m")
        md._cache_put(key, rows[:60], None, 300, fetched_at=123.0)
        md._cache_put(key, rows[40:], None, 300, fetched_at=None)
        with md._cache_lock:
            entry = md._candle_cache[key]
        self.assertEqual(len(entry["candles"]), 100)
        self.assertEqual(entry["candles"][0]["time"], rows[0]["time"])
        self.assertEqual(entry["candles"][-1]["time"], rows[-1]["time"])
        self.assertEqual(entry["fetched_at"], 123.0,
                         "a backfill must not refresh the realtime freshness stamp")
        cached = md._cache_get(key, 20, rows[30]["time"])
        self.assertEqual(cached["candles"][-1]["time"], rows[30]["time"])
        self.assertEqual(len(cached["candles"]), 20)

    def test_unsupported_timeframe_raises(self):
        with mock.patch.object(md, "_catalog", return_value=[md.Instrument("BTC/USDT", "BTCUSDT", "BTC", "USDT")]):
            with self.assertRaises(md.MarketDataError):
                md.fetch_candles("coinbase", "spot", "BTC/USD", "8h", limit=10)

    def test_market_support_is_enforced(self):
        with self.assertRaises(md.MarketDataError):
            md.fetch_candles("coinbase", "futures", "BTC/USD", "5m", limit=10)
        with self.assertRaises(md.MarketDataError):
            md.fetch_candles("nope", "spot", "BTC/USDT", "5m", limit=10)


if __name__ == "__main__":
    unittest.main()
