import { kvGetJson, kvSetJson } from "./kv.js";
import { getMarkets, getMarket, getOrderbook, kalshiFetch } from "./kalshi_client.mjs";

// ── Series definitions ──

const SERIES_DEFS = {
  "15M": {
    suffix: "15M",
    defaultSeriesTicker: "KXBTC15M",
    signal: "getSignal15M",
    indicators: ["rsi", "vwap", "ob"],
    defaultWeights: { rsi: 2, vwap: 2, ob: 2 },
    defaults: {
      minMinutesToCloseToEnter: 10,
      cooldownMinutes: 5,
      minEntryPriceCents: 35,
      maxEntryPriceCents: 80,
      makerOffsetCents: 2,
      minEdge: 5,
      atrMaxPct: 0.15,
    },
  },
  "1H": {
    suffix: "1H",
    defaultSeriesTicker: "KXBTC",
    signal: "bracket",
    indicators: [],
    defaultWeights: {},
    defaults: {
      minMinutesToCloseToEnter: 60,
      cooldownMinutes: 15,
      minEntryPriceCents: 8,
      maxEntryPriceCents: 85,
      makerOffsetCents: 2,
      minEdge: 3,
      atrMaxPct: 0.25,
    },
  },
};

// ── KV key helper ──

function kvKey(base, suffix) {
  return base + ":" + suffix;
}

// ── Utilities ──

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function validPx(v) {
  const n = (typeof v === "number") ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 99) return null;
  return n;
}

function calcContracts({ tradeSizeUsd, maxContracts, askCents, winRate, confidence }) {
  const maxBet = 3;
  const confScaled = Math.max(0.2, Math.min(1, confidence || 0.5)) * maxBet;
  const b = (100 - askCents) / askCents;
  const p = Math.max(0.3, Math.min(0.8, (winRate || 50) / 100));
  const q = 1 - p;
  const kellyFraction = Math.max(0, (b * p - q) / b);
  const kellyScale = Math.max(0.5, Math.min(1, kellyFraction * 0.5 + 0.5));
  const scaledBet = confScaled * kellyScale;
  const budgetCents = Math.max(1, Math.round(scaledBet * 100));
  const byBudget = Math.floor(budgetCents / askCents);
  return clamp(Math.max(1, byBudget), 1, maxContracts || 10);
}

// ── Coinbase data fetchers ──

const COINBASE_BASE = "https://api.exchange.coinbase.com";

async function fetchCoinbaseCandles(limit = 100) {
  const url = `${COINBASE_BASE}/products/BTC-USD/candles?granularity=60`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const data = await res.json();
  return data.slice(0, limit).reverse()
    .map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
}

async function fetchCoinbaseCandles5m(limit = 50) {
  try {
    const res = await fetch(`${COINBASE_BASE}/products/BTC-USD/candles?granularity=300`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
  } catch { return null; }
}

async function fetchCoinbaseCandles15m(limit = 30) {
  try {
    const res = await fetch(`${COINBASE_BASE}/products/BTC-USD/candles?granularity=900`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
  } catch { return null; }
}

async function fetchCoinbaseOrderBook() {
  const url = `${COINBASE_BASE}/products/BTC-USD/book?level=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase book ${res.status}`);
  const data = await res.json();
  let bidDepth = 0, askDepth = 0;
  for (const [, size] of (data.bids || []).slice(0, 5)) bidDepth += parseFloat(size);
  for (const [, size] of (data.asks || []).slice(0, 5)) askDepth += parseFloat(size);
  const total = bidDepth + askDepth;
  return { ratio: total > 0 ? bidDepth / total : 0.5, bidDepth, askDepth };
}

// ── Technical indicators ──

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

function computeATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length < period) return null;
  return trs.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function computeEMA(values, period) {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = computeEMA(macdLine.slice(slow - 1), signal);
  // Align signal line with macd line
  const offset = macdLine.length - signalLine.length;
  const lastMacd = macdLine[macdLine.length - 1];
  const lastSignal = signalLine[signalLine.length - 1];
  const prevMacd = macdLine[macdLine.length - 2];
  const prevSignal = signalLine.length >= 2 ? signalLine[signalLine.length - 2] : lastSignal;
  const histogram = lastMacd - lastSignal;
  const crossUp = prevMacd <= prevSignal && lastMacd > lastSignal;
  const crossDown = prevMacd >= prevSignal && lastMacd < lastSignal;
  return { macd: lastMacd, signal: lastSignal, histogram, crossUp, crossDown };
}

function computeEMACrossover(closes, fastPeriod = 9, slowPeriod = 21) {
  if (closes.length < slowPeriod + 1) return null;
  const fast = computeEMA(closes, fastPeriod);
  const slow = computeEMA(closes, slowPeriod);
  const lastFast = fast[fast.length - 1];
  const lastSlow = slow[slow.length - 1];
  return { fast: lastFast, slow: lastSlow, bullish: lastFast > lastSlow };
}

function computeVWAP(candles) {
  let cumVolPrice = 0, cumVol = 0;
  for (const c of candles) {
    const typical = ((c.high || c.close) + (c.low || c.close) + c.close) / 3;
    const vol = c.volume || 0;
    cumVolPrice += typical * vol;
    cumVol += vol;
  }
  return cumVol > 0 ? cumVolPrice / cumVol : null;
}

// ── Probability engine (1H bracket markets) ──

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

function computeRealizedVol(candles1m, lookback = 60) {
  const subset = candles1m.slice(-Math.min(candles1m.length, lookback + 1));
  if (subset.length < 10) return 0.50;
  const returns = [];
  for (let i = 1; i < subset.length; i++) {
    if (subset[i].close > 0 && subset[i - 1].close > 0)
      returns.push(Math.log(subset[i].close / subset[i - 1].close));
  }
  if (returns.length < 5) return 0.50;
  const variance = returns.reduce((s, r) => s + r * r, 0) / returns.length;
  return Math.sqrt(variance * 525600);
}

function fairValueAbove(spot, strike, sigmaAnnual, tauYears) {
  if (tauYears <= 0) return spot >= strike ? 1 : 0;
  const sqrtTau = Math.sqrt(tauYears);
  const d2 = (Math.log(spot / strike) - (sigmaAnnual * sigmaAnnual / 2) * tauYears)
              / (sigmaAnnual * sqrtTau);
  return normalCDF(d2);
}

function parseStrike(ticker) {
  const m = ticker.match(/-([TB])(\d+\.?\d*)$/);
  if (!m) return null;
  return { strike: parseFloat(m[2]), type: m[1] === "T" ? "above" : "below" };
}

