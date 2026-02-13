// pages/api/btc-price.js
// Proxies Binance BTC data — avoids CORS issues on client

export default async function handler(req, res) {
  try {
    const { interval, limit } = req.query;

    const [tickerRes, klinesRes] = await Promise.all([
      fetch("https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"),
      fetch(
        `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${interval || "1m"}&limit=${limit || "100"}`
      ),
    ]);

    const ticker = await tickerRes.json();
    const rawKlines = await klinesRes.json();

    if (!Array.isArray(rawKlines)) {
      const msg = rawKlines && (rawKlines.msg || rawKlines.message) ? (rawKlines.msg || rawKlines.message) : JSON.stringify(rawKlines);
      throw new Error(`Binance klines unexpected response: ${msg}`);
    }

    const klines = rawKlines.map((k) => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
    }));

    res.status(200).json({
      price: parseFloat(ticker.lastPrice),
      priceChange: parseFloat(ticker.priceChange),
      priceChangePct: parseFloat(ticker.priceChangePercent),
      volume24h: parseFloat(ticker.volume),
      high24h: parseFloat(ticker.highPrice),
      low24h: parseFloat(ticker.lowPrice),
      klines,
      timestamp: Date.now(),
    });
  } catch (e) {
    console.error("BTC price error:", e.message);
    res.status(500).json({ error: e.message });
  }
}
