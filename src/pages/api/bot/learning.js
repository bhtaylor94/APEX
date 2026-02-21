import { kvGetJson, requireUiToken } from "./_upstash";

const DEFAULT_WEIGHTS_15M = { rsi: 2, vwap: 2, ob: 2 };
const DEFAULT_WEIGHTS_1H = { rsi: 2, macd: 2, ema: 2, vwap: 2 };

export default async function handler(req, res) {
  try {
    requireUiToken(req);
  } catch (e) {
    return res.status(e.statusCode || 401).json({ error: "Unauthorized" });
  }

  try {
    const [learned15, learned1H, history, daily15, daily1H, pos15, pos1H, state15, state1H, config] = await Promise.all([
      kvGetJson("bot:learned_weights:15M"),
      kvGetJson("bot:learned_weights:1H"),
      kvGetJson("bot:trade_history"),
      kvGetJson("bot:daily_stats:15M"),
      kvGetJson("bot:daily_stats:1H"),
      kvGetJson("bot:position:15M"),
      kvGetJson("bot:position:1H"),
      kvGetJson("bot:state:15M"),
      kvGetJson("bot:state:1H"),
      kvGetJson("bot:config"),
    ]);

    res.status(200).json({
      ok: true,
      series: {
        "15M": {
          learned: learned15 || null,
          dailyStats: daily15 || null,
          position: pos15 || null,
          state: state15 || null,
          defaultWeights: DEFAULT_WEIGHTS_15M,
        },
        "1H": {
          learned: learned1H || null,
          dailyStats: daily1H || null,
          position: pos1H || null,
          state: state1H || null,
          defaultWeights: DEFAULT_WEIGHTS_1H,
        },
      },
      tradeHistory: history || [],
      config: config || null,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
