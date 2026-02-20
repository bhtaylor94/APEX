import { kvGetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try {
    requireUiToken(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: "Unauthorized" });
  }

  try {
    const [cfg, state, lastTradeTs, learned, dailyStats] = await Promise.all([
      kvGetJson("bot:config"),
      kvGetJson("bot:state"),
      kvGetJson("bot:lastTradeTs"),
      kvGetJson("bot:learned_weights"),
      kvGetJson("bot:daily_stats"),
    ]);
    res.status(200).json({ ok: true, config: cfg, state, lastTradeTs, learned, dailyStats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
