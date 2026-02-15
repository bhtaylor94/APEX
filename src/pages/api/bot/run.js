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

function calcContracts({ tradeSizeUsd, maxContracts, askCents }) {
  const budgetCents = Math.max(1, Math.round((tradeSizeUsd || 10) * 100));
  const byBudget = Math.floor(budgetCents / askCents);
  return clamp(Math.max(1, byBudget), 1, maxContracts || 10);
}

// ── Coinbase ──

const CB = "https://api.exchange.coinbase.com";

async function fetchCandles(limit = 100) {
  const res = await fetch(CB + "/products/BTC-USD/candles?granularity=60");
  if (!res.ok) throw new Error("Coinbase candles " + res.status);
  const data = await res.json();
  return data.slice(0, limit).reverse().map(c => ({ close: c[4], volume: c[5] }));
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

function ema(data, period) {
  if (data.length < period) return null;
  const k = 2 / (period + 1);
  let e = data.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

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

function computeMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0 };
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
  for (let i = 12; i < 26; i++) e12 = closes[i] * k12 + e12 * (1 - k12);
  const mH = [];
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    mH.push(e12 - e26);
  }
  const macdLine = e12 - e26;
  const sig = mH.length >= 9 ? ema(mH, 9) : macdLine;
  return { macd: macdLine, signal: sig || 0 };
}

// ── Adaptive learning ──

const DEFAULT_WEIGHTS = { rsi: 2, macd: 1, bb: 1, ema: 1, ob: 1 };
const INDICATORS = ["rsi", "macd", "bb", "ema", "ob"];

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
  for (const ind of INDICATORS) stats[ind] = { correct: 0, wrong: 0 };
  let wins = 0, losses = 0;

  for (const t of recent) {
    const won = t.result === "win" || t.result === "tp_exit";
    const lost = t.result === "loss";
    if (won) wins++; if (lost) losses++;
    const inds = t.signal.indicators;
    if (!inds) continue;
    for (const ind of INDICATORS) {
      const vote = inds[ind] || 0;
      if (vote === 0) continue;
      const votedUp = vote > 0;
      const withTrade = (t.signal.direction === "up" && votedUp) || (t.signal.direction === "down" && !votedUp);
      if ((withTrade && won) || (!withTrade && lost)) stats[ind].correct++;
      else stats[ind].wrong++;
    }
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
  if (lossStreak >= 4) minScore = 3.5;          // 4+ losses in a row: go strict
  else if (lossStreak >= 3) minScore = 3;        // 3 losses: moderate tightening
  else if (lossStreak >= 2) minScore = 2.5;      // 2 losses: slight tightening
  else if (winRate >= 0.65 && total >= 5) minScore = 1.5;  // hot streak: loosen up
  else if (winRate < 0.35 && total >= 5) minScore = 3;     // overall bad: tighten

  const mode = lossStreak >= 3 ? "recovery" : winRate >= 0.6 ? "aggressive" : "normal";

  await kvSetJson("bot:learned_weights", { weights: newWeights, minScoreThreshold: minScore,
    winRate: Math.round(winRate * 100), totalTrades: total, lossStreak, mode,
    indicatorStats: stats, lastUpdated: Date.now() });
  if (L) L("LEARNED: weights=" + JSON.stringify(newWeights) + " minScore=" + minScore + " mode=" + mode +
    " winRate=" + Math.round(winRate * 100) + "% streak=" + lossStreak + "L");
}

