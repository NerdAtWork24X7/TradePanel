"""Candle data fetching and SQLite caching.

Fetches historical candles from Binance, caches them in a local SQLite
database, and returns only new data on subsequent requests (incremental).

Database layout (v2):
    One database per timeframe  →  data/candles_5m.db, data/candles_1m.db, …
    One table per coin          →  candles_BTC, candles_ETH, …
    Each table has columns:     (time, open, high, low, close, volume)
    Primary key:                time  (unique per coin per timeframe)
"""

from __future__ import annotations

import sqlite3
import time
import logging

import requests

from backend.Core.config import candles_db_path
from backend.Core.utils import table_name

log = logging.getLogger(__name__)

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines" 
MAX_PER_REQUEST = 1000       # Binance hard limit
TARGET_CANDLES = 5000        # How many candles we want cached


# ── Table name helpers ───────────────────────────────────────────────────────



# ── Database helpers ─────────────────────────────────────────────────────────

def _get_conn(timeframe: str) -> sqlite3.Connection:
    """Return a connection to the per-timeframe candles database.

    Creates the database directory and enables WAL mode.
    The actual table is created lazily by _ensure_table().
    """
    db_path = candles_db_path(timeframe)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _ensure_table(conn: sqlite3.Connection, coin: str) -> None:
    """Create the per-coin table if it doesn't exist."""
    table = table_name(coin)
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {table} (
            time   INTEGER NOT NULL PRIMARY KEY,
            open   REAL    NOT NULL,
            high   REAL    NOT NULL,
            low    REAL    NOT NULL,
            close  REAL    NOT NULL,
            volume REAL    NOT NULL
        )
    """)
    conn.commit()


def _close_conn(conn: sqlite3.Connection) -> None:
    """Close connection and checkpoint the WAL so external readers see
    the latest data immediately."""
    try:
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception:
        pass
    conn.close()


# ── Query helpers ────────────────────────────────────────────────────────────

def _last_cached_time(conn: sqlite3.Connection, coin: str) -> int | None:
    table = table_name(coin)
    row = conn.execute(f"SELECT MAX(time) FROM {table}").fetchone()
    return row[0] if row and row[0] is not None else None


def _oldest_cached_time(conn: sqlite3.Connection, coin: str) -> int | None:
    table = table_name(coin)
    row = conn.execute(f"SELECT MIN(time) FROM {table}").fetchone()
    return row[0] if row and row[0] is not None else None


def _count_cached(conn: sqlite3.Connection, coin: str) -> int:
    table = table_name(coin)
    row = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    return row[0]


def _insert_candles(
    conn: sqlite3.Connection,
    coin: str,
    rows: list[tuple[int, float, float, float, float, float]],
) -> int:
    """Insert candles, skipping duplicates. Returns count inserted."""
    if not rows:
        return 0
    table = table_name(coin)
    conn.executemany(
        f"""INSERT OR IGNORE INTO {table}
            (time, open, high, low, close, volume)
            VALUES (?, ?, ?, ?, ?, ?)""",
        rows,
    )
    conn.commit()
    return len(rows)


def _trim_candles(
    conn: sqlite3.Connection,
    coin: str,
    max_count: int = TARGET_CANDLES,
) -> int:
    """Remove oldest candles so that at most *max_count* remain.

    Returns the number of rows deleted.
    """
    table = table_name(coin)
    count = _count_cached(conn, coin)
    if count <= max_count:
        return 0
    excess = count - max_count
    conn.execute(
        f"DELETE FROM {table} WHERE time IN ("
        f"SELECT time FROM {table} ORDER BY time ASC LIMIT ?)",
        (excess,),
    )
    conn.commit()
    log.info("Trimmed %d oldest candles for %s (was %d, now ≤%d)",
             excess, coin, count, max_count)
    return excess


def _load_all(coin: str, timeframe: str) -> tuple[list[dict], list[dict]]:
    """Open a fresh read-only connection, load all cached candles, close immediately."""
    db_path = candles_db_path(timeframe)
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        table = table_name(coin)
        cursor = conn.execute(
            f"""SELECT time, open, high, low, close, volume
                FROM {table}
                ORDER BY time ASC""",
        )
        candles = []
        volumes = []
        for t, o, h, l, c, v in cursor:
            candles.append({"time": t, "open": o, "high": h, "low": l, "close": c})
            color = "rgba(38,166,154,0.4)" if c >= o else "rgba(239,83,80,0.4)"
            volumes.append({"time": t, "value": v, "color": color})
        return candles, volumes
    finally:
        conn.close()


# ── Binance API ──────────────────────────────────────────────────────────────

def _is_invalid_symbol_error(resp: requests.Response) -> bool:
    """Return True if Binance rejected the request because the symbol does not exist."""
    if resp.status_code != 400:
        return False
    try:
        data = resp.json()
        # Binance returns code -1121 for invalid symbol
        return data.get("code") == -1121 or "Invalid symbol" in data.get("msg", "")
    except Exception:
        return "Invalid symbol" in resp.text


def _parse_klines(raw: list) -> list[tuple[int, float, float, float, float, float]]:
    """Convert Binance kline array → (time_s, O, H, L, C, V) tuples."""
    result = []
    for k in raw:
        result.append((
            k[0] // 1000,           # ms → seconds
            float(k[1]),            # open
            float(k[2]),            # high
            float(k[3]),            # low
            float(k[4]),            # close
            float(k[5]),            # volume
        ))
    return result


def _fetch_klines(
    coin: str,
    interval: str,
    limit: int = MAX_PER_REQUEST,
    end_time_ms: int | None = None,
    start_time_ms: int | None = None,
) -> list:
    """Fetch one page of klines from Binance, trying common quote assets."""
    params_base = {"interval": interval, "limit": limit}
    if end_time_ms is not None:
        params_base["endTime"] = end_time_ms
    if start_time_ms is not None:
        params_base["startTime"] = start_time_ms

    for quote in ("USDT", "FDUSD", "USDC", "BUSD"):
        symbol = f"{coin}{quote}"
        params = {**params_base, "symbol": symbol}
        try:
            resp = requests.get(BINANCE_KLINES_URL, params=params, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except requests.HTTPError as e:
            # A 400 response usually means the trading pair does not exist for
            # this quote asset, so try the next one.
            if e.response is not None and _is_invalid_symbol_error(e.response):
                continue
            raise
    raise RuntimeError(f"Could not fetch klines for {coin} with any quote asset")


def fetch_historical(
    coin: str,
    timeframe: str,
    target: int = TARGET_CANDLES,
) -> tuple[list[dict], list[dict]]:
    """Fetch up to *target* candles, using cache for incremental updates.

    Returns (candles, volumes) ready for LightweightCharts.
    The write connection is closed before the read pass so external
    SQLite editors are never blocked.
    """
    conn = _get_conn(timeframe)

    try:
        _ensure_table(conn, coin)

        cached_count = _count_cached(conn, coin)
        last_ts = _last_cached_time(conn, coin)

        if cached_count >= target and last_ts is not None:
            # Enough cached — only grab new candles since last timestamp
            new_rows = _fetch_incremental(coin, timeframe, last_ts)
            if new_rows:
                inserted = _insert_candles(conn, coin, new_rows)
                log.info(
                    "Incremental refresh for %s %s: %d new candles (cache had %d)",
                    coin, timeframe, inserted, cached_count,
                )
            else:
                log.info("Cache up-to-date for %s %s (%d candles)", coin, timeframe, cached_count)

        elif cached_count > 0:
            # Partial cache — fill forward and backward
            oldest_ts = _oldest_cached_time(conn, coin)

            new_rows = _fetch_incremental(coin, timeframe, last_ts)
            if new_rows:
                _insert_candles(conn, coin, new_rows)

            remaining = target - _count_cached(conn, coin)
            if remaining > 0 and oldest_ts is not None:
                old_rows = _fetch_older(coin, timeframe, oldest_ts, remaining)
                if old_rows:
                    _insert_candles(conn, coin, old_rows)

            log.info(
                "Expanded cache for %s %s → %d candles",
                coin, timeframe, _count_cached(conn, coin),
            )

        else:
            # Empty cache — full initial fetch
            all_rows = _fetch_full(coin, timeframe, target)
            _insert_candles(conn, coin, all_rows)
            log.info("Initial fetch for %s %s: cached %d candles", coin, timeframe, len(all_rows))

        # Always enforce the rolling window cap
        _trim_candles(conn, coin, target)

    finally:
        _close_conn(conn)           # release the write lock

    # Read with a separate, read-only connection — no lock held
    return _load_all(coin, timeframe)


# ── Paginated fetchers ───────────────────────────────────────────────────────

def _fetch_full(coin: str, interval: str, target: int) -> list[tuple]:
    """Fetch *target* candles going backwards from now."""
    all_rows: list[tuple] = []
    end_ms: int | None = None

    while len(all_rows) < target:
        page_size = min(MAX_PER_REQUEST, target - len(all_rows))
        raw = _fetch_klines(coin, interval, limit=page_size, end_time_ms=end_ms)
        if not raw:
            break
        parsed = _parse_klines(raw)
        all_rows = parsed + all_rows   # older data goes to the front
        end_ms = raw[0][0] - 1         # one ms before the oldest candle
        time.sleep(0.15)               # gentle rate-limit

    return all_rows


def _fetch_incremental(
    coin: str,
    interval: str,
    after_ts: int,
) -> list[tuple]:
    """Fetch candles newer than *after_ts* (in seconds)."""
    all_rows: list[tuple] = []
    start_ms = (after_ts + 1) * 1000

    while True:
        raw = _fetch_klines(coin, interval, limit=MAX_PER_REQUEST, start_time_ms=start_ms)
        if not raw:
            break
        parsed = _parse_klines(raw)
        all_rows.extend(parsed)
        if len(raw) < MAX_PER_REQUEST:
            break
        start_ms = raw[-1][0] + 1
        time.sleep(0.15)

    return all_rows


def _fetch_older(
    coin: str,
    interval: str,
    before_ts: int,
    count: int,
) -> list[tuple]:
    """Fetch up to *count* candles older than *before_ts* (in seconds)."""
    all_rows: list[tuple] = []
    end_ms = (before_ts - 1) * 1000

    while len(all_rows) < count:
        page_size = min(MAX_PER_REQUEST, count - len(all_rows))
        raw = _fetch_klines(coin, interval, limit=page_size, end_time_ms=end_ms)
        if not raw:
            break
        parsed = _parse_klines(raw)
        all_rows = parsed + all_rows
        end_ms = raw[0][0] - 1
        time.sleep(0.15)

    return all_rows
