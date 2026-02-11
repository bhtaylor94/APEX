"""
Abstract base class for trading strategies.
"""

import logging
from abc import ABC, abstractmethod

from src.api.client import KalshiClient
from src.api.models import Market, TradeSignal

logger = logging.getLogger(__name__)


class BaseStrategy(ABC):
    """
    Abstract base for all trading strategies.

    Each strategy must implement:
    - `scan()`: Identify markets of interest
    - `analyze()`: Generate trade signals for a given market
    """

    name: str = "BaseStrategy"

    def __init__(self, client: KalshiClient):
        self.client = client

    @abstractmethod
    def scan(self) -> list[Market]:
        """
        Scan for markets relevant to this strategy.

        Returns a list of markets that are candidates for trading.
        """
        ...

    @abstractmethod
    def analyze(self, market: Market) -> TradeSignal | None:
        """
        Analyze a market and potentially generate a trade signal.

        Returns a TradeSignal if the strategy identifies an opportunity,
        or None if no trade is warranted.
        """
        ...

    def run(self) -> list[TradeSignal]:
        """
        Execute the full strategy pipeline: scan → analyze → return signals.
        """
        signals = []

        markets = self.scan()
        logger.info(f"[{self.name}] Scanning found {len(markets)} candidate markets")

        for market in markets:
            try:
                signal = self.analyze(market)
                if signal is not None:
                    signals.append(signal)
                    logger.info(
                        f"[{self.name}] Signal: {signal.ticker} "
                        f"{signal.side.value} {signal.action.value} "
                        f"EV={signal.expected_value:.4f} conf={signal.confidence:.2f}"
                    )
            except Exception as e:
                logger.error(f"[{self.name}] Error analyzing {market.ticker}: {e}")

        return signals
