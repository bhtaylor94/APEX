"""
Common helper functions for the trading bot.
"""

import time
from datetime import datetime, timezone


def unix_ts_now() -> int:
    """Current Unix timestamp in seconds."""
    return int(time.time())


def unix_ts_ms_now() -> int:
    """Current Unix timestamp in milliseconds."""
    return int(time.time() * 1000)


def hours_from_now_to_unix(hours: int) -> int:
    """Convert 'hours from now' to a Unix timestamp."""
    return unix_ts_now() + (hours * 3600)


def parse_iso_datetime(iso_str: str) -> datetime:
    """Parse an ISO 8601 datetime string to a timezone-aware datetime."""
    if not iso_str:
        return datetime.now(timezone.utc)
    # Handle various ISO formats
    iso_str = iso_str.replace("Z", "+00:00")
    try:
        return datetime.fromisoformat(iso_str)
    except ValueError:
        return datetime.now(timezone.utc)


def hours_until_close(close_time_str: str) -> float:
    """Calculate hours until a market closes."""
    if not close_time_str:
        return float("inf")
    close_time = parse_iso_datetime(close_time_str)
    now = datetime.now(timezone.utc)
    delta = close_time - now
    return max(0, delta.total_seconds() / 3600)


def cents_to_dollars(cents: int) -> float:
    """Convert cents to dollars."""
    return cents / 100.0


def dollars_to_cents(dollars: float) -> int:
    """Convert dollars to cents."""
    return int(round(dollars * 100))


def calculate_expected_value(
    estimated_probability: float,
    cost_cents: int,
    payout_cents: int = 100,
) -> float:
    """
    Calculate expected value of a binary contract.

    EV = (probability * payout) - cost
    Returns EV in cents.
    """
    return (estimated_probability * payout_cents) - cost_cents


def calculate_return_on_investment(
    cost_cents: int,
    payout_cents: int = 100,
) -> float:
    """Calculate ROI if the contract pays out. Returns as a decimal (e.g., 1.5 = 150%)."""
    if cost_cents <= 0:
        return 0.0
    return (payout_cents - cost_cents) / cost_cents


def format_market_summary(market) -> str:
    """Format a market for display."""
    return (
        f"{market.ticker} | {market.title} {market.subtitle} | "
        f"Yes: {market.yes_bid}/{market.yes_ask}¢ | "
        f"Vol: {market.volume_24h} | "
        f"Status: {market.status}"
    )
