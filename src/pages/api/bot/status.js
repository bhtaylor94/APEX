import { kvGetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try {
    requireUiToken(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: "Unauthorized" });
  }

  try {
    const [cfg, lastTradeTs15, lastTradeTs1H, learned15, learned1H, daily15, daily1H, state15, state1H, pos15, pos1H] = await Promise.all([
      kvGetJson("bot:config"),
      kvGetJson("bot:lastTradeTs:15M"),
      kvGetJson("bot:lastTradeTs:1H"),
      kvGetJson("bot:learned_weights:15M"),
      kvGetJson("bot:learned_weights:1H"),
      kvGetJson("bot:daily_stats:15M"),
      kvGetJson("bot:daily_stats:1H"),
      kvGetJson("bot:state:15M"),
      kvGetJson("bot:state:1H"),
      kvGetJson("bot:position:15M"),
      kvGetJson("bot:position:1H"),
    ]);

    res.status(200).json({
      ok: true,
      config: cfg,
      series: {
        "15M": { state: state15, lastTradeTs: lastTradeTs15, learned: learned15, dailyStats: daily15, position: pos15 },
        "1H": { state: state1H, lastTradeTs: lastTradeTs1H, learned: learned1H, dailyStats: daily1H, position: pos1H },
      },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
