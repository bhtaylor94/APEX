// Vercel API route: GET /api/bot/run
// Triggered by cron-job.org every 1 minute.
// Runs the full bot cycle for both 15M and 1H series.

import crypto from "crypto";
import { kvGetJson, kvSetJson } from "./_upstash";

// ── Series definitions ──

const SERIES_DEFS = {
  "15M": {
    suffix: "15M",
    defaultSeriesTicker: "KXBTC15M",
    indicators: ["rsi", "vwap", "ob"],
    defaultWeights: { rsi: 2, vwap: 2, ob: 2 },
    defaults: {
      minMinutesToCloseToEnter: 10, cooldownMinutes: 5,
      minEntryPriceCents: 35, maxEntryPriceCents: 80, makerOffsetCents: 2, minEdge: 5, atrMaxPct: 0.15,
    },
  },
  "1H": {
    suffix: "1H",
    defaultSeriesTicker: "KXBTC",
    indicators: ["rsi", "macd", "ema", "vwap"],
    defaultWeights: { rsi: 2, macd: 2, ema: 2, vwap: 2 },
    defaults: {
      minMinutesToCloseToEnter: 30, cooldownMinutes: 15,
      minEntryPriceCents: 35, maxEntryPriceCents: 80, makerOffsetCents: 2, minEdge: 5, atrMaxPct: 0.25,
    },
  },
};

function kvKey(base, suffix) { return base + ":" + suffix; }

// ── Kalshi auth ──

