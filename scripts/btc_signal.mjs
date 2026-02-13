function ema(values, period) {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - (100 / (1 + rs));
}

export async function fetchCoinbaseCandles({ granularity=60, limit=120 } = {}) {
  // Coinbase Exchange candles: /products/BTC-USD/candles
  // returns [ time, low, high, open, close, volume ]
  const end = Math.floor(Date.now() / 1000);
  const start = end - granularity * limit;

  const url =
    "https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=" +
    granularity +
    "&start=" + new Date(start * 1000).toISOString() +
    "&end=" + new Date(end * 1000).toISOString();

  const res = await fetch(url, { headers: { "User-Agent": "apex-bot" } });
  if (!res.ok) throw new Error("Coinbase candles HTTP " + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error("Coinbase candles unexpected response");

  // Sort ascending by time
  data.sort((a,b) => a[0]-b[0]);
  return data.map(d => ({
    t: d[0],
    o: d[3],
    h: d[2],
    l: d[1],
    c: d[4],
    v: d[5]
  }));
}

export function computeSignal(candles) {
  const closes = candles.map(c => c.c);
  const last = closes[closes.length - 1];

  const emaFast = ema(closes.slice(-60), 9);
  const emaSlow = ema(closes.slice(-60), 21);
  const trendUp = emaFast > emaSlow;
  const trendDown = emaFast < emaSlow;

  const r = rsi(closes, 14);

  // Confidence: trend separation + RSI distance from 50
  const sep = Math.min(1, Math.abs(emaFast - emaSlow) / last * 50); // scaled
  const rsiConf = Math.min(1, Math.abs(r - 50) / 25);
  const confidence = Math.max(0, Math.min(1, 0.55 * sep + 0.45 * rsiConf));

  let dir = "NONE";
  if (trendUp && r >= 45 && r <= 75) dir = "UP";
  if (trendDown && r <= 55 && r >= 25) dir = "DOWN";

  return { dir, confidence, emaFast, emaSlow, rsi: r, last };
}
