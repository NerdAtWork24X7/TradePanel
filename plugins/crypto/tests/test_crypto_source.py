"""Market-data tests: naming, precision, pagination and search, without a network."""

from __future__ import annotations

import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crypto_source import (  # noqa: E402
    CryptoSource,
    PluginError,
    _Loaded,
    _forming,
    _merge_spans,
    _missing_spans,
    _precision_scale,
)


def market(base: str, quote: str, kind: str = "spot", *, precision=2, mode=2, settle: str | None = None) -> dict:
    return {
        "symbol": f"{base}/{quote}" + (f":{settle}" if kind == "swap" else ""),
        "base": base,
        "quote": quote,
        "spot": kind == "spot",
        "swap": kind == "swap",
        "linear": kind == "swap",
        "inverse": False,
        "active": True,
        "settle": settle or quote,
        "precision": {"price": precision},
        "precisionMode": mode,
    }


class FakeClient:
    def __init__(self, rows: list[list[float]] | None = None):
        self.rows = rows or []
        self.calls: list[tuple] = []

    def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None):
        self.calls.append((symbol, timeframe, since, limit))
        out = [r for r in self.rows if since is None or r[0] >= since]
        return out[: limit or len(out)]

    def fetch_ticker(self, symbol):
        return {"bid": 1.0, "ask": 1.1, "last": 1.05}

    def fetch_tickers(self, symbols):
        return {s: {"last": 1.05} for s in symbols}


def loaded(venue: str, kind: str, markets: list[dict], client=None) -> _Loaded:
    client = client or FakeClient()
    client.markets = {m["symbol"]: m for m in markets}
    item = _Loaded(client=client)
    for m in markets:
        from crypto_source import Market

        ticker = f"{m['base']}/{m['quote']}" + (".P" if kind == "swap" else "")
        row = Market(venue, "fake", kind, ticker, m["symbol"], m)
        item.by_ticker[ticker] = row
        item.by_ccxt[m["symbol"]] = row
    return item


class NamingTests(unittest.TestCase):
    def test_spot_and_perp_names_do_not_collide(self):
        source = CryptoSource(log=lambda _m: None)
        item = loaded("BINANCE", "swap", [market("BTC", "USDT", "swap", settle="USDT")])
        source._loaded[("BINANCE", "swap")] = item
        self.assertIn("BTC/USDT.P", item.by_ticker)
        self.assertEqual(item.by_ticker["BTC/USDT.P"].symbol, "BTC/USDT:USDT")

    def test_index_prefers_usdt_margined_contract(self):
        source = CryptoSource(log=lambda _m: None)
        # Both contracts are BTC/USDT for the plugin; the USDT-margined one wins.
        markets = {
            "BTC/USDC:USDC": market("BTC", "USDT", "swap", settle="USDC"),
            "BTC/USDT:USDT": market("BTC", "USDT", "swap", settle="USDT"),
        }
        client = FakeClient()
        client.markets = markets
        indexed = source._index("BYBIT", "swap", "bybit", client)
        self.assertEqual(len(indexed.by_ticker), 1)
        self.assertEqual(indexed.by_ticker["BTC/USDT.P"].symbol, "BTC/USDT:USDT")

    def test_unknown_exchange_is_a_bad_parameter(self):
        source = CryptoSource(log=lambda _m: None)
        with self.assertRaises(PluginError) as caught:
            source._market("NOPE:BTC/USDT")
        self.assertEqual(caught.exception.code, -32602)


class PrecisionTests(unittest.TestCase):
    def test_decimal_places(self):
        self.assertEqual(_precision_scale({"precision": {"price": 2}, "precisionMode": 2}), 100)

    def test_tick_size(self):
        self.assertEqual(_precision_scale({"precision": {"price": 0.0001}, "precisionMode": 4}), 10_000)

    def test_a_tick_size_without_a_mode(self):
        # Hyperliquid: precision.price = 1.0 is a whole-unit tick, not one decimal place.
        self.assertEqual(_precision_scale({"precision": {"price": 1.0}, "precisionMode": None}), 1)
        self.assertEqual(_precision_scale({"precision": {"price": 0.01}}), 100)

    def test_legacy_limits_fallback(self):
        self.assertEqual(
            _precision_scale({"precision": {"price": None}, "limits": {"price": {"min": 0.5}}}),
            2,
        )

    def test_bad_precision_does_not_divide_by_zero(self):
        self.assertEqual(_precision_scale({"precision": {"price": 0}, "precisionMode": 4}), 1)
        self.assertEqual(_precision_scale({"precision": {"price": 0}, "precisionMode": None}), 1)


