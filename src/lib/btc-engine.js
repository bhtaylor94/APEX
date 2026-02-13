// lib/btc-engine.js
// BTC Price feed + Technical analysis indicators
// Uses Coinbase Exchange public API (no auth). Binance is geo-restricted for many US deployments.

const COINBASE_BASE = "https://api.exchange.coinbase.com";
const COINBASE_PRODUCT = "BTC-USD";

function intervalToGranularity(interval) {
  // Coinbase granularity is in seconds.
  // Supported granularities are typically: 60, 300, 900, 3600, 21600, 86400.
  switch (interval) {
    case "1m":
      return 60;
    case "5m":
      return 300;
    case "15m":
      return 900;
    case "1h":
      return 3600;
    case "6h":
      return 21600;
    case "1d":
      return 86400;
    default:
      return 60;
  }
}

function headers() {
  // Some edge networks are picky without a UA.
  return {
    "User-Agent": "ApexBot/1.0",
    Accept: "application/json",
  };
}

export async function fetchBTCTicker() {
  // Coinbase: /products/<product-id>/ticker
  const tickerRes = await fetch(`${COINBASE_BASE}/products/${COINBASE_PRODUCT}/ticker`, {
    headers: headers(),
  });
  if (!tickerRes.ok) {
    const txt = await tickerRes.text().catch(() => "");
    throw new Error(`Coinbase ticker ${tickerRes.status} ${txt}`);
  }
  const ticker = await tickerRes.json();

  // Coinbase: /products/<product-id>/stats (24h)
  const statsRes = await fetch(`${COINBASE_BASE}/products/${COINBASE_PRODUCT}/stats`, {
    headers: headers(),
  });
  if (!statsRes.ok) {
    const txt = await statsRes.text().catch(() => "");
    throw new Error(`Coinbase stats ${statsRes.status} ${txt}`);
  }
  const stats = await statsRes.json();

  const price = parseFloat(ticker.price);
  const open = parseFloat(stats.open);
  const priceChange = price - open;
  const priceChangePct = open > 0 ? (priceChange / open) * 100 : 0;

  return {
    price,
    volume24h: parseFloat(stats.volume),
    priceChange,
    priceChangePct,
    high24h: parseFloat(stats.high),
    low24h: parseFloat(stats.low),
    timestamp: Date.now(),
  };
}

export async function fetchBTCKlines(interval = "1m", limit = 100) {
  const granularity = intervalToGranularity(interval);
  const end = new Date();
  const start = new Date(end.getTime() - granularity * 1000 * Math.max(10, limit));

  // Coinbase candles return: [ time, low, high, open, close, volume ]
  // and are typically returned in reverse chronological order.
  const url = new URL(`${COINBASE_BASE}/products/${COINBASE_PRODUCT}/candles`);
  url.searchParams.set("granularity", String(granularity));
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());

  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Coinbase candles ${res.status} ${txt}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error(`Coinbase candles unexpected response`);
  }

  const candles = data
    .slice(0, limit)
    .map((k) => ({
      // k[0] is epoch seconds
      openTime: k[0] * 1000,
      low: parseFloat(k[1]),
      high: parseFloat(k[2]),
      open: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: (k[0] + granularity) * 1000,
    }))
    .sort((a, b) => a.openTime - b.openTime);

  return candles;
}

// ── Technical Indicators ──

export function sma(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((s, v) => s + v, 0) / period;
}

export function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

export function rsi(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const recent = changes.slice(-period);
  let gains = 0,
    losses = 0;
  for (const c of recent) {
    if (c > 0) gains += c;
    else losses += Math.abs(c);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export function macd(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  const macdLine = ema12 - ema26;
  const mH = [];
  const k12 = 2 / 13,
    k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    mH.push(e12 - e26);
  }
  const sig = mH.length >= 9 ? ema(mH, 9) : macdLine;
  return { macd: macdLine, signal: sig || 0, histogram: macdLine - (sig || 0) };
}

export function momentum(closes, period = 10) {
  if (closes.length < period + 1) return 0;
  const cur = closes[closes.length - 1];
  const past = closes[closes.length - 1 - period];
  return ((cur - past) / past) * 100;
}

export function bollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const avg = sma(closes, period);
  const slice = closes.slice(-period);
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / period);
  return {
    upper: avg + mult * std,
    middle: avg,
    lower: avg - mult * std,
    percentB: (closes[closes.length - 1] - (avg - mult * std)) / (mult * 2 * std),
  };
}

