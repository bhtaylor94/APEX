import { kvGetJson, kvSetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try {
    requireUiToken(req);
    if (req.method !== "POST") {
      res.status(405).json({ ok: false, error: "Method not allowed" });
      return;
    }
    const current = await kvGetJson("bot:config") || {};
    await kvSetJson("bot:config", { ...current, enabled: false });
    await kvSetJson("bot:position", null);
    await kvSetJson("bot:pendingOrder", null);
    res.status(200).json({ ok: true, message: "Bot disabled, position and pending order cleared" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
