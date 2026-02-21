import { kvGetJson, requireUiToken } from "./_upstash";

const DEFAULT_WEIGHTS = { rsi: 2, vwap: 2, ob: 2 };

export default async function handler(req, res) {
  try {
    requireUiToken(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: "Unauthorized" });
  }

  try {
    const [learned, history, dailyStats, position, state, config] = await Promise.all([
      kvGetJson("bot:learned_weights"),
      kvGetJson("bot:trade_history"),
      kvGetJson("bot:daily_stats"),
      kvGetJson("bot:position"),
      kvGetJson("bot:state"),
      kvGetJson("bot:config"),
    ]);

    res.status(200).json({
      ok: true,
      learned: learned || null,
      tradeHistory: history || [],
      dailyStats: dailyStats || null,
      position: position || null,
      state: state || null,
      config: config || null,
      defaultWeights: DEFAULT_WEIGHTS,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
