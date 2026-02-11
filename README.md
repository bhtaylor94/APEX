# Kalshi Weather & Economic Data Trading Bot

An automated trading bot for [Kalshi](https://kalshi.com) prediction markets, specializing in **weather** and **economic data** contracts. Built with robust risk management, real-time data feeds, and proven strategies from successful Kalshi traders.

## Features

- **Weather Market Trading** — Trades daily temperature markets (NYC, Chicago, Miami, Austin) using NWS forecasts, multiple weather models, and real-time observation data
- **Economic Data Trading** — Trades CPI, jobs reports, Fed rate decisions, GDP, and S&P 500 markets using economic calendars and consensus data
- **RSA-Signed API Authentication** — Secure request signing per Kalshi's API v2 spec
- **Multi-Strategy Engine** — Forecast divergence, expected value, arbitrage detection, and mean reversion
- **Kelly Criterion Position Sizing** — Mathematically optimal bet sizing based on edge and confidence
- **Risk Management** — Daily loss limits, per-trade caps, portfolio exposure limits, and correlation tracking
- **Rate Limit Compliance** — Built-in throttling respecting Kalshi's tiered rate limits (Basic: 20r/10w per second)
- **Dry Run Mode** — Paper trade to test strategies before going live
- **Comprehensive Logging** — Full audit trail of every decision, order, and market scan
- **GitHub Actions CI/CD** — Automated testing, linting, and optional scheduled deployment

## Architecture

```
kalshi-trading-bot/
├── src/
│   ├── api/                  # Kalshi API client & authentication
│   │   ├── client.py         # Core REST client with RSA signing
│   │   ├── auth.py           # Authentication & signature generation
│   │   └── models.py         # Data models for API responses
│   ├── strategies/           # Trading strategies
│   │   ├── base.py           # Abstract base strategy
│   │   ├── weather.py        # Weather market strategies
│   │   └── economic.py       # Economic data strategies
│   ├── data_feeds/           # External data sources
│   │   ├── nws.py            # National Weather Service forecasts
│   │   └── economic.py       # Economic calendar & consensus data
│   ├── risk/                 # Risk management
│   │   └── manager.py        # Position sizing, limits, exposure
│   └── utils/                # Utilities
│       ├── logger.py         # Structured logging
│       └── helpers.py        # Common helpers
├── config/
│   └── settings.py           # Configuration management
├── tests/                    # Unit & integration tests
├── .github/workflows/        # CI/CD pipelines
├── main.py                   # Entry point
├── requirements.txt          # Dependencies
└── .env.example              # Environment variable template
```

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/YOUR_USERNAME/kalshi-trading-bot.git
cd kalshi-trading-bot
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

### 2. Configure

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required environment variables:
| Variable | Description |
|---|---|
| `KALSHI_API_KEY` | Your Kalshi API Key ID |
| `KALSHI_PRIVATE_KEY_PATH` | Path to your RSA private key `.pem` file |
| `KALSHI_ENV` | `demo` or `prod` (default: `demo`) |
| `MAX_DAILY_LOSS` | Maximum daily loss in dollars (default: `50`) |
| `MAX_POSITION_SIZE` | Max contracts per position (default: `100`) |
| `DRY_RUN` | `true` for paper trading (default: `true`) |

### 3. Run

```bash
# Check connection & account status
python main.py --status

# Dry run (paper trading) — ALWAYS start here
python main.py

# Live trading (use with extreme caution)
python main.py --live

# Scan markets only (no trading)
python main.py --scan-only

# Trade specific categories
python main.py --categories weather economic
```

### Connection Status Dashboard

Run `python main.py --status` to verify your API keys are working. You'll see:

```
╔══════════════════════════════════════════════════════════╗
║                    CONNECTION STATUS                     ║
╠══════════════════════════════════════════════════════════╣
║  Exchange Status:   ✅ ONLINE                            ║
║  Trading Status:    ✅ ACTIVE                            ║
║  Authentication:    ✅ CONNECTED                         ║
║  Account Balance:   💰 $247.50                           ║
║  Open Positions:    📊 3 position(s)                     ║
║  Total Exposure:    📈 $42.00                            ║
╠══════════════════════════════════════════════════════════╣
║  Environment:       🟢 DEMO                              ║
║  Trading Mode:      📋 DRY RUN (paper)                   ║
║  API Endpoint:      https://demo-api.kalshi.co/trade-... ║
║  Categories:        weather, economic                    ║
║  Max Daily Loss:    $50.00                               ║
║  Kelly Fraction:    0.5                                  ║
╚══════════════════════════════════════════════════════════╝
```

## Trading Strategies

### Weather Markets

Based on strategies used by [successful Kalshi weather traders](https://news.kalshi.com/p/trading-the-weather):

1. **Forecast Divergence** — Compares NWS point forecasts against multiple weather models (GFS, ECMWF, NAM, HRRR). When models diverge from the consensus, identifies brackets where the market is mispricing probability.

2. **Observation Momentum** — Monitors real-time temperature observations throughout the day. If temps are running hotter/colder than forecast, buys cheap contracts in adjacent brackets before the market adjusts.

3. **Edge Bracket Value** — Targets the outer brackets that traders tend to undervalue. When conditions support outlier temperatures (haze, cloud breaks, cold fronts), buys edge contracts at 1-5¢ for asymmetric payoffs.

4. **Settlement Source Alignment** — Ensures all trades align with the actual NWS Daily Climate Report resolution source (Central Park, Midway Airport, MIA, Austin-Bergstrom).

### Economic Data Markets

1. **Consensus Deviation** — Compares market-implied probabilities against economic consensus forecasts. When Kalshi pricing diverges significantly from Bloomberg/Reuters consensus, takes the side with better expected value.

2. **Leading Indicator Signals** — Uses leading economic indicators to predict surprises in lagging data (e.g., initial claims → jobs report, PMI → GDP).

3. **Fed Watch Arbitrage** — Compares Kalshi Fed rate decision pricing against the CME FedWatch Tool. Exploits pricing differences between the two markets.

4. **Calendar Drift** — Trades the tendency for economic markets to drift toward consensus as the release date approaches, then mean-revert on surprises.

## Risk Management

- **Kelly Criterion** — Optimal position sizing based on estimated edge
- **Half-Kelly Default** — Uses half-Kelly for safety margin
- **Daily Loss Limit** — Auto-stops trading when daily P&L hits the configured limit
- **Per-Trade Cap** — No single trade exceeds configured maximum
- **Correlation Limits** — Prevents over-concentration in correlated markets
- **Portfolio Exposure** — Caps total outstanding risk at a percentage of account balance

## Important Disclaimers

> **⚠️ FINANCIAL RISK WARNING**: Trading prediction markets involves significant financial risk. You may lose some or all of your invested capital. This bot is provided for **educational and research purposes only**.
>
> **No Financial Advice**: This software does not provide financial advice. All trading decisions are made by automated algorithms and should not be considered investment recommendations.
>
> **Use at Your Own Risk**: By using this software, you acknowledge that you understand the risks and are solely responsible for any trading decisions and their outcomes.
>
> **Start with Demo**: Always test in Kalshi's demo environment first. Use the `DRY_RUN=true` setting before committing real funds.

## License

MIT License — see [LICENSE](LICENSE) for details.