const KALSHI_BASE = (process.env.KALSHI_ENV || process.env.NEXT_PUBLIC_KALSHI_ENV || "prod") === "demo"
  ? "https://demo-api.kalshi.co" : "https://api.elections.kalshi.com";

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
  const msg = String(ts) + method.toUpperCase() + path.split("?")[0];
  const pem = formatPem(privateKey);
  const signature = crypto.sign("sha256", Buffer.from(msg, "utf8"), {
    key: pem, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  const headers = {
    "KALSHI-ACCESS-KEY": apiKeyId, "KALSHI-ACCESS-SIGNATURE": signature.toString("base64"),
    "KALSHI-ACCESS-TIMESTAMP": String(ts), "Content-Type": "application/json",
  };
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  return fetch(KALSHI_BASE + path, opts).then(async (res) => {
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

// ── Coinbase ──

const CB = "https://api.exchange.coinbase.com";

async function fetchCandles(limit = 100) {
  const res = await fetch(CB + "/products/BTC-USD/candles?granularity=60");
  if (!res.ok) throw new Error("Coinbase candles " + res.status);
  const data = await res.json();
  return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
}

async function fetchCandles5m(limit = 50) {
  try {
    const res = await fetch(CB + "/products/BTC-USD/candles?granularity=300");
    if (!res.ok) return null;
    const data = await res.json();
    return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
  } catch { return null; }
}

async function fetchCandles15m(limit = 30) {
  try {
    const res = await fetch(CB + "/products/BTC-USD/candles?granularity=900");
    if (!res.ok) return null;
    const data = await res.json();
    return data.slice(0, limit).reverse().map(c => ({ low: c[1], high: c[2], close: c[4], volume: c[5] }));
  } catch { return null; }
}

async function fetchBtcOrderBook() {
  const res = await fetch(CB + "/products/BTC-USD/book?level=2");
  if (!res.ok) throw new Error("Coinbase book " + res.status);
  const data = await res.json();
  let bid = 0, ask = 0;
  for (const [, s] of (data.bids || []).slice(0, 5)) bid += parseFloat(s);
  for (const [, s] of (data.asks || []).slice(0, 5)) ask += parseFloat(s);
  const t = bid + ask;
  return { ratio: t > 0 ? bid / t : 0.5 };
}

// ── Indicators ──

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

function computeEMA(values, period) {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) ema.push(values[i] * k + ema[i - 1] * (1 - k));
  return ema;
}

function computeMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = computeEMA(closes, fast);
  const emaSlow = computeEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = computeEMA(macdLine.slice(slow - 1), signal);
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
  return { fast: fast[fast.length - 1], slow: slow[slow.length - 1], bullish: fast[fast.length - 1] > slow[slow.length - 1] };
}

function computeVWAP(candles) {
  let cumVolPrice = 0, cumVol = 0;
  for (const c of candles) {
    const typical = ((c.high || c.close) + (c.low || c.close) + c.close) / 3;
    cumVolPrice += typical * (c.volume || 0);
    cumVol += (c.volume || 0);
  }
  return cumVol > 0 ? cumVolPrice / cumVol : null;
}

// ── Adaptive learning (series-aware) ──

async function getLearnedWeights(suffix, seriesDef) {
  const learned = await kvGetJson(kvKey("bot:learned_weights", suffix));
  if (!learned || !learned.weights) return { weights: { ...seriesDef.defaultWeights }, minScoreThreshold: suffix === "1H" ? 2 : 3 };
  return { weights: { ...seriesDef.defaultWeights, ...learned.weights }, minScoreThreshold: learned.minScoreThreshold || (suffix === "1H" ? 2 : 3) };
}

async function learnFromTrades(suffix, seriesDef, L) {
  const history = (await kvGetJson("bot:trade_history")) || [];
  const trades = history.filter(t => t.signal && t.signal.indicators && (t.seriesSuffix || "15M") === suffix);
  if (trades.length < 5) return;

  const recent = trades.slice(-20);
  const INDICATORS = seriesDef.indicators;
  const DEFAULT_WEIGHTS = seriesDef.defaultWeights;
  const stats = {};
  for (const ind of INDICATORS) stats[ind] = { correct: 0, wrong: 0, neutral: 0 };
  let wins = 0, losses = 0, totalPnl = 0;
  const comboStats = {};
  const hourlyStats = {};
  const entryPriceStats = { low: 0, lowWin: 0, mid: 0, midWin: 0, high: 0, highWin: 0 };

  for (const t of recent) {
    const won = t.result === "win" || t.result === "tp_exit";
    const lost = t.result === "loss";
    if (won) wins++; if (lost) losses++;
    totalPnl += (t.pnlCents || 0);
    const inds = t.signal.indicators;
    if (!inds) continue;

    for (const ind of INDICATORS) {
      const vote = inds[ind] || 0;
      if (vote === 0) { stats[ind].neutral++; continue; }
      const votedUp = vote > 0;
      const withTrade = (t.signal.direction === "up" && votedUp) || (t.signal.direction === "down" && !votedUp);
      if ((withTrade && won) || (!withTrade && lost)) stats[ind].correct++;
      else stats[ind].wrong++;
    }

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

    const ts = t.openedTs || t.settledTs || t.closedTs;
    if (ts) {
      const hour = new Date(ts).getUTCHours();
      if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, total: 0 };
      hourlyStats[hour].total++;
      if (won) hourlyStats[hour].wins++;
    }

    const ep = t.entryPriceCents || 50;
    if (ep < 45) { entryPriceStats.low++; if (won) entryPriceStats.lowWin++; }
    else if (ep <= 65) { entryPriceStats.mid++; if (won) entryPriceStats.midWin++; }
    else { entryPriceStats.high++; if (won) entryPriceStats.highWin++; }
  }

  const newWeights = {};
  for (const ind of INDICATORS) {
    const total = stats[ind].correct + stats[ind].wrong;
    if (total < 3) { newWeights[ind] = DEFAULT_WEIGHTS[ind]; continue; }
    newWeights[ind] = Math.round(DEFAULT_WEIGHTS[ind] * Math.max(0.25, Math.min(3, (stats[ind].correct / total) * 2)) * 100) / 100;
  }

  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0.5;
  let lossStreak = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].result === "loss") lossStreak++; else break;
  }

  let minScore = 2;
  if (lossStreak >= 5) minScore = 2.25;
  else if (winRate >= 0.65 && total >= 5) minScore = 1.5;
  else if (winRate < 0.35 && total >= 5) minScore = 2;

  const mode = lossStreak >= 5 ? "recovery" : winRate >= 0.6 ? "aggressive" : "normal";

  let priceAdvice = null;
  if (entryPriceStats.low >= 30 && entryPriceStats.lowWin / entryPriceStats.low < 0.3) priceAdvice = "low_price_losing";
  if (entryPriceStats.high >= 30 && entryPriceStats.highWin / entryPriceStats.high < 0.3)
    priceAdvice = priceAdvice ? "both_extremes_losing" : "high_price_losing";

  await kvSetJson(kvKey("bot:learned_weights", suffix), {
    weights: newWeights, minScoreThreshold: minScore,
    winRate: Math.round(winRate * 100), totalTrades: total, totalPnl, lossStreak, mode,
    indicatorStats: stats, comboStats, hourlyStats, priceAdvice, lastUpdated: Date.now(),
  });
  if (L) L("[" + suffix + "] LEARNED: weights=" + JSON.stringify(newWeights) + " minScore=" + minScore + " mode=" + mode);
}

// ── Signal generators ──

