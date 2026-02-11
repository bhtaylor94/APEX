"""
Risk Management Module.

Implements:
- Kelly Criterion position sizing
- Daily loss limits
- Per-trade cost caps
- Portfolio exposure limits
- Correlation tracking
"""

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone

from src.api.models import OrderRequest, TradeSignal, OrderSide, OrderAction, OrderType

logger = logging.getLogger(__name__)


@dataclass
class DailyPnL:
    """Tracks daily profit and loss."""

    date: str = ""
    realized_pnl: float = 0.0
    unrealized_pnl: float = 0.0
    trades_count: int = 0
    wins: int = 0
    losses: int = 0

    @property
    def total_pnl(self) -> float:
        return self.realized_pnl + self.unrealized_pnl

    @property
    def win_rate(self) -> float:
        if self.trades_count == 0:
            return 0.0
        return self.wins / self.trades_count


class RiskManager:
    """
    Central risk management engine.

    Enforces all risk limits and calculates optimal position sizes
    using the Kelly Criterion (with configurable fraction for safety).
    """

    def __init__(
        self,
        max_daily_loss: float = 50.0,
        max_position_size: int = 100,
        max_trade_cost: float = 25.0,
        max_portfolio_exposure_pct: float = 20.0,
        kelly_fraction: float = 0.5,
    ):
        self.max_daily_loss = max_daily_loss
        self.max_position_size = max_position_size
        self.max_trade_cost = max_trade_cost
        self.max_portfolio_exposure_pct = max_portfolio_exposure_pct
        self.kelly_fraction = kelly_fraction

        self._daily_pnl = DailyPnL(date=self._today())
        self._open_positions: dict[str, float] = {}  # ticker -> exposure in dollars
        self._trades_today: list[dict] = []

    def _today(self) -> str:
        return datetime.now(timezone.utc).strftime("%Y-%m-%d")

    def _reset_daily_if_needed(self):
        """Reset daily counters at the start of a new day."""
        today = self._today()
        if self._daily_pnl.date != today:
            logger.info(
                f"New trading day. Yesterday P&L: ${self._daily_pnl.total_pnl:.2f} "
                f"({self._daily_pnl.trades_count} trades, "
                f"{self._daily_pnl.win_rate:.0%} win rate)"
            )
            self._daily_pnl = DailyPnL(date=today)
            self._trades_today = []

    # ------------------------------------------------------------------ #
    #                     Kelly Criterion Sizing                          #
    # ------------------------------------------------------------------ #

    def kelly_criterion(self, probability: float, odds_decimal: float) -> float:
        """
        Calculate Kelly Criterion optimal bet fraction.

        For binary contracts:
        - probability: our estimated probability of winning
        - odds_decimal: payout ratio = (payout - cost) / cost

        Kelly fraction = (p * b - q) / b
        where p = win probability, q = 1 - p, b = odds

        We use fractional Kelly (e.g., half-Kelly) for safety.
        """
        if probability <= 0 or probability >= 1 or odds_decimal <= 0:
            return 0.0

        q = 1 - probability
        kelly = (probability * odds_decimal - q) / odds_decimal

        # Never bet more than Kelly suggests, use fraction for safety
        kelly = max(0.0, kelly) * self.kelly_fraction

        return kelly

    def calculate_position_size(
        self,
        signal: TradeSignal,
        balance: float,
        cost_per_contract_cents: int,
    ) -> int:
        """
        Calculate the optimal number of contracts to trade.

        Uses Kelly Criterion with multiple safety constraints:
        1. Kelly-optimal fraction of bankroll
        2. Maximum position size limit
        3. Maximum per-trade cost limit
        4. Portfolio exposure limit
        5. Daily loss limit remaining
        """
        self._reset_daily_if_needed()

        if cost_per_contract_cents <= 0 or balance <= 0:
            return 0

        cost_per_contract = cost_per_contract_cents / 100.0

        # Calculate odds (binary contract payout is always $1.00)
        payout = 1.00
        profit_if_win = payout - cost_per_contract
        if profit_if_win <= 0:
            return 0
        odds = profit_if_win / cost_per_contract

        # Kelly-optimal fraction
        kelly_frac = self.kelly_criterion(signal.estimated_probability, odds)
        kelly_amount = balance * kelly_frac

        # Constraint 1: Kelly-optimal amount
        max_from_kelly = int(kelly_amount / cost_per_contract) if cost_per_contract > 0 else 0

        # Constraint 2: Position size limit
        max_from_position = self.max_position_size

        # Constraint 3: Per-trade cost limit
        max_from_cost = int(self.max_trade_cost / cost_per_contract) if cost_per_contract > 0 else 0

        # Constraint 4: Portfolio exposure limit
        current_exposure = sum(self._open_positions.values())
        max_exposure = balance * (self.max_portfolio_exposure_pct / 100.0)
        remaining_exposure = max(0, max_exposure - current_exposure)
        max_from_exposure = int(remaining_exposure / cost_per_contract) if cost_per_contract > 0 else 0

        # Constraint 5: Daily loss limit remaining
        remaining_daily = max(0, self.max_daily_loss - abs(min(0, self._daily_pnl.total_pnl)))
        max_from_daily = int(remaining_daily / cost_per_contract) if cost_per_contract > 0 else 0

        # Take the minimum of all constraints
        size = min(
            max_from_kelly,
            max_from_position,
            max_from_cost,
            max_from_exposure,
            max_from_daily,
        )

        size = max(0, size)

        logger.debug(
            f"Position sizing for {signal.ticker}: "
            f"kelly={max_from_kelly}, pos_limit={max_from_position}, "
            f"cost_limit={max_from_cost}, exposure_limit={max_from_exposure}, "
            f"daily_limit={max_from_daily} → size={size}"
        )

        return size

    # ------------------------------------------------------------------ #
    #                     Trade Validation                                #
    # ------------------------------------------------------------------ #

    def validate_trade(
        self,
        signal: TradeSignal,
        balance: float,
        min_confidence: float = 0.55,
        min_ev: float = 0.05,
    ) -> tuple[bool, str]:
        """
        Validate whether a trade should be executed.

        Returns (is_valid, reason).
        """
        self._reset_daily_if_needed()

        # Check if we've hit the daily loss limit
        if self._daily_pnl.total_pnl <= -self.max_daily_loss:
            return False, f"Daily loss limit reached (${self._daily_pnl.total_pnl:.2f})"

        # Check confidence threshold
        if signal.confidence < min_confidence:
            return False, f"Confidence too low ({signal.confidence:.2f} < {min_confidence})"

        # Check expected value threshold
        if signal.expected_value < min_ev:
            return False, f"Expected value too low ({signal.expected_value:.4f} < {min_ev})"

        # Check balance
        if balance <= 0:
            return False, "Insufficient balance"

        # Check portfolio exposure
        current_exposure = sum(self._open_positions.values())
        max_exposure = balance * (self.max_portfolio_exposure_pct / 100.0)
        if current_exposure >= max_exposure:
            return False, f"Portfolio exposure limit reached (${current_exposure:.2f} >= ${max_exposure:.2f})"

        return True, "Trade approved"

    # ------------------------------------------------------------------ #
    #                     Order Construction                              #
    # ------------------------------------------------------------------ #

    def build_order(
        self,
        signal: TradeSignal,
        balance: float,
    ) -> OrderRequest | None:
        """
        Build an order from a trade signal, with proper sizing and limits.

        Returns None if the trade should not be executed.
        """
        # Determine cost per contract in cents
        if signal.side == OrderSide.YES:
            cost_cents = signal.suggested_price or int(signal.market_probability * 100)
        else:
            cost_cents = signal.suggested_price or int((1 - signal.market_probability) * 100)

        if cost_cents <= 0 or cost_cents >= 100:
            return None

        # Calculate position size
        count = self.calculate_position_size(signal, balance, cost_cents)
        if count <= 0:
            return None

        # Build order
        order = OrderRequest(
            ticker=signal.ticker,
            side=signal.side,
            action=signal.action,
            count=count,
            order_type=OrderType.LIMIT,
            yes_price=cost_cents if signal.side == OrderSide.YES else None,
            no_price=cost_cents if signal.side == OrderSide.NO else None,
            time_in_force="gtc",
            post_only=True,  # Avoid taker fees; act as market maker
        )

        return order

    # ------------------------------------------------------------------ #
    #                     Position Tracking                               #
    # ------------------------------------------------------------------ #

    def record_trade(self, ticker: str, cost_dollars: float, pnl: float = 0.0):
        """Record a completed trade for tracking."""
        self._reset_daily_if_needed()
        self._daily_pnl.trades_count += 1
        self._daily_pnl.realized_pnl += pnl
        if pnl > 0:
            self._daily_pnl.wins += 1
        elif pnl < 0:
            self._daily_pnl.losses += 1

        # Update exposure
        self._open_positions[ticker] = self._open_positions.get(ticker, 0) + cost_dollars
        self._trades_today.append({
            "ticker": ticker,
            "cost": cost_dollars,
            "pnl": pnl,
            "time": datetime.now(timezone.utc).isoformat(),
        })

    def update_position(self, ticker: str, exposure_dollars: float):
        """Update tracked exposure for a position."""
        if exposure_dollars <= 0:
            self._open_positions.pop(ticker, None)
        else:
            self._open_positions[ticker] = exposure_dollars

    def get_daily_summary(self) -> dict:
        """Get a summary of today's trading activity."""
        self._reset_daily_if_needed()
        return {
            "date": self._daily_pnl.date,
            "realized_pnl": self._daily_pnl.realized_pnl,
            "trades_count": self._daily_pnl.trades_count,
            "win_rate": self._daily_pnl.win_rate,
            "total_exposure": sum(self._open_positions.values()),
            "open_positions": len(self._open_positions),
            "remaining_daily_loss_budget": self.max_daily_loss + self._daily_pnl.total_pnl,
        }
