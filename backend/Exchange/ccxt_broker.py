"""ccxt-backed broker for the non-Hyperliquid exchanges.

Hyperliquid keeps its native SDK client (``backend.Exchange.hyperliquid``) for
the perp path because it already encodes the venue's trigger-order semantics.
Every other connection in ``shared/exchanges.json`` goes through this module,
which normalises symbol resolution, tick/quantity rounding, balances, positions
and bracket orders onto ccxt's unified API.

Live secrets never leave the process: they are read from the environment that
the Tauri shell populated from the OS keyring.
"""

from __future__ import annotations

import importlib
import logging
import os
import threading
from dataclasses import dataclass
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP
from typing import Any

from backend.Core.models import OrderParams, OrderResult, PositionData, UpdateTpSlResult
from backend.Exchange import specs

log = logging.getLogger(__name__)

_PREFERRED_QUOTES = ("USDT", "USDC", "USD", "FDUSD", "EUR", "BTC")
_PRICE_TOLERANCE = 1e-9
_RECENT_SECONDS = 30.0


class BrokerError(RuntimeError):
    """Exchange/transport failure that is safe to show to the user."""


class BrokerUnavailable(BrokerError):
    """Missing or rejected credentials, or an unsupported venue/network."""


class BrokerInputError(BrokerError):
    """The requested instrument, size or price is invalid."""


@dataclass(frozen=True)
class InstrumentInfo:
    symbol: str
    native: str
    base: str
    quote: str
    spot: bool
    contract_size: Decimal
    amount_step: Decimal
    price_step: Decimal
    sz_decimals: int
    price_decimals: int
    min_contracts: Decimal | None
    min_cost: Decimal | None


def _ccxt():
    """Import ccxt lazily so sidecar start-up does not pay for all venues."""
    return importlib.import_module("ccxt")


def _decimal(value: Any, default: str = "0") -> Decimal:
    try:
        return Decimal(str(value))
    except Exception:  # noqa: BLE001 - exchange payloads are untrusted
        return Decimal(default)


def _decimals(step: Decimal) -> int:
    if step <= 0:
        return 8
    exponent = step.normalize().as_tuple().exponent
    return max(0, -int(exponent))


def _quantize(value: Decimal, step: Decimal, rounding: str = ROUND_HALF_UP) -> Decimal:
    if step <= 0:
        return value
    units = (value / step).to_integral_value(rounding=rounding)
    return units * step


def _same(a: float, b: float) -> bool:
    return abs(float(a) - float(b)) <= _PRICE_TOLERANCE * max(1.0, abs(float(b)))