function findBestBracketTrade(markets, spot, sigma, tauYears, priceBand, minEdgeCents, vwapSignal) {
  let best = null;
  for (const m of markets) {
    const parsed = parseStrike(m.ticker);
    if (!parsed) continue;

    const closeTs = m.close_time ? new Date(m.close_time).getTime()
      : m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
    const thisTau = closeTs > 0 ? (closeTs - Date.now()) / (365.25 * 24 * 3600 * 1000) : tauYears;

    let fairProb = fairValueAbove(spot, parsed.strike, sigma, thisTau);
    fairProb = Math.max(0.01, Math.min(0.99, fairProb + vwapSignal * 0.03));
    const fairCents = Math.round(fairProb * 100);

    const yesAsk = validPx(m.yes_ask);
    if (yesAsk && yesAsk >= priceBand[0] && yesAsk <= priceBand[1]) {
      const edge = fairCents - yesAsk;
      if (edge >= minEdgeCents && (!best || edge > best.edge)) {
        best = { ticker: m.ticker, side: "yes", askPrice: yesAsk, fairCents,
                 edge, strike: parsed.strike, type: parsed.type, closeTs };
      }
    }

    const noFairCents = 100 - fairCents;
    const noAsk = validPx(m.no_ask);
    if (noAsk && noAsk >= priceBand[0] && noAsk <= priceBand[1]) {
      const edge = noFairCents - noAsk;
      if (edge >= minEdgeCents && (!best || edge > best.edge)) {
        best = { ticker: m.ticker, side: "no", askPrice: noAsk, fairCents: noFairCents,
                 edge, strike: parsed.strike, type: parsed.type, closeTs };
      }
    }
  }
  return best;
}

// ── Adaptive learning: series-aware ──

async function getLearnedWeights(suffix, seriesDef) {
  const learned = await kvGetJson(kvKey("bot:learned_weights", suffix));
  if (!learned || !learned.weights) return { ...seriesDef.defaultWeights };
  return { ...seriesDef.defaultWeights, ...learned.weights };
}

async function learnFromTrades(suffix, seriesDef) {
  const history = (await kvGetJson("bot:trade_history")) || [];
  const tradesWithSignals = history.filter(t => t.signal && (t.seriesSuffix || "15M") === suffix);
  if (tradesWithSignals.length < 5) return null;

  const recent = tradesWithSignals.slice(-20);
  const INDICATORS = seriesDef.indicators;
  const DEFAULT_WEIGHTS = seriesDef.defaultWeights;

  const indicatorStats = {};
  for (const ind of INDICATORS) {
    indicatorStats[ind] = { correct: 0, wrong: 0, neutral: 0 };
  }

  let totalWins = 0, totalLosses = 0, totalPnl = 0;
  const entryPriceStats = { low: 0, lowWin: 0, mid: 0, midWin: 0, high: 0, highWin: 0 };
  const comboStats = {};
  const hourlyStats = {};
  const edgeStats = { small: 0, smallWin: 0, medium: 0, mediumWin: 0, large: 0, largeWin: 0 };

  for (const trade of recent) {
    const won = trade.result === "win" || trade.result === "tp_exit";
    const lost = trade.result === "loss";
    if (won) totalWins++;
    if (lost) totalLosses++;
    totalPnl += (trade.pnlCents || 0);

    const ep = trade.entryPriceCents || 50;
    if (ep < 45) { entryPriceStats.low++; if (won) entryPriceStats.lowWin++; }
    else if (ep <= 65) { entryPriceStats.mid++; if (won) entryPriceStats.midWin++; }
    else { entryPriceStats.high++; if (won) entryPriceStats.highWin++; }

    // Track edge stats for bracket trades
    if (trade.signal?.type === "bracket" && trade.signal.edge != null) {
      const e = trade.signal.edge;
      if (e >= 8) { edgeStats.large++; if (won) edgeStats.largeWin++; }
      else if (e >= 5) { edgeStats.medium++; if (won) edgeStats.mediumWin++; }
      else { edgeStats.small++; if (won) edgeStats.smallWin++; }
    }

    const indicators = trade.signal?.indicators;
    if (!indicators) {
      // Still track hourly stats for bracket trades
      const ts = trade.openedTs || trade.settledTs || trade.closedTs;
      if (ts) {
        const hour = new Date(ts).getUTCHours();
        if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, total: 0 };
        hourlyStats[hour].total++;
        if (won) hourlyStats[hour].wins++;
      }
      continue;
    }
    const tradeDir = trade.signal.direction;

    for (const ind of INDICATORS) {
      const vote = indicators[ind] || 0;
      if (vote === 0) { indicatorStats[ind].neutral++; continue; }
      const votedUp = vote > 0;
      const votedWithTrade = (tradeDir === "up" && votedUp) || (tradeDir === "down" && !votedUp);
      if ((votedWithTrade && won) || (!votedWithTrade && lost)) indicatorStats[ind].correct++;
      else indicatorStats[ind].wrong++;
    }

    for (let a = 0; a < INDICATORS.length; a++) {
      for (let b = a + 1; b < INDICATORS.length; b++) {
        const va = indicators[INDICATORS[a]] || 0;
        const vb = indicators[INDICATORS[b]] || 0;
        if (va !== 0 && vb !== 0 && va === vb) {
          const key = INDICATORS[a] + "+" + INDICATORS[b];
          if (!comboStats[key]) comboStats[key] = { wins: 0, total: 0 };
          comboStats[key].total++;
          if (won) comboStats[key].wins++;
        }
      }
    }

    const ts = trade.openedTs || trade.settledTs || trade.closedTs;
    if (ts) {
      const hour = new Date(ts).getUTCHours();
      if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, total: 0 };
      hourlyStats[hour].total++;
      if (won) hourlyStats[hour].wins++;
    }
  }

  const newWeights = {};
  for (const ind of INDICATORS) {
    const s = indicatorStats[ind];
    const total = s.correct + s.wrong;
    if (total < 3) { newWeights[ind] = DEFAULT_WEIGHTS[ind]; continue; }
    const accuracy = s.correct / total;
    const multiplier = Math.max(0.25, Math.min(3, accuracy * 2));
    newWeights[ind] = Math.round(DEFAULT_WEIGHTS[ind] * multiplier * 100) / 100;
  }

  const totalTrades = totalWins + totalLosses;
  const winRate = totalTrades > 0 ? totalWins / totalTrades : 0.5;

  let lossStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].result === "loss") lossStreak++;
    else break;
  }

  let minScoreThreshold = 2;
  if (lossStreak >= 5) minScoreThreshold = 2.25;
  else if (winRate >= 0.65 && totalTrades >= 5) minScoreThreshold = 1.5;
  else if (winRate < 0.35 && totalTrades >= 5) minScoreThreshold = 2;

  const tradingMode = lossStreak >= 5 ? "recovery" : winRate >= 0.6 ? "aggressive" : "normal";

  let priceAdvice = null;
  if (entryPriceStats.low >= 30 && entryPriceStats.lowWin / entryPriceStats.low < 0.3) {
    priceAdvice = "low_price_losing";
  }
  if (entryPriceStats.high >= 30 && entryPriceStats.highWin / entryPriceStats.high < 0.3) {
    priceAdvice = priceAdvice ? "both_extremes_losing" : "high_price_losing";
  }

  const result = {
    weights: newWeights, minScoreThreshold,
    winRate: Math.round(winRate * 100), totalTrades, totalPnl, lossStreak,
    mode: tradingMode, indicatorStats, comboStats, hourlyStats, edgeStats, priceAdvice,
    lastUpdated: Date.now(),
  };

  await kvSetJson(kvKey("bot:learned_weights", suffix), result);
  console.log("LEARNING [" + suffix + "]:", JSON.stringify({
    weights: newWeights, minScore: minScoreThreshold, mode: tradingMode,
    winRate: result.winRate + "%", trades: totalTrades, pnl: "$" + (totalPnl / 100).toFixed(2),
    lossStreak, priceAdvice,
  }));

  return result;
}

