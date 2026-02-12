const PROD_ROOT = "https://api.elections.kalshi.com/trade-api/v2";
const DEMO_ROOT = "https://demo-api.kalshi.co/trade-api/v2";

const ALLOW = new Set([
  "/markets",
  "/events",
  "/series",
]);

function root() {
  return (process.env.KALSHI_ENV || "demo") === "prod" ? PROD_ROOT : DEMO_ROOT;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { path, params } = req.body || {};
  const p = String(path || "");

  if (!ALLOW.has(p)) return res.status(403).json({ error: "Not allowed", path: p });

  const u = new URL(root() + p);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });

  const r = await fetch(u.toString(), { method: "GET" });
  const text = await r.text();
  res.status(r.status).send(text);
}

