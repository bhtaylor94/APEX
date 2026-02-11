"""
Kalshi REST API Client.

Handles all communication with the Kalshi Exchange API v2, including:
- RSA-PSS authenticated requests
- Rate limiting (Basic tier: 20 reads/sec, 10 writes/sec)
- Pagination
- Error handling with exponential backoff
"""

import json
import time
import uuid
import logging
from typing import Optional
from urllib.parse import urljoin

import requests

from src.api.auth import get_auth_headers, load_private_key, load_private_key_from_string
from src.api.models import (
    Event,
    Market,
    OrderRequest,
    Position,
)

logger = logging.getLogger(__name__)


class RateLimiter:
    """Token-bucket rate limiter for API compliance."""

    def __init__(self, max_per_second: int):
        self.max_per_second = max_per_second
        self.tokens = max_per_second
        self.last_refill = time.monotonic()

    def acquire(self):
        """Block until a token is available."""
        while True:
            now = time.monotonic()
            elapsed = now - self.last_refill
            self.tokens = min(self.max_per_second, self.tokens + elapsed * self.max_per_second)
            self.last_refill = now

            if self.tokens >= 1:
                self.tokens -= 1
                return
            sleep_time = (1 - self.tokens) / self.max_per_second
            time.sleep(sleep_time)


class KalshiAPIError(Exception):
    """Custom exception for Kalshi API errors."""

    def __init__(self, status_code: int, message: str, response_body: dict = None):
        self.status_code = status_code
        self.message = message
        self.response_body = response_body or {}
        super().__init__(f"Kalshi API Error {status_code}: {message}")