// ── Signal generators ──

function getSignal15M(candles, closes, obRatio, weights, minScoreThreshold, candles5m, candles15m) {
  const price = closes[closes.length - 1];

  const rsiVal = computeRSI(closes, 3);
  const vwap = computeVWAP(candles);
  const vwapDev = vwap ? (price - vwap) / vwap : 0;

  const indicators = { rsi: 0, vwap: 0, ob: 0 };
  let score = 0;
  const breakdown = {};

  if (rsiVal < 15) { indicators.rsi = 1; } else if (rsiVal > 85) { indicators.rsi = -1; }
  score += indicators.rsi * (weights.rsi || 2);
  breakdown.rsi = (indicators.rsi > 0 ? "+" : indicators.rsi < 0 ? "-" : "") +
    (indicators.rsi !== 0 ? (weights.rsi || 2).toFixed(1) : "0") + " (rsi3=" + rsiVal.toFixed(1) + ")";

  if (vwap) {
    if (vwapDev < -0.0015) { indicators.vwap = 1; } else if (vwapDev > 0.0015) { indicators.vwap = -1; }
  }
  score += indicators.vwap * (weights.vwap || 2);
  breakdown.vwap = (indicators.vwap > 0 ? "+" : indicators.vwap < 0 ? "-" : "") +
    (indicators.vwap !== 0 ? (weights.vwap || 2).toFixed(1) : "0") + " (dev=" + (vwapDev * 100).toFixed(3) + "%)";

  if (obRatio > 0.65) { indicators.ob = 1; } else if (obRatio < 0.35) { indicators.ob = -1; }
  score += indicators.ob * (weights.ob || 2);
  breakdown.ob = (indicators.ob > 0 ? "+" : indicators.ob < 0 ? "-" : "") +
    (indicators.ob !== 0 ? (weights.ob || 2).toFixed(1) : "0") + " (ob=" + obRatio.toFixed(3) + ")";

  const maxScore = (weights.rsi || 2) + (weights.vwap || 2) + (weights.ob || 2);

  // Multi-timeframe confirmation
  let mtfBoost = 0;
  const sigDir = score > 0 ? 1 : score < 0 ? -1 : 0;
  if (sigDir !== 0) {
    if (candles5m && candles5m.length >= 10) {
      const c5 = candles5m.map(c => c.close);
      const rsi5 = computeRSI(c5, 5);
      const rsiDir = rsi5 < 35 ? 1 : rsi5 > 65 ? -1 : 0;
      if (rsiDir !== 0 && rsiDir === sigDir) mtfBoost += 0.5;
    }
    if (candles15m && candles15m.length >= 10) {
      const c15 = candles15m.map(c => c.close);
      const rsi15 = computeRSI(c15, 7);
      const rsiDir = rsi15 < 35 ? 1 : rsi15 > 65 ? -1 : 0;
      if (rsiDir !== 0 && rsiDir === sigDir) mtfBoost += 0.5;
    }
    if (mtfBoost > 0) score += mtfBoost * sigDir;
  }

  const absScore = Math.abs(score);
  if (absScore < minScoreThreshold) {
    return { direction: "neutral", score, confidence: 0, price, breakdown, indicators, maxScore, mtfBoost };
  }

  const confidence = absScore / maxScore;
  const direction = score > 0 ? "up" : "down";
  const predProb = 50 + confidence * 30;

  return { direction, score, confidence, predProb, price, breakdown, indicators, maxScore, mtfBoost };
}

// ── Kalshi helpers ──

async function getKalshiPositions() {
  try {
    const data = await kalshiFetch("/trade-api/v2/portfolio/positions?limit=100&settlement_status=unsettled", { method: "GET" });
    return data?.market_positions || data?.positions || [];
  } catch (e) {
    console.log("Failed to fetch Kalshi positions:", e?.message || e);
    return [];
  }
}

async function getBestBidFromOrderbook(ticker, side) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ob = await getOrderbook(ticker, 10);
      const book = ob?.orderbook || ob?.order_book || ob;
      const bids = book?.[side] || [];
      if (bids.length === 0) {
        console.log("ORDERBOOK: " + side + " bids empty for " + ticker + " (attempt " + attempt + ")");
        continue;
      }
      const raw = bids[bids.length - 1];
      const price = validPx(Array.isArray(raw) ? raw[0] : raw?.price ?? raw);
      console.log("ORDERBOOK: " + side + " best bid = " + price + "c for " + ticker);
      return price;
    } catch (e) {
      console.log("ORDERBOOK ERROR (attempt " + attempt + "): " + (e?.message || e));
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

async function getOrderbookPrices(ticker) {
  try {
    const ob = await getOrderbook(ticker, 10);
    const book = ob?.orderbook || ob?.order_book || ob;
    const yesBids = book?.yes || [];
    const noBids = book?.no || [];
    const rawYes = yesBids.length > 0 ? yesBids[yesBids.length - 1] : null;
    const rawNo = noBids.length > 0 ? noBids[noBids.length - 1] : null;
    const bestYesBid = rawYes ? validPx(Array.isArray(rawYes) ? rawYes[0] : rawYes?.price ?? rawYes) : null;
    const bestNoBid = rawNo ? validPx(Array.isArray(rawNo) ? rawNo[0] : rawNo?.price ?? rawNo) : null;
    const yesAsk = bestNoBid ? (100 - bestNoBid) : null;
    const noAsk = bestYesBid ? (100 - bestYesBid) : null;
    return { yesAsk: validPx(yesAsk), noAsk: validPx(noAsk), yesBid: bestYesBid, noBid: bestNoBid };
  } catch (e) {
    console.log("Orderbook prices fetch failed for " + ticker + ":", e?.message || e);
    return { yesAsk: null, noAsk: null, yesBid: null, noBid: null };
  }
}

async function getExecutablePrices(ticker) {
  try {
    const m = await getMarket(ticker);
    const mm = m?.market || m;
    const yesAsk = validPx(mm?.yes_ask ?? mm?.yesAsk ?? null);
    const noAsk  = validPx(mm?.no_ask  ?? mm?.noAsk  ?? null);
    const yesBid = validPx(mm?.yes_bid ?? mm?.yesBid ?? null);
    const noBid  = validPx(mm?.no_bid  ?? mm?.noBid  ?? null);
    if (yesAsk || noAsk) return { yesAsk, noAsk, yesBid, noBid, source: "snapshot" };
  } catch (_) {}
  const obPx = await getOrderbookPrices(ticker);
  return { ...obPx, source: "orderbook" };
}

// ── Cancel unfilled maker orders after timeout ──

async function checkPendingOrder(cfg, suffix) {
  const pending = await kvGetJson(kvKey("bot:pendingOrder", suffix));
  if (!pending || !pending.orderId) return;

  const ageMs = Date.now() - (pending.placedTs || 0);
  const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;

  if (ageMs < timeoutMs) {
    try {
      const orderData = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const order = orderData?.order || orderData;
      if (order.status === "executed" || ((order.fill_count ?? 0) > 0)) {
        console.log("[" + suffix + "] PENDING ORDER FILLED:", pending.orderId);
        let marketCloseTs = null;
        try {
          const mkt = await getMarket(pending.ticker);
          const mm = mkt?.market || mkt;
          marketCloseTs = mm?.close_time ? new Date(mm.close_time).getTime()
            : mm?.expiration_time ? new Date(mm.expiration_time).getTime() : null;
        } catch (_) {}
        await kvSetJson(kvKey("bot:position", suffix), {
          ticker: pending.ticker, side: pending.side, entryPriceCents: pending.limitPrice,
          count: (order.fill_count ?? 0) > 0 ? order.fill_count : pending.count,
          openedTs: pending.placedTs, orderId: pending.orderId, signal: pending.signal, marketCloseTs,
        });
        await kvSetJson(kvKey("bot:pendingOrder", suffix), null);
        return;
      }
    } catch (_) {}
    console.log("[" + suffix + "] PENDING ORDER still resting (" + Math.round(ageMs / 1000) + "s old). Waiting...");
    return;
  }

  console.log("[" + suffix + "] PENDING ORDER TIMEOUT after " + Math.round(ageMs / 1000) + "s. Canceling:", pending.orderId);
  try {
    await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "DELETE" });
    console.log("[" + suffix + "] Order canceled successfully.");
  } catch (e) {
    console.log("[" + suffix + "] Cancel failed:", e?.message || e);
  }
  await kvSetJson(kvKey("bot:pendingOrder", suffix), null);
}

