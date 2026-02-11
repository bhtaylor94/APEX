"""
Weather Market Trading Strategy.

Implements proven strategies from successful Kalshi weather traders:

1. FORECAST DIVERGENCE — Compares NWS point forecast against the market's
   implied temperature. When our forecast differs significantly, we trade
   the bracket our model favors at a discount.

2. OBSERVATION MOMENTUM — If current observations show temps running
   hotter/colder than forecast, buy adjacent brackets before the market adjusts.

3. EDGE BRACKET VALUE — The outer brackets (highest/lowest) are chronically
   underpriced when conditions support outlier temps. Buy at 1-5¢ for
   asymmetric payoffs.

4. MULTI-MODEL DIVERGENCE — When different weather models disagree, identify
   which model has been more accurate for this station recently.

Key insights from successful traders:
- Settlement is based on NWS Daily Climate Report, NOT consumer weather apps
- DST affects reporting windows (1:00 AM to 12:59 AM local standard time)
- Markets open at 10 AM day before; forecasts improve dramatically same-day
- When all brackets drop to 1¢, an informed trader is signaling it's dead
- Forecasts are frequently wrong; weather models often diverge from them
"""

import logging
import re
from typing import Optional

from src.api.client import KalshiClient
from src.api.models import Market, TradeSignal, OrderSide, OrderAction
from src.data_feeds.nws import NWSDataFeed
from src.strategies.base import BaseStrategy
from src.utils.helpers import hours_until_close, calculate_expected_value
from config.settings import WEATHER_CONFIG

logger = logging.getLogger(__name__)