class KalshiClient:
    """
    Client for the Kalshi Exchange REST API v2.

    Supports both demo and production environments with automatic
    RSA-PSS request signing and rate limit compliance.
    """

    def __init__(
        self,
        api_key: str,
        private_key_path: str = "",
        private_key_string: str = "",
        base_url: str = "https://demo-api.kalshi.co/trade-api/v2",
        read_rate: int = 20,
        write_rate: int = 10,
    ):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.session = requests.Session()

        # Load private key
        if private_key_path:
            self.private_key = load_private_key(private_key_path)
        elif private_key_string:
            self.private_key = load_private_key_from_string(private_key_string)
        else:
            self.private_key = None

        # Rate limiters
        self._read_limiter = RateLimiter(read_rate)
        self._write_limiter = RateLimiter(write_rate)

        # Retry config
        self._max_retries = 3
        self._base_backoff = 0.5

    # ------------------------------------------------------------------ #
    #                        Low-Level HTTP Methods                       #
    # ------------------------------------------------------------------ #

    def _request(
        self,
        method: str,
        path: str,
        params: dict = None,
        json_body: dict = None,
        authenticated: bool = True,
    ) -> dict:
        """Execute an API request with auth, rate limiting, and retries."""
        url = f"{self.base_url}{path}"
        is_write = method.upper() in ("POST", "PUT", "DELETE", "PATCH")

        # Rate limit
        if is_write:
            self._write_limiter.acquire()
        else:
            self._read_limiter.acquire()

        # Build headers
        headers = {}
        if authenticated and self.private_key:
            api_path = f"/trade-api/v2{path}"
            headers = get_auth_headers(self.api_key, self.private_key, method.upper(), api_path)
        else:
            headers["Content-Type"] = "application/json"

        # Retry loop with exponential backoff
        last_exception = None
        for attempt in range(self._max_retries):
            try:
                response = self.session.request(
                    method=method.upper(),
                    url=url,
                    params=params,
                    json=json_body,
                    headers=headers,
                    timeout=30,
                )

                if response.status_code == 429:
                    # Rate limited — back off
                    wait = self._base_backoff * (2 ** attempt)
                    logger.warning(f"Rate limited (429). Retrying in {wait:.1f}s...")
                    time.sleep(wait)
                    continue

                if response.status_code >= 400:
                    body = {}
                    try:
                        body = response.json()
                    except Exception:
                        pass
                    raise KalshiAPIError(
                        response.status_code,
                        body.get("message", response.text[:200]),
                        body,
                    )

                if response.status_code == 204:
                    return {}

                return response.json()

            except (requests.ConnectionError, requests.Timeout) as e:
                last_exception = e
                wait = self._base_backoff * (2 ** attempt)
                logger.warning(f"Connection error: {e}. Retrying in {wait:.1f}s...")
                time.sleep(wait)

        raise last_exception or KalshiAPIError(0, "Max retries exceeded")

    def _get(self, path: str, params: dict = None, authenticated: bool = True) -> dict:
        return self._request("GET", path, params=params, authenticated=authenticated)

    def _post(self, path: str, json_body: dict = None, authenticated: bool = True) -> dict:
        return self._request("POST", path, json_body=json_body, authenticated=authenticated)

    def _delete(self, path: str, authenticated: bool = True) -> dict:
        return self._request("DELETE", path, authenticated=authenticated)

    # ------------------------------------------------------------------ #
    #                          Exchange Status                            #
    # ------------------------------------------------------------------ #

    def get_exchange_status(self) -> dict:
        """Check if the exchange is currently active."""
        return self._get("/exchange/status", authenticated=False)

    # ------------------------------------------------------------------ #
    #                          Market Data (Public)                       #
    # ------------------------------------------------------------------ #

    def get_markets(
        self,
        limit: int = 100,
        cursor: str = "",
        event_ticker: str = "",
        series_ticker: str = "",
        status: str = "",
        max_close_ts: Optional[int] = None,
        min_close_ts: Optional[int] = None,
    ) -> tuple[list[Market], str]:
        """
        Get markets with optional filters. Returns (markets, next_cursor).

        Pagination: pass the returned cursor to get the next page.
        """
        params = {"limit": min(limit, 1000)}
        if cursor:
            params["cursor"] = cursor
        if event_ticker:
            params["event_ticker"] = event_ticker
        if series_ticker:
            params["series_ticker"] = series_ticker
        if status:
            params["status"] = status
        if max_close_ts:
            params["max_close_ts"] = max_close_ts
        if min_close_ts:
            params["min_close_ts"] = min_close_ts

        data = self._get("/markets", params=params, authenticated=False)
        markets = [Market.from_api(m) for m in data.get("markets", [])]
        next_cursor = data.get("cursor", "")
        return markets, next_cursor

    def get_all_markets_for_series(self, series_ticker: str, status: str = "open") -> list[Market]:
        """Fetch all markets for a series, handling pagination automatically."""
        all_markets = []
        cursor = ""
        while True:
            markets, cursor = self.get_markets(
                limit=200,
                series_ticker=series_ticker,
                status=status,
                cursor=cursor,
            )
            all_markets.extend(markets)
            if not cursor:
                break
        return all_markets

    def get_market(self, ticker: str) -> Market:
        """Get a single market by its ticker."""
        data = self._get(f"/markets/{ticker}", authenticated=False)
        return Market.from_api(data.get("market", data))

    def get_market_orderbook(self, ticker: str, depth: int = 10) -> dict:
        """Get the orderbook for a specific market."""
        params = {"depth": depth}
        return self._get(f"/markets/{ticker}/orderbook", params=params, authenticated=False)

    def get_market_trades(
        self,
        ticker: str = "",
        limit: int = 100,
        cursor: str = "",
    ) -> tuple[list[dict], str]:
        """Get recent trades, optionally filtered by market ticker."""
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        if ticker:
            params["ticker"] = ticker
        data = self._get("/markets/trades", params=params, authenticated=False)
        return data.get("trades", []), data.get("cursor", "")

    # ------------------------------------------------------------------ #
    #                          Events (Public)                            #
    # ------------------------------------------------------------------ #

    def get_events(
        self,
        limit: int = 100,
        cursor: str = "",
        series_ticker: str = "",
        status: str = "",
        with_nested_markets: bool = False,
    ) -> tuple[list[Event], str]:
        """Get events with optional filters."""
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        if series_ticker:
            params["series_ticker"] = series_ticker
        if status:
            params["status"] = status
        if with_nested_markets:
            params["with_nested_markets"] = "true"

        data = self._get("/events", params=params, authenticated=False)
        events = [Event.from_api(e) for e in data.get("events", [])]
        return events, data.get("cursor", "")

    def get_event(self, event_ticker: str, with_nested_markets: bool = True) -> Event:
        """Get a single event by ticker."""
        params = {}
        if with_nested_markets:
            params["with_nested_markets"] = "true"
        data = self._get(f"/events/{event_ticker}", params=params, authenticated=False)
        return Event.from_api(data.get("event", data))

    def get_series(self, series_ticker: str) -> dict:
        """Get series information (metadata, settlement sources, etc.)."""
        return self._get(f"/series/{series_ticker}", authenticated=False)

    # ------------------------------------------------------------------ #
    #                      Portfolio (Authenticated)                      #
    # ------------------------------------------------------------------ #

    def get_balance(self) -> float:
        """Get account balance in dollars."""
        data = self._get("/portfolio/balance")
        # Balance is returned in cents
        balance_cents = data.get("balance", 0)
        return balance_cents / 100.0

    def get_positions(
        self,
        limit: int = 100,
        cursor: str = "",
        event_ticker: str = "",
        settlement_status: str = "",
    ) -> tuple[list[Position], str]:
        """Get current portfolio positions."""
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        if event_ticker:
            params["event_ticker"] = event_ticker
        if settlement_status:
            params["settlement_status"] = settlement_status

        data = self._get("/portfolio/positions", params=params)
        positions = [Position.from_api(p) for p in data.get("market_positions", [])]
        return positions, data.get("cursor", "")

    def get_all_positions(self) -> list[Position]:
        """Fetch all open positions, handling pagination."""
        all_positions = []
        cursor = ""
        while True:
            positions, cursor = self.get_positions(
                limit=200,
                cursor=cursor,
                settlement_status="unsettled",
            )
            all_positions.extend(positions)
            if not cursor:
                break
        return all_positions

    # ------------------------------------------------------------------ #
    #                       Orders (Authenticated)                        #
    # ------------------------------------------------------------------ #

    def create_order(self, order: OrderRequest) -> dict:
        """Submit an order to the exchange."""
        if not order.client_order_id:
            order.client_order_id = str(uuid.uuid4())

        payload = order.to_api_payload()
        logger.info(f"Submitting order: {payload}")

        data = self._post("/portfolio/orders", json_body=payload)
        return data.get("order", data)

    def cancel_order(self, order_id: str) -> dict:
        """Cancel a resting order."""
        return self._delete(f"/portfolio/orders/{order_id}")

    def get_orders(
        self,
        ticker: str = "",
        status: str = "",
        limit: int = 100,
    ) -> list[dict]:
        """Get orders with optional filters."""
        params = {"limit": limit}
        if ticker:
            params["ticker"] = ticker
        if status:
            params["status"] = status

        data = self._get("/portfolio/orders", params=params)
        return data.get("orders", [])

    def get_fills(self, limit: int = 100, ticker: str = "") -> list[dict]:
        """Get executed trades (fills)."""
        params = {"limit": limit}
        if ticker:
            params["ticker"] = ticker
        data = self._get("/portfolio/fills", params=params)
        return data.get("fills", [])