// ── Trade history logging ──

async function logTradeResult(entry) {
  entry.hourUtc = new Date().getUTCHours();
  const history = (await kvGetJson("bot:trade_history")) || [];
  history.push(entry);
  if (history.length > 100) history.splice(0, history.length - 100);
  await kvSetJson("bot:trade_history", history);
}

// ── Daily stats (per-series) ──

async function getDailyStats(suffix) {
  const state = (await kvGetJson(kvKey("bot:daily_stats", suffix))) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.date !== today) {
    const fresh = { date: today, totalTrades: 0, wins: 0, losses: 0, takeProfits: 0, totalPnlCents: 0 };
    await kvSetJson(kvKey("bot:daily_stats", suffix), fresh);
    return fresh;
  }
  return state;
}

async function recordDailyTrade(suffix, type, pnlCents) {
  const stats = await getDailyStats(suffix);
  stats.totalTrades = (stats.totalTrades || 0) + 1;
  stats.totalPnlCents = (stats.totalPnlCents || 0) + pnlCents;
  if (type === "win") stats.wins = (stats.wins || 0) + 1;
  else if (type === "loss") stats.losses = (stats.losses || 0) + 1;
  else if (type === "tp_exit") stats.takeProfits = (stats.takeProfits || 0) + 1;
  await kvSetJson(kvKey("bot:daily_stats", suffix), stats);
  return stats;
}

// ── Combined daily loss check ──

async function checkCombinedDailyLoss(cfg) {
  const maxLossCents = Math.round((Number(cfg.dailyMaxLossUsd ?? 10)) * 100);
  let combinedPnl = 0;
  for (const sKey of Object.keys(SERIES_DEFS)) {
    const stats = await getDailyStats(sKey);
    combinedPnl += (stats.totalPnlCents || 0);
  }
  if (combinedPnl <= -maxLossCents) {
    console.log("DAILY LOSS LIMIT: $" + (combinedPnl / 100).toFixed(2) + " (max -$" + (maxLossCents / 100).toFixed(2) + "). Stopping.");
    return { ok: false, combinedPnl };
  }
  return { ok: true, combinedPnl };
}

// ── Cooldown (per-series) ──

async function checkCooldown(cfg, suffix, seriesDef) {
  const baseCooldownMs = (Number(cfg[suffix === "1H" ? "hourly_cooldownMinutes" : "cooldownMinutes"] ?? seriesDef.defaults.cooldownMinutes)) * 60 * 1000;
  const learned = await kvGetJson(kvKey("bot:learned_weights", suffix));
  const lossStreak = learned?.lossStreak || 0;
  const multiplier = Math.min(2, 1 + lossStreak * 0.25);
  const cooldownMs = baseCooldownMs * multiplier;
  const lastTrade = await kvGetJson(kvKey("bot:lastTradeTs", suffix));
  if (lastTrade && (Date.now() - lastTrade) < cooldownMs) {
    const secsLeft = Math.round((cooldownMs - (Date.now() - lastTrade)) / 1000);
    console.log("[" + suffix + "] COOLDOWN: " + secsLeft + "s remaining" +
      (multiplier > 1 ? " (streak x" + multiplier.toFixed(1) + ")" : "") + ". Skipping.");
    return false;
  }
  return true;
}

// ── KV Migration: move unsuffixed keys to :15M ──

async function migrateOldKeys() {
  const migrated = await kvGetJson("bot:migration_done");
  if (migrated) return;

  const keysToMigrate = ["bot:position", "bot:pendingOrder", "bot:daily_stats", "bot:state", "bot:lastTradeTs", "bot:learned_weights"];
  for (const key of keysToMigrate) {
    const val = await kvGetJson(key);
    if (val != null) {
      const newKey = kvKey(key, "15M");
      const existing = await kvGetJson(newKey);
      if (existing == null) {
        await kvSetJson(newKey, val);
        console.log("MIGRATED: " + key + " -> " + newKey);
      }
    }
  }
  await kvSetJson("bot:migration_done", { ts: Date.now(), version: 2 });
  console.log("KV migration complete.");
}

// ── Run one series cycle ──

