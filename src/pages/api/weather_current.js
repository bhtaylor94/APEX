const NWS_ROOT = "https://api.weather.gov";

function userAgent() {
  // Recommended by NWS: include a UA with contact info
  return process.env.NWS_USER_AGENT || "APEXBot/1.0 (contact: unknown)";
}

async function nwsAbs(url) {
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": userAgent(),
      "Accept": "application/geo+json",
    },
  });
  if (!r.ok) return null;
  return r.json();
}

async function nws(path) {
  return nwsAbs(NWS_ROOT + path);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { lat, lon, station } = req.body || {};
  if (lat == null || lon == null || !station) {
    return res.status(400).json({ error: "lat, lon, station required" });
  }

  // Points + latest observation
  const [pt, obs] = await Promise.all([
    nws(`/points/${lat},${lon}`),
    nws(`/stations/${station}/observations/latest`),
  ]);

  let hi = null, hrMax = null, desc = null;

  // Daytime forecast high
  if (pt?.properties?.forecast) {
    const fc = await nwsAbs(pt.properties.forecast);
    const day = fc?.properties?.periods?.find((p) => p?.isDaytime);
    hi = (day && typeof day.temperature === "number") ? day.temperature : null;
    desc = day?.shortForecast ?? null;
  }

  // Hourly forecast max (daytime)
  if (pt?.properties?.forecastHourly) {
    const hc = await nwsAbs(pt.properties.forecastHourly);
    const dh = hc?.properties?.periods
      ?.filter((p) => p?.isDaytime)
      ?.slice(0, 18);
    if (dh?.length) {
      const temps = dh.map((h) => h.temperature).filter((t) => typeof t === "number");
      if (temps.length) hrMax = Math.max(...temps);
    }
  }

  // Current observation (C -> F)
  const cur = (obs?.properties?.temperature?.value != null)
    ? Math.round(obs.properties.temperature.value * 9 / 5 + 32)
    : null;

  // Simple ensemble: blend available signals
  const srcs = [];
  if (hi != null) srcs.push({ t: hi, w: 0.5 });
  if (hrMax != null) srcs.push({ t: hrMax, w: 0.35 });
  if (cur != null && hi != null) srcs.push({ t: Math.round(cur + (hi - cur) * 0.55), w: 0.15 });

  const tw = srcs.reduce((s, x) => s + x.w, 0);
  const ens = tw > 0 ? Math.round(srcs.reduce((s, x) => s + x.t * x.w, 0) / tw) : hi;

  // Uncertainty proxy: if we have multiple signals, use spread; otherwise default
  const sig = (srcs.length >= 2 && ens != null)
    ? Math.max(1.5, Math.sqrt(srcs.reduce((s, x) => s + (x.t - ens) ** 2, 0) / srcs.length))
    : 3;

  res.status(200).json({ ens, sig, cur, hi, hrMax, desc });
}
