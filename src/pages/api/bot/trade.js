/**
 * POST /api/bot/trade
 *
 * Execute a trade based on a signal.
 *
 * Body: {
 *   ticker: "KXHIGHNY-...",
 *   side: "yes" | "no",
 *   action: "buy" | "sell",
 *   count: 10,
 *   price: 45,         // cents
 *   dryRun: true       // if true, just simulates
 * }
 */

import { createClientFromEnv } from "../../../lib/kalshi";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { ticker, side, action = "buy", count, price, dryRun = true } = req.body || {};

  if (!ticker || !side || !count || !price) {
    return res.status(400).json({ error: "Missing required fields: ticker, side, count, price" });
  }

  const order = {
    ticker,
    side,
    action,
    count: parseInt(count),
    type: "limit",
    ...(side === "yes" ? { yes_price: parseInt(price) } : { no_price: parseInt(price) }),
    time_in_force: "gtc",
    post_only: true,
  };

  if (dryRun || process.env.DRY_RUN !== "false") {
    return res.status(200).json({
      status: "dry_run",
      message: "Order simulated (dry run mode)",
      order,
      timestamp: new Date().toISOString(),
    });
  }

  try {
    const client = createClientFromEnv();
    const result = await client.createOrder(order);
    return res.status(200).json({
      status: "executed",
      order: result.order || result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message, order });
  }
}
