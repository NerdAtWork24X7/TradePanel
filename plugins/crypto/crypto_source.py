"""Market data for the crypto plugin: one ccxt client per venue and market.

The plugin serves several exchanges from one source (Plugin API 2, `exchanges`), so every
ticker it names is a whole symbol: ``BINANCE:BTC/USDT``. Spot markets keep their ccxt name
(``BTC/USDT``); perpetuals take a ``.P`` suffix (``BINANCE:BTC/USDT.P``) because a full
OpenTrader symbol cannot hold the second colon ccxt uses for the settle currency
(``BTC/USDT:USDT``). The suffix is plugin-local: it never reaches ccxt.

Only public endpoints are used here. Nothing in this module places an order.
"""

from __future__ import annotations

import math
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

from quote_stream import QuoteStream

# venue code in OpenTrader -> ccxt id and defaultType per market kind.
VENUES: dict[str, dict[str, tuple[str, str]]] = {
    "BINANCE": {"spot": ("binance", "spot"), "swap": ("binance", "swap")},
    "BYBIT": {"spot": ("bybit", "spot"), "swap": ("bybit", "swap")},
    "OKX": {"spot": ("okx", "spot"), "swap": ("okx", "swap")},
    "COINBASE": {"spot": ("coinbase", "spot")},
    "KRAKEN": {"spot": ("kraken", "spot")},
    "KUCOIN": {"spot": ("kucoin", "spot"), "swap": ("kucoinfutures", "swap")},
    "GATEIO": {"spot": ("gate", "spot"), "swap": ("gate", "swap")},
    "BITGET": {"spot": ("bitget", "spot"), "swap": ("bitget", "swap")},
    "HYPERLIQUID": {"spot": ("hyperliquid", "spot"), "swap": ("hyperliquid", "swap")},
}

VENUE_NAMES = {
    "BINANCE": "Binance",
    "BYBIT": "Bybit",
    "OKX": "OKX",
    "COINBASE": "Coinbase",
    "KRAKEN": "Kraken",
    "KUCOIN": "KuCoin",
    "GATEIO": "Gate.io",
    "BITGET": "Bitget",
    "HYPERLIQUID": "Hyperliquid",
}

# Empty searches (the picker's popular rows) show these first, on every venue that lists them.
MAJORS = ("BTC", "ETH", "SOL", "XRP", "BNB", "DOGE", "ADA", "AVAX", "LINK", "TON")
QUOTES = ("USDT", "USDC", "USD", "FDUSD", "EUR", "BTC")

# ccxt can return a lot in one call; every venue's cap is at or under this.
PAGE = 1000
# Stop a runaway pagination request (a venue that ignores `since`).
MAX_PAGES = 80
# Refresh the cached daily / minute bar behind a live quote.
DAY_REFRESH = 300.0
MINUTE_REFRESH = 25.0
# A window ending at the live edge is refreshed this often when history is
# read again; older windows are immutable and stay cached.
LIVE_BARS_TTL = 2.0
# Bounded history memo: the cache never grows with every symbol ever charted.
BARS_CACHE_MAX_ROWS = 300_000
BARS_CACHE_MAX_KEYS = 32
BARS_CACHE_REFRESH = 3.0


@dataclass
class _BarsEntry:
    """Fetched history of one (ticker, timeframe), as time -> row and covered spans."""

    rows: dict[int, list[float]] = field(default_factory=dict)
    spans: list[tuple[float, float]] = field(default_factory=list)
    at: float = 0.0


class PluginError(Exception):
    """An error answered to the app; the message is shown to the user."""

    def __init__(self, message: str, code: int = -32000):
        super().__init__(message)
        self.code = code


@dataclass
class Market:
    """One tradable market, in the plugin's naming."""

    venue: str
    ccxt_id: str
    kind: str
    ticker: str
    symbol: str  # ccxt's unified symbol
    market: dict[str, Any]

    @property
    def base(self) -> str:
        return str(self.market.get("base") or self.ticker.split("/")[0])

    @property
    def quote(self) -> str:
        return str(self.market.get("quote") or "USD")


