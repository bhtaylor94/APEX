/**
 * POST /api/bot/scan
 *
 * Runs a full strategy scan cycle and returns trade signals.
 * Does NOT execute trades — just returns the signals for the dashboard.
 *
 * Body: { categories: ["weather", "economic"] }
 */

import { createClientFromEnv } from "../../../lib/kalshi";
import { runStrategyScan } from "../../../lib/strategies";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const client = createClientFromEnv();
    const categories = req.body?.categories || ["weather", "economic"];

    const signals = await runStrategyScan(client, categories);

    return res.status(200).json({
      timestamp: new Date().toISOString(),
      signalCount: signals.length,
      signals,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
