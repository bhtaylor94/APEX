// lib/btc-engine.js
// BTC Price feed + Technical analysis indicators
// Uses Binance public API (free, no auth, ~1s updates)

const BINANCE_BASE = "https://api.binance.com/api/v3";

export async function fetchBTCTicker() {
  const res = await fetch(`${BINANCE_BASE}/ticker/24hr?symbol=BTCUSDT`);
  if (!res.ok) throw new Error(`Binance ticker ${res.status}`);
  const data = await res.json();
  return {
    price: parseFloat(data.lastPrice),
    volume24h: parseFloat(data.volume),
    priceChange: parseFloat(data.priceChange),
    priceChangePct: parseFloat(data.priceChangePercent),
    high24h: parseFloat(data.highPrice),
    low24h: parseFloat(data.lowPrice),
    timestamp: Date.now(),
  };
}

export async function fetchBTCKlines(interval = "1m", limit = 100) {
  const res = await fetch(
    `${BINANCE_BASE}/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`
  );
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const data = await res.json();
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
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
