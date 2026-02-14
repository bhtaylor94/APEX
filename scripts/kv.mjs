const URL = process.env.UPSTASH_REDIS_REST_URL || "";
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "";

function mustEnv() {
  if (!URL || !TOKEN) throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN");
}

export async function kvGetJson(key) {
  mustEnv();
  const res = await fetch(URL.replace(/\/$/, "") + "/get/" + encodeURIComponent(key), {
    headers: { Authorization: "Bearer " + TOKEN }
  });
  const data = await res.json();
  const raw = data?.result ?? null;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function kvSetJson(key, obj) {
  mustEnv();
  const val = JSON.stringify(obj);
  const res = await fetch(URL.replace(/\/$/, "") + "/set/" + encodeURIComponent(key), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + TOKEN,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(val)
  });
  const data = await res.json();
  return data;
}