class CcxtBroker:
    """One authenticated ccxt client for an (exchange, market, network) tuple."""

    def __init__(self, exchange_id: str, market: str, network: str | None = None) -> None:
        self.spec = specs.exchange(exchange_id)
        self.market = str(market or "").strip().lower()
        if self.market not in self.spec.markets:
            raise BrokerInputError(
                f"{self.spec.name} does not support {self.market or 'this market'} trading"
            )
        self.network = network or specs.network(self.spec.id)
        if self.network not in self.spec.networks:
            raise BrokerUnavailable(
                f"{self.spec.name} does not offer the {self.network} network"
            )
        self._client: Any | None = None
        self._public: Any | None = None
        self._lock = threading.RLock()

    # ── client / markets ──────────────────────────────────────────────────

    @property
    def label(self) -> str:
        return f"{self.spec.name} {specs.MARKET_LABELS.get(self.market, self.market)}"

    def _values(self) -> dict[str, str]:
        return specs.credential_values(self.spec.id)

    def _client_ready(self) -> Any:
        with self._lock:
            if self._client is not None:
                return self._client
            values = self._values()
            missing = [specs.FIELD_BY_KEY[key].label for key in self._required_keys() if not values.get(key)]
            if missing:
                raise BrokerUnavailable(
                    f"{self.spec.name} credentials are not configured ({', '.join(missing)}). "
                    "Add them in Settings → Exchange."
                )
            self._client = self._build_client(values)
            return self._client

    def _required_keys(self) -> list[str]:
        return [field.key for field in self.spec.required_fields()]

    def _build_client(self, values: dict[str, str]) -> Any:
        ccxt = _ccxt()
        ccxt_id = self.spec.markets[self.market]
        settings: dict[str, Any] = {
            "enableRateLimit": True,
            "timeout": 20_000,
            "options": {
                "defaultType": "spot" if self.market == "spot" else "swap",
                "adjustForTimeDifference": True,
            },
        }
        if self.spec.wallet:
            settings["walletAddress"] = values.get("HL_ADDRESS", "")
            settings["privateKey"] = values.get("HL_PRIVATE_KEY", "")
        else:
            settings["apiKey"] = values.get(f"{self.spec.prefix}_API_KEY", "")
            settings["secret"] = values.get(f"{self.spec.prefix}_API_SECRET", "")
            if self.spec.passphrase:
                settings["password"] = values.get(f"{self.spec.prefix}_PASSPHRASE", "")
        try:
            client = getattr(ccxt, ccxt_id)(settings)
            if self.network == "testnet":
                client.set_sandbox_mode(True)
                # Bitget routes demo trading through a header instead of the
                # base-class flag; both count as a successful switch.
                if not getattr(client, "isSandboxModeEnabled", False) and not (
                    client.options or {}
                ).get("sandboxMode"):
                    raise BrokerUnavailable(
                        f"{self.spec.name} testnet is not available in this build"
                    )
        except Exception as exc:  # noqa: BLE001
            raise BrokerUnavailable(
                f"Cannot create the {self.spec.name} client: {exc}"
            ) from exc
        return client

    def _public_client(self) -> Any:
        """A keyless client for market metadata and symbol catalogs."""
        with self._lock:
            if self._public is None:
                ccxt = _ccxt()
                self._public = getattr(ccxt, self.spec.markets[self.market])(
                    {
                        "enableRateLimit": True,
                        "timeout": 20_000,
                        "options": {
                            "defaultType": "spot" if self.market == "spot" else "swap",
                        },
                    }
                )
                if self.network == "testnet":
                    try:
                        self._public.set_sandbox_mode(True)
                    except Exception as exc:  # noqa: BLE001 - metadata is still usable
                        log.debug("%s testnet metadata unavailable: %s", self.label, exc)
            return self._public

    def _markets(self) -> dict[str, dict]:
        client = self._client or self._public_client()
        try:
            if not getattr(client, "markets", None):
                client.load_markets()
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc, "market metadata") from exc
        return client.markets or {}

    def _market_type(self, market: dict) -> bool:
        return bool(market.get("spot")) if self.market == "spot" else bool(
            market.get("swap") or market.get("future")
        )

    def market_for(self, coin: str) -> dict:
        raw = str(coin or "").strip().upper().replace("-", "/").replace("_", "/")
        if not raw:
            raise BrokerInputError("Coin is required")
        markets = self._markets()
        if "/" in raw:
            base, quote = raw.split("/", 1)
            quote = quote.split(":", 1)[0]
            candidates = [
                market
                for market in markets.values()
                if self._market_type(market)
                and str(market.get("base") or "").upper() == base
                and str(market.get("quote") or "").upper() == quote
            ]
        else:
            base = raw
            candidates = [
                market
                for market in markets.values()
                if self._market_type(market)
                and str(market.get("base") or "").upper() == base
            ]
        if not candidates:
            raise BrokerInputError(
                f"{base} is not listed on {self.label}"
            )
        preference = {quote: index for index, quote in enumerate(_PREFERRED_QUOTES)}
        candidates.sort(
            key=lambda market: (
                preference.get(str(market.get("quote") or "").upper(), 99),
                market.get("symbol", ""),
            )
        )
        return candidates[0]

    def instruments(self) -> list[str]:
        bases: set[str] = set()
        for market in self._markets().values():
            if not self._market_type(market) or market.get("active") is False:
                continue
            base = str(market.get("base") or "").upper()
            if base:
                bases.add(base)
        return sorted(bases)

    def instrument(self, coin: str) -> InstrumentInfo:
        market = self.market_for(coin)
        contract = bool(market.get("contract"))
        amount_step = _decimal((market.get("precision") or {}).get("amount"), "0.00000001")
        if amount_step <= 0:
            amount_step = Decimal("0.00000001")
        price_step = _decimal((market.get("precision") or {}).get("price"), "0.00000001")
        if price_step <= 0:
            price_step = Decimal("0.00000001")
        contract_size = _decimal(market.get("contractSize"), "1") if contract else Decimal("1")
        if contract_size <= 0:
            contract_size = Decimal("1")
        base_step = amount_step * contract_size
        limits = market.get("limits") or {}
        amount_limits = limits.get("amount") or {}
        cost_limits = limits.get("cost") or {}
        min_contracts = _decimal(amount_limits.get("min"), "0") or None
        min_cost = _decimal(cost_limits.get("min"), "0") or None
        if min_contracts is not None and min_contracts <= 0:
            min_contracts = None
        if min_cost is not None and min_cost <= 0:
            min_cost = None
        return InstrumentInfo(
            symbol=str(market["symbol"]),
            native=str(market.get("id") or ""),
            base=str(market.get("base") or "").upper(),
            quote=str(market.get("quote") or "").upper(),
            spot=bool(market.get("spot")),
            contract_size=contract_size,
            amount_step=amount_step,
            price_step=price_step,
            sz_decimals=_decimals(base_step),
            price_decimals=_decimals(price_step),
            min_contracts=min_contracts,
            min_cost=min_cost,
        )

    def round_price(self, coin: str, price: float) -> float:
        info = self.instrument(coin)
        return float(_quantize(_decimal(price), info.price_step))

    def round_quantity(self, coin: str, qty: float, limit_price: float | None = None) -> tuple[float, float]:
        """Return ``(contracts, base_quantity)`` rounded to the venue step."""
        info = self.instrument(coin)
        base_qty = _decimal(qty)
        contracts = _quantize(base_qty / info.contract_size, info.amount_step, ROUND_DOWN)
        if contracts <= 0:
            raise BrokerInputError(
                f"QTY {qty} is below {info.base}'s minimum step on {self.label}"
            )
        if info.min_contracts is not None and contracts < info.min_contracts:
            minimum = info.min_contracts * info.contract_size
            raise BrokerInputError(
                f"QTY is below the {self.label} minimum of {minimum.normalize()} {info.base}"
            )
        rounded_base = contracts * info.contract_size
        if info.min_cost is not None and limit_price:
            notional = rounded_base * _decimal(limit_price)
            if notional < info.min_cost:
                raise BrokerInputError(
                    f"Order value {notional:.8g} is below the {self.label} minimum of "
                    f"{info.min_cost.normalize()} {info.quote}"
                )
        return float(contracts), float(rounded_base)

    # ── error translation ─────────────────────────────────────────────────

    def _translate(self, exc: Exception, action: str) -> BrokerError:
        ccxt = _ccxt()
        if isinstance(exc, (ccxt.AuthenticationError, ccxt.PermissionDenied)):
            extra = " and passphrase" if self.spec.passphrase else ""
            return BrokerUnavailable(
                f"{self.spec.name} rejected the API credentials. Check the key, secret{extra} "
                f"and that the key has {self.market} trading permission."
            )
        if isinstance(exc, ccxt.BadSymbol):
            return BrokerInputError(f"{exc}")
        if isinstance(exc, ccxt.InsufficientFunds):
            return BrokerError(f"{self.spec.name} balance is insufficient: {exc}")
        if isinstance(exc, ccxt.RateLimitExceeded):
            return BrokerError(f"{self.spec.name} rate limit reached; retry shortly")
        return BrokerError(f"{self.spec.name} {action} failed: {exc}")

    def _call(self, action: str, fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except BrokerError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc, action) from exc

    # ── orders / positions ────────────────────────────────────────────────

    def _fetch_open_orders(self, symbol: str) -> list[dict]:
        client = self._client_ready()
        orders: list[dict] = []
        seen: set[str] = set()
        for params in ({}, {"trigger": True}):
            try:
                batch = client.fetch_open_orders(symbol, None, None, params)
            except Exception as exc:  # noqa: BLE001 - the trigger variant is optional
                if not params:
                    raise self._translate(exc, "open orders") from exc
                continue
            for order in batch or []:
                oid = str(order.get("id") or "")
                if oid and oid in seen:
                    continue
                if oid:
                    seen.add(oid)
                orders.append(order)
        return orders

    def _order_trigger(self, order: dict) -> float | None:
        for key in ("stopLossPrice", "takeProfitPrice", "triggerPrice"):
            value = order.get(key)
            if value not in (None, ""):
                return float(value)
        return None

    def _is_trigger(self, order: dict) -> bool:
        order_type = str(order.get("type") or "").lower()
        if any(token in order_type for token in ("stop", "take_profit", "trigger")):
            return True
        return self._order_trigger(order) is not None

    def _cancel_open_orders(self, symbol: str, triggers_only: bool = False) -> list[str]:
        client = self._client_ready()
        errors: list[str] = []
        for order in self._fetch_open_orders(symbol):
            if triggers_only and not self._is_trigger(order):
                continue
            oid = order.get("id")
            if oid is None:
                continue
            params = {"trigger": True} if self._is_trigger(order) else {}
            try:
                client.cancel_order(str(oid), symbol, params)
            except Exception as exc:  # noqa: BLE001 - report and continue
                errors.append(str(exc))
                log.warning("Could not cancel %s order %s: %s", self.label, oid, exc)
        return errors

    def _close_side(self, is_buy: bool) -> str:
        return "sell" if is_buy else "buy"

    def _place_trigger(
        self,
        symbol: str,
        side: str,
        contracts: float,
        price: float,
        key: str,
        spot: bool,
    ) -> dict:
        client = self._client_ready()
        params: dict[str, Any] = {key: price}
        if not spot:
            params["reduceOnly"] = True
        return client.create_order(symbol, "market", side, contracts, None, params)

    def _has_matching_bracket(
        self,
        symbol: str,
        entry_side: str,
        contracts: float,
        limit: float,
        tp: float,
        sl: float,
    ) -> bool:
        try:
            orders = self._fetch_open_orders(symbol)
        except BrokerError:
            return False
        entry_ok = tp_ok = sl_ok = False
        for order in orders:
            trigger = self._is_trigger(order)
            amount = float(order.get("amount") or 0)
            if not trigger:
                price = order.get("price")
                if (
                    str(order.get("side") or "") == entry_side
                    and price is not None
                    and _same(amount, contracts)
                    and _same(float(price), limit)
                ):
                    entry_ok = True
                continue
            trigger_price = self._order_trigger(order)
            if trigger_price is None:
                continue
            if _same(trigger_price, tp):
                tp_ok = True
            if _same(trigger_price, sl):
                sl_ok = True
        return entry_ok and tp_ok and sl_ok

    def place_order(self, params: OrderParams) -> OrderResult:
        try:
            info = self.instrument(params.coin)
            if info.spot and not params.is_buy:
                raise BrokerInputError(
                    "Spot markets support buy entries only; open a perpetual chart to short."
                )
            limit = self.round_price(params.coin, params.limit_price)
            tp = self.round_price(params.coin, params.tp_price)
            sl = self.round_price(params.coin, params.sl_price)
            contracts, _base = self.round_quantity(params.coin, params.qty, limit)
            symbol = info.symbol
            side = "buy" if params.is_buy else "sell"
            if self._has_matching_bracket(symbol, side, contracts, limit, tp, sl):
                log.info("Identical %s bracket already open; skipping", self.label)
                return OrderResult(success=True)
            self._cancel_open_orders(symbol)

            client = self._client_ready()
            limit_response = self._call(
                "limit order",
                client.create_order,
                symbol,
                "limit",
                side,
                contracts,
                limit,
                {"timeInForce": "GTC"},
            )
            log.info("Placed %s limit entry for %s", self.label, params.coin)

            close_side = self._close_side(params.is_buy)
            errors: list[str] = []
            sl_response = tp_response = None
            try:
                sl_response = self._place_trigger(
                    symbol, close_side, contracts, sl, "stopLossPrice", info.spot
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"stop-loss: {self._describe(exc)}")
            try:
                tp_response = self._place_trigger(
                    symbol, close_side, contracts, tp, "takeProfitPrice", info.spot
                )
            except Exception as exc:  # noqa: BLE001
                errors.append(f"take-profit: {self._describe(exc)}")

            if errors:
                log.error("Entry placed but protective orders failed on %s: %s", self.label, errors)
                return OrderResult(
                    success=True,
                    limit_response=limit_response,
                    sl_response=sl_response,
                    tp_response=tp_response,
                    error=(
                        "Entry was placed, but the protective order failed ("
                        + "; ".join(errors)
                        + "). Do not resubmit the entry; fix the levels or use Update TP/SL."
                    ),
                )
            return OrderResult(
                success=True,
                limit_response=limit_response,
                sl_response=sl_response,
                tp_response=tp_response,
            )
        except BrokerUnavailable:
            raise
        except BrokerError as exc:
            log.error("Order placement failed on %s: %s", self.label, exc)
            return OrderResult(success=False, error=str(exc))

    def _describe(self, exc: Exception) -> str:
        if isinstance(exc, BrokerError):
            return str(exc)
        return self._translate(exc, "protective order").__str__()

    def update_tp_sl(
        self, coin: str, is_buy: bool, qty: float, tp_price: float, sl_price: float
    ) -> UpdateTpSlResult:
        try:
            info = self.instrument(coin)
            if info.spot:
                raise BrokerInputError(
                    "TP/SL updates need a perpetual position; spot exits are sell orders."
                )
            tp = self.round_price(coin, tp_price)
            sl = self.round_price(coin, sl_price)
            contracts, _base = self.round_quantity(coin, qty)
            symbol = info.symbol
            cancel_errors = self._cancel_open_orders(symbol, triggers_only=True)
            close_side = self._close_side(is_buy)
            sl_response = self._place_trigger(
                symbol, close_side, contracts, sl, "stopLossPrice", False
            )
            tp_response = self._place_trigger(
                symbol, close_side, contracts, tp, "takeProfitPrice", False
            )
            error = "; ".join(cancel_errors) or None
            return UpdateTpSlResult(
                success=True,
                tp_response=tp_response,
                sl_response=sl_response,
                error=error,
            )
        except BrokerUnavailable:
            raise
        except BrokerError as exc:
            log.error("TP/SL update failed on %s: %s", self.label, exc)
            return UpdateTpSlResult(success=False, error=str(exc))

    def position(self, coin: str) -> PositionData:
        info = self.instrument(coin)
        if info.spot:
            return PositionData(coin=info.base)
        client = self._client_ready()
        try:
            positions = client.fetch_positions([info.symbol])
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc, "position") from exc
        entry = None
        for row in positions or []:
            if str(row.get("symbol") or "") != info.symbol:
                continue
            contracts = _decimal(row.get("contracts"))
            if contracts == 0:
                continue
            entry = row
            break
        if entry is None:
            return PositionData(coin=info.base)
        contracts = _decimal(entry.get("contracts"))
        side = str(entry.get("side") or "").lower()
        size = abs(contracts * info.contract_size)
        if side == "short" or (not side and contracts < 0):
            size = -size
        entry_price = float(entry.get("entryPrice") or 0) or None
        unrealized = float(entry.get("unrealizedPnl") or 0)
        mark = float(entry.get("markPrice") or 0) or None
        tp, sl = self._position_triggers(info.symbol, size, entry_price)
        return PositionData(
            coin=info.base,
            entry_price=entry_price,
            size=float(size),
            unrealized_pnl=unrealized,
            tp_price=tp,
            sl_price=sl,
            has_position=float(size) != 0.0,
            mark_price=mark,
        )

    def _position_triggers(
        self, symbol: str, size: Decimal, entry_price: float | None
    ) -> tuple[float | None, float | None]:
        try:
            orders = self._fetch_open_orders(symbol)
        except BrokerError:
            return None, None
        explicit_tp: list[float] = []
        explicit_sl: list[float] = []
        ambiguous: list[float] = []
        for order in orders:
            if not self._is_trigger(order):
                continue
            tp = order.get("takeProfitPrice")
            sl = order.get("stopLossPrice")
            if tp not in (None, ""):
                explicit_tp.append(float(tp))
            if sl not in (None, ""):
                explicit_sl.append(float(sl))
            if tp in (None, "") and sl in (None, ""):
                price = self._order_trigger(order)
                if price is not None:
                    ambiguous.append(price)
        if explicit_tp and explicit_sl:
            return explicit_tp[0], explicit_sl[0]
        if size == 0 or entry_price is None:
            if len(ambiguous) >= 2:
                low, high = sorted(ambiguous[:2])
                return high, low
            return None, None
        if len(ambiguous) >= 2:
            low, high = sorted(ambiguous)
            if size > 0:
                return high, low
            return low, high
        if len(ambiguous) == 1:
            price = ambiguous[0]
            if size > 0:
                return (price, None) if price > entry_price else (None, price)
            return (price, None) if price < entry_price else (None, price)
        if explicit_tp:
            return explicit_tp[0], None
        if explicit_sl:
            return None, explicit_sl[0]
        return None, None

    def open_orders(self, coin: str) -> list[dict]:
        info = self.instrument(coin)
        orders = self._fetch_open_orders(info.symbol)
        out: list[dict] = []
        for order in orders:
            trigger_price = self._order_trigger(order)
            side = str(order.get("side") or "")
            amount = _decimal(order.get("amount"), "0")
            base_amount = amount * info.contract_size if not info.spot else amount
            out.append(
                {
                    "oid": order.get("id"),
                    "side": "B" if side == "buy" else "A" if side == "sell" else side,
                    "size": str(base_amount.normalize()) if base_amount else None,
                    "limitPrice": _string(order.get("price")),
                    "triggerPrice": _string(trigger_price),
                    "isTrigger": self._is_trigger(order),
                    "reduceOnly": bool(order.get("reduceOnly")),
                    "timestamp": order.get("timestamp"),
                }
            )
        return out

    def balance(self) -> dict[str, Any]:
        client = self._client_ready()
        try:
            raw = client.fetch_balance()
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc, "balance") from exc
        totals = raw.get("total") if isinstance(raw, dict) else {}
        free = raw.get("free") if isinstance(raw, dict) else {}
        balances = []
        for currency, total in (totals or {}).items():
            try:
                amount = float(total or 0)
            except (TypeError, ValueError):
                continue
            if amount == 0:
                continue
            balances.append(
                {
                    "currency": str(currency),
                    "total": amount,
                    "free": float((free or {}).get(currency) or 0),
                }
            )
        balances.sort(key=lambda item: item["total"], reverse=True)
        return {
            "ok": True,
            "exchange": self.spec.id,
            "market": self.market,
            "network": self.network,
            "balances": balances[:20],
        }


def _string(value: Any) -> str | None:
    if value in (None, ""):
        return None
    return str(value)


# ── cache / reset ────────────────────────────────────────────────────────────

_CACHE: dict[tuple[str, str, str], CcxtBroker] = {}
_CACHE_LOCK = threading.RLock()


def broker(exchange_id: str, market: str, network: str | None = None) -> CcxtBroker:
    spec = specs.exchange(exchange_id)
    resolved = network or specs.network(spec.id)
    key = (spec.id, str(market or "").lower(), resolved)
    with _CACHE_LOCK:
        cached = _CACHE.get(key)
        if cached is not None:
            return cached
        created = CcxtBroker(spec.id, key[1], resolved)
        _CACHE[key] = created
        return created


def reset_clients() -> None:
    """Drop authenticated clients so credential/network edits apply live."""
    with _CACHE_LOCK:
        _CACHE.clear()