export function vwMomentum(klines, period = 10) {
  if (klines.length < period) return 0;
  const recent = klines.slice(-period);
  let ws = 0,
    tv = 0;
  for (let i = 1; i < recent.length; i++) {
    ws +=
      ((recent[i].close - recent[i - 1].close) / recent[i - 1].close) *
      recent[i].volume;
    tv += recent[i].volume;
  }
  return tv > 0 ? (ws / tv) * 100 : 0;
}

// ── Composite Signal Generator ──

export function generateSignals(klines) {
  if (!klines || klines.length < 30) {
    return { direction: "neutral", confidence: 0, compositeScore: 0, signals: {} };
  }

  const closes = klines.map((k) => k.close);
  const price = closes[closes.length - 1];

  const rsiVal = rsi(closes, 14);
  const macdVal = macd(closes);
  const mom5 = momentum(closes, 5);
  const bb = bollingerBands(closes, 20, 2);
  const vwm = vwMomentum(klines, 10);
  const sma5 = sma(closes, 5);
  const sma20 = sma(closes, 20);

  const scores = {};

  // RSI — mean reversion
  scores.rsi =
    rsiVal > 75 ? -0.8 : rsiVal > 65 ? -0.3 : rsiVal < 25 ? 0.8 : rsiVal < 35 ? 0.3 : 0;

  // MACD — trend momentum
  scores.macd =
    macdVal.histogram > 0 && macdVal.macd > macdVal.signal
      ? 0.6
      : macdVal.histogram < 0 && macdVal.macd < macdVal.signal
        ? -0.6
        : macdVal.histogram > 0
          ? 0.2
          : -0.2;

  // Short-term momentum
  scores.momentum =
    mom5 > 0.3 ? 0.7 : mom5 > 0.1 ? 0.3 : mom5 < -0.3 ? -0.7 : mom5 < -0.1 ? -0.3 : 0;

  // Bollinger Bands — mean reversion at extremes
  scores.bb = bb
    ? bb.percentB > 1
      ? -0.8
      : bb.percentB > 0.8
        ? -0.4
        : bb.percentB < 0
          ? 0.8
          : bb.percentB < 0.2
            ? 0.4
            : 0
    : 0;

  // Volume-weighted momentum
  scores.vwm = vwm > 0.2 ? 0.5 : vwm < -0.2 ? -0.5 : 0;

  // MA crossover
  scores.maCross =
    sma5 && sma20
      ? (sma5 - sma20) / sma20 > 0.001
        ? 0.4
        : (sma5 - sma20) / sma20 < -0.001
          ? -0.4
          : 0
      : 0;

  // Weighted composite
  const weights = { rsi: 0.2, macd: 0.2, momentum: 0.25, bb: 0.15, vwm: 0.1, maCross: 0.1 };
  let comp = 0;
  for (const [k, s] of Object.entries(scores)) comp += s * (weights[k] || 0);

  const direction = comp > 0.15 ? "up" : comp < -0.15 ? "down" : "neutral";
  const confidence = Math.min(Math.abs(comp) / 0.6, 1);

  return {
    direction,
    confidence,
    compositeScore: comp,
    currentPrice: price,
    signals: {
      rsi: { value: rsiVal, score: scores.rsi },
      macd: { value: macdVal, score: scores.macd },
      momentum: { value: mom5, score: scores.momentum },
      bb: { value: bb, score: scores.bb },
      vwm: { value: vwm, score: scores.vwm },
      maCross: { value: sma5 && sma20 ? { sma5, sma20 } : null, score: scores.maCross },
    },
    timestamp: Date.now(),
  };
}
