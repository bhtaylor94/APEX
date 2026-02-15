import { kvGetJson, kvSetJson } from "./kv.js";
import { getMarkets, getMarket, getOrderbook, placeOrder, kalshiFetch } from "./kalshi_client.mjs";

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
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const k12 = 2 / 13, k26 = 2 / 27;
  let e12 = closes.slice(0, 12).reduce((s, v) => s + v, 0) / 12;
  let e26 = closes.slice(0, 26).reduce((s, v) => s + v, 0) / 26;
  // Update EMA-12 for values 12-25 (before EMA-26 is ready)
  for (let i = 12; i < 26; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
  }
  const mH = [];
  for (let i = 26; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    mH.push(e12 - e26);
  }
  const macdLine = e12 - e26;
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
    rsi: rsiVal.toFixed(1) + " -> " + indicators.rsi,
    macd: macdVal.histogram.toFixed(2) + " -> " + indicators.macd,
    bb: (bb ? bb.percentB.toFixed(3) : "n/a") + " -> " + indicators.bb,
    obImbalance: obImbalance.ratio.toFixed(3) + " -> " + indicators.obImbalance,
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

  console.log("No trade -- indicators disagree (UP=" + upVotes + " DOWN=" + downVotes + ")");
  return { direction: "neutral", confidence: 0, price, indicators };
}


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

// ── Kalshi position checker (source of truth) ──

async function getKalshiPositions() {
  try {
    const data = await kalshiFetch("/trade-api/v2/portfolio/positions?limit=100&settlement_status=unsettled", { method: "GET" });
    return data?.market_positions || data?.positions || [];
  } catch (e) {
    console.log("Failed to fetch Kalshi positions:", e?.message || e);
    return [];
  }
}

// ── Exit strategy ──

async function maybeExitPosition(pos, cfg) {
  const ticker = pos.ticker;
  const side = pos.side;
  const entryPrice = pos.entryPriceCents;
  const count = pos.count;

  // Check if market is still open
  let market;
  try {
    const m = await getMarket(ticker);
    market = m?.market || m;
  } catch (e) {
    console.log("Cannot fetch market for exit check:", e?.message || e);
    return false; // can't check, hold
  }

  const status = market?.status || market?.result;
  if (status === "settled" || status === "closed") {
    console.log("Market already settled/closed. Clearing position.");
    await kvSetJson("bot:position", null);
    return true; // position cleared
  }

  // Get current prices
  const px = await getExecutablePrices(ticker);
  const currentBid = side === "yes" ? px.yesBid : px.noBid;

  if (!currentBid) {
    console.log("No bid available for exit. Holding position.");
    return false;
  }

  // Calculate time remaining
  const closeTs = market.close_time ? new Date(market.close_time).getTime()
    : market.expiration_time ? new Date(market.expiration_time).getTime() : 0;
  const minsLeft = closeTs > 0 ? (closeTs - Date.now()) / 60000 : 999;

  const profitCents = currentBid - entryPrice;
  const profitPct = (profitCents / entryPrice) * 100;

  console.log("EXIT CHECK:", {
    ticker,
    side: side.toUpperCase(),
    entry: entryPrice + "c",
    currentBid: currentBid + "c",
    profitCents: (profitCents >= 0 ? "+" : "") + profitCents + "c",
    profitPct: profitPct.toFixed(1) + "%",
    minsLeft: minsLeft.toFixed(1),
    count,
  });

  // Exit rules:
  // 1. TAKE PROFIT: sell if bid >= entry + 15c (lock in meaningful profit)
  const takeProfitThreshold = Number(cfg.takeProfitCents ?? 15);
  if (profitCents >= takeProfitThreshold) {
    console.log("TAKE PROFIT: +" + profitCents + "c >= +" + takeProfitThreshold + "c threshold");
    return await executeSell(ticker, side, count, currentBid, cfg.mode, entryPrice);
  }

  // 2. STOP LOSS: sell if bid <= entry - 20c (cut losses before total wipeout)
  const stopLossThreshold = Number(cfg.stopLossCents ?? 20);
  if (profitCents <= -stopLossThreshold) {
    console.log("STOP LOSS: " + profitCents + "c <= -" + stopLossThreshold + "c threshold");
    return await executeSell(ticker, side, count, currentBid, cfg.mode, entryPrice);
  }

  // 3. TIME EXIT: if < 3 minutes left and losing, sell to salvage capital
  if (minsLeft < 3 && profitCents < -5) {
    console.log("TIME EXIT: <3 min left and losing " + profitCents + "c. Selling to salvage.");
    return await executeSell(ticker, side, count, currentBid, cfg.mode, entryPrice);
  }

  console.log("HOLDING position. No exit trigger met.");
  return false;
}

