#!/usr/bin/env python3
"""
Kalshi Weather & Economic Data Trading Bot — Main Entry Point.

Usage:
    python main.py                      # Dry run (paper trading)
    python main.py --live               # Live trading (real money!)
    python main.py --scan-only          # Scan markets without trading
    python main.py --categories weather # Trade only weather markets
    python main.py --once               # Run one cycle and exit
"""

import argparse
import logging
import signal
import sys
import time
from datetime import datetime, timezone

from config.settings import Settings
from src.api.client import KalshiClient, KalshiAPIError
from src.strategies.weather import WeatherStrategy
from src.strategies.economic import EconomicStrategy
from src.risk.manager import RiskManager
from src.utils.logger import setup_logger, log_trade_signal, log_order_result
from src.utils.helpers import format_market_summary

# Global flag for graceful shutdown
_running = True


def signal_handler(signum, frame):
    global _running
    _running = False
    print("\nShutting down gracefully...")


signal.signal(signal.SIGINT, signal_handler)
signal.signal(signal.SIGTERM, signal_handler)


def display_connection_status(client: KalshiClient, settings: Settings, logger: logging.Logger) -> bool:
    """
    Verify connection to Kalshi and display account status dashboard.
    Returns True if connected successfully, False otherwise.
    """
    border = "═" * 58
    logger.info("")
    logger.info(f"╔{border}╗")
    logger.info(f"║{'CONNECTION STATUS':^58}║")
    logger.info(f"╠{border}╣")

    # 1. Check exchange status
    try:
        status = client.get_exchange_status()
        exchange_active = status.get("exchange_active", False)
        trading_active = status.get("trading_active", False)
        ex_icon = "✅" if exchange_active else "❌"
        tr_icon = "✅" if trading_active else "⏸️ "
        logger.info(f"║  Exchange Status:   {ex_icon} {'ONLINE' if exchange_active else 'OFFLINE':<35}║")
        logger.info(f"║  Trading Status:    {tr_icon} {'ACTIVE' if trading_active else 'PAUSED':<35}║")
    except Exception as e:
        logger.info(f"║  Exchange Status:   ❌ ERROR: {str(e)[:28]:<35}║")
        logger.info(f"╚{border}╝")
        return False

    # 2. Check authentication & balance
    try:
        balance = client.get_balance()
        logger.info(f"║  Authentication:    ✅ {'CONNECTED':<35}║")
        logger.info(f"║  Account Balance:   💰 ${balance:<34.2f}║")
    except Exception as e:
        err_msg = str(e)[:30]
        logger.info(f"║  Authentication:    ❌ FAILED — {err_msg:<25}║")
        logger.info(f"║  Account Balance:   ⚠️  UNAVAILABLE{'':<22}║")
        logger.info(f"╠{border}╣")
        logger.info(f"║  {'Check KALSHI_API_KEY and KALSHI_PRIVATE_KEY_PATH':^56}  ║")
        logger.info(f"╚{border}╝")
        return False

    # 3. Check open positions
    try:
        positions = client.get_all_positions()
        open_count = len(positions)
        total_exposure = sum(abs(p.market_exposure) for p in positions) / 100.0
        logger.info(f"║  Open Positions:    📊 {open_count} position(s){'':<23}║")
        logger.info(f"║  Total Exposure:    📈 ${total_exposure:<34.2f}║")
    except Exception:
        logger.info(f"║  Open Positions:    ⚠️  Could not fetch{'':<19}║")

    # 4. Environment info
    logger.info(f"╠{border}╣")
    env_label = "🔴 PRODUCTION" if settings.is_production else "🟢 DEMO"
    mode_label = "📋 DRY RUN (paper)" if settings.dry_run else "🔴 LIVE TRADING"
    logger.info(f"║  Environment:       {env_label:<38}║")
    logger.info(f"║  Trading Mode:      {mode_label:<38}║")
    logger.info(f"║  API Endpoint:      {settings.api_base_url[:38]:<38}║")
    logger.info(f"║  Categories:        {', '.join(settings.trade_categories):<38}║")
    logger.info(f"║  Max Daily Loss:    ${settings.max_daily_loss:<37.2f}║")
    logger.info(f"║  Kelly Fraction:    {settings.kelly_fraction:<38}║")
    logger.info(f"╚{border}╝")
    logger.info("")

    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Kalshi Weather & Economic Trading Bot")
    parser.add_argument(
        "--live",
        action="store_true",
        help="Enable live trading (overrides DRY_RUN=true in .env)",
    )
    parser.add_argument(
        "--scan-only",
        action="store_true",
        help="Only scan markets, do not place any orders",
    )
    parser.add_argument(
        "--categories",
        nargs="+",
        choices=["weather", "economic"],
        help="Categories to trade (default: from .env)",
    )
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run a single scan cycle and exit",
    )
    parser.add_argument(
        "--status",
        action="store_true",
        help="Show connection status and account info, then exit",
    )
    return parser.parse_args()


