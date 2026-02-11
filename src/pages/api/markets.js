/**
 * GET /api/markets?series=KXHIGHNY&status=open
 *
 * Returns markets for a given series ticker.
 */

import { createClientFromEnv } from "../../lib/kalshi";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const client = createClientFromEnv();
    const { series, status = "open", limit = "100" } = req.query;

    if (series) {
      const markets = await client.getAllMarketsForSeries(series, status);
      return res.status(200).json({ markets, count: markets.length });
    }

    const data = await client.getMarkets({ limit: parseInt(limit), status });
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
