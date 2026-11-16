"""Hyperliquid perp account for the crypto plugin (read + trade).

Safety posture, the same as TradePanel's:
  * ``network`` defaults to **testnet**; live is a per-credential choice.
  * the private key never touches this module's logs and arrives in the app's
    `plugin.configure` message from the OS credential store.
  * OpenTrader refuses to place or change orders until its own trading switch is on,
    and asks for confirmation on every live order. This module adds no way around that.

Positions, orders and executions use the plugin's data tickers, so a position opens on
the chart of the same symbol without a mapping: ``HYPERLIQUID:BTC/USDC.P``. A bare coin
(``HYPERLIQUID:BTC``) is accepted too, for a chart added before the market data loaded.
"""

from __future__ import annotations

import json
import math
import threading
import time
from decimal import Decimal, ROUND_DOWN
from typing import Any, Callable

from crypto_source import CryptoSource, PluginError

TESTNET = "testnet"
LIVE = "live"

FILL_HISTORY = 24 * 3600 * 1000  # recent executions shown, ms
MAX_EXECUTIONS = 100
MAX_ORDERS = 60


def coin_of(ticker: str) -> str:
    """``HYPERLIQUID:BTC/USDC.P`` → ``BTC``; ``HYPERLIQUID:BTC`` → ``BTC``."""
    head = ticker.split(":", 1)[1] if ":" in ticker else ticker
    head = head.strip()
    if head.endswith(".P"):
        head = head[:-2]
    return head.split("/", 1)[0].strip().upper()


def round_size(qty: float, sz_decimals: int) -> float:
    """A size Hyperliquid accepts: `szDecimals` decimals, rounded down (never overshoot)."""
    if not math.isfinite(qty) or qty <= 0:
        raise PluginError("The quantity must be positive", -32602)
    step = Decimal(1).scaleb(-max(0, int(sz_decimals)))
    size = Decimal(str(qty)).quantize(step, rounding=ROUND_DOWN)
    if size <= 0:
        raise PluginError(f"The quantity is smaller than the market's step ({step})", -32602)
    return float(size)


def round_price(price: float, sz_decimals: int) -> float:
    """Hyperliquid's perp price rule: 5 significant figures, then ``6 - szDecimals`` decimals."""
    if not math.isfinite(price) or price <= 0:
        raise PluginError("The price must be positive", -32602)
    decimals = max(0, 6 - int(sz_decimals))
    try:
        return round(float(f"{price:.5g}"), decimals)
    except (ValueError, OverflowError) as e:
        raise PluginError(f"The price {price} cannot be represented") from e


def _num(value: Any, default: float = 0.0) -> float:
    try:
        n = float(value)
        return n if math.isfinite(n) else default
    except (TypeError, ValueError):
        return default


def _side(value: str) -> str:
    return "buy" if str(value).upper() in ("B", "BUY") else "sell"


def _short(address: str) -> str:
    return f"{address[:6]}…{address[-4:]}" if len(address) > 12 else address


def order_type_of(order: dict[str, Any]) -> str:
    """`market` / `limit` / `stop` / `stopLimit` from Hyperliquid's order row."""
    label = str(order.get("orderType") or "").lower()
    if not order.get("isTrigger"):
        return "limit"
    return "stopLimit" if "limit" in label else "stop"


def trigger_kind(order: dict[str, Any]) -> str | None:
    """`tp` / `sl` for a reduce-only trigger order, from its label."""
    label = str(order.get("orderType") or "").lower()
    if "take profit" in label:
        return "tp"
    if "stop" in label:
        return "sl"
    return None


def bracket_levels(position_szi: float, triggers: list[float], entry: float = 0.0) -> tuple[float | None, float | None]:
    """Take profit and stop loss of a position from its trigger prices.

    Hyperliquid does not label position-level TP/SL consistently across trailing stops, so
    the side decides when the labels are missing: for a long the higher trigger is the
    target, for a short the lower one is. With a single trigger, the entry says which leg
    it is.
    """
    if not triggers:
        return None, None
    if len(triggers) == 1:
        trigger = triggers[0]
        if entry > 0:
            return (trigger, None) if (position_szi >= 0) == (trigger > entry) else (None, trigger)
        return trigger, None
    low, high = sorted(triggers)[:2]
    return (high, low) if position_szi >= 0 else (low, high)


