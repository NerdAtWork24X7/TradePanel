"""Legacy chart indicators computed for workspace panels.

The original single-chart view computed these indicators in Python from the
Binance SQLite cache. The multi-chart workspace supports eight exchanges, so
the same indicator implementations are fed normalized candles from
``Core.market_data`` instead.

Only the indicators requested by a panel are computed. Results are cached for
a few seconds so several panels/toggles in the same UI tick share one pass.
"""

from __future__ import annotations

import json
import logging
import threading
import time

import pandas as pd

from backend.Core import market_data
from backend.Indicator import config as indicator_config
from backend.Indicator.adx import (
    _compute_adx_impl,
    set_adx_length,
    set_adx_pane_height,
    set_adx_show_di_lines,
)
from backend.Indicator.ema_ribbon import _compute_ribbon_impl, set_ribbon_lengths, set_ribbon_ma_type
from backend.Indicator.fvg import _compute_fvg_impl, set_fvg_gap_pct
from backend.Indicator.hl_ema import _compute_hl_ema_impl, set_hl_ema_length
from backend.Indicator.sessions import _compute_session_boxes_impl, configure_session_starts
from backend.Indicator.volume_profile import (
    _compute_daily_vp_impl,
    _compute_session_vp_impl,
    _compute_vp_impl,
    set_vp_length,
    set_vp_rows,
)

log = logging.getLogger(__name__)

CACHE_TTL = 5.0
MAX_CACHE_ENTRIES = 64

_cache: dict[tuple, tuple[float, dict]] = {}
_cache_lock = threading.Lock()
_config_lock = threading.Lock()
_config_signature: str | None = None

SESSION_FLAGS = ("session_asian", "session_london", "session_ny_am", "session_ny_pm")
ALL_FLAGS = set(SESSION_FLAGS) | {
    "fvg", "ribbon", "vp", "daily_vp", "session_vp",
    "hl_ema", "adx",
}


def _chart_limit(timeframe: str) -> int:
    if timeframe == "1M":
        return 60
    if timeframe == "1w":
        return 200
    if timeframe == "1d":
        return 400
    return 800


def _apply_config(cfg: dict) -> str:
    """Push the persisted indicator config into the legacy modules."""
    global _config_signature
    signature = json.dumps(cfg, sort_keys=True)
    with _config_lock:
        if signature == _config_signature:
            return signature
        sessions = cfg.get("sessions", {})
        starts = {}
        for key in ("asian", "london", "ny_am", "ny_pm"):
            starts[key] = {
                "start": sessions.get(f"{key}_start", "00:00"),
                "end": sessions.get(f"{key}_end", "23:59"),
            }
        configure_session_starts(starts)
        fvg = cfg.get("fvg", {})
        set_fvg_gap_pct(float(fvg.get("gap_pct", 0.5)))
        ribbon = cfg.get("ema_ribbon", {})
        set_ribbon_ma_type(ribbon.get("ma_type", "EMA"))
        set_ribbon_lengths([
            int(ribbon.get("length1", 20)),
            int(ribbon.get("length2", 40)),
            int(ribbon.get("length3", 60)),
        ])
        vp = cfg.get("volume_profile", {})
        set_vp_length(int(vp.get("length", 100)))
        set_vp_rows(int(vp.get("rows", 24)))
        set_hl_ema_length(int(cfg.get("hl_ema", {}).get("length", 20)))
        adx = cfg.get("adx", {})
        set_adx_length(int(adx.get("length", 14)))
        set_adx_pane_height(int(adx.get("pane_height", 160)))
        set_adx_show_di_lines(bool(adx.get("show_di_lines", False)))
        _config_signature = signature
        return signature


