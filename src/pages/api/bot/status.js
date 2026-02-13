import { kvGetJson } from "./_upstash";

export default async function handler(req, res) {
  try {
    const cfg = await kvGetJson("bot:config");
    const state = await kvGetJson("bot:state");
    const last = await kvGetJson("bot:last_run");
    res.status(200).json({ ok: true, config: cfg, state, last_run: last });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Unknown error" });
  }
}