class HyperliquidBroker:
    """One Hyperliquid account, polled on a thread and commanded from the app's requests."""

    def __init__(
        self,
        data: CryptoSource,
        log: Callable[[str], None],
        notify: Callable[[str], None],
        event: Callable[[dict[str, Any]], None],
    ):
        self._data = data
        self._log = log
        self._notify = notify
        self._event = event
        self._lock = threading.RLock()
        self._settings: dict[str, str] = {}
        self._network = TESTNET
        self._address = ""
        self._info: Any = None
        self._exchange: Any = None
        self._universe: dict[str, dict[str, Any]] = {}
        self._state: dict[str, Any] = {"connected": False}
        self._fingerprint = ""
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seen_fills: set[str] = set()
        self._seen_once = False
        self._pending_brackets: dict[str, tuple[float | None, float | None]] = {}
        self._watch: set[str] = set()
        self._online = False
        self._tickers: dict[str, str] = {}
        self._warned_no_key = False
        self._last_error = ""
        self._last_error_at = 0.0

    # ── lifecycle ────────────────────────────────────────────────────────────

    def configure(self, settings: dict[str, str]) -> None:
        """Apply the form values; a changed key or network rebuilds the SDK clients."""
        key = str(settings.get("privateKey") or "").strip()
        address = str(settings.get("accountAddress") or "").strip()
        network = LIVE if str(settings.get("network") or "").strip().lower() == LIVE else TESTNET
        before = (self._network, self._address, self._settings.get("privateKey"))
        self._settings = dict(settings)
        self._network = network
        self._address = address
        after = (self._network, self._address, key)
        if before != after:
            with self._lock:
                self._info = None
                self._exchange = None
                self._universe = {}
                self._seen_once = False
        if key and not address:
            # The wallet key's own address is the account unless an agent wallet names another.
            try:
                from eth_account import Account  # noqa: PLC0415 - optional dependency

                self._address = Account.from_key(key).address
            except Exception:  # noqa: BLE001 - reported by the poll, not here
                self._address = ""
        self._connect()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="hyperliquid-broker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _poll_seconds(self) -> float:
        try:
            return max(1.0, float(self._settings.get("pollSeconds") or 3.0))
        except (TypeError, ValueError):
            return 3.0

    def _base_url(self) -> str:
        from hyperliquid.utils import constants  # noqa: PLC0415 - optional dependency

        return constants.MAINNET_API_URL if self._network == LIVE else constants.TESTNET_API_URL

    def _connect(self) -> None:
        """Build the SDK clients once a key is present (idempotent)."""
        with self._lock:
            if self._info is not None and self._exchange is not None:
                return
            key = str(self._settings.get("privateKey") or "").strip()
            if not key or not self._address:
                self._online = False
                self._state = {"connected": False}
                if not self._warned_no_key:
                    self._warned_no_key = True
                    self._notify("warn", "Hyperliquid: set the wallet private key in the plugin settings")
                return
            self._warned_no_key = False
            try:
                from eth_account import Account  # noqa: PLC0415
                from hyperliquid.exchange import Exchange  # noqa: PLC0415
                from hyperliquid.info import Info  # noqa: PLC0415

                wallet = Account.from_key(key)
                base = self._base_url()
                self._info = Info(base, skip_ws=True)
                # `account_address` lets an API (agent) wallet act for the main account.
                self._exchange = Exchange(wallet, base, account_address=self._address)
                meta = self._info.meta() or {}
                self._universe = {str(u.get("name")): u for u in meta.get("universe", []) if u.get("name")}
                self._online = True
                self._log(f"Hyperliquid {self._network}: account {_short(self._address)}")
            except PluginError:
                raise
            except Exception as e:  # noqa: BLE001 - an SDK or credential error reaches the user
                self._info = None
                self._exchange = None
                self._online = False
                raise PluginError(f"Hyperliquid: {e}") from e

    # ── state ────────────────────────────────────────────────────────────────

    def state(self) -> dict[str, Any]:
        with self._lock:
            return self._state

    def _coin(self, ticker: str) -> str:
        coin = coin_of(ticker)
        if coin not in self._universe:
            raise PluginError(f"Hyperliquid does not trade {coin}", -32602)
        return coin

    def _decimals(self, coin: str) -> int:
        try:
            return int(self._universe[coin].get("szDecimals", 0))
        except (TypeError, ValueError):
            return 0

    def _loop(self) -> None:
        while not self._stop.wait(0.2):
            started = time.time()
            try:
                self._refresh()
            except PluginError as e:
                self._warn(str(e), "warn")
            except Exception as e:  # noqa: BLE001 - keep the poll alive
                self._warn(f"Hyperliquid: {e}", "error")
            self._stop.wait(max(0.5, self._poll_seconds() - (time.time() - started)))

    def _warn(self, message: str, level: str) -> None:
        """One notice per distinct failure, repeated at most every minute: a venue hiccup
        must not fill the plugin log with the same line every poll."""
        now = time.time()
        if message == self._last_error and now - self._last_error_at < 60.0:
            return
        self._last_error = message
        self._last_error_at = now
        self._notify(level, message)

    def _refresh(self) -> None:
        self._connect()
        if not self._online:
            self._publish({"connected": False})
            return
        info = self._info
        address = self._address
        state = info.user_state(address) or {}
        orders = self._open_orders()
        fills = self._fills()
        mids = info.all_mids() or {}

        account, _ = self._account(state, fills)
        positions = self._positions(state, orders, mids)
        wire_orders = self._orders(orders, fills, positions)
        executions = self._executions(fills)
        payload = {
            "connected": True,
            "accounts": [{"id": address, "name": f"Hyperliquid {self._network} {_short(address)}"}],
            "account": account,
            "positionMode": "netting",
            "capabilities": {
                "orderTypes": ["market", "limit", "stop", "stopLimit"],
                "brackets": True,
                "positionBrackets": True,
                "partialClose": True,
                "modifyOrders": True,
            },
            "positions": positions,
            "orders": wire_orders,
            "executions": executions,
        }
        self._publish(payload)
        self._emit_new_fills(executions)
        self._apply_pending_brackets(positions)
        self._emit_quotes(mids)

    def _open_orders(self) -> list[dict[str, Any]]:
        info = self._info
        for name in ("frontend_open_orders", "open_orders"):
            fn = getattr(info, name, None)
            if fn is None:
                continue
            try:
                rows = fn(self._address) or []
            except Exception as e:  # noqa: BLE001 - a venue hiccup must not kill the state
                self._log(f"[broker] {name}: {e}")
                continue
            if isinstance(rows, dict):
                rows = rows.get("orders") or []
            if rows:
                return rows
        return []

    def _fills(self) -> list[dict[str, Any]]:
        try:
            rows = self._info.user_fills(self._address) or []
        except Exception as e:  # noqa: BLE001
            self._log(f"[broker] fills: {e}")
            return []
        cutoff = time.time() * 1000 - FILL_HISTORY
        rows = [r for r in rows if _num(r.get("time")) >= cutoff]
        rows.sort(key=lambda r: _num(r.get("time")))
        return rows[-MAX_EXECUTIONS * 2:]

    def ticker_of_coin(self, coin: str) -> str:
        """The chart symbol of a coin: the perp market's ticker when the data source has it."""
        return self._ticker(coin)

    def resolve_symbol(self, symbol: str, ticker: str) -> str | None:
        """The broker ticker of a chart symbol: itself when Hyperliquid trades its coin,
        the base asset when the chart is on another venue (``BINANCE:BTCUSDT`` → BTC)."""
        coin = coin_of(ticker or symbol)
        if coin in self._universe:
            return self._ticker(coin)
        for quote in ("FDUSD", "USDT", "USDC", "USD", "BTC", "ETH"):
            if coin.endswith(quote) and len(coin) > len(quote):
                base = coin[: -len(quote)]
                return self._ticker(base) if base in self._universe else None
        return None

    def _ticker(self, coin: str) -> str:
        """The chart symbol of a coin: the perp market's ticker when the data source has it."""
        cached = self._tickers.get(coin)
        if cached:
            return cached
        for kind in ("swap", "spot"):
            try:
                loaded = self._data._ensure("HYPERLIQUID", kind)  # noqa: SLF001 - same plugin
            except PluginError:
                continue
            for market in loaded.by_ticker.values():
                if market.base.upper() == coin.upper():
                    ticker = f"HYPERLIQUID:{market.ticker}"
                    self._tickers[coin] = ticker
                    return ticker
        ticker = f"HYPERLIQUID:{coin}"
        self._tickers[coin] = ticker
        return ticker

    def _account(self, state: dict[str, Any], fills: list[dict[str, Any]]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        margin = state.get("marginSummary") or state.get("crossMarginSummary") or {}
        account_value = _num(margin.get("accountValue"))
        margin_used = _num(margin.get("totalMarginUsed"))
        notional = _num(margin.get("totalNtlPos"))
        withdrawable = _num(state.get("withdrawable"))
        positions = []
        unrealized = 0.0
        for item in state.get("assetPositions") or []:
            position = item.get("position") or {}
            szi = _num(position.get("szi"))
            if szi == 0:
                continue
            unrealized += _num(position.get("unrealizedPnl"))
            last = _num(position.get("positionValue")) / abs(szi) if szi else None
            positions.append({
                "coin": str(position.get("coin") or ""),
                "szi": szi,
                "entry": _num(position.get("entryPx")),
                "last": last,
                "unrealized": _num(position.get("unrealizedPnl")),
                "leverage": _num((position.get("leverage") or {}).get("value")),
                "liquidation": _num(position.get("liquidationPx")) or None,
            })
        closes = [_num(f.get("closedPnl")) for f in fills if f.get("closedPnl") not in (None, "")]
        account = {
            "id": self._address,
            "name": f"Hyperliquid {self._network}",
            "currency": "USDC",
            "isDemo": self._network == TESTNET,
            "balance": account_value,
            "equity": account_value,
            "unrealizedPnl": unrealized,
            "realizedPnl": sum(closes),
            "marginUsed": margin_used,
            "marginFree": withdrawable,
            "values": [
                {"label": "Network", "value": "Testnet" if self._network == TESTNET else "Live"},
                {"label": "Account", "value": _short(self._address)},
                {"label": "Notional", "value": f"{notional:,.2f} USDC"},
                {"label": "Withdrawable", "value": f"{withdrawable:,.2f} USDC"},
            ],
        }
        return account, positions

    def _positions(self, state: dict[str, Any], orders: list[dict[str, Any]], mids: dict[str, Any]) -> list[dict[str, Any]]:
        rows = []
        for item in state.get("assetPositions") or []:
            position = item.get("position") or {}
            coin = str(position.get("coin") or "")
            szi = _num(position.get("szi"))
            if not coin or szi == 0:
                continue
            ticker = self._ticker(coin)
            triggers = [
                _num(o.get("triggerPx"))
                for o in orders
                if str(o.get("coin")) == coin and o.get("isTrigger") and _num(o.get("triggerPx")) > 0
            ]
            tp, sl = bracket_levels(szi, triggers, _num(position.get("entryPx")))
            rows.append({
                "id": f"pos:{coin}",
                "ticker": ticker,
                "side": "buy" if szi > 0 else "sell",
                "qty": abs(szi),
                "avgPrice": _num(position.get("entryPx")),
                "last": _num(mids.get(coin)) or _num(position.get("positionValue")) / abs(szi),
                "unrealizedPnl": _num(position.get("unrealizedPnl")),
                "takeProfit": tp,
                "stopLoss": sl,
            })
        return rows

    def _orders(self, orders: list[dict[str, Any]], fills: list[dict[str, Any]], positions: list[dict[str, Any]]) -> list[dict[str, Any]]:
        by_oid = {str(o.get("oid")): o for o in orders}
        rows: list[dict[str, Any]] = []
        for order in orders:
            oid = str(order.get("oid"))
            if not oid or oid == "None":
                continue
            trigger = bool(order.get("isTrigger"))
            children = [by_oid.get(str(c)) for c in (order.get("children") or [])]
            child_tp = next((_num(c.get("triggerPx")) for c in children if c and trigger_kind(c) == "tp"), None)
            child_sl = next((_num(c.get("triggerPx")) for c in children if c and trigger_kind(c) == "sl"), None)
            rows.append({
                "id": oid,
                "ticker": self._ticker(str(order.get("coin") or "")),
                "side": _side(str(order.get("side") or "B")),
                "type": order_type_of(order),
                "qty": _num(order.get("origSz") or order.get("sz")),
                "filledQty": max(0.0, _num(order.get("origSz")) - _num(order.get("sz"))),
                "limitPrice": _num(order.get("limitPx")) if not trigger else None,
                "stopPrice": _num(order.get("triggerPx")) if trigger else None,
                "takeProfit": child_tp or None,
                "stopLoss": child_sl or None,
                "status": "working",
                "duration": "gtc" if not trigger else None,
                "updatedMs": _num(order.get("timestamp")),
            })
        # Fills become filled orders, so the account manager shows what just happened.
        filled: dict[str, dict[str, Any]] = {}
        for fill in fills:
            oid = str(fill.get("oid") or "")
            if not oid or oid == "None" or oid in by_oid:
                continue
            row = filled.setdefault(oid, {
                "id": oid,
                "ticker": self._ticker(str(fill.get("coin") or "")),
                "side": _side(str(fill.get("side") or "B")),
                "type": "market" if fill.get("crossed") else "limit",
                "qty": 0.0,
                "filledQty": 0.0,
                "avgFillPrice": 0.0,
                "takeProfit": None,
                "stopLoss": None,
                "status": "filled",
                "updatedMs": 0.0,
            })
            qty = _num(fill.get("sz"))
            price = _num(fill.get("px"))
            before = row["filledQty"]
            total = before + qty
            row["qty"] = total
            row["filledQty"] = total
            row["avgFillPrice"] = (row["avgFillPrice"] * before + price * qty) / total if total else price
            row["updatedMs"] = max(row["updatedMs"], _num(fill.get("time")))
        rows.extend(filled.values())
        rows.sort(key=lambda r: -_num(r.get("updatedMs")))
        return rows[:MAX_ORDERS]

    def _executions(self, fills: list[dict[str, Any]]) -> list[dict[str, Any]]:
        rows = []
        for fill in fills:
            tid = fill.get("tid")
            fill_id = f"{fill.get('hash') or ''}:{tid if tid is not None else fill.get('time')}"
            rows.append({
                "id": fill_id,
                "orderId": str(fill.get("oid") or "") or None,
                "ticker": self._ticker(str(fill.get("coin") or "")),
                "side": _side(str(fill.get("side") or "B")),
                "qty": _num(fill.get("sz")),
                "price": _num(fill.get("px")),
                "timeMs": _num(fill.get("time")),
                "commission": abs(_num(fill.get("fee"))),
                "realizedPnl": _num(fill.get("closedPnl")),
            })
        return rows[-MAX_EXECUTIONS:]

    def _publish(self, payload: dict[str, Any]) -> None:
        fingerprint = json.dumps(payload, sort_keys=True, default=str)
        with self._lock:
            if fingerprint == self._fingerprint:
                return
            self._fingerprint = fingerprint
            self._state = payload
        self._notify_state(payload)

    def _notify_state(self, payload: dict[str, Any]) -> None:
        self._event({"__state__": payload})  # the glue sends broker.state

    def _emit_new_fills(self, executions: list[dict[str, Any]]) -> None:
        ids = {e["id"] for e in executions}
        if not self._seen_once:
            self._seen_fills = ids
            self._seen_once = True
            return
        for execution in executions:
            if execution["id"] in self._seen_fills:
                continue
            self._event({
                "kind": "executed",
                "ticker": execution["ticker"],
                "side": execution["side"],
                "type": "market",
                "qty": execution["qty"],
                "price": execution["price"],
            })
        self._seen_fills = ids

    def _emit_quotes(self, mids: dict[str, Any]) -> None:
        for ticker in list(self._watch):
            coin = coin_of(ticker)
            mid = _num(mids.get(coin)) or None
            if mid is None:
                continue
            bid = ask = None
            try:
                book = self._info.l2_snapshot(coin) or {}
                levels = book.get("levels") or []
                if len(levels) >= 2 and levels[0] and levels[1]:
                    bid = _num(levels[0][0].get("px")) or None
                    ask = _num(levels[1][0].get("px")) or None
            except Exception:  # noqa: BLE001 - the mid is enough for the ticket
                pass
            self._event({"__quote__": {"ticker": ticker, "bid": bid, "ask": ask, "last": mid}})

    # ── commands ─────────────────────────────────────────────────────────────

    def _require(self) -> tuple[Any, str]:
        self._connect()
        if not self._online or self._exchange is None:
            raise PluginError("Hyperliquid is not connected: set the wallet private key in the plugin settings")
        return self._exchange, self._address

    @staticmethod
    def _response_id(response: Any) -> str:
        """The order id in an SDK answer, or a readable refusal."""
        if not isinstance(response, dict):
            raise PluginError(f"Hyperliquid answered {response!r}")
        status = response.get("status")
        data = (response.get("response") or {}).get("data") or {}
        statuses = data.get("statuses") if isinstance(data, dict) else None
        if status and status != "ok":
            raise PluginError(f"Hyperliquid: {status}")
        for item in statuses or []:
            if not isinstance(item, dict):
                continue
            if "error" in item:
                raise PluginError(f"Hyperliquid: {item['error']}")
            for key in ("resting", "filled"):
                if key in item and isinstance(item[key], dict):
                    oid = item[key].get("oid")
                    if oid is not None:
                        return str(oid)
        raise PluginError("Hyperliquid accepted the order without an id")

    def place(self, ticket: dict[str, Any], modify_oid: str | None = None, announce: bool = True) -> str:
        exchange, _ = self._require()
        ticker = str(ticket.get("ticker") or "")
        coin = self._coin(ticker)
        szd = self._decimals(coin)
        qty = round_size(_num(ticket.get("qty")), szd)
        side = str(ticket.get("side") or "buy").lower()
        is_buy = side == "buy"
        kind = str(ticket.get("type") or "market")
        limit = ticket.get("limitPrice")
        stop = ticket.get("stopPrice")
        try:
            slippage = max(0.001, min(0.05, float(self._settings.get("slippage") or 0.5) / 100))
        except (TypeError, ValueError):
            slippage = 0.005
        price = None
        if kind in ("limit", "stopLimit"):
            price = round_price(_num(limit), szd)
        try:
            if modify_oid:
                if kind in ("market", "stop", "stopLimit"):
                    # HL modifies the price of a resting order; market/trigger entries are replaced.
                    exchange.cancel(coin, int(modify_oid))
                    return self.place(ticket, announce=False)
                response = exchange.modify_order(int(modify_oid), coin, is_buy, qty, price, {"limit": {"tif": "Gtc"}})
            elif kind == "market":
                response = exchange.market_open(coin, is_buy, qty, None, slippage)
            elif kind == "limit":
                response = exchange.order(coin, is_buy, qty, price, {"limit": {"tif": "Gtc"}})
            elif kind == "stop":
                trigger = round_price(_num(stop), szd)
                response = exchange.order(coin, is_buy, qty, trigger, {
                    "trigger": {"isMarket": True, "triggerPx": trigger, "tpsl": "sl"},
                })
            elif kind == "stopLimit":
                trigger = round_price(_num(stop), szd)
                response = exchange.order(coin, is_buy, qty, price, {
                    "trigger": {"isMarket": False, "triggerPx": trigger, "tpsl": "sl"},
                })
            else:
                raise PluginError(f"Unknown order type {kind}", -32602)
        except PluginError:
            raise
        except Exception as e:  # noqa: BLE001 - SDK refusal text is what the user needs
            raise PluginError(f"Hyperliquid: {e}") from e
        order_id = self._response_id(response)
        tp, sl = ticket.get("takeProfit"), ticket.get("stopLoss")
        if tp is not None or sl is not None:
            with self._lock:
                self._pending_brackets[coin] = (
                    round_price(_num(tp), szd) if tp is not None else None,
                    round_price(_num(sl), szd) if sl is not None else None,
                )
        if announce:
            self._event({
                "kind": "placed",
                "ticker": ticker,
                "side": side,
                "type": kind,
                "qty": qty,
                "price": price if kind != "market" else None,
            })
        return order_id

    def modify(self, order_id: str, ticket: dict[str, Any]) -> None:
        self.place(ticket, modify_oid=order_id, announce=False)
        self._event({
            "kind": "modified",
            "ticker": str(ticket.get("ticker") or ""),
            "side": str(ticket.get("side") or "buy"),
            "type": str(ticket.get("type") or "limit"),
            "qty": _num(ticket.get("qty")),
            "price": _num(ticket.get("limitPrice")) or None,
        })

    def cancel(self, order_id: str) -> None:
        exchange, _ = self._require()
        order = next((o for o in self._open_orders() if str(o.get("oid")) == str(order_id)), None)
        if order is None:
            raise PluginError(f"Order {order_id} is not open")
        try:
            exchange.cancel(str(order.get("coin")), int(order_id))
        except Exception as e:  # noqa: BLE001
            raise PluginError(f"Hyperliquid: {e}") from e
        self._event({
            "kind": "cancelled",
            "ticker": self._ticker(str(order.get("coin") or "")),
            "side": _side(str(order.get("side") or "B")),
            "type": order_type_of(order),
            "qty": _num(order.get("sz")),
            "price": _num(order.get("limitPx")) or None,
        })

    def close_position(self, position_id: str, qty: float | None = None) -> None:
        exchange, _ = self._require()
        coin = position_id.split(":", 1)[1] if position_id.startswith("pos:") else coin_of(position_id)
        if coin not in self._universe:
            raise PluginError(f"Hyperliquid does not trade {coin}", -32602)
        szd = self._decimals(coin)
        size = round_size(_num(qty), szd) if qty is not None else None
        try:
            response = exchange.market_close(coin, size)
        except Exception as e:  # noqa: BLE001
            raise PluginError(f"Hyperliquid: {e}") from e
        self._response_id(response)
        self._notify("info", f"{coin}: close {'sent' if size else 'submitted'}")

    def set_position_brackets(self, position_id: str, take_profit: float | None, stop_loss: float | None) -> None:
        exchange, _ = self._require()
        coin = position_id.split(":", 1)[1] if position_id.startswith("pos:") else coin_of(position_id)
        if coin not in self._universe:
            raise PluginError(f"Hyperliquid does not trade {coin}", -32602)
        state = self._info.user_state(self._address) or {}
        position = next(
            (p.get("position") for p in state.get("assetPositions") or [] if (p.get("position") or {}).get("coin") == coin),
            None,
        )
        if not position or _num(position.get("szi")) == 0:
            raise PluginError(f"{coin}: no open position")
        szi = _num(position.get("szi"))
        qty = round_size(abs(szi), self._decimals(coin))
        szd = self._decimals(coin)
        close_buy = szi < 0  # closing a short buys
        # Replace the coin's triggers: the old levels must not survive a new plan.
        for order in self._open_orders():
            if str(order.get("coin")) != coin or not order.get("isTrigger"):
                continue
            try:
                exchange.cancel(coin, int(order.get("oid")))
            except Exception as e:  # noqa: BLE001 - a stale leg is not worth failing the update
                self._log(f"[broker] cancel trigger {order.get('oid')}: {e}")
        errors = []
        for level, kind in ((take_profit, "tp"), (stop_loss, "sl")):
            if level is None:
                continue
            try:
                trigger = round_price(float(level), szd)
                self._response_id(exchange.order(
                    coin, close_buy, qty, trigger,
                    {"trigger": {"isMarket": True, "triggerPx": trigger, "tpsl": kind}},
                    reduce_only=True,
                ))
            except Exception as e:  # noqa: BLE001
                errors.append(f"{kind.upper()}: {e}")
        if errors:
            raise PluginError(f"{coin}: " + "; ".join(errors))

    def watch_quote(self, tickers: list[str]) -> None:
        with self._lock:
            self._watch = {str(t) for t in tickers if t}

    def _apply_pending_brackets(self, positions: list[dict[str, Any]]) -> None:
        with self._lock:
            pending = dict(self._pending_brackets)
        for position in positions:
            coin = position["id"].split(":", 1)[1]
            plan = pending.get(coin)
            if plan is None:
                continue
            with self._lock:
                self._pending_brackets.pop(coin, None)
            try:
                self.set_position_brackets(position["id"], plan[0], plan[1])
            except PluginError as e:
                self._notify("warn", str(e))
