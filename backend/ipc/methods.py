"""JSON-RPC method registry for the TradePanel sidecar.

Every method maps onto existing ``Core`` / ``Indicator`` / ``Exchange``
functionality. No trading behaviour is re-implemented here; the handlers are
thin, validating adapters (see ``Core/trading_service.py``).
"""

from __future__ import annotations

import logging
import math
import os
import platform
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from backend.Core import (
    coin_service,
    config,
    credentials,
    market_data,
    trading_service,
    window_state,
    workspace_indicators,
    workspace_store,
)
from backend.Indicator import config as indicator_config

from .credentials import CredentialStore
from .protocol import (
    INVALID_PARAMS,
    PROTOCOL_MISMATCH,
    PROTOCOL_VERSION,
    RpcError,
)

log = logging.getLogger(__name__)

BACKEND_VERSION = os.environ.get("TRADEPANEL_APP_VERSION", "0.1.0")
LAYOUTS = ["1", "2h", "2v", "4", "6", "8", "custom"]


# ── Parameter validation ─────────────────────────────────────────────────────


def _get(params: dict, key: str, *, required: bool = True, default: Any = None) -> Any:
    value = params.get(key)
    if value is None:
        if required:
            raise RpcError(INVALID_PARAMS, f"Missing parameter: {key}")
        return default
    return value


def _text(params: dict, key: str, *, required: bool = True, default: str = "",
          max_len: int = 200) -> str:
    value = _get(params, key, required=required, default=default)
    if not isinstance(value, str):
        raise RpcError(INVALID_PARAMS, f"{key} must be a string")
    text = value.strip()
    if required and not text:
        raise RpcError(INVALID_PARAMS, f"{key} must not be empty")
    if len(text) > max_len:
        raise RpcError(INVALID_PARAMS, f"{key} is too long")
    return text