function getSignalWithWeights(closes, obRatio, weights, minScoreThreshold) {
  const price = closes[closes.length - 1];
  const rsi = computeRSI(closes, 14);
  const macd = computeMACD(closes);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  const avg = sma(closes, 20);
  const slice = closes.slice(-20);
  const std = avg ? Math.sqrt(slice.reduce((s, v) => s + (v - avg) ** 2, 0) / 20) : 0;
  const bbLower = avg ? avg - 2 * std : null;
  const bbUpper = avg ? avg + 2 * std : null;

  const indicators = { rsi: 0, macd: 0, bb: 0, ema: 0, ob: 0 };
  let score = 0;
  const bd = {};

  if (rsi < 30) indicators.rsi = 1; else if (rsi > 70) indicators.rsi = -1;
  score += indicators.rsi * weights.rsi;
  bd.rsi = (indicators.rsi !== 0 ? (indicators.rsi > 0 ? "+" : "-") + weights.rsi : "0");

  if (macd.macd > macd.signal) indicators.macd = 1; else if (macd.macd < macd.signal) indicators.macd = -1;
  score += indicators.macd * weights.macd;
  bd.macd = (indicators.macd !== 0 ? (indicators.macd > 0 ? "+" : "-") + weights.macd : "0");

  if (bbLower && price < bbLower) indicators.bb = 1; else if (bbUpper && price > bbUpper) indicators.bb = -1;
  score += indicators.bb * weights.bb;
  bd.bb = (indicators.bb !== 0 ? (indicators.bb > 0 ? "+" : "-") + weights.bb : "0");

  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) indicators.ema = 1; else if (ema9 < ema21) indicators.ema = -1;
  }
  score += indicators.ema * weights.ema;
  bd.ema = (indicators.ema !== 0 ? (indicators.ema > 0 ? "+" : "-") + weights.ema : "0");

  if (obRatio > 0.60) indicators.ob = 1; else if (obRatio < 0.40) indicators.ob = -1;
  score += indicators.ob * weights.ob;
  bd.ob = (indicators.ob !== 0 ? (indicators.ob > 0 ? "+" : "-") + weights.ob : "0");

  const maxScore = weights.rsi + weights.macd + weights.bb + weights.ema + weights.ob;
  const abs = Math.abs(score);
  if (abs < minScoreThreshold) return { direction: "neutral", score, breakdown: bd, indicators };
  return {
    direction: score > 0 ? "up" : "down", score, indicators,
    predProb: 50 + (abs / maxScore) * 30, breakdown: bd,
  };
}

// ── Kalshi helpers ──

