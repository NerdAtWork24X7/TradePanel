"""Trade calculation utilities.

Pure functions — no side effects, no UI, no exchange calls.
"""

from __future__ import annotations

from Core.config import LONG_TP_PCT, LONG_SL_PCT, SHORT_TP_PCT, SHORT_SL_PCT


def detect_price_precision(price: float) -> int:
    """Detect a sensible number of decimal places for a price.

    Uses the magnitude of the price to choose a reasonable precision,
    which avoids the pitfalls of float string representation.

    Examples:
        detect_price_precision(0.1234)   -> 6
        detect_price_precision(42.50)     -> 2
        detect_price_precision(0.00012)   -> 8
    """
    if price is None or price == 0:
        return 2
    abs_price = abs(price)
    if abs_price >= 1000:
        return 2
    if abs_price >= 1:
        return 4
    if abs_price >= 0.01:
        return 6
    if abs_price >= 0.001:
        return 7
    if abs_price >= 0.0001:
        return 8
    return 10


# Hyperliquid perp price rules: at most 5 significant figures and at most
# ``PERP_PRICE_DECIMALS - szDecimals`` decimal places.
PRICE_SIG_FIGS = 5
PERP_PRICE_DECIMALS = 6


def price_decimals(sz_decimals: int) -> int:
    """Decimal places allowed for a perp price given the coin's size decimals."""
    return max(0, PERP_PRICE_DECIMALS - int(sz_decimals))


def round_exchange_price(price: float, sz_decimals: int) -> float:
    """Round a price to Hyperliquid's perp tick.

    Mirrors the SDK's own wire formatting (5 significant figures, then
    ``6 - szDecimals`` decimals) so levels drawn or typed in the UI survive
    exchange validation unchanged.
    """
    decimals = price_decimals(sz_decimals)
    return round(float(f"{price:.{PRICE_SIG_FIGS}g}"), decimals)


def round_price(price: float, reference: float | None = None) -> float:
    """Round price to the same precision as *reference* (or *price* itself).

    If *reference* is provided, its decimal precision is detected and used.
    Otherwise the precision of *price* itself is used.
    Falls back to magnitude-based heuristics if detection yields 0.
    """
    ref = reference or price
    precision = detect_price_precision(ref)
    if precision == 0:
        # Fallback: magnitude-based
        if ref >= 1:
            precision = 2
        else:
            precision = 6
    return round(price, precision)


def calculate_qty(risk: float, entry: float, sl: float, is_short: bool, sz_decimals: int = 4) -> float:
    """Calculate position size from risk amount and SL distance.

    Args:
        risk: Dollar amount you're willing to lose.
        entry: Entry price.
        sl: Stop-loss price.
        is_short: True for short positions.
        sz_decimals: Decimal precision for quantity (from exchange meta).

    Returns:
        Position size (qty).

    Raises:
        ZeroDivisionError: If entry and SL are identical.
    """
    sl_distance = (entry - sl) if not is_short else (sl - entry)
    if sl_distance == 0:
        raise ZeroDivisionError("Entry and SL are the same — infinite risk.")
    return round(risk / sl_distance, sz_decimals)


def quick_long_params(current_price: float) -> tuple[float, float, float]:
    """Return (entry, tp, sl) for a quick LONG at the given price."""
    entry = round_price(current_price)
    tp = round_price(entry * LONG_TP_PCT, current_price)
    sl = round_price(entry * LONG_SL_PCT, current_price)
    return entry, tp, sl


def quick_short_params(current_price: float) -> tuple[float, float, float]:
    """Return (entry, tp, sl) for a quick SHORT at the given price."""
    entry = round_price(current_price)
    tp = round_price(entry * SHORT_TP_PCT, current_price)
    sl = round_price(entry * SHORT_SL_PCT, current_price)
    return entry, tp, sl
