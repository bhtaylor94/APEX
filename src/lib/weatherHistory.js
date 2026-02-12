
// Minimal historical weather helper (scaffold)
// You can plug in an archive provider (NOAA, Open-Meteo, Meteostat, etc.) and cache results.
//
// Goal: produce a data-driven prior (mean/std) for today's high given city+day-of-year,
// then combine with the market strike to compute probability.
//
// NOTE: This file does not ship keys; it is safe to extend server-side.
export async function getDailyHighHistory({ lat, lon, startDate, endDate }) {
  // TODO: Implement using your preferred archive source.
  // Return an array of daily highs in Fahrenheit.
  return [];
}

export function computeMeanStd(values) {
  const n = values.length;
  if (!n) return { mean: null, std: null };
  const mean = values.reduce((a,b)=>a+b,0) / n;
  const var_ = values.reduce((a,b)=>a+(b-mean)*(b-mean),0) / n;
  return { mean, std: Math.sqrt(var_) };
}