async function runSeriesCycle(seriesDef, cfg, sharedData, _log) {
  const suffix = seriesDef.suffix;
  const { candles, candles5m, candles15m, orderBook, kalshiPositions, mode } = sharedData;

  const seriesTickerCfgKey = suffix === "1H" ? "hourlySeriesTicker" : "seriesTicker";
  const seriesTicker = String(cfg[seriesTickerCfgKey] || seriesDef.defaultSeriesTicker).toUpperCase();
  const seriesPrefix = seriesTicker + "-";

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 10);
  const maxContracts = Number(cfg.maxContracts ?? 10);
  const minEdge = Number(cfg[suffix === "1H" ? "hourly_minEdge" : "minEdge"] ?? seriesDef.defaults.minEdge);
  const minEntryPriceCents = Number(cfg[suffix === "1H" ? "hourly_minEntryPriceCents" : "minEntryPriceCents"] ?? seriesDef.defaults.minEntryPriceCents);
  const maxEntryPriceCents = Number(cfg[suffix === "1H" ? "hourly_maxEntryPriceCents" : "maxEntryPriceCents"] ?? seriesDef.defaults.maxEntryPriceCents);
  const minMinutesToCloseToEnter = Number(cfg[suffix === "1H" ? "hourly_minMinutesToCloseToEnter" : "minMinutesToCloseToEnter"] ?? seriesDef.defaults.minMinutesToCloseToEnter);
  const makerOffset = Number(cfg[suffix === "1H" ? "hourly_makerOffsetCents" : "makerOffsetCents"] ?? seriesDef.defaults.makerOffsetCents);
  const atrMaxPct = seriesDef.defaults.atrMaxPct;

  _log("[" + suffix + "] series=" + seriesTicker + " priceband=" + minEntryPriceCents + "-" + maxEntryPriceCents + "c minClose=" + minMinutesToCloseToEnter + "m");

  // ── Handle pending maker orders ──
  await checkPendingOrder(cfg, suffix);
  if (await kvGetJson(kvKey("bot:pendingOrder", suffix))) {
    _log("[" + suffix + "] Pending order still active. Skipping.");
    return { action: "pending_order" };
  }

  // ── CHECK FOR OPEN POSITION ──
  let pos = await kvGetJson(kvKey("bot:position", suffix));

  const relevantPositions = kalshiPositions.filter(p =>
    p.ticker?.startsWith(seriesPrefix) && p.position !== 0 && p.position != null
  );

  // Position recovery
  if ((!pos || !pos.ticker) && relevantPositions.length > 0) {
    if (relevantPositions.length > 1) {
      _log("[" + suffix + "] WARNING: Multiple positions (" + relevantPositions.length + "). Recovering first.");
    }
    const kp = relevantPositions[0];
    const posCount = Math.abs(kp.position || 0);
    const side = (kp.position > 0) ? "yes" : "no";
    _log("[" + suffix + "] RECOVERING: " + side.toUpperCase() + " " + posCount + "x " + kp.ticker);
    let marketCloseTs = null;
    try {
      const mkt = await getMarket(kp.ticker);
      const mm = mkt?.market || mkt;
      marketCloseTs = mm?.close_time ? new Date(mm.close_time).getTime()
        : mm?.expiration_time ? new Date(mm.expiration_time).getTime() : null;
    } catch (_) {}
    let entryPrice = 50;
    try {
      const fills = await kalshiFetch("/trade-api/v2/portfolio/fills?ticker=" + encodeURIComponent(kp.ticker) + "&limit=20", { method: "GET" });
      const buyFills = (fills?.fills || []).filter(f => f.action === "buy" && f.ticker === kp.ticker);
      if (buyFills.length > 0) {
        const totalCost = buyFills.reduce((s, f) => s + (f.yes_price || f.no_price || 50) * (f.count || 1), 0);
        const totalQty = buyFills.reduce((s, f) => s + (f.count || 1), 0);
        entryPrice = Math.round(totalCost / totalQty);
      }
    } catch (_) {}
    pos = {
      ticker: kp.ticker, side, entryPriceCents: entryPrice, count: posCount,
      openedTs: Date.now(), orderId: null, marketCloseTs,
    };
    await kvSetJson(kvKey("bot:position", suffix), pos);
  }

  if (pos && pos.ticker) {
    const stillOnKalshi = relevantPositions.some(p => p.ticker === pos.ticker);

    if (!stillOnKalshi) {
      // Position settled
      _log("[" + suffix + "] Position " + pos.ticker + " settled.");
      let won = false, revenueCents = 0;
      try {
        const settleData = await kalshiFetch("/trade-api/v2/portfolio/settlements?limit=10", { method: "GET" });
        const match = (settleData?.settlements || []).find(s => s.ticker === pos.ticker);
        if (match) {
          won = (match.market_result === pos.side);
          revenueCents = won ? (pos.count * 100) : 0;
          _log("[" + suffix + "] SETTLEMENT: " + (won ? "WIN" : "LOSS"));
        }
      } catch (e) { _log("[" + suffix + "] Settlement lookup failed: " + (e?.message || e)); }

      const costCents = (pos.entryPriceCents || 50) * (pos.count || 1);
      const pnlCents = revenueCents - costCents;
      await logTradeResult({
        ticker: pos.ticker, side: pos.side, entryPriceCents: pos.entryPriceCents,
        count: pos.count, result: won ? "win" : "loss", exitReason: "SETTLEMENT",
        revenueCents, costCents, pnlCents, seriesSuffix: suffix,
        signal: pos.signal || null, openedTs: pos.openedTs, settledTs: Date.now(),
      });
      await recordDailyTrade(suffix, won ? "win" : "loss", pnlCents);
      await learnFromTrades(suffix, seriesDef);
      await kvSetJson(kvKey("bot:position", suffix), null);
      pos = null;
    } else {
      // ── TAKE PROFIT / TRAILING STOP ──
      const kalshiMatch = relevantPositions.find(p => p.ticker === pos.ticker);
      const realCount = kalshiMatch ? Math.abs(kalshiMatch.position || 0) : 0;
      if (realCount > 0 && realCount !== pos.count) {
        _log("[" + suffix + "] COUNT FIX: stored=" + pos.count + " kalshi=" + realCount);
        pos.count = realCount;
        await kvSetJson(kvKey("bot:position", suffix), pos);
      }
      const bestBid = await getBestBidFromOrderbook(pos.ticker, pos.side);
      const entryPx = pos.entryPriceCents || 50;
      const cnt = pos.count || 1;
      const totalCost = entryPx * cnt;
      const currentValue = bestBid ? (bestBid * cnt) : 0;
      const totalProfit = currentValue - totalCost;

      if (bestBid && (!pos.peakBidCents || bestBid > pos.peakBidCents)) {
        pos.peakBidCents = bestBid;
        await kvSetJson(kvKey("bot:position", suffix), pos);
      }

      _log("[" + suffix + "] POSITION: " + pos.side.toUpperCase() + " " + cnt + "x " + pos.ticker +
        " | entry=" + entryPx + "c bid=" + (bestBid || "?") + "c peak=" + (pos.peakBidCents || "?") + "c" +
        " | P&L=" + (totalProfit >= 0 ? "+$" : "-$") + (Math.abs(totalProfit) / 100).toFixed(2));

      const minsToClose = pos.marketCloseTs ? (pos.marketCloseTs - Date.now()) / 60000 : 999;
      const profitPerContract = bestBid ? bestBid - entryPx : 0;

      // ── TAKE PROFIT LOGIC ──
      let shouldTakeProfit = false;
      let tpReason = "";
      // 1H: wider trailing stop (8c vs 5c for momentum fade)
      const trailingStopDrop = suffix === "1H" ? 8 : 5;

      if (bestBid && profitPerContract > 0) {
        if (bestBid >= 85) {
          shouldTakeProfit = true;
          tpReason = "HIGH_BID_" + bestBid;
        } else if (profitPerContract >= 25) {
          shouldTakeProfit = true;
          tpReason = "STRONG_PROFIT_" + profitPerContract;
        } else if (minsToClose < 5 && profitPerContract >= 15) {
          shouldTakeProfit = true;
          tpReason = "TIME_LOCK_" + profitPerContract + "c_" + minsToClose.toFixed(0) + "m";
        } else if (profitPerContract >= 10 && pos.peakBidCents && (pos.peakBidCents - bestBid) >= trailingStopDrop) {
          shouldTakeProfit = true;
          tpReason = "MOMENTUM_FADE_peak" + pos.peakBidCents + "_now" + bestBid;
        }
      }

      if (shouldTakeProfit) {
        _log("[" + suffix + "] TAKE PROFIT: " + tpReason);

        if (mode !== "live") {
          const rev = bestBid * cnt;
          const cost = entryPx * cnt;
          const pnl = rev - cost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
            exitPriceCents: bestBid, count: cnt, result: "tp_exit", exitReason: "TAKE_PROFIT_" + tpReason,
            revenueCents: rev, costCents: cost, pnlCents: pnl, seriesSuffix: suffix,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade(suffix, "tp_exit", pnl);
          await learnFromTrades(suffix, seriesDef);
          await kvSetJson(kvKey("bot:position", suffix), null);
          _log("[" + suffix + "] PAPER SOLD " + cnt + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
          return { action: "take_profit", reason: tpReason, pnlCents: pnl };
        }

        const sellBody = { ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: cnt,
          time_in_force: "fill_or_kill",
          ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }) };
        try {
          const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
          const so = sr?.order || {};
          if (so.status === "executed" || ((so.fill_count ?? 0) > 0)) {
            const fc = (so.fill_count ?? 0) > 0 ? so.fill_count : cnt;
            const rev = bestBid * fc;
            const pnl = rev - entryPx * fc;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
              exitPriceCents: bestBid, count: fc, result: "tp_exit", exitReason: "TAKE_PROFIT_" + tpReason,
              revenueCents: rev, costCents: entryPx * fc, pnlCents: pnl, seriesSuffix: suffix,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade(suffix, "tp_exit", pnl);
            await learnFromTrades(suffix, seriesDef);
            await kvSetJson(kvKey("bot:position", suffix), null);
            return { action: "take_profit", reason: tpReason, pnlCents: pnl };
          }
        } catch (e) { _log("[" + suffix + "] TP sell failed: " + (e?.message || e)); }
      }

      // ── Tiered loss exit ──
      const updatedProfit = bestBid ? (bestBid * cnt) - (entryPx * cnt) : totalProfit;
      if (bestBid) {
        const lossPerContract = entryPx - bestBid;
        const lossRatio = lossPerContract / entryPx;

        let maxLossRatio;
        if (minsToClose < 5) maxLossRatio = 0.30;
        else if (minsToClose < 8) maxLossRatio = 0.40;
        else maxLossRatio = 0.50;

        const hopeless = (lossRatio >= maxLossRatio && lossPerContract > 0) || (bestBid <= 5);

        if (hopeless && lossPerContract > 0) {
          const reason = bestBid <= 5 ? "NEAR_ZERO" : "LOSS_GATE_" + Math.round(maxLossRatio * 100);
          _log("[" + suffix + "] EXIT_LOSING: " + reason + " loss=" + lossPerContract + "c/contract");

          if (mode !== "live") {
            const rev = bestBid * cnt;
            const cost = entryPx * cnt;
            const pnl = rev - cost;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
              exitPriceCents: bestBid, count: cnt, result: "loss", exitReason: "STOP_LOSS_" + reason,
              revenueCents: rev, costCents: cost, pnlCents: pnl, seriesSuffix: suffix,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade(suffix, "loss", pnl);
            await learnFromTrades(suffix, seriesDef);
            await kvSetJson(kvKey("bot:position", suffix), null);
            return { action: "stop_loss", reason, pnlCents: pnl };
          }

          const sellBody = { ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: cnt,
            time_in_force: "fill_or_kill",
            ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }) };
          try {
            const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
            const so = sr?.order || {};
            if (so.status === "executed" || ((so.fill_count ?? 0) > 0)) {
              const fc = (so.fill_count ?? 0) > 0 ? so.fill_count : cnt;
              const rev = bestBid * fc;
              const pnl = rev - entryPx * fc;
              await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
                exitPriceCents: bestBid, count: fc, result: "loss", exitReason: "STOP_LOSS_" + reason,
                revenueCents: rev, costCents: entryPx * fc, pnlCents: pnl, seriesSuffix: suffix,
                signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
              await recordDailyTrade(suffix, "loss", pnl);
              await learnFromTrades(suffix, seriesDef);
              await kvSetJson(kvKey("bot:position", suffix), null);
              return { action: "stop_loss", reason, pnlCents: pnl };
            }
          } catch (e) { _log("[" + suffix + "] Exit sell failed: " + (e?.message || e)); }
        } else if (updatedProfit > 0) {
          _log("[" + suffix + "] IN PROFIT: +$" + (updatedProfit / 100).toFixed(2) + " — holding");
        } else if (updatedProfit <= 0 && lossPerContract > 0) {
          _log("[" + suffix + "] UNDERWATER: -$" + (Math.abs(updatedProfit) / 100).toFixed(2) + " — holding");
        }
      } else if (!bestBid) {
        _log("[" + suffix + "] NO BIDS — holding to settlement");
      }

      await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", totalProfit: updatedProfit };
    }
  }

  // ── Pre-entry checks ──
  const cooldownOk = await checkCooldown(cfg, suffix, seriesDef);
  if (!cooldownOk) return { action: "cooldown" };

  // ── 1H: Probability-based bracket market trading ──
  if (suffix === "1H") {
    const closes = candles.map(c => c.close);
    const spot = closes[closes.length - 1];
    const sigma = computeRealizedVol(candles, 60);

    // Time to settlement (KXBTC settles at 22:00 UTC)
    const now = new Date();
    const settlement = new Date(now);
    settlement.setUTCHours(22, 0, 0, 0);
    if (settlement <= now) settlement.setUTCDate(settlement.getUTCDate() + 1);
    const tauYears = (settlement - now) / (365.25 * 24 * 3600 * 1000);
    const minsToSettlement = (settlement - now) / 60000;

    if (minsToSettlement < minMinutesToCloseToEnter) {
      _log("[1H] TIME GATE: " + minsToSettlement.toFixed(0) + "min to settlement (need " + minMinutesToCloseToEnter + ")");
      return { action: "time_gate" };
    }

    // VWAP signal for probability adjustment
    const vwap = computeVWAP(candles);
    const vwapDev = vwap ? (spot - vwap) / vwap : 0;
    let vwapSignal = 0;
    if (vwapDev < -0.005) vwapSignal = 1;
    else if (vwapDev > 0.005) vwapSignal = -1;

    _log("[1H] spot=$" + spot.toFixed(0) + " sigma=" + (sigma * 100).toFixed(1) +
      "% tau=" + (tauYears * 365.25 * 24).toFixed(1) + "h vwap=" + vwapSignal);

    // Fetch all KXBTC markets
    const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200 });
    const allMarkets = (resp?.markets || []).filter(m =>
      m.ticker?.startsWith(seriesPrefix) && m.close_time
    );
    _log("[1H] Markets: " + allMarkets.length);

    // Find best mispriced contract
    const best = findBestBracketTrade(allMarkets, spot, sigma, tauYears,
      [minEntryPriceCents, maxEntryPriceCents], minEdge, vwapSignal);

    if (!best) {
      _log("[1H] No mispriced contracts found");
      await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), sigma, spot });
      return { action: "no_edge" };
    }

    _log("[1H] BEST: " + best.ticker + " " + best.side + " ask=" + best.askPrice +
      "c fair=" + best.fairCents + "c edge=" + best.edge + "c strike=$" + best.strike);

    // Depth check
    let depthOk = true;
    try {
      const depthOb = await getOrderbook(best.ticker, 10);
      const depthBook = depthOb?.orderbook || depthOb?.order_book || depthOb;
      const depthBids = depthBook?.[best.side] || [];
      const totalDepth = depthBids.reduce((s, b) => s + (Array.isArray(b) ? (b[1] || 0) : (b?.quantity || b?.size || 0)), 0);
      if (totalDepth < 10) depthOk = false;
    } catch (e) { _log("[1H] Depth check failed: " + (e?.message || e)); }
    if (!depthOk) {
      _log("[1H] DEPTH GATE");
      await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), sigma, spot });
      return { action: "depth_gate" };
    }

    // Place order
    const limitPrice = best.askPrice - makerOffset;
    const finalPrice = limitPrice >= minEntryPriceCents ? limitPrice : best.askPrice;
    const confidence = Math.min(1, best.edge / 20);
    const learned = await kvGetJson(kvKey("bot:learned_weights", suffix));
    const wr = learned?.winRate || 50;
    const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: finalPrice, winRate: wr, confidence });

    _log("[1H] ORDER: " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + finalPrice +
      "c (conf=" + (confidence * 100).toFixed(0) + "% mode=" + mode + ")");

    const sigData = { type: "bracket", spot, sigma, strike: best.strike, fairCents: best.fairCents,
      edge: best.edge, vwapSignal, tauHours: tauYears * 365.25 * 24 };

    if (mode !== "live") {
      _log("[1H] PAPER MODE: " + best.side.toUpperCase() + " " + count + "x @ " + finalPrice + "c");
      const posData = {
        ticker: best.ticker, side: best.side, entryPriceCents: finalPrice,
        count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
        signal: sigData, marketCloseTs: best.closeTs || null,
      };
      await kvSetJson(kvKey("bot:position", suffix), posData);
      await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
      await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), lastAction: "paper_buy", sigma, spot });
      return { action: "paper_buy", position: posData };
    }

    const orderBody = {
      ticker: best.ticker, action: "buy", type: "limit", side: best.side, count,
      ...(best.side === "yes" ? { yes_price: finalPrice } : { no_price: finalPrice }),
    };

    const res = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
    _log("[1H] ORDER RESULT: " + JSON.stringify(res));

    const order = res?.order || {};
    const status = order.status || "";

    if (status === "executed" || ((order.fill_count ?? 0) > 0)) {
      const fillCount = (order.fill_count ?? 0) > 0 ? order.fill_count : count;
      await kvSetJson(kvKey("bot:position", suffix), {
        ticker: best.ticker, side: best.side, entryPriceCents: finalPrice,
        count: fillCount, openedTs: Date.now(), orderId: order.order_id || null,
        signal: sigData, marketCloseTs: best.closeTs || null,
      });
      await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
    } else if (status === "resting") {
      _log("[1H] ORDER RESTING on book.");
      await kvSetJson(kvKey("bot:pendingOrder", suffix), {
        orderId: order.order_id, ticker: best.ticker, side: best.side,
        limitPrice: finalPrice, count, placedTs: Date.now(), signal: sigData,
      });
    }

    await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), lastAction: "buy", sigma, spot });
    return { action: "order_placed", status };
  }

  // ── 15M: Indicator-based signal trading ──
  const closes = candles.map(c => c.close);
  const closes5m = candles5m ? candles5m.map(c => c.close) : [];

  const weights = await getLearnedWeights(suffix, seriesDef);
  const learned = await kvGetJson(kvKey("bot:learned_weights", suffix));
  const minScoreThreshold = learned?.minScoreThreshold || 3;
  const sig = getSignal15M(candles, closes, orderBook.ratio, weights, minScoreThreshold, candles5m, candles15m);

  // Volume confirmation
  const volumes = candles.map(c => c.volume || 0);
  const avgVol = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
  const recentVol = volumes.length >= 5 ? volumes.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;

  // ATR regime
  const atr = computeATR(candles, 14);
  const price = closes[closes.length - 1];
  const atrPct = atr && price > 0 ? (atr / price) * 100 : 0;

  _log("[" + suffix + "] SIGNAL: score=" + (sig.score || 0).toFixed(2) + " dir=" + (sig.direction || "neutral") +
    " vol=" + volRatio.toFixed(2) + " atr=" + atrPct.toFixed(3) + "%");

  if (sig.direction === "neutral" || !sig.predProb) {
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_signal", signal: sig };
  }

  // Volume gate
  if (volRatio < 0.5) {
    _log("[" + suffix + "] VOLUME GATE. Skipping.");
    return { action: "volume_gate" };
  }

  // ATR gates
  if (atrPct > 0 && atrPct < 0.02) {
    _log("[" + suffix + "] ATR GATE: too low. Skipping.");
    return { action: "atr_gate" };
  }
  if (atrPct > atrMaxPct) {
    _log("[" + suffix + "] ATR GATE: too high (" + atrPct.toFixed(3) + "% > " + atrMaxPct + "%). Skipping.");
    return { action: "atr_high_gate" };
  }

  // Volume boost
  if (volRatio > 1.5) {
    sig.score += 0.5 * Math.sign(sig.score);
    _log("[" + suffix + "] VOLUME BOOST: +0.5");
  }

  // Recalculate predProb after boosts
  const maxScore = sig.maxScore || 6;
  sig.predProb = 50 + (Math.abs(sig.score) / maxScore) * 30;
  const predProb = sig.predProb;

  // ── Hourly gate ──
  const hourlyGate = learned?.hourlyStats;
  if (hourlyGate) {
    const currentHour = new Date().getUTCHours();
    const hourData = hourlyGate[currentHour];
    if (hourData && hourData.total >= 30 && (hourData.wins / hourData.total) < 0.3) {
      _log("[" + suffix + "] HOURLY GATE: hour " + currentHour + " UTC blocked.");
      return { action: "hourly_gate" };
    }
  }

  // ── Combo bonus ──
  const comboBonus = learned?.comboStats;
  const INDICATORS = seriesDef.indicators;
  let comboBonusScore = 0;
  if (comboBonus && sig.indicators) {
    for (let a = 0; a < INDICATORS.length; a++) {
      for (let b = a + 1; b < INDICATORS.length; b++) {
        const va = sig.indicators[INDICATORS[a]] || 0;
        const vb = sig.indicators[INDICATORS[b]] || 0;
        if (va !== 0 && vb !== 0 && va === vb) {
          const key = INDICATORS[a] + "+" + INDICATORS[b];
          const combo = comboBonus[key];
          if (combo && combo.total >= 10 && (combo.wins / combo.total) > 0.65) {
            comboBonusScore += 0.5;
          }
        }
      }
    }
    if (comboBonusScore > 0) _log("[" + suffix + "] COMBO BONUS: +" + comboBonusScore.toFixed(1));
  }

  // ── Price optimization ──
  let effectiveMinEntry = minEntryPriceCents;
  let effectiveMaxEntry = maxEntryPriceCents;
  const priceAdvice = learned?.priceAdvice;
  if (priceAdvice === "low_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMinEntry = Math.min(effectiveMinEntry + 10, 55);
  }
  if (priceAdvice === "high_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMaxEntry = Math.max(effectiveMaxEntry - 10, 60);
  }

  // ── Find best market ──
  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  _log("[" + suffix + "] Markets found: " + markets.length);

  const now = Date.now();
  const candidates = markets.filter(m => {
    if (typeof m?.ticker !== "string" || !m.ticker.startsWith(seriesPrefix)) return false;
    const closeTs = m.close_time ? new Date(m.close_time).getTime()
      : m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
    if (closeTs > 0) {
      const minsLeft = (closeTs - now) / 60000;
      if (minsLeft < minMinutesToCloseToEnter) return false;
    }
    return true;
  });

  if (!candidates.length) {
    _log("[" + suffix + "] No markets with " + minMinutesToCloseToEnter + "+ min remaining.");
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_markets" };
  }

  let best = null;
  for (const m of candidates) {
    const ticker = m.ticker;
    const px = await getExecutablePrices(ticker);
    const yesAsk = validPx(px.yesAsk ?? m.yes_ask ?? null);
    const noAsk  = validPx(px.noAsk  ?? m.no_ask  ?? null);

    let targetAsk, side;
    if (sig.direction === "up") { side = "yes"; targetAsk = yesAsk; }
    else { side = "no"; targetAsk = noAsk; }

    if (!targetAsk) continue;
    if (targetAsk < effectiveMinEntry || targetAsk > effectiveMaxEntry) continue;

    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < effectiveMinEntry) continue;

    const edge = predProb - limitPrice;
    const closeTs = m.close_time ? new Date(m.close_time).getTime()
      : m.expiration_time ? new Date(m.expiration_time).getTime() : null;

    if (!best || edge > best.edge) {
      best = { ticker, side, targetAsk, limitPrice, edge, source: px.source, marketCloseTs: closeTs };
    }
  }

  if (!best) {
    _log("[" + suffix + "] No market in price band.");
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_edge" };
  }

  if (comboBonusScore > 0) best.edge += comboBonusScore;

  _log("[" + suffix + "] BEST: " + best.ticker + " " + best.side + " limit=" + best.limitPrice + "c edge=" + best.edge.toFixed(1) + "c");

  if (best.edge < minEdge) {
    _log("[" + suffix + "] Edge too low: " + best.edge.toFixed(1) + "c");
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "insufficient_edge" };
  }

  // ── Orderbook depth check ──
  let depthOk = true;
  try {
    const depthOb = await getOrderbook(best.ticker, 10);
    const depthBook = depthOb?.orderbook || depthOb?.order_book || depthOb;
    const depthBids = depthBook?.[best.side] || [];
    const totalDepth = depthBids.reduce((s, b) => s + (Array.isArray(b) ? (b[1] || 0) : (b?.quantity || b?.size || 0)), 0);
    if (totalDepth < 10) {
      depthOk = false;
      _log("[" + suffix + "] DEPTH GATE: only " + totalDepth + " contracts. Skipping.");
    }
  } catch (e) { _log("[" + suffix + "] Depth check failed: " + (e?.message || e)); }

  if (!depthOk) {
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "depth_gate" };
  }

  // ── Place order ──
  const learnedWinRate = learned?.winRate || 50;
  const confidence = sig.confidence || 0.5;
  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice, winRate: learnedWinRate, confidence });
  const betSize = (best.limitPrice * count / 100).toFixed(2);
  _log("[" + suffix + "] ORDER: " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice +
    "c (conf=" + (confidence * 100).toFixed(0) + "% bet=$" + betSize + " mode=" + mode + ")");

  const rawCandles = sig.candles || candles || [];
  const candleSnapshot = rawCandles.slice(-5).map(c => ({ c: c.close, v: c.volume, h: c.high, l: c.low }));
  const sigData = { direction: sig.direction, score: sig.score, predProb, indicators: sig.indicators,
    mtfBoost: sig.mtfBoost || 0, volRatio, atrPct, candleSnapshot };

  if (mode !== "live") {
    _log("[" + suffix + "] PAPER MODE: " + best.side.toUpperCase() + " " + count + "x @ " + best.limitPrice + "c");
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: sigData, marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson(kvKey("bot:position", suffix), posData);
    await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return { action: "paper_buy", position: posData };
  }

  const orderBody = {
    ticker: best.ticker, action: "buy", type: "limit", side: best.side, count,
    ...(best.side === "yes" ? { yes_price: best.limitPrice } : { no_price: best.limitPrice }),
  };

  const res = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
  _log("[" + suffix + "] ORDER RESULT: " + JSON.stringify(res));

  const order = res?.order || {};
  const status = order.status || "";

  if (status === "executed" || ((order.fill_count ?? 0) > 0)) {
    const fillCount = (order.fill_count ?? 0) > 0 ? order.fill_count : count;
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fillCount, openedTs: Date.now(), orderId: order.order_id || null,
      signal: sigData, marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson(kvKey("bot:position", suffix), posData);
    await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
  } else if (status === "resting") {
    _log("[" + suffix + "] ORDER RESTING on book.");
    await kvSetJson(kvKey("bot:pendingOrder", suffix), {
      orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(), signal: sigData,
    });
  }

  await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
  return { action: "order_placed", status };
}