@dataclass
class _Loaded:
    """The markets of one (ccxt id, kind) client, indexed both ways."""

    client: Any
    by_ticker: dict[str, Market] = field(default_factory=dict)
    by_ccxt: dict[str, Market] = field(default_factory=dict)


def _precision_scale(market: dict[str, Any]) -> int:
    """Ticks per unit price (``pricescale``) from ccxt's market precision.

    ccxt reports the price precision either as decimal places (mode 2) or as the tick
    size itself (mode 4). Older exchanges leave it in ``limits.price.min``.
    """
    precision = market.get("precision") or {}
    price = precision.get("price")
    mode = market.get("precisionMode")
    if price is not None:
        try:
            value = float(price)
            if value <= 0:
                return 1
            # ccxt speaks two precisions: decimal places (mode 2) or the tick size itself
            # (mode 4). Some venues leave the mode out and give a tick size, so only mode 2
            # is read as decimal places.
            if mode == 2:
                return 10 ** min(12, int(value))
            return max(1, round(1 / value))
        except (TypeError, ValueError, OverflowError):
            pass
    minimum = ((market.get("limits") or {}).get("price") or {}).get("min")
    try:
        if minimum:
            return max(1, round(1 / float(minimum)))
    except (TypeError, ValueError, ZeroDivisionError):
        pass
    return 100_000_000


def _is_active(market: dict[str, Any]) -> bool:
    return market.get("active") is not False


def _settle_rank(market: dict[str, Any]) -> int:
    """Prefer USDT-margined contracts, then USDC, then the rest (one per base / quote)."""
    settle = str(market.get("settle") or market.get("quote") or "")
    return {"USDT": 0, "USDC": 1, "USD": 2}.get(settle, 3)


