"""
Tests for the Kalshi Trading Bot.
"""

import math
import pytest

from src.api.models import (
    Market,
    TradeSignal,
    OrderRequest,
    OrderSide,
    OrderAction,
    OrderType,
)
from src.risk.manager import RiskManager
from src.utils.helpers import (
    calculate_expected_value,
    calculate_return_on_investment,
    cents_to_dollars,
    dollars_to_cents,
    hours_until_close,
)


# ------------------------------------------------------------------ #
#                          Model Tests                                #
# ------------------------------------------------------------------ #

class TestMarketModel:
    def test_from_api(self):
        data = {
            "ticker": "KXHIGHNY-26FEB11-B45",
            "event_ticker": "KXHIGHNY-26FEB11",
            "title": "Highest temperature in NYC on Feb 11?",
            "subtitle": "45° to 46°",
            "status": "active",
            "yes_bid": 30,
            "yes_ask": 35,
            "no_bid": 65,
            "no_ask": 70,
            "last_price": 32,
            "volume": 500,
            "volume_24h": 200,
        }
        market = Market.from_api(data)
        assert market.ticker == "KXHIGHNY-26FEB11-B45"
        assert market.yes_bid == 30
        assert market.yes_ask == 35

    def test_implied_probability(self):
        market = Market(
            ticker="TEST",
            event_ticker="TEST-EVENT",
            title="Test",
            yes_bid=40,
            yes_ask=45,
        )
        prob = market.implied_probability
        assert 0.40 <= prob <= 0.45

    def test_zero_price_probability(self):
        market = Market(
            ticker="TEST",
            event_ticker="TEST-EVENT",
            title="Test",
            yes_bid=0,
            yes_ask=0,
            last_price=0,
        )
        assert market.implied_probability == 0.0


class TestOrderRequest:
    def test_to_api_payload(self):
        order = OrderRequest(
            ticker="TEST-TICKER",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            count=10,
            order_type=OrderType.LIMIT,
            yes_price=45,
            client_order_id="test-123",
        )
        payload = order.to_api_payload()
        assert payload["ticker"] == "TEST-TICKER"
        assert payload["side"] == "yes"
        assert payload["action"] == "buy"
        assert payload["count"] == 10
        assert payload["yes_price"] == 45

    def test_no_side_order(self):
        order = OrderRequest(
            ticker="TEST",
            side=OrderSide.NO,
            action=OrderAction.BUY,
            count=5,
            no_price=60,
        )
        payload = order.to_api_payload()
        assert payload["side"] == "no"
        assert payload["no_price"] == 60
        assert "yes_price" not in payload


class TestTradeSignal:
    def test_edge_calculation(self):
        signal = TradeSignal(
            ticker="TEST",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            confidence=0.7,
            estimated_probability=0.65,
            market_probability=0.50,
            expected_value=0.10,
            strategy_name="TestStrategy",
            reasoning="Test",
        )
        assert signal.edge == pytest.approx(0.15, abs=0.001)


# ------------------------------------------------------------------ #
#                       Helper Function Tests                         #
# ------------------------------------------------------------------ #

class TestHelpers:
    def test_calculate_expected_value(self):
        # 70% probability, cost 45 cents, payout $1
        ev = calculate_expected_value(0.70, 45, 100)
        assert ev == pytest.approx(25.0, abs=0.01)  # 70 - 45 = 25 cents

    def test_calculate_ev_negative(self):
        # 30% probability, cost 45 cents → negative EV
        ev = calculate_expected_value(0.30, 45, 100)
        assert ev < 0

    def test_cents_to_dollars(self):
        assert cents_to_dollars(150) == 1.50
        assert cents_to_dollars(0) == 0.0

    def test_dollars_to_cents(self):
        assert dollars_to_cents(1.50) == 150
        assert dollars_to_cents(0.01) == 1

    def test_roi(self):
        roi = calculate_return_on_investment(25, 100)
        assert roi == pytest.approx(3.0, abs=0.01)  # 300% ROI

    def test_roi_zero_cost(self):
        assert calculate_return_on_investment(0) == 0.0


# ------------------------------------------------------------------ #
#                     Risk Manager Tests                              #
# ------------------------------------------------------------------ #