def create_strategies(
    client: KalshiClient,
    settings: Settings,
    categories: list[str],
) -> list:
    """Instantiate the requested trading strategies."""
    strategies = []

    if "weather" in categories:
        strategies.append(
            WeatherStrategy(
                client=client,
                series_tickers=settings.weather_series_tickers,
                max_hours_to_close=settings.max_hours_to_close,
                min_volume=settings.min_market_volume,
            )
        )

    if "economic" in categories:
        strategies.append(
            EconomicStrategy(
                client=client,
                series_tickers=settings.economic_series_tickers,
                max_hours_to_close=settings.max_hours_to_close,
                min_volume=settings.min_market_volume,
            )
        )

    return strategies


def run_trading_cycle(
    client: KalshiClient,
    strategies: list,
    risk_manager: RiskManager,
    settings: Settings,
    scan_only: bool = False,
    logger: logging.Logger = None,
) -> int:
    """
    Execute one complete trading cycle:
    1. Check exchange status
    2. Get account balance
    3. Run each strategy to generate signals
    4. Validate signals through risk management
    5. Execute approved trades (or log in dry run)

    Returns the number of trades executed (or would-have-been in dry run).
    """
    if logger is None:
        logger = logging.getLogger(__name__)

    trades_executed = 0

    # Step 1: Check exchange status
    try:
        status = client.get_exchange_status()
        trading_active = status.get("trading_active", False)
        exchange_active = status.get("exchange_active", False)
        if not exchange_active:
            logger.warning("Exchange is not active. Skipping cycle.")
            return 0
        if not trading_active:
            logger.info("Trading is paused. Monitoring only.")
            if not scan_only:
                scan_only = True
    except KalshiAPIError as e:
        logger.error(f"Could not check exchange status: {e}")
        # Continue anyway for market scanning

    # Step 2: Get account balance
    balance = 0.0
    try:
        balance = client.get_balance()
        logger.info(f"Account balance: ${balance:.2f}")
    except KalshiAPIError as e:
        logger.warning(f"Could not fetch balance: {e}. Using $0 (scan-only mode).")
        scan_only = True

    # Step 3: Run strategies
    all_signals = []
    for strategy in strategies:
        try:
            signals = strategy.run()
            all_signals.extend(signals)
        except Exception as e:
            logger.error(f"Strategy {strategy.name} failed: {e}", exc_info=True)

    if not all_signals:
        logger.info("No trade signals generated this cycle.")
        return 0

    # Sort signals by expected value (best opportunities first)
    all_signals.sort(key=lambda s: s.expected_value, reverse=True)

    logger.info(f"Generated {len(all_signals)} trade signals. Processing...")

    # Step 4 & 5: Validate and execute
    for signal in all_signals:
        log_trade_signal(logger, signal)

        if scan_only:
            logger.info(f"[SCAN ONLY] Would trade: {signal.ticker} {signal.side.value}")
            trades_executed += 1
            continue

        # Validate through risk manager
        is_valid, reason = risk_manager.validate_trade(
            signal,
            balance,
            min_confidence=settings.min_confidence,
            min_ev=settings.min_expected_value,
        )

        if not is_valid:
            logger.info(f"Trade rejected: {signal.ticker} — {reason}")
            continue

        # Build the order
        order = risk_manager.build_order(signal, balance)
        if order is None:
            logger.info(f"Order construction returned None for {signal.ticker}")
            continue

        # Execute or simulate
        if settings.dry_run:
            # Dry run — log what we would do
            logger.info(
                f"[DRY RUN] Would place order: {order.ticker} "
                f"{order.side.value} {order.action.value} "
                f"x{order.count} @ {order.yes_price or order.no_price}¢"
            )
            log_order_result(
                logger,
                {"ticker": order.ticker, "status": "dry_run", "side": order.side.value,
                 "yes_price": order.yes_price, "order_id": "DRY-RUN"},
                dry_run=True,
            )
            trades_executed += 1
        else:
            # LIVE TRADING
            try:
                result = client.create_order(order)
                log_order_result(logger, result)
                cost = (order.yes_price or order.no_price or 0) * order.count / 100.0
                risk_manager.record_trade(order.ticker, cost)
                trades_executed += 1
                # Update balance
                balance = client.get_balance()
            except KalshiAPIError as e:
                logger.error(f"Order failed for {order.ticker}: {e}")

    return trades_executed


