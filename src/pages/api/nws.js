const NWS_ROOT = "https://api.weather.gov";

const ALLOW_PREFIX = [
  "/points/",
  "/stations/",
  "/gridpoints/",
];

function isAllowedPath(p) {
  return ALLOW_PREFIX.some(pref => p.startsWith(pref));
}

function userAgent() {
  // NWS requests should include a unique User-Agent with contact info when possible.
  // Set NWS_USER_AGENT in Vercel env vars, e.g. "APEXBot/1.0 (you@example.com)"
  return process.env.NWS_USER_AGENT || "APEXBot/1.0 (contact: unknown)";
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { path, params } = req.body || {};
  const p = String(path || "");

  if (!isAllowedPath(p)) {
    return res.status(403).json({ error: "Not allowed", path: p });
  }

  const u = new URL(NWS_ROOT + p);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });

  const r = await fetch(u.toString(), {
    method: "GET",
    headers: {
      "User-Agent": userAgent(),
      "Accept": "application/geo+json",
    },
  });

  const text = await r.text();
  res.status(r.status).send(text);
}
