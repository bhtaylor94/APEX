import { kvGetJson, requireUiToken } from "./_upstash";

export default async function handler(req, res) {
  try {
    // Read-only endpoint; optional protection
    requireUiToken(req);

    const cfg = await kvGetJson("bot:config");
    const state = await kvGetJson("bot:state");
    const last = await kvGetJson("bot:last_run");

    res.status(200).json({ ok: true, config: cfg, state, last_run: last });
  } catch (e) {
    res.status(e.statusCode || 500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
