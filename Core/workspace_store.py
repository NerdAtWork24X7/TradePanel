"""Persistence for multi-chart trading workspaces.

Stores the complete workspace tree (layout, charts, sync groups, settings,
drawings) as JSON in ``data/workspaces.json`` — the same lightweight JSON
persistence mechanism the rest of the app uses (alerts, coins, window state).

Writes are atomic (tmp file + replace) and every payload coming from the web
layer is validated/clamped before it touches disk.
"""

from __future__ import annotations

import json
import logging
import os
import time
import uuid
from typing import Any

from Core.config import DATA_DIR
from Core.market_data import TIMEFRAMES

log = logging.getLogger(__name__)

WORKSPACES_FILE = DATA_DIR / "workspaces.json"
STORE_VERSION = 1
MAX_WORKSPACES = 24
MAX_CHARTS = 12
LAYOUTS = ("1", "2h", "2v", "4", "6", "8", "custom")
CHART_TYPES = ("candlestick", "hollow", "bar", "line", "area", "baseline")
PRICE_MODES = ("independent", "absolute", "percentage", "indexed")
REFERENCE_MODES = ("first_visible", "history_start", "custom")
NEAREST_POLICIES = ("closest", "previous", "next", "none")
EXCHANGES = ("binance", "bybit", "okx", "coinbase", "kraken", "kucoin", "gate", "bitget")
GROUP_COLORS = ("#FF5A3C", "#2962FF", "#F5C400", "#10B981", "#A855F7", "#06B6D4")

DEFAULT_SETTINGS: dict[str, Any] = {
    "crosshair": True,
    "timeRange": True,
    "horizontalScroll": True,
    "zoom": True,
    "timeframe": False,
    "priceScale": "independent",
    "nearestPolicy": "previous",
    "maxDriftBars": 2,
    "referenceMode": "first_visible",
    "referenceTime": None,
}

DEFAULT_INDICATORS: dict[str, Any] = {
    "sma": {"enabled": False, "length": 20},
    "ema": {"enabled": False, "length": 50},
    "rsi": {"enabled": False, "length": 14},
    "macd": {"enabled": False, "fast": 12, "slow": 26, "signal": 9},
    "bb": {"enabled": False, "length": 20, "mult": 2},
    "vwap": {"enabled": False},
    "atr": {"enabled": False, "length": 14},
    "volume": {"enabled": True},
    # Legacy chart indicators (computed in Python from the panel's candles).
    "session_asian": {"enabled": False},
    "session_london": {"enabled": False},
    "session_ny_am": {"enabled": False},
    "session_ny_pm": {"enabled": False},
    "fvg": {"enabled": False},
    "ribbon": {"enabled": False},
    "vp": {"enabled": False},
    "daily_vp": {"enabled": False},
    "session_vp": {"enabled": False},
    "hl_ema": {"enabled": False},
    "adx": {"enabled": False},
}

DRAWING_TOOLS = ("hline", "vline", "trend", "rect", "fib", "text")


# ── Defaults ─────────────────────────────────────────────────────────────────

def _chart(chart_id: str, exchange: str, symbol: str, timeframe: str,
           group_id: str | None = None) -> dict:
    return {
        "id": chart_id,
        "exchange": exchange,
        "market": "spot",
        "symbol": symbol,
        "timeframe": timeframe,
        "chartType": "candlestick",
        "priceScaleMode": "independent",
        "referenceMode": "first_visible",
        "referenceTime": None,
        "indicators": json.loads(json.dumps(DEFAULT_INDICATORS)),
        "groupId": group_id,
        "drawings": [],
        "view": None,
    }


