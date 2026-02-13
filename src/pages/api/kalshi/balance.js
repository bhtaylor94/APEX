// pages/api/kalshi/balance.js
import { kalshiFetch, isConfigured } from "../../../lib/kalshi";

export default async function handler(req, res) {
  if (!isConfigured()) {
    return res.status(200).json({ error: "no_keys", balance: 0, portfolio_value: 0 });
  }
  try {
    const data = await kalshiFetch("/portfolio/balance");
    res.status(200).json(data);
  } catch (e) {
    console.error("Balance error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
