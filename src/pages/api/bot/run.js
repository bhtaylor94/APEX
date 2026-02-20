// Vercel API route: GET /api/bot/run
// Triggered by cron-job.org every 1 minute.
// Runs the full bot cycle: check position → take profit → signal → entry.

import crypto from "crypto";
import { kvGetJson, kvSetJson } from "./_upstash";

// ── Kalshi auth (same as lib/kalshi.js) ──

const KALSHI_BASE = (process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod") === "demo"
  ? "https://demo-api.kalshi.co"
  : "https://api.elections.kalshi.com";

function formatPem(raw) {
  if (!raw) return raw;
  let key = String(raw).trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n").replace(/\r\n/g, "\n");
  if (!key.includes("-----BEGIN")) {
    const lines = key.replace(/\s/g, "").match(/.{1,64}/g) || [];
    return "-----BEGIN PRIVATE KEY-----\n" + lines.join("\n") + "\n-----END PRIVATE KEY-----";
  }
  return key;
}

function kalshiFetch(path, { method = "GET", body = null } = {}) {
  const apiKeyId = process.env.KALSHI_API_KEY_ID || process.env.NEXT_PUBLIC_KALSHI_API_KEY_ID;
  const privateKey = process.env.KALSHI_PRIVATE_KEY;
  if (!apiKeyId || !privateKey) throw new Error("Kalshi credentials not configured");

  const ts = Date.now();
  const pathNoQuery = path.split("?")[0];
  const msg = String(ts) + method.toUpperCase() + pathNoQuery;
  const pem = formatPem(privateKey);
  const signature = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });

  const headers = {
    "KALSHI-ACCESS-KEY": apiKeyId,
    "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": String(ts),
    "Content-Type": "application/json",
  };

  const url = KALSHI_BASE + path;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  return fetch(url, opts).then(async (res) => {
    const txt = await res.text();
    let data;
    try { data = JSON.parse(txt); } catch { data = { raw: txt }; }
    if (!res.ok) throw new Error("Kalshi " + method + " " + path + " (" + res.status + "): " + txt);
    return data;
  });
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

// ── Coinbase ──

const CB = "https://api.exchange.coinbase.com";

async function fetchCandles(limit = 100) {
  const res = await fetch(CB + "/products/BTC-USD/candles?granularity=60");
  if (!res.ok) throw new Error("Coinbase candles " + res.status);
  const data = await res.json();
  return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
}

async function fetchCandles5m(limit = 50) {
  const res = await fetch(CB + "/products/BTC-USD/candles?granularity=300");
  if (!res.ok) return null;
  const data = await res.json();
  return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
}

async function fetchCandles15m(limit = 30) {
  const res = await fetch(CB + "/products/BTC-USD/candles?granularity=900");
  if (!res.ok) return null;
  const data = await res.json();
  return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
}

async function fetchBtcOrderBook() {
  const res = await fetch(CB + "/products/BTC-USD/book?level=2");
  if (!res.ok) throw new Error("Coinbase book " + res.status);
  const data = await res.json();
  let bid = 0, ask = 0;
  for (const [, s] of (data.bids || []).slice(0, 10)) bid += parseFloat(s);
  for (const [, s] of (data.asks || []).slice(0, 10)) ask += parseFloat(s);
  const t = bid + ask;
  return { ratio: t > 0 ? bid / t : 0.5 };
}

// ── Indicators ──

function sma(data, period) {
  if (data.length < period) return null;
  return data.slice(-period).reduce((s, v) => s + v, 0) / period;
}

function computeRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  const changes = [];
  for (let i = 1; i < closes.length; i++) changes.push(closes[i] - closes[i - 1]);
  const recent = changes.slice(-period);
  let gains = 0, losses = 0;
  for (const c of recent) { if (c > 0) gains += c; else losses += Math.abs(c); }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / (losses / period));
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

// ── Adaptive learning ──

const DEFAULT_WEIGHTS = { rsi: 1, bb: 1, ob: 3 };
const INDICATORS = ["rsi", "bb", "ob"];

async function getLearnedWeights() {
  const learned = await kvGetJson("bot:learned_weights");
  if (!learned || !learned.weights) return { weights: { ...DEFAULT_WEIGHTS }, minScoreThreshold: 2 };
  return { weights: { ...DEFAULT_WEIGHTS, ...learned.weights }, minScoreThreshold: learned.minScoreThreshold || 2 };
}

