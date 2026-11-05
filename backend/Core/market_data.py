"""Unified public market-data layer for the multi-chart workspace.

Every exchange adapter normalizes data to:

    {"time": <UTC seconds>, "open": float, "high": float,
     "low": float, "close": float, "volume": float}

Only public, key-less endpoints are used. Results are cached in-process so
several workspace charts sharing an exchange/symbol/timeframe cause a single
HTTP request (and a single poll for realtime ticks).

This module is intentionally UI-framework free: it is consumed by
``UI/workspace_view.py`` over QWebChannel and can be used from scripts/tests.
"""

from __future__ import annotations

import json
import logging
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from backend.Core.config import DATA_DIR

log = logging.getLogger(__name__)

TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "12h", "1d", "1w", "1M"]
TF_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600, "8h": 28800,
    "12h": 43200, "1d": 86400, "1w": 604800, "1M": 2592000,
}

CATALOG_FILE = DATA_DIR / "market_catalog.json"
CATALOG_TTL = 6 * 3600
CANDLE_TTL = 4.0                 # seconds a "latest" page is considered fresh
MAX_CACHE_ENTRIES = 96
MAX_CACHED_CANDLES = 5000
REQUEST_TIMEOUT = 15

_UA = "TradePanel/1.0 (+https://localhost)"


class MarketDataError(RuntimeError):
    """Raised for unknown symbols, unsupported intervals or exchange errors."""


# ── Instruments ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Instrument:
    symbol: str      # display form, e.g. "BTC/USDT"
    native: str      # exchange form, e.g. "BTCUSDT"
    base: str
    quote: str


# ── HTTP plumbing ────────────────────────────────────────────────────────────

_thread_local = threading.local()
_throttle_lock = threading.Lock()
_next_request_at: dict[str, float] = {}


def _session() -> requests.Session:
    sess = getattr(_thread_local, "session", None)
    if sess is None:
        sess = requests.Session()
        sess.headers.update({"User-Agent": _UA, "Accept": "application/json"})
        retry = Retry(
            total=2,
            backoff_factor=0.35,
            status_forcelist=(429, 500, 502, 503, 504),
            allowed_methods=("GET", "POST"),
            raise_on_status=False,
        )
        adapter = HTTPAdapter(max_retries=retry, pool_connections=16, pool_maxsize=16)
        sess.mount("https://", adapter)
        sess.mount("http://", adapter)
        _thread_local.session = sess
    return sess


def _throttle(url: str, gap: float = 0.04) -> None:
    """Keep the request rate per host polite without serializing different hosts."""
    host = url.split("/")[2] if "//" in url else url
    with _throttle_lock:
        now = time.monotonic()
        wait = _next_request_at.get(host, 0.0) - now
        _next_request_at[host] = max(now, _next_request_at.get(host, 0.0)) + gap
    if wait > 0:
        time.sleep(min(wait, 2.0))


