# ⚡ Apex Bot — Kalshi Automated Trading Bot

Automated weather + economic market trading bot for Kalshi prediction markets.

## Features

- **Weather edge detection**: NWS ensemble forecast (daily + hourly + observation) vs Kalshi contract prices using Gaussian probability model
- **Economic market scanner**: CPI, Fed Rate, GDP, Jobs, Unemployment, PCE, TSA
- **Automated trading**: Configurable entry/exit rules with take-profit and stop-loss
- **Account linking**: RSA-PSS authenticated order placement via server-side API route (private key never touches the browser)
- **Persistent storage**: Trade log, positions, stats, and settings saved to localStorage across sessions
- **Export**: Download your trade history as JSON

## Quick Start

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

The bot works in **view-only mode** without API keys — you can scan markets and see signals, but orders won't execute.

## Linking Your Kalshi Account

1. Go to [kalshi.com/account/profile](https://kalshi.com/account/profile)
2. Scroll to **API Keys** → click **Create New API Key**
3. **Save the Private Key file** (you can't retrieve it later)
4. Note the **Key ID**
5. Create `.env.local` in the project root:

```env
NEXT_PUBLIC_KALSHI_API_KEY_ID=your-key-id-here
KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
...paste your full private key here...
-----END RSA PRIVATE KEY-----"
NEXT_PUBLIC_KALSHI_ENV=demo
```

6. Restart the dev server
7. The header will show **LIVE** and your balance when connected
8. **Start with `demo`** — change `NEXT_PUBLIC_KALSHI_ENV=prod` only when ready for real money

### How Auth Works

Your private key **never leaves the server**. The browser calls `/api/kalshi` which signs requests server-side using RSA-PSS with SHA256, then proxies them to Kalshi. This is secure for deployment.

For Vercel, add these as **Environment Variables** in your project settings.

## Deploy to Vercel

1. Push to GitHub
2. Import the repo in [vercel.com/new](https://vercel.com/new)
3. Add your environment variables in Vercel's project settings
4. Deploy — that's it

## Strategy (from research)

The bot uses proven approaches from successful Kalshi trading bots:

- **Multi-model ensemble**: NWS daily forecast (45%), hourly forecast (35%), observation trajectory (20%)
- **Gaussian CDF**: Converts ensemble + uncertainty into threshold probabilities
- **Edge detection**: Buys when model probability diverges from market price by configurable threshold
- **Maker-only**: Limit orders = $0 Kalshi fees (taker fee is 7%)
- **No longshots**: Configurable price floor avoids <10¢ contracts (60%+ capital loss historically)
- **Quarter Kelly sizing**: Configurable bet size caps exposure

## Project Structure

```
apex-bot/
├── src/
│   └── pages/
│       ├── index.js        # Main bot UI
│       └── api/
│           └── kalshi.js   # Server-side auth proxy
├── .env.example            # Environment template
├── next.config.js
└── package.json
```

## Disclaimer

This is for educational/research purposes. Trading prediction markets involves financial risk. Use demo mode first. No guarantees of profit.