async function executeSell(ticker, side, count, priceCents, mode, entryPriceCents) {
  const line = "SELL " + side.toUpperCase() + " " + count + "x " + ticker + " @ " + priceCents + "c";

  if (mode !== "live") {
    console.log("PAPER SELL:", line);
    await kvSetJson("bot:position", null);
    return true;
  }

  try {
    const res = await placeOrder({
      ticker,
      side,
      count,
      priceCents,
      action: "sell",
    });
    console.log("SELL ORDER:", line);
    console.log("SELL RESULT:", res);

    const orderStatus = res?.order?.status;
    if (orderStatus === "resting" || orderStatus === "pending") {
      console.log("SELL order resting (not filled yet). Keeping position.");
      return false;
    }

    // Record sell revenue in daily P&L
    const revenueCents = priceCents * count;
    await recordSellRevenue(revenueCents);

    await kvSetJson("bot:position", null);
    return true;
  } catch (e) {
    console.log("SELL FAILED:", e?.message || e);
    return false;
  }
}

// ── Daily P&L tracking ──

async function checkDailyLimits(cfg) {
  const state = (await kvGetJson("bot:dailyState")) || {};
  const today = new Date().toISOString().slice(0, 10);

  if (state.date !== today) {
    // New day, reset counters
    await kvSetJson("bot:dailyState", { date: today, trades: 0, pnlCents: 0 });
    return { ok: true, trades: 0, pnlCents: 0 };
  }

  const trades = state.trades || 0;
  const pnlCents = state.pnlCents || 0;
  const maxTrades = Number(cfg.maxTradesPerDay ?? 10);
  const maxLossCents = Math.round((Number(cfg.dailyMaxLossUsd ?? 25)) * 100);

  if (trades >= maxTrades) {
    console.log("DAILY LIMIT: " + trades + "/" + maxTrades + " trades. Stopping.");
    return { ok: false, trades, pnlCents };
  }

  if (pnlCents <= -maxLossCents) {
    console.log("DAILY LOSS LIMIT: $" + (pnlCents / 100).toFixed(2) + " (max -$" + (maxLossCents / 100).toFixed(2) + "). Stopping.");
    return { ok: false, trades, pnlCents };
  }

  return { ok: true, trades, pnlCents };
}

async function recordSellRevenue(revenueCents) {
  const state = (await kvGetJson("bot:dailyState")) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.date === today) {
    state.pnlCents = (state.pnlCents || 0) + revenueCents;
    await kvSetJson("bot:dailyState", state);
    console.log("Daily P&L updated: +" + revenueCents + "c revenue. Total: " + state.pnlCents + "c");
  }
}

async function recordTrade(costCents) {
  const state = (await kvGetJson("bot:dailyState")) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.date !== today) {
    await kvSetJson("bot:dailyState", { date: today, trades: 1, pnlCents: -costCents });
  } else {
    state.trades = (state.trades || 0) + 1;
    state.pnlCents = (state.pnlCents || 0) - costCents;
    await kvSetJson("bot:dailyState", state);
  }
}

// ── Cooldown check ──

async function checkCooldown(cfg) {
  const cooldownMs = (Number(cfg.cooldownMinutes ?? 8)) * 60 * 1000;
  const lastTrade = await kvGetJson("bot:lastTradeTs");
  if (lastTrade && (Date.now() - lastTrade) < cooldownMs) {
    const secsLeft = Math.round((cooldownMs - (Date.now() - lastTrade)) / 1000);
    console.log("COOLDOWN: " + secsLeft + "s remaining. Skipping.");
    return false;
  }
  return true;
}

