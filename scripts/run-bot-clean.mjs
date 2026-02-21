import { kvGetJson, kvSetJson } from "./kv.js";
import { getMarkets, getMarket, getOrderbook, kalshiFetch } from "./kalshi_client.mjs";

// ── Utilities ──

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function validPx(v) {
  const n = (typeof v === "number") ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 99) return null;
  return n;
}

function calcContracts({ tradeSizeUsd, maxContracts, askCents, winRate, confidence }) {
  // confidence = 0.0 to 1.0 (from signal score / maxScore)
  // Scale: $2 at 100%, $1 at 50%, floor at $0.40 (0.2 * $2)
  const maxBet = 2; // hard cap — keep small until account > $250
  const confScaled = Math.max(0.2, Math.min(1, confidence || 0.5)) * maxBet;

  // Then apply half-Kelly on top for additional safety
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

// ── Coinbase data fetchers (public, no auth, reliable for US) ──

const COINBASE_BASE = "https://api.exchange.coinbase.com";

async function fetchCoinbaseCandles(limit = 100) {
  const url = `${COINBASE_BASE}/products/BTC-USD/candles?granularity=60`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const data = await res.json();
  const candles = data
    .slice(0, limit)
    .reverse()
    .map(c => ({ time: c[0], low: c[1], high: c[2], open: c[3], close: c[4], volume: c[5] }));
  return candles;
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
  const bids = (data.bids || []).slice(0, 5);
  const asks = (data.asks || []).slice(0, 5);
  for (const [, size] of bids) bidDepth += parseFloat(size);
  for (const [, size] of asks) askDepth += parseFloat(size);
  const total = bidDepth + askDepth;
  const ratio = total > 0 ? bidDepth / total : 0.5;
  return { ratio, bidDepth, askDepth };
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

// ── Adaptive learning: analyze past trades to adjust indicator weights ──

const DEFAULT_WEIGHTS = { rsi: 2, vwap: 2, ob: 2 };
const INDICATORS = ["rsi", "vwap", "ob"];

async function getLearnedWeights() {
  const learned = await kvGetJson("bot:learned_weights");
  if (!learned || !learned.weights) return { ...DEFAULT_WEIGHTS };
  return { ...DEFAULT_WEIGHTS, ...learned.weights };
}

async function learnFromTrades() {
  const history = (await kvGetJson("bot:trade_history")) || [];
  const tradesWithSignals = history.filter(t => t.signal && t.signal.indicators);
  if (tradesWithSignals.length < 5) return null;

  const recent = tradesWithSignals.slice(-20);

  const indicatorStats = {};
  for (const ind of INDICATORS) {
    indicatorStats[ind] = { correct: 0, wrong: 0, neutral: 0 };
  }

  let totalWins = 0;
  let totalLosses = 0;
  let totalPnl = 0;
  const entryPriceStats = { low: 0, lowWin: 0, mid: 0, midWin: 0, high: 0, highWin: 0 };

  // Combo tracking: pairwise indicator agreement win rates
  const comboStats = {};
  // Hourly stats: win rate by hour UTC
  const hourlyStats = {};

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

    const indicators = trade.signal.indicators;
    if (!indicators) continue;

    const tradeDir = trade.signal.direction;

    for (const ind of INDICATORS) {
      const vote = indicators[ind] || 0;
      if (vote === 0) {
        indicatorStats[ind].neutral++;
        continue;
      }
      const votedUp = vote > 0;
      const votedWithTrade = (tradeDir === "up" && votedUp) || (tradeDir === "down" && !votedUp);

      if ((votedWithTrade && won) || (!votedWithTrade && lost)) {
        indicatorStats[ind].correct++;
      } else {
        indicatorStats[ind].wrong++;
      }
    }

    // Combo stats: track pairwise agreement
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

    // Hourly stats
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
    if (total < 3) {
      newWeights[ind] = DEFAULT_WEIGHTS[ind];
      continue;
    }
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
    weights: newWeights,
    minScoreThreshold,
    winRate: Math.round(winRate * 100),
    totalTrades,
    totalPnl,
    lossStreak,
    mode: tradingMode,
    indicatorStats,
    comboStats,
    hourlyStats,
    priceAdvice,
    lastUpdated: Date.now(),
  };

  await kvSetJson("bot:learned_weights", result);
  console.log("LEARNING UPDATE:", JSON.stringify({
    weights: newWeights, minScore: minScoreThreshold, mode: tradingMode,
    winRate: result.winRate + "%", trades: totalTrades, pnl: "$" + (totalPnl / 100).toFixed(2),
    lossStreak, priceAdvice, combos: Object.keys(comboStats).length,
  }));

  return result;
}

// ── Signal generator: adaptive weighted scoring, 3 indicators (RSI-3, VWAP, OB) ──

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

async function getSignal() {
  let candles, orderBook, candles5m, candles15m;
  try {
    [candles, orderBook, candles5m, candles15m] = await Promise.all([
      fetchCoinbaseCandles(100),
      fetchCoinbaseOrderBook(),
      fetchCoinbaseCandles5m(50),
      fetchCoinbaseCandles15m(30),
    ]);
  } catch (e) {
    console.log("Coinbase data fetch failed:", e?.message || e);
    return { direction: "neutral", score: 0, confidence: 0, details: "coinbase_error" };
  }

  if (!candles || candles.length < 30) {
    return { direction: "neutral", score: 0, confidence: 0, details: "insufficient_data" };
  }

  const weights = await getLearnedWeights();
  const learned = await kvGetJson("bot:learned_weights");
  const minScoreThreshold = learned?.minScoreThreshold || 3;

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  // RSI-3 (ultra-fast for 1-min candles, Connors-style)
  const rsiVal = computeRSI(closes, 3);
  // VWAP deviation
  const vwap = computeVWAP(candles);
  const vwapDev = vwap ? (price - vwap) / vwap : 0;
  // Order book imbalance (tighter thresholds: 0.65/0.35)
  const obRatio = orderBook.ratio;

  const indicators = { rsi: 0, vwap: 0, ob: 0 };
  let score = 0;
  const breakdown = {};

  // RSI-3: use 15/85 thresholds (research-backed for short-period RSI)
  if (rsiVal < 15) { indicators.rsi = 1; } else if (rsiVal > 85) { indicators.rsi = -1; }
  score += indicators.rsi * (weights.rsi || 2);
  breakdown.rsi = (indicators.rsi > 0 ? "+" : indicators.rsi < 0 ? "-" : "") +
    (indicators.rsi !== 0 ? (weights.rsi || 2).toFixed(1) : "0") + " (rsi3=" + rsiVal.toFixed(1) + ")";

  // VWAP: buy 0.15%+ below, sell 0.15%+ above
  if (vwap) {
    if (vwapDev < -0.0015) { indicators.vwap = 1; } else if (vwapDev > 0.0015) { indicators.vwap = -1; }
  }
  score += indicators.vwap * (weights.vwap || 2);
  breakdown.vwap = (indicators.vwap > 0 ? "+" : indicators.vwap < 0 ? "-" : "") +
    (indicators.vwap !== 0 ? (weights.vwap || 2).toFixed(1) : "0") + " (dev=" + (vwapDev * 100).toFixed(3) + "%)";

  // OB imbalance: tighter thresholds (0.65/0.35)
  if (obRatio > 0.65) { indicators.ob = 1; } else if (obRatio < 0.35) { indicators.ob = -1; }
  score += indicators.ob * (weights.ob || 2);
  breakdown.ob = (indicators.ob > 0 ? "+" : indicators.ob < 0 ? "-" : "") +
    (indicators.ob !== 0 ? (weights.ob || 2).toFixed(1) : "0") + " (ob=" + obRatio.toFixed(3) + ")";

  const maxScore = (weights.rsi || 2) + (weights.vwap || 2) + (weights.ob || 2);

  // Multi-timeframe confirmation (RSI on 5m and 15m — faster periods for short windows)
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

  // Volume confirmation
  const volumes = candles.map(c => c.volume || 0);
  const avgVol = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
  const recentVol = volumes.length >= 5 ? volumes.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;

  // ATR regime
  const atr = computeATR(candles, 14);
  const atrPct = atr && price > 0 ? (atr / price) * 100 : 0;

  console.log("SIGNAL SCORE:", score.toFixed(2), "/ " + maxScore.toFixed(1) + " (threshold: " + minScoreThreshold + ")" +
    " mtf=+" + mtfBoost.toFixed(1) + " vol=" + volRatio.toFixed(2) + " atr=" + atrPct.toFixed(3) + "%");

  const absScore = Math.abs(score);

  if (absScore < minScoreThreshold) {
    console.log("No trade -- score " + score.toFixed(2) + " (need |" + minScoreThreshold + "|+)");
    return { direction: "neutral", score, confidence: 0, price, breakdown, indicators, candles, volRatio, atrPct, mtfBoost };
  }

  const confidence = absScore / maxScore;
  const direction = score > 0 ? "up" : "down";
  const predProb = 50 + confidence * 30;

  // Volume gate
  if (volRatio < 0.5) {
    console.log("VOLUME GATE: recent vol " + volRatio.toFixed(2) + "x avg. Skipping.");
    return { direction: "neutral", score, confidence: 0, price, breakdown, indicators, details: "volume_gate" };
  }

  // ATR gate: too low = no movement, too high = trending (mean reversion fails)
  if (atrPct > 0 && atrPct < 0.02) {
    console.log("ATR GATE: volatility too low (" + atrPct.toFixed(3) + "%). Skipping.");
    return { direction: "neutral", score, confidence: 0, price, breakdown, indicators, details: "atr_gate" };
  }
  if (atrPct > 0.15) {
    console.log("ATR GATE: volatility too high (" + atrPct.toFixed(3) + "%). Mean reversion unreliable. Skipping.");
    return { direction: "neutral", score, confidence: 0, price, breakdown, indicators, details: "atr_high_gate" };
  }

  // Volume boost
  if (volRatio > 1.5) {
    score += 0.5 * Math.sign(score);
    console.log("VOLUME BOOST: +" + 0.5 + " (vol " + volRatio.toFixed(2) + "x avg)");
  }

  // Recalculate after volume boost
  const finalAbsScore = Math.abs(score);
  const finalConfidence = finalAbsScore / maxScore;
  const finalPredProb = 50 + finalConfidence * 30;

  console.log("SIGNAL:", direction.toUpperCase(), "confidence=" + (finalConfidence * 100).toFixed(0) + "%", "predProb=" + finalPredProb.toFixed(1) + "%");
  return { direction, score, confidence: finalConfidence, predProb: finalPredProb, price, breakdown, indicators, candles, volRatio, atrPct, mtfBoost };
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

// Get best bid from LIVE orderbook — not the stale getMarket() snapshot
// Retries once on failure since sell decisions depend on this
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

// Get asks from orderbook for entry pricing
async function getOrderbookPrices(ticker) {
  try {
    const ob = await getOrderbook(ticker, 10);
    const book = ob?.orderbook || ob?.order_book || ob;
    const yesBids = book?.yes || [];
    const noBids = book?.no || [];
    // Best ask = lowest ask = first element; but Kalshi returns bids not asks in this format
    // For asks: yes_ask = 100 - best_no_bid, no_ask = 100 - best_yes_bid
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
  // Try market snapshot first (has explicit ask prices)
  try {
    const m = await getMarket(ticker);
    const mm = m?.market || m;
    const yesAsk = validPx(mm?.yes_ask ?? mm?.yesAsk ?? null);
    const noAsk  = validPx(mm?.no_ask  ?? mm?.noAsk  ?? null);
    const yesBid = validPx(mm?.yes_bid ?? mm?.yesBid ?? null);
    const noBid  = validPx(mm?.no_bid  ?? mm?.noBid  ?? null);
    if (yesAsk || noAsk) {
      return { yesAsk, noAsk, yesBid, noBid, source: "snapshot" };
    }
  } catch (_) {}

  // Fallback to orderbook
  const obPx = await getOrderbookPrices(ticker);
  return { ...obPx, source: "orderbook" };
}

// ── Cancel unfilled maker orders after timeout ──

async function checkPendingOrder(cfg) {
  const pending = await kvGetJson("bot:pendingOrder");
  if (!pending || !pending.orderId) return;

  const ageMs = Date.now() - (pending.placedTs || 0);
  const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;

  if (ageMs < timeoutMs) {
    try {
      const orderData = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const order = orderData?.order || orderData;
      if (order.status === "executed" || ((order.fill_count ?? 0) > 0)) {
        console.log("PENDING ORDER FILLED:", pending.orderId);
        // Get the market close time for position tracking
        let marketCloseTs = null;
        try {
          const mkt = await getMarket(pending.ticker);
          const mm = mkt?.market || mkt;
          marketCloseTs = mm?.close_time ? new Date(mm.close_time).getTime()
            : mm?.expiration_time ? new Date(mm.expiration_time).getTime() : null;
        } catch (_) {}
        await kvSetJson("bot:position", {
          ticker: pending.ticker,
          side: pending.side,
          entryPriceCents: pending.limitPrice,
          count: (order.fill_count ?? 0) > 0 ? order.fill_count : pending.count,
          openedTs: pending.placedTs,
          orderId: pending.orderId,
          signal: pending.signal,
          marketCloseTs,
        });
        // Verify write
        const verify = await kvGetJson("bot:position");
        console.log("POSITION SAVED:", verify?.ticker || "WRITE FAILED");
        await kvSetJson("bot:pendingOrder", null);
        return;
      }
    } catch (_) {}
    console.log("PENDING ORDER still resting (" + Math.round(ageMs / 1000) + "s old). Waiting...");
    return;
  }

  console.log("PENDING ORDER TIMEOUT after " + Math.round(ageMs / 1000) + "s. Canceling:", pending.orderId);
  try {
    await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "DELETE" });
    console.log("Order canceled successfully.");
  } catch (e) {
    console.log("Cancel failed (may already be filled/canceled):", e?.message || e);
  }
  await kvSetJson("bot:pendingOrder", null);
}

// ── Trade history logging ──

async function logTradeResult(entry) {
  entry.hourUtc = new Date().getUTCHours();
  const history = (await kvGetJson("bot:trade_history")) || [];
  history.push(entry);
  if (history.length > 100) history.splice(0, history.length - 100);
  await kvSetJson("bot:trade_history", history);
}

// ── Daily stats ──

async function getDailyStats() {
  const state = (await kvGetJson("bot:daily_stats")) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.date !== today) {
    const fresh = { date: today, totalTrades: 0, wins: 0, losses: 0, takeProfits: 0, totalPnlCents: 0 };
    await kvSetJson("bot:daily_stats", fresh);
    return fresh;
  }
  return state;
}