// ── Main bot cycle ──

export async function runBotCycle() {
  const log = [];
  const _log = (msg) => { console.log(msg); log.push(msg); };

  // Migrate old unsuffixed keys to :15M
  await migrateOldKeys();

  const cfg = (await kvGetJson("bot:config")) || {};
  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const hourlyEnabled = !!cfg.hourlyEnabled;

  _log("CONFIG: enabled=" + enabled + " mode=" + mode + " 15m=" + enabled + " hourly=" + hourlyEnabled);

  if (!enabled && !hourlyEnabled) { _log("Both bots disabled -- exiting."); return { action: "disabled", log }; }

  // ── Combined daily loss check ──
  const dailyCheck = await checkCombinedDailyLoss(cfg);
  if (!dailyCheck.ok) { return { action: "daily_limit", log }; }

  // ── Fetch shared data once ──
  let candles, candles5m, candles15m, orderBook;
  try {
    [candles, orderBook, candles5m, candles15m] = await Promise.all([
      fetchCoinbaseCandles(100),
      fetchCoinbaseOrderBook(),
      fetchCoinbaseCandles5m(50),
      fetchCoinbaseCandles15m(30),
    ]);
  } catch (e) {
    _log("Coinbase data fetch failed: " + (e?.message || e));
    return { action: "data_error", log };
  }

  if (!candles || candles.length < 30) {
    _log("Insufficient candle data.");
    return { action: "no_data", log };
  }

  const kalshiPositions = await getKalshiPositions();

  const sharedData = { candles, candles5m, candles15m, orderBook, kalshiPositions, mode };

  // ── Run each enabled series ──
  const results = {};

  // Run 15M if enabled
  if (enabled) {
    _log("── 15M Series ──");
    results["15M"] = await runSeriesCycle(SERIES_DEFS["15M"], cfg, sharedData, _log);
  }

  // Run 1H if enabled
  if (hourlyEnabled) {
    _log("── 1H Series ──");
    results["1H"] = await runSeriesCycle(SERIES_DEFS["1H"], cfg, sharedData, _log);
  }

  return { action: "multi_series", results, log };
}

// ── CLI entry point ──

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith("run-bot-clean.mjs") ||
  process.argv[1].endsWith("run-bot-clean")
);

if (isMainModule) {
  runBotCycle().then(result => {
    console.log("RESULT:", JSON.stringify(result?.results || result?.action || "unknown"));
  }).catch((e) => {
    console.error("Bot runner failed:", e?.message || e);
    process.exit(1);
  });
}
