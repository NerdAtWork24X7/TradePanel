"""WebSocket quote selection, with a fake ccxt.pro exchange (no network)."""

from __future__ import annotations

import asyncio
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crypto_source import CryptoSource, _Loaded, Market  # noqa: E402
from quote_stream import QuoteStream  # noqa: E402


class FakeExchange:
    has = {"watchTickers": True}

    def __init__(self, last: float):
        self.last = last
        self.calls: list[list[str]] = []
        self.closed = False

    async def watch_tickers(self, symbols):
        self.calls.append(list(symbols))
        await asyncio.sleep(0.02)
        return {symbol: {"symbol": symbol, "last": self.last} for symbol in symbols}

    async def close(self):
        self.closed = True


def source_with_btc() -> CryptoSource:
    source = CryptoSource(log=lambda _m: None)
    market = Market("BINANCE", "binance", "spot", "BTC/USDT", "BTC/USDT", {
        "base": "BTC", "quote": "USDT", "spot": True,
    })
    source._loaded[("BINANCE", "spot")] = _Loaded(
        client=None, by_ticker={"BTC/USDT": market}, by_ccxt={"BTC/USDT": market},
    )
    source._subscribed = {"BINANCE:BTC/USDT"}
    now = time.time()
    source._bars["BINANCE:BTC/USDT"] = {
        "minute": None, "day": None,
        "minute_at": now, "day_at": now,
        "minute_busy": False, "day_busy": False, "last": None,
    }
    return source


class QuoteStreamTests(unittest.TestCase):
    def test_streams_the_selected_ticker_and_skips_others(self):
        source = source_with_btc()
        exchange = FakeExchange(last=7.5)
        stream = QuoteStream(
            {"BINANCE": {"spot": ("binance", "spot")}},
            source._stream_market,
            source._quote,
            lambda _m: None,
        )

        async def client(_venue, _kind):
            return exchange

        stream._client = client  # type: ignore[method-assign]
        seen: list[dict] = []
        source._emit = seen.append
        stream.set_tickers(["BINANCE:BTC/USDT", "BINANCE:NOPE/USDT"])
        stream.start()
        try:
            deadline = time.time() + 5.0
            while time.time() < deadline and not seen:
                time.sleep(0.05)
            self.assertTrue(seen, "the socket quote never reached the source")
            self.assertEqual({q["ticker"] for q in seen}, {"BINANCE:BTC/USDT"})
            self.assertTrue(exchange.calls)
            self.assertEqual(exchange.calls[0], ["BTC/USDT"])
            self.assertTrue(stream.healthy("BINANCE", "spot"))
        finally:
            stream.stop()
            source._bar_pool.shutdown(wait=False, cancel_futures=True)
        time.sleep(0.2)
        self.assertTrue(exchange.closed)


if __name__ == "__main__":
    unittest.main()
