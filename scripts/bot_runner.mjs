import { defaultConfig } from "./default_config.mjs";
import { kvGetJson, kvSetJson } from "./upstash_kv.mjs";
import { KalshiClient } from "./kalshi_client.mjs";
import { fetchCoinbaseCandles, computeSignal } from "./btc_signal.mjs";

function nowMs() { return Date.now(); }
function dayKey() { return new Date().toISOString().slice(0,10); }
function clamp(n,a,b){ return Math.max(a, Math.min(b, n)); }

async function main() {
  const cfg = Object.assign({}, defaultConfig(), await kvGetJson("bot:config"));
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled. Exiting.");
    return;
  }

  const state = Object.assign(
    { position: null, cooldownUntil: 0, daily: { date: dayKey(), pnlUsd: 0, trades: 0 } },
    await kvGetJson("bot:state")
  );

  if (state.daily?.date !== dayKey()) state.daily = { date: dayKey(), pnlUsd: 0, trades: 0 };

  if (state.cooldownUntil && nowMs() < state.cooldownUntil) {
    console.log("Cooldown active until", new Date(state.cooldownUntil).toISOString());
    return;
  }
  if (state.daily.trades >= cfg.maxTradesPerDay) {
    console.log("Max trades/day reached.");
    return;
  }
  if (state.daily.pnlUsd <= -Math.abs(cfg.dailyMaxLossUsd)) {
    console.log("Daily max loss reached.");
    return;
  }

  const candles = await fetchCoinbaseCandles({ granularity: 60, limit: 120 });
  const sig = computeSignal(candles);
  console.log("SIGNAL:", sig);

  const kalshi = new KalshiClient();

  // Pick active 15-minute market (soonest closing open market in series)
  const mktsResp = await kalshi.getMarkets({ series_ticker: cfg.seriesTicker, status: "open", limit: 50 });
  const markets = Array.isArray(mktsResp?.markets) ? mktsResp.markets : [];
  if (!markets.length) {
    console.log("No open markets for series:", cfg.seriesTicker);
    return;
  }
  markets.sort((a,b) => new Date(a.close_time).getTime() - new Date(b.close_time).getTime());
  const m = markets[0];
  const closeMs = new Date(m.close_time).getTime();
  const minsToClose = (closeMs - nowMs()) / 60000;

  console.log("ACTIVE MARKET:", {
    ticker: m.ticker,
    yes: m.yes_sub_title,
    no: m.no_sub_title,
    close_time: m.close_time,
    minsToClose: minsToClose.toFixed(2),
    yes_ask: m.yes_ask,
    no_ask: m.no_ask,
    yes_bid: m.yes_bid,
    no_bid: m.no_bid
  });

  // Exit logic
  if (state.position) {
    const pos = state.position;
    const minsLeft = (pos.closeTimeMs - nowMs()) / 60000;

    const bidCents = pos.side === "yes" ? (m.yes_bid ?? null) : (m.no_bid ?? null);
    if (!bidCents) {
      console.log("No bid for held side; skipping exit check.");
      return;
    }

    const entry = pos.entryPriceCents;
    const current = bidCents;
    const pnlPct = (current - entry) / Math.max(1, entry);

    const hitTP = pnlPct >= cfg.takeProfitPct;
    const hitSL = pnlPct <= -cfg.stopLossPct;
    const mustExitForTime = minsLeft <= cfg.minMinutesToCloseToHold;

    const reversal = (sig.dir !== pos.direction && sig.confidence >= clamp(cfg.minConfidence + 0.10, 0, 0.95));

    console.log("POSITION:", { entry, current, pnlPct: pnlPct.toFixed(3), minsLeft: minsLeft.toFixed(2), hitTP, hitSL, mustExitForTime, reversal });

    if (!hitTP && !hitSL && !mustExitForTime && !reversal) {
      console.log("Holding position.");
      return;
    }

    if (cfg.mode === "live") {
      console.log("LIVE SELL:", { ticker: pos.marketTicker, side: pos.side, count: pos.count });
      await kalshi.createOrder({ ticker: pos.marketTicker, type: "market", action: "sell", side: pos.side, count: pos.count, priceCents: 1 });
    } else {
      console.log("PAPER SELL:", { ticker: pos.marketTicker, side: pos.side, count: pos.count });
      const pnlUsd = ((current - entry) / 100) * pos.count;
      state.daily.pnlUsd = Number((state.daily.pnlUsd + pnlUsd).toFixed(2));
    }

    state.position = null;
    state.cooldownUntil = nowMs() + cfg.cooldownMinutes * 60000;
    state.daily.trades += 1;

    await kvSetJson("bot:state", state);
    console.log("Exited. State saved.");
    return;
  }

  // Entry logic
  if (minsToClose <= cfg.minMinutesToCloseToEnter) {
    console.log("Too close to close to enter. Skipping entry.");
    return;
  }
  if (sig.dir === "NONE" || sig.confidence < cfg.minConfidence) {
    console.log("No entry: weak or NONE signal.");
    return;
  }

  const yesIsUp = (m.yes_sub_title || "").toLowerCase().includes("up");
  const noIsUp  = (m.no_sub_title  || "").toLowerCase().includes("up");
  if (!yesIsUp && !noIsUp) {
    console.log("Cannot infer Up/Down mapping from subtitles. Refusing to trade.");
    return;
  }

  const desiredSide =
    sig.dir === "UP"
      ? (yesIsUp ? "yes" : "no")
      : (yesIsUp ? "no" : "yes");

  const askCents = desiredSide === "yes" ? (m.yes_ask ?? null) : (m.no_ask ?? null);
  if (!askCents) {
    console.log("No ask for desired side; skipping entry.");
    return;
  }

  const priceUsd = askCents / 100;
  const count = Math.max(1, Math.floor(cfg.tradeSizeUsd / Math.max(0.01, priceUsd)));

  console.log("ENTRY PLAN:", { direction: sig.dir, desiredSide, askCents, count });

  if (cfg.mode === "live") {
    console.log("LIVE BUY:", { ticker: m.ticker, side: desiredSide, count, askCents });
    await kalshi.createOrder({ ticker: m.ticker, type: "market", action: "buy", side: desiredSide, count, priceCents: askCents });
  } else {
    console.log("PAPER BUY:", { ticker: m.ticker, side: desiredSide, count, askCents });
  }

  state.position = {
    marketTicker: m.ticker,
    side: desiredSide,            // "yes" or "no"
    direction: sig.dir,           // "UP" or "DOWN"
    entryPriceCents: askCents,
    count,
    openedAtMs: nowMs(),
    closeTimeMs: closeMs
  };

  state.cooldownUntil = nowMs() + cfg.cooldownMinutes * 60000;
  await kvSetJson("bot:state", state);
  console.log("Entered. State saved.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