function getSignal15M(candles, closes, obRatio, weights, minScoreThreshold, candles5m, candles15m) {
  const price = closes[closes.length - 1];
  const rsi = computeRSI(closes, 3);
  const vwap = computeVWAP(candles);
  const vwapDev = vwap ? (price - vwap) / vwap : 0;
  const indicators = { rsi: 0, vwap: 0, ob: 0 };
  let score = 0;
  const bd = {};

  if (rsi < 15) indicators.rsi = 1; else if (rsi > 85) indicators.rsi = -1;
  score += indicators.rsi * (weights.rsi || 2);
  bd.rsi = (indicators.rsi !== 0 ? (indicators.rsi > 0 ? "+" : "-") + (weights.rsi || 2) : "0");

  if (vwap) { if (vwapDev < -0.0015) indicators.vwap = 1; else if (vwapDev > 0.0015) indicators.vwap = -1; }
  score += indicators.vwap * (weights.vwap || 2);
  bd.vwap = (indicators.vwap !== 0 ? (indicators.vwap > 0 ? "+" : "-") + (weights.vwap || 2) : "0");

  if (obRatio > 0.65) indicators.ob = 1; else if (obRatio < 0.35) indicators.ob = -1;
  score += indicators.ob * (weights.ob || 2);
  bd.ob = (indicators.ob !== 0 ? (indicators.ob > 0 ? "+" : "-") + (weights.ob || 2) : "0");

  const maxScore = (weights.rsi || 2) + (weights.vwap || 2) + (weights.ob || 2);

  // MTF confirmation
  let mtfBoost = 0;
  const sigDir = score > 0 ? 1 : score < 0 ? -1 : 0;
  if (sigDir !== 0) {
    if (candles5m && candles5m.length >= 10) {
      const rsi5 = computeRSI(candles5m.map(c => c.close), 5);
      const d = rsi5 < 35 ? 1 : rsi5 > 65 ? -1 : 0;
      if (d !== 0 && d === sigDir) mtfBoost += 0.5;
    }
    if (candles15m && candles15m.length >= 10) {
      const rsi15 = computeRSI(candles15m.map(c => c.close), 7);
      const d = rsi15 < 35 ? 1 : rsi15 > 65 ? -1 : 0;
      if (d !== 0 && d === sigDir) mtfBoost += 0.5;
    }
    if (mtfBoost > 0) score += mtfBoost * sigDir;
  }

  const abs = Math.abs(score);
  if (abs < minScoreThreshold) return { direction: "neutral", score, breakdown: bd, indicators, maxScore, mtfBoost };
  return {
    direction: score > 0 ? "up" : "down", score, indicators,
    predProb: 50 + (abs / maxScore) * 30, breakdown: bd, maxScore, mtfBoost,
    confidence: abs / maxScore,
  };
}

function getSignal1H(candles5m, closes5m, obRatio, weights, minScoreThreshold) {
  if (!candles5m || closes5m.length < 30) {
    return { direction: "neutral", score: 0, confidence: 0, maxScore: 8, mtfBoost: 0 };
  }
  const price = closes5m[closes5m.length - 1];
  const rsiVal = computeRSI(closes5m, 14);
  const macdData = computeMACD(closes5m, 12, 26, 9);
  const emaCross = computeEMACrossover(closes5m, 9, 21);
  const vwap = computeVWAP(candles5m);
  const vwapDev = vwap ? (price - vwap) / vwap : 0;

  const indicators = { rsi: 0, macd: 0, ema: 0, vwap: 0 };
  let score = 0;
  const bd = {};

  if (rsiVal < 30) indicators.rsi = 1; else if (rsiVal > 70) indicators.rsi = -1;
  score += indicators.rsi * (weights.rsi || 2);
  bd.rsi = (indicators.rsi !== 0 ? (indicators.rsi > 0 ? "+" : "-") + (weights.rsi || 2) : "0");

  if (macdData) {
    if (macdData.crossUp || (macdData.histogram > 0 && macdData.macd > 0)) indicators.macd = 1;
    else if (macdData.crossDown || (macdData.histogram < 0 && macdData.macd < 0)) indicators.macd = -1;
  }
  score += indicators.macd * (weights.macd || 2);
  bd.macd = (indicators.macd !== 0 ? (indicators.macd > 0 ? "+" : "-") + (weights.macd || 2) : "0");

  if (emaCross) {
    if (emaCross.bullish) indicators.ema = 1; else indicators.ema = -1;
  }
  score += indicators.ema * (weights.ema || 2);
  bd.ema = (indicators.ema !== 0 ? (indicators.ema > 0 ? "+" : "-") + (weights.ema || 2) : "0");

  if (vwap) { if (vwapDev < -0.0025) indicators.vwap = 1; else if (vwapDev > 0.0025) indicators.vwap = -1; }
  score += indicators.vwap * (weights.vwap || 2);
  bd.vwap = (indicators.vwap !== 0 ? (indicators.vwap > 0 ? "+" : "-") + (weights.vwap || 2) : "0");

  const maxScore = (weights.rsi || 2) + (weights.macd || 2) + (weights.ema || 2) + (weights.vwap || 2);
  const abs = Math.abs(score);
  if (abs < minScoreThreshold) return { direction: "neutral", score, breakdown: bd, indicators, maxScore, mtfBoost: 0 };
  return {
    direction: score > 0 ? "up" : "down", score, indicators,
    predProb: 50 + (abs / maxScore) * 30, breakdown: bd, maxScore, mtfBoost: 0,
    confidence: abs / maxScore,
  };
}

// ── Kalshi helpers ──

