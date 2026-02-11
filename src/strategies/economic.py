"""
Economic Data Market Trading Strategy.

Trades Kalshi markets on economic indicators including:
- CPI (Consumer Price Index)
- Nonfarm Payrolls (Jobs Report)
- Federal Reserve Interest Rate Decisions
- GDP Growth
- S&P 500 Daily Close

Strategies:
1. CONSENSUS DEVIATION — When market pricing diverges from economist consensus
2. LEADING INDICATOR SIGNALS — Uses leading indicators to predict lagging data
3. FED WATCH COMPARISON — Compares Kalshi pricing to CME FedWatch probabilities
4. CALENDAR DRIFT — Trades mean reversion as release dates approach

Key insights:
- Economic markets settle based on official sources (BLS, Fed, BEA)
- Markets often overreact to recent data and underweight base rates
- Leading indicators (initial claims, PMI) provide edge on lagging data
- Consensus estimates are surprisingly accurate but not perfect
"""

import logging
import re
from typing import Optional

from src.api.client import KalshiClient
from src.api.models import Market, TradeSignal, OrderSide, OrderAction
from src.data_feeds.economic import EconomicDataFeed
from src.strategies.base import BaseStrategy
from src.utils.helpers import hours_until_close, calculate_expected_value
from config.settings import ECONOMIC_CONFIG

logger = logging.getLogger(__name__)