async function learnFromTrades(L) {
  const history = (await kvGetJson("bot:trade_history")) || [];
  const trades = history.filter(t => t.signal && t.signal.indicators);
  if (trades.length < 5) return;

  const recent = trades.slice(-20);
  const stats = {};
  for (const ind of INDICATORS) stats[ind] = { correct: 0, wrong: 0, neutral: 0 };
  let wins = 0, losses = 0, totalPnl = 0;

  // Combo tracking: pairwise indicator agreement win rates
  const comboStats = {};
  // Hourly stats: win rate by hour UTC
  const hourlyStats = {};
  // Entry price tracking
  const entryPriceStats = { low: 0, lowWin: 0, mid: 0, midWin: 0, high: 0, highWin: 0 };

  for (const t of recent) {
    const won = t.result === "win" || t.result === "tp_exit";
    const lost = t.result === "loss";
    if (won) wins++; if (lost) losses++;
    totalPnl += (t.pnlCents || 0);
    const inds = t.signal.indicators;
    if (!inds) continue;

    // Per-indicator stats
    for (const ind of INDICATORS) {
      const vote = inds[ind] || 0;
      if (vote === 0) {
        stats[ind].neutral++;
        continue;
      }
      const votedUp = vote > 0;
      const withTrade = (t.signal.direction === "up" && votedUp) || (t.signal.direction === "down" && !votedUp);
      if ((withTrade && won) || (!withTrade && lost)) stats[ind].correct++;
      else stats[ind].wrong++;
    }

    // Combo stats: track pairwise agreement
    for (let a = 0; a < INDICATORS.length; a++) {
      for (let b = a + 1; b < INDICATORS.length; b++) {
        const va = inds[INDICATORS[a]] || 0;
        const vb = inds[INDICATORS[b]] || 0;
        if (va !== 0 && vb !== 0 && va === vb) {
          const key = INDICATORS[a] + "+" + INDICATORS[b];
          if (!comboStats[key]) comboStats[key] = { wins: 0, total: 0 };
          comboStats[key].total++;
          if (won) comboStats[key].wins++;
        }
      }
    }

    // Hourly stats
    const ts = t.openedTs || t.settledTs || t.closedTs;
    if (ts) {
      const hour = new Date(ts).getUTCHours();
      if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, total: 0 };
      hourlyStats[hour].total++;
      if (won) hourlyStats[hour].wins++;
    }

    // Entry price stats
    const ep = t.entryPriceCents || 50;
    if (ep < 45) { entryPriceStats.low++; if (won) entryPriceStats.lowWin++; }
    else if (ep <= 65) { entryPriceStats.mid++; if (won) entryPriceStats.midWin++; }
    else { entryPriceStats.high++; if (won) entryPriceStats.highWin++; }
  }

  const newWeights = {};
  for (const ind of INDICATORS) {
    const total = stats[ind].correct + stats[ind].wrong;
    if (total < 3) { newWeights[ind] = DEFAULT_WEIGHTS[ind]; continue; }
    const acc = stats[ind].correct / total;
    newWeights[ind] = Math.round(DEFAULT_WEIGHTS[ind] * Math.max(0.25, Math.min(3, acc * 2)) * 100) / 100;
  }

  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0.5;

  // Count recent consecutive losses (streak from end of array)
  let lossStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].result === "loss") lossStreak++;
    else break;
  }

  // Dynamic threshold: base=2, tighten on losses, loosen on good performance
  let minScore = 2;
  if (lossStreak >= 5) minScore = 2.25;
  else if (winRate >= 0.65 && total >= 5) minScore = 1.5;
  else if (winRate < 0.35 && total >= 5) minScore = 2;

  const mode = lossStreak >= 5 ? "recovery" : winRate >= 0.6 ? "aggressive" : "normal";

  // Entry price advice
  let priceAdvice = null;
  if (entryPriceStats.low >= 30 && entryPriceStats.lowWin / entryPriceStats.low < 0.3) {
    priceAdvice = "low_price_losing";
  }
  if (entryPriceStats.high >= 30 && entryPriceStats.highWin / entryPriceStats.high < 0.3) {
    priceAdvice = priceAdvice ? "both_extremes_losing" : "high_price_losing";
  }

  await kvSetJson("bot:learned_weights", { weights: newWeights, minScoreThreshold: minScore,
    winRate: Math.round(winRate * 100), totalTrades: total, totalPnl, lossStreak, mode,
    indicatorStats: stats, comboStats, hourlyStats, priceAdvice, lastUpdated: Date.now() });
  if (L) L("LEARNED: weights=" + JSON.stringify(newWeights) + " minScore=" + minScore + " mode=" + mode +
    " winRate=" + Math.round(winRate * 100) + "% streak=" + lossStreak + "L" +
    (priceAdvice ? " price=" + priceAdvice : ""));
}

