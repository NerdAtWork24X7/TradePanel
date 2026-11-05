"""Shared utilities for the core package.

Pure helper functions used by the indicator modules.
"""

from __future__ import annotations

import re
import sqlite3

import pandas as pd

from backend.Core.config import candles_db_path


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