class BarsTests(unittest.TestCase):
    def setUp(self):
        self.source = CryptoSource(log=lambda _m: None)
        self.client = FakeClient()
        self.source._loaded[("BINANCE", "spot")] = loaded("BINANCE", "spot", [market("BTC", "USDT")], self.client)

    def test_returns_newest_count_back_and_filters_window(self):
        now = 1_700_000_000
        rows = [[(now - i * 60) * 1000, 1, 2, 0.5, 1.5, 10] for i in range(50)][::-1]
        self.client.rows = rows
        result = self.source.bars("BINANCE:BTC/USDT", "1", now - 600, now, 5)
        self.assertEqual(len(result), 5)
        self.assertEqual(result[-1][0], float(now))
        self.assertEqual(result[0][0], float(now - 4 * 60))

    def test_empty_history_is_an_empty_list(self):
        self.client.rows = []
        self.assertEqual(self.source.bars("BINANCE:BTC/USDT", "5", 0, 10, 10), [])

    def test_pagination_stops_at_the_window(self):
        now = 1_700_000_000
        rows = [[(now - i * 60) * 1000, 1, 2, 0.5, 1.5, 10] for i in range(3)][::-1]
        self.client.rows = rows
        self.source.bars("BINANCE:BTC/USDT", "1", now - 600, now, 10)
        self.assertEqual(len(self.client.calls), 1)
        self.assertEqual(self.client.calls[0][1], "1m")

    def test_does_not_ask_for_a_page_after_the_window(self):
        # Hyperliquid answers 500 when since > until: a last bar just before `to` must end
        # the pagination instead of asking for the next (future) page.
        now = 1_700_000_000

        class Guarded(FakeClient):
            def fetch_ohlcv(self, symbol, timeframe, since=None, limit=None):
                self.calls.append((symbol, timeframe, since, limit))
                if since is not None and since > now * 1000:
                    raise RuntimeError("since after until")
                return [[(now - 1) * 1000, 1, 2, 0.5, 1.5, 10]]

        client = Guarded()
        self.source._loaded[("BINANCE", "spot")] = loaded("BINANCE", "spot", [market("BTC", "USDT")], client)
        result = self.source.bars("BINANCE:BTC/USDT", "1", now - 600, now, 10)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(client.calls), 1)

    def test_unsupported_resolution(self):
        with self.assertRaises(PluginError):
            self.source.bars("BINANCE:BTC/USDT", "7", 0, 1, 1)


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.source = CryptoSource(log=lambda _m: None)
        item = loaded("BINANCE", "spot", [market("BTC", "USDT"), market("ETH", "USDT")])
        item.by_ticker.update({
            t: m for t, m in loaded("BINANCE", "swap", [
                market("BTC", "USDT", "swap", settle="USDT"),
                market("ETH", "USDT", "swap", settle="USDT"),
            ]).by_ticker.items()
        })
        self.source._loaded[("BINANCE", "spot")] = item
        # Every other venue is "loaded and empty": the search must not reach the network here.
        from crypto_source import VENUES

        for venue, kinds in VENUES.items():
            for kind in kinds:
                self.source._loaded.setdefault((venue, kind), _Loaded(client=FakeClient()))

    def test_search_names_whole_symbols(self):
        rows = self.source.search("btc")
        tickers = {r["ticker"] for r in rows}
        self.assertIn("BINANCE:BTC/USDT", tickers)
        self.assertIn("BINANCE:BTC/USDT.P", tickers)
        self.assertTrue(all(r["type"] == "crypto" for r in rows))

    def test_empty_query_lists_majors(self):
        rows = self.source.search("")
        self.assertEqual({r["ticker"] for r in rows}, {
            "BINANCE:BTC/USDT", "BINANCE:BTC/USDT.P",
            "BINANCE:ETH/USDT", "BINANCE:ETH/USDT.P",
        })

    def test_refresh_drops_the_symbol_caches(self):
        self.source.search("btc")
        self.assertTrue(self.source._search_cache)
        self.assertTrue(self.source._loaded)
        self.assertEqual(self.source.refresh_symbols(), {"reloaded": True})
        self.assertEqual(self.source._search_cache, {})
        self.assertEqual(self.source._loaded, {})
        self.assertEqual(self.source._failed, {})