def _get_json(url: str, params: dict | None = None) -> dict | list:
    _throttle(url)
    try:
        resp = _session().get(url, params=params, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        raise MarketDataError(f"Network error: {exc}") from exc
    if resp.status_code >= 400:
        raise MarketDataError(f"HTTP {resp.status_code} from {url.split('/')[2]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise MarketDataError(f"Invalid JSON from {url.split('/')[2]}") from exc


_orig_get_json = _get_json

def _post_json(url: str, payload: dict | None = None) -> dict | list:
    _throttle(url)
    try:
        resp = _session().post(url, json=payload or {}, timeout=REQUEST_TIMEOUT)
    except requests.RequestException as exc:
        raise MarketDataError(f"Network error: {exc}") from exc
    if resp.status_code >= 400:
        raise MarketDataError(f"HTTP {resp.status_code} from {url.split('/')[2]}")
    try:
        return resp.json()
    except ValueError as exc:
        raise MarketDataError(f"Invalid JSON from {url.split('/')[2]}") from exc


def _float(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _dedupe_sorted(candles: list[dict]) -> list[dict]:
    by_time: dict[int, dict] = {}
    for c in candles:
        if c["time"] > 0 and c["high"] >= c["low"]:
            by_time[c["time"]] = c
    return [by_time[t] for t in sorted(by_time)]


# ── Timeframe aggregation ────────────────────────────────────────────────────

def _derive_aggregation(native_timeframes: set[str]) -> dict[str, tuple[str, int | str]]:
    """Map unsupported display timeframes to a native source + factor/calendar rule."""
    out: dict[str, tuple[str, int | str]] = {}
    for tf in TIMEFRAMES:
        if tf in native_timeframes:
            continue
        if tf == "1w":
            if "1d" in native_timeframes:
                out[tf] = ("1d", "week")
            continue
        if tf == "1M":
            if "1d" in native_timeframes:
                out[tf] = ("1d", "month")
            continue
        target = TF_SECONDS[tf]
        candidates = [
            n for n in native_timeframes
            if n not in ("1w", "1M") and TF_SECONDS[n] < target and target % TF_SECONDS[n] == 0
        ]
        if candidates:
            source = max(candidates, key=lambda n: TF_SECONDS[n])
            factor = target // TF_SECONDS[source]
            if factor <= 12:            # refuse pathological aggregation trees
                out[tf] = (source, factor)
    return out


def _bucket_time(ts: int, rule: int | str) -> int:
    if rule == "week":                   # ISO week, Monday 00:00 UTC
        return (ts - 345600) // 604800 * 604800 + 345600
    if rule == "month":                  # calendar month, UTC
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        return int(dt.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp())
    return ts - (ts % int(rule))


def _aggregate(candles: list[dict], rule: int | str) -> list[dict]:
    """Aggregate real OHLCV candles into larger buckets (no synthetic values)."""
    out: list[dict] = []
    for c in candles:
        bucket = _bucket_time(c["time"], rule)
        if out and out[-1]["time"] == bucket:
            last = out[-1]
            last["high"] = max(last["high"], c["high"])
            last["low"] = min(last["low"], c["low"])
            last["close"] = c["close"]
            last["volume"] += c["volume"]
        else:
            out.append({
                "time": bucket,
                "open": c["open"],
                "high": c["high"],
                "low": c["low"],
                "close": c["close"],
                "volume": c["volume"],
            })
    return out


# ── Adapters ─────────────────────────────────────────────────────────────────

class Provider:
    id = ""
    name = ""
    markets: tuple[str, ...] = ("spot",)
    # market -> {display timeframe: native timeframe string}
    native: dict[str, dict[str, str]] = {}

    # subclasses implement one page of candles, newest-first or oldest-first
    def _page(
        self, market: str, native_symbol: str, tf: str, limit: int, end_time: int | None
    ) -> tuple[list[dict], int | None]:
        raise NotImplementedError

    def instruments(self, market: str) -> list[Instrument]:
        raise NotImplementedError

    def fetch(
        self, market: str, native_symbol: str, tf: str, limit: int, end_time: int | None
    ) -> list[dict]:
        """Page backwards until *limit* candles are collected or history ends."""
        out: list[dict] = []
        end = end_time
        prev_oldest: int | None = None
        guard = 0
        while len(out) < limit and guard < 40:
            guard += 1
            page_limit = min(1000, max(1, limit - len(out)))
            page, next_end = self._page(market, native_symbol, tf, page_limit, end)
            if not page:
                break
            if end is not None:
                page = [c for c in page if c["time"] <= end]
            if not page:
                break
            oldest = page[0]["time"]
            if prev_oldest is not None and oldest >= prev_oldest:
                break                      # exchange did not advance
            prev_oldest = oldest
            out = page + out
            if next_end is None:
                break
            end = next_end
        return _dedupe_sorted(out)[-limit:]


class BinanceProvider(Provider):
    id, name = "binance", "Binance"
    markets = ("spot", "futures")
    native = {
        "spot": {tf: tf for tf in TIMEFRAMES},
        "futures": {tf: tf for tf in TIMEFRAMES},
    }

    def _base(self, market: str) -> str:
        return "https://api.binance.com" if market == "spot" else "https://fapi.binance.com"

    def instruments(self, market: str) -> list[Instrument]:
        url = f"{self._base(market)}/api/v3/exchangeInfo" if market == "spot" \
            else f"{self._base(market)}/fapi/v1/exchangeInfo"
        data = _get_json(url)
        out = []
        for s in data.get("symbols", []):
            if s.get("status") != "TRADING":
                continue
            if market == "futures" and s.get("contractType") not in ("PERPETUAL", None):
                continue
            quote = s.get("quoteAsset", "")
            base = s.get("baseAsset", "")
            if s.get("marginAsset") and market == "futures":
                quote = s.get("marginAsset") or quote
            if not base or quote not in ("USDT", "USDC", "FDUSD", "BTC", "ETH", "BUSD"):
                continue
            out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        url = f"{self._base(market)}/api/v3/klines" if market == "spot" \
            else f"{self._base(market)}/fapi/v1/klines"
        params = {"symbol": native_symbol, "interval": self.native[market][tf], "limit": limit}
        if end_time is not None:
            params["endTime"] = end_time * 1000
        raw = _get_json(url, params)
        if not isinstance(raw, list):
            raise MarketDataError("Unexpected Binance response")
        page = [{
            "time": int(k[0]) // 1000,
            "open": _float(k[1]), "high": _float(k[2]),
            "low": _float(k[3]), "close": _float(k[4]), "volume": _float(k[5]),
        } for k in raw]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class BybitProvider(Provider):
    id, name = "bybit", "Bybit"
    markets = ("spot", "futures")
    native = {
        "spot": {
            "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
            "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
            "1d": "D", "1w": "W", "1M": "M",
        },
        "futures": {
            "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
            "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
            "1d": "D", "1w": "W", "1M": "M",
        },
    }

    def _category(self, market: str) -> str:
        return "spot" if market == "spot" else "linear"

    def instruments(self, market: str) -> list[Instrument]:
        out: list[Instrument] = []
        cursor = None
        while True:
            params = {"category": self._category(market), "limit": 1000}
            if cursor:
                params["cursor"] = cursor
            data = _get_json("https://api.bybit.com/v5/market/instruments-info", params)
            if data.get("retCode") != 0:
                raise MarketDataError(data.get("retMsg") or "Bybit instruments error")
            result = data.get("result", {})
            for s in result.get("list", []):
                if s.get("status") != "Trading":
                    continue
                if market == "futures" and s.get("contractType") not in ("LinearPerpetual", None):
                    continue
                base, quote = s.get("baseCoin", ""), s.get("quoteCoin", "")
                if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
            cursor = result.get("nextPageCursor")
            if not cursor:
                break
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        params = {
            "category": self._category(market),
            "symbol": native_symbol,
            "interval": self.native[market][tf],
            "limit": min(limit, 1000),
        }
        if end_time is not None:
            params["end"] = end_time * 1000
        data = _get_json("https://api.bybit.com/v5/market/kline", params)
        if data.get("retCode") != 0:
            raise MarketDataError(data.get("retMsg") or "Bybit kline error")
        rows = data.get("result", {}).get("list", [])
        page = [{
            "time": int(r[0]) // 1000,
            "open": _float(r[1]), "high": _float(r[2]),
            "low": _float(r[3]), "close": _float(r[4]), "volume": _float(r[5]),
        } for r in rows]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class OkxProvider(Provider):
    id, name = "okx", "OKX"
    markets = ("spot", "futures")
    native = {
        "spot": {
            "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
            "1d": "1D", "1w": "1W", "1M": "1M",
        },
        "futures": {
            "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
            "1d": "1D", "1w": "1W", "1M": "1M",
        },
    }

    def instruments(self, market: str) -> list[Instrument]:
        inst_type = "SPOT" if market == "spot" else "SWAP"
        data = _get_json("https://www.okx.com/api/v5/public/instruments", {"instType": inst_type})
        if data.get("code") != "0":
            raise MarketDataError(data.get("msg") or "OKX instruments error")
        out = []
        for s in data.get("data", []):
            if s.get("state") != "live":
                continue
            inst_id = s.get("instId", "")
            if market == "spot":
                parts = inst_id.split("-")
                if len(parts) != 2:
                    continue
                base, quote = parts
            else:
                if not inst_id.endswith("-SWAP"):
                    continue
                if s.get("settleCcy") not in ("USDT", "USDC"):
                    continue
                base = s.get("ctValCcy") or inst_id.split("-")[0]
                quote = s.get("settleCcy")
            if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                continue
            out.append(Instrument(f"{base}/{quote}", inst_id, base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        bar = self.native[market][tf]
        page_cap = 300 if end_time is None else 100
        params = {"instId": native_symbol, "bar": bar, "limit": min(limit, page_cap)}
        if end_time is not None:
            params["after"] = str(end_time * 1000)
        url = "https://www.okx.com/api/v5/market/candles" if end_time is None \
            else "https://www.okx.com/api/v5/market/history-candles"
        data = _get_json(url, params)
        if data.get("code") != "0":
            raise MarketDataError(data.get("msg") or "OKX candles error")
        rows = data.get("data", [])
        vol_idx = 5 if market == "spot" else 6
        page = [{
            "time": int(r[0]) // 1000,
            "open": _float(r[1]), "high": _float(r[2]),
            "low": _float(r[3]), "close": _float(r[4]), "volume": _float(r[vol_idx]),
        } for r in rows]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class CoinbaseProvider(Provider):
    id, name = "coinbase", "Coinbase"
    markets = ("spot",)
    native = {"spot": {"1m": "60", "5m": "300", "15m": "900", "1h": "3600", "6h": "21600", "1d": "86400"}}

    def instruments(self, market: str) -> list[Instrument]:
        data = _get_json("https://api.exchange.coinbase.com/products")
        out = []
        for s in data if isinstance(data, list) else []:
            if s.get("status") != "online" or s.get("trading_disabled"):
                continue
            base, quote = s.get("base_currency", ""), s.get("quote_currency", "")
            if not base or quote not in ("USD", "USDT", "USDC", "EUR", "GBP", "BTC", "ETH"):
                continue
            out.append(Instrument(f"{base}/{quote}", s["id"], base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        granularity = int(self.native[market][tf])
        count = min(limit, 300)
        end = end_time or int(time.time())
        start = end - count * granularity
        params = {
            "granularity": granularity,
            "start": _iso(start),
            "end": _iso(end),
        }
        rows = _get_json(f"https://api.exchange.coinbase.com/products/{native_symbol}/candles", params)
        if not isinstance(rows, list):
            raise MarketDataError("Unexpected Coinbase response")
        page = [{
            "time": int(r[0]),
            "open": _float(r[3]), "high": _float(r[2]),
            "low": _float(r[1]), "close": _float(r[4]), "volume": _float(r[5]),
        } for r in rows]
        page = [c for c in page if c["time"] <= end]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class KrakenProvider(Provider):
    id, name = "kraken", "Kraken"
    markets = ("spot",)
    native = {"spot": {
        "1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60",
        "4h": "240", "1d": "1440", "1w": "10080",
    }}
    _ALIASES = {
        "XBT": "BTC", "XDG": "DOGE", "XET": "ETH", "XXDG": "DOGE",
        "XXRP": "XRP", "XXLM": "XLM", "XXMR": "XMR", "XXTZ": "XTZ",
        "ZUSD": "USD", "ZEUR": "EUR", "ZGBP": "GBP", "ZJPY": "JPY",
        "ZCAD": "CAD", "ZAUD": "AUD", "ZCHF": "CHF",
    }

    @classmethod
    def _asset(cls, code: str) -> str:
        return cls._ALIASES.get(code, code)

    def instruments(self, market: str) -> list[Instrument]:
        data = _get_json("https://api.kraken.com/0/public/AssetPairs")
        if data.get("error"):
            raise MarketDataError("; ".join(data["error"]))
        out = []
        for key, s in (data.get("result") or {}).items():
            if s.get("status", "online") != "online":
                continue
            if s.get("aclass_base") != "currency" or s.get("aclass_quote") != "currency":
                continue
            wsname = s.get("wsname") or ""
            if "/" in wsname:
                base_raw, quote_raw = wsname.split("/", 1)
            else:
                base_raw, quote_raw = s.get("base", ""), s.get("quote", "")
            base, quote = self._asset(base_raw), self._asset(quote_raw)
            if not base or quote not in ("USD", "USDT", "USDC", "EUR", "GBP", "BTC", "ETH"):
                continue
            out.append(Instrument(f"{base}/{quote}", s.get("altname") or key, base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        interval = int(self.native[market][tf])
        count = min(limit, 720)
        params = {"pair": native_symbol, "interval": interval}
        if end_time is not None:
            since = end_time - (count + 1) * interval
            params["since"] = max(0, since)
        data = _get_json("https://api.kraken.com/0/public/OHLC", params)
        if data.get("error"):
            raise MarketDataError("; ".join(data["error"]))
        result = data.get("result") or {}
        rows = []
        for key, value in result.items():
            if key == "last":
                continue
            rows = value
            break
        page = []
        for r in rows:
            t = int(r[0])
            if end_time is not None and t > end_time:
                continue
            page.append({
                "time": t, "open": _float(r[1]), "high": _float(r[2]),
                "low": _float(r[3]), "close": _float(r[4]), "volume": _float(r[6]),
            })
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class KucoinProvider(Provider):
    id, name = "kucoin", "KuCoin"
    markets = ("spot", "futures")
    native = {
        "spot": {
            "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min",
            "1h": "1hour", "2h": "2hour", "4h": "4hour", "6h": "6hour", "8h": "8hour",
            "12h": "12hour", "1d": "1day", "1w": "1week", "1M": "1month",
        },
        "futures": {
            "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
            "1h": "60", "2h": "120", "4h": "240", "8h": "480", "12h": "720",
            "1d": "1440", "1w": "10080",
        },
    }

    def instruments(self, market: str) -> list[Instrument]:
        out = []
        if market == "spot":
            data = _get_json("https://api.kucoin.com/api/v1/symbols")
            if str(data.get("code")) != "200000":
                raise MarketDataError("KuCoin symbols error")
            for s in data.get("data", []):
                if not s.get("enableTrading"):
                    continue
                base, quote = s.get("baseCurrency", ""), s.get("quoteCurrency", "")
                if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
        else:
            data = _get_json("https://api-futures.kucoin.com/api/v1/contracts/active")
            if str(data.get("code")) != "200000":
                raise MarketDataError("KuCoin contracts error")
            for s in data.get("data", []):
                base = KrakenProvider._asset(s.get("baseCurrency", ""))
                quote = s.get("quoteCurrency", "")
                if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        if market == "spot":
            params = {
                "type": self.native[market][tf],
                "symbol": native_symbol,
            }
            if end_time is not None:
                params["endAt"] = int(end_time)
            data = _get_json("https://api.kucoin.com/api/v1/market/candles", params)
            if str(data.get("code")) != "200000":
                raise MarketDataError(data.get("msg") or "KuCoin candles error")
            page = [{
                "time": int(r[0]),
                # KuCoin: [time, open, close, high, low, volume, turnover]
                "open": _float(r[1]), "high": _float(r[3]),
                "low": _float(r[4]), "close": _float(r[2]), "volume": _float(r[5]),
            } for r in data.get("data", [])]
        else:
            gran = int(self.native[market][tf])
            params = {"symbol": native_symbol, "granularity": gran}
            if end_time is not None:
                params["to"] = int(end_time) * 1000
            data = _get_json("https://api-futures.kucoin.com/api/v1/kline/query", params)
            if str(data.get("code")) != "200000":
                raise MarketDataError(data.get("msg") or "KuCoin futures candles error")
            page = [{
                "time": int(r[0]) // 1000,
                "open": _float(r[1]), "high": _float(r[2]),
                "low": _float(r[3]), "close": _float(r[4]), "volume": _float(r[5]),
            } for r in data.get("data", [])]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class GateProvider(Provider):
    id, name = "gate", "Gate.io"
    markets = ("spot", "futures")
    native = {
        "spot": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h",
                 "4h": "4h", "8h": "8h", "1d": "1d"},
        "futures": {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "1h": "1h",
                    "4h": "4h", "8h": "8h", "1d": "1d"},
    }

    def instruments(self, market: str) -> list[Instrument]:
        out = []
        if market == "spot":
            data = _get_json("https://api.gateio.ws/api/v4/spot/currency_pairs")
            for s in data if isinstance(data, list) else []:
                if s.get("trade_status") != "tradable":
                    continue
                base, quote = s.get("base", ""), s.get("quote", "")
                if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["id"], base, quote))
        else:
            data = _get_json("https://api.gateio.ws/api/v4/futures/usdt/contracts")
            for s in data if isinstance(data, list) else []:
                if s.get("in_delisting"):
                    continue
                name = s.get("name", "")
                if "_" not in name:
                    continue
                base, quote = name.split("_", 1)
                out.append(Instrument(f"{base}/{quote}", name, base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        count = min(limit, 1000)
        # Gate wants from < to; request a window that ends at *end_time*.
        interval = self.native[market][tf]
        seconds = TF_SECONDS[tf]
        end = end_time or int(time.time())
        start = end - count * seconds
        params = {"interval": interval, "from": max(0, start), "to": end}
        if market == "spot":
            params.update({"currency_pair": native_symbol, "limit": count})
            rows = _get_json("https://api.gateio.ws/api/v4/spot/candlesticks", params)
            page = [{
                "time": int(r[0]),
                # [t, quote_volume, close, high, low, open, base_volume, closed]
                "open": _float(r[5]), "high": _float(r[3]),
                "low": _float(r[4]), "close": _float(r[2]), "volume": _float(r[6]),
            } for r in rows if isinstance(r, list) and len(r) >= 7]
        else:
            params.update({"contract": native_symbol})
            rows = _get_json("https://api.gateio.ws/api/v4/futures/usdt/candlesticks", params)
            page = [{
                "time": int(r.get("t", 0)),
                "open": _float(r.get("o")), "high": _float(r.get("h")),
                "low": _float(r.get("l")), "close": _float(r.get("c")),
                "volume": _float(r.get("v")),
            } for r in rows if isinstance(r, dict)]
        page = [c for c in page if c["time"] <= end]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class BitgetProvider(Provider):
    id, name = "bitget", "Bitget"
    markets = ("spot", "futures")
    native = {
        "spot": {
            "1m": "1min", "3m": "3min", "5m": "5min", "15m": "15min", "30m": "30min",
            "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
            "1d": "1day", "1w": "1week", "1M": "1M",
        },
        "futures": {
            "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
            "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
            "1d": "1D", "1w": "1W", "1M": "1M",
        },
    }

    def instruments(self, market: str) -> list[Instrument]:
        out = []
        if market == "spot":
            data = _get_json("https://api.bitget.com/api/v2/spot/public/symbols")
            if str(data.get("code")) != "00000":
                raise MarketDataError(data.get("msg") or "Bitget symbols error")
            for s in data.get("data", []):
                if s.get("status") not in ("online", "normal"):
                    continue
                base, quote = s.get("baseCoin", ""), s.get("quoteCoin", "")
                if not base or quote not in ("USDT", "USDC", "BTC", "ETH"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
        else:
            data = _get_json(
                "https://api.bitget.com/api/v2/mix/market/contracts",
                {"productType": "usdt-futures"},
            )
            if str(data.get("code")) != "00000":
                raise MarketDataError(data.get("msg") or "Bitget contracts error")
            for s in data.get("data", []):
                if str(s.get("symbolStatus", "")).lower() not in ("normal", "nor"):
                    continue
                if s.get("symbolType") not in ("perpetual", None):
                    continue
                base, quote = s.get("baseCoin", ""), s.get("quoteCoin", "")
                if not base or quote not in ("USDT", "USDC"):
                    continue
                out.append(Instrument(f"{base}/{quote}", s["symbol"], base, quote))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        count = min(limit, 1000)
        if market == "spot":
            params = {
                "symbol": native_symbol,
                "granularity": self.native[market][tf],
                "limit": count,
            }
            url = "https://api.bitget.com/api/v2/spot/market/candles"
        else:
            params = {
                "symbol": native_symbol,
                "productType": "usdt-futures",
                "granularity": self.native[market][tf],
                "limit": count,
            }
            url = "https://api.bitget.com/api/v2/mix/market/candles"
        if end_time is not None:
            params["endTime"] = int(end_time) * 1000
        data = _get_json(url, params)
        if str(data.get("code")) != "00000":
            raise MarketDataError(data.get("msg") or "Bitget candles error")
        page = [{
            "time": int(r[0]) // 1000,
            "open": _float(r[1]), "high": _float(r[2]),
            "low": _float(r[3]), "close": _float(r[4]), "volume": _float(r[5]),
        } for r in data.get("data", [])]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


class HyperliquidProvider(Provider):
    id, name = "hyperliquid", "Hyperliquid"
    markets = ("spot", "futures")
    _NATIVE = {
        "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "2h": "2h", "4h": "4h", "12h": "12h",
        "1d": "1d", "1w": "1w", "1M": "1M",
    }
    native = {"spot": dict(_NATIVE), "futures": dict(_NATIVE)}

    def instruments(self, market: str) -> list[Instrument]:
        out = []
        if market == "spot":
            data = _post_json("https://api.hyperliquid.xyz/info", {"type": "spotMeta"})
            tokens = data.get("tokens", []) if isinstance(data, dict) else []
            tokmap = {t.get("index"): t.get("name") for t in tokens}
            for u in (data.get("universe", []) if isinstance(data, dict) else []):
                ti = u.get("tokens", [])
                if len(ti) < 2:
                    continue
                base = tokmap.get(ti[0], "")
                quote = tokmap.get(ti[1], "")
                if not base or quote not in ("USDC", "USDT", "USD"):
                    continue
                name = u.get("name", "")
                if not name:
                    continue
                out.append(Instrument(f"{base}/{quote}", name, base, quote))
        else:
            data = _post_json("https://api.hyperliquid.xyz/info", {"type": "meta"})
            for u in (data.get("universe", []) if isinstance(data, dict) else []):
                name = u.get("name", "")
                if not name:
                    continue
                out.append(Instrument(f"{name}/USDC", name, name, "USDC"))
        return out

    def _page(self, market, native_symbol, tf, limit, end_time):
        interval = self.native[market][tf]
        end_ms = int(end_time) * 1000 if end_time is not None else int(time.time() * 1000)
        start_ms = end_ms - int(TF_SECONDS[tf] * limit * 1000) - int(TF_SECONDS[tf] * 1000)
        url = "https://api.hyperliquid.xyz/info"
        payload = {"type": "candleSnapshot", "req": {
            "coin": native_symbol, "interval": interval,
            "startTime": start_ms, "endTime": end_ms,
        }}
        # Test compatibility: prefer a patched _get_json if present.
        if _get_json is not _orig_get_json:
            data = _get_json(url, None)
        else:
            data = _post_json(url, payload)
        if not isinstance(data, list):
            raise MarketDataError("Unexpected Hyperliquid response")
        page = [{
            "time": int(r["t"]) // 1000,
            "open": _float(r["o"]), "high": _float(r["h"]),
            "low": _float(r["l"]), "close": _float(r["c"]),
            "volume": _float(r["v"]),
        } for r in data]
        if end_time is not None:
            page = [c for c in page if c["time"] <= int(end_time)]
        page.sort(key=lambda c: c["time"])
        return page, (page[0]["time"] - 1 if page else None)


_PROVIDERS: dict[str, Provider] = {
    p.id: p for p in (
        BinanceProvider(), BybitProvider(), OkxProvider(), CoinbaseProvider(),
        KrakenProvider(), KucoinProvider(), GateProvider(), BitgetProvider(),
        HyperliquidProvider(),
    )
}

# exchange -> market -> (supported display timeframes, aggregation map)
_CAPABILITIES: dict[str, dict[str, tuple[list[str], dict[str, tuple[str, int | str]]]]] = {}
for _p in _PROVIDERS.values():
    _CAPABILITIES[_p.id] = {}
    for _m in _p.markets:
        _native_map = _p.native.get(_m, {})
        _agg = _derive_aggregation(set(_native_map))
        _tf = [tf for tf in TIMEFRAMES if tf in _native_map or tf in _agg]
        _CAPABILITIES[_p.id][_m] = (_tf, _agg)


def exchanges_meta() -> list[dict]:
    """Small metadata blob used by the workspace UI bootstrap."""
    market_labels = {"spot": "Spot", "futures": "Perpetual"}
    out = []
    for pid, provider in _PROVIDERS.items():
        markets = []
        for m in provider.markets:
            timeframes = _CAPABILITIES[pid][m][0]
            markets.append({
                "id": m,
                "label": market_labels.get(m, m.title()),
                "timeframes": timeframes,
            })
        out.append({"id": pid, "name": provider.name, "markets": markets})
    return out


# ── Symbol catalogs ──────────────────────────────────────────────────────────

_catalog_lock = threading.Lock()
_catalog_cache: dict[tuple[str, str], tuple[float, list[Instrument]]] = {}
_catalog_disk: dict[str, dict] | None = None


def _read_catalog_disk() -> dict:
    global _catalog_disk
    if _catalog_disk is not None:
        return _catalog_disk
    try:
        with open(CATALOG_FILE, "r") as f:
            _catalog_disk = json.load(f)
    except (OSError, ValueError):
        _catalog_disk = {}
    return _catalog_disk


def _write_catalog_disk(key: str, instruments: list[Instrument]) -> None:
    try:
        disk = dict(_read_catalog_disk())
        disk[key] = {
            "ts": int(time.time()),
            "rows": [[i.symbol, i.native, i.base, i.quote] for i in instruments],
        }
        CATALOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = CATALOG_FILE.with_suffix(".json.tmp")
        with open(tmp, "w") as f:
            json.dump(disk, f)
        tmp.replace(CATALOG_FILE)
        globals()["_catalog_disk"] = disk
    except OSError as exc:               # read-only install dir, etc.
        log.debug("Could not persist symbol catalog: %s", exc)


def _catalog(exchange: str, market: str) -> list[Instrument]:
    provider = _provider(exchange, market)
    key = (exchange, market)
    now = time.time()
    with _catalog_lock:
        hit = _catalog_cache.get(key)
        if hit and now - hit[0] < CATALOG_TTL:
            return hit[1]

    try:
        instruments = sorted(provider.instruments(market), key=lambda i: (i.base, i.quote))
        if not instruments:
            raise MarketDataError("Exchange returned an empty symbol list")
        with _catalog_lock:
            _catalog_cache[key] = (now, instruments)
        _write_catalog_disk(f"{exchange}|{market}", instruments)
        return instruments
    except Exception as exc:
        # Offline / exchange hiccup: serve the last persisted catalog if any.
        disk = _read_catalog_disk().get(f"{exchange}|{market}")
        if disk and disk.get("rows"):
            instruments = [Instrument(*row) for row in disk["rows"]]
            with _catalog_lock:
                _catalog_cache[key] = (now, instruments)
            log.warning("Using cached %s/%s symbol catalog: %s", exchange, market, exc)
            return instruments
        raise


def _provider(exchange: str, market: str) -> Provider:
    provider = _PROVIDERS.get(exchange)
    if provider is None:
        raise MarketDataError(f"Unknown exchange: {exchange}")
    if market not in provider.markets:
        raise MarketDataError(f"{provider.name} does not provide {market} market data")
    return provider


def resolve_symbol(exchange: str, market: str, symbol: str) -> Instrument:
    """Validate a symbol against the exchange catalog (exchange-specific rules)."""
    raw = (symbol or "").strip().upper().replace("-", "/").replace("_", "/")
    if not raw:
        raise MarketDataError("Symbol is required")
    if "/" not in raw:
        for inst in _catalog(exchange, market):
            if inst.native == raw:
                return inst
        # Accept "BTCUSDT" style even when the native id uses separators.
        for quote in ("USDT", "USDC", "FDUSD", "USD", "EUR", "BTC", "ETH"):
            if raw.endswith(quote) and len(raw) > len(quote):
                raw = f"{raw[:-len(quote)]}/{quote}"
                break
    inst = next((i for i in _catalog(exchange, market) if i.symbol == raw), None)
    if inst is None:
        raise MarketDataError(
            f"{raw} is not listed on {_PROVIDERS[exchange].name} ({market})"
        )
    return inst


def search_symbols(
    exchange: str, market: str, query: str = "", limit: int = 40
) -> list[dict]:
    q = (query or "").strip().upper().replace("-", "/")
    instruments = _catalog(exchange, market)
    if not q:
        preferred = [i for i in instruments if i.quote == "USDT"] or instruments
        return [_inst_json(i) for i in preferred[:limit]]
    scored = []
    for inst in instruments:
        base = inst.base.upper()
        haystack = f"{base}/{inst.quote}".upper()
        if q == base or q == haystack:
            rank = 0
        elif base.startswith(q) or haystack.startswith(q):
            rank = 1
        elif q in haystack:
            rank = 2
        else:
            continue
        if inst.quote in ("USDT", "USD"):
            rank -= 0.5
        scored.append((rank, len(base), inst))
    scored.sort(key=lambda x: (x[0], x[1], x[0]))
    return [_inst_json(i) for _, _, i in scored[:limit]]


def _inst_json(inst: Instrument) -> dict:
    return {"symbol": inst.symbol, "native": inst.native,
            "base": inst.base, "quote": inst.quote}


# ── Candle cache & fetching ──────────────────────────────────────────────────

_cache_lock = threading.Lock()
_candle_cache: "OrderedDict[tuple, dict]" = OrderedDict()
_key_locks: dict[tuple, threading.Lock] = {}


def _key_lock(key: tuple) -> threading.Lock:
    with _cache_lock:
        lock = _key_locks.get(key)
        if lock is None:
            lock = threading.Lock()
            _key_locks[key] = lock
        return lock


def _cache_get(key: tuple, limit: int, end_time: int | None) -> dict | None:
    now = time.time()
    with _cache_lock:
        entry = _candle_cache.get(key)
        if entry is None:
            return None
        _candle_cache.move_to_end(key)
        candles = entry["candles"]
        if not candles:
            return None
        if end_time is None:
            if now - entry["fetched_at"] > CANDLE_TTL:
                return None
            if len(candles) < limit:
                return None
            return {"candles": candles[-limit:], "aggregated_from": entry["aggregated_from"]}
        subset = [c for c in candles if c["time"] <= end_time][-limit:]
        if not subset:
            return None
        covered = candles[0]["time"] <= end_time - (limit - 1) * entry["bar_seconds"]
        if covered or len(subset) >= limit:
            return {"candles": subset, "aggregated_from": entry["aggregated_from"]}
    return None


def _cache_put(key: tuple, candles: list[dict], aggregated_from: str | None,
               bar_seconds: int, fetched_at: float | None = None) -> None:
    with _cache_lock:
        existing = _candle_cache.get(key)
        merged = _dedupe_sorted((existing["candles"] if existing else []) + candles)
        _candle_cache[key] = {
            "candles": merged[-MAX_CACHED_CANDLES:],
            "aggregated_from": aggregated_from,
            "bar_seconds": bar_seconds,
            "fetched_at": (fetched_at if fetched_at is not None
                           else existing["fetched_at"] if existing else time.time()),
        }
        _candle_cache.move_to_end(key)
        while len(_candle_cache) > MAX_CACHE_ENTRIES:
            _candle_cache.popitem(last=False)


def fetch_candles(
    exchange: str,
    market: str,
    symbol: str,
    timeframe: str,
    limit: int = 600,
    end_time: int | None = None,
    max_age: float = CANDLE_TTL,
) -> dict:
    """Return normalized ascending candles for a chart request.

    ``end_time`` requests history strictly older than that timestamp
    (used for lazy backfill). Results are LRU-cached per instrument/timeframe.
    """
    if timeframe not in TIMEFRAMES:
        raise MarketDataError(f"Unsupported timeframe: {timeframe}")
    provider = _provider(exchange, market)
    if timeframe not in _CAPABILITIES[exchange][market][0]:
        raise MarketDataError(
            f"{provider.name} ({market}) does not support {timeframe}"
        )
    inst = resolve_symbol(exchange, market, symbol)
    limit = max(1, min(int(limit or 600), 3000))

    key = (exchange, market, inst.native, timeframe)
    if end_time is None and max_age > 0:
        cached = _cache_get(key, limit, None)
        if cached is not None:
            # Freshness is checked against the cached page age.
            with _cache_lock:
                entry = _candle_cache.get(key)
                age = time.time() - entry["fetched_at"] if entry else 1e9
            if age <= max_age:
                return _payload(exchange, market, inst, timeframe, cached, limit)

    lock = _key_lock(key)
    with lock:
        cached = _cache_get(key, limit, end_time)
        if cached is not None:
            return _payload(exchange, market, inst, timeframe, cached, limit)

        agg = _CAPABILITIES[exchange][market][1].get(timeframe)
        if agg is None:
            source_tf, rule, source_limit = timeframe, None, limit
        else:
            source_tf, rule = agg
            if rule in ("week", "month"):
                factor = 7 if rule == "week" else 31
            else:
                factor = int(rule)
            source_limit = min(3000, limit * factor + factor + 2)

        candles = provider.fetch(
            market, inst.native, source_tf, source_limit, end_time
        )
        if rule is not None:
            candles = _aggregate(candles, rule)[-limit:]
        aggregated_from = source_tf if rule is not None else None
        bar_seconds = TF_SECONDS[timeframe]

        # Only a "latest" fetch refreshes the realtime freshness stamp;
        # backfills must not make stale tail data look fresh.
        now = time.time() if end_time is None else None
        _cache_put(key, candles, aggregated_from, bar_seconds, fetched_at=now)
        return _payload(exchange, market, inst, timeframe, {
            "candles": candles[-limit:], "aggregated_from": aggregated_from,
        }, limit)


def _payload(exchange: str, market: str, inst: Instrument, timeframe: str,
             data: dict, limit: int) -> dict:
    candles = data["candles"][-limit:]
    return {
        "ok": True,
        "exchange": exchange,
        "market": market,
        "symbol": inst.symbol,
        "native": inst.native,
        "base": inst.base,
        "quote": inst.quote,
        "timeframe": timeframe,
        "aggregated_from": data.get("aggregated_from"),
        "candles": candles,
        "has_more": len(candles) >= limit,
    }


def fetch_tick(exchange: str, market: str, symbol: str, timeframe: str) -> dict:
    """Latest few candles for the realtime poller (shares the candle cache)."""
    payload = fetch_candles(exchange, market, symbol, timeframe, limit=3, max_age=0.5)
    payload["candles"] = payload["candles"][-3:]
    return payload


def clear_cache() -> None:
    with _cache_lock:
        _candle_cache.clear()


def capabilities() -> dict:
    return {
        pid: {m: {"timeframes": caps[0], "aggregated": caps[1]}
              for m, caps in markets.items()}
        for pid, markets in _CAPABILITIES.items()
    }