class CryptoSource:
    """Public market data across the venues of :data:`VENUES`."""

    def __init__(self, log: Callable[[str], None], poll_seconds: float = 3.0):
        self._log = log
        self._lock = threading.RLock()
        self._loaded: dict[tuple[str, str], _Loaded] = {}
        self._loading: set[tuple[str, str]] = set()
        self._loading_done = threading.Condition(self._lock)
        self._failed: dict[tuple[str, str], str] = {}
        self._failed_at: dict[tuple[str, str], float] = {}
        self._poll_seconds = max(1.0, float(poll_seconds or 3.0))
        self._subscribed: set[str] = set()
        self._bars: dict[str, dict[str, Any]] = {}
        self._bar_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="crypto-bars")
        self._bar_cache: OrderedDict[tuple[str, str], _BarsEntry] = OrderedDict()
        self._bar_locks: dict[tuple[str, str], threading.Lock] = {}
        self._search_cache: OrderedDict[str, tuple[float, list[dict[str, str]]]] = OrderedDict()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._emit: Callable[[dict[str, Any]], None] = lambda _quote: None
        self._stream = QuoteStream(VENUES, self._stream_market, self._quote, self._log)

    # ── lifecycle ────────────────────────────────────────────────────────────

    def configure(self, settings: dict[str, str]) -> None:
        try:
            self._poll_seconds = max(1.0, float(settings.get("pollSeconds") or 3.0))
        except (TypeError, ValueError):
            self._poll_seconds = 3.0

    def start(self, emit: Callable[[dict[str, Any]], None]) -> None:
        """Begin streaming quotes; `emit` receives one `data.quote` payload per price change."""
        self._emit = emit
        # Symbols, not markets: the socket is opened only for what is subscribed.
        self._stream.start()
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="crypto-quotes", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._stream.stop()
        self._bar_pool.shutdown(wait=False, cancel_futures=True)

    # ── clients and markets ──────────────────────────────────────────────────

    @staticmethod
    def _ccxt() -> Any:
        try:
            import ccxt  # noqa: PLC0415 - optional dependency, imported when the plugin starts
        except ImportError as e:  # pragma: no cover - environment problem, not a code path
            raise PluginError(
                "The crypto plugin needs the ccxt package: pip install -r requirements.txt",
            ) from e
        return ccxt

    def _client(self, ccxt_id: str, kind: str) -> Any:
        ccxt = self._ccxt()
        try:
            client = getattr(ccxt, ccxt_id)({
                "enableRateLimit": True,
                "timeout": 20_000,
                "options": {"defaultType": kind, "adjustForTimeDifference": True},
            })
        except AttributeError as e:
            raise PluginError(f"ccxt has no exchange {ccxt_id!r}") from e
        return client

    def _ensure(self, venue: str, kind: str) -> _Loaded:
        key = (venue, kind)
        with self._lock:
            while key in self._loading:
                # Another thread is fetching this venue's markets: wait for its outcome.
                self._loading_done.wait(0.5)
            if key in self._loaded:
                return self._loaded[key]
            failed = self._failed.get(key)
            if failed and time.time() - self._failed_at.get(key, 0.0) < 30.0:
                raise PluginError(f"{VENUE_NAMES.get(venue, venue)} {kind} markets: {failed}")
            self._loading.add(key)
        ccxt_id, default_type = VENUES[venue][kind]
        try:
            client = self._client(ccxt_id, default_type)
            client.load_markets()
            loaded = self._index(venue, kind, ccxt_id, client)
        except PluginError:
            with self._lock:
                self._loading.discard(key)
                self._loading_done.notify_all()
            raise
        except Exception as e:  # noqa: BLE001 - any venue failure must not sink the plugin
            with self._lock:
                self._loading.discard(key)
                self._failed[key] = str(e)
                self._failed_at[key] = time.time()
                self._loading_done.notify_all()
            raise PluginError(f"{VENUE_NAMES.get(venue, venue)} {kind} markets: {e}") from e
        with self._lock:
            self._loaded[key] = loaded
            self._loading.discard(key)
            self._failed.pop(key, None)
            self._loading_done.notify_all()
            return loaded

    def _index(self, venue: str, kind: str, ccxt_id: str, client: Any) -> _Loaded:
        loaded = _Loaded(client=client)
        markets = list((client.markets or {}).values())
        if kind == "swap":
            markets = [m for m in markets if m.get("swap") and (m.get("linear") or m.get("inverse"))]
            # One contract per base / quote, the USDT-margined one.
            markets.sort(key=lambda m: (_settle_rank(m), str(m.get("base")), str(m.get("quote"))))
        else:
            markets = [m for m in markets if m.get("spot", True) and not m.get("swap")]
        for market in markets:
            if not _is_active(market):
                continue
            base = str(market.get("base") or "").strip()
            quote = str(market.get("quote") or "").strip()
            if not base or not quote or quote not in QUOTES:
                continue
            ticker = f"{base}/{quote}" + (".P" if kind == "swap" else "")
            if ticker in loaded.by_ticker:
                continue
            item = Market(venue, ccxt_id, kind, ticker, str(market.get("symbol")), market)
            loaded.by_ticker[ticker] = item
            loaded.by_ccxt[item.symbol] = item
        return loaded

    def venues_loaded(self) -> list[str]:
        with self._lock:
            return sorted({venue for venue, _ in self._loaded})

    def _market(self, whole_symbol: str) -> Market:
        """Find a market from ``VENUE:TICKER``."""
        venue, sep, ticker = str(whole_symbol).partition(":")
        venue = venue.upper()
        if not sep or venue not in VENUES:
            raise PluginError(f"Unknown exchange in {whole_symbol!r}", -32602)
        ticker = ticker.strip()
        kind = "swap" if ticker.endswith(".P") else "spot"
        if kind not in VENUES[venue]:
            raise PluginError(f"{VENUE_NAMES.get(venue, venue)} has no {kind} markets", -32602)
        loaded = self._ensure(venue, kind)
        market = loaded.by_ticker.get(ticker)
        if market is None:
            raise PluginError(f"{whole_symbol} is not listed on {VENUE_NAMES.get(venue, venue)}", -32602)
        return market

    def _stream_market(self, ticker: str) -> tuple[str, str, Market] | None:
        """Resolve a subscribed ticker for the WebSocket stream; unknown ones stay on REST."""
        try:
            market = self._market(ticker)
        except PluginError:
            return None
        return market.venue, market.kind, market

    # ── search ───────────────────────────────────────────────────────────────

    def search(self, query: str) -> list[dict[str, str]]:
        q = query.strip().upper()
        now = time.time()
        with self._lock:
            hit = self._search_cache.get(q)
            if hit and now - hit[0] < 5.0:
                self._search_cache.move_to_end(q)
                return list(hit[1])
        rows = self._search(q)
        with self._lock:
            self._search_cache[q] = (now, rows)
            self._search_cache.move_to_end(q)
            while len(self._search_cache) > 32:
                self._search_cache.popitem(last=False)
        return rows

    def _search(self, q: str) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        # Load every venue once, in parallel: a search covers all of them.
        threads = []
        for venue, kinds in VENUES.items():
            for kind in kinds:
                t = threading.Thread(target=self._quiet_ensure, args=(venue, kind), daemon=True)
                t.start()
                threads.append(t)
        # A search is a typeahead: answer from the venues that have loaded instead of holding it for
        # one that is slow or unreachable. The first venue is what the dialog needs; its peers get a
        # short grace, and a cold start (nothing loaded yet) the whole budget.
        deadline = time.time() + 10.0
        while time.time() < deadline and not self.venues_loaded():
            time.sleep(0.05)
        if self.venues_loaded():
            deadline = min(deadline, time.time() + 1.5)
        for t in threads:
            t.join(timeout=max(0.0, deadline - time.time()))
        with self._lock:
            venues = list(self._loaded.values())
        matches: list[tuple[int, str, Market]] = []
        for loaded in venues:
            for market in loaded.by_ticker.values():
                hay = f"{market.base}/{market.quote} {market.base}".upper()
                if not q:
                    if market.base.upper() in MAJORS:
                        matches.append((MAJORS.index(market.base.upper()), market.ticker, market))
                    continue
                if q in market.ticker.upper() or q in hay or q == market.base.upper():
                    rank = 0 if market.ticker.upper().startswith(q) else 1 if market.base.upper() == q else 2
                    matches.append((rank, market.ticker, market))
        quote_rank = {q: i for i, q in enumerate(QUOTES)}
        matches.sort(key=lambda m: (m[0], m[2].kind == "swap", quote_rank.get(m[2].quote, len(QUOTES)), m[1], m[2].venue))
        seen: set[str] = set()
        for _, _, market in matches:
            ticker = f"{market.venue}:{market.ticker}"
            if ticker in seen:
                continue
            seen.add(ticker)
            rows.append({
                "ticker": ticker,
                "description": f"{market.base}/{market.quote} " + ("perpetual" if market.kind == "swap" else "spot"),
                "type": "crypto",
            })
            if len(rows) >= 50:
                break
        return rows

    def _quiet_ensure(self, venue: str, kind: str) -> None:
        try:
            self._ensure(venue, kind)
        except PluginError:
            pass

    # ── symbol info ──────────────────────────────────────────────────────────

    def symbol_info(self, ticker: str) -> dict[str, Any]:
        market = self._market(ticker)
        return {
            "description": f"{market.base}/{market.quote} " + ("perpetual" if market.kind == "swap" else "spot"),
            "type": "crypto",
            "currency": market.quote,
            "timezone": "Etc/UTC",
            "session": "24x7",
            "extended": None,
            "holidays": "",
            "pricescale": _precision_scale(market.market),
            "minmov": 1,
            "intervals": ["1", "5", "15", "30", "60", "240", "1D"],
        }

    def pricescale(self, ticker: str) -> int:
        return _precision_scale(self._market(ticker).market)

    # ── bars ─────────────────────────────────────────────────────────────────

    @staticmethod
    def timeframe(resolution: str) -> str:
        table = {"1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m", "60": "1h",
                 "120": "2h", "240": "4h", "360": "6h", "720": "12h", "1D": "1d", "1W": "1w", "1M": "1M"}
        found = table.get(resolution.upper() if resolution.upper().endswith(("D", "W", "M")) else resolution)
        if not found:
            raise PluginError(f"Resolution {resolution} is not served", -32602)
        return found

    def bars(self, ticker: str, resolution: str, frm: float, to: float, count_back: int) -> list[list[float]]:
        market = self._market(ticker)
        timeframe = self.timeframe(resolution)
        step = self._timeframe_seconds(timeframe)
        count = max(1, min(int(count_back or 500), 50_000))
        to_s = max(0.0, float(to))
        from_s = max(0.0, min(float(frm), to_s))
        # Ask for the window that can hold `count` bars, not from the start of history:
        # `from` may be years back while the chart only wants the newest 500 bars.
        since = max(from_s, to_s - (count + 4) * step)
        key = (ticker, timeframe)
        # One fetch for the same series at a time: two charts opening together share it.
        with self._bar_lock(key):
            now = time.time()
            entry = self._bar_entry(key)
            if entry is None:
                spans = [(since, to_s)]
            else:
                spans = _missing_spans(entry.spans, since, to_s)
                # The newest bars are still moving: re-read only that tail, and only
                # when the memo has had time to go stale. Older windows never are.
                if to_s >= now - 2 * step and now - entry.at >= LIVE_BARS_TTL:
                    spans = _merge_spans(spans + [(max(since, to_s - 2 * step), to_s)])
            if spans:
                fetched: list[list[float]] = []
                covered: list[tuple[float, float]] = []
                for start, end in spans:
                    ask = max(1, min(count, int(math.ceil((end - start) / step)) + 4))
                    rows, covered_to = self._fetch_window(market, timeframe, start, end, ask, step)
                    fetched.extend(rows)
                    covered.append((start, covered_to))
                with self._lock:
                    entry = self._bar_cache.get(key)
                    if entry is None:
                        entry = _BarsEntry()
                        self._bar_cache[key] = entry
                    self._bar_cache.move_to_end(key)
                    for row in fetched:
                        entry.rows[int(row[0])] = row
                    entry.spans = _merge_spans(entry.spans + covered)
                    if any(end >= now - 2 * step for _start, end in spans):
                        entry.at = now
                    self._trim_bars_cache()
            with self._lock:
                entry = self._bar_cache.get(key)
                if entry is None:
                    rows = []
                else:
                    self._bar_cache.move_to_end(key)
                    rows = [row for t, row in entry.rows.items() if from_s - 1e-6 <= t <= to_s + 1e-6]
                live = self._bars.get(ticker)
        rows.sort(key=lambda r: r[0])
        # The forming bar is always the live one, even when the cached copy of it
        # is a few seconds old: history never overrides the quote stream.
        if live and timeframe in ("1m", "1d") and live.get("last") is not None:
            source = live.get("minute" if timeframe == "1m" else "day")
            if source is not None:
                overlay = _forming(source, float(live["last"]), step, now)
                if from_s - 1e-6 <= overlay[0] <= to_s + 1e-6:
                    _put_bar(rows, overlay)
        return rows[-count:]

    def _bar_lock(self, key: tuple[str, str]) -> threading.Lock:
        with self._lock:
            lock = self._bar_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._bar_locks[key] = lock
            return lock

    def _bar_entry(self, key: tuple[str, str]) -> _BarsEntry | None:
        with self._lock:
            entry = self._bar_cache.get(key)
            if entry is not None:
                self._bar_cache.move_to_end(key)
            return entry

    def _trim_bars_cache(self) -> None:
        """Keep the memo bounded: old series go first (the venue is asked again)."""
        total = sum(len(entry.rows) for entry in self._bar_cache.values())
        while len(self._bar_cache) > 1 and (len(self._bar_cache) > BARS_CACHE_MAX_KEYS or total > BARS_CACHE_MAX_ROWS):
            _key, entry = self._bar_cache.popitem(last=False)
            total -= len(entry.rows)

    def _fetch_window(
        self,
        market: Market,
        timeframe: str,
        from_s: float,
        to_s: float,
        count: int,
        step: int,
    ) -> tuple[list[list[float]], float]:
        """Bars of one window, and how far the venue's answer actually covers it."""
        out: list[list[float]] = []
        cursor = int(from_s * 1000)
        end_ms = int(to_s * 1000)
        complete = False
        for _ in range(MAX_PAGES):
            rows = self._fetch_ohlcv(market, timeframe, cursor)
            if not rows:
                complete = True
                break
            out.extend(rows)
            last = int(rows[-1][0])
            if last >= end_ms or len(out) >= count + 4:
                complete = last >= end_ms
                break
            following = last + step * 1000
            # The next candle would start after the window (or the venue returned nothing
            # new): a request with since > until is a venue error, not another page.
            if following > end_ms or following <= cursor:
                complete = True
                break
            cursor = following
        clean: list[list[float]] = []
        for row in out:
            try:
                t = float(row[0]) / 1000.0
                if t < from_s - 1e-6 or t > to_s + 1e-6:
                    continue
                clean.append([
                    float(t), float(row[1]), float(row[2]), float(row[3]), float(row[4]),
                    float(row[5] or 0.0),
                ])
            except (TypeError, ValueError, IndexError):
                continue
        clean.sort(key=lambda r: r[0])
        deduped: list[list[float]] = []
        for row in clean:
            if deduped and deduped[-1][0] == row[0]:
                deduped[-1] = row
            else:
                deduped.append(row)
        if not deduped or complete:
            covered_to = to_s
        else:
            # Stopped at the request's bar cap: the window beyond the last row was
            # not read, so it must stay missing for the next call.
            covered_to = max(from_s, min(to_s, deduped[-1][0] + step))
        return deduped[-count:], covered_to

    def _fetch_ohlcv(self, market: Market, timeframe: str, since_ms: int) -> list[list[float]]:
        client = self._ensure(market.venue, market.kind).client
        try:
            return client.fetch_ohlcv(market.symbol, timeframe, since=since_ms, limit=PAGE) or []
        except Exception as e:  # noqa: BLE001 - ccxt raises its own hierarchy
            raise PluginError(f"{VENUE_NAMES.get(market.venue, market.venue)} bars: {e}") from e

    def _timeframe_seconds(self, timeframe: str) -> int:
        unit = timeframe[-1]
        try:
            value = int(timeframe[:-1])
        except ValueError:
            return 86_400
        return value * {"m": 60, "h": 3600, "d": 86_400, "w": 604_800, "M": 2_592_000}.get(unit, 86_400)

    # ── live quotes ──────────────────────────────────────────────────────────

    def subscribe(self, tickers: Iterable[str]) -> None:
        with self._lock:
            self._subscribed = {str(t).strip() for t in tickers if str(t).strip()}
            for ticker in list(self._bars):
                if ticker not in self._subscribed:
                    self._bars.pop(ticker, None)
            subscribed = sorted(self._subscribed)
        # WebSocket subscriptions follow the selection; the REST loop covers the
        # same set when a socket is down or a venue has none.
        self._stream.set_tickers(subscribed)

    def broker_quote(self, ticker: str) -> dict[str, Any] | None:
        """Bid / ask / last for the order ticket, without touching the quote stream."""
        try:
            market = self._market(ticker)
        except PluginError:
            return None
        client = self._ensure(market.venue, market.kind).client
        try:
            t = client.fetch_ticker(market.symbol)
        except Exception:  # noqa: BLE001
            return None
        return {
            "ticker": ticker,
            "bid": _number(t.get("bid")),
            "ask": _number(t.get("ask")),
            "last": _number(t.get("last") or t.get("close")),
        }

    def _loop(self) -> None:
        while not self._stop.wait(0.1):
            started = time.time()
            with self._lock:
                tickers = sorted(self._subscribed)
            if not tickers:
                self._stop.wait(1.0)
                continue
            for group in self._groups(tickers):
                # A socket has this group: do not poll the same prices over REST.
                if self._stream.healthy(group[0].venue, group[0].kind):
                    continue
                try:
                    self._poll_group(group)
                except PluginError as e:
                    self._log(f"[quotes] {e}")
                except Exception as e:  # noqa: BLE001 - one venue must not stop the loop
                    self._log(f"[quotes] {e}")
            wait = max(0.2, self._poll_seconds - (time.time() - started))
            self._stop.wait(wait)

    def _groups(self, tickers: list[str]) -> list[tuple[Market, list[str]]]:
        groups: dict[tuple[str, str], tuple[Market, list[str]]] = {}
        for ticker in tickers:
            try:
                market = self._market(ticker)
            except PluginError:
                continue
            key = (market.venue, market.kind)
            if key not in groups:
                groups[key] = (market, [])
            groups[key][1].append(market.ticker)
        return list(groups.values())

    def _poll_group(self, group: tuple[Market, list[str]]) -> None:
        representative, tickers = group
        loaded = self._ensure(representative.venue, representative.kind)
        symbols = [loaded.by_ticker[t].symbol for t in tickers if t in loaded.by_ticker]
        if not symbols:
            return
        try:
            fetched = loaded.client.fetch_tickers(symbols)
        except Exception:  # noqa: BLE001 - some venues refuse a symbol filter
            fetched = {}
            for symbol in symbols:
                try:
                    fetched[symbol] = loaded.client.fetch_ticker(symbol)
                except Exception:  # noqa: BLE001
                    continue
        now = time.time()
        for ticker in tickers:
            market = loaded.by_ticker.get(ticker)
            if market is None:
                continue
            t = fetched.get(market.symbol)
            if not t:
                continue
            last = _number(t.get("last") or t.get("close") or t.get("bid") or t.get("ask"))
            if last is None:
                continue
            self._quote(f"{market.venue}:{market.ticker}", market, last, now, _number(t.get("previousClose")))

    def _quote(self, ticker: str, market: Market, last: float, now: float, prev_close: float | None = None) -> None:
        """One live price: update the forming bars and push a `data.quote`.

        The bar refresh runs on a worker thread, so a socket tick never waits for
        a REST call and the other venues' streams keep flowing.
        """
        if not math.isfinite(last):
            return
        refresh_minute = refresh_day = False
        with self._lock:
            # A socket can deliver one last update while a symbol is being removed.
            if ticker not in self._subscribed:
                return
            bars = self._bars.setdefault(ticker, _bar_state())
            changed = False
            if prev_close is not None and prev_close > 0 and bars.get("prevClose") != prev_close:
                bars["prevClose"] = prev_close
                changed = True
            if now - bars["minute_at"] >= MINUTE_REFRESH and not bars["minute_busy"]:
                bars["minute_at"] = now
                bars["minute_busy"] = True
                refresh_minute = True
            if now - bars["day_at"] >= DAY_REFRESH and not bars["day_busy"]:
                bars["day_at"] = now
                bars["day_busy"] = True
                refresh_day = True
            previous = bars.get("last")
            bars["last"] = last
            if previous == last and not changed and not refresh_minute and not refresh_day:
                return
            payload = self._payload(ticker, bars, last, now)
        if refresh_minute or refresh_day:
            try:
                self._bar_pool.submit(self._refresh_bars, market, ticker, bars, now, refresh_minute, refresh_day)
            except RuntimeError:  # the pool is shut down: the app is going away
                pass
        self._emit(payload)

    def _payload(self, ticker: str, bars: dict[str, Any], last: float, now: float) -> dict[str, Any]:
        # The cached daily bar is the forming one; the previous close is the bar before it.
        return {
            "ticker": ticker,
            "time": int(now),
            "price": last,
            "prevClose": bars.get("prevClose"),
            "minute": _forming(bars.get("minute"), last, 60, now),
            "day": _forming(bars.get("day"), last, 86_400, now),
        }

    def _refresh_bars(
        self,
        market: Market,
        ticker: str,
        bars: dict[str, Any],
        now: float,
        minute_due: bool,
        day_due: bool,
    ) -> None:
        try:
            client = self._ensure(market.venue, market.kind).client
            if minute_due:
                try:
                    minute = client.fetch_ohlcv(market.symbol, "1m", limit=2) or []
                    if minute:
                        row = minute[-1]
                        with self._lock:
                            bars["minute"] = [float(row[0]) / 1000.0, *(float(v) for v in row[1:6])]
                except Exception:  # noqa: BLE001 - a quote without its forming bar is still useful
                    pass
            if day_due:
                try:
                    day = client.fetch_ohlcv(market.symbol, "1d", limit=2) or []
                    if day:
                        row = day[-1]
                        with self._lock:
                            bars["day"] = [float(row[0]) / 1000.0, *(float(v) for v in row[1:6])]
                            if len(day) >= 2:
                                bars["prevClose"] = float(day[-2][4])
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001 - the next quote retries
            pass
        finally:
            with self._lock:
                if minute_due:
                    bars["minute_busy"] = False
                if day_due:
                    bars["day_busy"] = False
                last = bars.get("last")
                payload = (
                    self._payload(ticker, bars, float(last), time.time())
                    if last is not None and ticker in self._subscribed and self._bars.get(ticker) is bars
                    else None
                )
            # The price may not move again: push the bars the refresh just learned.
            if payload is not None:
                self._emit(payload)