def _number(params: dict, key: str, *, required: bool = True,
            default: float | None = None) -> float | None:
    value = _get(params, key, required=required, default=default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RpcError(INVALID_PARAMS, f"{key} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise RpcError(INVALID_PARAMS, f"{key} must be finite")
    return number


def _integer(params: dict, key: str, *, required: bool = True,
             default: int | None = None, minimum: int = 0,
             maximum: int = 2**31 - 1) -> int | None:
    value = _get(params, key, required=required, default=default)
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise RpcError(INVALID_PARAMS, f"{key} must be an integer")
    if not minimum <= value <= maximum:
        raise RpcError(INVALID_PARAMS, f"{key} is out of range")
    return value


def _boolean(params: dict, key: str, *, required: bool = True,
             default: bool = False) -> bool:
    value = _get(params, key, required=required, default=default)
    if not isinstance(value, bool):
        raise RpcError(INVALID_PARAMS, f"{key} must be a boolean")
    return value


def _object(params: dict, key: str, *, required: bool = True) -> dict:
    value = _get(params, key, required=required, default={})
    if not isinstance(value, dict):
        raise RpcError(INVALID_PARAMS, f"{key} must be an object")
    return value


def _instrument(params: dict) -> tuple[str, str, str, str]:
    return (
        _text(params, "exchange", max_len=32),
        _text(params, "market", max_len=32),
        _text(params, "symbol", max_len=64),
        _text(params, "timeframe", max_len=8),
    )


# ── Registry types ───────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Context:
    credentials: CredentialStore
    started_at: float
    state_lock: threading.RLock


@dataclass(frozen=True)
class MethodSpec:
    handler: Callable[[dict, Context], Any]
    serialized: bool = False
    allow_during_shutdown: bool = False


# ── Handlers ─────────────────────────────────────────────────────────────────


def _hello(params: dict, ctx: Context) -> dict:
    client_version = _get(params, "protocol_version")
    if not isinstance(client_version, int) or isinstance(client_version, bool):
        raise RpcError(INVALID_PARAMS, "protocol_version must be an integer")
    if client_version != PROTOCOL_VERSION:
        raise RpcError(
            PROTOCOL_MISMATCH,
            "Protocol version mismatch: rebuild the desktop app and backend together",
            {
                "expected": PROTOCOL_VERSION,
                "got": client_version,
                "backend_version": BACKEND_VERSION,
            },
        )
    return {
        "protocol_version": PROTOCOL_VERSION,
        "backend_version": BACKEND_VERSION,
        "python": platform.python_version(),
        "platform": platform.system(),
        "pid": os.getpid(),
        "started_at_ms": int(ctx.started_at * 1000),
        "methods": sorted(METHODS),
    }


def _ping(params: dict, ctx: Context) -> dict:
    return {"pong": True, "uptime_ms": int((time.time() - ctx.started_at) * 1000)}


def _shutdown(params: dict, ctx: Context) -> dict:
    return {"ok": True}


def _set_credentials(params: dict, ctx: Context) -> dict:
    values = _object(params, "values", required=False)
    clear = _get(params, "clear", required=False, default=[]) or []
    if not isinstance(clear, list) or any(not isinstance(k, str) for k in clear):
        raise RpcError(INVALID_PARAMS, "clear must be a list of strings")
    for key, value in values.items():
        if not isinstance(value, str):
            raise RpcError(INVALID_PARAMS, "credential values must be strings")
    changed = ctx.credentials.apply(values, clear)
    return {
        "keys": changed,
        "set": {key: bool(os.environ.get(key)) for key in _credential_keys()},
    }


def _credential_keys() -> tuple[str, ...]:
    return tuple(field[0] for field in credentials.FIELDS)


def _meta(params: dict, ctx: Context) -> dict:
    return {
        "exchanges": market_data.exchanges_meta(),
        "timeframes": market_data.TIMEFRAMES,
        "aggregations": market_data.capabilities(),
        "layouts": LAYOUTS,
    }


def _get_candles(params: dict, ctx: Context) -> dict:
    exchange, market, symbol, timeframe = _instrument(params)
    limit = _integer(params, "limit", required=False, default=600,
                     minimum=1, maximum=3000)
    end_time = _integer(params, "end_time", required=False, default=None,
                        minimum=0)
    return market_data.fetch_candles(
        exchange, market, symbol, timeframe,
        limit=int(limit or 600), end_time=end_time or None,
    )


def _get_tick(params: dict, ctx: Context) -> dict:
    exchange, market, symbol, timeframe = _instrument(params)
    return market_data.fetch_tick(exchange, market, symbol, timeframe)


def _search_symbols(params: dict, ctx: Context) -> dict:
    exchange = _text(params, "exchange", max_len=32)
    market = _text(params, "market", max_len=32)
    query = _text(params, "query", required=False, default="", max_len=64)
    return {"ok": True, "symbols": market_data.search_symbols(exchange, market, query)}


def _indicator_get(params: dict, ctx: Context) -> dict:
    return {"ok": True, "config": indicator_config.load_indicator_config()}


def _indicator_save(params: dict, ctx: Context) -> dict:
    cfg = _object(params, "config")
    indicator_config.save_indicator_config(cfg)
    workspace_indicators.clear_cache()
    return {"ok": True, "config": indicator_config.load_indicator_config()}


def _indicator_compute(params: dict, ctx: Context) -> dict:
    exchange, market, symbol, timeframe = _instrument(params)
    flags = _object(params, "flags", required=False)
    return workspace_indicators.compute_workspace_indicators(
        exchange, market, symbol, timeframe, flags
    )


def _workspace_load(params: dict, ctx: Context) -> dict:
    with ctx.state_lock:
        store = workspace_store.load_store()
    return {"ok": True, **store}


def _workspace_save(params: dict, ctx: Context) -> dict:
    store = _object(params, "store")
    with ctx.state_lock:
        saved = workspace_store.save_store(store)
    return {"ok": True, "store": saved}


def _account_position(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    return trading_service.position_snapshot(coin)


def _account_open_orders(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    return {"coin": coin, "orders": trading_service.open_orders(coin)}


def _place_order(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    is_buy = _boolean(params, "is_buy")
    qty = _number(params, "qty")
    limit_price = _number(params, "limit_price")
    tp_price = _number(params, "tp_price")
    sl_price = _number(params, "sl_price")
    success, message = trading_service.place_order(
        coin, is_buy, qty, limit_price, tp_price, sl_price
    )
    return {"success": success, "message": message}


def _update_tp_sl(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    is_short = _boolean(params, "is_short")
    tp = _number(params, "tp")
    sl = _number(params, "sl")
    success, message = trading_service.update_tp_sl(coin, is_short, tp, sl)
    return {"success": success, "message": message}


def _calc_qty(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    risk = _number(params, "risk")
    entry = _number(params, "entry")
    sl = _number(params, "sl")
    is_short = _boolean(params, "is_short")
    qty = trading_service.calculate_qty(risk, entry, sl, is_short, coin)
    return {"qty": qty, "sz_decimals": trading_service.sz_decimals(coin)}


def _sz_decimals(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    return {"coin": coin, "sz_decimals": trading_service.sz_decimals(coin)}


def _price_precision(params: dict, ctx: Context) -> dict:
    coin = _text(params, "coin", max_len=20)
    return trading_service.price_precision(coin)


def _coins(params: dict, ctx: Context) -> dict:
    refresh = _boolean(params, "refresh", required=False, default=False)
    coins = coin_service.refresh_coins() if refresh else coin_service.load_coins()
    return {"coins": coins}


def _window_state_get(params: dict, ctx: Context) -> dict:
    with ctx.state_lock:
        return {"state": window_state.load_window_state()}


def _window_state_save(params: dict, ctx: Context) -> dict:
    state = _object(params, "state")
    # Only known, non-secret fields are persisted.
    allowed = {
        "coin", "timeframe", "favorites", "risk", "is_short", "hyperliquid",
        "limit", "tp", "sl", "sidebar_collapsed", "fvg_enabled", "vwap_visible",
        "session_asian_visible", "session_london_visible",
        "session_ny_am_visible", "session_ny_pm_visible",
        "fvg_chart_visible",
    }
    cleaned = {key: value for key, value in state.items() if key in allowed}
    with ctx.state_lock:
        # Merge into the existing file so keys this shell does not manage
        # (legacy visibility flags, future settings) survive the migration.
        existing = window_state.load_window_state()
        existing.update(cleaned)
        window_state.save_window_state(existing)
    return {"ok": True}


METHODS: dict[str, MethodSpec] = {
    "system.hello": MethodSpec(_hello, allow_during_shutdown=True),
    "system.ping": MethodSpec(_ping, allow_during_shutdown=True),
    "system.shutdown": MethodSpec(_shutdown, allow_during_shutdown=True),
    "system.set_credentials": MethodSpec(_set_credentials),
    "market.meta": MethodSpec(_meta),
    "market.get_candles": MethodSpec(_get_candles),
    "market.get_tick": MethodSpec(_get_tick),
    "market.search_symbols": MethodSpec(_search_symbols),
    "indicator.get_config": MethodSpec(_indicator_get),
    "indicator.save_config": MethodSpec(_indicator_save),
    "indicator.compute": MethodSpec(_indicator_compute),
    "workspace.load": MethodSpec(_workspace_load),
    "workspace.save": MethodSpec(_workspace_save),
    "account.position": MethodSpec(_account_position),
    "account.open_orders": MethodSpec(_account_open_orders),
    "trading.place_order": MethodSpec(_place_order, serialized=True),
    "trading.update_tp_sl": MethodSpec(_update_tp_sl, serialized=True),
    "trading.calc_qty": MethodSpec(_calc_qty),
    "trading.sz_decimals": MethodSpec(_sz_decimals),
    "trading.price_precision": MethodSpec(_price_precision),
    "trading.coins": MethodSpec(_coins),
    "settings.window_state.get": MethodSpec(_window_state_get),
    "settings.window_state.save": MethodSpec(_window_state_save),
}