async function recordDailyTrade(type, pnlCents) {
  const stats = await getDailyStats();
  stats.totalTrades = (stats.totalTrades || 0) + 1;
  stats.totalPnlCents = (stats.totalPnlCents || 0) + pnlCents;
  if (type === "win") stats.wins = (stats.wins || 0) + 1;
  else if (type === "loss") stats.losses = (stats.losses || 0) + 1;
  else if (type === "tp_exit") stats.takeProfits = (stats.takeProfits || 0) + 1;
  await kvSetJson("bot:daily_stats", stats);
  return stats;
}

async function checkDailyLimits(cfg) {
  const stats = await getDailyStats();
  const maxLossCents = Math.round((Number(cfg.dailyMaxLossUsd ?? 10)) * 100);

  if (stats.totalPnlCents <= -maxLossCents) {
    console.log("DAILY LOSS LIMIT: $" + (stats.totalPnlCents / 100).toFixed(2) + " (max -$" + (maxLossCents / 100).toFixed(2) + "). Stopping.");
    return { ok: false, stats };
  }

  // No trade count limit — only stop on loss limit

  return { ok: true, stats };
}

// ── Cooldown ──

async function checkCooldown(cfg) {
  const baseCooldownMs = (Number(cfg.cooldownMinutes ?? 5)) * 60 * 1000;
  // Streak-aware: multiply cooldown by 1 + lossStreak * 0.25 (max 2x)
  const learned = await kvGetJson("bot:learned_weights");
  const lossStreak = learned?.lossStreak || 0;
  const multiplier = Math.min(2, 1 + lossStreak * 0.25);
  const cooldownMs = baseCooldownMs * multiplier;
  const lastTrade = await kvGetJson("bot:lastTradeTs");
  if (lastTrade && (Date.now() - lastTrade) < cooldownMs) {
    const secsLeft = Math.round((cooldownMs - (Date.now() - lastTrade)) / 1000);
    console.log("COOLDOWN: " + secsLeft + "s remaining" +
      (multiplier > 1 ? " (streak x" + multiplier.toFixed(1) + ")" : "") + ". Skipping.");
    return false;
  }
  return true;
}