def default_store() -> dict:
    """The workspace shipped with the feature (mirrors the documented example)."""
    workspace = {
        "id": "ws-default",
        "name": "Multi-Market",
        "layout": "4",
        "columns": [0.5, 0.5],
        "rows": [0.5, 0.5],
        "charts": [
            _chart("c1", "binance", "BTC/USDT", "5m", "g-red"),
            _chart("c2", "bybit", "BTC/USDT", "5m", "g-red"),
            _chart("c3", "binance", "ETH/USDT", "15m", "g-blue"),
            _chart("c4", "okx", "SOL/USDT", "1h", "g-blue"),
        ],
        "syncGroups": [
            {"id": "g-red", "name": "BTC", "color": "#FF5A3C",
             "enabled": True, "settings": json.loads(json.dumps(DEFAULT_SETTINGS))},
            {"id": "g-blue", "name": "Alts", "color": "#2962FF",
             "enabled": True, "settings": json.loads(json.dumps(DEFAULT_SETTINGS))},
        ],
        "globalSettings": json.loads(json.dumps(DEFAULT_SETTINGS)),
        "updatedAt": int(time.time() * 1000),
    }
    return {"version": STORE_VERSION, "active": workspace["id"], "workspaces": [workspace]}


def empty_workspace(name: str = "Workspace") -> dict:
    workspace = default_store()["workspaces"][0]
    workspace["id"] = f"ws-{uuid.uuid4().hex[:8]}"
    workspace["name"] = name
    return workspace


# ── Validation ───────────────────────────────────────────────────────────────

def _str(value: Any, default: str = "", limit: int = 40) -> str:
    return value.strip()[:limit] if isinstance(value, str) and value.strip() else default