class TestRiskManager:
    def setup_method(self):
        self.rm = RiskManager(
            max_daily_loss=50.0,
            max_position_size=100,
            max_trade_cost=25.0,
            max_portfolio_exposure_pct=20.0,
            kelly_fraction=0.5,
        )

    def test_kelly_criterion_positive_edge(self):
        # Probability 0.6, odds 1.0 (even money)
        # Kelly = (0.6 * 1 - 0.4) / 1 = 0.2
        # Half Kelly = 0.1
        k = self.rm.kelly_criterion(0.6, 1.0)
        assert k == pytest.approx(0.10, abs=0.01)

    def test_kelly_criterion_no_edge(self):
        # Probability 0.5, odds 1.0 → no edge
        k = self.rm.kelly_criterion(0.5, 1.0)
        assert k == pytest.approx(0.0, abs=0.01)

    def test_kelly_criterion_negative_edge(self):
        k = self.rm.kelly_criterion(0.3, 1.0)
        assert k == 0.0

    def test_validate_trade_approved(self):
        signal = TradeSignal(
            ticker="TEST",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            confidence=0.7,
            estimated_probability=0.65,
            market_probability=0.50,
            expected_value=0.10,
            strategy_name="Test",
            reasoning="Test",
        )
        valid, reason = self.rm.validate_trade(signal, balance=1000.0)
        assert valid is True

    def test_validate_trade_low_confidence(self):
        signal = TradeSignal(
            ticker="TEST",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            confidence=0.3,  # Below threshold
            estimated_probability=0.55,
            market_probability=0.50,
            expected_value=0.10,
            strategy_name="Test",
            reasoning="Test",
        )
        valid, reason = self.rm.validate_trade(signal, balance=1000.0)
        assert valid is False
        assert "Confidence" in reason

    def test_validate_trade_low_ev(self):
        signal = TradeSignal(
            ticker="TEST",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            confidence=0.7,
            estimated_probability=0.55,
            market_probability=0.50,
            expected_value=0.01,  # Below threshold
            strategy_name="Test",
            reasoning="Test",
        )
        valid, reason = self.rm.validate_trade(signal, balance=1000.0)
        assert valid is False
        assert "Expected value" in reason

    def test_position_sizing_respects_limits(self):
        signal = TradeSignal(
            ticker="TEST",
            side=OrderSide.YES,
            action=OrderAction.BUY,
            confidence=0.8,
            estimated_probability=0.70,
            market_probability=0.50,
            expected_value=0.15,
            strategy_name="Test",
            reasoning="Test",
        )
        size = self.rm.calculate_position_size(signal, balance=1000.0, cost_per_contract_cents=50)
        assert 0 < size <= 100  # Within position limit
        assert size * 0.50 <= 25.0  # Within trade cost limit

    def test_daily_loss_tracking(self):
        self.rm.record_trade("T1", 10.0, pnl=-10.0)
        self.rm.record_trade("T2", 10.0, pnl=-10.0)
        summary = self.rm.get_daily_summary()
        assert summary["realized_pnl"] == -20.0
        assert summary["trades_count"] == 2


# ------------------------------------------------------------------ #
#                     Weather Strategy Tests                          #
# ------------------------------------------------------------------ #

class TestWeatherParsing:
    """Test bracket parsing from market subtitles."""

    def test_parse_range_bracket(self):
        from src.strategies.weather import WeatherStrategy

        ws = WeatherStrategy.__new__(WeatherStrategy)
        low, high = ws._parse_bracket_from_subtitle("51° to 52°")
        assert low == 51.0
        assert high == 53.0  # exclusive upper bound

    def test_parse_lower_edge(self):
        from src.strategies.weather import WeatherStrategy

        ws = WeatherStrategy.__new__(WeatherStrategy)
        low, high = ws._parse_bracket_from_subtitle("≤ 49°")
        assert low == -999
        assert high == 50.0

    def test_parse_upper_edge(self):
        from src.strategies.weather import WeatherStrategy

        ws = WeatherStrategy.__new__(WeatherStrategy)
        low, high = ws._parse_bracket_from_subtitle("≥ 55°")
        assert low == 55.0
        assert high == 999

    def test_normal_cdf(self):
        from src.strategies.weather import WeatherStrategy

        # CDF at the mean should be 0.5
        result = WeatherStrategy._normal_cdf(50, 50, 5)
        assert result == pytest.approx(0.5, abs=0.001)

        # CDF well above mean should be close to 1.0
        result = WeatherStrategy._normal_cdf(65, 50, 5)
        assert result > 0.99


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
