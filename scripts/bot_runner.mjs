import { defaultConfig } from "./default_config.mjs";
import { kvGetJson, kvSetJson } from "./upstash_kv.mjs";
import { KalshiClient } from "./kalshi_client.mjs";
import { fetchCoinbaseCandles, computeSignal } from "./btc_signal.mjs";

function nowMs() { return Date.now(); }
function dayKey() { return new Date().toISOString().slice(0,10); }

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

async function main() {
  const cfg = Object.assign({}, defaultConfig(), await kvGetJson("bot:config"));

  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Exiting.");
    return;
  }

  // IMPORTANT: You must set the exact market tickers you want to trade
  // in Upstash config. This avoids guessing the wrong BTC contract.
  const MARKET_UP = cfg.marketTickerUp;
  const MARKET_DOWN = cfg.marketTickerDown;
  if (!MARKET_UP || !MARKET_DOWN) {
    console.log("Missing cfg.marketTickerUp / cfg.marketTickerDown. Refusing to trade.");
    return;
  }

  const state = Object.assign(
    { position: null, cooldownUntil: 0, daily: { date: dayKey(), pnlUsd: 0, trades: 0, lossStreak: 0 } },
    await kvGetJson("bot:state")
  );

  // Reset daily counters if new day
  if (state.daily?.date !== dayKey()) {
    state.daily = { date: dayKey(), pnlUsd: 0, trades: 0, lossStreak: 0 };
  }

  if (state.cooldownUntil && nowMs() < state.cooldownUntil) {
    console.log("Cooldown active until", new Date(state.cooldownUntil).toISOString());
    return;
  }

  if (state.daily.trades >= cfg.maxTradesPerDay) {
    console.log("Max trades/day reached.");
    return;
  }

  if (state.daily.pnlUsd <= -Math.abs(cfg.dailyMaxLossUsd)) {
    console.log("Daily max loss reached. Halting trades for the day.");
    return;
  }

  // Fetch BTC candles (Coinbase) and compute signal
  const candles = await fetchCoinbaseCandles({ granularity: 60, limit: 120 });
  const sig = computeSignal(candles);

  console.log("SIGNAL:", sig);

  if (sig.confidence < cfg.minConfidence || sig.dir === "NONE") {
    console.log("No trade: signal too weak or NONE.");
    return;
  }

  const kalshi = new KalshiClient();

  // Helper to get best ask/bid for YES side
  async function bestYesPrices(marketTicker) {
    const ob = await kalshi.getOrderbook(marketTicker, 1);
    const yesAsks = ob?.orderbook?.yes_asks || [];
    const yesBids = ob?.orderbook?.yes_bids || [];
    const bestAsk = yesAsks.length ? yesAsks[0][0] : null; // price in cents
    const bestBid = yesBids.length ? yesBids[0][0] : null;
    return { bestAsk, bestBid };
  }

  // Decide which market to trade based on UP/DOWN
  const targetMarket = sig.dir === "UP" ? MARKET_UP : MARKET_DOWN;

  // Position management
  const pos = state.position;

  // Exit rules if we have a position
  if (pos) {
    const { bestBid } = await bestYesPrices(pos.marketTicker);
    if (!bestBid) {
      console.log("No bestBid available; skipping exit check.");
      return;
    }

    const entry = pos.entryYesPriceCents;
    const current = bestBid;
    const pnlPct = (current - entry) / entry;

    const openMins = (nowMs() - pos.openedAtMs) / 60000;

    const hitTP = pnlPct >= cfg.takeProfitPct;
    const hitSL = pnlPct <= -cfg.stopLossPct;
    const hitTime = openMins >= cfg.timeStopMinutes;
    const reversal = (sig.dir !== pos.side && sig.confidence >= clamp(cfg.minConfidence + 0.10, 0, 0.95));

    console.log("POSITION:", { entry, current, pnlPct: pnlPct.toFixed(3), openMins: openMins.toFixed(1), hitTP, hitSL, hitTime, reversal });

    if (!hitTP && !hitSL && !hitTime && !reversal) {
      console.log("Holding position.");
      return;
    }

    if (cfg.mode !== "live") {
      console.log("PAPER SELL:", pos.marketTicker, pos.count, "reason:", { hitTP, hitSL, hitTime, reversal });
      // Simulate pnl: contract is $1 at settle, but we approximate using bid
      const pnlUsd = ((current - entry) / 100) * pos.count;
      state.daily.pnlUsd = Number((state.daily.pnlUsd + pnlUsd).toFixed(2));
    } else {
      console.log("LIVE SELL:", pos.marketTicker, pos.count, "YES @ market");
      // Sell YES using market order (action sell)
      await kalshi.createOrder({ ticker: pos.marketTicker, type: "market", action: "sell", side: "yes", count: pos.count, yes_price: 1 });
      // We don’t know exact fill price here without querying fills; keep pnl approximate until we add fill fetch.
    }

    state.position = null;
    state.cooldownUntil = nowMs() + cfg.cooldownMinutes * 60000;
    state.daily.trades += 1;

    await kvSetJson("bot:state", state);
    console.log("Exited. Updated state saved.");
    return;
  }

  // Entry rules (no position)
  const { bestAsk } = await bestYesPrices(targetMarket);
  if (!bestAsk) {
    console.log("No liquidity (bestAsk missing). No entry.");
    return;
  }

  // Simple sizing: tradeSizeUsd / (price in dollars) -> contracts
  const priceUsd = bestAsk / 100;
  const count = Math.max(1, Math.floor(cfg.tradeSizeUsd / Math.max(0.01, priceUsd)));

  if (count < 1) {
    console.log("Trade size too small for current ask. No entry.");
    return;
  }

  if (cfg.mode !== "live") {
    console.log("PAPER BUY:", targetMarket, count, "YES @", bestAsk);
  } else {
    console.log("LIVE BUY:", targetMarket, count, "YES @", bestAsk);
    // Buy YES market order (or limit). We'll do market with a max yes_price cap.
    await kalshi.createOrder({ ticker: targetMarket, type: "market", action: "buy", side: "yes", count, yes_price: bestAsk });
  }

  state.position = {
    side: sig.dir,
    marketTicker: targetMarket,
    entryYesPriceCents: bestAsk,
    count,
    openedAtMs: nowMs()
  };

  state.cooldownUntil = nowMs() + cfg.cooldownMinutes * 60000;
  await kvSetJson("bot:state", state);

  console.log("Entered position. State saved.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
