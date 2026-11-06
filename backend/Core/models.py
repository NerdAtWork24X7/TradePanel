"""Data models for the Trade_Panel trading panel.

Plain dataclasses — no Qt or exchange dependencies.
"""

from __future__ import annotations
from dataclasses import dataclass


@dataclass
class OrderParams:
    """Parameters for placing an order."""
    coin: str
    is_buy: bool
    qty: float
    limit_price: float
    tp_price: float
    sl_price: float


@dataclass
class UpdateTpSlResult:
    """Result of updating TP/SL on an existing position."""
    success: bool
    cancel_response: dict | None = None
    tp_response: dict | None = None
    sl_response: dict | None = None
    error: str | None = None


@dataclass
class OrderResult:
    """Result of placing an order."""
    success: bool
    limit_response: dict | None = None
    sl_response: dict | None = None
    tp_response: dict | None = None
    error: str | None = None


@dataclass
class PositionData:
    """Open position data for a single coin."""
    coin: str
    entry_price: float | None = None
    size: float = 0.0        # positive = long, negative = short
    unrealized_pnl: float = 0.0
    tp_price: float | None = None
    sl_price: float | None = None
    has_position: bool = False
    mark_price: float | None = None  # current mid price (optional)
