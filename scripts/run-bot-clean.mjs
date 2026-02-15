import { kvGetJson, kvSetJson } from "./kv.js";
import { getMarkets, getMarket, getOrderbook, placeOrder, kalshiFetch } from "./kalshi_client.mjs";

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

// ── Coinbase data fetchers (public, no auth, reliable for US) ──

const COINBASE_BASE = "https://api.exchange.coinbase.com";

async function fetchCoinbaseCandles(limit = 100) {
  // granularity=60 = 1-minute candles. Coinbase returns newest first.
  const url = `${COINBASE_BASE}/products/BTC-USD/candles?granularity=60`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
  const data = await res.json();
  // Coinbase format: [ [time, low, high, open, close, volume], ... ] newest first
  // Reverse to oldest-first, take last `limit`
  const candles = data
    .slice(0, limit)
    .reverse()
    .map(c => ({
      time: c[0],
      low: c[1],
      high: c[2],
      open: c[3],
      close: c[4],
      volume: c[5],
    }));
  return candles;
}

async function fetchCoinbaseOrderBook() {
  const url = `${COINBASE_BASE}/products/BTC-USD/book?level=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase book ${res.status}`);
  const data = await res.json();
  // Sum top 10 levels of bids and asks
  let bidDepth = 0, askDepth = 0;
  const bids = (data.bids || []).slice(0, 10);
  const asks = (data.asks || []).slice(0, 10);
  for (const [, size] of bids) bidDepth += parseFloat(size);
  for (const [, size] of asks) askDepth += parseFloat(size);
  const total = bidDepth + askDepth;
  const ratio = total > 0 ? bidDepth / total : 0.5;
  return { ratio, bidDepth, askDepth };
}

// ── Technical indicators ──

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
  const price = closes[closes.length - 1];
  return {
    upper: avg + mult * std,
    middle: avg,
    lower: avg - mult * std,
    price,
    std,
  };
}

// ── Signal generator: weighted scoring, 5 indicators ──

async function getSignal() {
  let candles, orderBook;
  try {
    [candles, orderBook] = await Promise.all([
      fetchCoinbaseCandles(100),
      fetchCoinbaseOrderBook(),
    ]);
  } catch (e) {
    console.log("Coinbase data fetch failed:", e?.message || e);
    return { direction: "neutral", score: 0, confidence: 0, details: "coinbase_error" };
  }

  if (!candles || candles.length < 30) {
    return { direction: "neutral", score: 0, confidence: 0, details: "insufficient_data" };
  }

  const closes = candles.map(c => c.close);
  const price = closes[closes.length - 1];

  // 1. RSI (14-period)
  const rsiVal = computeRSI(closes, 14);

  // 2. MACD (12, 26, 9)
  const macdVal = computeMACD(closes);

  // 3. Bollinger Bands (20, 2)
  const bb = computeBollingerBands(closes, 20, 2);

  // 4. EMA 9 vs EMA 21 crossover
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);

  // 5. Order book imbalance
  const obRatio = orderBook.ratio;

  // ── Scoring (max possible: +7 / -7) ──
  let score = 0;
  const breakdown = {};

  // RSI: oversold/overbought gets double weight
  if (rsiVal < 30) { score += 2; breakdown.rsi = "+2 (oversold " + rsiVal.toFixed(1) + ")"; }
  else if (rsiVal > 70) { score -= 2; breakdown.rsi = "-2 (overbought " + rsiVal.toFixed(1) + ")"; }
  else { breakdown.rsi = "0 (neutral " + rsiVal.toFixed(1) + ")"; }

  // MACD
  if (macdVal.macd > macdVal.signal) { score += 1; breakdown.macd = "+1 (bullish)"; }
  else if (macdVal.macd < macdVal.signal) { score -= 1; breakdown.macd = "-1 (bearish)"; }
  else { breakdown.macd = "0 (neutral)"; }

  // Bollinger Bands
  if (bb) {
    if (price < bb.lower) { score += 1; breakdown.bb = "+1 (below lower)"; }
    else if (price > bb.upper) { score -= 1; breakdown.bb = "-1 (above upper)"; }
    else { breakdown.bb = "0 (within bands)"; }
  } else {
    breakdown.bb = "0 (n/a)";
  }

  // EMA crossover
  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) { score += 1; breakdown.ema = "+1 (9>21 bullish)"; }
    else if (ema9 < ema21) { score -= 1; breakdown.ema = "-1 (9<21 bearish)"; }
    else { breakdown.ema = "0 (equal)"; }
  } else {
    breakdown.ema = "0 (n/a)";
  }

  // Order book imbalance
  if (obRatio > 0.60) { score += 1; breakdown.ob = "+1 (bid heavy " + obRatio.toFixed(3) + ")"; }
  else if (obRatio < 0.40) { score -= 1; breakdown.ob = "-1 (ask heavy " + obRatio.toFixed(3) + ")"; }
  else { breakdown.ob = "0 (balanced " + obRatio.toFixed(3) + ")"; }

  console.log("SIGNAL SCORE:", score, "/ 7");
  console.log("BREAKDOWN:", breakdown);

  const absScore = Math.abs(score);

  // Only trade when |score| >= 3
  if (absScore < 3) {
    console.log("No trade -- score " + score + " (need |3|+ for edge)");
    return { direction: "neutral", score, confidence: 0, price, breakdown };
  }

  const confidence = absScore / 7;
  const direction = score > 0 ? "up" : "down";
  // Predicted probability: 50% + confidence * 30%
  const predProb = 50 + confidence * 30;

  console.log("SIGNAL:", direction.toUpperCase(), "confidence=" + (confidence * 100).toFixed(0) + "%", "predProb=" + predProb.toFixed(1) + "%");

  return { direction, score, confidence, predProb, price, breakdown };
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

