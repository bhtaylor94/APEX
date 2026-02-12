const CDO_ROOT = "https://www.ncei.noaa.gov/cdo-web/api/v2";

// Simple in-memory cache (serverless warm instances only)
const CACHE = new Map();

function cacheGet(key) {
  const v = CACHE.get(key);
  if (!v) return null;
  if (Date.now() > v.exp) {
    CACHE.delete(key);
    return null;
  }
  return v.val;
}

function cacheSet(key, val, ttlMs) {
  CACHE.set(key, { val, exp: Date.now() + ttlMs });
}

function bbox(lat, lon, deg) {
  const minLat = lat - deg;
  const maxLat = lat + deg;
  const minLon = lon - deg;
  const maxLon = lon + deg;
  // extent expects: minLat,minLon,maxLat,maxLon
  return `${minLat},${minLon},${maxLat},${maxLon}`;
}

async function cdo(path, params) {
  const token = process.env.NOAA_CDO_TOKEN;
  if (!token) return null;

  const u = new URL(CDO_ROOT + path);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });

  const r = await fetch(u.toString(), { method: "GET", headers: { token } });
  if (!r.ok) return null;
  return r.json();
}

function meanStd(values) {
  const n = values.length;
  if (!n) return { mean: null, std: null, n: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const var_ = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return { mean, std: Math.sqrt(var_), n };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { lat, lon, years = 10, windowDays = 10 } = req.body || {};
  if (lat == null || lon == null) return res.status(400).json({ error: "lat, lon required" });

  const key = JSON.stringify({ lat, lon, years, windowDays });
  const cached = cacheGet(key);
  if (cached) return res.status(200).json(cached);

  // Find best nearby station in GHCND via extent search
  const ext = bbox(Number(lat), Number(lon), 0.75);
  const st = await cdo("/stations", {
    datasetid: "GHCND",
    extent: ext,
    limit: 25,
    sortfield: "datacoverage",
    sortorder: "desc",
  });

  const stationId = st?.results?.[0]?.id || null;
  if (!stationId) {
    const out = { mean: null, std: null, n: 0, stationId: null };
    cacheSet(key, out, 60 * 60 * 1000);
    return res.status(200).json(out);
  }

  const today = new Date();
  const mm = today.getUTCMonth() + 1;
  const dd = today.getUTCDate();
  const curYear = today.getUTCFullYear();

  function pad(n) { return String(n).padStart(2, "0"); }

  const highs = [];

  for (let y = curYear - years; y <= curYear - 1; y++) {
    const start = new Date(Date.UTC(y, mm - 1, dd));
    const end = new Date(Date.UTC(y, mm - 1, dd));
    start.setUTCDate(start.getUTCDate() - windowDays);
    end.setUTCDate(end.getUTCDate() + windowDays);

    const startdate = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;
    const enddate = `${end.getUTCFullYear()}-${pad(end.getUTCMonth() + 1)}-${pad(end.getUTCDate())}`;

    const d = await cdo("/data", {
      datasetid: "GHCND",
      datatypeid: "TMAX",
      stationid: stationId,
      startdate,
      enddate,
      units: "standard",
      limit: 1000,
    });

    for (const r of (d?.results || [])) {
      if (r?.value != null) highs.push(Number(r.value));
    }
  }

  const stats = meanStd(highs);
  const out = { ...stats, stationId };
  cacheSet(key, out, 6 * 60 * 60 * 1000);
  res.status(200).json(out);
}
