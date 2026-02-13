import { kvSetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try {
    requireUiToken(req);
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }
    await kvSetJson("bot:config", { enabled: false, mode: "paper", seriesTicker: "kxbtc15m" });
    res.status(200).json({ ok: true, message: "Bot disabled (kill switch)" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