async function getKalshiPositions() {
  try {
    const data = await kalshiFetch("/trade-api/v2/portfolio/positions?limit=100&settlement_status=unsettled", { method: "GET" });
    return data?.market_positions || data?.positions || [];
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
      const price = validPx(bids[bids.length - 1][0]);
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
  const minMinutesToClose = Number(cfg.minMinutesToCloseToEnter ?? 10);
  const makerOffset = Number(cfg.makerOffsetCents ?? 2);
  const takeProfitCents = Number(cfg.takeProfitCents ?? 75);
  const cooldownMin = Number(cfg.cooldownMinutes ?? 5);
  const maxTradesPerDay = Number(cfg.maxTradesPerDay ?? 10);
  const dailyMaxLossUsd = Number(cfg.dailyMaxLossUsd ?? 50);

  L("CONFIG: mode=" + mode + " tp=$" + (takeProfitCents / 100).toFixed(2));

  if (!enabled) { L("Bot disabled."); return { action: "disabled", log }; }

  // ── Daily limits ──
  const stats = await getDailyStats();
  if (stats.totalPnlCents <= -(dailyMaxLossUsd * 100)) {
    L("DAILY LOSS LIMIT hit: $" + (stats.totalPnlCents / 100).toFixed(2));
    return { action: "daily_limit", stats, log };
  }
  if (stats.totalTrades >= maxTradesPerDay) {
    L("DAILY TRADE LIMIT: " + stats.totalTrades + "/" + maxTradesPerDay);
    return { action: "daily_limit", stats, log };
  }

  // ── Pending orders ──
  const pending = await kvGetJson("bot:pendingOrder");
  if (pending?.orderId) {
    const ageMs = Date.now() - (pending.placedTs || 0);
    const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;
    try {
      const od = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const o = od?.order || od;
      if (o.status === "executed" || (o.fill_count && o.fill_count > 0)) {
        L("PENDING FILLED: " + pending.orderId);
        let closeTime = null;
        try { const mp = await getMarketPrices(pending.ticker); closeTime = mp.closeTime; } catch {}
        await kvSetJson("bot:position", {
          ticker: pending.ticker, side: pending.side, entryPriceCents: pending.limitPrice,
          count: o.fill_count || pending.count, openedTs: pending.placedTs,
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
  const kalshiPos = await getKalshiPositions();
  const prefix = seriesTicker + "-";
  const relevant = kalshiPos.filter(p => p.ticker?.startsWith(prefix) && (p.total_traded > 0 || p.quantity > 0));

  // Recovery
  if ((!pos || !pos.ticker) && relevant.length > 0) {
    const kp = relevant[0];
    const side = (kp.market_position || kp.position || "yes").toLowerCase();
    L("RECOVERING position: " + side + " " + kp.ticker);
    let closeTime = null;
    try { const mp = await getMarketPrices(kp.ticker); closeTime = mp.closeTime; } catch {}
    pos = { ticker: kp.ticker, side, entryPriceCents: 50, count: kp.total_traded || kp.quantity || 1,
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
      // Take profit check
      const bestBid = await getBestBid(pos.ticker, pos.side, L);
      const entry = pos.entryPriceCents || 50;
      const cnt = pos.count || 1;
      const totalCost = entry * cnt;
      const totalVal = bestBid ? bestBid * cnt : 0;
      const profit = totalVal - totalCost;

      L("POSITION: " + pos.side.toUpperCase() + " " + cnt + "x " + pos.ticker +
        " entry=" + entry + "c bid=" + (bestBid || "?") + "c P&L=" +
        (profit >= 0 ? "+$" : "-$") + (Math.abs(profit) / 100).toFixed(2));

      if (bestBid && profit >= takeProfitCents) {
        L("TAKE PROFIT! $" + (profit / 100).toFixed(2) + " >= $" + (takeProfitCents / 100).toFixed(2));

        if (mode !== "live") {
          const pnl = totalVal - totalCost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
            exitPriceCents: bestBid, count: cnt, result: "tp_exit", exitReason: "TAKE_PROFIT",
            revenueCents: totalVal, costCents: totalCost, pnlCents: pnl,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade("tp_exit", pnl);
          await learnFromTrades(L);
          await kvSetJson("bot:position", null);
          L("PAPER SOLD " + cnt + "x @ " + bestBid + "c, profit: $" + (pnl / 100).toFixed(2));
          return { action: "take_profit", pnlCents: pnl, log };
        }

        const sellBody = {
          ticker: pos.ticker, action: "sell", type: "limit", side: pos.side, count: cnt,
          time_in_force: "fill_or_kill",
          ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }),
        };
        try {
          const sr = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
          const so = sr?.order || {};
          if (so.status === "executed" || (so.fill_count > 0)) {
            const fc = so.fill_count || cnt;
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
      } else if (bestBid && profit > 0) {
        L("Waiting for $" + (takeProfitCents / 100).toFixed(2) + " target");
      } else if (bestBid) {
        L("Underwater. Holding to settlement.");
      }
      await kvSetJson("bot:state", { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", profit, log };
    }
  }

  // ── Cooldown ──
  const lastTrade = await kvGetJson("bot:lastTradeTs");
  if (lastTrade && (Date.now() - lastTrade) < cooldownMin * 60000) {
    L("COOLDOWN: " + Math.round((cooldownMin * 60000 - (Date.now() - lastTrade)) / 1000) + "s left");
    return { action: "cooldown", log };
  }

  // ── Signal ──
  let candles, ob;
  try { [candles, ob] = await Promise.all([fetchCandles(100), fetchBtcOrderBook()]); }
  catch (e) { L("Data fetch failed: " + (e?.message || e)); return { action: "data_error", log }; }

  if (!candles || candles.length < 30) { L("Insufficient candle data."); return { action: "no_data", log }; }

  const closes = candles.map(c => c.close);
  const { weights, minScoreThreshold } = await getLearnedWeights();
  const learned = await kvGetJson("bot:learned_weights");
  const tradingMode = learned?.mode || "normal";
  const sig = getSignalWithWeights(closes, ob.ratio, weights, minScoreThreshold);
  L("SIGNAL: score=" + sig.score + " threshold=" + minScoreThreshold + " mode=" + tradingMode +
    " dir=" + (sig.direction || "neutral") + " " + JSON.stringify(sig.breakdown));

  if (sig.direction === "neutral") {
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_signal", signal: sig, log };
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
    if (targetAsk < minEntryPriceCents || targetAsk > maxEntryPriceCents) continue;
    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < minEntryPriceCents) continue;
    const edge = sig.predProb - limitPrice;
    if (!best || edge > best.edge) {
      best = { ticker: m.ticker, side, targetAsk, limitPrice, edge, marketCloseTs: closeTs || null };
    }
  }

  if (!best || best.edge < minEdge) {
    L(best ? "Edge too low: " + best.edge.toFixed(1) + "c" : "No market in price band.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_edge", log };
  }

  // ── Place order ──
  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice });
  L("ORDER: " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice + "c (edge=" + best.edge.toFixed(1) + "c)");

  if (mode !== "live") {
    const posData = { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators },
      marketCloseTs: best.marketCloseTs };
    await kvSetJson("bot:position", posData);
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

  if (order.status === "executed" || (order.fill_count > 0)) {
    const fc = order.fill_count || count;
    await kvSetJson("bot:position", { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fc, openedTs: Date.now(), orderId: order.order_id,
      signal: { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators },
      marketCloseTs: best.marketCloseTs });
    await kvSetJson("bot:lastTradeTs", Date.now());
    L("FILLED " + fc + "x @ " + best.limitPrice + "c");
  } else if (order.status === "resting") {
    await kvSetJson("bot:pendingOrder", { orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators } });
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
