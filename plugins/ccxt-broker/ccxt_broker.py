"""The CCXT broker behind one venue of the broker plugins (OpenTrader Plugin API 2).

Every ticker is a whole OpenTrader symbol, the same one the crypto data plugin serves:
``BINANCE:BTC/USDT`` for spot and ``BINANCE:BTC/USDT.P`` for perpetuals. ccxt's own
``BTC/USDT:USDT`` never leaves this module, so a chart, a position and an order all speak
the same name.

Quantities are units of the base asset, as the protocol requires. A venue that counts
contracts (every perpetual) converts here with the market's ``contractSize``, and prices
and amounts go through ccxt's precision helpers so each venue's own step and tick rules
apply.

Nothing here holds a credential longer than a configure message: the app reads the API key
from the OS credential store. OpenTrader's trading switch and its live-order confirmation
remain the gate; this module adds no way around them.
"""

from __future__ import annotations

import json
import math
import threading
import time
from typing import Any, Callable, Iterable

from specs import Venue

FILL_HISTORY = 24 * 3600 * 1000  # executions shown, ms
MAX_ORDERS = 60
MAX_EXECUTIONS = 100
PREFERRED_QUOTES = ("USDT", "USDC", "USD", "FDUSD", "EUR", "BTC")
MARKET_TYPES = {"futures": ("swap", "future"), "spot": ("spot",)}


class BrokerError(Exception):
    """A refusal or a venue failure; the message is shown to the user."""

    def __init__(self, message: str, code: int = -32000):
        super().__init__(message)
        self.code = code


class BrokerUnavailable(BrokerError):
    """Missing or rejected credentials, or the venue is unreachable."""


class BrokerInput(BrokerError):
    """The requested symbol, size or price is invalid."""

    def __init__(self, message: str):
        super().__init__(message, -32602)


def _ccxt() -> Any:
    """Import ccxt lazily: a plugin with no key costs nothing until it is configured."""
    import ccxt  # noqa: PLC0415

    return ccxt


