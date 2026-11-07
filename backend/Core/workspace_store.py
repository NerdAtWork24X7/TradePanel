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
import re
import time
import uuid
from typing import Any

from backend.Core.config import DATA_DIR
from backend.Core.market_data import TIMEFRAMES

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
    "priceScale": "independent",
    "nearestPolicy": "previous",
    "maxDriftBars": 2,
    "referenceMode": "first_visible",
    "referenceTime": None,
}

MAX_CHART_INDICATORS = 20
MAX_INDICATOR_INPUTS = 64
MAX_INDICATOR_PLOTS = 32
INDICATOR_ID = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
PLOT_COLOR = re.compile(r"^(#[0-9a-fA-F]{3,8}|transparent)$")

DRAWING_TOOLS = ("hline", "vline", "trend", "rect", "fib", "text")

# Drawing kinds accepted from the chart layer (lightweight-charts-drawing
# 0.6.3 plus the host's custom position tools). Anything else is dropped.
DRAWING_KINDS = frozenset({
    "trend-line", "ray", "info-line", "extended-line", "trend-angle",
    "horizontal-line", "horizontal-ray", "vertical-line", "cross-line",
    "parallel-channel", "regression-trend", "flat-top-bottom", "disjoint-channel",
    "pitchfork", "schiff-pitchfork", "modified-schiff-pitchfork", "inside-pitchfork",
    "fib-retracement", "trend-based-fib-extension", "fib-channel", "fib-time-zone",
    "fib-speed-resistance-fan", "trend-based-fib-time", "fib-circles", "fib-spiral",
    "fib-speed-resistance-arcs", "fib-wedge", "pitchfan",
    "gann-box", "gann-square-fixed", "gann-square", "gann-fan",
    "xabcd-pattern", "cypher-pattern", "head-and-shoulders", "abcd-pattern",
    "triangle-pattern", "three-drives-pattern",
    "elliott-impulse", "elliott-correction", "elliott-triangle",
    "elliott-double-combo", "elliott-triple-combo",
    "cyclic-lines", "time-cycles", "sine-line",
    "long-position", "short-position", "position-forecast", "bar-pattern",
    "ghost-feed", "sector", "anchored-vwap", "fixed-range-volume-profile",
    "anchored-volume-profile", "price-range", "date-range", "date-and-price-range",
    "brush", "highlighter", "arrow-marker", "arrow", "arrow-mark-up", "arrow-mark-down",
    "rectangle", "rotated-rectangle", "path", "circle", "ellipse", "polyline",
    "triangle", "arc", "curve", "double-curve",
    "text", "note", "price-note", "pin", "table", "callout", "comment",
    "price-label", "signpost", "flag-mark", "image", "font-icon",
})

MAX_DRAWING_POINTS = 512
MAX_DRAWING_BYTES = 64_000

# Chart price alerts live at the store root: a rule targets an instrument, not
# a layout, so it survives session switches.
MAX_ALERTS = 200
ALERT_CONDITIONS = ("crossing", "crossing-up", "crossing-down", "greater", "less")
ALERT_FREQUENCIES = ("once", "repeating")
ALERT_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


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
        "indicators": [],
        "showVolume": True,
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
    return {
        "version": STORE_VERSION,
        "active": workspace["id"],
        "alerts": [],
        "workspaces": [workspace],
    }


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


def _indicator_inputs(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, Any] = {}
    for key, raw in list(value.items())[:MAX_INDICATOR_INPUTS]:
        if not isinstance(key, str) or not key or len(key) > 64:
            continue
        if isinstance(raw, bool):
            out[key] = raw
        elif isinstance(raw, (int, float)) and not isinstance(raw, bool):
            number = float(raw)
            if number == number and abs(number) <= 1e9:
                out[key] = raw
        elif isinstance(raw, str):
            out[key] = raw[:120]
    return out