function getSignalWithWeights(closes, obRatio, weights, minScoreThreshold) {
  const price = closes[closes.length - 1];
  // RSI-9 (faster period for 1-min candles)
  const rsi = computeRSI(closes, 9);

  const avg = sma(closes, 20);
  const slice = closes.slice(-20);
  const std = avg ? Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / 20) : 0;
  const bbLower = avg ? avg - 2 * std : null;
  const bbUpper = avg ? avg + 2 * std : null;

  const indicators = { rsi: 0, bb: 0, ob: 0 };
  let score = 0;
  const bd = {};

  if (rsi < 30) indicators.rsi = 1; else if (rsi > 70) indicators.rsi = -1;
  score += indicators.rsi * (weights.rsi || 1);
  bd.rsi = (indicators.rsi !== 0 ? (indicators.rsi > 0 ? "+" : "-") + (weights.rsi || 1) : "0");

  if (bbLower && price < bbLower) indicators.bb = 1; else if (bbUpper && price > bbUpper) indicators.bb = -1;
  score += indicators.bb * (weights.bb || 1);
  bd.bb = (indicators.bb !== 0 ? (indicators.bb > 0 ? "+" : "-") + (weights.bb || 1) : "0");

  if (obRatio > 0.60) indicators.ob = 1; else if (obRatio < 0.40) indicators.ob = -1;
  score += indicators.ob * (weights.ob || 3);
  bd.ob = (indicators.ob !== 0 ? (indicators.ob > 0 ? "+" : "-") + (weights.ob || 3) : "0");

  const maxScore = (weights.rsi || 1) + (weights.bb || 1) + (weights.ob || 3);
  const abs = Math.abs(score);
  if (abs < minScoreThreshold) return { direction: "neutral", score, breakdown: bd, indicators };
  return {
    direction: score > 0 ? "up" : "down", score, indicators,
    predProb: 50 + (abs / maxScore) * 30, breakdown: bd,
  };
}

// ── Kalshi helpers ──

async function getKalshiPositions(log) {
  try {
    const data = await kalshiFetch("/trade-api/v2/portfolio/positions?limit=100&settlement_status=unsettled", { method: "GET" });
    const positions = data?.market_positions || data?.positions || [];
    if (log && positions.length > 0) log("KALSHI_POS_RAW: " + JSON.stringify(positions.map(p => ({
      ticker: p.ticker, position: p.position, total_traded: p.total_traded,
      market_position: p.market_position, resting_orders_count: p.resting_orders_count
    }))));
    return positions;
  } catch { return []; }
}

async function getBestBid(ticker, side, log) {
  // Try up to 2 times — sell decisions depend on this
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ob = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker) + "/orderbook?depth=10", { method: "GET" });
      const book = ob?.orderbook || ob;
      const bids = book?.[side] || [];
      if (bids.length === 0) {
        if (log) log("ORDERBOOK: " + side + " bids empty for " + ticker + " (attempt " + attempt + ")");
        continue;
      }
      const raw = bids[bids.length - 1];
      const price = validPx(Array.isArray(raw) ? raw[0] : raw?.price ?? raw);
      if (log) log("ORDERBOOK: " + side + " best bid = " + price + "c for " + ticker);
      return price;
    } catch (e) {
      if (log) log("ORDERBOOK ERROR (attempt " + attempt + "): " + (e?.message || e));
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

async function getMarketPrices(ticker) {
  try {
    const m = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker), { method: "GET" });
    const mm = m?.market || m;
    return {
      yesAsk: validPx(mm?.yes_ask), noAsk: validPx(mm?.no_ask),
      closeTime: mm?.close_time || mm?.expiration_time || null,
    };
  } catch { return { yesAsk: null, noAsk: null, closeTime: null }; }
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
}

async function logTradeResult(entry) {
  entry.hourUtc = new Date().getUTCHours();
  const history = (await kvGetJson("bot:trade_history")) || [];
  history.push(entry);
  if (history.length > 100) history.splice(0, history.length - 100);
  await kvSetJson("bot:trade_history", history);
}

// ── Main bot cycle ──

