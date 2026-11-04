"""Shared utilities for the core package.

Pure helper functions used by candle_service and indicators.
"""

from __future__ import annotations

import re
import sqlite3
import threading
import weakref
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures.thread import _threads_queues, _worker

import pandas as pd

from Core.config import candles_db_path


# Pre-compiled regex for performance
_COIN_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_]")


def sanitize_coin(coin: str) -> str:
    """Sanitize a coin name for safe use in SQLite table names."""
    return _COIN_SANITIZE_RE.sub("_", coin)


def table_name(coin: str) -> str:
    """Return the per-coin candles table name."""
    return f"candles_{sanitize_coin(coin)}"


def load_candles_df(
    coin: str,
    timeframe: str,
    columns: list[str] | None = None,
) -> pd.DataFrame:
    """Load cached candles for *coin*/*timeframe* into a DataFrame.

    Args:
        coin: Trading pair coin name (e.g. "BTC").
        timeframe: Candle interval (e.g. "5m", "1h").
        columns: Optional list of columns to select. Defaults to all OHLCV columns.

    Returns:
        DataFrame with requested columns, ordered by time ascending.
        Returns an empty DataFrame if no table exists.
    """
    default_columns = ["time", "open", "high", "low", "close", "volume"]
    select_columns = columns or default_columns
    allowed = set(default_columns)
    invalid = set(select_columns) - allowed
    if invalid:
        raise ValueError(f"Invalid columns requested: {invalid}")
    column_str = ", ".join(select_columns)

    db_path = candles_db_path(timeframe)
    table = table_name(coin)

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=10)
    conn.execute("PRAGMA busy_timeout=5000")
    try:
        df = pd.read_sql_query(
            f"SELECT {column_str} FROM {table} ORDER BY time ASC",
            conn,
        )
    finally:
        conn.close()

    return df


class DaemonThreadPoolExecutor(ThreadPoolExecutor):
    """ThreadPoolExecutor whose workers run as daemon threads.

    Python's default ThreadPoolExecutor creates non-daemon workers. On
    application shutdown those workers can block the interpreter's ``_shutdown``
    routine if they are still running (e.g. stuck on a network request). Daemon
    workers avoid this because they do not participate in the interpreter-wide
    thread join during shutdown.
    """

    def _adjust_thread_count(self) -> None:
        # Replicates the upstream logic but creates daemon threads before they
        # start. A thread's daemon flag can only be set before start() is called.
        if self._idle_semaphore.acquire(timeout=0):
            return

        def weakref_cb(_, q=self._work_queue):
            try:
                q.put(None)
            except Exception:
                pass

        num_threads = len(self._threads)
        if num_threads < self._max_workers:
            thread_name = "%s_%d" % (self._thread_name_prefix or self, num_threads)
            t = threading.Thread(
                name=thread_name,
                target=_worker,
                args=(
                    weakref.ref(self, weakref_cb),
                    self._work_queue,
                    self._initializer,
                    self._initargs,
                ),
            )
            t.daemon = True
            t.start()
            self._threads.add(t)
            _threads_queues[t] = self._work_queue
