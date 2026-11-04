"""UI event handlers — business logic extracted from MainWindow.

Each handler is a plain Python class (no QObject dependency) that takes
toolbar and chart references. MainWindow creates handlers, connects signals,
and manages threading.
"""

from UI.handlers.trade import TradeHandler
from UI.handlers.position import PositionHandler
__all__ = ["TradeHandler", "PositionHandler"]
