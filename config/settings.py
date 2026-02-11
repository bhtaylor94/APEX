"""
Configuration management for the Kalshi Trading Bot.
Loads settings from environment variables / .env file.
"""

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


# Kalshi API base URLs
API_URLS = {
    "demo": "https://demo-api.kalshi.co/trade-api/v2",
    "prod": "https://api.elections.kalshi.com/trade-api/v2",
}

# Weather series tickers mapped to city names and NWS stations
WEATHER_CONFIG = {
    "KXHIGHNY": {
        "city": "New York City",
        "station": "KNYC",  # Central Park
        "nws_office": "OKX",
        "lat": 40.7829,
        "lon": -73.9654,
    },
    "KXHIGHCHI": {
        "city": "Chicago",
        "station": "KMDW",  # Midway Airport
        "nws_office": "LOT",
        "lat": 41.7868,
        "lon": -87.7522,
    },
    "KXHIGHMIA": {
        "city": "Miami",
        "station": "KMIA",  # Miami International Airport
        "nws_office": "MFL",
        "lat": 25.7959,
        "lon": -80.2870,
    },
    "KXHIGHAUS": {
        "city": "Austin",
        "station": "KAUS",  # Austin-Bergstrom International Airport
        "nws_office": "EWX",
        "lat": 30.1945,
        "lon": -97.6699,
    },
}

# Known economic series tickers and their data sources
ECONOMIC_CONFIG = {
    "CPI": {
        "name": "Consumer Price Index",
        "source": "Bureau of Labor Statistics",
        "frequency": "monthly",
    },
    "JOBS": {
        "name": "Nonfarm Payrolls",
        "source": "Bureau of Labor Statistics",
        "frequency": "monthly",
    },
    "FED": {
        "name": "Federal Funds Rate Decision",
        "source": "Federal Reserve",
        "frequency": "8x_yearly",
    },
    "GDP": {
        "name": "GDP Growth Rate",
        "source": "Bureau of Economic Analysis",
        "frequency": "quarterly",
    },
    "SP500": {
        "name": "S&P 500 Daily Close",
        "source": "NYSE",
        "frequency": "daily",
    },
}


@dataclass
class Settings:
    """Application settings loaded from environment variables."""

    # API
    kalshi_api_key: str = ""
    kalshi_private_key_path: str = ""
    kalshi_env: str = "demo"

    # Trading mode
    dry_run: bool = True
    trade_categories: list[str] = field(default_factory=lambda: ["weather", "economic"])

    # Risk management
    max_daily_loss: float = 50.0
    max_position_size: int = 100
    max_trade_cost: float = 25.0
    max_portfolio_exposure_pct: float = 20.0
    kelly_fraction: float = 0.5

    # Strategy
    min_expected_value: float = 0.05
    min_confidence: float = 0.55
    min_market_volume: int = 50
    max_hours_to_close: int = 48

    # Weather
    weather_series_tickers: list[str] = field(
        default_factory=lambda: ["KXHIGHNY", "KXHIGHCHI", "KXHIGHMIA", "KXHIGHAUS"]
    )

    # Economic
    economic_series_tickers: list[str] = field(
        default_factory=lambda: ["KXCPI", "KXJOBS", "KXFED", "KXGDP", "KXSP500"]
    )

    # Scheduling
    scan_interval: int = 60
    trading_start_hour: int = 10
    trading_end_hour: int = 23

    # Logging
    log_level: str = "INFO"
    log_file: str = "./logs/trading_bot.log"

    @property
    def api_base_url(self) -> str:
        return API_URLS.get(self.kalshi_env, API_URLS["demo"])

    @property
    def is_production(self) -> bool:
        return self.kalshi_env == "prod"

    @classmethod
    def from_env(cls) -> "Settings":
        """Load settings from environment variables."""
        categories = os.getenv("TRADE_CATEGORIES", "weather,economic")
        weather_tickers = os.getenv(
            "WEATHER_SERIES_TICKERS", "KXHIGHNY,KXHIGHCHI,KXHIGHMIA,KXHIGHAUS"
        )
        econ_tickers = os.getenv("ECONOMIC_SERIES_TICKERS", "KXCPI,KXJOBS,KXFED,KXGDP,KXSP500")

        return cls(
            kalshi_api_key=os.getenv("KALSHI_API_KEY", ""),
            kalshi_private_key_path=os.getenv("KALSHI_PRIVATE_KEY_PATH", ""),
            kalshi_env=os.getenv("KALSHI_ENV", "demo"),
            dry_run=os.getenv("DRY_RUN", "true").lower() == "true",
            trade_categories=[c.strip() for c in categories.split(",")],
            max_daily_loss=float(os.getenv("MAX_DAILY_LOSS", "50.0")),
            max_position_size=int(os.getenv("MAX_POSITION_SIZE", "100")),
            max_trade_cost=float(os.getenv("MAX_TRADE_COST", "25.0")),
            max_portfolio_exposure_pct=float(os.getenv("MAX_PORTFOLIO_EXPOSURE_PCT", "20.0")),
            kelly_fraction=float(os.getenv("KELLY_FRACTION", "0.5")),
            min_expected_value=float(os.getenv("MIN_EXPECTED_VALUE", "0.05")),
            min_confidence=float(os.getenv("MIN_CONFIDENCE", "0.55")),
            min_market_volume=int(os.getenv("MIN_MARKET_VOLUME", "50")),
            max_hours_to_close=int(os.getenv("MAX_HOURS_TO_CLOSE", "48")),
            weather_series_tickers=[t.strip() for t in weather_tickers.split(",")],
            economic_series_tickers=[t.strip() for t in econ_tickers.split(",")],
            scan_interval=int(os.getenv("SCAN_INTERVAL", "60")),
            trading_start_hour=int(os.getenv("TRADING_START_HOUR", "10")),
            trading_end_hour=int(os.getenv("TRADING_END_HOUR", "23")),
            log_level=os.getenv("LOG_LEVEL", "INFO"),
            log_file=os.getenv("LOG_FILE", "./logs/trading_bot.log"),
        )