class EconomicStrategy(BaseStrategy):
    """
    Economic data trading strategy for Kalshi prediction markets.

    Scans economic series for mispriced brackets based on consensus data
    and leading indicator signals.
    """

    name = "EconomicStrategy"

    # Common economic series tickers on Kalshi
    DEFAULT_SERIES = ["KXCPI", "KXJOBS", "KXFED", "KXGDP", "KXSP500"]

    def __init__(
        self,
        client: KalshiClient,
        series_tickers: list[str] = None,
        fred_api_key: str = "",
        max_hours_to_close: int = 72,
        min_volume: int = 20,
    ):
        super().__init__(client)
        self.econ_feed = EconomicDataFeed(fred_api_key=fred_api_key)
        self.series_tickers = series_tickers or self.DEFAULT_SERIES
        self.max_hours_to_close = max_hours_to_close
        self.min_volume = min_volume

    def scan(self) -> list[Market]:
        """
        Scan economic series for open markets within our time horizon.
        """
        all_markets = []
        for series_ticker in self.series_tickers:
            try:
                markets = self.client.get_all_markets_for_series(
                    series_ticker=series_ticker,
                    status="open",
                )
                for m in markets:
                    h = hours_until_close(m.close_time)
                    if h <= self.max_hours_to_close:
                        all_markets.append(m)
            except Exception as e:
                logger.error(f"Error scanning economic series {series_ticker}: {e}")

        return all_markets

    def _identify_indicator(self, market: Market) -> str:
        """Identify which economic indicator a market belongs to."""
        ticker_upper = market.event_ticker.upper()
        title_lower = market.title.lower()

        if "CPI" in ticker_upper or "inflation" in title_lower or "cpi" in title_lower:
            return "CPI"
        if "JOB" in ticker_upper or "payroll" in title_lower or "nonfarm" in title_lower:
            return "JOBS"
        if "FED" in ticker_upper or "federal" in title_lower or "rate" in title_lower:
            return "FED"
        if "GDP" in ticker_upper or "gdp" in title_lower:
            return "GDP"
        if "SP500" in ticker_upper or "s&p" in title_lower or "s&p 500" in title_lower:
            return "SP500"

        return "UNKNOWN"

    def _parse_economic_bracket(
        self, subtitle: str, indicator: str
    ) -> tuple[Optional[float], Optional[float]]:
        """
        Parse a bracket from the market subtitle for an economic indicator.

        Examples:
        - "0.3% to 0.4%"  → (0.3, 0.4)
        - "≥ 200K"         → (200, inf)
        - "150K to 200K"   → (150, 200)
        - "> 5.25%"        → (5.25, inf)
        """
        subtitle = subtitle.strip()

        # Try to extract numeric values from the subtitle
        numbers = re.findall(r"[-+]?[\d]*\.?\d+", subtitle)

        if len(numbers) >= 2:
            return (float(numbers[0]), float(numbers[1]))
        elif len(numbers) == 1:
            val = float(numbers[0])
            if any(sym in subtitle for sym in ["≥", ">=", ">", "or more", "above", "over"]):
                return (val, float("inf"))
            elif any(sym in subtitle for sym in ["≤", "<=", "<", "or less", "below", "under"]):
                return (float("-inf"), val)
            else:
                return (val, val)

        return (None, None)

    def _estimate_fed_probability(
        self, bracket_low: float, bracket_high: float
    ) -> Optional[float]:
        """
        Estimate probability for a Fed rate decision bracket.
        Compares against our FedWatch-like model.
        """
        fed_data = self.econ_feed.get_fed_rate_estimate()
        if not fed_data.probabilities:
            return None

        current_rate = fed_data.current_rate_lower

        # Map brackets to outcomes
        if bracket_high <= current_rate:
            # Rate would need to be cut
            cuts_needed = int((current_rate - bracket_high) / 0.25) + 1
            if cuts_needed == 1:
                return fed_data.probabilities.get("cut_25bp", 0.1)
            return 0.02  # Multiple cuts unlikely
        elif bracket_low >= current_rate + 0.25:
            # Rate would need to be hiked
            return fed_data.probabilities.get("hike_25bp", 0.05)
        else:
            # Rate stays in current range (hold)
            return fed_data.probabilities.get("hold", 0.65)

    def analyze(self, market: Market) -> TradeSignal | None:
        """
        Analyze an economic market and generate a trading signal.

        Uses consensus data to estimate bracket probabilities
        and compares against market-implied pricing.
        """
        indicator = self._identify_indicator(market)
        if indicator == "UNKNOWN":
            return None

        bracket_low, bracket_high = self._parse_economic_bracket(
            market.subtitle, indicator
        )
        if bracket_low is None:
            logger.debug(f"Could not parse bracket from: {market.subtitle}")
            return None

        # Estimate probability based on indicator type
        est_prob = None

        if indicator == "FED":
            est_prob = self._estimate_fed_probability(bracket_low, bracket_high)
        elif indicator in ("CPI", "JOBS"):
            # Use consensus-based estimation
            try:
                est_prob = self.econ_feed.estimate_bracket_probability(
                    indicator, bracket_low, bracket_high
                )
            except ImportError:
                # scipy not available; use simpler estimation
                est_prob = self._simple_bracket_estimate(indicator, bracket_low, bracket_high)
        else:
            # For GDP, SP500 — use simpler heuristics
            est_prob = self._simple_bracket_estimate(indicator, bracket_low, bracket_high)

        if est_prob is None:
            return None

        est_prob = max(0.01, min(0.99, est_prob))

        # Market-implied probability
        market_prob = market.implied_probability
        if market_prob <= 0:
            market_prob = 0.01

        # Calculate edge
        edge = est_prob - market_prob

        # Determine trade direction
        if edge > 0.04:
            # YES is underpriced
            cost_cents = market.yes_ask if market.yes_ask > 0 else int(market_prob * 100)
            ev = calculate_expected_value(est_prob, cost_cents)
            side = OrderSide.YES
            prob_for_ev = est_prob
        elif edge < -0.04:
            # NO is underpriced
            no_prob = 1 - est_prob
            cost_cents = market.no_ask if market.no_ask > 0 else int((1 - market_prob) * 100)
            ev = calculate_expected_value(no_prob, cost_cents)
            side = OrderSide.NO
            prob_for_ev = no_prob
        else:
            return None

        ev_normalized = ev / 100.0

        # Confidence scoring
        hours_left = hours_until_close(market.close_time)
        time_factor = min(1.0, max(0.3, 1.0 - hours_left / 72.0))
        confidence = min(0.90, abs(edge) * 1.5 + time_factor * 0.2)

        # Skip low-quality signals
        if abs(edge) < 0.03 or ev_normalized < 0.01:
            return None

        reasoning = (
            f"{indicator}: bracket=[{bracket_low}, {bracket_high}], "
            f"est_prob={est_prob:.3f}, mkt_prob={market_prob:.3f}, "
            f"edge={edge:+.3f}, EV=${ev_normalized:.3f}, "
            f"hours_left={hours_left:.1f}"
        )

        return TradeSignal(
            ticker=market.ticker,
            side=side,
            action=OrderAction.BUY,
            confidence=confidence,
            estimated_probability=prob_for_ev,
            market_probability=market_prob,
            expected_value=ev_normalized,
            strategy_name=self.name,
            reasoning=reasoning,
            suggested_price=cost_cents,
        )

    def _simple_bracket_estimate(
        self, indicator: str, bracket_low: float, bracket_high: float
    ) -> float:
        """
        Simple bracket probability estimate without scipy.

        Uses a uniform-ish estimate based on common ranges for each indicator.
        In production, replace with proper distribution modeling.
        """
        # Default ranges for each indicator
        ranges = {
            "CPI": (-0.5, 1.0),
            "JOBS": (-200, 500),
            "GDP": (-2.0, 5.0),
            "SP500": (-3.0, 3.0),
        }

        total_range = ranges.get(indicator, (-10, 10))
        range_width = total_range[1] - total_range[0]

        if range_width <= 0:
            return 0.5

        effective_low = max(bracket_low, total_range[0])
        effective_high = min(bracket_high, total_range[1])

        if effective_high <= effective_low:
            return 0.01

        bracket_width = effective_high - effective_low
        return bracket_width / range_width