async function getKalshiPositions(log) {
  try {
    const data = await kalshiFetch("/trade-api/v2/portfolio/positions?limit=100&settlement_status=unsettled", { method: "GET" });
    return data?.market_positions || data?.positions || [];
  } catch { return []; }
}

async function getBestBid(ticker, side) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ob = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker) + "/orderbook?depth=10", { method: "GET" });
      const book = ob?.orderbook || ob;
      const bids = book?.[side] || [];
      if (bids.length === 0) continue;
      const raw = bids[bids.length - 1];
      return validPx(Array.isArray(raw) ? raw[0] : raw?.price ?? raw);
    } catch (e) {
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
  return null;
}

async function getMarketPrices(ticker) {
  try {
    const m = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(ticker), { method: "GET" });
    const mm = m?.market || m;
    return { yesAsk: validPx(mm?.yes_ask), noAsk: validPx(mm?.no_ask), closeTime: mm?.close_time || mm?.expiration_time || null };
  } catch { return { yesAsk: null, noAsk: null, closeTime: null }; }
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
}

async function logTradeResult(entry) {
  entry.hourUtc = new Date().getUTCHours();
  const history = (await kvGetJson("bot:trade_history")) || [];
  history.push(entry);
  if (history.length > 100) history.splice(0, history.length - 100);
  await kvSetJson("bot:trade_history", history);
}

// ── Combined daily loss check ──

async function checkCombinedDailyLoss(cfg) {
  const maxLossCents = Math.round((Number(cfg.dailyMaxLossUsd ?? 10)) * 100);
  let combinedPnl = 0;
  for (const sKey of Object.keys(SERIES_DEFS)) {
    const stats = await getDailyStats(sKey);
    combinedPnl += (stats.totalPnlCents || 0);
  }
  return combinedPnl <= -maxLossCents ? { ok: false, combinedPnl } : { ok: true, combinedPnl };
}

// ── KV Migration ──

async function migrateOldKeys() {
  const migrated = await kvGetJson("bot:migration_done");
  if (migrated) return;
  const keys = ["bot:position", "bot:pendingOrder", "bot:daily_stats", "bot:state", "bot:lastTradeTs", "bot:learned_weights"];
  for (const key of keys) {
    const val = await kvGetJson(key);
    if (val != null) {
      const newKey = kvKey(key, "15M");
      const existing = await kvGetJson(newKey);
      if (existing == null) await kvSetJson(newKey, val);
    }
  }
  await kvSetJson("bot:migration_done", { ts: Date.now(), version: 2 });
}

// ── Run one series cycle ──