def _frame(candles: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(candles)
    if df.empty:
        return df
    for column in ("open", "high", "low", "close", "volume"):
        if column in df.columns:
            df[column] = pd.to_numeric(df[column], errors="coerce")
    df["time"] = pd.to_numeric(df["time"], errors="coerce").astype("int64")
    return df


def compute_workspace_indicators(
    exchange: str,
    market: str,
    symbol: str,
    timeframe: str,
    flags: dict,
) -> dict:
    """Compute the requested legacy indicators for one workspace panel."""
    flags = {k: bool(v) for k, v in (flags or {}).items() if k in ALL_FLAGS}
    if not any(flags.values()):
        return {"ok": True, "empty": True}

    cfg = indicator_config.load_indicator_config()
    signature = _apply_config(cfg)
    flag_key = tuple(sorted(k for k, v in flags.items() if v))
    cache_key = (exchange, market, symbol, timeframe, flag_key, signature)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and now - hit[0] < CACHE_TTL:
            return hit[1]

    limit = _chart_limit(timeframe)
    payload = market_data.fetch_candles(
        exchange, market, symbol, timeframe, limit=limit,
    )
    candles = payload.get("candles") or []
    df = _frame(candles)
    if df.empty:
        return {"ok": True, "empty": True}

    out: dict = {"ok": True, "candles": len(df), "aggregated_from": payload.get("aggregated_from")}
    sessions_enabled = any(flags.get(k) for k in SESSION_FLAGS)

    def safely(name: str, fn):
        try:
            out[name] = fn()
        except Exception as exc:  # one indicator must not break the rest
            log.warning("Workspace indicator %s failed for %s/%s %s: %s",
                        name, exchange, symbol, timeframe, exc)
            out[name] = None

    if sessions_enabled:
        safely("sessions", lambda: _compute_session_boxes_impl(
            None, timeframe, None, None, df=df))
    if flags.get("fvg"):
        safely("fvg", lambda: _compute_fvg_impl(
            None, timeframe, float(cfg.get("fvg", {}).get("gap_pct", 0.5)), df=df))
    if flags.get("ribbon"):
        ribbon_cfg = cfg.get("ema_ribbon", {})
        safely("ribbon", lambda: _compute_ribbon_impl(
            None, timeframe, ribbon_cfg.get("ma_type", "EMA"),
            [int(ribbon_cfg.get("length1", 20)), int(ribbon_cfg.get("length2", 40)),
             int(ribbon_cfg.get("length3", 60))], df=df))
    if flags.get("vp"):
        vp_cfg = cfg.get("volume_profile", {})
        safely("vp", lambda: _compute_vp_impl(
            None, timeframe, int(vp_cfg.get("length", 100)),
            int(vp_cfg.get("rows", 24)), df=df))
    if flags.get("daily_vp"):
        pseudo_coin = f"{exchange}:{symbol}"
        safely("daily_vp", lambda: _compute_daily_vp_impl(
            pseudo_coin, timeframe, int(cfg.get("volume_profile", {}).get("rows", 24)), df=df))
    if flags.get("session_vp"):
        safely("session_vp", lambda: _compute_session_vp_impl(None, timeframe, 100, df=df))

    if flags.get("hl_ema"):
        hl_len = int(cfg.get("hl_ema", {}).get("length", 20))
        safely("hl_ema", lambda: _compute_hl_ema_impl(
            None, timeframe, hl_len, df=df))
    if flags.get("adx"):
        def _adx():
            adx_cfg = cfg.get("adx", {})
            result = _compute_adx_impl(
                None, timeframe, int(adx_cfg.get("length", 14)), df=df)
            result["levels"] = adx_cfg.get("levels", [25])
            result["pane_height"] = adx_cfg.get("pane_height", 160)
            result["show_di_lines"] = bool(adx_cfg.get("show_di_lines", False))
            return result
        safely("adx", _adx)

    with _cache_lock:
        _cache[cache_key] = (now, out)
        while len(_cache) > MAX_CACHE_ENTRIES:
            _cache.pop(next(iter(_cache)))
    return out


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
