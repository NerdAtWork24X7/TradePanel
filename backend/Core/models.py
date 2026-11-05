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
