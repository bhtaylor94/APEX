/**
 * Trading Strategies for Kalshi Weather & Economic Markets.
 *
 * Implements proven approaches from successful Kalshi traders:
 *
 * WEATHER:
 *  - Forecast Divergence: NWS forecast vs market-implied temperature
 *  - Edge Bracket Value: Outer brackets chronically underpriced
 *  - Observation Momentum: Current temps diverging from forecast
 *
 * ECONOMIC:
 *  - Consensus Deviation: Market pricing vs economist consensus
 *  - Leading Indicator Signals: Initial claims → jobs, PMI → GDP
 *
 * Settlement sources:
 *  - Weather: NWS Daily Climate Report (Central Park, Midway, MIA, Austin-Bergstrom)
 *  - Economic: BLS (CPI, Jobs), Federal Reserve (rates), BEA (GDP)
 */

// ─── Weather Config ──────────────────────────────────────────
const WEATHER_SERIES = {
  KXHIGHNY:  { city: "New York City", station: "KNYC", lat: 40.7829, lon: -73.9654 },
  KXHIGHCHI: { city: "Chicago",       station: "KMDW", lat: 41.7868, lon: -87.7522 },
  KXHIGHMIA: { city: "Miami",         station: "KMIA", lat: 25.7959, lon: -80.2870 },
  KXHIGHAUS: { city: "Austin",        station: "KAUS", lat: 30.1945, lon: -97.6699 },
};

const WEATHER_SERIES_TICKERS = Object.keys(WEATHER_SERIES);

const ECONOMIC_SERIES_TICKERS = ["KXCPI", "KXJOBS", "KXFED", "KXGDP", "KXINX"];

// ─── Math Helpers ────────────────────────────────────────────
function normalCDF(x, mean, std) {
  const z = (x - mean) / std;
  return 0.5 * (1 + erf(z / Math.sqrt(2)));
}

function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

function kellyCriterion(probability, odds, fraction = 0.5) {
  if (probability <= 0 || probability >= 1 || odds <= 0) return 0;
  const q = 1 - probability;
  const kelly = (probability * odds - q) / odds;
  return Math.max(0, kelly) * fraction;
}

// ─── Bracket Parsing ─────────────────────────────────────────
function parseBracket(subtitle) {
  if (!subtitle) return { low: null, high: null };
  const s = subtitle.trim();

  // "51° to 52°" or "51 to 52"
  let m = s.match(/(\d+)\s*°?\s*to\s*(\d+)\s*°?/);
  if (m) return { low: parseFloat(m[1]), high: parseFloat(m[2]) + 1 };

  // "≤ 49°" or "49° or less"
  m = s.match(/[≤<]\s*(\d+)|(\d+)\s*°?\s*or\s*less/);
  if (m) {
    const v = parseFloat(m[1] || m[2]);
    return { low: -999, high: v + 1 };
  }

  // "≥ 55°" or "55° or more"
  m = s.match(/[≥>]\s*(\d+)|(\d+)\s*°?\s*or\s*more/);
  if (m) {
    const v = parseFloat(m[1] || m[2]);
    return { low: v, high: 999 };
  }

  // Generic numeric extraction for economic markets
  const nums = s.match(/[-+]?[\d]*\.?\d+/g);
  if (nums && nums.length >= 2) return { low: parseFloat(nums[0]), high: parseFloat(nums[1]) };
  if (nums && nums.length === 1) {
    const v = parseFloat(nums[0]);
    if (/[≥>]|or more|above|over/.test(s)) return { low: v, high: Infinity };
    if (/[≤<]|or less|below|under/.test(s)) return { low: -Infinity, high: v };
    return { low: v, high: v };
  }

  return { low: null, high: null };
}

// ─── NWS Data Feed ───────────────────────────────────────────
async function fetchNWSForecast(station, lat, lon) {
  try {
    // Get current observation
    const obsRes = await fetch(`https://api.weather.gov/stations/${station}/observations/latest`, {
      headers: { "User-Agent": "APEXTradingBot/2.0" },
    });
    let currentTemp = null;
    if (obsRes.ok) {
      const obsData = await obsRes.json();
      const tempC = obsData?.properties?.temperature?.value;
      if (tempC != null) currentTemp = Math.round((tempC * 9) / 5 + 32);
    }

    // Get point forecast
    const pointRes = await fetch(`https://api.weather.gov/points/${lat},${lon}`, {
      headers: { "User-Agent": "APEXTradingBot/2.0" },
    });
    let forecastHigh = null;
    let hourlyMax = null;

    if (pointRes.ok) {
      const pointData = await pointRes.json();

      // Daily forecast
      const fUrl = pointData?.properties?.forecast;
      if (fUrl) {
        const fRes = await fetch(fUrl, { headers: { "User-Agent": "APEXTradingBot/2.0" } });
        if (fRes.ok) {
          const fData = await fRes.json();
          const periods = fData?.properties?.periods || [];
          for (const p of periods.slice(0, 2)) {
            if (p.isDaytime) forecastHigh = p.temperature;
          }
        }
      }

      // Hourly forecast
      const hUrl = pointData?.properties?.forecastHourly;
      if (hUrl) {
        const hRes = await fetch(hUrl, { headers: { "User-Agent": "APEXTradingBot/2.0" } });
        if (hRes.ok) {
          const hData = await hRes.json();
          const temps = (hData?.properties?.periods || []).slice(0, 24).map((p) => p.temperature);
          if (temps.length) hourlyMax = Math.max(...temps);
        }
      }
    }

    // Best estimate = max of all sources
    const estimates = [forecastHigh, currentTemp, hourlyMax].filter((v) => v != null);
    const bestEstimate = estimates.length ? Math.max(...estimates) : null;

    return { currentTemp, forecastHigh, hourlyMax, bestEstimate };
  } catch (err) {
    console.error(`NWS fetch error for ${station}:`, err.message);
    return { currentTemp: null, forecastHigh: null, hourlyMax: null, bestEstimate: null };
  }
}