async function runBotCycle() {
  const log = [];
  const L = (m) => { log.push(m); };

  const cfg = (await kvGetJson("bot:config")) || {};
  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();
  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 10);
  const maxContracts = Number(cfg.maxContracts ?? 10);
  const minEdge = Number(cfg.minEdge ?? 5);
  const minEntryPriceCents = Number(cfg.minEntryPriceCents ?? 35);
  const maxEntryPriceCents = Number(cfg.maxEntryPriceCents ?? 80);
  const minMinutesToClose = Number(cfg.minMinutesToCloseToEnter ?? 3);
  const makerOffset = Number(cfg.makerOffsetCents ?? 2);
  const cooldownMin = Number(cfg.cooldownMinutes ?? 5);
  const dailyMaxLossUsd = Number(cfg.dailyMaxLossUsd ?? 10);

  L("CONFIG: mode=" + mode + " tp=any_profit");

  if (!enabled) { L("Bot disabled."); return { action: "disabled", log }; }

  // ── Daily limits ──
  const stats = await getDailyStats();
  if (stats.totalPnlCents <= -(dailyMaxLossUsd * 100)) {
    L("DAILY LOSS LIMIT hit: $" + (stats.totalPnlCents / 100).toFixed(2));
    return { action: "daily_limit", stats, log };
  }
  // No trade count limit — only stop on loss limit

  // ── Pending orders ──
  const pending = await kvGetJson("bot:pendingOrder");
  if (pending?.orderId) {
    const ageMs = Date.now() - (pending.placedTs || 0);
    const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;
    try {
      const od = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const o = od?.order || od;
      if (o.status === "executed" || ((o.fill_count ?? 0) > 0)) {
        L("PENDING FILLED: " + pending.orderId);
        let closeTime = null;
        try { const mp = await getMarketPrices(pending.ticker); closeTime = mp.closeTime; } catch {}
        await kvSetJson("bot:position", {
          ticker: pending.ticker, side: pending.side, entryPriceCents: pending.limitPrice,
          count: (o.fill_count ?? 0) > 0 ? o.fill_count : pending.count, openedTs: pending.placedTs,
          orderId: pending.orderId, signal: pending.signal, marketCloseTs: closeTime ? new Date(closeTime).getTime() : null,
        });
        await kvSetJson("bot:pendingOrder", null);
      } else if (ageMs >= timeoutMs) {
        L("PENDING TIMEOUT. Canceling.");
        try { await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "DELETE" }); } catch {}
        await kvSetJson("bot:pendingOrder", null);
      } else {
        L("PENDING still resting (" + Math.round(ageMs / 1000) + "s).");
        return { action: "pending_order", log };
      }
    } catch {
      if (ageMs >= timeoutMs) { await kvSetJson("bot:pendingOrder", null); }
      else { return { action: "pending_order", log }; }
    }
  }

  // ── Position check + take profit ──
  let pos = await kvGetJson("bot:position");
  const kalshiPos = await getKalshiPositions(L);
  const prefix = seriesTicker + "-";
  // position = current net holding count (positive=yes, negative=no). total_traded = cumulative volume (useless for sell count)
  const relevant = kalshiPos.filter(p => p.ticker?.startsWith(prefix) && p.position !== 0 && p.position != null);

  // Recovery — if we have no tracked position but Kalshi shows one
  if ((!pos || !pos.ticker) && relevant.length > 0) {
    if (relevant.length > 1) {
      L("WARNING: Multiple open positions (" + relevant.length + "). Recovering first: " +
        relevant.map(p => p.ticker + "=" + p.position).join(", "));
    }
    const kp = relevant[0];
    // position > 0 = holding YES, position < 0 = holding NO
    const posCount = Math.abs(kp.position || 0);
    const side = (kp.position > 0) ? "yes" : "no";
    L("RECOVERING position: " + side + " " + posCount + "x " + kp.ticker);
    let closeTime = null;
    try { const mp = await getMarketPrices(kp.ticker); closeTime = mp.closeTime; } catch {}
    // Try to get actual entry from fills
    let entryPrice = 50;
    try {
      const fills = await kalshiFetch("/trade-api/v2/portfolio/fills?ticker=" + encodeURIComponent(kp.ticker) + "&limit=20", { method: "GET" });
      const buyFills = (fills?.fills || []).filter(f => f.action === "buy" && f.ticker === kp.ticker);
      if (buyFills.length > 0) {
        const totalCost = buyFills.reduce((s, f) => s + (f.yes_price || f.no_price || 50) * (f.count || 1), 0);
        const totalQty = buyFills.reduce((s, f) => s + (f.count || 1), 0);
        entryPrice = Math.round(totalCost / totalQty);
        L("RECOVERED entry price: " + entryPrice + "c from " + buyFills.length + " fills");
      }
    } catch {}
    pos = { ticker: kp.ticker, side, entryPriceCents: entryPrice, count: posCount,
      openedTs: Date.now(), marketCloseTs: closeTime ? new Date(closeTime).getTime() : null };
    await kvSetJson("bot:position", pos);
  }

  if (pos?.ticker) {
    const onKalshi = relevant.some(p => p.ticker === pos.ticker);

    if (!onKalshi) {
      // Settled
      L("SETTLED: " + pos.ticker);
      let won = false, revenueCents = 0;
      try {
        const sd = await kalshiFetch("/trade-api/v2/portfolio/settlements?limit=10", { method: "GET" });
        const match = (sd?.settlements || []).find(s => s.ticker === pos.ticker);
        if (match) { won = (match.market_result === pos.side); revenueCents = won ? pos.count * 100 : 0; }
      } catch {}
      const costCents = (pos.entryPriceCents || 50) * (pos.count || 1);
      const pnl = revenueCents - costCents;
      L(won ? "WIN +$" + (revenueCents / 100).toFixed(2) : "LOSS -$" + (costCents / 100).toFixed(2));
      await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: pos.entryPriceCents,
        count: pos.count, result: won ? "win" : "loss", exitReason: "SETTLEMENT", revenueCents, costCents, pnlCents: pnl,
        signal: pos.signal, openedTs: pos.openedTs, settledTs: Date.now() });
      await recordDailyTrade(won ? "win" : "loss", pnl);
      await learnFromTrades(L);
      await kvSetJson("bot:position", null);
      pos = null;
    } else {
      // Take profit / trailing stop — verify actual count from Kalshi
      const bestBid = await getBestBid(pos.ticker, pos.side, L);
      const entry = pos.entryPriceCents || 50;
      const kalshiMatch = relevant.find(p => p.ticker === pos.ticker);
      const realCount = kalshiMatch ? Math.abs(kalshiMatch.position || 0) : 0;
      if (realCount > 0 && realCount !== pos.count) {
        L("COUNT FIX: stored=" + pos.count + " kalshi=" + realCount);
        pos.count = realCount;
        await kvSetJson("bot:position", pos);
      }
      const cnt = pos.count || 1;
      const totalCost = entry * cnt;
      const totalVal = bestBid ? bestBid * cnt : 0;
      const profit = totalVal - totalCost;

      // Track peak bid for trailing stop
      if (bestBid && (!pos.peakBidCents || bestBid > pos.peakBidCents)) {
        pos.peakBidCents = bestBid;
        await kvSetJson("bot:position", pos);
      }

      L("POSITION: " + pos.side.toUpperCase() + " " + cnt + "x " + pos.ticker +
        " entry=" + entry + "c bid=" + (bestBid || "?") + "c peak=" + (pos.peakBidCents || "?") +
        "c P&L=" + (profit >= 0 ? "+$" : "-$") + (Math.abs(profit) / 100).toFixed(2));

      // ── Trailing stop: sell if price drops 8c from peak (and we're in profit) ──
      const trailingDropCents = 8;
      const updatedCnt = pos.count || 1;
      if (bestBid && pos.peakBidCents && (pos.peakBidCents - bestBid) >= trailingDropCents && bestBid > entry) {
        L("TRAILING STOP: bid " + bestBid + "c dropped " + (pos.peakBidCents - bestBid) + "c from peak " + pos.peakBidCents + "c. Selling.");

        if (mode !== "live") {
          const rev = bestBid * updatedCnt;
          const cost = entry * updatedCnt;
          const pnl = rev - cost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
            exitPriceCents: bestBid, count: updatedCnt, result: "tp_exit", exitReason: "TRAILING_STOP",
            revenueCents: rev, costCents: cost, pnlCents: pnl,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade("tp_exit", pnl);
          await learnFromTrades(L);
          await kvSetJson("bot:position", null);
          L("PAPER TRAILING SOLD " + updatedCnt + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
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
            const pnl = rev - entry * fc;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
              exitPriceCents: bestBid, count: fc, result: "tp_exit", exitReason: "TRAILING_STOP",
              revenueCents: rev, costCents: entry * fc, pnlCents: pnl,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade("tp_exit", pnl);
            await learnFromTrades(L);
            await kvSetJson("bot:position", null);
            L("TRAILING SOLD " + fc + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
            return { action: "trailing_stop", pnlCents: pnl, log };
          }
          L("Trailing sell didn't fill. Retry next run.");
        } catch (e) { L("Trailing sell failed: " + (e?.message || e)); }
      }

      // ── Take profit: exit on ANY profit ──
      const updatedProfit = bestBid ? (bestBid * (pos.count || 1)) - (entry * (pos.count || 1)) : profit;
      if (bestBid && updatedProfit > 0) {
        const sellCnt = pos.count || 1;
        L("TAKE PROFIT: +$" + (updatedProfit / 100).toFixed(2) + " — exiting on profit");

        if (mode !== "live") {
          const rev = bestBid * sellCnt;
          const cost = entry * sellCnt;
          const pnl = rev - cost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
            exitPriceCents: bestBid, count: sellCnt, result: "tp_exit", exitReason: "TAKE_PROFIT",
            revenueCents: rev, costCents: cost, pnlCents: pnl,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade("tp_exit", pnl);
          await learnFromTrades(L);
          await kvSetJson("bot:position", null);
          L("PAPER SOLD " + sellCnt + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
          return { action: "take_profit", pnlCents: pnl, log };
        }

        const sellBody = {
          ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: sellCnt,
          time_in_force: "fill_or_kill",
          ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }),
        };
        try {
          const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
          const so = sr?.order || {};
          if (so.status === "executed" || ((so.fill_count ?? 0) > 0)) {
            const fc = (so.fill_count ?? 0) > 0 ? so.fill_count : sellCnt;
            const rev = bestBid * fc;
            const pnl = rev - entry * fc;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
              exitPriceCents: bestBid, count: fc, result: "tp_exit", exitReason: "TAKE_PROFIT",
              revenueCents: rev, costCents: entry * fc, pnlCents: pnl,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade("tp_exit", pnl);
            await learnFromTrades(L);
            await kvSetJson("bot:position", null);
            L("SOLD " + fc + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
            return { action: "take_profit", pnlCents: pnl, log };
          }
          L("Sell didn't fill (status=" + so.status + "). Retry next run.");
        } catch (e) { L("Sell failed: " + (e?.message || e)); }
      } else if (bestBid) {
        // ── Recognize hopeless trades and exit early ──
        // Instead of a fixed stop-loss, observe if the trade is clearly lost:
        // 1. Bid has collapsed >50% from entry (market decided against us)
        // 2. Running out of time AND losing significantly (no time to recover)
        // 3. Bid is near floor (<5c) — effectively zero, salvage what's left
        const lossPerContract = entry - bestBid;
        const lossRatio = lossPerContract / entry;
        const minsToClose = pos.marketCloseTs ? (pos.marketCloseTs - Date.now()) / 60000 : 999;

        const hopeless = (lossRatio >= 0.5) ||                    // lost half+ of entry
          (bestBid <= 5) ||                                        // bid near zero, salvage pennies
          (minsToClose < 3 && lossPerContract > 5);                // almost settled & losing

        if (hopeless && lossPerContract > 0) {
          const sellCnt = pos.count || 1;
          const totalLoss = lossPerContract * sellCnt;
          const reason = lossRatio >= 0.5 ? "COLLAPSED" : bestBid <= 5 ? "NEAR_ZERO" : "TIME_EXIT";
          L("EXIT_LOSING: " + reason + " loss=" + lossPerContract + "c/contract ($" + (totalLoss / 100).toFixed(2) + ")" +
            " ratio=" + (lossRatio * 100).toFixed(0) + "% bid=" + bestBid + "c mins=" + minsToClose.toFixed(1));

          if (mode !== "live") {
            const rev = bestBid * sellCnt;
            const cost = entry * sellCnt;
            const pnl = rev - cost;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
              exitPriceCents: bestBid, count: sellCnt, result: "loss", exitReason: "STOP_LOSS_" + reason,
              revenueCents: rev, costCents: cost, pnlCents: pnl,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade("loss", pnl);
            await learnFromTrades(L);
            await kvSetJson("bot:position", null);
            L("PAPER EXIT " + sellCnt + "x @ " + bestBid + "c, loss: $" + (Math.abs(pnl) / 100).toFixed(2));
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
              const pnl = rev - entry * fc;
              await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
                exitPriceCents: bestBid, count: fc, result: "loss", exitReason: "STOP_LOSS_" + reason,
                revenueCents: rev, costCents: entry * fc, pnlCents: pnl,
                signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
              await recordDailyTrade("loss", pnl);
              await learnFromTrades(L);
              await kvSetJson("bot:position", null);
              L("EXIT_SOLD " + fc + "x @ " + bestBid + "c, loss: $" + (Math.abs(pnl) / 100).toFixed(2));
              return { action: "stop_loss", reason, pnlCents: pnl, log };
            }
            L("Exit sell didn't fill. Retry next run.");
          } catch (e) { L("Exit sell failed: " + (e?.message || e)); }
        } else {
          L("Underwater. Holding to settlement.");
        }
      } else if (!bestBid) {
        L("NO BIDS on orderbook for " + pos.ticker + " — holding to settlement");
      }
      await kvSetJson("bot:state", { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", profit: updatedProfit, log };
    }
  }

  // ── Cooldown (streak-aware) ──
  const learned = await kvGetJson("bot:learned_weights");
  const currentLossStreak = learned?.lossStreak || 0;
  const cooldownMultiplier = Math.min(2, 1 + currentLossStreak * 0.25);
  const effectiveCooldown = cooldownMin * cooldownMultiplier;
  const lastTrade = await kvGetJson("bot:lastTradeTs");
  if (lastTrade && (Date.now() - lastTrade) < effectiveCooldown * 60000) {
    L("COOLDOWN: " + Math.round((effectiveCooldown * 60000 - (Date.now() - lastTrade)) / 1000) + "s left" +
      (cooldownMultiplier > 1 ? " (streak x" + cooldownMultiplier.toFixed(1) + ")" : ""));
    return { action: "cooldown", log };
  }

  // ── Signal (multi-timeframe + volume + ATR) ──
  let candles, ob, candles5m, candles15m;
  try {
    [candles, ob, candles5m, candles15m] = await Promise.all([
      fetchCandles(100), fetchBtcOrderBook(),
      fetchCandles5m(50), fetchCandles15m(30),
    ]);
  } catch (e) { L("Data fetch failed: " + (e?.message || e)); return { action: "data_error", log }; }

  if (!candles || candles.length < 30) { L("Insufficient candle data."); return { action: "no_data", log }; }

  const closes = candles.map(c => c.close);
  const { weights, minScoreThreshold } = await getLearnedWeights();
  const tradingMode = learned?.mode || "normal";
  const sig = getSignalWithWeights(closes, ob.ratio, weights, minScoreThreshold);

  // Multi-timeframe confirmation: boost score if 5m and 15m RSI+BB agree
  let mtfBoost = 0;
  if (sig.direction !== "neutral") {
    const sigDir = sig.score > 0 ? 1 : -1;
    if (candles5m && candles5m.length >= 20) {
      const c5 = candles5m.map(c => c.close);
      const rsi5 = computeRSI(c5, 9);
      const bb5avg = sma(c5, 20);
      const bb5slice = c5.slice(-20);
      const bb5std = bb5avg ? Math.sqrt(bb5slice.reduce((s, v) => s + (v - bb5avg) ** 2, 0) / 20) : 0;
      const rsiDir = rsi5 < 40 ? 1 : rsi5 > 60 ? -1 : 0;
      const bbDir = bb5avg ? (c5[c5.length - 1] < bb5avg - 2 * bb5std ? 1 : c5[c5.length - 1] > bb5avg + 2 * bb5std ? -1 : 0) : 0;
      const dir5 = rsiDir + bbDir;
      if (dir5 !== 0 && Math.sign(dir5) === sigDir) mtfBoost += 0.5;
    }
    if (candles15m && candles15m.length >= 20) {
      const c15 = candles15m.map(c => c.close);
      const rsi15 = computeRSI(c15, 9);
      const bb15avg = sma(c15, 20);
      const bb15slice = c15.slice(-20);
      const bb15std = bb15avg ? Math.sqrt(bb15slice.reduce((s, v) => s + (v - bb15avg) ** 2, 0) / 20) : 0;
      const rsiDir = rsi15 < 40 ? 1 : rsi15 > 60 ? -1 : 0;
      const bbDir = bb15avg ? (c15[c15.length - 1] < bb15avg - 2 * bb15std ? 1 : c15[c15.length - 1] > bb15avg + 2 * bb15std ? -1 : 0) : 0;
      const dir15 = rsiDir + bbDir;
      if (dir15 !== 0 && Math.sign(dir15) === sigDir) mtfBoost += 0.5;
    }
    if (mtfBoost > 0) sig.score += mtfBoost * Math.sign(sig.score);
  }

  // Volume confirmation: skip if volume declining on directional signal
  const volumes = candles.map(c => c.volume || 0);
  const avgVol = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
  const recentVol = volumes.length >= 5 ? volumes.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;
  let volumeOk = true;
  if (sig.direction !== "neutral" && volRatio < 0.5) {
    volumeOk = false;
  }

  // ATR regime: compute volatility
  const atr = computeATR(candles, 14);
  const atrPct = atr && closes[closes.length - 1] > 0 ? (atr / closes[closes.length - 1]) * 100 : 0;
  let atrOk = true;
  if (atrPct > 0 && atrPct < 0.02) atrOk = false;

  L("SIGNAL: score=" + sig.score + " threshold=" + minScoreThreshold + " mode=" + tradingMode +
    " dir=" + (sig.direction || "neutral") + " " + JSON.stringify(sig.breakdown) +
    " mtf=+" + mtfBoost.toFixed(1) + " vol=" + volRatio.toFixed(2) +
    " atr=" + atrPct.toFixed(3) + "%");

  if (sig.direction === "neutral") {
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_signal", signal: sig, log };
  }

  if (!volumeOk) {
    L("VOLUME GATE: recent vol " + volRatio.toFixed(2) + "x avg — too low. Skipping.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "volume_gate", log };
  }

  if (!atrOk) {
    L("ATR GATE: volatility too low (" + atrPct.toFixed(3) + "%). Skipping.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "atr_gate", log };
  }

  // Volume boost: if vol > 1.5x average, boost confidence
  const volBoost = volRatio > 1.5 ? 0.5 : 0;
  if (volBoost > 0) {
    sig.score += volBoost * Math.sign(sig.score);
    L("VOLUME BOOST: +" + volBoost + " (vol " + volRatio.toFixed(2) + "x avg)");
  }

  // Recalculate predProb after all score modifications (MTF, volume boost)
  const maxScoreRecalc = (weights.rsi || 1) + (weights.bb || 1) + (weights.ob || 3);
  sig.predProb = 50 + (Math.abs(sig.score) / maxScoreRecalc) * 30;

  // ── Hourly gate: skip hours with <30% win rate (3+ samples) ──
  const hourlyGate = learned?.hourlyStats;
  if (hourlyGate) {
    const currentHour = new Date().getUTCHours();
    const hourData = hourlyGate[currentHour];
    if (hourData && hourData.total >= 30 && (hourData.wins / hourData.total) < 0.3) {
      L("HOURLY GATE: hour " + currentHour + " UTC has " + Math.round(hourData.wins / hourData.total * 100) + "% win rate. Skipping.");
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
    if (comboBonusScore > 0) L("COMBO BONUS: +" + comboBonusScore.toFixed(1) + " from strong pairs");
  }

  // ── Price optimization: adjust effective min/max entry based on learned advice ──
  let effectiveMinEntry = minEntryPriceCents;
  let effectiveMaxEntry = maxEntryPriceCents;
  const priceAdvice = learned?.priceAdvice;
  if (priceAdvice === "low_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMinEntry = Math.min(effectiveMinEntry + 10, 55);
    L("PRICE OPT: raising min entry to " + effectiveMinEntry + "c (low prices losing)");
  }
  if (priceAdvice === "high_price_losing" || priceAdvice === "both_extremes_losing") {
    effectiveMaxEntry = Math.max(effectiveMaxEntry - 10, 60);
    L("PRICE OPT: lowering max entry to " + effectiveMaxEntry + "c (high prices losing)");
  }

  // ── Find market ──
  const resp = await kalshiFetch("/trade-api/v2/markets?series_ticker=" + seriesTicker + "&status=open&limit=200&mve_filter=exclude", { method: "GET" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  L("Markets: " + markets.length);

  const now = Date.now();
  let best = null;
  for (const m of markets) {
    if (!m.ticker?.startsWith(prefix)) continue;
    const closeTs = m.close_time ? new Date(m.close_time).getTime() : m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
    if (closeTs > 0 && (closeTs - now) / 60000 < minMinutesToClose) continue;

    const px = await getMarketPrices(m.ticker);
    const targetAsk = sig.direction === "up" ? px.yesAsk : px.noAsk;
    const side = sig.direction === "up" ? "yes" : "no";
    if (!targetAsk) continue;
    if (targetAsk < effectiveMinEntry || targetAsk > effectiveMaxEntry) continue;
    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < effectiveMinEntry) continue;
    const edge = sig.predProb - limitPrice;
    if (!best || edge > best.edge) {
      best = { ticker: m.ticker, side, targetAsk, limitPrice, edge, marketCloseTs: closeTs || null };
    }
  }

  // Apply combo bonus to effective edge
  if (best && comboBonusScore > 0) {
    best.edge += comboBonusScore;
    L("EDGE with combo: " + best.edge.toFixed(1) + "c");
  }

  if (!best || best.edge < minEdge) {
    L(best ? "Edge too low: " + best.edge.toFixed(1) + "c" : "No market in price band.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_edge", log };
  }

  // ── Orderbook depth check ──
  let depthOk = true;
  try {
    const depthOb = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(best.ticker) + "/orderbook?depth=10", { method: "GET" });
    const depthBook = depthOb?.orderbook || depthOb;
    const depthBids = depthBook?.[best.side] || [];
    const totalDepth = depthBids.reduce((s, b) => s + (Array.isArray(b) ? (b[1] || 0) : (b?.quantity || b?.size || 0)), 0);
    if (totalDepth < 3) {
      depthOk = false;
      L("DEPTH GATE: only " + totalDepth + " contracts on " + best.side + " book for " + best.ticker + ". Skipping.");
    } else {
      L("DEPTH: " + totalDepth + " contracts on " + best.side + " book");
    }
  } catch (e) { L("Depth check failed: " + (e?.message || e)); }

  if (!depthOk) {
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "depth_gate", log };
  }

  // ── Place order — confidence-based sizing ──
  const learnedWinRate = learned?.winRate || 50;
  const confidence = Math.abs(sig.score) / maxScoreRecalc;
  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice, winRate: learnedWinRate, confidence });
  const betSize = (best.limitPrice * count / 100).toFixed(2);
  L("ORDER: " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice +
    "c (edge=" + best.edge.toFixed(1) + "c conf=" + (confidence * 100).toFixed(0) + "% wr=" + learnedWinRate + "% bet=$" + betSize + ")");

  // Candle snapshot for backtesting
  const candleSnapshot = candles.slice(-5).map(c => ({ c: c.close, v: c.volume, h: c.high, l: c.low }));

  if (mode !== "live") {
    const posData = { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators,
        mtfBoost, volRatio: Math.round(volRatio * 100) / 100, atrPct: Math.round(atrPct * 1000) / 1000,
        candleSnapshot },
      marketCloseTs: best.marketCloseTs };
    await kvSetJson("bot:position", posData);
    await kvSetJson("bot:lastTradeTs", Date.now());
    L("PAPER BUY placed.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return { action: "paper_buy", position: posData, log };
  }

  const orderBody = {
    ticker: best.ticker, action: "buy", type: "limit", side: best.side, count,
    ...(best.side === "yes" ? { yes_price: best.limitPrice } : { no_price: best.limitPrice }),
  };
  const orderRes = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
  const order = orderRes?.order || {};

  const sigData = { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators,
    mtfBoost, volRatio: Math.round(volRatio * 100) / 100, atrPct: Math.round(atrPct * 1000) / 1000,
    candleSnapshot };

  if (order.status === "executed" || ((order.fill_count ?? 0) > 0)) {
    const fc = (order.fill_count ?? 0) > 0 ? order.fill_count : count;
    await kvSetJson("bot:position", { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fc, openedTs: Date.now(), orderId: order.order_id, signal: sigData,
      marketCloseTs: best.marketCloseTs });
    await kvSetJson("bot:lastTradeTs", Date.now());
    L("FILLED " + fc + "x @ " + best.limitPrice + "c");
  } else if (order.status === "resting") {
    await kvSetJson("bot:pendingOrder", { orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(), signal: sigData });
    L("RESTING on book.");
  } else {
    L("Unexpected order status: " + order.status);
  }

  await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
  return { action: "order_placed", status: order.status, log };
}

// ── Handler ──

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Optional: protect with a secret token
  const secret = process.env.BOT_CRON_SECRET;
  if (secret) {
    const token = req.headers["x-cron-secret"] || req.query.secret;
    if (token !== secret) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const start = Date.now();
  try {
    const result = await runBotCycle();
    res.status(200).json({ ok: true, action: result?.action, elapsed_ms: Date.now() - start, log: result?.log || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), elapsed_ms: Date.now() - start });
  }
}