async function getExecutablePrices(ticker) {
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

  try {
    const ob = await getOrderbook(ticker, 1);
    const book = ob?.orderbook || ob?.order_book || ob;
    const yesAsk = validPx((book?.yes_asks || [])?.[0]?.price ?? null);
    const noAsk  = validPx((book?.no_asks  || [])?.[0]?.price ?? null);
    const yesBid = validPx((book?.yes_bids || [])?.[0]?.price ?? null);
    const noBid  = validPx((book?.no_bids  || [])?.[0]?.price ?? null);
    return { yesAsk, noAsk, yesBid, noBid, source: "orderbook" };
  } catch (_) {}

  return { yesAsk: null, noAsk: null, yesBid: null, noBid: null, source: "none" };
}

// ── Cancel unfilled maker orders after timeout ──

async function checkPendingOrder(cfg) {
  const pending = await kvGetJson("bot:pendingOrder");
  if (!pending || !pending.orderId) return;

  const ageMs = Date.now() - (pending.placedTs || 0);
  const timeoutMs = (Number(cfg.makerTimeoutMinutes ?? 2.5)) * 60 * 1000;

  if (ageMs < timeoutMs) {
    // Check if it filled in the meantime
    try {
      const orderData = await kalshiFetch("/trade-api/v2/portfolio/orders/" + pending.orderId, { method: "GET" });
      const order = orderData?.order || orderData;
      if (order.status === "executed" || (order.fill_count && order.fill_count > 0)) {
        console.log("PENDING ORDER FILLED:", pending.orderId);
        await kvSetJson("bot:position", {
          ticker: pending.ticker,
          side: pending.side,
          entryPriceCents: pending.limitPrice,
          count: order.fill_count || pending.count,
          openedTs: pending.placedTs,
          orderId: pending.orderId,
          signal: pending.signal,
        });
        await kvSetJson("bot:pendingOrder", null);
        return;
      }
    } catch (_) {}
    console.log("PENDING ORDER still resting (" + Math.round(ageMs / 1000) + "s old). Waiting...");
    return;
  }

  // Timeout — cancel the order
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
  const history = (await kvGetJson("bot:trade_history")) || [];
  history.push(entry);
  // Keep last 100 trades
  if (history.length > 100) history.splice(0, history.length - 100);
  await kvSetJson("bot:trade_history", history);
}

// ── Daily limits ──