// ── Main bot cycle (exported for server.mjs) ──

export async function runBotCycle() {
  const log = [];
  const _log = (msg) => { console.log(msg); log.push(msg); };

  const cfg = (await kvGetJson("bot:config")) || {};

  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 10);
  const maxContracts = Number(cfg.maxContracts ?? 10);
  const minEdge = Number(cfg.minEdge ?? 5);
  const minEntryPriceCents = Number(cfg.minEntryPriceCents ?? 35);
  const maxEntryPriceCents = Number(cfg.maxEntryPriceCents ?? 80);
  const minMinutesToCloseToEnter = Number(cfg.minMinutesToCloseToEnter ?? 5);
  const makerOffset = Number(cfg.makerOffsetCents ?? 2);
  _log("CONFIG: enabled=" + enabled + " mode=" + mode + " series=" + seriesTicker +
    " exit=hold_to_settlement priceband=" + minEntryPriceCents + "-" + maxEntryPriceCents + "c");

  if (!enabled) { _log("Bot disabled -- exiting."); return { action: "disabled", log }; }

  // ── Step 1: Check daily limits FIRST ──

  const dailyCheck = await checkDailyLimits(cfg);
  if (!dailyCheck.ok) { return { action: "daily_limit", stats: dailyCheck.stats, log }; }

  // ── Step 2: Handle pending maker orders ──

  await checkPendingOrder(cfg);
  if (await kvGetJson("bot:pendingOrder")) {
    _log("Pending order still active. Skipping.");
    return { action: "pending_order", log };
  }

  // ── Step 3: CHECK FOR OPEN POSITION — TAKE PROFIT LOGIC ──

  let pos = await kvGetJson("bot:position");

  // Cross-check with Kalshi (source of truth)
  const kalshiPositions = await getKalshiPositions();
  const seriesPrefix = seriesTicker + "-";
  // position field = current net holding (positive=yes, negative=no). total_traded = cumulative volume (wrong for sell count!)
  const relevantPositions = kalshiPositions.filter(p =>
    p.ticker?.startsWith(seriesPrefix) && p.position !== 0 && p.position != null
  );

  // Position recovery: if bot:position is null but Kalshi has a position, recover it
  if ((!pos || !pos.ticker) && relevantPositions.length > 0) {
    if (relevantPositions.length > 1) {
      _log("WARNING: Multiple open positions found (" + relevantPositions.length + "). Recovering first only: " +
        relevantPositions.map(p => p.ticker + "=" + p.position).join(", "));
    }
    const kp = relevantPositions[0];
    const posCount = Math.abs(kp.position || 0);
    const side = (kp.position > 0) ? "yes" : "no";
    _log("RECOVERING orphan position: " + side.toUpperCase() + " " + posCount + "x " + kp.ticker);
    let marketCloseTs = null;
    try {
      const mkt = await getMarket(kp.ticker);
      const mm = mkt?.market || mkt;
      marketCloseTs = mm?.close_time ? new Date(mm.close_time).getTime()
        : mm?.expiration_time ? new Date(mm.expiration_time).getTime() : null;
    } catch (_) {}
    // Try to get actual entry price from fills
    let entryPrice = 50;
    try {
      const fills = await kalshiFetch("/trade-api/v2/portfolio/fills?ticker=" + encodeURIComponent(kp.ticker) + "&limit=20", { method: "GET" });
      const buyFills = (fills?.fills || []).filter(f => f.action === "buy" && f.ticker === kp.ticker);
      if (buyFills.length > 0) {
        const totalCost = buyFills.reduce((s, f) => s + (f.yes_price || f.no_price || 50) * (f.count || 1), 0);
        const totalQty = buyFills.reduce((s, f) => s + (f.count || 1), 0);
        entryPrice = Math.round(totalCost / totalQty);
        _log("RECOVERED entry price: " + entryPrice + "c from " + buyFills.length + " fills");
      }
    } catch (_) {}
    pos = {
      ticker: kp.ticker, side, entryPriceCents: entryPrice, count: posCount,
      openedTs: Date.now(), orderId: null, marketCloseTs,
    };
    await kvSetJson("bot:position", pos);
    const verify = await kvGetJson("bot:position");
    _log("POSITION RECOVERED: " + (verify?.ticker || "WRITE FAILED"));
  }

  if (pos && pos.ticker) {
    const stillOnKalshi = relevantPositions.some(p => p.ticker === pos.ticker);

    if (!stillOnKalshi) {
      // Position settled. Log the result.
      _log("Position " + pos.ticker + " settled. Logging result.");

      let won = false;
      let revenueCents = 0;
      try {
        const settleData = await kalshiFetch("/trade-api/v2/portfolio/settlements?limit=10", { method: "GET" });
        const settlements = settleData?.settlements || [];
        const match = settlements.find(s => s.ticker === pos.ticker);
        if (match) {
          const result = match.market_result;
          won = (result === pos.side);
          revenueCents = won ? (pos.count * 100) : 0;
          _log("SETTLEMENT: " + pos.ticker + " result=" + result + " side=" + pos.side + " " +
            (won ? "WIN +$" + (revenueCents / 100).toFixed(2) : "LOSS"));
        }
      } catch (e) {
        _log("Settlement lookup failed: " + (e?.message || e));
      }

      const costCents = (pos.entryPriceCents || 50) * (pos.count || 1);
      const pnlCents = revenueCents - costCents;
      await logTradeResult({
        ticker: pos.ticker, side: pos.side, entryPriceCents: pos.entryPriceCents,
        count: pos.count, result: won ? "win" : "loss", exitReason: "SETTLEMENT",
        revenueCents, costCents, pnlCents,
        signal: pos.signal || null, openedTs: pos.openedTs, settledTs: Date.now(),
      });
      await recordDailyTrade(won ? "win" : "loss", pnlCents);
      await learnFromTrades();
      await kvSetJson("bot:position", null);
      pos = null;
    } else {
      // ── TAKE PROFIT / TRAILING STOP ──
      const kalshiMatch = relevantPositions.find(p => p.ticker === pos.ticker);
      const realCount = kalshiMatch ? Math.abs(kalshiMatch.position || 0) : 0;
      if (realCount > 0 && realCount !== pos.count) {
        _log("COUNT FIX: stored=" + pos.count + " kalshi=" + realCount);
        pos.count = realCount;
        await kvSetJson("bot:position", pos);
      }
      const bestBid = await getBestBidFromOrderbook(pos.ticker, pos.side);
      const entryPx = pos.entryPriceCents || 50;
      const cnt = pos.count || 1;
      const totalCost = entryPx * cnt;
      const currentValue = bestBid ? (bestBid * cnt) : 0;
      const totalProfit = currentValue - totalCost;

      // Track peak bid for trailing stop
      if (bestBid && (!pos.peakBidCents || bestBid > pos.peakBidCents)) {
        pos.peakBidCents = bestBid;
        await kvSetJson("bot:position", pos);
      }

      _log("POSITION CHECK: " + pos.side.toUpperCase() + " " + cnt + "x " + pos.ticker +
        " | entry=" + entryPx + "c bid=" + (bestBid || "?") + "c peak=" + (pos.peakBidCents || "?") + "c" +
        " | P&L=" + (totalProfit >= 0 ? "+$" : "-$") + (Math.abs(totalProfit) / 100).toFixed(2));

      // ── Balanced exit strategy: protect profits, limit losses, let winners run ──
      const minsToClose = pos.marketCloseTs ? (pos.marketCloseTs - Date.now()) / 60000 : 999;
      const updatedCnt = pos.count || 1;

      // Trailing stop: activates after +10c profit, trails 5c from peak
      // Near settlement (<3 min): don't trail — just hold for binary payout
      const trailingDropCents = 5;
      const trailingMinProfitCents = 10;
      if (bestBid && pos.peakBidCents && minsToClose >= 3 &&
          pos.peakBidCents >= (entryPx + trailingMinProfitCents) &&
          (pos.peakBidCents - bestBid) >= trailingDropCents && bestBid > entryPx) {
        _log("TRAILING STOP: bid " + bestBid + "c dropped " + (pos.peakBidCents - bestBid) + "c from peak " + pos.peakBidCents + "c");

        if (mode !== "live") {
          const rev = bestBid * updatedCnt;
          const cost = entryPx * updatedCnt;
          const pnl = rev - cost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
            exitPriceCents: bestBid, count: updatedCnt, result: "tp_exit", exitReason: "TRAILING_STOP",
            revenueCents: rev, costCents: cost, pnlCents: pnl,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade("tp_exit", pnl);
          await learnFromTrades();
          await kvSetJson("bot:position", null);
          _log("PAPER TRAILING SOLD " + updatedCnt + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
          return { action: "trailing_stop", pnlCents: pnl, log };
        }

        const sellBody = { ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: updatedCnt,
          time_in_force: "fill_or_kill",
          ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }) };
        try {
          const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
          const so = sr?.order || {};
          if (so.status === "executed" || ((so.fill_count ?? 0) > 0)) {
            const fc = (so.fill_count ?? 0) > 0 ? so.fill_count : updatedCnt;
            const rev = bestBid * fc;
            const pnl = rev - entryPx * fc;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
              exitPriceCents: bestBid, count: fc, result: "tp_exit", exitReason: "TRAILING_STOP",
              revenueCents: rev, costCents: entryPx * fc, pnlCents: pnl,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade("tp_exit", pnl);
            await learnFromTrades();
            await kvSetJson("bot:position", null);
            _log("TRAILING SOLD " + fc + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
            return { action: "trailing_stop", pnlCents: pnl, log };
          }
        } catch (e) { _log("Trailing sell failed: " + (e?.message || e)); }
      }

      // ── Tiered exit: hold for binary payout but cut losses before zero ──
      const updatedProfit = bestBid ? (bestBid * (pos.count || 1)) - (entryPx * (pos.count || 1)) : totalProfit;
      if (bestBid && updatedProfit > 0) {
        _log("IN PROFIT: +$" + (updatedProfit / 100).toFixed(2) + " — holding to settlement (" + minsToClose.toFixed(1) + " min left)");
      }
      if (bestBid) {
        // Tiered loss gates — tighter as settlement approaches:
        //   >8 min left: exit if lost >50% from entry (clearly wrong)
        //   5-8 min left: exit if lost >40% from entry (unlikely to recover)
        //   <5 min left: exit if lost >30% from entry (cut and save capital)
        //   Always: exit if bid <5c (near zero, salvage pennies)
        const lossPerContract = entryPx - bestBid;
        const lossRatio = lossPerContract / entryPx;

        let maxLossRatio;
        if (minsToClose < 5) maxLossRatio = 0.30;
        else if (minsToClose < 8) maxLossRatio = 0.40;
        else maxLossRatio = 0.50;

        const hopeless = (lossRatio >= maxLossRatio && lossPerContract > 0) ||
          (bestBid <= 5);

        if (hopeless && lossPerContract > 0) {
          const sellCnt = pos.count || 1;
          const totalLoss = lossPerContract * sellCnt;
          const reason = bestBid <= 5 ? "NEAR_ZERO" : "LOSS_GATE_" + Math.round(maxLossRatio * 100);
          _log("EXIT_LOSING: " + reason + " loss=" + lossPerContract + "c/contract ($" + (totalLoss / 100).toFixed(2) + ")" +
            " ratio=" + (lossRatio * 100).toFixed(0) + "% (gate=" + Math.round(maxLossRatio * 100) + "%) bid=" + bestBid + "c mins=" + minsToClose.toFixed(1));

          if (mode !== "live") {
            const rev = bestBid * sellCnt;
            const cost = entryPx * sellCnt;
            const pnl = rev - cost;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
              exitPriceCents: bestBid, count: sellCnt, result: "loss", exitReason: "STOP_LOSS_" + reason,
              revenueCents: rev, costCents: cost, pnlCents: pnl,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade("loss", pnl);
            await learnFromTrades();
            await kvSetJson("bot:position", null);
            _log("PAPER EXIT " + sellCnt + "x @ " + bestBid + "c, loss: $" + (Math.abs(pnl) / 100).toFixed(2));
            return { action: "stop_loss", reason, pnlCents: pnl, log };
          }

          const sellBody = { ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: sellCnt,
            time_in_force: "fill_or_kill",
            ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }) };
          try {
            const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
            const so = sr?.order || {};
            if (so.status === "executed" || ((so.fill_count ?? 0) > 0)) {
              const fc = (so.fill_count ?? 0) > 0 ? so.fill_count : sellCnt;
              const rev = bestBid * fc;
              const pnl = rev - entryPx * fc;
              await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
                exitPriceCents: bestBid, count: fc, result: "loss", exitReason: "STOP_LOSS_" + reason,
                revenueCents: rev, costCents: entryPx * fc, pnlCents: pnl,
                signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
              await recordDailyTrade("loss", pnl);
              await learnFromTrades();
              await kvSetJson("bot:position", null);
              _log("EXIT_SOLD " + fc + "x @ " + bestBid + "c, loss: $" + (Math.abs(pnl) / 100).toFixed(2));
              return { action: "stop_loss", reason, pnlCents: pnl, log };
            }
            _log("Exit sell didn't fill. Retry next run.");
          } catch (e) { _log("Exit sell failed: " + (e?.message || e)); }
        } else if (updatedProfit <= 0) {
          _log("UNDERWATER: -$" + (Math.abs(updatedProfit) / 100).toFixed(2) + " (loss=" + (lossRatio * 100).toFixed(0) + "% gate=" + Math.round(maxLossRatio * 100) + "%) — holding, " + minsToClose.toFixed(1) + " min left");
        }
      } else if (!bestBid) {
        _log("NO BIDS on orderbook for " + pos.ticker + " — holding to settlement");
      }

      await kvSetJson("bot:state", { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", totalProfit: updatedProfit, log };
    }
  }

  // ── Step 4: Pre-entry checks ──

  const cooldownOk = await checkCooldown(cfg);
  if (!cooldownOk) return { action: "cooldown", log };

  // ── Step 5: Generate signal ──

  const sig = await getSignal();

  if (sig.direction === "neutral" || !sig.predProb) {
    _log("No trade -- signal is neutral.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_signal", signal: sig, log };
  }

  const predProb = sig.predProb;

  // ── Hourly gate: skip hours with <30% win rate (3+ samples) ──
  const learned = await kvGetJson("bot:learned_weights");
  const hourlyGate = learned?.hourlyStats;
  if (hourlyGate) {
    const currentHour = new Date().getUTCHours();
    const hourData = hourlyGate[currentHour];
    if (hourData && hourData.total >= 30 && (hourData.wins / hourData.total) < 0.3) {
      _log("HOURLY GATE: hour " + currentHour + " UTC has " + Math.round(hourData.wins / hourData.total * 100) + "% win rate. Skipping.");
      return { action: "hourly_gate", log };
    }
  }

  // ── Combo bonus: add score if agreeing pair has >65% historical win rate ──
  const comboBonus = learned?.comboStats;
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
    if (comboBonusScore > 0) _log("COMBO BONUS: +" + comboBonusScore.toFixed(1) + " from strong pairs");
  }

  // ── Price optimization: adjust effective min/max entry based on learned advice ──
  let effectiveMinEntry = minEntryPriceCents;
  let effectiveMaxEntry = maxEntryPriceCents;
  const priceAdvice = learned?.priceAdvice;
  if (priceAdvice === "low_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMinEntry = Math.min(effectiveMinEntry + 10, 55);
    _log("PRICE OPT: raising min entry to " + effectiveMinEntry + "c (low prices losing)");
  }
  if (priceAdvice === "high_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMaxEntry = Math.max(effectiveMaxEntry - 10, 60);
    _log("PRICE OPT: lowering max entry to " + effectiveMaxEntry + "c (high prices losing)");
  }

  // ── Step 6: Find best market ──

  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  _log("Markets found: " + markets.length);

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
    _log("No markets with " + minMinutesToCloseToEnter + "+ min remaining.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_markets", log };
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

    // Store market close time for position tracking
    const closeTs = m.close_time ? new Date(m.close_time).getTime()
      : m.expiration_time ? new Date(m.expiration_time).getTime() : null;

    if (!best || edge > best.edge) {
      best = { ticker, side, targetAsk, limitPrice, edge, source: px.source, volume: Number(m.volume || 0), marketCloseTs: closeTs };
    }
  }

  if (!best) {
    _log("No trade -- no market in price band " + minEntryPriceCents + "-" + maxEntryPriceCents + "c.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_edge", log };
  }

  // Apply combo bonus to effective edge
  if (comboBonusScore > 0) {
    best.edge += comboBonusScore;
    _log("EDGE with combo: " + best.edge.toFixed(1) + "c");
  }

  _log("BEST MARKET: " + best.ticker + " " + best.side + " ask=" + best.targetAsk + "c limit=" + best.limitPrice + "c edge=" + best.edge.toFixed(1) + "c");

  if (best.edge < minEdge) {
    _log("No trade -- edge " + best.edge.toFixed(1) + "c < min " + minEdge + "c.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "insufficient_edge", log };
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
      _log("DEPTH GATE: only " + totalDepth + " contracts on " + best.side + " book (need 10+). Skipping.");
    } else {
      _log("DEPTH: " + totalDepth + " contracts on " + best.side + " book");
    }
  } catch (e) { _log("Depth check failed: " + (e?.message || e)); }

  if (!depthOk) {
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "depth_gate", log };
  }

  // ── Step 7: Place maker order (confidence-based sizing) ──
  const learnedWinRate = learned?.winRate || 50;
  const confidence = sig.confidence || 0.5;
  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice, winRate: learnedWinRate, confidence });
  const betSize = (best.limitPrice * count / 100).toFixed(2);
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice +
    "c (conf=" + (confidence * 100).toFixed(0) + "% wr=" + learnedWinRate + "% bet=$" + betSize + " mode=" + mode + ")";
  _log("ORDER: " + line);

  // Candle snapshot for backtesting
  const rawCandles = sig.candles || [];
  const candleSnapshot = rawCandles.slice(-5).map(c => ({ c: c.close, v: c.volume, h: c.high, l: c.low }));
  const sigData = { direction: sig.direction, score: sig.score, predProb, indicators: sig.indicators,
    mtfBoost: sig.mtfBoost, volRatio: sig.volRatio, atrPct: sig.atrPct,
    candleSnapshot };

  if (mode !== "live") {
    _log("PAPER MODE: " + line);
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: sigData, marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson("bot:position", posData);
    await kvSetJson("bot:lastTradeTs", Date.now());
    const verify = await kvGetJson("bot:position");
    _log("POSITION SAVED: " + (verify?.ticker || "WRITE FAILED"));
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return { action: "paper_buy", position: posData, log };
  }

  const orderBody = {
    ticker: best.ticker, action: "buy", type: "limit", side: best.side, count,
    ...(best.side === "yes" ? { yes_price: best.limitPrice } : { no_price: best.limitPrice }),
  };

  const res = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
  _log("ORDER RESULT: " + JSON.stringify(res));

  const order = res?.order || {};
  const status = order.status || "";

  if (status === "executed" || ((order.fill_count ?? 0) > 0)) {
    const fillCount = (order.fill_count ?? 0) > 0 ? order.fill_count : count;
    _log("ORDER FILLED immediately: " + fillCount + "x @ " + best.limitPrice + "c");
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fillCount, openedTs: Date.now(), orderId: order.order_id || null,
      signal: sigData, marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson("bot:position", posData);
    const verify = await kvGetJson("bot:position");
    _log("POSITION SAVED: " + (verify?.ticker || "WRITE FAILED"));
    await kvSetJson("bot:lastTradeTs", Date.now());
  } else if (status === "resting") {
    _log("ORDER RESTING on book. Will check for fill next run.");
    await kvSetJson("bot:pendingOrder", {
      orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(), signal: sigData,
    });
  } else {
    _log("ORDER STATUS unexpected: " + status);
  }

  await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
  return { action: "order_placed", status, log };
}

// ── CLI entry point ──

const isMainModule = process.argv[1] && (
  process.argv[1].endsWith("run-bot-clean.mjs") ||
  process.argv[1].endsWith("run-bot-clean")
);

if (isMainModule) {
  runBotCycle().then(result => {
    console.log("RESULT:", result?.action || "unknown");
  }).catch((e) => {
    console.error("Bot runner failed:", e?.message || e);
    process.exit(1);
  });
}