class BarsCacheTests(unittest.TestCase):
    """Repeated history reads reuse fetched spans; the live edge stays live."""

    def setUp(self):
        import crypto_source

        self.module = crypto_source
        self.source = CryptoSource(log=lambda _m: None)
        self.client = FakeClient()
        self.source._loaded[("BINANCE", "spot")] = loaded("BINANCE", "spot", [market("BTC", "USDT")], self.client)

    def tearDown(self):
        self.source._bar_pool.shutdown(wait=False, cancel_futures=True)

    def rows_around(self, end: int, seconds: int):
        return [[(end - i * 60) * 1000, 1, 2, 0.5, 1.5, 10] for i in range(seconds // 60)][::-1]

    def test_a_historical_window_is_fetched_once(self):
        end = 1_700_000_000
        self.client.rows = self.rows_around(end, 600)
        first = self.source.bars("BINANCE:BTC/USDT", "1", end - 300, end, 10)
        calls = len(self.client.calls)
        second = self.source.bars("BINANCE:BTC/USDT", "1", end - 300, end, 10)
        self.assertEqual(first, second)
        self.assertEqual(len(self.client.calls), calls, "the cached window was asked again")

    def test_scroll_back_only_reads_the_missing_part(self):
        end = 1_700_000_000
        self.client.rows = self.rows_around(end, 1200)
        self.source.bars("BINANCE:BTC/USDT", "1", end - 600, end, 100)
        calls = len(self.client.calls)
        older = self.source.bars("BINANCE:BTC/USDT", "1", end - 1200, end - 601, 100)
        self.assertEqual(len(older), 9)
        self.assertGreater(len(self.client.calls), calls)
        self.assertEqual(older[0][0], float(end - 1140))

    def test_live_edge_is_re_read_when_stale(self):
        end = int(time.time())
        self.client.rows = self.rows_around(end, 600)
        old_ttl = self.module.LIVE_BARS_TTL
        self.module.LIVE_BARS_TTL = 0.0
        try:
            self.source.bars("BINANCE:BTC/USDT", "1", end - 300, end, 10)
            calls = len(self.client.calls)
            self.source.bars("BINANCE:BTC/USDT", "1", end - 300, end, 10)
            self.assertGreater(len(self.client.calls), calls)
        finally:
            self.module.LIVE_BARS_TTL = old_ttl

    def test_cached_history_returns_the_live_forming_bar(self):
        now = int(time.time())
        bucket = now // 60 * 60
        self.client.rows = self.rows_around(bucket, 600)
        self.source._subscribed = {"BINANCE:BTC/USDT"}
        self.source._bars["BINANCE:BTC/USDT"] = {
            "minute": [bucket, 1.0, 1.2, 0.9, 1.1, 10],
            "day": None,
            "minute_at": 0.0,
            "day_at": 0.0,
            "minute_busy": False,
            "day_busy": False,
            "last": 9.9,
        }
        rows = self.source.bars("BINANCE:BTC/USDT", "1", now - 300, now, 10)
        self.assertEqual(rows[-1][4], 9.9, "the cached copy of the forming bar won over the quote")

    def test_spans_cover_every_gap_once(self):
        self.assertEqual(_missing_spans([(0, 10), (20, 30)], 5, 25), [(10, 20)])
        self.assertEqual(_merge_spans([(0, 10), (10, 20), (5, 15)]), [(0, 20)])


class SelectedSymbolTests(unittest.TestCase):
    def test_only_the_subscribed_tickers_are_streamed(self):
        source = CryptoSource(log=lambda _m: None)
        source._loaded[("BINANCE", "spot")] = loaded("BINANCE", "spot", [market("BTC", "USDT"), market("ETH", "USDT")])
        source._subscribed = {"BINANCE:BTC/USDT"}
        seen = []
        source._emit = seen.append
        btc = source._market("BINANCE:BTC/USDT")
        eth = source._market("BINANCE:ETH/USDT")
        source._quote("BINANCE:ETH/USDT", eth, 2.0, 1_700_000_000)
        self.assertEqual(seen, [], "a quote for an unselected symbol was pushed")
        source._quote("BINANCE:BTC/USDT", btc, 1.0, 1_700_000_000)
        # One immediate push, then one when the bar refresh lands.
        self.assertTrue(seen)
        self.assertEqual({q["ticker"] for q in seen}, {"BINANCE:BTC/USDT"})
        source._bar_pool.shutdown(wait=False, cancel_futures=True)

    def test_quote_stream_keeps_only_resolved_selections(self):
        from quote_stream import QuoteStream

        source = CryptoSource(log=lambda _m: None)
        source._loaded[("BINANCE", "spot")] = loaded("BINANCE", "spot", [market("BTC", "USDT")])
        stream = QuoteStream(
            {"BINANCE": {"spot": ("binance", "spot")}},
            source._stream_market,
            source._quote,
            lambda _m: None,
        )
        stream.set_tickers(["BINANCE:BTC/USDT", "BINANCE:NOPE/USDT"])
        wanted = stream._resolve_all(stream._requested)
        self.assertEqual(list(wanted), [("BINANCE", "spot")])
        self.assertEqual(list(wanted[("BINANCE", "spot")]), ["BINANCE:BTC/USDT"])


class FormingBarTests(unittest.TestCase):
    def test_starts_a_new_bucket_at_the_boundary(self):
        cached = [120, 10, 12, 9, 11, 100]
        moved = _forming(cached, 10.5, 60, 125)
        self.assertEqual(moved, [120, 10, 12, 9, 10.5, 100])
        fresh = _forming(cached, 13, 60, 185)
        self.assertEqual(fresh[0], 180)
        self.assertEqual(fresh[1], 13)

    def test_bucket_is_utc(self):
        now = 1_700_000_123
        bar = _forming(None, 5, 86_400, now)
        self.assertEqual(bar[0], now // 86_400 * 86_400)


if __name__ == "__main__":
    unittest.main()
