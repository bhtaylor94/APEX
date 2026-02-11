"""
Data models for Kalshi API responses and internal trading objects.
"""

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Optional


class MarketStatus(str, Enum):
    INITIALIZED = "initialized"
    ACTIVE = "active"
    CLOSED = "closed"
    SETTLED = "settled"


class OrderSide(str, Enum):
    YES = "yes"
    NO = "no"


class OrderAction(str, Enum):
    BUY = "buy"
    SELL = "sell"


class OrderType(str, Enum):
    LIMIT = "limit"
    MARKET = "market"


class OrderStatus(str, Enum):
    RESTING = "resting"
    CANCELED = "canceled"
    EXECUTED = "executed"
    PENDING = "pending"


@dataclass
class Market:
    """Represents a Kalshi market (a specific binary outcome within an event)."""

    ticker: str
    event_ticker: str
    title: str
    subtitle: str = ""
    status: str = "active"
    open_time: Optional[str] = None
    close_time: Optional[str] = None
    expiration_time: Optional[str] = None
    yes_bid: int = 0  # in cents
    yes_ask: int = 0
    no_bid: int = 0
    no_ask: int = 0
    last_price: int = 0
    volume: int = 0
    volume_24h: int = 0
    open_interest: int = 0
    result: str = ""
    # Dollar-denominated fields (newer API)
    yes_bid_dollars: str = "0.00"
    yes_ask_dollars: str = "0.00"
    no_bid_dollars: str = "0.00"
    no_ask_dollars: str = "0.00"
    last_price_dollars: str = "0.00"

    @property
    def yes_mid(self) -> float:
        """Mid-market price for YES side in cents."""
        if self.yes_bid and self.yes_ask:
            return (self.yes_bid + self.yes_ask) / 2
        return float(self.last_price)

    @property
    def implied_probability(self) -> float:
        """Market-implied probability of YES outcome (0.0 to 1.0)."""
        mid = self.yes_mid
        return mid / 100.0 if mid > 0 else 0.0

    @classmethod
    def from_api(cls, data: dict) -> "Market":
        """Create a Market from Kalshi API response data."""
        return cls(
            ticker=data.get("ticker", ""),
            event_ticker=data.get("event_ticker", ""),
            title=data.get("title", ""),
            subtitle=data.get("subtitle", ""),
            status=data.get("status", "active"),
            open_time=data.get("open_time"),
            close_time=data.get("close_time"),
            expiration_time=data.get("expiration_time"),
            yes_bid=data.get("yes_bid", 0),
            yes_ask=data.get("yes_ask", 0),
            no_bid=data.get("no_bid", 0),
            no_ask=data.get("no_ask", 0),
            last_price=data.get("last_price", 0),
            volume=data.get("volume", 0),
            volume_24h=data.get("volume_24h", 0),
            open_interest=data.get("open_interest", 0),
            result=data.get("result", ""),
            yes_bid_dollars=data.get("yes_bid_dollars", "0.00"),
            yes_ask_dollars=data.get("yes_ask_dollars", "0.00"),
            no_bid_dollars=data.get("no_bid_dollars", "0.00"),
            no_ask_dollars=data.get("no_ask_dollars", "0.00"),
            last_price_dollars=data.get("last_price_dollars", "0.00"),
        )


@dataclass
class Event:
    """Represents a Kalshi event (e.g., 'Highest temperature in NYC on Feb 11')."""

    event_ticker: str
    series_ticker: str
    title: str
    category: str = ""
    markets: list[Market] = field(default_factory=list)
    status: str = "active"

    @classmethod
    def from_api(cls, data: dict) -> "Event":
        markets = []
        for m in data.get("markets", []):
            markets.append(Market.from_api(m))
        return cls(
            event_ticker=data.get("event_ticker", ""),
            series_ticker=data.get("series_ticker", ""),
            title=data.get("title", ""),
            category=data.get("category", ""),
            markets=markets,
            status=data.get("status", "active"),
        )


@dataclass
class OrderRequest:
    """Represents an order to be submitted to Kalshi."""

    ticker: str
    side: OrderSide
    action: OrderAction
    count: int
    order_type: OrderType = OrderType.LIMIT
    yes_price: Optional[int] = None  # cents
    no_price: Optional[int] = None
    client_order_id: str = ""
    time_in_force: str = "gtc"  # gtc, ioc, fill_or_kill
    buy_max_cost: Optional[int] = None
    post_only: bool = False

    def to_api_payload(self) -> dict:
        """Convert to Kalshi API request body."""
        payload = {
            "ticker": self.ticker,
            "side": self.side.value,
            "action": self.action.value,
            "count": self.count,
            "type": self.order_type.value,
        }
        if self.yes_price is not None:
            payload["yes_price"] = self.yes_price
        if self.no_price is not None:
            payload["no_price"] = self.no_price
        if self.client_order_id:
            payload["client_order_id"] = self.client_order_id
        if self.time_in_force:
            payload["time_in_force"] = self.time_in_force
        if self.buy_max_cost is not None:
            payload["buy_max_cost"] = self.buy_max_cost
        if self.post_only:
            payload["post_only"] = True
        return payload


@dataclass
class Position:
    """Represents a position in a market."""

    ticker: str
    event_ticker: str
    market_exposure: int = 0  # cents
    resting_orders_count: int = 0
    realized_pnl: int = 0
    total_traded: int = 0
    yes_count: int = 0
    no_count: int = 0

    @classmethod
    def from_api(cls, data: dict) -> "Position":
        return cls(
            ticker=data.get("ticker", ""),
            event_ticker=data.get("event_ticker", ""),
            market_exposure=data.get("market_exposure", 0),
            resting_orders_count=data.get("resting_orders_count", 0),
            realized_pnl=data.get("realized_pnl", 0),
            total_traded=data.get("total_traded", 0),
            yes_count=data.get("yes_count", 0) or data.get("yes_sub_total_cost", 0),
            no_count=data.get("no_count", 0) or data.get("no_sub_total_cost", 0),
        )


@dataclass
class TradeSignal:
    """A trading signal generated by a strategy."""

    ticker: str
    side: OrderSide
    action: OrderAction
    confidence: float  # 0.0 to 1.0
    estimated_probability: float  # Our model's probability estimate
    market_probability: float  # Market-implied probability
    expected_value: float  # Expected value per contract
    strategy_name: str
    reasoning: str
    suggested_price: Optional[int] = None  # cents
    suggested_count: Optional[int] = None
    timestamp: datetime = field(default_factory=datetime.utcnow)

    @property
    def edge(self) -> float:
        """Estimated edge over the market (positive = favorable)."""
        return abs(self.estimated_probability - self.market_probability)
