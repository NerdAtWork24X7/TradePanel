"""Datafeed tests for the NSE plugin: no network is used — HTTP is injected."""

from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from nse_source import CACHE_TTL, CATALOG, NseSource, PluginError  # noqa: E402


def chart(rows, meta=None, error=None):
    if error:
        return {"chart": {"error": error, "result": []}}
    times = [row[0] for row in rows]
    return {
        "chart": {
            "error": None,
            "result": [{
                "meta": meta or {},
                "timestamp": times,
                "indicators": {"quote": [{
                    "open": [row[1] for row in rows],
                    "high": [row[2] for row in rows],
                    "low": [row[3] for row in rows],
                    "close": [row[4] for row in rows],
                    "volume": [row[5] for row in rows],
                }]},
            }],
        }
    }


def symbol_csv(rows):
    return "Symbol,Series,Security Name\n" + "".join(f"{ticker},EQ,{name}\n" for ticker, name in rows)


class FakeOpener:
    """Answers by URL fragment, recording every request."""

    def __init__(self, symbols=None):
        self.answers = {"/sec_list.csv": symbol_csv(symbols if symbols is not None else CATALOG[:20])}
        self.calls = []

    def add(self, fragment, payload):
        self.answers[fragment] = payload

    def __call__(self, request, timeout=None):
        url = request.full_url
        self.calls.append(url)
        for fragment, payload in self.answers.items():
            if fragment in url:
                if isinstance(payload, Exception):
                    raise payload
                if isinstance(payload, str):
                    return io.BytesIO(payload.encode("utf-8"))
                return io.BytesIO(json.dumps(payload).encode("utf-8"))
        return io.BytesIO(json.dumps(chart([])).encode("utf-8"))


class SourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.cache = Path(self.temp.name) / "symbols.json"
        self.http = FakeOpener()
        self.source = NseSource(opener=self.http, clock=lambda: 1_700_000_000.0, cache_path=self.cache)

    def tearDown(self):
        self.temp.cleanup()

    def test_ticker_accepts_whole_and_bare_names_and_rejects_injection(self):
        self.assertEqual(self.source._ticker("nse:reliance"), "RELIANCE")
        self.assertEqual(self.source._ticker(" RELIANCE.NS "), "RELIANCE")
        self.assertEqual(self.source._ticker("M&M"), "M&M")
        for bad in ("", "NSE:", "../etc/passwd", "REL IANCE", "A:B"):
            with self.subTest(bad=bad), self.assertRaises(PluginError):
                self.source._ticker(bad)

    def test_search_from_the_symbol_list_ranks_an_exact_match_first(self):
        self.http.answers["/sec_list.csv"] = symbol_csv([
            ("RELIND", "Reliance Industrial Infrastructure"),
            ("RELIANCE", "Reliance Industries Limited"),
        ])
        rows = self.source.search("reliance")
        self.assertEqual(rows[0]["ticker"], "RELIANCE")
        self.assertEqual(rows[0]["description"], "Reliance Industries")
        self.assertEqual([r["ticker"] for r in rows], ["RELIANCE", "RELIND"])
        self.assertTrue(all(r["type"] == "stock" for r in rows))
        # A cached typeahead must not hit either endpoint again.
        calls = len(self.http.calls)
        self.source.search("RELIANCE")
        self.assertEqual(len(self.http.calls), calls)

    def test_an_unlisted_symbol_asks_the_live_index_and_ignores_other_exchanges(self):
        self.http.add("/v1/finance/search", {"quotes": [
            {"symbol": "ZOMATO.NS", "shortname": "Zomato", "quoteType": "EQUITY"},
            {"symbol": "ZOMATO.BO", "shortname": "Wrong exchange", "quoteType": "EQUITY"},
        ]})
        rows = self.source.search("ZOMATO")
        self.assertEqual([r["ticker"] for r in rows], ["ZOMATO"])

    def test_search_falls_back_to_bundled_symbols_when_both_sources_fail(self):
        self.http.answers["/sec_list.csv"] = HTTPError("url", 503, "Unavailable", None, None)
        self.http.add("/v1/finance/search", HTTPError("url", 429, "Too Many Requests", None, None))
        rows = self.source.search("tcs")
        self.assertEqual(rows[0]["ticker"], "TCS")
        self.assertEqual(rows[0]["description"], "Tata Consultancy Services")
        self.assertEqual(self.source.search("not a symbol"), [])

    def test_search_by_company_name_uses_the_symbol_list(self):
        rows = self.source.search("Reliance Industries")
        self.assertEqual(rows[0]["ticker"], "RELIANCE")

    def test_empty_search_returns_popular_symbols_without_http(self):
        rows = self.source.search("")
        self.assertEqual([r["ticker"] for r in rows[:3]], ["RELIANCE", "TCS", "HDFCBANK"])
        self.assertTrue(all("/v1/finance/search" not in call for call in self.http.calls))

    def test_the_exchange_name_lists_its_symbols(self):
        self.assertEqual([r["ticker"] for r in self.source.search("NSE")[:3]], ["RELIANCE", "TCS", "HDFCBANK"])

    def test_symbol_list_is_written_to_disk_and_reused_by_a_new_plugin(self):
        self.source.search("TCS")
        self.assertTrue(self.cache.exists())
        saved = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertEqual(saved["version"], 1)
        self.assertGreater(len(saved["symbols"]), 10)
        calls = len(self.http.calls)
        other = NseSource(opener=self.http, clock=lambda: 1_700_000_000.0, cache_path=self.cache)
        self.assertEqual(other.search("TCS")[0]["ticker"], "TCS")
        # The second plugin loaded the disk cache: no symbol-list request was made.
        self.assertEqual(len(self.http.calls), calls)

    def test_a_stale_symbol_list_is_refreshed(self):
        self.source.search("TCS")
        fresh = FakeOpener([("NEWLISTING", "Recently listed company")])
        later = 1_700_000_000.0 + CACHE_TTL + 1
        source = NseSource(opener=fresh, clock=lambda: later, cache_path=self.cache)
        self.assertEqual(source.search("NEWLISTING")[0]["ticker"], "NEWLISTING")
        self.assertIn("sec_list.csv", fresh.calls[0])

    def test_refresh_rebuilds_a_fresh_cache_on_demand(self):
        self.source.search("TCS")
        fresh = FakeOpener([("NEWLISTING", "Recently listed company")])
        source = NseSource(opener=fresh, clock=lambda: 1_700_000_000.0, cache_path=self.cache)
        self.assertEqual(source.refresh_symbols(), {"symbols": 1})
        self.assertIn("sec_list.csv", fresh.calls[0])
        self.assertEqual(source.search("NEWLISTING")[0]["ticker"], "NEWLISTING")

    def test_a_corrupt_cache_is_replaced_instead_of_serving_garbage(self):
        self.cache.write_text("{not json", encoding="utf-8")
        rows = self.source.search("RELIANCE")
        self.assertEqual(rows[0]["ticker"], "RELIANCE")
        self.assertEqual(json.loads(self.cache.read_text(encoding="utf-8"))["version"], 1)

    def test_symbol_info_uses_metadata_and_keeps_nse_sessions(self):
        self.http.add("RELIANCE.NS", chart([], {
            "longName": "Reliance Industries Limited", "currency": "INR",
        }))
        info = self.source.symbol_info("NSE:RELIANCE")
        self.assertEqual(info["description"], "Reliance Industries Limited")
        self.assertEqual(info["type"], "stock")
        self.assertEqual(info["timezone"], "Asia/Kolkata")
        self.assertEqual(info["session"], "0915-1530:23456")
        self.assertEqual(info["pricescale"], 100)
        self.assertIn("1D", info["intervals"])

    def test_bars_skip_invalid_rows_honour_the_window_and_cap_count(self):
        rows = [
            [100, 10, 12, 9, 11, 100],
            [160, None, 12, 9, 11, 100],  # a null OHLC row is dropped
            [220, 11, 13, 10, 12, 200],
            [280, 12, 14, 11, 13, 300],
        ]
        self.http.add("RELIANCE.NS", chart(rows))
        bars = self.source.bars("RELIANCE", "5", 50, 250, 10)
        self.assertEqual(bars, [[100, 10, 12, 9, 11, 100], [220, 11, 13, 10, 12, 200]])
        self.assertIn("interval=5m", self.http.calls[0])
        self.assertIn("period1=50", self.http.calls[0])
        self.assertIn("period2=251", self.http.calls[0])
        self.assertEqual(self.source.bars("RELIANCE", "5", 50, 250, 1), [[220, 11, 13, 10, 12, 200]])
        with self.assertRaises(PluginError):
            self.source.bars("RELIANCE", "13", 0, 100, 10)

    def test_daily_bars_start_at_midnight_in_the_exchange_timezone(self):
        self.http.add("TCS.NS", chart([[1_699_994_700, 1, 2, 0.5, 1.5, None]]))  # 09:15 IST
        self.assertEqual(
            self.source.bars("TCS", "1D", 0, 1_699_999_999, 5),
            [[1_699_986_600, 1, 2, 0.5, 1.5, 0]],  # 00:00 IST
        )
        self.assertIn("interval=1d", self.http.calls[0])

    def test_chart_error_is_reported_instead_of_returning_empty_history(self):
        self.http.add("TCS.NS", chart([], error={"code": "Not Found", "description": "No data"}))
        with self.assertRaisesRegex(PluginError, "No data"):
            self.source.bars("TCS", "1D", 0, 200, 5)

    def test_quote_builds_a_snapshot_with_minute_and_day_bars(self):
        rows = [
            [1_699_996_800, 100, 102, 99, 101, 500],
            [1_699_997_100, 101, 103, 100, 102, 700],
        ]
        meta = {
            "regularMarketPrice": 102.5,
            "regularMarketTime": 1_699_997_100,
            "chartPreviousClose": 99.5,
            "regularMarketDayOpen": 100,
            "regularMarketDayHigh": 103,
            "regularMarketDayLow": 99,
            "regularMarketDayVolume": 1200,
        }
        self.http.add("RELIANCE.NS", chart(rows, meta))
        quote = self.source.quote("NSE:RELIANCE")
        self.assertEqual(quote["ticker"], "RELIANCE")
        self.assertEqual(quote["price"], 102.5)
        self.assertEqual(quote["prevClose"], 99.5)
        self.assertEqual(quote["minute"], rows[-1])
        self.assertEqual(quote["day"], [1_699_986_600, 100, 103, 99, 1200])

    def test_quote_without_intraday_rows_still_has_a_forming_bar(self):
        self.http.add("TCS.NS", chart([], {"regularMarketPrice": 42.0, "regularMarketTime": 1_699_997_100}))
        quote = self.source.quote("TCS")
        self.assertIsNotNone(quote)
        self.assertEqual(quote["minute"][4], 42.0)
        self.assertEqual(quote["day"][1], 42.0)

    def test_subscription_and_refresh_settings(self):
        self.source.configure({"pollSeconds": "1"})
        self.assertEqual(self.source._poll_seconds, 5.0)
        self.source.configure({"pollSeconds": "90"})
        self.assertEqual(self.source._poll_seconds, 60.0)
        emitted = []
        self.source.start(emitted.append)
        self.source.subscribe(["RELIANCE", "NSE:TCS.NS"])
        self.assertEqual(self.source._subs, {"RELIANCE", "TCS"})
        self.source.stop()


if __name__ == "__main__":
    unittest.main()
