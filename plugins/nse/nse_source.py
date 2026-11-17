"""NSE equity market data for the Plugin API 2 data-only plugin.

One public chart endpoint supplies symbol metadata, OHLCV history and last-price
snapshots for `<ticker>.NS`. A small bundled catalogue keeps search useful when
the endpoint is unavailable; live search augments it when it answers.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import sys
import threading
import time
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

EXCHANGE = "NSE"
SUFFIX = ".NS"
CHART_API = "https://query1.finance.yahoo.com/v8/finance/chart"
SEARCH_API = "https://query1.finance.yahoo.com/v1/finance/search"
SYMBOL_LIST_URL = "https://nsearchives.nseindia.com/content/equities/sec_list.csv"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TradePanel/1.0)",
    "Accept": "application/json, text/plain, */*",
}
REQUEST_TIMEOUT = 12.0
CACHE_VERSION = 1
CACHE_TTL = 24 * 3600.0
# IST is a fixed +05:30 offset: no tzdata dependency in the bundled runtime.
IST = timezone(timedelta(hours=5, minutes=30))

SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9&.\-]{0,19}$")

# Starter list, used for empty queries and as a fallback when search is throttled.
CATALOG: tuple[tuple[str, str], ...] = (
    ("RELIANCE", "Reliance Industries"),
    ("TCS", "Tata Consultancy Services"),
    ("HDFCBANK", "HDFC Bank"),
    ("ICICIBANK", "ICICI Bank"),
    ("HINDUNILVR", "Hindustan Unilever"),
    ("INFY", "Infosys"),
    ("ITC", "ITC"),
    ("SBIN", "State Bank of India"),
    ("BHARTIARTL", "Bharti Airtel"),
    ("KOTAKBANK", "Kotak Mahindra Bank"),
    ("LICI", "Life Insurance Corporation of India"),
    ("BAJFINANCE", "Bajaj Finance"),
    ("ASIANPAINT", "Asian Paints"),
    ("MARUTI", "Maruti Suzuki India"),
    ("TITAN", "Titan Company"),
    ("AXISBANK", "Axis Bank"),
    ("HCLTECH", "HCL Technologies"),
    ("SUNPHARMA", "Sun Pharmaceutical Industries"),
    ("ULTRACEMCO", "UltraTech Cement"),
    ("WIPRO", "Wipro"),
    ("NTPC", "NTPC"),
    ("TATAMOTORS", "Tata Motors"),
    ("TATASTEEL", "Tata Steel"),
    ("ONGC", "Oil and Natural Gas Corporation"),
    ("POWERGRID", "Power Grid Corporation of India"),
    ("M&M", "Mahindra & Mahindra"),
    ("SHRIRAMFIN", "Shriram Finance"),
    ("ADANIENT", "Adani Enterprises"),
    ("ADANIPORTS", "Adani Ports and SEZ"),
    ("JSWSTEEL", "JSW Steel"),
    ("LT", "Larsen & Toubro"),
    ("CIPLA", "Cipla"),
    ("COALINDIA", "Coal India"),
    ("DRREDDY", "Dr. Reddy's Laboratories"),
    ("EICHERMOT", "Eicher Motors"),
    ("GRASIM", "Grasim Industries"),
    ("HINDALCO", "Hindalco Industries"),
    ("INDUSINDBK", "IndusInd Bank"),
    ("NESTLEIND", "Nestle India"),
    ("SBILIFE", "SBI Life Insurance"),
    ("TECHM", "Tech Mahindra"),
    ("TRENT", "Trent"),
    ("TATACONSUM", "Tata Consumer Products"),
    ("BAJAJFINSV", "Bajaj Finserv"),
    ("BPCL", "Bharat Petroleum Corporation"),
    ("APOLLOHOSP", "Apollo Hospitals Enterprise"),
    ("BRITANNIA", "Britannia Industries"),
    ("DIVISLAB", "Divi's Laboratories"),
    ("HAL", "Hindustan Aeronautics"),
    ("HDFCLIFE", "HDFC Life Insurance"),
    ("HEROMOTOCO", "Hero MotoCorp"),
    ("JIOFIN", "Jio Financial Services"),
    ("LTIM", "LTIMindtree"),
    ("MAXHEALTH", "Max Healthcare Institute"),
    ("SBICARD", "SBI Cards and Payment Services"),
    ("UPL", "UPL"),
    ("VEDL", "Vedanta"),
)
_NAMES = dict(CATALOG)

# App resolution -> endpoint interval, seconds per bar, and how far back it reaches.
TIMEFRAMES: dict[str, tuple[str, int, int]] = {
    "1": ("1m", 60, 29 * 86400),
    "5": ("5m", 300, 59 * 86400),
    "15": ("15m", 900, 59 * 86400),
    "30": ("30m", 1800, 59 * 86400),
    "60": ("60m", 3600, 729 * 86400),
    "240": ("60m", 3600, 729 * 86400),
    "1D": ("1d", 86400, 20 * 365 * 86400),
    "1W": ("1wk", 7 * 86400, 20 * 365 * 86400),
    "1M": ("1mo", 30 * 86400, 20 * 365 * 86400),
}

INTERVALS = ["1", "5", "15", "30", "60", "1D", "1W", "1M"]


class PluginError(Exception):
    """An error answered to the app; its message is shown to the user."""

    def __init__(self, message: str, code: int = -32000):
        super().__init__(message)
        self.code = code


class _Cache:
    """Small TTL cache: a typeahead or a poll must not turn into an HTTP flood."""

    def __init__(self, max_entries: int):
        self.max_entries = max_entries
        self._entries: OrderedDict[Any, tuple[float, Any]] = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: Any, ttl: float, now: float) -> Any | None:
        with self._lock:
            hit = self._entries.get(key)
            if hit is None:
                return None
            if now - hit[0] >= ttl:
                self._entries.pop(key, None)
                return None
            self._entries.move_to_end(key)
            return hit[1]

    def put(self, key: Any, value: Any, now: float) -> None:
        with self._lock:
            self._entries[key] = (now, value)
            self._entries.move_to_end(key)
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._entries.clear()


def _number(value: Any, default: float) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if math.isfinite(result) else default


def _day_start(timestamp: int) -> int:
    local = datetime.fromtimestamp(timestamp, IST)
    return int(datetime(local.year, local.month, local.day, tzinfo=IST).timestamp())


def default_cache_path() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
    return base / "TradePanel" / "nse-symbols.json"


class NseSource:
    """The datafeed methods of the plugin, over one public chart endpoint."""

    def __init__(
        self,
        log: Callable[[str], None] | None = None,
        opener: Callable[..., Any] | None = None,
        clock: Callable[[], float] | None = None,
        cache_path: Path | None = None,
        cache_ttl: float = CACHE_TTL,
    ):
        self._log = log or (lambda _: None)
        self._opener = opener or urlopen
        self._clock = clock or time.time
        self._cache_path = Path(cache_path) if cache_path else default_cache_path()
        self._cache_ttl = cache_ttl
        self._catalog: list[dict[str, str]] = []
        self._catalog_at = 0.0
        self._catalog_lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._search_cache = _Cache(32)
        self._meta_cache = _Cache(64)
        self._chart_cache = _Cache(48)
        self._poll_seconds = 10.0
        self._subs: set[str] = set()
        self._inflight: set[str] = set()
        self._state_lock = threading.Lock()
        self._inflight_lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._emit: Callable[[dict[str, Any]], None] | None = None
        self._quote_pool: ThreadPoolExecutor | None = None

    # ── HTTP ─────────────────────────────────────────────────────────────────

    def _fetch(self, base: str, params: dict[str, Any] | None = None,
               accept: str | None = None, timeout: float = REQUEST_TIMEOUT) -> bytes:
        url = f"{base}?{urlencode(params)}" if params else base
        headers = dict(HEADERS)
        if accept:
            headers["Accept"] = accept
        try:
            with self._opener(Request(url, headers=headers), timeout=timeout) as response:
                return response.read()
        except HTTPError as e:
            if e.code in (403, 429, 503):
                raise PluginError("The market data endpoint is limiting requests; try again shortly.") from e
            raise PluginError(f"The market data endpoint answered HTTP {e.code}.") from e
        except (URLError, TimeoutError, OSError) as e:
            raise PluginError(f"Could not reach the market data endpoint: {e}") from e

    def _json(self, base: str, params: dict[str, Any]) -> dict[str, Any]:
        try:
            payload = json.loads(self._fetch(base, params))
        except (ValueError, UnicodeDecodeError) as e:
            raise PluginError("The market data endpoint answered an unexpected payload.") from e
        if not isinstance(payload, dict):
            raise PluginError("The market data endpoint answered an unexpected payload.")
        return payload

    def _chart(self, symbol: str, params: dict[str, Any], ttl: float) -> dict[str, Any]:
        now = self._clock()
        key = (symbol, tuple(sorted(params.items())))
        cached = self._chart_cache.get(key, ttl, now)
        if cached is not None:
            return cached
        payload = self._json(f"{CHART_API}/{symbol}{SUFFIX}", params)
        self._chart_cache.put(key, payload, now)
        return payload

    def _meta(self, symbol: str) -> dict[str, Any]:
        now = self._clock()
        cached = self._meta_cache.get(symbol, 300.0, now)
        if cached is not None:
            return cached
        meta: dict[str, Any] = {}
        try:
            payload = self._json(f"{CHART_API}/{symbol}{SUFFIX}", {"range": "5d", "interval": "1d"})
            result = ((payload.get("chart") or {}).get("result") or [{}])[0]
            value = result.get("meta")
            if isinstance(value, dict):
                meta = value
        except PluginError as e:
            # Symbol info is static; a throttled lookup must not stop the chart from loading.
            self._log(str(e))
        self._meta_cache.put(symbol, meta, now)
        return meta

    @staticmethod
    def _ticker(value: Any) -> str:
        symbol = str(value or "").strip().upper()
        if symbol.startswith(f"{EXCHANGE}:"):
            symbol = symbol[len(EXCHANGE) + 1:].strip()
        if symbol.endswith(SUFFIX):
            symbol = symbol[: -len(SUFFIX)]
        if not SYMBOL_RE.fullmatch(symbol):
            raise PluginError(f"{value!r} is not an NSE symbol", -32602)
        return symbol

    @staticmethod
    def _rows(payload: dict[str, Any]) -> list[list[float]]:
        chart = payload.get("chart") or {}
        error = chart.get("error")
        if error:
            message = error.get("description") or error.get("code") or str(error)
            raise PluginError(f"The market data endpoint could not serve this symbol: {message}")
        result = chart.get("result") or []
        if not result or not isinstance(result[0], dict):
            return []
        series = result[0]
        timestamps = series.get("timestamp") or []
        quotes = ((series.get("indicators") or {}).get("quote") or [{}])[0]
        if not isinstance(quotes, dict):
            return []
        fields = {name: quotes.get(name) or [] for name in ("open", "high", "low", "close", "volume")}
        bars: list[list[float]] = []
        for index, stamp in enumerate(timestamps):
            values = [fields[name][index] if index < len(fields[name]) else None for name in ("open", "high", "low", "close")]
            if any(value is None or not math.isfinite(float(value)) for value in values):
                continue
            volume = fields["volume"][index] if index < len(fields["volume"]) else None
            # NSE equities tick in paise; the source carries binary-float noise past it.
            bars.append([int(stamp), *(round(float(value), 2) for value in values), _number(volume, 0.0)])
        return bars

    # ── symbol list cache ────────────────────────────────────────────────────

    def _load_symbol_cache(self) -> bool:
        try:
            data = json.loads(self._cache_path.read_text(encoding="utf-8"))
        except (OSError, ValueError, UnicodeDecodeError):
            return False
        if not isinstance(data, dict) or data.get("version") != CACHE_VERSION:
            return False
        symbols = data.get("symbols")
        if not isinstance(symbols, list):
            return False
        rows = []
        for item in symbols:
            if not isinstance(item, dict):
                continue
            ticker = str(item.get("ticker") or "")
            if not SYMBOL_RE.fullmatch(ticker):
                continue
            rows.append(self._row(ticker, str(item.get("description") or ticker)))
        if not rows:
            return False
        self._catalog = rows
        self._catalog_at = _number(data.get("savedAt"), 0.0)
        return True

    def _save_symbol_cache(self, rows: list[dict[str, str]]) -> None:
        payload = {
            "version": CACHE_VERSION,
            "savedAt": self._clock(),
            "symbols": rows,
        }
        try:
            self._cache_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self._cache_path.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
            os.replace(temporary, self._cache_path)
        except OSError as e:
            # A read-only cache folder must not stop search: the in-memory list still works.
            self._log(f"[cache] could not save the NSE symbol list: {e}")

    def _fetch_symbol_list(self) -> list[dict[str, str]]:
        raw = self._fetch(SYMBOL_LIST_URL, accept="text/csv,*/*", timeout=8.0)
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.DictReader(io.StringIO(text))
        by_symbol: dict[str, dict[str, str]] = {}
        for item in reader:
            fields = {str(k).strip().upper(): str(v or "").strip() for k, v in item.items() if k}
            ticker = fields.get("SYMBOL", "")
            if not SYMBOL_RE.fullmatch(ticker):
                continue
            row = self._row(ticker, fields.get("SECURITY NAME") or ticker)
            # The same symbol may appear in more than one series; prefer regular equity.
            previous = by_symbol.get(ticker)
            if previous and previous["description"] and not fields.get("SERIES") == "EQ":
                continue
            by_symbol[ticker] = row
        rows = [by_symbol[key] for key in sorted(by_symbol)]
        if not rows:
            raise PluginError("The NSE symbol list was empty; using the bundled list.")
        return rows

    def _refresh_symbol_cache(self, force: bool = False) -> None:
        """Load the disk cache at once; refresh it when forced, missing or a day old."""
        with self._refresh_lock:
            now = self._clock()
            with self._catalog_lock:
                if not force and self._catalog and now - self._catalog_at < self._cache_ttl:
                    return
                if not force and not self._catalog:
                    self._load_symbol_cache()
                    now = self._clock()
                    if self._catalog and now - self._catalog_at < self._cache_ttl:
                        return
            try:
                rows = self._fetch_symbol_list()
            except PluginError as e:
                self._log(str(e))
                return
            with self._catalog_lock:
                self._catalog = rows
                self._catalog_at = self._clock()
            self._save_symbol_cache(rows)
            # A refreshed universe must not be hidden behind yesterday's typeahead results.
            self._search_cache.clear()

    def warm(self) -> None:
        """Fetch the symbol list off the request path so the first search is instant."""
        threading.Thread(target=self._refresh_symbol_cache, name="nse-symbols", daemon=True).start()

    def refresh_symbols(self) -> dict[str, int]:
        """The symbol-search refresh button: rebuild the cache even when it is fresh."""
        self._refresh_symbol_cache(force=True)
        with self._catalog_lock:
            return {"symbols": len(self._catalog)}

    # ── search ───────────────────────────────────────────────────────────────

    @staticmethod
    def _row(symbol: str, description: str) -> dict[str, str]:
        return {"ticker": symbol, "description": description or symbol, "type": "stock"}

    def search(self, query: Any) -> list[dict[str, str]]:
        # A search box can hold any text ("reliance ind"), so do not reject it as
        # a malformed ticker: keep the letters and digits a symbol may contain.
        raw = str(query or "").strip().upper()
        if raw.startswith(f"{EXCHANGE}:"):
            raw = raw[len(EXCHANGE) + 1:].strip()
        if raw.endswith(SUFFIX):
            raw = raw[: -len(SUFFIX)]
        if raw == EXCHANGE:  # the exchange name on its own asks for its listings
            raw = ""
        q = "".join(ch for ch in raw if ch.isalnum() or ch in "&.-")[:20]
        now = self._clock()
        cached = self._search_cache.get(q, 120.0, now)
        if cached is not None:
            return list(cached)

        # The full list comes from a local cache after the first load; a search never
        # waits on the network when the symbol is already known.
        self._refresh_symbol_cache()
        with self._catalog_lock:
            catalog = list(self._catalog)
        rows: list[dict[str, str]] = []
        if not q:
            rows = [self._row(symbol, name) for symbol, name in CATALOG[:12]]
        else:
            matches: list[tuple[int, str, dict[str, str]]] = []
            for row in catalog:
                ticker = row["ticker"]
                if ticker == q:
                    rank = 0
                elif ticker.startswith(q):
                    rank = 1
                elif q in ticker:
                    rank = 2
                elif raw in row["description"].upper():
                    rank = 3
                else:
                    continue
                matches.append((rank, ticker, row))
            matches.sort(key=lambda item: (item[0], item[1]))
            rows = [self._prefer_known_name(item[2]) for item in matches]
            if not rows:
                # A new listing may not be in yesterday's list: ask the live index,
                # then fall back to the bundled starters when it cannot answer.
                rows = self._search_live(q, raw)
                rows = [self._prefer_known_name(row) for row in rows]
        rows = rows[:50]
        self._search_cache.put(q, rows, now)
        return list(rows)

    @staticmethod
    def _prefer_known_name(row: dict[str, str]) -> dict[str, str]:
        known = _NAMES.get(row["ticker"])
        return NseSource._row(row["ticker"], known) if known else row

    def _search_live(self, q: str, raw: str) -> list[dict[str, str]]:
        rows: list[dict[str, str]] = []
        try:
            answer = self._json(SEARCH_API, {
                "q": f"{q}{SUFFIX}", "quotesCount": 25, "newsCount": 0, "enableFuzzyQuery": "false",
            })
            for quote in answer.get("quotes") or []:
                if not isinstance(quote, dict):
                    continue
                symbol = str(quote.get("symbol") or "")
                if not symbol.endswith(SUFFIX) or quote.get("quoteType") not in (None, "", "EQUITY"):
                    continue
                ticker = self._ticker(symbol[: -len(SUFFIX)])
                name = str(quote.get("longname") or quote.get("shortname") or _NAMES.get(ticker) or ticker)
                rows.append(self._row(ticker, name))
        except PluginError as e:
            self._log(str(e))
        for symbol, name in CATALOG:
            if q == symbol or q in symbol or raw in name.upper():
                rows.append(self._row(symbol, name))
        seen: set[str] = set()
        unique = []
        for row in rows:
            if row["ticker"] in seen:
                continue
            seen.add(row["ticker"])
            unique.append(row)
        unique.sort(key=lambda row: (
            0 if row["ticker"] == q else 1 if row["ticker"].startswith(q) else 2,
            row["ticker"],
        ))
        return unique

    def symbol_info(self, ticker: Any) -> dict[str, Any]:
        symbol = self._ticker(ticker)
        meta = self._meta(symbol)
        return {
            "description": str(meta.get("longName") or meta.get("shortName") or _NAMES.get(symbol) or symbol),
            "type": "stock",
            "currency": str(meta.get("currency") or "INR"),
            "timezone": "Asia/Kolkata",
            "session": "0915-1530:23456",
            "extended": "0900-1530:23456",
            "holidays": "",
            "pricescale": 100,
            "minmov": 1,
            "intervals": INTERVALS,
        }

    # ── bars and quotes ──────────────────────────────────────────────────────

    def bars(self, ticker: Any, resolution: Any, frm: Any, to: Any, count_back: Any) -> list[list[float]]:
        symbol = self._ticker(ticker)
        key = str(resolution or "1D").upper()
        if key not in TIMEFRAMES:
            raise PluginError(f"Resolution {resolution} is not served", -32602)
        interval, step, reach = TIMEFRAMES[key]
        count = int(_number(count_back, 500))
        count = max(1, min(count, 50_000))
        end = _number(to, 0.0)
        if end <= 0:
            end = self._clock()
        start = _number(frm, 0.0)
        if start <= 0 or start >= end:
            start = end - (count + 8) * step
        start = max(start, end - reach)
        payload = self._chart(symbol, {
            "period1": int(start), "period2": int(end) + 1, "interval": interval,
        }, 300.0 if step >= 86400 else 30.0)
        rows = self._rows(payload)
        if step >= 86400:
            # The endpoint stamps daily bars at the session open; the datafeed grammar
            # wants the trading day's midnight. Quote day bars use the same stamp.
            rows = [[_day_start(row[0]), *row[1:]] for row in rows]
            start = _day_start(int(start))
        return [row for row in rows if start <= row[0] <= end][-count:]

    def quote(self, ticker: Any) -> dict[str, Any] | None:
        symbol = self._ticker(ticker)
        payload = self._chart(symbol, {"range": "1d", "interval": "1m"}, 5.0)
        rows = self._rows(payload)
        series = ((payload.get("chart") or {}).get("result") or [{}])[0]
        meta = series.get("meta") if isinstance(series, dict) else None
        meta = meta if isinstance(meta, dict) else {}
        last = rows[-1] if rows else None
        price = _number(meta.get("regularMarketPrice"), last[4] if last else 0.0)
        if price <= 0:
            return None
        prev = _number(meta.get("chartPreviousClose") or meta.get("previousClose"), price)
        stamp = int(_number(meta.get("regularMarketTime"), last[0] if last else self._clock()))
        minute = last if last and abs(last[0] - stamp) <= 300 else None
        if minute is None:
            start = stamp - (stamp % 60)
            minute = [start, price, price, price, price, 0.0]
        day_rows = rows
        day = [
            _day_start(stamp),
            _number(meta.get("regularMarketDayOpen"), day_rows[0][1] if day_rows else price),
            _number(meta.get("regularMarketDayHigh"), max((row[2] for row in day_rows), default=price)),
            _number(meta.get("regularMarketDayLow"), min((row[3] for row in day_rows), default=price)),
            _number(meta.get("regularMarketDayVolume"), sum(row[5] for row in day_rows)),
        ]
        return {
            "ticker": symbol, "time": stamp, "price": price, "prevClose": prev,
            "minute": minute, "day": day,
        }

    # ── subscription ─────────────────────────────────────────────────────────

    def configure(self, settings: dict[str, str]) -> None:
        self._poll_seconds = min(60.0, max(5.0, _number(settings.get("pollSeconds"), 10.0)))

    def subscribe(self, tickers: list[str]) -> None:
        with self._state_lock:
            self._subs = {self._ticker(t) for t in tickers}

    def start(self, emit: Callable[[dict[str, Any]], None]) -> None:
        with self._state_lock:
            if self._thread and self._thread.is_alive():
                return
            self._emit = emit
            self._stop.clear()
            self._quote_pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="nse-quote")
            self._thread = threading.Thread(target=self._poll, name="nse-quotes", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._state_lock:
            pool, self._quote_pool = self._quote_pool, None
            self._emit = None
        if pool:
            pool.shutdown(wait=False, cancel_futures=True)

    def _poll(self) -> None:
        while not self._stop.wait(self._poll_seconds):
            with self._state_lock:
                symbols = sorted(self._subs)
                emit, pool = self._emit, self._quote_pool
            if not symbols or not emit or not pool:
                continue
            with self._inflight_lock:
                pending = [symbol for symbol in symbols if symbol not in self._inflight]
            futures = {pool.submit(self._one_quote, symbol, emit): symbol for symbol in pending}
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as e:  # noqa: BLE001 - one bad symbol must not end the feed
                    self._log(f"[quote] {futures[future]}: {e}")

    def _one_quote(self, symbol: str, emit: Callable[[dict[str, Any]], None]) -> None:
        with self._inflight_lock:
            if self._stop.is_set() or symbol in self._inflight:
                return
            self._inflight.add(symbol)
        try:
            quote = self.quote(symbol)
            if quote and not self._stop.is_set():
                emit(quote)
        finally:
            with self._inflight_lock:
                self._inflight.discard(symbol)
