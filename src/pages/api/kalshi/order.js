// pages/api/kalshi/order.js
import { kalshiFetch, isConfigured } from "../../../lib/kalshi";
import { v4 as uuid } from "uuid";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!isConfigured()) {
    return res.status(400).json({ error: "API keys not configured" });
  }

  try {
    const { ticker, side, action, count, type, yes_price, no_price } = req.body;

    if (!ticker || !side || !count) {
      return res.status(400).json({ error: "Missing required fields: ticker, side, count" });
    }

    const orderData = {
      ticker,
      side,
      action: action || "buy",
      count: parseInt(count),
      type: type || "limit",
      client_order_id: uuid(),
      time_in_force: "fill_or_kill", // Immediate fill or cancel — critical for short-duration markets
    };

    if (side === "yes" && yes_price) orderData.yes_price = parseInt(yes_price);
    if (side === "no" && no_price) orderData.no_price = parseInt(no_price);

    console.log("Placing order:", JSON.stringify(orderData));

    const data = await kalshiFetch("/portfolio/orders", "POST", orderData);

    console.log("Order result:", JSON.stringify(data));
    res.status(201).json(data);
  } catch (e) {
    console.error("Order error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
