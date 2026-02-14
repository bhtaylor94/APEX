function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

async function fetchCoinbasePrice() {
  // Coinbase public spot
  const r = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot");
  const j = await r.json();
  const p = Number(j?.data?.amount);
  if (!Number.isFinite(p)) throw new Error("Coinbase price parse failed");
  return p;
}

async function fetchCoinbaseCandles1m(limit=60) {
  // Coinbase Exchange candles (public). granularity=60 seconds
  // Returns [time, low, high, open, close, volume]
  const end = new Date();
  const start = new Date(end.getTime() - limit * 60_000);
  const url = new URL("https://api.exchange.coinbase.com/products/BTC-USD/candles");
  url.searchParams.set("granularity", "60");
  url.searchParams.set("start", start.toISOString());
  url.searchParams.set("end", end.toISOString());

  const r = await fetch(url.toString(), { headers: { "User-Agent": "apex-bot" }});
  if (!r.ok) throw new Error("Coinbase candles error: " + r.status);
  const arr = await r.json();
  const candles = Array.isArray(arr) ? arr : [];
  // sort ascending by time
  candles.sort((a,b)=>a[0]-b[0]);
  return candles.map(c => ({ t:c[0], open:c[3], close:c[4], high:c[2], low:c[1], vol:c[5] }));
}

function rsi(closes, period=14) {
  if (closes.length < period + 1) return 50;
  let gains=0, losses=0;
  for (let i=closes.length-period; i<closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d>0) gains += d; else losses += -d;
  }
  if (losses === 0) return 100;
  const rs = (gains/period)/(losses/period);
  return 100 - 100/(1+rs);
}

export async function getBTCSignal() {
  const candles = await fetchCoinbaseCandles1m(60);
  const closes = candles.map(x => x.close);
  const last = closes[closes.length - 1] ?? await fetchCoinbasePrice();

  // momentum: last vs 10-min avg
  const slice = closes.slice(-10);
  const avg10 = slice.reduce((s,v)=>s+v,0) / (slice.length || 1);
  const mom = (last - avg10) / avg10; // ~ -0.01..0.01 typical
  const r = rsi(closes, 14);

  // map to direction + confidence
  let direction = "neutral";
  if (mom > 0.0006) direction = "up";
  if (mom < -0.0006) direction = "down";

  // confidence: blend momentum strength + RSI tilt
  const momConf = clamp(Math.abs(mom) / 0.003, 0, 1);      // 0..1
  const rsiTilt = clamp(Math.abs(r - 50) / 30, 0, 1);      // 0..1
  const confidence = clamp(0.10 + 0.60*momConf + 0.30*rsiTilt, 0, 1);

  return { direction, confidence: Number(confidence.toFixed(3)), price: Number(last.toFixed(3)), rsi: Number(r.toFixed(2)), mom: Number(mom.toFixed(6)) };
}
