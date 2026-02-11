"""
Structured logging for the trading bot.
"""

import logging
import os
import sys
from datetime import datetime


def setup_logger(log_level: str = "INFO", log_file: str = "./logs/trading_bot.log") -> logging.Logger:
    """Configure the application-wide logger with file and console handlers."""

    # Ensure log directory exists
    log_dir = os.path.dirname(log_file)
    if log_dir:
        os.makedirs(log_dir, exist_ok=True)

    logger = logging.getLogger("kalshi_bot")
    logger.setLevel(getattr(logging, log_level.upper(), logging.INFO))

    # Prevent duplicate handlers if called multiple times
    if logger.handlers:
        return logger

    # Formatter
    fmt = logging.Formatter(
        "[%(asctime)s] %(levelname)-8s %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    # Console handler
    console = logging.StreamHandler(sys.stdout)
    console.setFormatter(fmt)
    logger.addHandler(console)

    # File handler
    try:
        file_handler = logging.FileHandler(log_file, mode="a")
        file_handler.setFormatter(fmt)
        logger.addHandler(file_handler)
    except OSError:
        logger.warning(f"Could not create log file at {log_file}. Logging to console only.")

    return logger


def log_trade_signal(logger: logging.Logger, signal) -> None:
    """Log a trade signal with all relevant details."""
    logger.info(
        f"SIGNAL | {signal.strategy_name} | {signal.ticker} | "
        f"{signal.side.value} {signal.action.value} | "
        f"confidence={signal.confidence:.2f} | "
        f"est_prob={signal.estimated_probability:.3f} | "
        f"mkt_prob={signal.market_probability:.3f} | "
        f"EV={signal.expected_value:.4f} | "
        f"{signal.reasoning}"
    )


def log_order_result(logger: logging.Logger, order_result: dict, dry_run: bool = False) -> None:
    """Log the result of an order submission."""
    prefix = "[DRY RUN] " if dry_run else ""
    logger.info(
        f"{prefix}ORDER | {order_result.get('ticker', 'N/A')} | "
        f"status={order_result.get('status', 'N/A')} | "
        f"order_id={order_result.get('order_id', 'N/A')} | "
        f"side={order_result.get('side', 'N/A')} | "
        f"price={order_result.get('yes_price', 'N/A')}¢"
    )
