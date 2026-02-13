// pages/api/btc-price.js
// Server-side BTC price + candles (Coinbase Exchange) — avoids client CORS and Binance geo restrictions.
// No API keys required.

const GRANULARITY_BY_INTERVAL = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "1d": 86400,
};

function clampInt(n, min, max, fallback) {
  const x = Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(x)) return fallback;
  return Math.min(max, Math.max(min, x));
}

export default async function handler(req, res) {
  try {
    const interval = String(req.query.interval || "1m");
    const limit = clampInt(req.query.limit, 1, 300, 100);

    const granularity = GRANULARITY_BY_INTERVAL[interval] || 60;
    const endMs = Date.now();
    const startMs = endMs - granularity * 1000 * limit;

    const startISO = new Date(startMs).toISOString();
    const endISO = new Date(endMs).toISOString();

    const base = "https://api.exchange.coinbase.com";

    const [tickerRes, statsRes, candlesRes] = await Promise.all([
      fetch(`${base}/products/BTC-USD/ticker`, {
        headers: { "User-Agent": "apex-bot" },
      }),
      fetch(`${base}/products/BTC-USD/stats`, {
        headers: { "User-Agent": "apex-bot" },
      }),
      fetch(
        `${base}/products/BTC-USD/candles?start=${encodeURIComponent(startISO)}&end=${encodeURIComponent(
          endISO
        )}&granularity=${granularity}`,
        { headers: { "User-Agent": "apex-bot" } }
      ),
    ]);

    if (!tickerRes.ok) {
      const txt = await tickerRes.text();
      throw new Error(`Coinbase ticker error: ${tickerRes.status} ${txt}`);
    }
    if (!statsRes.ok) {
      const txt = await statsRes.text();
      throw new Error(`Coinbase stats error: ${statsRes.status} ${txt}`);
    }
    if (!candlesRes.ok) {
      const txt = await candlesRes.text();
      throw new Error(`Coinbase candles error: ${candlesRes.status} ${txt}`);
    }

    const ticker = await tickerRes.json();
    const stats = await statsRes.json();
    const rawCandles = await candlesRes.json();

    if (!Array.isArray(rawCandles)) {
      throw new Error(`Coinbase candles unexpected response: ${JSON.stringify(rawCandles)}`);
    }

    // Coinbase candles: [ time, low, high, open, close, volume ] (most recent first)
    const sorted = rawCandles.slice().sort((a, b) => Number(a[0]) - Number(b[0]));

    const klines = sorted.map((c) => ({
      openTime: Number(c[0]) * 1000,
      open: Number.parseFloat(c[3]),
      high: Number.parseFloat(c[2]),
      low: Number.parseFloat(c[1]),
      close: Number.parseFloat(c[4]),
      volume: Number.parseFloat(c[5]),
      closeTime: (Number(c[0]) + granularity) * 1000,
    }));

    const last = Number.parseFloat(ticker?.price ?? stats?.last);
    const open24h = Number.parseFloat(stats?.open);
    const high24h = Number.parseFloat(stats?.high);
    const low24h = Number.parseFloat(stats?.low);
    const volume24h = Number.parseFloat(stats?.volume);

    const priceChange = Number.isFinite(last) && Number.isFinite(open24h) ? last - open24h : 0;
    const priceChangePct =
      Number.isFinite(last) && Number.isFinite(open24h) && open24h !== 0 ? (priceChange / open24h) * 100 : 0;

    res.status(200).json({
      price: last,
      priceChange,
      priceChangePct,
      volume24h,
      high24h,
      low24h,
      klines,
      timestamp: Date.now(),
      source: "coinbase",
      interval,
      granularity,
      limit,
    });
  } catch (e) {
    console.error("BTC price error:", e?.message || e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}
