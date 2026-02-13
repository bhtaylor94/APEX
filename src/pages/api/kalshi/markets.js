// pages/api/kalshi/markets.js
import { kalshiPublicFetch } from "../../../lib/kalshi";

export default async function handler(req, res) {
  try {
    const { series_ticker, status, limit, event_ticker } = req.query;
    const params = new URLSearchParams();
    if (series_ticker) params.set("series_ticker", series_ticker);
    if (event_ticker) params.set("event_ticker", event_ticker);
    if (status) params.set("status", status);
    params.set("limit", limit || "50");

    const data = await kalshiPublicFetch(`/markets?${params}`);
    res.status(200).json(data);
  } catch (e) {
    console.error("Markets error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