def _bar_state() -> dict[str, Any]:
    return {
        "minute": None,
        "day": None,
        "minute_at": 0.0,
        "day_at": 0.0,
        "minute_busy": False,
        "day_busy": False,
        "last": None,
    }


def _missing_spans(spans: list[tuple[float, float]], start: float, end: float) -> list[tuple[float, float]]:
    """Parts of `[start, end]` no fetched span covers yet."""
    if end < start:
        return []
    out: list[tuple[float, float]] = []
    cursor = start
    for a, b in sorted(spans):
        a = max(a, start)
        b = min(b, end)
        if b < cursor or a > end:
            continue
        if a > cursor:
            out.append((cursor, a))
        cursor = max(cursor, b)
        if cursor >= end:
            break
    if cursor < end:
        out.append((cursor, end))
    return out


def _merge_spans(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    merged: list[tuple[float, float]] = []
    for a, b in sorted(spans):
        if b < a:
            continue
        if merged and a <= merged[-1][1] + 1e-6:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def _put_bar(rows: list[list[float]], bar: list[float]) -> None:
    """Replace or insert `bar` by time, keeping `rows` ascending."""
    t = bar[0]
    for i in range(len(rows) - 1, -1, -1):
        if rows[i][0] == t:
            rows[i] = bar
            return
        if rows[i][0] < t:
            rows.insert(i + 1, bar)
            return
    rows.insert(0, bar)


def _number(value: Any) -> float | None:
    try:
        n = float(value)
        return n if n == n and n not in (float("inf"), float("-inf")) else None
    except (TypeError, ValueError):
        return None


def _forming(cached: Any, last: float, size: int, now: float) -> list[float]:
    """The forming bar of `size` seconds at `now`, moved to `last`."""
    bucket = int(now // size * size)
    if isinstance(cached, list) and len(cached) >= 6 and int(cached[0]) == bucket:
        _time, open_, high, low, _close, volume = cached[:6]
        return [bucket, open_, max(high, last), min(low, last), last, volume]
    return [bucket, last, last, last, last, 0.0]