// ── Main ──

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
    priceband: minEntryPriceCents + "c-" + maxEntryPriceCents + "c",
    minMinutesToCloseToEnter,
  });

  if (!enabled) return console.log("Bot disabled -- exiting.");

  // ── Step 1: Check for existing position & handle exits ──

  let pos = await kvGetJson("bot:position");

  // Cross-check with Kalshi's actual positions (source of truth)
  const kalshiPositions = await getKalshiPositions();
  const seriesPrefix = seriesTicker + "-";
  const relevantPositions = kalshiPositions.filter(p =>
    p.ticker?.startsWith(seriesPrefix) && (p.total_traded > 0 || p.quantity > 0)
  );

  if (pos && pos.ticker) {
    // We think we have a position — verify it still exists on Kalshi
    const stillOnKalshi = relevantPositions.some(p => p.ticker === pos.ticker);

    if (!stillOnKalshi) {
      // Position settled or was sold. Clear it.
      console.log("Position " + pos.ticker + " no longer on Kalshi (settled). Clearing.");
      await kvSetJson("bot:position", null);
      pos = null;
    } else {
      // Position still open — check exit strategy
      console.log("HOLDING:", pos.side?.toUpperCase(), pos.count + "x", pos.ticker, "entry=" + pos.entryPriceCents + "c");
      const exited = await maybeExitPosition(pos, { ...cfg, mode });
      if (exited) {
        console.log("Exited position. Will look for new entries next run.");
      }
      return; // Don't enter new trades while holding
    }
  } else if (relevantPositions.length > 0) {
    // We don't have a recorded position but Kalshi says we do — sync it
    const kp = relevantPositions[0];
    const side = (kp.market_position || kp.position || "yes").toLowerCase();
    console.log("ORPHAN POSITION detected on Kalshi:", side.toUpperCase(), (kp.total_traded || kp.quantity) + "x", kp.ticker);
    pos = {
      ticker: kp.ticker,
      side,
      entryPriceCents: 50, // unknown entry price, estimate middle
      count: kp.total_traded || kp.quantity || 1,
      openedTs: Date.now(),
      orderId: null,
    };
    await kvSetJson("bot:position", pos);
    // Check exit on this orphan
    const exited = await maybeExitPosition(pos, { ...cfg, mode });
    if (!exited) console.log("Holding orphan position. Will check exit next run.");
    return;
  }

  // ── Step 2: Pre-entry checks ──

  const dailyCheck = await checkDailyLimits(cfg);
  if (!dailyCheck.ok) return;

  const cooldownOk = await checkCooldown(cfg);
  if (!cooldownOk) return;

  // ── Step 3: Generate signal ──

  const sig = await getSignal();
  console.log("SIGNAL:", sig);

  const confidence = Number(sig.confidence || 0);
  if (confidence < minConfidence) {
    console.log("No trade -- confidence too low:", confidence, "<", minConfidence);
    // Save signal state for dashboard
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  const pYes = probYesFromSignal(sig.direction, confidence);
  const predYes = clamp(Math.round(pYes * 100), 1, 99);
  const predNo = 100 - predYes;

  // ── Step 4: Find best market ──

  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  console.log("Markets source: series(" + seriesTicker + ") -- found:", markets.length);

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
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  let best = null;

  for (const m of candidates) {
    const ticker = m.ticker;

    const px = await getExecutablePrices(ticker);
    const yesAsk = validPx(px.yesAsk ?? m.yes_ask ?? m.yesAsk ?? null);
    const noAsk  = validPx(px.noAsk  ?? m.no_ask  ?? m.noAsk  ?? null);

    // Price band filter: only trade contracts priced within our band
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
    console.log("No trade -- no candidate had a valid ask in price band.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  console.log("Selected market:", best);
  console.log(
    "Edge check:",
    "predYES=" + predYes + "c",
    "predNO=" + predNo + "c",
    "chosen=" + best.side.toUpperCase(),
    "ask=" + best.askCents + "c",
    "edge=" + best.edge + "c",
    "minEdge=" + minEdge + "c",
    "pxSource=" + best.pxSource
  );

  if (best.edge < minEdge) {
    console.log("No trade -- edge too small.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  // ── Step 5: Execute trade ──

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.askCents });
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.askCents + "c (mode=" + mode + ")";
  console.log("Decision:", line);

  if (mode !== "live") {
    console.log("PAPER MODE -- would place:", line);
    // Save paper position so exit logic can be tested
    await kvSetJson("bot:position", {
      ticker: best.ticker,
      side: best.side,
      entryPriceCents: best.askCents,
      count,
      openedTs: Date.now(),
      orderId: "paper-" + Date.now(),
    });
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return;
  }

  const res = await placeOrder({ ticker: best.ticker, side: best.side, count, priceCents: best.askCents, action: "buy" });
  console.log("ORDER RESULT:", res);

  // Check if order was actually filled
  const orderStatus = res?.order?.status;
  if (orderStatus === "resting" || orderStatus === "pending") {
    console.log("Order resting (not filled). Will check again next run.");
    await kvSetJson("bot:pendingOrder", {
      orderId: res.order.order_id,
      ticker: best.ticker,
      side: best.side,
      askCents: best.askCents,
      count,
      placedTs: Date.now(),
    });
    return;
  }

  // Save position (order was filled)
  await kvSetJson("bot:position", {
    ticker: best.ticker,
    side: best.side,
    entryPriceCents: best.askCents,
    count,
    openedTs: Date.now(),
    orderId: res?.order?.order_id || null
  });
  console.log("Saved bot:position");

  // Record trade for daily limits & cooldown
  await recordTrade(best.askCents * count);
  await kvSetJson("bot:lastTradeTs", Date.now());

  // Save signal state for dashboard
  await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
}

main().catch((e) => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