async function checkDailyLimits(cfg) {
  const state = (await kvGetJson("bot:dailyState")) || {};
  const today = new Date().toISOString().slice(0, 10);

  if (state.date !== today) {
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

async function recordTradeEntry(costCents) {
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

async function recordSettlementResult(revenueCents) {
  const state = (await kvGetJson("bot:dailyState")) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.date === today) {
    state.pnlCents = (state.pnlCents || 0) + revenueCents;
    await kvSetJson("bot:dailyState", state);
  }
}

// ── Cooldown ──

async function checkCooldown(cfg) {
  const cooldownMs = (Number(cfg.cooldownMinutes ?? 5)) * 60 * 1000;
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

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 10);
  const maxContracts = Number(cfg.maxContracts ?? 10);
  const minEdge = Number(cfg.minEdge ?? 5);
  const minEntryPriceCents = Number(cfg.minEntryPriceCents ?? 35);
  const maxEntryPriceCents = Number(cfg.maxEntryPriceCents ?? 80);
  const minMinutesToCloseToEnter = Number(cfg.minMinutesToCloseToEnter ?? 10);
  const makerOffset = Number(cfg.makerOffsetCents ?? 2);

  console.log("CONFIG:", {
    enabled, mode, seriesTicker,
    tradeSizeUsd, maxContracts, minEdge,
    priceband: minEntryPriceCents + "c-" + maxEntryPriceCents + "c",
    minMinutesToCloseToEnter, makerOffset,
  });

  if (!enabled) return console.log("Bot disabled -- exiting.");

  // ── Step 1: Handle pending maker orders ──

  await checkPendingOrder(cfg);
  if (await kvGetJson("bot:pendingOrder")) {
    console.log("Pending order still active. Skipping new entries.");
    return;
  }

  // ── Step 2: Check for existing position ──

  let pos = await kvGetJson("bot:position");

  // Cross-check with Kalshi (source of truth)
  const kalshiPositions = await getKalshiPositions();
  const seriesPrefix = seriesTicker + "-";
  const relevantPositions = kalshiPositions.filter(p =>
    p.ticker?.startsWith(seriesPrefix) && (p.total_traded > 0 || p.quantity > 0)
  );

  if (pos && pos.ticker) {
    const stillOnKalshi = relevantPositions.some(p => p.ticker === pos.ticker);

    if (!stillOnKalshi) {
      // Position settled. Log the result.
      console.log("Position " + pos.ticker + " settled. Logging result.");

      // Determine if we won: check settlements
      let won = false;
      let revenueCents = 0;
      try {
        const settleData = await kalshiFetch("/trade-api/v2/portfolio/settlements?limit=5", { method: "GET" });
        const settlements = settleData?.settlements || [];
        const match = settlements.find(s => s.ticker === pos.ticker);
        if (match) {
          const result = match.market_result; // "yes" or "no"
          won = (result === pos.side);
          revenueCents = won ? (pos.count * 100) : 0;
          console.log("SETTLEMENT:", pos.ticker, "result=" + result, "side=" + pos.side, won ? "WIN +$" + (revenueCents / 100).toFixed(2) : "LOSS");
        }
      } catch (e) {
        console.log("Settlement lookup failed:", e?.message || e);
      }

      // Log to trade history
      const costCents = (pos.entryPriceCents || 50) * (pos.count || 1);
      const pnlCents = revenueCents - costCents;
      await logTradeResult({
        ticker: pos.ticker,
        side: pos.side,
        entryPriceCents: pos.entryPriceCents,
        count: pos.count,
        result: won ? "win" : "loss",
        revenueCents,
        costCents,
        pnlCents,
        signal: pos.signal || null,
        openedTs: pos.openedTs,
        settledTs: Date.now(),
      });

      // Update daily P&L
      await recordSettlementResult(revenueCents);

      await kvSetJson("bot:position", null);
      pos = null;
    } else {
      // Position still open — HOLD. No exit. Let it settle.
      console.log("HOLDING:", pos.side?.toUpperCase(), pos.count + "x", pos.ticker, "entry=" + pos.entryPriceCents + "c. Waiting for settlement.");
      await kvSetJson("bot:state", { lastCheck: Date.now(), holding: pos.ticker });
      return;
    }
  } else if (relevantPositions.length > 0) {
    // Orphan position on Kalshi we don't know about — sync and hold
    const kp = relevantPositions[0];
    const side = (kp.market_position || kp.position || "yes").toLowerCase();
    console.log("ORPHAN POSITION on Kalshi:", side.toUpperCase(), (kp.total_traded || kp.quantity) + "x", kp.ticker);
    await kvSetJson("bot:position", {
      ticker: kp.ticker,
      side,
      entryPriceCents: 50,
      count: kp.total_traded || kp.quantity || 1,
      openedTs: Date.now(),
      orderId: null,
    });
    console.log("Synced orphan. Holding to settlement.");
    return;
  }

  // ── Step 3: Pre-entry checks ──

  const dailyCheck = await checkDailyLimits(cfg);
  if (!dailyCheck.ok) return;

  const cooldownOk = await checkCooldown(cfg);
  if (!cooldownOk) return;

  // ── Step 4: Generate signal ──

  const sig = await getSignal();

  if (sig.direction === "neutral" || !sig.predProb) {
    console.log("No trade -- signal is neutral.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  // predProb is the probability in the signal direction (e.g., 65% YES or 65% NO)
  const predProb = sig.predProb;

  // ── Step 5: Find best market ──

  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  console.log("Markets found:", markets.length);

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
    console.log("No markets with " + minMinutesToCloseToEnter + "+ min remaining.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  let best = null;

  for (const m of candidates) {
    const ticker = m.ticker;
    const px = await getExecutablePrices(ticker);
    const yesAsk = validPx(px.yesAsk ?? m.yes_ask ?? null);
    const noAsk  = validPx(px.noAsk  ?? m.no_ask  ?? null);

    // Determine which side to trade based on signal direction
    // UP signal -> buy YES, DOWN signal -> buy NO
    let targetAsk, side;
    if (sig.direction === "up") {
      side = "yes";
      targetAsk = yesAsk;
    } else {
      side = "no";
      targetAsk = noAsk;
    }

    if (!targetAsk) continue;

    // Price band filter: 35c-80c only
    if (targetAsk < minEntryPriceCents || targetAsk > maxEntryPriceCents) continue;

    // Maker order: place limit at ask - makerOffset
    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < minEntryPriceCents) continue;

    // Edge calculation: predicted probability - limit price
    const edge = predProb - limitPrice;

    if (!best || edge > best.edge) {
      best = { ticker, side, targetAsk, limitPrice, edge, source: px.source, volume: Number(m.volume || 0) };
    }
  }

  if (!best) {
    console.log("No trade -- no market in price band " + minEntryPriceCents + "-" + maxEntryPriceCents + "c.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  console.log("BEST MARKET:", best);
  console.log("Edge:", "pred=" + predProb.toFixed(1) + "c", "limit=" + best.limitPrice + "c", "edge=" + best.edge.toFixed(1) + "c", "(min " + minEdge + "c)");

  if (best.edge < minEdge) {
    console.log("No trade -- edge " + best.edge.toFixed(1) + "c < min " + minEdge + "c.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return;
  }

  // ── Step 6: Place maker order ──

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice });
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice + "c (maker, mode=" + mode + ")";
  console.log("ORDER:", line);

  if (mode !== "live") {
    console.log("PAPER MODE:", line);
    await kvSetJson("bot:position", {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb },
    });
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "paper_buy" });
    return;
  }

  // Place limit order with post_only to ensure maker (zero fees)
  const orderBody = {
    ticker: best.ticker,
    action: "buy",
    type: "limit",
    side: best.side,
    count,
    ...(best.side === "yes" ? { yes_price: best.limitPrice } : { no_price: best.limitPrice }),
  };

  const res = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: orderBody });
  console.log("ORDER RESULT:", res);

  const order = res?.order || {};
  const status = order.status || "";

  if (status === "executed" || (order.fill_count && order.fill_count > 0)) {
    // Filled immediately (might happen even with maker offset)
    const fillCount = order.fill_count || count;
    console.log("ORDER FILLED immediately:", fillCount + "x @ " + best.limitPrice + "c");
    await kvSetJson("bot:position", {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fillCount, openedTs: Date.now(), orderId: order.order_id || null,
      signal: { direction: sig.direction, score: sig.score, predProb },
    });
    await recordTradeEntry(best.limitPrice * fillCount);
    await kvSetJson("bot:lastTradeTs", Date.now());
  } else if (status === "resting") {
    // Maker order resting on the book — will check for fill next run
    console.log("ORDER RESTING on book. Will check for fill next run.");
    await kvSetJson("bot:pendingOrder", {
      orderId: order.order_id,
      ticker: best.ticker,
      side: best.side,
      limitPrice: best.limitPrice,
      count,
      placedTs: Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb },
    });
  } else {
    console.log("ORDER STATUS unexpected:", status);
  }

  await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now(), lastAction: "buy" });
}

main().catch((e) => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
