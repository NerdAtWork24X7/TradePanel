"""Live quotes over the venues' own WebSockets (ccxt.pro).

The plugin only streams the symbols the app asked for (`data.subscribe`): a
watchlist of twenty symbols opens twenty subscriptions, never every market of
the venue. One task per venue/kind owns the socket and answers the current set,
so a subscription change reaches the venue on the next watch loop.

Every failure falls back to the REST poller in `crypto_source.py`: `healthy()`
goes false as soon as the socket reports an error, and the poller takes the
group back. The reverse happens when the socket recovers: the poller skips a
group a WebSocket has fed within the last few seconds. Quotes are deduplicated
by price in the source, so a short overlap cannot produce a double tick.
"""

from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import Mapping
from typing import Any, Callable

# A group a socket has fed this recently is left to it; after that the REST
# poller resumes, covering a reconnect or a venue without WebSocket support.
HEALTHY_FOR = 10.0
# Longest wait between two attempts at a failing socket.
MAX_BACKOFF = 30.0


class QuoteStream:
    """ccxt.pro quote subscriptions for exactly the tickers the app selects."""

    def __init__(
        self,
        venues: Mapping[str, Mapping[str, tuple[str, str]]],
        resolve: Callable[[str], tuple[str, str, Any] | None],
        quote: Callable[[str, Any, float, float], None],
        log: Callable[[str], None],
    ):
        self._venues = venues
        self._resolve = resolve
        self._quote = quote
        self._log = log
        self._lock = threading.Lock()
        self._requested: list[str] = []
        self._requested_version = 0
        self._resolved_version = -1
        self._wanted: dict[tuple[str, str], dict[str, Any]] = {}
        self._healthy: dict[tuple[str, str], float] = {}
        self._fallback: set[tuple[str, str]] = set()
        self._last_error: dict[tuple[str, str], tuple[str, float]] = {}
        self._thread: threading.Thread | None = None
        self._stop = False
        self._pro_missing = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop = False
        self._thread = threading.Thread(target=self._run, name="crypto-ws", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop = True

    def set_tickers(self, tickers: list[str]) -> None:
        """The app's whole selection: replaces the previous set, no market scan.

        The tickers are resolved on the stream's own worker: subscribing runs on
        the app's message thread and must never wait for a venue to load markets.
        """
        with self._lock:
            if tickers == self._requested:
                return
            self._requested = list(tickers)
            self._requested_version += 1

    def healthy(self, venue: str, kind: str) -> bool:
        """True while a WebSocket feeds this group; the REST poller then stands down."""
        with self._lock:
            at = self._healthy.get((venue, kind))
        return at is not None and time.time() - at < HEALTHY_FOR

    # ── event loop ───────────────────────────────────────────────────────────

    def _run(self) -> None:
        try:
            asyncio.run(self._main())
        except Exception as e:  # noqa: BLE001 - the REST poller is still there
            self._log(f"[ws] quote stream stopped: {e}")

    async def _main(self) -> None:
        tasks: dict[tuple[str, str], asyncio.Task[None]] = {}
        try:
            while not self._stop:
                await self._resolve_requested()
                wanted = self._snapshot()
                for key in list(tasks):
                    if key not in wanted:
                        tasks.pop(key).cancel()
                if not self._pro_missing:
                    for key in wanted:
                        if key in self._fallback:
                            continue
                        task = tasks.get(key)
                        if task is None or task.done():
                            tasks[key] = asyncio.create_task(self._watch(key), name=f"ws-{key[0]}-{key[1]}")
                await asyncio.sleep(0.5)
        finally:
            for task in tasks.values():
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks.values(), return_exceptions=True)

    async def _resolve_requested(self) -> None:
        with self._lock:
            version = self._requested_version
            if version == self._resolved_version:
                return
            tickers = list(self._requested)
        wanted = await asyncio.to_thread(self._resolve_all, tickers)
        with self._lock:
            if version != self._requested_version:
                return  # a newer selection arrived while this one resolved
            self._wanted = wanted
            self._resolved_version = version
            for key in list(self._healthy):
                if key not in wanted:
                    self._healthy.pop(key, None)

    def _resolve_all(self, tickers: list[str]) -> dict[tuple[str, str], dict[str, Any]]:
        wanted: dict[tuple[str, str], dict[str, Any]] = {}
        for ticker in tickers:
            found = self._resolve(ticker)
            if found is None:
                continue
            venue, kind, market = found
            wanted.setdefault((venue, kind), {})[ticker] = market
        return wanted

    def _snapshot(self) -> dict[tuple[str, str], dict[str, Any]]:
        with self._lock:
            return {key: dict(markets) for key, markets in self._wanted.items()}

    async def _watch(self, key: tuple[str, str]) -> None:
        venue, kind = key
        exchange: Any = None
        backoff = 1.0
        try:
            while not self._stop:
                markets = self._snapshot().get(key)
                if not markets:
                    return
                try:
                    if exchange is None:
                        exchange = await self._client(venue, kind)
                    symbols = [market.symbol for market in markets.values()]
                    # `has` is the venue's own capability report: a venue without a
                    # bulk ticker socket stays on REST instead of opening one socket
                    # per symbol.
                    if not (exchange.has or {}).get("watchTickers"):
                        self._unavailable(key, "no ticker WebSocket on this venue")
                        return
                    updates = await exchange.watch_tickers(symbols)
                    now = time.time()
                    by_symbol = {market.symbol: (ticker, market) for ticker, market in markets.items()}
                    for symbol, ticker in (updates or {}).items():
                        found = by_symbol.get(symbol)
                        if found is None:
                            continue
                        name, market = found
                        last = _last_price(ticker)
                        if last is None:
                            continue
                        self._quote(name, market, last, now)
                    # A successful watch means the socket is alive even when no price
                    # moved (a quiet market), so REST must keep standing down.
                    with self._lock:
                        self._healthy[key] = now
                    backoff = 1.0
                except asyncio.CancelledError:
                    raise
                except ImportError as e:
                    self._pro_missing = True
                    self._unavailable(key, str(e))
                    return
                except Exception as e:  # noqa: BLE001 - one venue must not stop the others
                    with self._lock:
                        self._healthy.pop(key, None)
                    # The venue reports it has no such stream: REST is its path.
                    if type(e).__name__ == "NotSupported":
                        self._unavailable(key, str(e))
                        return
                    self._log_once(key, str(e))
                    await asyncio.sleep(backoff)
                    backoff = min(MAX_BACKOFF, backoff * 2)
                    # A client whose socket is broken is rebuilt once the loop retries.
                    if backoff >= MAX_BACKOFF:
                        await _close(exchange)
                        exchange = None
        finally:
            await _close(exchange)

    async def _client(self, venue: str, kind: str) -> Any:
        import ccxt.pro as ccxtpro  # noqa: PLC0415 - optional dependency, checked when streaming

        ccxt_id, default_type = self._venues[venue][kind]
        try:
            constructor = getattr(ccxtpro, ccxt_id)
        except AttributeError as e:
            raise ImportError(f"ccxt.pro has no exchange {ccxt_id!r}") from e
        return constructor({
            "enableRateLimit": True,
            "newUpdates": True,
            "timeout": 20_000,
            "options": {"defaultType": default_type, "adjustForTimeDifference": True},
        })

    def _unavailable(self, key: tuple[str, str], reason: str) -> None:
        with self._lock:
            self._healthy.pop(key, None)
            # Keep REST on this group instead of reconnecting a stream the venue
            # says it does not have every half second.
            self._fallback.add(key)
        self._log_once(key, reason)

    def _log_once(self, key: tuple[str, str], message: str) -> None:
        """One line per distinct failure a minute, never per reconnect attempt."""
        now = time.time()
        with self._lock:
            previous = self._last_error.get(key)
            if previous and previous[0] == message and now - previous[1] < 60.0:
                return
            self._last_error[key] = (message, now)
        self._log(f"[ws] {key[0]} {key[1]}: {message}")


async def _close(exchange: Any) -> None:
    if exchange is None:
        return
    try:
        await exchange.close()
    except Exception:  # noqa: BLE001 - closing a broken socket is best effort
        pass


def _last_price(ticker: Mapping[str, Any] | None) -> float | None:
    """The last trade, or the bid when the venue sends no trades."""
    if not isinstance(ticker, Mapping):
        return None
    for field in ("last", "close", "bid", "ask"):
        try:
            value = ticker.get(field)
            if value is None:
                continue
            price = float(value)
        except (TypeError, ValueError):
            continue
        if price == price and price not in (float("inf"), float("-inf")) and price > 0:
            return price
    return None