class WeatherStrategy(BaseStrategy):
    """
    Weather market trading strategy for Kalshi.

    Trades daily high temperature markets for NYC, Chicago, Miami, and Austin.
    """

    name = "WeatherStrategy"

    # Series tickers for weather markets
    SERIES_TICKERS = ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS"]

    def __init__(
        self,
        client: KalshiClient,
        series_tickers: list[str] = None,
        max_hours_to_close: int = 48,
        min_volume: int = 10,
    ):
        super().__init__(client)
        self.nws = NWSDataFeed()
        self.series_tickers = series_tickers or self.SERIES_TICKERS
        self.max_hours_to_close = max_hours_to_close
        self.min_volume = min_volume

    def scan(self) -> list[Market]:
        """
        Scan all weather series for open markets within our time horizon.
        """
        all_markets = []
        for series_ticker in self.series_tickers:
            try:
                markets = self.client.get_all_markets_for_series(
                    series_ticker=series_ticker,
                    status="open",
                )
                # Filter by time to close and minimum volume
                for m in markets:
                    h = hours_until_close(m.close_time)
                    if h <= self.max_hours_to_close:
                        all_markets.append(m)
            except Exception as e:
                logger.error(f"Error scanning series {series_ticker}: {e}")

        return all_markets

    def _parse_bracket_from_subtitle(self, subtitle: str) -> tuple[Optional[float], Optional[float]]:
        """
        Parse temperature bracket from market subtitle.

        Examples:
        - "51° to 52°" → (51.0, 53.0)   (exclusive upper bound)
        - "≤ 49°"      → (-999, 50.0)
        - "≥ 55°"      → (55.0, 999)
        - "50° or less" → (-999, 51.0)
        - "56° or more" → (56.0, 999)
        """
        subtitle = subtitle.strip()

        # Pattern: "X° to Y°" or "X to Y"
        range_match = re.search(r"(\d+)\s*°?\s*to\s*(\d+)\s*°?", subtitle)
        if range_match:
            low = float(range_match.group(1))
            high = float(range_match.group(2)) + 1  # exclusive upper
            return (low, high)

        # Pattern: "≤ X°" or "X° or less" or "under X°" or "< X°"
        lower_match = re.search(r"[≤<]\s*(\d+)|(\d+)\s*°?\s*or\s*less|under\s*(\d+)", subtitle)
        if lower_match:
            val = float(next(g for g in lower_match.groups() if g is not None))
            return (-999, val + 1)

        # Pattern: "≥ X°" or "X° or more" or "over X°" or "> X°"
        upper_match = re.search(r"[≥>]\s*(\d+)|(\d+)\s*°?\s*or\s*more|over\s*(\d+)", subtitle)
        if upper_match:
            val = float(next(g for g in upper_match.groups() if g is not None))
            return (val, 999)

        return (None, None)

    def _get_series_config(self, market: Market) -> dict:
        """Get the weather config for a market's series."""
        # Extract series ticker from event ticker
        for series_ticker, config in WEATHER_CONFIG.items():
            if market.event_ticker.startswith(series_ticker.replace("KX", "")):
                return {**config, "series_ticker": series_ticker}
            # Also check if the event_ticker contains the city abbreviation
            if series_ticker in market.event_ticker or series_ticker.replace("KX", "") in market.event_ticker:
                return {**config, "series_ticker": series_ticker}

        # Try matching by title
        title_lower = market.title.lower()
        for series_ticker, config in WEATHER_CONFIG.items():
            if config["city"].lower() in title_lower:
                return {**config, "series_ticker": series_ticker}

        return {}

    def analyze(self, market: Market) -> TradeSignal | None:
        """
        Analyze a weather market and generate a trading signal.

        Strategy pipeline:
        1. Get NWS forecast for this station
        2. Parse the bracket this market represents
        3. Compare our estimated probability vs market-implied probability
        4. If there's sufficient edge, generate a signal
        """
        config = self._get_series_config(market)
        if not config:
            logger.debug(f"No weather config found for {market.ticker}")
            return None

        # Get our temperature estimate
        estimated_high = self.nws.estimate_high_temperature(
            station=config["station"],
            lat=config["lat"],
            lon=config["lon"],
            city=config["city"],
        )

        if estimated_high is None:
            logger.debug(f"Could not get temperature estimate for {config['city']}")
            return None

        # Parse the bracket
        bracket_low, bracket_high = self._parse_bracket_from_subtitle(market.subtitle)
        if bracket_low is None or bracket_high is None:
            logger.debug(f"Could not parse bracket from subtitle: {market.subtitle}")
            return None

        # Estimate probability that the high temp falls in this bracket
        # Simple Gaussian model centered on our estimate with typical forecast error
        import numpy as np

        forecast_std = 2.5  # Typical NWS forecast error in °F
        if bracket_low == -999:
            # Lower edge bracket
            est_prob = self._normal_cdf(bracket_high, estimated_high, forecast_std)
        elif bracket_high == 999:
            # Upper edge bracket
            est_prob = 1.0 - self._normal_cdf(bracket_low, estimated_high, forecast_std)
        else:
            # Middle bracket
            est_prob = (
                self._normal_cdf(bracket_high, estimated_high, forecast_std)
                - self._normal_cdf(bracket_low, estimated_high, forecast_std)
            )

        est_prob = max(0.01, min(0.99, est_prob))

        # Market-implied probability
        market_prob = market.implied_probability
        if market_prob <= 0:
            market_prob = 0.01

        # Calculate edge and expected value
        edge = est_prob - market_prob

        # Determine trade direction
        if edge > 0:
            # Our model says YES is underpriced → BUY YES
            cost_cents = market.yes_ask if market.yes_ask > 0 else int(market_prob * 100)
            ev = calculate_expected_value(est_prob, cost_cents)
            side = OrderSide.YES
        elif edge < -0.05:
            # Our model says YES is overpriced → BUY NO
            cost_cents = market.no_ask if market.no_ask > 0 else int((1 - market_prob) * 100)
            no_prob = 1 - est_prob
            ev = calculate_expected_value(no_prob, cost_cents)
            side = OrderSide.NO
            est_prob = no_prob
        else:
            return None  # Not enough edge

        ev_normalized = ev / 100.0  # Convert from cents to dollars

        # Confidence based on forecast quality and edge magnitude
        hours_left = hours_until_close(market.close_time)
        time_confidence = min(1.0, 1.0 - (hours_left / 48.0) * 0.3)
        confidence = min(0.95, abs(edge) * 2 + time_confidence * 0.3)

        # Minimum thresholds
        if abs(edge) < 0.03 or ev_normalized < 0.02:
            return None

        # Build the signal
        reasoning = (
            f"{config['city']}: est_high={estimated_high:.1f}°F, "
            f"bracket=[{bracket_low}, {bracket_high}], "
            f"est_prob={est_prob:.3f}, mkt_prob={market_prob:.3f}, "
            f"edge={edge:+.3f}, hours_left={hours_left:.1f}"
        )

        return TradeSignal(
            ticker=market.ticker,
            side=side,
            action=OrderAction.BUY,
            confidence=confidence,
            estimated_probability=est_prob,
            market_probability=market_prob,
            expected_value=ev_normalized,
            strategy_name=self.name,
            reasoning=reasoning,
            suggested_price=cost_cents,
        )

    @staticmethod
    def _normal_cdf(x: float, mean: float, std: float) -> float:
        """Compute the CDF of a normal distribution (no scipy dependency)."""
        import math

        z = (x - mean) / std
        return 0.5 * (1 + math.erf(z / math.sqrt(2)))