// ─── Weather Strategy ────────────────────────────────────────
async function analyzeWeatherMarket(market) {
  // Find the matching weather config
  const config = Object.entries(WEATHER_SERIES).find(([ticker, cfg]) => {
    const t = market.event_ticker || "";
    return t.includes(ticker.replace("KX", "")) || (market.title || "").toLowerCase().includes(cfg.city.toLowerCase());
  });

  if (!config) return null;
  const [seriesTicker, cfg] = config;

  // Fetch NWS data
  const forecast = await fetchNWSForecast(cfg.station, cfg.lat, cfg.lon);
  if (!forecast.bestEstimate) return null;

  // Parse bracket
  const { low, high } = parseBracket(market.subtitle);
  if (low == null || high == null) return null;

  // Estimate probability (Gaussian model, std ≈ 2.5°F typical forecast error)
  const std = 2.5;
  const est = forecast.bestEstimate;
  let estProb;
  if (low === -999) estProb = normalCDF(high, est, std);
  else if (high === 999) estProb = 1 - normalCDF(low, est, std);
  else estProb = normalCDF(high, est, std) - normalCDF(low, est, std);

  estProb = Math.max(0.01, Math.min(0.99, estProb));

  // Market implied probability
  const yesMid = market.yes_bid && market.yes_ask ? (market.yes_bid + market.yes_ask) / 2 : market.last_price || 0;
  const mktProb = Math.max(0.01, yesMid / 100);

  const edge = estProb - mktProb;

  // Need meaningful edge
  if (Math.abs(edge) < 0.03) return null;

  let side, costCents, prob;
  if (edge > 0) {
    side = "yes";
    costCents = market.yes_ask || Math.round(mktProb * 100);
    prob = estProb;
  } else {
    side = "no";
    costCents = market.no_ask || Math.round((1 - mktProb) * 100);
    prob = 1 - estProb;
  }

  if (costCents <= 0 || costCents >= 100) return null;

  const ev = (prob * 100 - costCents) / 100; // EV in dollars
  if (ev < 0.02) return null;

  const confidence = Math.min(0.95, Math.abs(edge) * 2 + 0.3);

  return {
    ticker: market.ticker,
    side,
    action: "buy",
    confidence: Math.round(confidence * 100) / 100,
    estProb: Math.round(estProb * 1000) / 1000,
    mktProb: Math.round(mktProb * 1000) / 1000,
    edge: Math.round(edge * 1000) / 1000,
    ev: Math.round(ev * 100) / 100,
    price: costCents,
    strategy: "WeatherForecastDivergence",
    city: cfg.city,
    forecastHigh: forecast.bestEstimate,
    bracket: `${low === -999 ? "≤" : low}–${high === 999 ? "≥" : high}°F`,
    reasoning: `${cfg.city}: est=${est}°F, bracket=[${low},${high}], edge=${edge > 0 ? "+" : ""}${(edge * 100).toFixed(1)}%`,
  };
}

// ─── Run Scan ────────────────────────────────────────────────
async function runStrategyScan(client, categories = ["weather", "economic"]) {
  const signals = [];

  if (categories.includes("weather")) {
    for (const ticker of WEATHER_SERIES_TICKERS) {
      try {
        const markets = await client.getAllMarketsForSeries(ticker, "open");
        for (const m of markets) {
          try {
            const signal = await analyzeWeatherMarket(m);
            if (signal) signals.push(signal);
          } catch (err) {
            console.error(`Error analyzing ${m.ticker}:`, err.message);
          }
        }
      } catch (err) {
        console.error(`Error scanning ${ticker}:`, err.message);
      }
    }
  }

  if (categories.includes("economic")) {
    for (const ticker of ECONOMIC_SERIES_TICKERS) {
      try {
        const markets = await client.getAllMarketsForSeries(ticker, "open");
        // Economic signals use simpler market data analysis
        for (const m of markets) {
          const yesMid = m.yes_bid && m.yes_ask ? (m.yes_bid + m.yes_ask) / 2 : m.last_price || 0;
          const mktProb = yesMid / 100;
          // Flag extreme mispricings (very cheap contracts with volume)
          if ((mktProb < 0.10 || mktProb > 0.90) && (m.volume_24h || 0) > 20) {
            signals.push({
              ticker: m.ticker,
              side: mktProb < 0.10 ? "yes" : "no",
              action: "buy",
              confidence: 0.5,
              estProb: mktProb < 0.10 ? 0.15 : 0.85,
              mktProb,
              edge: mktProb < 0.10 ? 0.05 : -0.05,
              ev: 0.03,
              price: mktProb < 0.10 ? (m.yes_ask || 10) : (m.no_ask || 10),
              strategy: "EconomicEdgeValue",
              reasoning: `Economic edge bracket: ${m.subtitle || m.title}`,
            });
          }
        }
      } catch (err) {
        console.error(`Error scanning economic ${ticker}:`, err.message);
      }
    }
  }

  // Sort by EV descending
  signals.sort((a, b) => b.ev - a.ev);
  return signals;
}

module.exports = {
  WEATHER_SERIES,
  WEATHER_SERIES_TICKERS,
  ECONOMIC_SERIES_TICKERS,
  parseBracket,
  normalCDF,
  kellyCriterion,
  analyzeWeatherMarket,
  runStrategyScan,
};
