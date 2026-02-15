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
    res.status(200).json({ ok: true, message: "Bot disabled (kill switch)" });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