def _num(value: Any, default: float = 0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except (TypeError, ValueError):
        return default


def _short(value: Any, fallback: str = "") -> str:
    return fallback if value in (None, "") else str(value)


def parse_ticker(ticker: str) -> tuple[str | None, str, str | None, bool]:
    """``BINANCE:BTC/USDT.P`` → ``("BINANCE", "BTC", "USDT", True)``; ``BTC`` → ``(None, "BTC", None, False)``."""
    head = str(ticker or "").strip()
    code: str | None = None
    if ":" in head:
        prefix, _, rest = head.partition(":")
        # A venue prefix has no slash; "BTC/USDT:USDT" is ccxt's settle suffix, not a venue.
        if "/" not in prefix:
            code = prefix.strip().upper() or None
            head = rest
    head = head.strip()
    futures = head.upper().endswith(".P")
    if futures:
        head = head[:-2]
    # A ccxt symbol may carry its settle currency after a second colon (BTC/USDT:USDT).
    head = head.split(":", 1)[0].replace("-", "/").replace("_", "/")
    base, _, quote = head.partition("/")
    return code, base.strip().upper(), (quote.strip().upper() or None), futures


def app_ticker(code: str, market: dict[str, Any], futures: bool) -> str:
    """The OpenTrader symbol of a ccxt market."""
    return f"{code}:{market.get('base')}/{market.get('quote')}" + (".P" if futures else "")


def is_trigger_order(order: dict[str, Any]) -> bool:
    kind = str(order.get("type") or "").lower()
    if any(word in kind for word in ("stop", "take_profit", "trigger")):
        return True
    return trigger_price(order) is not None


def trigger_price(order: dict[str, Any]) -> float | None:
    for key in ("triggerPrice", "stopPrice", "takeProfitPrice", "stopLossPrice"):
        value = order.get(key)
        if value not in (None, ""):
            return _num(value) or None
    return None


def bracket_levels(side: str, entry: float, triggers: Iterable[float]) -> tuple[float | None, float | None]:
    """A position's take profit and stop loss from its trigger prices.

    Venues label protective orders inconsistently, so the side decides when the labels are
    missing: a long targets a price above the entry and stops below it, a short the reverse.
    """
    levels = sorted({round(price, 12) for price in triggers if price > 0})
    if not levels:
        return None, None
    if len(levels) == 1:
        level = levels[0]
        if entry <= 0:
            return level, None
        above = level > entry
        return (level, None) if (side == "buy") == above else (None, level)
    low, high = levels[0], levels[-1]
    return (high, low) if side == "buy" else (low, high)


class CcxtBroker:
    """One authenticated ccxt account, polled on a thread and commanded from the app's requests."""

    def __init__(
        self,
        venue: Venue,
        log: Callable[[str], None],
        notify: Callable[[str, str], None],
        event: Callable[[dict[str, Any]], None],
    ):
        self.venue = venue
        self._log = log
        self._notify = notify
        self._event = event
        self._lock = threading.RLock()
        self._settings: dict[str, str] = {}
        self._market = venue.default_market
        self._network = venue.default_network
        self._client: Any | None = None
        self._client_key: tuple[str, ...] | None = None
        self._markets: dict[str, dict[str, Any]] = {}
        self._raw_orders: list[dict[str, Any]] = []
        self._raw_positions: list[dict[str, Any]] = []
        self._positions: list[dict[str, Any]] = []
        self._orders: list[dict[str, Any]] = []
        self._executions: list[dict[str, Any]] = []
        self._state: dict[str, Any] = {"connected": False}
        self._fingerprint = ""
        self._watch: set[str] = set()
        self._seen_fills: set[str] = set()
        self._seen_once = False
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._last_error = ""
        self._last_error_at = 0.0
        self._warned_no_key = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    def configure(self, settings: dict[str, str]) -> None:
        """Apply the form values; a changed key, network or market rebuilds the ccxt client."""
        network = str(settings.get("network") or "").strip().lower()
        market = str(settings.get("market") or "").strip().lower()
        if network not in self.venue.networks:
            network = self.venue.default_network
        if market not in self.venue.markets:
            market = self.venue.default_market
        key = (
            str(settings.get("apiKey") or "").strip(),
            str(settings.get("apiSecret") or "").strip(),
            str(settings.get("passphrase") or "").strip(),
            network,
            market,
        )
        with self._lock:
            changed = key != self._client_key
            self._settings = dict(settings)
            self._network, self._market = network, market
            if changed:
                self._client_key = key
                self._client = None
                self._markets = {}
                self._raw_orders = []
                self._raw_positions = []
                self._positions = []
                self._orders = []
                self._executions = []
                self._fingerprint = ""
                self._seen_once = False
                self._warned_no_key = False
        if changed:
            self._connect()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name=f"{self.venue.id}-broker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def _poll_seconds(self) -> float:
        try:
            return max(1.0, min(60.0, float(self._settings.get("pollSeconds") or 3.0)))
        except (TypeError, ValueError):
            return 3.0

    def _loop(self) -> None:
        while not self._stop.wait(0.2):
            started = time.time()
            try:
                self._refresh()
            except BrokerError as exc:
                self._warn(str(exc))
            except Exception as exc:  # noqa: BLE001 - keep the poll alive
                self._warn(f"{self.venue.name}: {exc}")
            self._stop.wait(max(0.5, self._poll_seconds() - (time.time() - started)))

    def _warn(self, message: str) -> None:
        """One notice per distinct failure, repeated at most every minute."""
        now = time.time()
        if message == self._last_error and now - self._last_error_at < 60.0:
            return
        self._last_error = message
        self._last_error_at = now
        self._notify("warn", message)

    # ── client ───────────────────────────────────────────────────────────────

    def _credentials(self) -> tuple[str, str, str]:
        return (
            str(self._settings.get("apiKey") or "").strip(),
            str(self._settings.get("apiSecret") or "").strip(),
            str(self._settings.get("passphrase") or "").strip(),
        )

    def _build_client(self) -> Any:
        ccxt = _ccxt()
        api_key, secret, passphrase = self._credentials()
        options: dict[str, Any] = {
            "enableRateLimit": True,
            "timeout": 20_000,
            "options": {
                "defaultType": "spot" if self._market == "spot" else "swap",
                "adjustForTimeDifference": True,
            },
        }
        if api_key:
            options["apiKey"] = api_key
        if secret:
            options["secret"] = secret
        if self.venue.passphrase and passphrase:
            options["password"] = passphrase
        try:
            client = getattr(ccxt, self.venue.ccxt_id(self._market))(options)
            if self._network == "testnet":
                client.set_sandbox_mode(True)
            client.load_markets()
        except Exception as exc:  # noqa: BLE001 - the venue's own refusal text is what the user needs
            raise self._translate("connection", exc) from exc
        return client

    def _connect(self) -> None:
        with self._lock:
            if self._client is not None:
                return
            api_key, secret, _ = self._credentials()
            if not api_key or not secret:
                self._state = {"connected": False}
                if not self._warned_no_key:
                    self._warned_no_key = True
                    fields = "API key and secret" + (" and passphrase" if self.venue.passphrase else "")
                    self._notify("warn", f"{self.venue.name}: set the {fields} in the plugin settings")
                return
            try:
                client = self._build_client()
            except BrokerError as exc:
                self._state = {"connected": False}
                self._warn(str(exc))
                return
            self._warned_no_key = False
            self._client = client
            self._markets = {str(symbol): market for symbol, market in (client.markets or {}).items()}
            self._log(f"{self.venue.name} {self._market} {self._network}: {len(self._markets)} markets")

    def _require(self) -> Any:
        if self._client is None:
            self._connect()
        if self._client is None:
            fields = "API key and secret" + (" and passphrase" if self.venue.passphrase else "")
            raise BrokerUnavailable(f"{self.venue.name} is not connected: set the {fields} in the plugin settings")
        return self._client

    def _translate(self, action: str, exc: Exception) -> BrokerError:
        name = type(exc).__name__
        if name in ("AuthenticationError", "PermissionDenied", "AccountSuspended"):
            extra = " and passphrase" if self.venue.passphrase else ""
            return BrokerUnavailable(
                f"{self.venue.name} rejected the API credentials. Check the key, secret{extra} and that the key may trade {self._market}."
            )
        if name in ("BadSymbol", "InvalidOrder", "ArgumentsRequired"):
            return BrokerInput(str(exc))
        if name == "InsufficientFunds":
            return BrokerError(f"{self.venue.name} balance is insufficient: {exc}")
        if name == "RateLimitExceeded":
            return BrokerError(f"{self.venue.name} rate limit reached; retry shortly")
        if name in ("NetworkError", "RequestTimeout", "ExchangeNotAvailable", "DDoSProtection"):
            return BrokerUnavailable(f"{self.venue.name} is unreachable: {exc}")
        return BrokerError(f"{self.venue.name} {action} failed: {exc}")

    def _call(self, action: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            try:
                return fn(*args, **kwargs)
            except BrokerError:
                raise
            except Exception as exc:  # noqa: BLE001
                raise self._translate(action, exc) from exc

    # ── markets and symbols ──────────────────────────────────────────────────

    def _is_our_kind(self, market: dict[str, Any]) -> bool:
        return any(bool(market.get(key)) for key in MARKET_TYPES.get(self._market, ()))

    def _find_market(self, base: str, quote: str | None = None) -> dict[str, Any]:
        base = base.strip().upper()
        if not base:
            raise BrokerInput("The symbol has no base asset")
        rows = [
            market
            for market in self._markets.values()
            if self._is_our_kind(market)
            and market.get("active") is not False
            and str(market.get("base") or "").upper() == base
        ]
        if not rows:
            raise BrokerInput(f"{base} is not listed on {self.venue.name} {self._market}")
        if quote:
            exact = [market for market in rows if str(market.get("quote") or "").upper() == quote.strip().upper()]
            if exact:
                return exact[0]
        rank = {currency: index for index, currency in enumerate(PREFERRED_QUOTES)}
        rows.sort(key=lambda market: (rank.get(str(market.get("quote") or "").upper(), len(rank)), str(market.get("symbol"))))
        return rows[0]

    def _market_for(self, ticker: str) -> tuple[dict[str, Any], str]:
        _, base, quote, _ = parse_ticker(ticker)
        market = self._find_market(base, quote)
        return market, str(market.get("symbol") or "")

    def _ticker_of(self, symbol: str) -> str:
        market = self._markets.get(symbol)
        if market is None:
            _, base, quote, _ = parse_ticker(symbol)
            return app_ticker(self.venue.code, {"base": base, "quote": quote or "USD"}, self._market == "futures")
        return app_ticker(self.venue.code, market, self._market == "futures")

    def resolve_symbol(self, symbol: str, ticker: str = "") -> str | None:
        """The broker ticker of a chart symbol: its venue's own market for that asset.

        A chart on another venue (``BINANCE:BTC/USDT.P`` while this broker is Bybit) maps to
        this venue's market for the same base and quote, so the ticket trades what the chart
        shows. ``None`` when the venue does not list the asset.
        """
        self._require()
        try:
            _, base, quote, _ = parse_ticker(symbol or ticker)
            market = self._find_market(base, quote)
        except BrokerInput:
            return None
        return app_ticker(self.venue.code, market, self._market == "futures")

    # ── precision ────────────────────────────────────────────────────────────

    def _contract_size(self, market: dict[str, Any]) -> float:
        if market.get("spot"):
            return 1.0
        size = _num(market.get("contractSize"), 1.0)
        return size if size > 0 else 1.0

    def _amount(self, client: Any, market: dict[str, Any], qty: float, price: float | None) -> float:
        """Units of the base asset → the amount the venue orders, rounded to its step."""
        if not math.isfinite(qty) or qty <= 0:
            raise BrokerInput("The quantity must be positive")
        contract = self._contract_size(market)
        symbol = str(market.get("symbol") or "")
        raw = qty if market.get("spot") else qty / contract
        try:
            amount = float(client.amount_to_precision(symbol, raw))
        except Exception as exc:  # noqa: BLE001
            raise self._translate("quantity", exc) from exc
        if amount <= 0:
            raise BrokerInput(f"{qty:g} is below {self.venue.name}'s smallest order size")
        limits = market.get("limits") or {}
        minimum = _num((limits.get("amount") or {}).get("min"))
        if minimum > 0 and amount < minimum:
            units = minimum * contract
            raise BrokerInput(f"The order is below {self.venue.name}'s minimum of {units:.8g} {market.get('base')}")
        min_cost = _num((limits.get("cost") or {}).get("min"))
        if min_cost > 0 and price:
            notional = amount * contract * price
            if notional < min_cost:
                raise BrokerInput(
                    f"The order value {notional:.8g} is below {self.venue.name}'s minimum of {min_cost:g} {market.get('quote')}"
                )
        return amount

    def _price(self, client: Any, market: dict[str, Any], price: Any) -> float:
        value = _num(price)
        if not math.isfinite(value) or value <= 0:
            raise BrokerInput("The price must be positive")
        try:
            return float(client.price_to_precision(str(market.get("symbol") or ""), value))
        except Exception as exc:  # noqa: BLE001
            raise self._translate("price", exc) from exc

    def _units(self, market: dict[str, Any], amount: float) -> float:
        """The venue's order amount → base-asset units (the protocol's quantity)."""
        return amount if market.get("spot") else amount * self._contract_size(market)

    # ── state ────────────────────────────────────────────────────────────────

    def state(self) -> dict[str, Any]:
        with self._lock:
            return self._state

    def _publish(self, payload: dict[str, Any]) -> None:
        fingerprint = json.dumps(payload, sort_keys=True, default=str)
        with self._lock:
            if fingerprint == self._fingerprint:
                return
            self._fingerprint = fingerprint
            self._state = payload
        self._event({"__state__": payload})

    def _refresh(self) -> None:
        with self._lock:
            client = self._client
            if client is None:
                self._publish({"connected": False})
                return
            balance = self._call("balance", client.fetch_balance)
            positions_raw = self._fetch_positions(client) if self._market != "spot" else []
            orders_raw = self._fetch_open_orders(client)
            trades = self._fetch_trades(client)
            self._raw_positions = positions_raw
            self._raw_orders = orders_raw
            account, currency = self._account(balance, positions_raw, trades)
            positions = self._position_rows(orders_raw)
            orders = self._order_rows(orders_raw, trades)
            executions = self._execution_rows(trades)
            self._positions = positions
            self._orders = orders
            self._executions = executions
            payload = {
                "connected": True,
                "accounts": [{"id": account["id"], "name": account["name"]}],
                "account": account,
                "positionMode": "netting",
                "capabilities": self._capabilities(),
                "positions": positions,
                "orders": orders,
                "executions": executions,
            }
            self._publish(payload)
            self._emit_new_fills(executions)
            self._emit_quotes(client)

    def _capabilities(self) -> dict[str, Any]:
        if self._market == "spot":
            return {
                "orderTypes": ["market", "limit"],
                "brackets": False,
                "positionBrackets": False,
                "partialClose": False,
                "modifyOrders": True,
            }
        return {
            "orderTypes": ["market", "limit", "stop", "stopLimit"],
            "brackets": True,
            "positionBrackets": True,
            "partialClose": True,
            "modifyOrders": True,
        }

    def _account(
        self,
        balance: dict[str, Any],
        positions_raw: list[dict[str, Any]],
        trades: list[dict[str, Any]],
    ) -> tuple[dict[str, Any], str]:
        totals = balance.get("total") if isinstance(balance, dict) else {}
        free = balance.get("free") if isinstance(balance, dict) else {}
        used = balance.get("used") if isinstance(balance, dict) else {}
        totals = totals if isinstance(totals, dict) else {}
        free = free if isinstance(free, dict) else {}
        used = used if isinstance(used, dict) else {}
        currency = next((code for code in ("USDT", "USDC", "USD") if _num(totals.get(code)) > 0), "")
        if not currency:
            held = [(str(code), _num(value)) for code, value in totals.items() if _num(value) > 0 and code != "info"]
            currency = max(held, key=lambda item: item[1])[0] if held else "USD"
        total = _num(totals.get(currency))
        unrealized = 0.0 if self._market == "spot" else sum(
            _num(row.get("unrealizedPnl")) for row in positions_raw if isinstance(row, dict)
        )
        realized = sum(
            _num((row.get("info") or {}).get("realizedPnl") if isinstance(row.get("info"), dict) else None)
            for row in trades
            if isinstance(row, dict)
        )
        account_id = f"{self.venue.code}:{self._market}:{self._network}"
        network = "Testnet" if self._network == "testnet" else "Live"
        levels = [
            {"label": "Market", "value": "Perpetual futures" if self._market == "futures" else "Spot"},
            {"label": "Network", "value": network},
            {"label": "Free", "value": f"{_num(free.get(currency)):,.2f} {currency}"},
        ]
        if self._market == "spot":
            held = sorted(
                ((str(code), _num(value)) for code, value in totals.items() if _num(value) > 0 and code != "info"),
                key=lambda item: item[1],
                reverse=True,
            )[:4]
            if held:
                levels.append({
                    "label": "Balances",
                    "value": ", ".join(f"{amount:.6g} {code}" for code, amount in held),
                })
        account = {
            "id": account_id,
            "name": f"{self.venue.name} · {network}",
            "currency": currency,
            "isDemo": self._network == "testnet",
            "balance": total,
            "equity": total + unrealized,
            "unrealizedPnl": unrealized,
            "realizedPnl": realized,
            "marginUsed": _num(used.get(currency)),
            "marginFree": _num(free.get(currency)),
            "values": levels,
        }
        return account, currency

    def _fetch_positions(self, client: Any) -> list[dict[str, Any]]:
        try:
            rows = self._call("positions", client.fetch_positions)
        except BrokerError as exc:
            self._log(f"[broker] positions: {exc}")
            return []
        return [row for row in (rows or []) if isinstance(row, dict)]

    def _fetch_open_orders(self, client: Any) -> list[dict[str, Any]]:
        try:
            rows = self._call("open orders", client.fetch_open_orders)
            return [row for row in (rows or []) if isinstance(row, dict)]
        except BrokerError as exc:
            # Some venues only answer per symbol: ask for the symbols the account trades.
            symbols = {str(row.get("symbol")) for row in self._raw_positions if row.get("symbol")}
            symbols.update(symbol for symbol in (self._symbol_of(ticker) for ticker in self._watch) if symbol)
            symbols.discard("")
            if not symbols:
                self._log(f"[broker] open orders: {exc}")
                return []
            rows: list[dict[str, Any]] = []
            for symbol in symbols:
                try:
                    rows.extend(self._call("open orders", client.fetch_open_orders, symbol) or [])
                except BrokerError:
                    continue
            return [row for row in rows if isinstance(row, dict)]

    def _symbol_of(self, ticker: str) -> str:
        try:
            market, symbol = self._market_for(ticker)
            return symbol
        except BrokerError:
            return ""

    def _fetch_trades(self, client: Any) -> list[dict[str, Any]]:
        since = int(time.time() * 1000) - FILL_HISTORY
        rows: list[dict[str, Any]] = []
        try:
            rows = self._call("executions", client.fetch_my_trades, None, since, MAX_EXECUTIONS) or []
        except BrokerError as exc:
            symbols = {str(row.get("symbol")) for row in self._raw_positions if row.get("symbol")}
            for symbol in symbols:
                try:
                    rows.extend(self._call("executions", client.fetch_my_trades, symbol, since, 50) or [])
                except BrokerError:
                    continue
            if not rows:
                self._log(f"[broker] executions: {exc}")
                return []
        clean = [row for row in rows if isinstance(row, dict) and _num(row.get("timestamp")) >= since]
        clean.sort(key=lambda row: _num(row.get("timestamp")))
        return clean[-MAX_EXECUTIONS:]

    def _position_rows(self, orders: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for row in self._raw_positions:
            contracts = _num(row.get("contracts"))
            if contracts == 0:
                continue
            symbol = str(row.get("symbol") or "")
            market = self._markets.get(symbol)
            if market is None or not self._is_our_kind(market):
                continue
            ticker = app_ticker(self.venue.code, market, True)
            units = abs(contracts) * self._contract_size(market)
            side = "sell" if (str(row.get("side") or "").lower() == "short" or (not row.get("side") and contracts < 0)) else "buy"
            entry = _num(row.get("entryPrice"))
            triggers = [
                price
                for order in orders
                if str(order.get("symbol") or "") == symbol and is_trigger_order(order)
                for price in (trigger_price(order),)
                if price
            ]
            take_profit, stop_loss = bracket_levels(side, entry, triggers)
            out.append({
                "id": f"pos:{ticker}",
                "ticker": ticker,
                "side": side,
                "qty": units,
                "avgPrice": entry,
                "last": _num(row.get("markPrice")) or None,
                "unrealizedPnl": _num(row.get("unrealizedPnl")),
                "takeProfit": take_profit,
                "stopLoss": stop_loss,
            })
        return out

    def _order_rows(self, rows: list[dict[str, Any]], trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for order in rows:
            symbol = str(order.get("symbol") or "")
            market = self._markets.get(symbol)
            if market is None or not self._is_our_kind(market):
                continue
            amount = _num(order.get("amount"))
            filled = _num(order.get("filled"))
            contract = self._contract_size(market)
            trigger = trigger_price(order)
            limit = _num(order.get("price")) or None
            if trigger is not None:
                kind = "stopLimit" if limit else "stop"
            else:
                kind = "market" if str(order.get("type") or "").lower() == "market" else "limit"
            status = "working"
            if str(order.get("status") or "").lower() in ("canceled", "cancelled", "closed", "expired", "rejected"):
                status = str(order.get("status") or "").lower().replace("canceled", "cancelled")
                if status == "closed":
                    status = "filled"
                if status not in ("filled", "cancelled", "rejected", "inactive"):
                    status = "working"
            out.append({
                "id": str(order.get("id") or ""),
                "ticker": app_ticker(self.venue.code, market, self._market == "futures"),
                "side": "buy" if str(order.get("side") or "").lower() == "buy" else "sell",
                "type": kind,
                "qty": amount * contract,
                "filledQty": filled * contract,
                "limitPrice": limit,
                "stopPrice": trigger,
                "takeProfit": None,
                "stopLoss": None,
                "status": status,
                "duration": _short(order.get("timeInForce")) or None,
                "updatedMs": _num(order.get("lastTradeTimestamp") or order.get("timestamp")),
            })
        open_ids = {row["id"] for row in out}
        # Fills become filled orders, so the account manager shows what just happened.
        filled: dict[str, dict[str, Any]] = {}
        for trade in trades:
            symbol = str(trade.get("symbol") or "")
            market = self._markets.get(symbol)
            if market is None or not self._is_our_kind(market):
                continue
            order_id = str(trade.get("order") or "")
            if not order_id or order_id in open_ids:
                continue
            contract = self._contract_size(market)
            quantity = _num(trade.get("amount")) * contract
            price = _num(trade.get("price"))
            row = filled.setdefault(order_id, {
                "id": order_id,
                "ticker": app_ticker(self.venue.code, market, self._market == "futures"),
                "side": "buy" if str(trade.get("side") or "").lower() == "buy" else "sell",
                "type": "market",
                "qty": 0.0,
                "filledQty": 0.0,
                "avgFillPrice": 0.0,
                "takeProfit": None,
                "stopLoss": None,
                "status": "filled",
                "updatedMs": 0.0,
            })
            before = row["filledQty"]
            total = before + quantity
            row["qty"] = total
            row["filledQty"] = total
            row["avgFillPrice"] = (row["avgFillPrice"] * before + price * quantity) / total if total else price
            row["updatedMs"] = max(row["updatedMs"], _num(trade.get("timestamp")))
        out.extend(filled.values())
        out.sort(key=lambda row: -_num(row.get("updatedMs")))
        return out[:MAX_ORDERS]

    def _execution_rows(self, trades: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for trade in trades:
            symbol = str(trade.get("symbol") or "")
            market = self._markets.get(symbol)
            if market is None or not self._is_our_kind(market):
                continue
            contract = self._contract_size(market)
            fee = trade.get("fee") if isinstance(trade.get("fee"), dict) else {}
            info = trade.get("info") if isinstance(trade.get("info"), dict) else {}
            out.append({
                "id": str(trade.get("id") or f"{trade.get('order')}:{trade.get('timestamp')}"),
                "orderId": str(trade.get("order")) if trade.get("order") not in (None, "") else None,
                "ticker": app_ticker(self.venue.code, market, self._market == "futures"),
                "side": "buy" if str(trade.get("side") or "").lower() == "buy" else "sell",
                "qty": _num(trade.get("amount")) * contract,
                "price": _num(trade.get("price")),
                "timeMs": _num(trade.get("timestamp")),
                "commission": abs(_num(fee.get("cost"))),
                "realizedPnl": _num(info.get("realizedPnl")),
            })
        return out[-MAX_EXECUTIONS:]

    def _emit_new_fills(self, executions: list[dict[str, Any]]) -> None:
        ids = {row["id"] for row in executions}
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

    def _emit_quotes(self, client: Any) -> None:
        for ticker in list(self._watch):
            symbol = self._symbol_of(ticker)
            if not symbol:
                continue
            try:
                row = self._call("quote", client.fetch_ticker, symbol)
            except BrokerError:
                continue
            last = _num(row.get("last")) or _num(row.get("close")) or None
            self._event({"__quote__": {
                "ticker": ticker,
                "bid": _num(row.get("bid")) or None,
                "ask": _num(row.get("ask")) or None,
                "last": last,
            }})

    # ── commands ─────────────────────────────────────────────────────────────

    def watch_quote(self, tickers: list[str]) -> None:
        with self._lock:
            self._watch = {str(ticker) for ticker in tickers if ticker}

    def _after_command(self) -> None:
        try:
            self._refresh()
        except BrokerError as exc:
            self._warn(str(exc))

    def _find_open(self, order_id: str) -> dict[str, Any] | None:
        return next((row for row in self._raw_orders if str(row.get("id")) == str(order_id)), None)

    def _find_position(self, position_id: str) -> dict[str, Any] | None:
        return next((row for row in self._positions if row["id"] == position_id), None)

    def place(self, ticket: dict[str, Any]) -> str:
        client = self._require()
        ticker = str(ticket.get("ticker") or "")
        market, symbol = self._market_for(ticker)
        side = "buy" if str(ticket.get("side") or "buy").strip().lower() == "buy" else "sell"
        kind = str(ticket.get("type") or "market").strip()
        price = self._price(client, market, ticket.get("limitPrice")) if kind in ("limit", "stopLimit") else None
        trigger = self._price(client, market, ticket.get("stopPrice")) if kind in ("stop", "stopLimit") else None
        amount = self._amount(client, market, _num(ticket.get("qty")), price)
        params: dict[str, Any] = {}
        if kind in ("limit", "stopLimit"):
            params["timeInForce"] = "GTC"
        if trigger is not None:
            params["triggerPrice"] = trigger
        order_type = "limit" if kind in ("limit", "stopLimit") else "market"
        response = self._call(f"{kind} order", client.create_order, symbol, order_type, side, amount, price, params)
        order_id = _short((response or {}).get("id"))
        if not order_id:
            raise BrokerError(f"{self.venue.name} accepted the order without an id")
        if self._market != "spot":
            self._place_brackets(client, market, side, amount, ticket.get("takeProfit"), ticket.get("stopLoss"))
        self._event({
            "kind": "placed",
            "ticker": self._ticker_of(symbol),
            "side": side,
            "type": kind,
            "qty": self._units(market, amount),
            "price": price,
        })
        self._after_command()
        return order_id

    def _place_brackets(
        self,
        client: Any,
        market: dict[str, Any],
        entry_side: str,
        amount: float,
        take_profit: Any,
        stop_loss: Any,
    ) -> None:
        """Protective reduce-only orders for a new perpetual position."""
        close_side = "sell" if entry_side == "buy" else "buy"
        for key, value, label in (
            ("takeProfitPrice", take_profit, "take profit"),
            ("stopLossPrice", stop_loss, "stop loss"),
        ):
            if value in (None, ""):
                continue
            try:
                level = self._price(client, market, value)
                self._call(
                    f"{label} order",
                    client.create_order,
                    str(market.get("symbol") or ""),
                    "market",
                    close_side,
                    amount,
                    None,
                    {key: level, "reduceOnly": True},
                )
            except BrokerError as exc:
                self._notify(
                    "warn",
                    f"{self.venue.name}: the entry was placed, but its {label} failed ({exc}). "
                    "Do not resubmit the entry; set the brackets on the position instead.",
                )

    def modify(self, order_id: str, ticket: dict[str, Any]) -> None:
        client = self._require()
        ticker = str(ticket.get("ticker") or "")
        market, symbol = self._market_for(ticker)
        existing = self._find_open(order_id) or {}
        side = str(ticket.get("side") or existing.get("side") or "buy").strip().lower()
        kind = str(ticket.get("type") or "").strip() or ("limit" if existing.get("price") else "market")
        price = self._price(client, market, ticket.get("limitPrice")) if kind in ("limit", "stopLimit") else None
        trigger = self._price(client, market, ticket.get("stopPrice")) if kind in ("stop", "stopLimit") else None
        amount = self._amount(client, market, _num(ticket.get("qty")), price)
        edited = False
        if kind == "limit" and (getattr(client, "has", {}) or {}).get("editOrder"):
            try:
                self._call("modify", client.edit_order, order_id, symbol, "limit", side, amount, price, {})
                edited = True
            except BrokerInput:
                edited = False  # a venue that advertises editing but refuses this order: replace it
        if not edited:
            params: dict[str, Any] = {}
            if kind in ("limit", "stopLimit"):
                params["timeInForce"] = "GTC"
            if trigger is not None:
                params["triggerPrice"] = trigger
            self._call("cancel", client.cancel_order, order_id, symbol)
            self._call("replace", client.create_order, symbol, "limit" if kind in ("limit", "stopLimit") else "market", side, amount, price, params)
        self._event({
            "kind": "modified",
            "ticker": self._ticker_of(symbol),
            "side": side,
            "type": kind,
            "qty": self._units(market, amount),
            "price": price,
        })
        self._after_command()

    def cancel(self, order_id: str) -> None:
        client = self._require()
        existing = self._find_open(order_id) or {}
        symbol = _short(existing.get("symbol"))
        try:
            self._call("cancel", client.cancel_order, order_id, symbol or None)
        except BrokerError:
            if not symbol:
                raise
            self._call("cancel", client.cancel_order, order_id)
        row = next((order for order in self._orders if order["id"] == str(order_id)), None)
        if row is not None:
            self._event({
                "kind": "cancelled",
                "ticker": row["ticker"],
                "side": row["side"],
                "type": row["type"],
                "qty": row["qty"],
                "price": row.get("limitPrice"),
            })
        self._after_command()

    def close_position(self, position_id: str, qty: float | None = None) -> None:
        client = self._require()
        position = self._find_position(position_id)
        if position is None:
            raise BrokerError(f"{position_id} is not an open position")
        market, symbol = self._market_for(position["ticker"])
        side = "sell" if position["side"] == "buy" else "buy"
        units = position["qty"] if qty is None else min(_num(qty), position["qty"])
        amount = self._amount(client, market, units, None)
        params = {} if market.get("spot") else {"reduceOnly": True}
        self._call("close", client.create_order, symbol, "market", side, amount, None, params)
        self._notify("info", f"{position['ticker']}: close submitted")
        self._after_command()

    def set_position_brackets(self, position_id: str, take_profit: float | None, stop_loss: float | None) -> None:
        client = self._require()
        if self._market == "spot":
            raise BrokerInput("Spot exits are sell orders; a spot account has no position brackets")
        position = self._find_position(position_id)
        if position is None:
            raise BrokerError(f"{position_id} is not an open position")
        market, symbol = self._market_for(position["ticker"])
        close_side = "sell" if position["side"] == "buy" else "buy"
        amount = self._amount(client, market, position["qty"], None)
        # Replace the position's triggers: an old level must not survive a new plan.
        for order in list(self._raw_orders):
            if str(order.get("symbol") or "") != symbol or not is_trigger_order(order):
                continue
            try:
                self._call("cancel", client.cancel_order, str(order.get("id")), symbol)
            except BrokerError as exc:
                self._log(f"[broker] cancel trigger {order.get('id')}: {exc}")
        errors: list[str] = []
        for key, value, label in (
            ("takeProfitPrice", take_profit, "take profit"),
            ("stopLossPrice", stop_loss, "stop loss"),
        ):
            if value is None:
                continue
            try:
                level = self._price(client, market, value)
                self._call(
                    f"{label} order",
                    client.create_order,
                    symbol,
                    "market",
                    close_side,
                    amount,
                    None,
                    {key: level, "reduceOnly": True},
                )
            except BrokerError as exc:
                errors.append(f"{label}: {exc}")
        if errors:
            raise BrokerError("; ".join(errors))
        self._after_command()
