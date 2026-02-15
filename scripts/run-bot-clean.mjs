import { kvGetJson, kvSetJson } from "./kv.js";
import { getMarkets, getMarket, getOrderbook, placeOrder } from "./kalshi_client.mjs";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function validPx(v) {
  const n = (typeof v === "number") ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 99) return null;
  return n;
}

function calcContracts({ tradeSizeUsd, maxContracts, askCents }) {
  const budgetCents = Math.max(1, Math.round((tradeSizeUsd || 5) * 100));
  const byBudget = Math.floor(budgetCents / askCents);
  return clamp(Math.max(1, byBudget), 1, maxContracts || 5);
}

// ── Binance data fetchers (public, no auth) ──

// Binance.US for US-based deployments (api.binance.com returns 451 from US IPs)
const BINANCE_BASE = "https://api.binance.us";

async function fetchBinanceKlines(limit = 100) {
  const url = `${BINANCE_BASE}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance klines ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
  }));
}

async function fetchBinanceOrderBookImbalance() {
  const url = `${BINANCE_BASE}/api/v3/depth?symbol=BTCUSDT&limit=10`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance depth ${res.status}`);
  const data = await res.json();
  let bidDepth = 0, askDepth = 0;
  for (const [, qty] of data.bids) bidDepth += parseFloat(qty);
  for (const [, qty] of data.asks) askDepth += parseFloat(qty);
  const total = bidDepth + askDepth;
  const ratio = total > 0 ? bidDepth / total : 0.5;
  // >0.60 = UP pressure, <0.40 = DOWN pressure, else neutral
  const signal = ratio > 0.60 ? 1 : ratio < 0.40 ? -1 : 0;
  return { ratio, signal, bidDepth, askDepth };
}

// ── Technical indicators (computed on the fly) ──

