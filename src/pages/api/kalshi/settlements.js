// pages/api/kalshi/settlements.js
import { kalshiFetch, isConfigured } from "../../../lib/kalshi";

export default async function handler(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ settlements: [] });
  }
  try {
    const { limit, cursor } = req.query;
    const params = new URLSearchParams();
    params.set("limit", limit || "100");
    if (cursor) params.set("cursor", cursor);

    const data = await kalshiFetch(`/portfolio/settlements?${params}`);
    res.status(200).json(data);
  } catch (e) {
    console.error("Settlements error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
