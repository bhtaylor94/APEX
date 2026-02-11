"""
Economic Data Feed.

Provides consensus estimates and leading indicators for economic data markets.
Uses publicly available data sources to build probability estimates for
CPI, jobs reports, Fed rate decisions, GDP, and S&P 500 markets.
"""

import logging
from dataclasses import dataclass, field
from typing import Optional

import requests

logger = logging.getLogger(__name__)


@dataclass
class EconomicConsensus:
    """Consensus estimate for an economic data release."""

    indicator: str
    consensus_value: Optional[float] = None
    previous_value: Optional[float] = None
    high_estimate: Optional[float] = None
    low_estimate: Optional[float] = None
    release_date: str = ""
    source: str = ""

    @property
    def consensus_range(self) -> tuple[Optional[float], Optional[float]]:
        """Range of analyst estimates."""
        return (self.low_estimate, self.high_estimate)


@dataclass
class FedWatchData:
    """Fed rate decision probability data (similar to CME FedWatch)."""

    meeting_date: str = ""
    current_rate_lower: float = 0.0
    current_rate_upper: float = 0.0
    probabilities: dict = field(default_factory=dict)
    # e.g., {"hold": 0.65, "cut_25bp": 0.30, "hike_25bp": 0.05}


class EconomicDataFeed:
    """
    Fetches economic consensus data and leading indicators.

    For production use, you would integrate with:
    - Bloomberg Terminal API
    - Reuters Eikon
    - FRED (Federal Reserve Economic Data) — free
    - Trading Economics API

    This implementation uses FRED for freely available economic data
    and provides a framework for adding premium data sources.
    """

    FRED_API_BASE = "https://api.stlouisfed.org/fred"

    def __init__(self, fred_api_key: str = ""):
        self.fred_api_key = fred_api_key
        self.session = requests.Session()
        self._cache: dict = {}

    # ------------------------------------------------------------------ #
    #                    FRED Data (Free, Public)                         #
    # ------------------------------------------------------------------ #

    def get_fred_series(self, series_id: str, limit: int = 10) -> list[dict]:
        """
        Fetch data from FRED (Federal Reserve Economic Data).

        Useful series IDs:
        - CPIAUCSL: CPI for All Urban Consumers
        - PAYEMS: Total Nonfarm Payrolls
        - FEDFUNDS: Federal Funds Effective Rate
        - GDP: Gross Domestic Product
        - UNRATE: Unemployment Rate
        - ICSA: Initial Jobless Claims (leading indicator)
        """
        if not self.fred_api_key:
            logger.warning("FRED API key not configured. Using cached/default data.")
            return []

        try:
            url = f"{self.FRED_API_BASE}/series/observations"
            params = {
                "series_id": series_id,
                "api_key": self.fred_api_key,
                "file_type": "json",
                "sort_order": "desc",
                "limit": limit,
            }
            resp = self.session.get(url, params=params, timeout=15)
            resp.raise_for_status()
            data = resp.json()
            return data.get("observations", [])
        except requests.RequestException as e:
            logger.error(f"FRED API error for {series_id}: {e}")
            return []

    # ------------------------------------------------------------------ #
    #                    Consensus Estimates                              #
    # ------------------------------------------------------------------ #

    def get_cpi_consensus(self) -> EconomicConsensus:
        """
        Get CPI consensus estimate.

        In production, this would pull from Bloomberg/Reuters consensus.
        For now, uses recent FRED data trend to estimate.
        """
        recent = self.get_fred_series("CPIAUCSL", limit=3)
        consensus = EconomicConsensus(indicator="CPI", source="FRED trend estimate")

        if len(recent) >= 2:
            try:
                latest = float(recent[0]["value"])
                previous = float(recent[1]["value"])
                # Simple month-over-month change estimate
                mom_change = (latest - previous) / previous * 100
                consensus.previous_value = round(mom_change, 2)
                # Estimate next month based on recent trend
                consensus.consensus_value = round(mom_change, 2)
                consensus.low_estimate = round(mom_change - 0.1, 2)
                consensus.high_estimate = round(mom_change + 0.1, 2)
            except (ValueError, ZeroDivisionError):
                pass

        return consensus

    def get_jobs_consensus(self) -> EconomicConsensus:
        """Get nonfarm payrolls consensus estimate."""
        recent = self.get_fred_series("PAYEMS", limit=3)
        consensus = EconomicConsensus(indicator="Nonfarm Payrolls", source="FRED trend estimate")

        if len(recent) >= 2:
            try:
                latest = float(recent[0]["value"])
                previous = float(recent[1]["value"])
                change = latest - previous  # in thousands
                consensus.previous_value = change
                consensus.consensus_value = change
                consensus.low_estimate = change - 50
                consensus.high_estimate = change + 50
            except ValueError:
                pass

        return consensus

    def get_fed_rate_estimate(self) -> FedWatchData:
        """
        Estimate Fed rate decision probabilities.

        In production, compare against CME FedWatch Tool data.
        Uses Fed Funds rate trend and recent communications.
        """
        recent = self.get_fred_series("FEDFUNDS", limit=3)
        fed_data = FedWatchData()

        if recent:
            try:
                current = float(recent[0]["value"])
                fed_data.current_rate_lower = current
                fed_data.current_rate_upper = current + 0.25

                # Default probabilities (would be derived from futures in production)
                fed_data.probabilities = {
                    "hold": 0.65,
                    "cut_25bp": 0.25,
                    "hike_25bp": 0.10,
                }
            except ValueError:
                pass

        return fed_data

    def get_initial_claims(self) -> Optional[float]:
        """
        Get latest initial jobless claims (leading indicator for jobs report).
        """
        recent = self.get_fred_series("ICSA", limit=1)
        if recent:
            try:
                return float(recent[0]["value"])
            except ValueError:
                pass
        return None

    # ------------------------------------------------------------------ #
    #                    Probability Estimation                           #
    # ------------------------------------------------------------------ #

    def estimate_bracket_probability(
        self,
        indicator: str,
        bracket_low: float,
        bracket_high: float,
    ) -> float:
        """
        Estimate the probability that an economic indicator falls within a bracket.

        Uses a normal distribution centered on the consensus estimate with
        historical volatility as the standard deviation.

        Args:
            indicator: Economic indicator name
            bracket_low: Lower bound of the bracket
            bracket_high: Upper bound of the bracket

        Returns:
            Estimated probability (0.0 to 1.0)
        """
        import numpy as np

        consensus_map = {
            "CPI": self.get_cpi_consensus,
            "JOBS": self.get_jobs_consensus,
        }

        getter = consensus_map.get(indicator)
        if not getter:
            return 0.5  # No estimate available

        consensus = getter()
        if consensus.consensus_value is None:
            return 0.5

        mean = consensus.consensus_value
        # Estimate std from the consensus range
        if consensus.high_estimate and consensus.low_estimate:
            std = (consensus.high_estimate - consensus.low_estimate) / 4  # ~95% range
        else:
            std = abs(mean) * 0.05  # Default 5% of the value

        if std <= 0:
            std = 0.01

        # Normal CDF probability for the bracket
        from scipy.stats import norm

        prob = norm.cdf(bracket_high, loc=mean, scale=std) - norm.cdf(
            bracket_low, loc=mean, scale=std
        )

        return max(0.001, min(0.999, prob))
