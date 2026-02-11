# APEX — Kalshi Trading Bot

Automated trading bot for [Kalshi](https://kalshi.com) prediction markets, specializing in **weather** and **economic data** contracts. Deploys to Vercel with a live dashboard showing account connection status, balance, positions, and trade signals.

## Features

- **Live Dashboard** — Real-time connection status, account balance, open positions, and trade signals
- **Weather Trading** — Trades daily high temperature markets (NYC, Chicago, Miami, Austin) using NWS forecast data
- **Economic Trading** — Trades CPI, jobs reports, Fed rate, GDP, and S&P 500 markets
- **RSA-PSS Authentication** — Secure API signing per Kalshi's v2 specification
- **Strategy Scanner** — One-click scan for mispriced markets with edge/EV calculations
- **Risk Controls** — Kelly Criterion sizing, daily loss limits, dry run mode
- **Vercel Deploy** — Push to GitHub, auto-deploys on Vercel

## Setup

### 1. Deploy to Vercel

Push this repo to GitHub, then import it in [vercel.com](https://vercel.com).

### 2. Set Environment Variables

In **Vercel Dashboard → Settings → Environment Variables**, add:

| Variable | Value |
|---|---|
| `KALSHI_API_KEY` | Your Kalshi API Key ID |
| `KALSHI_PRIVATE_KEY` | Full PEM private key content (with newlines as `\n`) |
| `KALSHI_ENV` | `demo` or `prod` |
| `DRY_RUN` | `true` (set `false` for live trading) |

### 3. Use the Dashboard

Open your Vercel URL. The dashboard shows:
- Connection status (green = connected to your Kalshi account)
- Account balance in real-time
- Open positions and exposure
- Click **Run Scan** to find trade opportunities

## ⚠️ Disclaimer

This software is for **educational and research purposes only**. Trading prediction markets involves significant financial risk. Always start with `KALSHI_ENV=demo` and `DRY_RUN=true`.