def _indicator_plots(value: Any) -> dict[str, Any]:
    """Per-plot style overrides (colour, width, visibility) keyed by plot id."""
    if not isinstance(value, dict):
        return {}
    out: dict[str, Any] = {}
    for plot_id, raw in list(value.items())[:MAX_INDICATOR_PLOTS]:
        if not isinstance(plot_id, str) or not plot_id or len(plot_id) > 64:
            continue
        if not isinstance(raw, dict):
            continue
        item: dict[str, Any] = {}
        color = raw.get("color")
        if isinstance(color, str) and PLOT_COLOR.match(color):
            item["color"] = color
        if isinstance(raw.get("lineWidth"), int) and not isinstance(raw.get("lineWidth"), bool):
            item["lineWidth"] = max(0, min(4, int(raw["lineWidth"])))
        if isinstance(raw.get("visible"), bool):
            item["visible"] = raw["visible"]
        if item:
            out[plot_id] = item
    return out


def _indicators(value: Any) -> list[dict[str, Any]]:
    """Chart indicator list: one entry per on-chart instance.

    Ids may repeat — the same study can be added several times with different
    inputs/styles (two VWAPs, RSI 14 + RSI 50); only the total is capped.
    """
    if not isinstance(value, list):
        return []
    out: list[dict[str, Any]] = []
    for item in value:
        if not isinstance(item, dict) or len(out) >= MAX_CHART_INDICATORS:
            continue
        indicator_id = item.get("id")
        if not isinstance(indicator_id, str):
            continue
        indicator_id = indicator_id.strip()
        if not INDICATOR_ID.match(indicator_id):
            continue
        out.append({
            "id": indicator_id,
            "inputs": _indicator_inputs(item.get("inputs")),
            "plots": _indicator_plots(item.get("plots")),
            "visible": _bool(item.get("visible"), True),
        })
    return out


def _drawing_points(value: Any) -> list[dict]:
    """Anchors of a drawing: epoch seconds (or a date string) + price."""
    if not isinstance(value, list):
        return []
    out = []
    for point in value[:MAX_DRAWING_POINTS]:
        if not isinstance(point, dict):
            continue
        time = point.get("time")
        if isinstance(time, str):
            # Lightweight Charts accepts a business-day string ("2024-01-31").
            if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", time):
                continue
        elif isinstance(time, (int, float)) and not isinstance(time, bool):
            time = _int(time, 0, 0, 4102444800)
        else:
            continue
        out.append({"time": time, "price": _num(point.get("price"), 0.0, -1e12, 1e12)})
    return out


def _json_clean(value: Any, depth: int = 0) -> Any:
    """Bounded JSON copy for drawing style/kind-specific metadata."""
    if depth > 6:
        return None
    if isinstance(value, bool) or value is None:
        return value
    if isinstance(value, (int, float)):
        number = float(value)
        return number if number == number else None
    if isinstance(value, str):
        return value[:4000]
    if isinstance(value, list):
        items = [_json_clean(item, depth + 1) for item in value[:256]]
        items = [item for item in items if item is not None]
        return items or None
    if isinstance(value, dict):
        out = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 60 or not isinstance(key, str):
                break
            clean = _json_clean(item, depth + 1)
            if clean is not None:
                out[key[:40]] = clean
        return out or None
    return None


