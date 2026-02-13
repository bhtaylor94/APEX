import { kvGetJson, kvSetJson, requireUiToken } from "./_upstash";

function pickConfig(input, current) {
  // Allowlist only safe, expected keys
  const allowed = [
    "enabled",
    "mode",
    "seriesTicker",
    "tradeSizeUsd",
    "minConfidence",
    "takeProfitPct",
    "stopLossPct",
    "minMinutesToCloseToEnter",
    "minMinutesToCloseToHold",
    "cooldownMinutes",
    "maxTradesPerDay",
    "dailyMaxLossUsd"
  ];

  const out = Object.assign({}, current || {});
  for (const k of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, k)) out[k] = input[k];
  }

  // Basic normalization
  if (typeof out.enabled !== "boolean") out.enabled = !!out.enabled;
  out.mode = (out.mode === "live") ? "live" : "paper";
  out.seriesTicker = out.seriesTicker || "kxbtc15m";

  const numFields = [
    "tradeSizeUsd","minConfidence","takeProfitPct","stopLossPct",
    "minMinutesToCloseToEnter","minMinutesToCloseToHold","cooldownMinutes",
    "maxTradesPerDay","dailyMaxLossUsd"
  ];
  for (const k of numFields) {
    if (out[k] !== undefined && out[k] !== null) out[k] = Number(out[k]);
  }

  // Clamp some values
  out.tradeSizeUsd = Math.max(1, out.tradeSizeUsd || 5);
  out.minConfidence = Math.min(0.95, Math.max(0.05, out.minConfidence || 0.55));
  out.takeProfitPct = Math.min(1, Math.max(0.01, out.takeProfitPct || 0.20));
  out.stopLossPct = Math.min(1, Math.max(0.01, out.stopLossPct || 0.12));

  return out;
}

export default async function handler(req, res) {
  try {
    requireUiToken(req);

    if (req.method === "GET") {
      const cfg = await kvGetJson("bot:config");
      res.status(200).json({ ok: true, config: cfg });
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }

    const current = await kvGetJson("bot:config");
    const next = pickConfig(req.body || {}, current);

    await kvSetJson("bot:config", next);

    res.status(200).json({ ok: true, config: next });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
