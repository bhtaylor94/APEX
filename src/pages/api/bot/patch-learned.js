import { kvGetJson, kvSetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try { requireUiToken(req); } catch (e) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const learned = await kvGetJson("bot:learned_weights");
  if (!learned) return res.json({ ok: false, error: "No learned weights found" });

  // Recalculate threshold with new rules
  const ls = learned.lossStreak || 0;
  const wr = (learned.winRate || 0) / 100;
  const total = learned.totalTrades || 0;
  let threshold = 2;
  if (ls >= 5) threshold = 2.25;
  else if (wr >= 0.65 && total >= 5) threshold = 1.5;
  else if (wr < 0.35 && total >= 5) threshold = 2;

  const before = learned.minScoreThreshold;
  learned.minScoreThreshold = threshold;

  // Reset weights to clean 3-indicator defaults
  learned.weights = { rsi: 2, vwap: 2, ob: 2 };
  // Reset indicator stats so old BB/MACD data doesn't pollute learning
  learned.indicatorStats = { rsi: { correct: 0, wrong: 0, neutral: 0 }, vwap: { correct: 0, wrong: 0, neutral: 0 }, ob: { correct: 0, wrong: 0, neutral: 0 } };
  learned.comboStats = {};

  await kvSetJson("bot:learned_weights", learned);

  // Reset daily stats if requested
  let dailyReset = false;
  if (req.body?.resetDaily) {
    const today = new Date().toISOString().slice(0, 10);
    await kvSetJson("bot:daily_stats", { date: today, totalTrades: 0, wins: 0, losses: 0, takeProfits: 0, totalPnlCents: 0 });
    dailyReset = true;
  }

  res.json({ ok: true, before, after: threshold, weights: learned.weights, lossStreak: ls, winRate: learned.winRate, dailyReset });
}