def _drawing(value: dict) -> dict | None:
    """One drawing of the chart layer, new (kind) or legacy (tool) model."""
    raw_points = value.get("points")
    kind = _str(value.get("kind"), "", 40)
    if kind:
        if kind not in DRAWING_KINDS:
            return None
        points = _drawing_points(raw_points)
        if not points:
            return None
        record: dict[str, Any] = {
            "id": _str(value.get("id"), f"dw-{uuid.uuid4().hex[:6]}", 64),
            "kind": kind,
            "points": points,
        }
        style = _json_clean(value.get("style"))
        if isinstance(style, dict) and style:
            record["style"] = style
        for field, limit in (("text", 2000), ("name", 120), ("glyph", 2000),
                             ("group", 64), ("owner", 64)):
            text = value.get(field)
            if isinstance(text, str) and text:
                record[field] = text[:limit]
        for field in ("locked", "hidden", "closed"):
            if value.get(field) is True:
                record[field] = True
        fmt = value.get("fmt")
        if isinstance(fmt, int) and not isinstance(fmt, bool):
            record["fmt"] = fmt
        # Kind-specific payloads the renderer needs back after a reload.
        for field in ("visibility", "image", "pattern", "ghost", "anchored", "table"):
            clean = _json_clean(value.get(field))
            if isinstance(clean, dict) and clean:
                record[field] = clean
        if len(json.dumps(record)) > MAX_DRAWING_BYTES:
            return None
        return record

    tool = _str(value.get("tool"), "", 12)
    if tool not in DRAWING_TOOLS:
        return None
    clean_points = []
    if isinstance(raw_points, list):
        for point in raw_points[:8]:
            if not isinstance(point, dict):
                continue
            clean_points.append({
                "time": _int(point.get("time"), 0, 0, 4102444800),
                "price": _num(point.get("price"), 0.0, -1e12, 1e12),
            })
    return {
        "id": _str(value.get("id"), f"d-{uuid.uuid4().hex[:6]}", 40),
        "tool": tool,
        "points": clean_points,
        "color": _str(value.get("color"), "#F5C400", 16),
        "text": _str(value.get("text"), "", 120),
    }


def _drawings(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    out = []
    for raw in value[:400]:
        if not isinstance(raw, dict):
            continue
        record = _drawing(raw)
        if record is not None:
            out.append(record)
    return out


def _alert(raw: Any) -> dict | None:
    """One price-alert rule; unusable targets are dropped, not defaulted."""
    if not isinstance(raw, dict):
        return None
    price = _num(raw.get("price"), 0.0, 0.0, 1e12)
    symbol = _str(raw.get("symbol"), "", 32).upper()
    exchange = _str(raw.get("exchange"), "", 16).lower()
    market = _str(raw.get("market"), "spot", 12).lower()
    if price <= 0 or not symbol or exchange not in EXCHANGES:
        return None
    if market not in ("spot", "futures"):
        market = "spot"
    condition = _str(raw.get("condition"), "crossing", 20)
    frequency = _str(raw.get("frequency"), "once", 20)
    alert_id = _str(raw.get("id"), "", 40)
    if not ALERT_ID.match(alert_id):
        alert_id = f"a-{uuid.uuid4().hex[:10]}"
    return {
        "id": alert_id,
        "exchange": exchange,
        "market": market,
        "symbol": symbol,
        "timeframe": _str(raw.get("timeframe"), "", 8),
        "price": price,
        "condition": condition if condition in ALERT_CONDITIONS else "crossing",
        "frequency": frequency if frequency in ALERT_FREQUENCIES else "once",
        "note": _str(raw.get("note"), "", 120),
        "enabled": _bool(raw.get("enabled"), True),
        "createdAt": _int(raw.get("createdAt"), int(time.time() * 1000), 0, 10**14),
    }


def _alerts(value: Any) -> list[dict]:
    if not isinstance(value, list):
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for item in value[:MAX_ALERTS]:
        alert = _alert(item)
        if alert is None or alert["id"] in seen:
            continue
        seen.add(alert["id"])
        out.append(alert)
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
    # Pre-2026-11 stores kept a dict of built-in flags; only its volume flag
    # carries over, every hand-written indicator is discarded.
    legacy_indicators = raw.get("indicators")
    legacy_volume = True
    if isinstance(legacy_indicators, dict):
        volume = legacy_indicators.get("volume")
        if isinstance(volume, dict):
            legacy_volume = _bool(volume.get("enabled"), True)
    chart["indicators"] = _indicators(legacy_indicators)
    chart["showVolume"] = _bool(raw.get("showVolume"), legacy_volume)
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
    return {
        "version": STORE_VERSION,
        "active": active,
        "alerts": _alerts(source.get("alerts")),
        "workspaces": workspaces,
    }


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
