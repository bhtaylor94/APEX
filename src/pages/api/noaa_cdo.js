const CDO_ROOT = "https://www.ncei.noaa.gov/cdo-web/api/v2";

const ALLOW = new Set([
  "/stations",
  "/data",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const token = process.env.NOAA_CDO_TOKEN;
  if (!token) return res.status(500).json({ error: "NOAA_CDO_TOKEN not set" });

  const { path, params } = req.body || {};
  const p = String(path || "");

  if (!ALLOW.has(p)) return res.status(403).json({ error: "Not allowed", path: p });

  const u = new URL(CDO_ROOT + p);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });

  const r = await fetch(u.toString(), {
    method: "GET",
    headers: { token },
  });

  const text = await r.text();
  res.status(r.status).send(text);
}
