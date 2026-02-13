import { defaultConfig } from "./default_config.mjs";

async function upstashGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error("Missing Upstash env vars (UPSTASH_REDIS_REST_URL/TOKEN)");

  const res = await fetch([url, "get", encodeURIComponent(key)].join("/"), {
    headers: { Authorization: ["Bearer", token].join(" ") }
  });
  const json = await res.json();
  return json?.result ? JSON.parse(json.result) : null;
}

async function main() {
  const cfg = Object.assign({}, defaultConfig(), await upstashGet("bot:config"));

  console.log("BOT CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Exiting.");
    process.exit(0);
  }

  // TODO: wire these into your existing codebase:
  // 1) Fetch BTC candles/price (Coinbase)
  // 2) Compute signal + confidence
  // 3) Load bot:state (position/cooldown/daily)
  // 4) If paper => log decisions only
  // 5) If live => place Kalshi orders + persist state

  console.log("Runner skeleton installed. Next step: wire signal + Kalshi order placement.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