def main():
    args = parse_args()
    settings = Settings.from_env()

    # Override settings from CLI
    if args.live:
        settings.dry_run = False
    if args.categories:
        settings.trade_categories = args.categories

    # Setup logging
    logger = setup_logger(settings.log_level, settings.log_file)

    # Banner
    logger.info("=" * 60)
    logger.info("  Kalshi Weather & Economic Trading Bot")
    logger.info(f"  Environment: {settings.kalshi_env.upper()}")
    logger.info(f"  Mode: {'DRY RUN' if settings.dry_run else '🔴 LIVE TRADING'}")
    logger.info(f"  Categories: {', '.join(settings.trade_categories)}")
    logger.info(f"  Max Daily Loss: ${settings.max_daily_loss}")
    logger.info(f"  Scan Interval: {settings.scan_interval}s")
    logger.info("=" * 60)

    # Safety check for live trading
    if not settings.dry_run and settings.is_production:
        logger.warning("⚠️  LIVE TRADING ON PRODUCTION ENVIRONMENT ⚠️")
        logger.warning("You have 5 seconds to press Ctrl+C to abort...")
        time.sleep(5)
        if not _running:
            sys.exit(0)

    # Validate credentials
    if not settings.kalshi_api_key:
        logger.error("KALSHI_API_KEY not set. Please configure your .env file.")
        sys.exit(1)
    if not settings.kalshi_private_key_path:
        logger.error("KALSHI_PRIVATE_KEY_PATH not set. Please configure your .env file.")
        sys.exit(1)

    # Initialize client
    try:
        client = KalshiClient(
            api_key=settings.kalshi_api_key,
            private_key_path=settings.kalshi_private_key_path,
            base_url=settings.api_base_url,
        )
        logger.info(f"Connected to Kalshi API at {settings.api_base_url}")
    except Exception as e:
        logger.error(f"Failed to initialize Kalshi client: {e}")
        sys.exit(1)

    # Display connection status dashboard
    connected = display_connection_status(client, settings, logger)

    if args.status:
        # --status flag: show status and exit
        sys.exit(0 if connected else 1)

    if not connected:
        logger.error("Could not connect to Kalshi. Fix your credentials and try again.")
        sys.exit(1)

    # Initialize risk manager
    risk_manager = RiskManager(
        max_daily_loss=settings.max_daily_loss,
        max_position_size=settings.max_position_size,
        max_trade_cost=settings.max_trade_cost,
        max_portfolio_exposure_pct=settings.max_portfolio_exposure_pct,
        kelly_fraction=settings.kelly_fraction,
    )

    # Initialize strategies
    strategies = create_strategies(client, settings, settings.trade_categories)
    if not strategies:
        logger.error("No strategies configured. Check TRADE_CATEGORIES in .env")
        sys.exit(1)

    logger.info(f"Loaded {len(strategies)} strategies: {[s.name for s in strategies]}")

    # Main loop
    cycle = 0
    while _running:
        cycle += 1
        now = datetime.now(timezone.utc)

        # Check trading hours
        if not (settings.trading_start_hour <= now.hour < settings.trading_end_hour):
            logger.debug(f"Outside trading hours ({settings.trading_start_hour}-{settings.trading_end_hour} UTC). Sleeping...")
            if args.once:
                break
            time.sleep(60)
            continue

        logger.info(f"--- Cycle {cycle} @ {now.strftime('%Y-%m-%d %H:%M:%S UTC')} ---")

        try:
            trades = run_trading_cycle(
                client=client,
                strategies=strategies,
                risk_manager=risk_manager,
                settings=settings,
                scan_only=args.scan_only,
                logger=logger,
            )

            # Log daily summary
            summary = risk_manager.get_daily_summary()
            logger.info(
                f"Cycle complete: {trades} trades | "
                f"Daily P&L: ${summary['realized_pnl']:.2f} | "
                f"Positions: {summary['open_positions']} | "
                f"Remaining budget: ${summary['remaining_daily_loss_budget']:.2f}"
            )

        except Exception as e:
            logger.error(f"Cycle {cycle} failed: {e}", exc_info=True)

        if args.once:
            break

        # Sleep until next cycle
        logger.debug(f"Sleeping {settings.scan_interval}s until next cycle...")
        for _ in range(settings.scan_interval):
            if not _running:
                break
            time.sleep(1)

    logger.info("Bot stopped. Final daily summary:")
    summary = risk_manager.get_daily_summary()
    for key, value in summary.items():
        logger.info(f"  {key}: {value}")


if __name__ == "__main__":
    main()
