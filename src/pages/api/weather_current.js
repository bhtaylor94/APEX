async function nws(path, params) {
  const r = await fetch("http://localhost:3000/api/nws", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, params }),
  });
  if (!r.ok) return null;
  return r.json();
}

// Vercel doesn't provide localhost:3000 in production.
// We'll call the route handler internally by reusing fetch relative URL.
async function nwsRel(path, params) {
  const r = await fetch("/api/nws", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, params }),
  });
  if (!r.ok) return null;
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { lat, lon, station } = req.body || {};
  if (lat == null || lon == null || !station) {
    return res.status(400).json({ error: "lat, lon, station required" });
  }

  const NWS = "https://api.weather.gov";
  const [pt, obs] = await Promise.all([
    nwsRel(`/points/${lat},${lon}`),
    nwsRel(`/stations/${station}/observations/latest`),
  ]);

  let hi = null, hrMax = null, desc = null;
  if (pt?.properties?.forecast) {
    const fc = await nwsRel(pt.properties.forecast.replace(NWS, ""));
    const day = fc?.properties?.periods?.find(p => p.isDaytime);
    hi = day?.temperature ?? null;
    desc = day?.shortForecast ?? null;
  }
  if (pt?.properties?.forecastHourly) {
    const hc = await nwsRel(pt.properties.forecastHourly.replace(NWS, ""));
    const dh = hc?.properties?.periods?.filter(p => p.isDaytime)?.slice(0, 12);
    if (dh?.length) hrMax = Math.max(...dh.map(h => h.temperature));
  }
  const cur = obs?.properties?.temperature?.value != null
    ? Math.round(obs.properties.temperature.value * 9 / 5 + 32) : null;

  const srcs = [];
  if (hi != null) srcs.push({ t: hi, w: 0.45 });
  if (hrMax != null) srcs.push({ t: hrMax, w: 0.35 });
  if (cur != null && hi != null) srcs.push({ t: Math.round(cur + (hi - cur) * 0.55), w: 0.2 });

  const tw = srcs.reduce((s, x) => s + x.w, 0);
  const ens = tw > 0 ? Math.round(srcs.reduce((s, x) => s + x.t * x.w, 0) / tw) : hi;
  const sig = srcs.length >= 2
    ? Math.max(1.5, Math.sqrt(srcs.reduce((s, x) => s + (x.t - ens) ** 2, 0) / srcs.length))
    : 3;

  res.status(200).json({ ens, sig, cur, hi, hrMax, desc });
}
