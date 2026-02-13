function base() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  if (!url) throw new Error("Missing UPSTASH_REDIS_REST_URL");
  return url;
}
function headers() {
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) throw new Error("Missing UPSTASH_REDIS_REST_TOKEN");
  return { Authorization: "Bearer " + token };
}

export async function kvGetJson(key) {
  const res = await fetch(base() + "/get/" + encodeURIComponent(key), { headers: headers() });
  const json = await res.json();
  return json?.result ? JSON.parse(json.result) : null;
}

export async function kvSetJson(key, value) {
  const payload = encodeURIComponent(JSON.stringify(value));
  const res = await fetch(base() + "/set/" + encodeURIComponent(key) + "/" + payload, { headers: headers() });
  const json = await res.json();
  if (json?.error) throw new Error("Upstash set error: " + json.error);
  return true;
}

export function requireUiToken(req) {
  const required = process.env.BOT_UI_TOKEN;
  if (!required) return; // if not set, don't block (but better to set it)
  const got = req.headers["x-bot-token"];
  if (!got || got !== required) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
