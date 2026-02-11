/**
 * GET /api/status
 *
 * Returns full connection status: exchange state, auth check,
 * account balance, open positions, and config info.
 */

import { createClientFromEnv } from "../../lib/kalshi";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const result = {
    timestamp: new Date().toISOString(),
    exchange: { active: false, trading: false },
    auth: { connected: false, error: null },
    account: { balance: null, balanceFormatted: null },
    positions: { count: 0, totalExposure: null, items: [] },
    config: {
      env: process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "demo",
      dryRun: process.env.DRY_RUN !== "false",
      maxDailyLoss: parseFloat(process.env.MAX_DAILY_LOSS || "50"),
      kellyFraction: parseFloat(process.env.KELLY_FRACTION || "0.5"),
      categories: (process.env.TRADE_CATEGORIES || "weather,economic").split(","),
    },
  };

  let client;

  // 1. Initialize client
  try {
    client = createClientFromEnv();
  } catch (err) {
    result.auth.error = err.message;
    return res.status(200).json(result);
  }

  // 2. Exchange status
  try {
    const status = await client.getExchangeStatus();
    result.exchange.active = status.exchange_active || false;
    result.exchange.trading = status.trading_active || false;
  } catch (err) {
    result.exchange.error = err.message;
  }

  // 3. Authentication + Balance
  try {
    const balance = await client.getBalance();
    result.auth.connected = true;
    result.account.balance = balance;
    result.account.balanceFormatted = `$${balance.toFixed(2)}`;
  } catch (err) {
    result.auth.error = err.message;
    return res.status(200).json(result);
  }

  // 4. Positions
  try {
    const positions = await client.getAllPositions();
    result.positions.count = positions.length;
    const totalExposure = positions.reduce(
      (sum, p) => sum + Math.abs(p.market_exposure || 0),
      0
    ) / 100;
    result.positions.totalExposure = totalExposure;
    result.positions.totalExposureFormatted = `$${totalExposure.toFixed(2)}`;
    result.positions.items = positions.slice(0, 20).map((p) => ({
      ticker: p.ticker,
      eventTicker: p.event_ticker,
      exposure: (Math.abs(p.market_exposure || 0) / 100).toFixed(2),
      restingOrders: p.resting_orders_count || 0,
    }));
  } catch (err) {
    result.positions.error = err.message;
  }

  return res.status(200).json(result);
}
