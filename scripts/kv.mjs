const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || "";
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

function mustEnv(name, v) {
  if (!v) throw new Error("Missing env: " + name);
  return v;
}

async function upstash(path, init = {}) {
  const base = mustEnv("UPSTASH_REDIS_REST_URL", UPSTASH_URL).replace(/\/$/, "");
  const tok = mustEnv("UPSTASH_REDIS_REST_TOKEN", UPSTASH_TOKEN);

  const res = await fetch(base + path, {
    ...init,
    headers: {
      "Authorization": "Bearer " + tok,
      "Content-Type": "application/json",
      ...(init.headers || {})
    }
  });

  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { data = { raw: txt }; }

  if (!res.ok) throw new Error("Upstash " + res.status + ": " + txt);
  return data;
}

export async function kvGetJson(key) {
  const r = await upstash("/get/" + encodeURIComponent(key), { method: "GET" });
  const v = r?.result;
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}

export async function kvSetJson(key, obj) {
  // NOTE: requires write permissions on your Upstash REST token
  return upstash("/set/" + encodeURIComponent(key), {
    method: "POST",
    body: JSON.stringify(obj)
  });
}
