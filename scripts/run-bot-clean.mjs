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

async function fetchCoinbaseOrderBook() {
  const url = `${COINBASE_BASE}/products/BTC-USD/book?level=2`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Coinbase book ${res.status}`);
  const data = await res.json();
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
  return { upper: avg + mult * std, middle: avg, lower: avg - mult * std, price, std };
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

  const rsiVal = computeRSI(closes, 14);
  const macdVal = computeMACD(closes);
  const bb = computeBollingerBands(closes, 20, 2);
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const obRatio = orderBook.ratio;

  let score = 0;
  const breakdown = {};

  if (rsiVal < 30) { score += 2; breakdown.rsi = "+2 (oversold " + rsiVal.toFixed(1) + ")"; }
  else if (rsiVal > 70) { score -= 2; breakdown.rsi = "-2 (overbought " + rsiVal.toFixed(1) + ")"; }
  else { breakdown.rsi = "0 (neutral " + rsiVal.toFixed(1) + ")"; }

  if (macdVal.macd > macdVal.signal) { score += 1; breakdown.macd = "+1 (bullish)"; }
  else if (macdVal.macd < macdVal.signal) { score -= 1; breakdown.macd = "-1 (bearish)"; }
  else { breakdown.macd = "0 (neutral)"; }

  if (bb) {
    if (price < bb.lower) { score += 1; breakdown.bb = "+1 (below lower)"; }
    else if (price > bb.upper) { score -= 1; breakdown.bb = "-1 (above upper)"; }
    else { breakdown.bb = "0 (within bands)"; }
  } else { breakdown.bb = "0 (n/a)"; }

  if (ema9 != null && ema21 != null) {
    if (ema9 > ema21) { score += 1; breakdown.ema = "+1 (9>21 bullish)"; }
    else if (ema9 < ema21) { score -= 1; breakdown.ema = "-1 (9<21 bearish)"; }
    else { breakdown.ema = "0 (equal)"; }
  } else { breakdown.ema = "0 (n/a)"; }

  if (obRatio > 0.60) { score += 1; breakdown.ob = "+1 (bid heavy " + obRatio.toFixed(3) + ")"; }
  else if (obRatio < 0.40) { score -= 1; breakdown.ob = "-1 (ask heavy " + obRatio.toFixed(3) + ")"; }
  else { breakdown.ob = "0 (balanced " + obRatio.toFixed(3) + ")"; }

  console.log("SIGNAL SCORE:", score, "/ 7");
  console.log("BREAKDOWN:", breakdown);

  const absScore = Math.abs(score);

  if (absScore < 3) {
    console.log("No trade -- score " + score + " (need |3|+ for edge)");
    return { direction: "neutral", score, confidence: 0, price, breakdown };
  }

  const confidence = absScore / 7;
  const direction = score > 0 ? "up" : "down";
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

// Get best bid from LIVE orderbook — not the stale getMarket() snapshot
async function getBestBidFromOrderbook(ticker, side) {
  try {
    const ob = await getOrderbook(ticker, 10);
    const book = ob?.orderbook || ob?.order_book || ob;
    // Kalshi orderbook format: { yes: [[price, qty], ...], no: [[price, qty], ...] }
    // Sorted ascending — last element is the highest (best) bid
    const bids = book?.[side] || [];
    if (bids.length === 0) return null;
    const bestBidEntry = bids[bids.length - 1];
    const price = bestBidEntry[0];
    return validPx(price);
  } catch (e) {
    console.log("Orderbook fetch failed for " + ticker + ":", e?.message || e);
    return null;
  }
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
    const bestYesBid = yesBids.length > 0 ? validPx(yesBids[yesBids.length - 1][0]) : null;
    const bestNoBid = noBids.length > 0 ? validPx(noBids[noBids.length - 1][0]) : null;
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
      if (order.status === "executed" || (order.fill_count && order.fill_count > 0)) {
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
          count: order.fill_count || pending.count,
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
  const maxTrades = Number(cfg.maxTradesPerDay ?? 10);
  const maxLossCents = Math.round((Number(cfg.dailyMaxLossUsd ?? 50)) * 100);

  if (stats.totalPnlCents <= -maxLossCents) {
    console.log("DAILY LOSS LIMIT: $" + (stats.totalPnlCents / 100).toFixed(2) + " (max -$" + (maxLossCents / 100).toFixed(2) + "). Stopping.");
    return { ok: false, stats };
  }

  if (stats.totalTrades >= maxTrades) {
    console.log("DAILY TRADE LIMIT: " + stats.totalTrades + "/" + maxTrades + " trades. Stopping.");
    return { ok: false, stats };
  }

  return { ok: true, stats };
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
  const minMinutesToCloseToEnter = Number(cfg.minMinutesToCloseToEnter ?? 10);
  const makerOffset = Number(cfg.makerOffsetCents ?? 2);
  const takeProfitCents = Number(cfg.takeProfitCents ?? 75);

  _log("CONFIG: enabled=" + enabled + " mode=" + mode + " series=" + seriesTicker +
    " tp=$" + (takeProfitCents / 100).toFixed(2) + " priceband=" + minEntryPriceCents + "-" + maxEntryPriceCents + "c");

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
  const relevantPositions = kalshiPositions.filter(p =>
    p.ticker?.startsWith(seriesPrefix) && (p.total_traded > 0 || p.quantity > 0)
  );

  // Position recovery: if bot:position is null but Kalshi has a position, recover it
  if ((!pos || !pos.ticker) && relevantPositions.length > 0) {
    const kp = relevantPositions[0];
    const side = (kp.market_position || kp.position || "yes").toLowerCase();
    const count = kp.total_traded || kp.quantity || 1;
    _log("RECOVERING orphan position: " + side.toUpperCase() + " " + count + "x " + kp.ticker);
    let marketCloseTs = null;
    try {
      const mkt = await getMarket(kp.ticker);
      const mm = mkt?.market || mkt;
      marketCloseTs = mm?.close_time ? new Date(mm.close_time).getTime()
        : mm?.expiration_time ? new Date(mm.expiration_time).getTime() : null;
    } catch (_) {}
    pos = {
      ticker: kp.ticker, side, entryPriceCents: 50, count,
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
      await kvSetJson("bot:position", null);
      pos = null;
    } else {
      // ── TAKE PROFIT CHECK ──
      // Fetch LIVE orderbook — getMarket() returns stale/zero bids
      const bestBid = await getBestBidFromOrderbook(pos.ticker, pos.side);
      const entryPx = pos.entryPriceCents || 50;
      const count = pos.count || 1;
      const totalCost = entryPx * count;
      const currentValue = bestBid ? (bestBid * count) : 0;
      const totalProfit = currentValue - totalCost;

      _log("POSITION CHECK: " + pos.side.toUpperCase() + " " + count + "x " + pos.ticker +
        " | entry=" + entryPx + "c bid=" + (bestBid || "?") + "c" +
        " | cost=$" + (totalCost / 100).toFixed(2) + " value=$" + (currentValue / 100).toFixed(2) +
        " | P&L=" + (totalProfit >= 0 ? "+$" : "-$") + (Math.abs(totalProfit) / 100).toFixed(2));

      if (bestBid && totalProfit >= takeProfitCents) {
        _log("TAKE PROFIT: unrealized profit $" + (totalProfit / 100).toFixed(2) +
          " >= $" + (takeProfitCents / 100).toFixed(2) + " threshold. SELLING NOW.");

        if (mode !== "live") {
          _log("PAPER SELL: " + count + "x @ " + bestBid + "c");
          const revenueCents = bestBid * count;
          const pnlCents = revenueCents - totalCost;
          await logTradeResult({
            ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
            exitPriceCents: bestBid, count, result: "tp_exit", exitReason: "TAKE_PROFIT",
            revenueCents, costCents: totalCost, pnlCents,
            signal: pos.signal || null, openedTs: pos.openedTs, closedTs: Date.now(),
          });
          await recordDailyTrade("tp_exit", pnlCents);
          await kvSetJson("bot:position", null);
          _log("TAKE PROFIT: Sold " + count + " " + pos.side + " contracts at " + bestBid +
            "c, entry was " + entryPx + "c, profit: $" + (pnlCents / 100).toFixed(2));
          await kvSetJson("bot:state", { lastCheck: Date.now(), lastAction: "take_profit" });
          return { action: "take_profit", pnlCents, log };
        }

        // LIVE MODE: sell at best bid for instant execution
        const sellBody = {
          ticker: pos.ticker,
          action: "sell",
          type: "limit",
          side: pos.side,
          count,
          ...(pos.side === "yes" ? { yes_price: bestBid } : { no_price: bestBid }),
        };

        try {
          const sellRes = await kalshiFetch("/trade-api/v2/portfolio/orders", { method: "POST", body: sellBody });
          const sellOrder = sellRes?.order || {};
          _log("SELL ORDER: status=" + sellOrder.status + " fill=" + (sellOrder.fill_count || 0));

          if (sellOrder.status === "executed" || (sellOrder.fill_count && sellOrder.fill_count > 0)) {
            const fillCount = sellOrder.fill_count || count;
            const revenueCents = bestBid * fillCount;
            const pnlCents = revenueCents - (entryPx * fillCount);
            await logTradeResult({
              ticker: pos.ticker, side: pos.side, entryPriceCents: entryPx,
              exitPriceCents: bestBid, count: fillCount, result: "tp_exit", exitReason: "TAKE_PROFIT",
              revenueCents, costCents: entryPx * fillCount, pnlCents,
              signal: pos.signal || null, openedTs: pos.openedTs, closedTs: Date.now(),
            });
            await recordDailyTrade("tp_exit", pnlCents);
            await kvSetJson("bot:position", null);
            _log("TAKE PROFIT: Sold " + fillCount + " " + pos.side + " contracts at " + bestBid +
              "c, entry was " + entryPx + "c, profit: $" + (pnlCents / 100).toFixed(2));
            await kvSetJson("bot:state", { lastCheck: Date.now(), lastAction: "take_profit" });
            return { action: "take_profit", pnlCents, log };
          } else {
            _log("Sell order did not fill immediately (status=" + sellOrder.status + "). Will retry next run.");
          }
        } catch (e) {
          _log("Sell order failed: " + (e?.message || e) + " — will retry next run.");
        }
      } else if (bestBid && totalProfit > 0) {
        _log("HOLDING: Position has $" + (totalProfit / 100).toFixed(2) + " unrealized profit, waiting for $" +
          (takeProfitCents / 100).toFixed(2) + " target");
      } else if (bestBid) {
        _log("UNDERWATER: Position is -$" + (Math.abs(totalProfit) / 100).toFixed(2) + ", holding to settlement");
      } else {
        _log("NO BIDS on orderbook for " + pos.ticker + " — holding to settlement");
      }

      await kvSetJson("bot:state", { lastCheck: Date.now(), holding: pos.ticker });
      return { action: "holding", totalProfit, log };
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
    if (targetAsk < minEntryPriceCents || targetAsk > maxEntryPriceCents) continue;

    const limitPrice = targetAsk - makerOffset;
    if (limitPrice < minEntryPriceCents) continue;

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

  _log("BEST MARKET: " + best.ticker + " " + best.side + " ask=" + best.targetAsk + "c limit=" + best.limitPrice + "c edge=" + best.edge.toFixed(1) + "c");

  if (best.edge < minEdge) {
    _log("No trade -- edge " + best.edge.toFixed(1) + "c < min " + minEdge + "c.");
    await kvSetJson("bot:state", { lastSignal: sig, lastCheck: Date.now() });
    return { action: "insufficient_edge", log };
  }

  // ── Step 7: Place maker order ──

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.limitPrice });
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.limitPrice + "c (maker, mode=" + mode + ")";
  _log("ORDER: " + line);

  if (mode !== "live") {
    _log("PAPER MODE: " + line);
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count, openedTs: Date.now(), orderId: "paper-" + Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb },
      marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson("bot:position", posData);
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

  if (status === "executed" || (order.fill_count && order.fill_count > 0)) {
    const fillCount = order.fill_count || count;
    _log("ORDER FILLED immediately: " + fillCount + "x @ " + best.limitPrice + "c");
    const posData = {
      ticker: best.ticker, side: best.side, entryPriceCents: best.limitPrice,
      count: fillCount, openedTs: Date.now(), orderId: order.order_id || null,
      signal: { direction: sig.direction, score: sig.score, predProb },
      marketCloseTs: best.marketCloseTs,
    };
    await kvSetJson("bot:position", posData);
    const verify = await kvGetJson("bot:position");
    _log("POSITION SAVED: " + (verify?.ticker || "WRITE FAILED"));
    await kvSetJson("bot:lastTradeTs", Date.now());
  } else if (status === "resting") {
    _log("ORDER RESTING on book. Will check for fill next run.");
    await kvSetJson("bot:pendingOrder", {
      orderId: order.order_id, ticker: best.ticker, side: best.side,
      limitPrice: best.limitPrice, count, placedTs: Date.now(),
      signal: { direction: sig.direction, score: sig.score, predProb },
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
