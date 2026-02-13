// pages/api/kalshi/positions.js
import { kalshiFetch, isConfigured } from "../../../lib/kalshi";

export default async function handler(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ market_positions: [] });
  }
  try {
    const data = await kalshiFetch("/portfolio/positions");
    res.status(200).json(data);
  } catch (e) {
    console.error("Positions error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
