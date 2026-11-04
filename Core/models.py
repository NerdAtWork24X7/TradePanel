"""Data models for the Trade_Panel trading panel.

Plain dataclasses — no Qt or exchange dependencies.
"""

from __future__ import annotations
from dataclasses import dataclass, field


@dataclass
class FVG:
    """Fair Value Gap levels."""
    high: float = 0.0
    low: float = 0.0


@dataclass
class TrendLine:
    """Trend-line anchor points."""
    y2: float = 0.0
    y1: float = 0.0
    x2: float = 0.0
    x1: float = 0.0


@dataclass
class CoinAlert:
    """All alert data for a single coin."""
    fvg: FVG = field(default_factory=FVG)
    high_trend: TrendLine = field(default_factory=TrendLine)
    low_trend: TrendLine = field(default_factory=TrendLine)

    def to_dict(self) -> dict:
        return {
            "FVG": {"high": self.fvg.high, "low": self.fvg.low},
            "hightrend": {
                "Y2": self.high_trend.y2, "Y1": self.high_trend.y1,
                "X2": self.high_trend.x2, "X1": self.high_trend.x1,
            },
            "lowtrend": {
                "Y2": self.low_trend.y2, "Y1": self.low_trend.y1,
                "X2": self.low_trend.x2, "X1": self.low_trend.x1,
            },
        }

    @classmethod
    def from_dict(cls, d: dict) -> CoinAlert:
        fvg = d.get("FVG", {})
        ht = d.get("hightrend", {})
        lt = d.get("lowtrend", {})
        return cls(
            fvg=FVG(high=fvg.get("high", 0.0), low=fvg.get("low", 0.0)),
            high_trend=TrendLine(
                y2=ht.get("Y2", 0.0), y1=ht.get("Y1", 0.0),
                x2=ht.get("X2", 0), x1=ht.get("X1", 0.0),
            ),
            low_trend=TrendLine(
                y2=lt.get("Y2", 0.0), y1=lt.get("Y1", 0.0),
                x2=lt.get("X2", 0), x1=lt.get("X1", 0.0),
            ),
        )


@dataclass
class OrderParams:
    """Parameters for placing an order."""
    coin: str
    is_buy: bool
    qty: float
    limit_price: float
    tp_price: float
    sl_price: float