async function runSeriesCycle(seriesDef, cfg, sharedData, L) {
  const suffix = seriesDef.suffix;
  const { candles, candles5m, candles15m, ob, kalshiPos, mode } = sharedData;

  const seriesTickerKey = suffix === "1H" ? "hourlySeriesTicker" : "seriesTicker";
  const seriesTicker = String(cfg[seriesTickerKey] || seriesDef.defaultSeriesTicker).toUpperCase();
  const prefix = seriesTicker + "-";

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 10);
  const maxContracts = Number(cfg.maxContracts ?? 10);
  const minEdge = Number(cfg[suffix === "1H" ? "hourly_minEdge" : "minEdge"] ?? seriesDef.defaults.minEdge);
  const minEntry = Number(cfg[suffix === "1H" ? "hourly_minEntryPriceCents" : "minEntryPriceCents"] ?? seriesDef.defaults.minEntryPriceCents);
  const maxEntry = Number(cfg[suffix === "1H" ? "hourly_maxEntryPriceCents" : "maxEntryPriceCents"] ?? seriesDef.defaults.maxEntryPriceCents);
  const minMins = Number(cfg[suffix === "1H" ? "hourly_minMinutesToCloseToEnter" : "minMinutesToCloseToEnter"] ?? seriesDef.defaults.minMinutesToCloseToEnter);
  const makerOffset = Number(cfg[suffix === "1H" ? "hourly_makerOffsetCents" : "makerOffsetCents"] ?? seriesDef.defaults.makerOffsetCents);
  const cooldownMin = Number(cfg[suffix === "1H" ? "hourly_cooldownMinutes" : "cooldownMinutes"] ?? seriesDef.defaults.cooldownMinutes);
  const atrMaxPct = seriesDef.defaults.atrMaxPct;

  L("[" + suffix + "] series=" + seriesTicker);

  // ── Pending orders ──
  const pending = await kvGetJson(kvKey("bot:pendingOrder", suffix));
  if (pending?.orderId) {
    const ageMs = Date.now() - (pending.placedTs || 0);
    const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;
    try {
      const od = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const o = od?.order || od;
      if (o.status === "executed" || ((o.fill_count ?? 0) > 0)) {
        let closeTime = null;
        try { const mp = await getMarketPrices(pending.ticker); closeTime = mp.closeTime; } catch {}
        await kvSetJson(kvKey("bot:position", suffix), {
          ticker: pending.ticker, side: pending.side, entryPriceCents: pending.limitPrice,
          count: (o.fill_count ?? 0) > 0 ? o.fill_count : pending.count, openedTs: pending.placedTs,
          orderId: pending.orderId, signal: pending.signal, marketCloseTs: closeTime ? new Date(closeTime).getTime() : null,
        });
        await kvSetJson(kvKey("bot:pendingOrder", suffix), null);
      } else if (ageMs >= timeoutMs) {
        try { await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "DELETE" }); } catch {}
        await kvSetJson(kvKey("bot:pendingOrder", suffix), null);
      } else {
        L("[" + suffix + "] PENDING resting (" + Math.round(ageMs / 1000) + "s).");
        return { action: "pending_order" };
      }
    } catch {
      if (ageMs >= timeoutMs) await kvSetJson(kvKey("bot:pendingOrder", suffix), null);
      else return { action: "pending_order" };
    }
  }

  // ── Position check ──
  let pos = await kvGetJson(kvKey("bot:position", suffix));
  const relevant = kalshiPos.filter(p => p.ticker?.startsWith(prefix) && p.position !== 0 && p.position != null);

  // Recovery
  if ((!pos || !pos.ticker) && relevant.length > 0) {
    const kp = relevant[0];
    const posCount = Math.abs(kp.position || 0);
    const side = (kp.position > 0) ? "yes" : "no";
    L("[" + suffix + "] RECOVERING: " + side + " " + posCount + "x " + kp.ticker);
    let closeTime = null;
    try { const mp = await getMarketPrices(kp.ticker); closeTime = mp.closeTime; } catch {}
    let entryPrice = 50;
    try {
      const fills = await kalshiFetch("/trade-api/v2/portfolio/fills?ticker=" + encodeURIComponent(kp.ticker) + "&limit=20", { method: "GET" });
      const buyFills = (fills?.fills || []).filter(f => f.action === "buy" && f.ticker === kp.ticker);
      if (buyFills.length > 0) {
        entryPrice = Math.round(buyFills.reduce((s, f) => s + (f.yes_price || f.no_price || 50) * (f.count || 1), 0)
          / buyFills.reduce((s, f) => s + (f.count || 1), 0));
      }
    } catch {}
    pos = { ticker: kp.ticker, side, entryPriceCents: entryPrice, count: posCount,
      openedTs: Date.now(), marketCloseTs: closeTime ? new Date(closeTime).getTime() : null };
    await kvSetJson(kvKey("bot:position", suffix), pos);
  }

  if (pos?.ticker) {
    const onKalshi = relevant.some(p => p.ticker === pos.ticker);

    if (!onKalshi) {
      // Settled
      L("[" + suffix + "] SETTLED: " + pos.ticker);
      let won = false, revenueCents = 0;
      try {
        const sd = await kalshiFetch("/trade-api/v2/portfolio/settlements?limit=10", { method: "GET" });
        const match = (sd?.settlements || []).find(s => s.ticker === pos.ticker);
        if (match) { won = (match.market_result === pos.side); revenueCents = won ? pos.count * 100 : 0; }
      } catch {}
      const costCents = (pos.entryPriceCents || 50) * (pos.count || 1);
      const pnl = revenueCents - costCents;
      await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: pos.entryPriceCents,
        count: pos.count, result: won ? "win" : "loss", exitReason: "SETTLEMENT", revenueCents, costCents, pnlCents: pnl,
        seriesSuffix: suffix, signal: pos.signal, openedTs: pos.openedTs, settledTs: Date.now() });
      await recordDailyTrade(suffix, won ? "win" : "loss", pnl);
      await learnFromTrades(suffix, seriesDef, L);
      await kvSetJson(kvKey("bot:position", suffix), null);
      pos = null;
    } else {
      // TP / trailing stop
      const bestBid = await getBestBid(pos.ticker, pos.side);
      const entry = pos.entryPriceCents || 50;
      const kalshiMatch = relevant.find(p => p.ticker === pos.ticker);
      const realCount = kalshiMatch ? Math.abs(kalshiMatch.position || 0) : 0;
      if (realCount > 0 && realCount !== pos.count) {
        pos.count = realCount;
        await kvSetJson(kvKey("bot:position", suffix), pos);
      }
      const cnt = pos.count || 1;
      const profit = bestBid ? (bestBid * cnt) - (entry * cnt) : 0;

      if (bestBid && (!pos.peakBidCents || bestBid > pos.peakBidCents)) {
        pos.peakBidCents = bestBid;
        await kvSetJson(kvKey("bot:position", suffix), pos);
      }

      L("[" + suffix + "] POSITION: " + pos.side.toUpperCase() + " " + cnt + "x " + pos.ticker +
        " entry=" + entry + "c bid=" + (bestBid || "?") + "c P&L=" + (profit >= 0 ? "+" : "") + "$" + (profit / 100).toFixed(2));

      const minsToClose = pos.marketCloseTs ? (pos.marketCloseTs - Date.now()) / 60000 : 999;
      const profitPC = bestBid ? bestBid - entry : 0;
      const trailingDrop = suffix === "1H" ? 8 : 5;

      let shouldTP = false, tpReason = "";
      if (bestBid && profitPC > 0) {
        if (bestBid >= 85) { shouldTP = true; tpReason = "HIGH_BID_" + bestBid; }
        else if (profitPC >= 25) { shouldTP = true; tpReason = "STRONG_PROFIT_" + profitPC; }
        else if (minsToClose < 5 && profitPC >= 15) { shouldTP = true; tpReason = "TIME_LOCK"; }
        else if (profitPC >= 10 && pos.peakBidCents && (pos.peakBidCents - bestBid) >= trailingDrop) {
          shouldTP = true; tpReason = "MOMENTUM_FADE";
        }
      }

      if (shouldTP) {
        L("[" + suffix + "] TAKE PROFIT: " + tpReason);
        if (mode !== "live") {
          const rev = bestBid * cnt, cost = entry * cnt, pnl = rev - cost;
          await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
            exitPriceCents: bestBid, count: cnt, result: "tp_exit", exitReason: "TAKE_PROFIT_" + tpReason,
            revenueCents: rev, costCents: cost, pnlCents: pnl, seriesSuffix: suffix,
            signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
          await recordDailyTrade(suffix, "tp_exit", pnl);
          await learnFromTrades(suffix, seriesDef, L);
          await kvSetJson(kvKey("bot:position", suffix), null);
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
            const rev = bestBid * fc, pnl = rev - entry * fc;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
              exitPriceCents: bestBid, count: fc, result: "tp_exit", exitReason: "TAKE_PROFIT_" + tpReason,
              revenueCents: rev, costCents: entry * fc, pnlCents: pnl, seriesSuffix: suffix,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade(suffix, "tp_exit", pnl);
            await learnFromTrades(suffix, seriesDef, L);
            await kvSetJson(kvKey("bot:position", suffix), null);
            return { action: "take_profit", reason: tpReason, pnlCents: pnl };
          }
        } catch (e) { L("[" + suffix + "] TP sell failed: " + (e?.message || e)); }
      }

      // Tiered loss exit
      if (bestBid) {
        const lossPC = entry - bestBid;
        const lossRatio = lossPC / entry;
        let maxLR = minsToClose < 5 ? 0.30 : minsToClose < 8 ? 0.40 : 0.50;
        const hopeless = (lossRatio >= maxLR && lossPC > 0) || (bestBid <= 5);

        if (hopeless && lossPC > 0) {
          const reason = bestBid <= 5 ? "NEAR_ZERO" : "LOSS_GATE_" + Math.round(maxLR * 100);
          L("[" + suffix + "] EXIT_LOSING: " + reason);
          if (mode !== "live") {
            const rev = bestBid * cnt, cost = entry * cnt, pnl = rev - cost;
            await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
              exitPriceCents: bestBid, count: cnt, result: "loss", exitReason: "STOP_LOSS_" + reason,
              revenueCents: rev, costCents: cost, pnlCents: pnl, seriesSuffix: suffix,
              signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
            await recordDailyTrade(suffix, "loss", pnl);
            await learnFromTrades(suffix, seriesDef, L);
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
              const rev = bestBid * fc, pnl = rev - entry * fc;
              await logTradeResult({ ticker: pos.ticker, side: pos.side, entryPriceCents: entry,
                exitPriceCents: bestBid, count: fc, result: "loss", exitReason: "STOP_LOSS_" + reason,
                revenueCents: rev, costCents: entry * fc, pnlCents: pnl, seriesSuffix: suffix,
                signal: pos.signal, openedTs: pos.openedTs, closedTs: Date.now() });
              await recordDailyTrade(suffix, "loss", pnl);
              await learnFromTrades(suffix, seriesDef, L);
              await kvSetJson(kvKey("bot:position", suffix), null);
              return { action: "stop_loss", reason, pnlCents: pnl };
            }
          } catch (e) { L("[" + suffix + "] Exit sell failed: " + (e?.message || e)); }
        }
      }

      await kvSetJson(kvKey("bot:state", suffix), { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", profit };
    }
  }

  // ── Daily trade limit ──
  const dailyStats = await getDailyStats(suffix);
  const maxTradesPerDay = Number(cfg.maxTradesPerDay ?? 10);
  if ((dailyStats.totalTrades || 0) >= maxTradesPerDay) {
    L("[" + suffix + "] DAILY TRADE LIMIT: " + dailyStats.totalTrades + "/" + maxTradesPerDay);
    return { action: "daily_trade_limit" };
  }

  // ── Cooldown ──
  const learnedData = await kvGetJson(kvKey("bot:learned_weights", suffix));
  const streak = learnedData?.lossStreak || 0;
  const coolMult = Math.min(2, 1 + streak * 0.25);
  const lastTrade = await kvGetJson(kvKey("bot:lastTradeTs", suffix));
  if (lastTrade && (Date.now() - lastTrade) < cooldownMin * coolMult * 60000) {
    L("[" + suffix + "] COOLDOWN");
    return { action: "cooldown" };
  }

  // ── Signal ──
  const closes = candles.map(c => c.close);
  const closes5m = candles5m ? candles5m.map(c => c.close) : [];
  const { weights, minScoreThreshold } = await getLearnedWeights(suffix, seriesDef);

  let sig;
  if (suffix === "1H") {
    sig = getSignal1H(candles5m, closes5m, ob.ratio, weights, minScoreThreshold);
  } else {
    sig = getSignal15M(candles, closes, ob.ratio, weights, minScoreThreshold, candles5m, candles15m);
  }

  // Volume + ATR
  const volumes = candles.map(c => c.volume || 0);
  const avgVol = volumes.length >= 20 ? volumes.slice(-20).reduce((s, v) => s + v, 0) / 20 : 0;
  const recentVol = volumes.length >= 5 ? volumes.slice(-5).reduce((s, v) => s + v, 0) / 5 : 0;
  const volRatio = avgVol > 0 ? recentVol / avgVol : 1;
  const atr = computeATR(candles, 14);
  const atrPct = atr && closes[closes.length - 1] > 0 ? (atr / closes[closes.length - 1]) * 100 : 0;

  L("[" + suffix + "] SIGNAL: score=" + (sig.score || 0).toFixed(2) + " dir=" + (sig.direction || "neutral"));

  if (sig.direction === "neutral" || !sig.predProb) {
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_signal" };
  }

  if (volRatio < 0.5) { L("[" + suffix + "] VOLUME GATE"); return { action: "volume_gate" }; }
  if (atrPct > 0 && atrPct < 0.02) { L("[" + suffix + "] ATR too low"); return { action: "atr_gate" }; }
  if (atrPct > atrMaxPct) { L("[" + suffix + "] ATR too high"); return { action: "atr_high_gate" }; }

  if (volRatio > 1.5) sig.score += 0.5 * Math.sign(sig.score);

  const maxScoreR = sig.maxScore || 6;
  sig.predProb = 50 + (Math.abs(sig.score) / maxScoreR) * 30;

  // Hourly gate
  const hourlyGate = learnedData?.hourlyStats;
  if (hourlyGate) {
    const hr = new Date().getUTCHours();
    const hd = hourlyGate[hr];
    if (hd && hd.total >= 30 && (hd.wins / hd.total) < 0.3) {
      L("[" + suffix + "] HOURLY GATE"); return { action: "hourly_gate" };
    }
  }

  // Combo bonus
  const INDICATORS = seriesDef.indicators;
  let comboBonus = 0;
  if (learnedData?.comboStats && sig.indicators) {
    for (let a = 0; a < INDICATORS.length; a++) {
      for (let b = a + 1; b < INDICATORS.length; b++) {
        const va = sig.indicators[INDICATORS[a]] || 0;
        const vb = sig.indicators[INDICATORS[b]] || 0;
        if (va !== 0 && vb !== 0 && va === vb) {
          const combo = learnedData.comboStats[INDICATORS[a] + "+" + INDICATORS[b]];
          if (combo && combo.total >= 10 && (combo.wins / combo.total) > 0.65) comboBonus += 0.5;
        }
      }
    }
  }

  // Price optimization
  let effMin = minEntry, effMax = maxEntry;
  const pa = learnedData?.priceAdvice;
  if (pa === "low_price_losing" || pa === "both_extremes_losing") effMin = Math.min(effMin + 10, 55);
  if (pa === "high_price_losing" || pa === "both_extremes_losing") effMax = Math.max(effMax - 10, 60);

  // Find market
  const resp = await kalshiFetch("/trade-api/v2/markets?series_ticker=" + seriesTicker + "&status=open&limit=200&mve_filter=exclude", { method: "GET" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  L("[" + suffix + "] Markets: " + markets.length);

  const now = Date.now();
  let best = null;
  for (const m of markets) {
    if (!m.ticker?.startsWith(prefix)) continue;
    const closeTs = m.close_time ? new Date(m.close_time).getTime() : m.expiration_time ? new Date(m.expiration_time).getTime() : 0;
    if (closeTs > 0 && (closeTs - now) / 60000 < minMins) continue;
    const px = await getMarketPrices(m.ticker);
    const targetAsk = sig.direction === "up" ? px.yesAsk : px.noAsk;
    const side = sig.direction === "up" ? "yes" : "no";
    if (!targetAsk) continue;
    if (targetAsk < effMin || targetAsk > effMax) continue;
    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < effMin) continue;
    const edge = sig.predProb - limitPrice;
    if (!best || edge > best.edge) {
      best = { ticker: m.ticker, side, targetAsk, limitPrice, edge, marketCloseTs: closeTs || null };
    }
  }

  if (best && comboBonus > 0) best.edge += comboBonus;

  if (!best || best.edge < minEdge) {
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "no_edge" };
  }

  // Depth check
  let depthOk = true;
  try {
    const dob = await kalshiFetch("/trade-api/v2/markets/" + encodeURIComponent(best.ticker) + "/orderbook?depth=10", { method: "GET" });
    const db = dob?.orderbook || dob;
    const bids = db?.[best.side] || [];
    const td = bids.reduce((s, b) => s + (Array.isArray(b) ? (b[1] || 0) : (b?.quantity || b?.size || 0)), 0);
    if (td < 10) depthOk = false;
  } catch {}
  if (!depthOk) {
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now() });
    return { action: "depth_gate" };
  }

  // Place order
  const wr = learnedData?.winRate || 50;
  const conf = sig.confidence || Math.abs(sig.score) / maxScoreR;
  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice, winRate: wr, confidence: conf });
  L("[" + suffix + "] ORDER: " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice + "c");

  const candleSnap = candles.slice(-5).map(c => ({ c: c.close, v: c.volume, h: c.high, l: c.low }));
  const sigData = { direction: sig.direction, score: sig.score, predProb: sig.predProb, indicators: sig.indicators,
    mtfBoost: sig.mtfBoost || 0, volRatio: Math.round(volRatio * 100) / 100, atrPct: Math.round(atrPct * 1000) / 1000,
    candleSnapshot: candleSnap };

  if (mode !== "live") {
    const posData = { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: sigData, marketCloseTs: best.marketCloseTs };
    await kvSetJson(kvKey("bot:position", suffix), posData);
    await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
    await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return { action: "paper_buy", position: posData };
  }

  const orderBody = { ticker: best.ticker, action: "buy", type: "limit", side: best.side, count,
    ...(best.side === "yes" ? { yes_price: best.limitPrice } : { no_price: best.limitPrice }) };
  const orderRes = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
  const order = orderRes?.order || {};

  if (order.status === "executed" || ((order.fill_count ?? 0) > 0)) {
    const fc = (order.fill_count ?? 0) > 0 ? order.fill_count : count;
    await kvSetJson(kvKey("bot:position", suffix), { ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fc, openedTs: Date.now(), orderId: order.order_id, signal: sigData, marketCloseTs: best.marketCloseTs });
    await kvSetJson(kvKey("bot:lastTradeTs", suffix), Date.now());
  } else if (order.status === "resting") {
    await kvSetJson(kvKey("bot:pendingOrder", suffix), { orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(), signal: sigData });
  }

  await kvSetJson(kvKey("bot:state", suffix), { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
  return { action: "order_placed", status: order.status };
}

// ── Main bot cycle ──

async function runBotCycle() {
  const log = [];
  const L = (m) => { log.push(m); };

  await migrateOldKeys();

  const cfg = (await kvGetJson("bot:config")) || {};
  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const hourlyEnabled = !!cfg.hourlyEnabled;

  L("CONFIG: mode=" + mode + " 15m=" + enabled + " hourly=" + hourlyEnabled);

  if (!enabled && !hourlyEnabled) { L("Both bots disabled."); return { action: "disabled", log }; }

  const dailyCheck = await checkCombinedDailyLoss(cfg);
  if (!dailyCheck.ok) { L("DAILY LOSS LIMIT"); return { action: "daily_limit", log }; }

  let candles, candles5m, candles15m, ob;
  try {
    [candles, ob, candles5m, candles15m] = await Promise.all([
      fetchCandles(100), fetchBtcOrderBook(), fetchCandles5m(50), fetchCandles15m(30),
    ]);
  } catch (e) { L("Data fetch failed: " + (e?.message || e)); return { action: "data_error", log }; }

  if (!candles || candles.length < 30) { L("Insufficient data."); return { action: "no_data", log }; }

  const kalshiPos = await getKalshiPositions();
  const sharedData = { candles, candles5m, candles15m, ob, kalshiPos, mode };

  const results = {};

  if (enabled) {
    L("── 15M ──");
    results["15M"] = await runSeriesCycle(SERIES_DEFS["15M"], cfg, sharedData, L);
  }

  if (hourlyEnabled) {
    L("── 1H ──");
    results["1H"] = await runSeriesCycle(SERIES_DEFS["1H"], cfg, sharedData, L);
  }

  return { action: "multi_series", results, log };
}

// ── Handler ──

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = process.env.BOT_CRON_SECRET;
  if (secret) {
    const token = req.headers["x-cron-secret"] || req.query.secret;
    if (token !== secret) return res.status(401).json({ error: "Unauthorized" });
  }

  const start = Date.now();
  try {
    const result = await runBotCycle();
    res.status(200).json({ ok: true, action: result?.action, elapsed_ms: Date.now() - start, log: result?.log || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e), elapsed_ms: Date.now() - start });
  }
}