def _bool(value: Any, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _num(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    if number != number:                     # NaN
        return default
    return max(lo, min(hi, number))


def _int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _fractions(value: Any, count: int, custom: bool = False) -> list[float]:
    """Validate CSS-grid track fractions (sum ~= 1, each meaningfully > 0)."""
    def equal(n: int) -> list[float]:
        n = max(1, min(n, MAX_CHARTS))
        return [round(1.0 / n, 6)] * n

    def clean(items: list) -> list[float] | None:
        nums = []
        for item in items:
            number = _num(item, 0.0, 0.0, 1.0)
            if number <= 0.03 or number >= 0.97:
                return None          # impossible track, fall back to equal split
            nums.append(number)
        total = sum(nums)
        return [round(v / total, 6) for v in nums] if total > 0 else None

    if custom and isinstance(value, list) and 1 <= len(value) <= 6:
        cleaned = clean(value)
        if cleaned:
            return cleaned
    count = max(1, min(count, MAX_CHARTS))
    if isinstance(value, list) and len(value) == count:
        cleaned = clean(value)
        if cleaned:
            return cleaned
    return equal(count)


def _indicators(value: Any) -> dict:
    src = value if isinstance(value, dict) else {}
    out: dict[str, Any] = {}
    for key, defaults in DEFAULT_INDICATORS.items():
        incoming = src.get(key) if isinstance(src.get(key), dict) else {}
        item: dict[str, Any] = {"enabled": _bool(incoming.get("enabled"), defaults["enabled"])}
        for field, default_value in defaults.items():
            if field == "enabled":
                continue
            if isinstance(default_value, int):
                item[field] = _int(incoming.get(field), default_value, 1, 500)
            elif isinstance(default_value, float):
                item[field] = _num(incoming.get(field), default_value, 0.1, 10)
        out[key] = item
    return out


def _drawings(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    out = []
    for raw in value[:400]:
        if not isinstance(raw, dict):
            continue
        tool = _str(raw.get("tool"), "", 12)
        if tool not in DRAWING_TOOLS:
            continue
        points = raw.get("points")
        clean_points = []
        if isinstance(points, list):
            for point in points[:8]:
                if not isinstance(point, dict):
                    continue
                clean_points.append({
                    "time": _int(point.get("time"), 0, 0, 4102444800),
                    "price": _num(point.get("price"), 0.0, -1e12, 1e12),
                })
        out.append({
            "id": _str(raw.get("id"), f"d-{uuid.uuid4().hex[:6]}", 40),
            "tool": tool,
            "points": clean_points,
            "color": _str(raw.get("color"), "#F5C400", 16),
            "text": _str(raw.get("text"), "", 120),
        })
    return out


def _settings(value: Any) -> dict:
    src = value if isinstance(value, dict) else {}
    mode = _str(src.get("priceScale"), "independent", 16)
    policy = _str(src.get("nearestPolicy"), "closest", 16)
    ref = _str(src.get("referenceMode"), "first_visible", 16)
    ref_time = src.get("referenceTime")
    return {
        "crosshair": _bool(src.get("crosshair"), True),
        "timeRange": _bool(src.get("timeRange"), True),
        "horizontalScroll": _bool(src.get("horizontalScroll"), True),
        "zoom": _bool(src.get("zoom"), True),
        "timeframe": _bool(src.get("timeframe"), False),
        "priceScale": mode if mode in PRICE_MODES else "independent",
        "nearestPolicy": policy if policy in NEAREST_POLICIES else "closest",
        "maxDriftBars": _num(src.get("maxDriftBars"), 2, 0, 100),
        "referenceMode": ref if ref in REFERENCE_MODES else "first_visible",
        "referenceTime": _int(ref_time, 0, 0, 4102444800) or None,
    }


def _chart_config(raw: dict, index: int, group_ids: set[str]) -> dict:
    chart = _chart(
        _str(raw.get("id"), f"c{index + 1}", 32),
        _str(raw.get("exchange"), "binance", 16),
        _str(raw.get("symbol"), "BTC/USDT", 32).upper(),
        _str(raw.get("timeframe"), "5m", 8),
    )
    if chart["exchange"] not in EXCHANGES:
        chart["exchange"] = "binance"
    market = _str(raw.get("market"), "spot", 12)
    chart["market"] = market if market in ("spot", "futures") else "spot"
    if chart["timeframe"] not in TIMEFRAMES:
        chart["timeframe"] = "5m"
    chart_type = _str(raw.get("chartType"), "candlestick", 16)
    chart["chartType"] = chart_type if chart_type in CHART_TYPES else "candlestick"
    mode = _str(raw.get("priceScaleMode"), "independent", 16)
    chart["priceScaleMode"] = mode if mode in PRICE_MODES else "independent"
    ref = _str(raw.get("referenceMode"), "first_visible", 16)
    chart["referenceMode"] = ref if ref in REFERENCE_MODES else "first_visible"
    ref_time = _int(raw.get("referenceTime"), 0, 0, 4102444800)
    chart["referenceTime"] = ref_time or None
    chart["indicators"] = _indicators(raw.get("indicators"))
    group = _str(raw.get("groupId"), "", 32)
    chart["groupId"] = group if group in group_ids else None
    chart["drawings"] = _drawings(raw.get("drawings"))
    view = raw.get("view")
    if isinstance(view, dict):
        start = _int(view.get("from"), 0, 0, 4102444800)
        end = _int(view.get("to"), 0, 0, 4102444800)
        if 0 < start < end:
            chart["view"] = {"from": start, "to": end}
    return chart


def _workspace(raw: dict, fallback_index: int = 0) -> dict:
    source = raw if isinstance(raw, dict) else {}
    name = _str(source.get("name"), f"Workspace {fallback_index + 1}", 60)
    workspace = empty_workspace(name)
    workspace["id"] = _str(source.get("id"), workspace["id"], 40)
    layout = _str(source.get("layout"), "4", 10)
    workspace["layout"] = layout if layout in LAYOUTS else "custom"

    charts_raw = source.get("charts") if isinstance(source.get("charts"), list) else []
    charts_raw = charts_raw[:MAX_CHARTS]
    if not charts_raw:
        charts_raw = [{"id": "c1", "exchange": "binance", "symbol": "BTC/USDT",
                       "timeframe": "5m"}]

    groups_raw = source.get("syncGroups") if isinstance(source.get("syncGroups"), list) else []
    groups: list[dict] = []
    seen_groups: set[str] = set()
    for index, group in enumerate(groups_raw[:12]):
        if not isinstance(group, dict):
            continue
        gid = _str(group.get("id"), f"g{index + 1}", 32)
        if gid in seen_groups:
            continue
        seen_groups.add(gid)
        groups.append({
            "id": gid,
            "name": _str(group.get("name"), f"Group {index + 1}", 40),
            "color": _str(group.get("color"), GROUP_COLORS[index % len(GROUP_COLORS)], 16),
            "enabled": _bool(group.get("enabled"), True),
            "settings": _settings(group.get("settings")),
        })
    workspace["syncGroups"] = groups

    charts = []
    seen_charts: set[str] = set()
    for index, raw_chart in enumerate(charts_raw):
        if not isinstance(raw_chart, dict):
            continue
        config = _chart_config(raw_chart, index, seen_groups)
        base = config["id"]
        suffix = 2
        while config["id"] in seen_charts:
            config["id"] = f"{base}-{suffix}"
            suffix += 1
        seen_charts.add(config["id"])
        charts.append(config)
    workspace["charts"] = charts

    workspace["columns"] = _fractions(source.get("columns"), _column_count(workspace["layout"], charts),
                                      custom=workspace["layout"] == "custom")
    workspace["rows"] = _fractions(source.get("rows"), _row_count(workspace["layout"], charts),
                                   custom=workspace["layout"] == "custom")
    workspace["globalSettings"] = _settings(source.get("globalSettings"))
    workspace["updatedAt"] = _int(source.get("updatedAt"), int(time.time() * 1000), 0, 10**14)
    return workspace


def _column_count(layout: str, charts: list) -> int:
    fixed = {"1": 1, "2h": 2, "2v": 1, "4": 2, "6": 3, "8": 4}.get(layout)
    if fixed:
        return fixed
    n = max(1, len(charts))
    return n if n <= 2 else 2 if n <= 4 else 3 if n <= 6 else 4


def _row_count(layout: str, charts: list) -> int:
    fixed = {"1": 1, "2h": 1, "2v": 2, "4": 2, "6": 2, "8": 2}.get(layout)
    if fixed:
        return fixed
    n = max(1, len(charts))
    cols = _column_count("custom", charts)
    return max(1, (n + cols - 1) // cols)


def _store(raw: dict) -> dict:
    source = raw if isinstance(raw, dict) else {}
    raw_workspaces = source.get("workspaces") if isinstance(source.get("workspaces"), list) else []
    workspaces = []
    seen: set[str] = set()
    for index, item in enumerate(raw_workspaces[:MAX_WORKSPACES]):
        workspace = _workspace(item, index)
        if workspace["id"] in seen:
            workspace["id"] = f"{workspace['id']}-{index}"
        seen.add(workspace["id"])
        workspaces.append(workspace)
    if not workspaces:
        return default_store()
    active = _str(source.get("active"), workspaces[0]["id"], 40)
    if active not in seen:
        active = workspaces[0]["id"]
    return {"version": STORE_VERSION, "active": active, "workspaces": workspaces}


# ── Disk I/O ─────────────────────────────────────────────────────────────────

def load_store() -> dict:
    if not WORKSPACES_FILE.exists():
        return default_store()
    try:
        with open(WORKSPACES_FILE, "r") as f:
            raw = json.load(f)
    except (OSError, ValueError) as exc:
        log.error("Could not read workspaces file: %s", exc)
        # Preserve the unreadable file for inspection instead of deleting it.
        try:
            WORKSPACES_FILE.replace(WORKSPACES_FILE.with_suffix(".json.corrupt"))
        except OSError:
            pass
        return default_store()
    return _store(raw)


def save_store(raw: dict) -> dict:
    """Validate, clamp and atomically persist the workspace store."""
    store = _store(raw)
    WORKSPACES_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = WORKSPACES_FILE.with_name(f"{WORKSPACES_FILE.name}.tmp.{os.getpid()}")
    with open(tmp, "w") as f:
        json.dump(store, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(10):
        try:
            tmp.replace(WORKSPACES_FILE)
            break
        except PermissionError:            # Windows: file held by another reader
            if attempt == 9:
                raise
            time.sleep(0.01)
    return store


def delete_workspace(store: dict, workspace_id: str) -> dict:
    payload = dict(store if isinstance(store, dict) else {})
    workspaces = [w for w in payload.get("workspaces", []) if isinstance(w, dict)
                  and w.get("id") != workspace_id]
    if not workspaces:
        raise ValueError("Cannot delete the last workspace")
    payload["workspaces"] = workspaces
    if payload.get("active") == workspace_id:
        payload["active"] = workspaces[0].get("id")
    return save_store(payload)