function sma(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const recent = changes.slice(-period);
  let gains = 0, losses = 0;
  for (const c of recent) {
    if (c > 0) gains += c;
    else losses += Math.abs(c);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeMACD(closes) {
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  if (!ema12 || !ema26) return { macd: 0, signal: 0, histogram: 0 };
  const macdLine = ema12 - ema26;
  const mH = [];
  const k12 = 2 / 13, k26 = 2 / 27;
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

function computeBollingerBands(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const avg = sma(closes, period);
  const slice = closes.slice(-period);
  const std = Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / period);
  return {
    upper: avg + mult * std,
    middle: avg,
    lower: avg - mult * std,
    percentB: std > 0 ? (closes[closes.length - 1] - (avg - mult * std)) / (mult * 2 * std) : 0.5,
  };
}

// ── Signal generator: requires 3+ of 4 indicators to agree ──

async function getSignal() {
  let klines, obImbalance;
  try {
    [klines, obImbalance] = await Promise.all([
      fetchBinanceKlines(100),
      fetchBinanceOrderBookImbalance(),
    ]);
  } catch (e) {
    console.log("Binance data fetch failed:", e?.message || e);
    return { direction: "neutral", confidence: 0, details: "binance_error" };
  }

  if (!klines || klines.length < 30) {
    return { direction: "neutral", confidence: 0, details: "insufficient_data" };
  }

  const closes = klines.map(k => k.close);
  const price = closes[closes.length - 1];

  // Compute indicators
  const rsiVal = computeRSI(closes, 14);
  const macdVal = computeMACD(closes);
  const bb = computeBollingerBands(closes, 20, 2);

  // Score each indicator: +1 = UP, -1 = DOWN, 0 = neutral
  const indicators = {};

  // RSI: < 30 = oversold (UP), > 70 = overbought (DOWN)
  indicators.rsi = rsiVal < 30 ? 1 : rsiVal > 70 ? -1 : 0;

  // MACD: histogram crossing up = UP, crossing down = DOWN
  indicators.macd = (macdVal.histogram > 0 && macdVal.macd > macdVal.signal) ? 1
    : (macdVal.histogram < 0 && macdVal.macd < macdVal.signal) ? -1 : 0;

  // Bollinger Bands: price at lower band = UP, upper band = DOWN
  indicators.bb = bb ? (bb.percentB < 0.1 ? 1 : bb.percentB > 0.9 ? -1 : 0) : 0;

  // Binance order book imbalance
  indicators.obImbalance = obImbalance.signal;

  // Count agreements
  const upVotes = Object.values(indicators).filter(v => v === 1).length;
  const downVotes = Object.values(indicators).filter(v => v === -1).length;

  console.log("INDICATORS:", {
    rsi: rsiVal.toFixed(1) + " → " + indicators.rsi,
    macd: macdVal.histogram.toFixed(2) + " → " + indicators.macd,
    bb: (bb ? bb.percentB.toFixed(3) : "n/a") + " → " + indicators.bb,
    obImbalance: obImbalance.ratio.toFixed(3) + " → " + indicators.obImbalance,
    upVotes, downVotes,
  });

  // Require 3+ indicators to agree for a signal
  if (upVotes >= 3) {
    const confidence = 0.55 + (upVotes - 3) * 0.15; // 3 agree = 0.55, 4 agree = 0.70
    return { direction: "up", confidence: Math.min(confidence, 0.85), price, indicators };
  }
  if (downVotes >= 3) {
    const confidence = 0.55 + (downVotes - 3) * 0.15;
    return { direction: "down", confidence: Math.min(confidence, 0.85), price, indicators };
  }

  console.log("No trade — indicators disagree (UP=" + upVotes + " DOWN=" + downVotes + ")");
  return { direction: "neutral", confidence: 0, price, indicators };
}


// Exit logic removed — contracts settle at $1 or $0 in 15 minutes.
// Risk is controlled purely through position sizing (tradeSizeUsd / maxContracts).

function probYesFromSignal(direction, confidence) {
  const c = clamp(Number(confidence || 0), 0, 1);
  const p = 0.5 + c * 0.35;
  if (String(direction).toLowerCase() === "down") return 1 - p;
  if (String(direction).toLowerCase() === "up") return p;
  return 0.5;
}

async function getExecutablePrices(ticker) {
  // Prefer snapshot: GET /markets/{ticker}
  try {
    const m = await getMarket(ticker);
    const mm = m?.market || m;

    const yesAsk = validPx(mm?.yes_ask ?? mm?.yesAsk ?? null);
    const noAsk  = validPx(mm?.no_ask  ?? mm?.noAsk  ?? null);
    const yesBid = validPx(mm?.yes_bid ?? mm?.yesBid ?? null);
    const noBid  = validPx(mm?.no_bid  ?? mm?.noBid  ?? null);

    if (yesAsk || noAsk || yesBid || noBid) {
      return { yesAsk, noAsk, yesBid, noBid, source: "snapshot" };
    }
  } catch (_) {}

  // Fallback: orderbook (if available)
  try {
    const ob = await getOrderbook(ticker, 1);
    const book = ob?.orderbook || ob?.order_book || ob;

    const yesAsks = book?.yes_asks || book?.yesAsks || book?.yes || [];
    const noAsks  = book?.no_asks  || book?.noAsks  || book?.no  || [];
    const yesBids = book?.yes_bids || book?.yesBids || [];
    const noBids  = book?.no_bids  || book?.noBids  || [];

    const yesAsk = validPx(yesAsks?.[0]?.price ?? null);
    const noAsk  = validPx(noAsks?.[0]?.price  ?? null);
    const yesBid = validPx(yesBids?.[0]?.price ?? null);
    const noBid  = validPx(noBids?.[0]?.price  ?? null);

    return { yesAsk, noAsk, yesBid, noBid, source: "orderbook" };
  } catch (_) {}

  return { yesAsk: null, noAsk: null, yesBid: null, noBid: null, source: "none" };
}

async function main() {
  const cfg = (await kvGetJson("bot:config")) || {};

  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 5);
  const maxContracts = Number(cfg.maxContracts ?? 5);
  const minConfidence = Number(cfg.minConfidence ?? 0.55);
  const minEdge = Number(cfg.minEdge ?? 5);
  const minEntryPriceCents = Number(cfg.minEntryPriceCents ?? 35);
  const maxEntryPriceCents = Number(cfg.maxEntryPriceCents ?? 80);
  const minMinutesToCloseToEnter = Number(cfg.minMinutesToCloseToEnter ?? 10);

  console.log("CONFIG:", {
    enabled, mode, seriesTicker,
    tradeSizeUsd, maxContracts,
    minConfidence, minEdge,
    priceband: minEntryPriceCents + "¢–" + maxEntryPriceCents + "¢",
    minMinutesToCloseToEnter,
  });

  if (!enabled) return console.log("Bot disabled — exiting.");

  // Check if we already have an open position — skip entry if so (let it settle)
  try {
    const pos = await kvGetJson("bot:position");
    if (pos && pos.ticker) {
      console.log("HOLDING position — letting it settle:", pos.side?.toUpperCase(), pos.count + "x", pos.ticker, "entry=" + pos.entryPriceCents + "¢");
      return;
    }
  } catch (e) {
    console.log("Position check error (non-fatal):", e?.message || e);
  }

  const sig = await getSignal();
  console.log("SIGNAL:", sig);

  const confidence = Number(sig.confidence || 0);
  if (confidence < minConfidence) {
    console.log("No trade — confidence too low:", confidence, "<", minConfidence);
    return;
  }

  const pYes = probYesFromSignal(sig.direction, confidence);
  const predYes = clamp(Math.round(pYes * 100), 1, 99);
  const predNo = 100 - predYes;

  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  console.log("Markets source: series(" + seriesTicker + ") — found:", markets.length);

  const prefix = seriesTicker + "-";
  const now = Date.now();
  const candidates = markets
    .filter(m => {
      if (typeof m?.ticker !== "string" || !m.ticker.startsWith(prefix)) return false;
      // Time gate: only enter markets with enough time remaining
      const closeTs = m.close_time ? new Date(m.close_time).getTime()
        : m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
      if (closeTs > 0) {
        const minsLeft = (closeTs - now) / 60000;
        if (minsLeft < minMinutesToCloseToEnter) {
          return false;
        }
      }
      return true;
    })
    .sort((a,b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 30);

  if (!candidates.length) {
    console.log("No tradable markets found (after prefix + time gate filter):", prefix);
    return;
  }

  let best = null;

  for (const m of candidates) {
    const ticker = m.ticker;

    const px = await getExecutablePrices(ticker);
    const yesAsk = validPx(px.yesAsk ?? m.yes_ask ?? m.yesAsk ?? null);
    const noAsk  = validPx(px.noAsk  ?? m.no_ask  ?? m.noAsk  ?? null);

    // Price band filter: only trade contracts priced 35¢–80¢
    const yesOk = yesAsk && yesAsk >= minEntryPriceCents && yesAsk <= maxEntryPriceCents;
    const noOk  = noAsk  && noAsk  >= minEntryPriceCents && noAsk  <= maxEntryPriceCents;

    if (!yesOk && !noOk) continue;

    const edgeYes = yesOk ? (predYes - yesAsk) : -9999;
    const edgeNo  = noOk  ? (predNo  - noAsk)  : -9999;

    const side = edgeYes >= edgeNo ? "yes" : "no";
    const askCents = side === "yes" ? yesAsk : noAsk;
    const edge = side === "yes" ? edgeYes : edgeNo;

    const cand = {
      ticker,
      volume: Number(m.volume || 0),
      side,
      askCents,
      edge,
      pxSource: px.source
    };

    if (!best || cand.edge > best.edge) best = cand;
  }

  if (!best) {
    console.log("No trade — no candidate had a valid ask (snapshot+orderbook both missing).");
    return;
  }

  console.log("Selected market:", best);
  console.log(
    "Edge check:",
    "predYES=" + predYes + "¢",
    "predNO=" + predNo + "¢",
    "chosen=" + best.side.toUpperCase(),
    "ask=" + best.askCents + "¢",
    "edge=" + best.edge + "¢",
    "minEdge=" + minEdge + "¢",
    "pxSource=" + best.pxSource
  );

  if (best.edge < minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.askCents });
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.askCents + "¢ (mode=" + mode + ")";
  console.log("Decision:", line);

  if (mode !== "live") {
    console.log("PAPER MODE — would place:", line);
    return;
  }

  const res = await placeOrder({ ticker: best.ticker, side: best.side, count, priceCents: best.askCents, action: "buy" });
  console.log("ORDER RESULT:", res);

  // best effort position write (won’t crash if Upstash token is read-only)
  try {
    await kvSetJson("bot:position", {
      ticker: best.ticker,
      side: best.side,
      entryPriceCents: best.askCents,
      count,
      openedTs: Date.now(),
      orderId: res?.order?.order_id || null
    });
    console.log("Saved bot:position");
  } catch (e) {
    console.log("WARN: bot:position not saved (Upstash token likely read-only):", e?.message || e);
  }
}

main().catch((e) => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
