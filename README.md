# Apex BTC Bot — Autonomous Kalshi BTC Trader

Autonomous trading bot that monitors live BTC price data, generates technical signals, and executes trades on Kalshi's BTC "Up or Down" 15-minute prediction markets.

## How It Works

1. **BTC Price Feed** — Pulls 1-minute candles from Binance every 10 seconds
2. **Signal Engine** — 6 weighted technical indicators:
   - RSI (20%) — mean reversion at overbought/oversold
   - MACD (20%) — trend momentum
   - Short-term Momentum (25%) — 5-period rate of change
   - Bollinger Bands (15%) — mean reversion at band extremes
   - Volume-Weighted Momentum (10%) — volume-confirmed moves
   - MA Crossover (10%) — SMA5 vs SMA20 trend
3. **Market Scanner** — Finds open BTC "Up or Down" markets on Kalshi
4. **Edge Calculator** — Compares predicted probability vs. market price
5. **Auto-Executor** — Places fill-or-kill limit orders when edge exceeds threshold
6. **Risk Management** — Quarter-Kelly sizing, position limits, hourly rate limits

## Setup

### 1. Your Vercel env vars should already be set:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_KALSHI_API_KEY_ID` | Your Kalshi API Key ID |
| `KALSHI_PRIVATE_KEY` | Your RSA private key (full PEM) |
| `NEXT_PUBLIC_KALSHI_ENV` | `prod` |

These are the **same env vars** from Apex Bot — no changes needed.

### 2. Deploy

```bash
# Push to GitHub
git init
git add .
git commit -m "Apex BTC Bot"
git remote add origin https://github.com/YOUR_USER/apex-btc-bot.git
git push -u origin main

# Then import in Vercel — it will pick up your existing env vars
# if you link to the same Vercel project, or copy them to a new one
```

### 3. Use

1. Open the deployed URL
2. Verify "CONNECTED" status and your balance shows
3. Adjust configuration sliders (start conservative):
   - Min Confidence: 45%+
   - Min Edge: 5¢+
   - Max Contracts: 10 (start low)
   - Max Cost/Trade: $10 (start low)
   - Max Trades/Hr: 5
4. Click **START BOT**
5. Monitor the activity log

## Architecture

```
src/
├── lib/
│   ├── kalshi.js          # Server-side Kalshi API client (RSA-PSS auth)
│   ├── btc-engine.js      # Technical indicators & signal generation
│   └── strategy.js        # Trading strategy & position sizing
├── pages/
│   ├── api/
│   │   ├── kalshi/
│   │   │   ├── balance.js    # GET /api/kalshi/balance
│   │   │   ├── markets.js    # GET /api/kalshi/markets
│   │   │   ├── order.js      # POST /api/kalshi/order
│   │   │   ├── positions.js  # GET /api/kalshi/positions
│   │   │   └── settlements.js # GET /api/kalshi/settlements
│   │   └── btc-price.js      # GET /api/btc-price (Binance proxy)
│   ├── _app.js
│   └── index.js              # Main dashboard
└── styles/
    └── globals.css
```

**Security:** Your private key never leaves the server. All Kalshi API signing happens in the `/api/kalshi/*` serverless functions. The browser only communicates with your own API routes.

## Risk Warning

This bot trades real money on Kalshi. Start with small position sizes and monitor closely. Trading prediction markets involves risk of loss. Past performance does not guarantee future results.
