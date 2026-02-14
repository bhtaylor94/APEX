import fetch from "node-fetch";

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

export async function kvGetJson(key) {
  const r = await fetch(`${URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

export async function kvSetJson(key, val) {
  await fetch(`${URL}/set/${key}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(val)
  });
}
