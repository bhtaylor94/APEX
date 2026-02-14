import { kvGetJson, kvSetJson } from "./kv.js";
import { getBTCSignal } from "./signal.js";
import { getMarkets, getOrderbook, placeOrder } from "./kalshi.js";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function calcContracts({ tradeSizeUsd, maxContracts, askCents }) {
  if (!askCents || askCents <= 0) return 0;
  const budgetCents = Math.max(1, Math.round((tradeSizeUsd || 5) * 100));
  const byBudget = Math.floor(budgetCents / askCents);
  return clamp(Math.max(1, byBudget), 1, maxContracts || 5);
}

function probFromSignal(direction, confidence) {
  // You can improve this later; for now: 50% + scaled confidence
  const c = clamp(confidence || 0, 0, 1);
  const p = 0.5 + c * 0.35;
  return direction === "down" ? (1 - p) : p;
}

async function pickTradableMarket(seriesTicker, desiredSide, maxEntryPriceCents) {
  const series = String(seriesTicker || "KXBTC15M").toUpperCase();

  const resp = await getMarkets({ series_ticker: series, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];

  console.log("Markets source: series(" + series + ") — found: " + markets.length);

  // Keep only BTC15M market tickers
  const btc = markets.filter(m => typeof m?.ticker === "string" && m.ticker.startsWith(series + "-"));
  if (!btc.length) return null;

  // Sort by volume desc
  btc.sort((a, b) => (b.volume || 0) - (a.volume || 0));

  // Try top N by volume; for each, find ask either from snapshot or orderbook
  const N = Math.min(30, btc.length);
  for (let i = 0; i < N; i++) {
    const m = btc[i];
    const ticker = m.ticker;

    // Snapshot ask may be missing / 99 — treat >=99 as non-tradable for entry
    const snapAsk = desiredSide === "yes" ? m.yes_ask : m.no_ask;
    let askCents = (typeof snapAsk === "number" ? snapAsk : null);
    let source = "snapshot";

    if (!askCents || askCents >= 99) {
      try {
        const ob = await getOrderbook(ticker, 1);
        const yesAsks = ob?.orderbook?.yes_asks || [];
        const noAsks  = ob?.orderbook?.no_asks  || [];
        const bestAsk = desiredSide === "yes"
          ? (yesAsks[0]?.price ?? null)
          : (noAsks[0]?.price  ?? null);

        askCents = (typeof bestAsk === "number" ? bestAsk : null);
        source = "orderbook";
      } catch (e) {
        // skip quietly
        continue;
      }
    }

    if (!askCents || askCents >= 99) continue;
    if (typeof maxEntryPriceCents === "number" && askCents > maxEntryPriceCents) continue;

    return {
      ticker,
      status: m.status,
      volume: m.volume || 0,
      askCents,
      source
    };
  }

  return null;
}

async function main() {
  const cfg = (await kvGetJson("bot:config")) || {};
  const enabled = !!cfg.enabled;
  const mode = (cfg.mode || "paper").toLowerCase();

  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();
  const minConfidence = Number(cfg.minConfidence ?? 0.15);
  const minEdge = Number(cfg.minEdge ?? 5);
  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 5);
  const maxContracts = Number(cfg.maxContracts ?? 5);
  const maxEntryPriceCents = (cfg.maxEntryPriceCents == null) ? 85 : Number(cfg.maxEntryPriceCents);

  console.log("CONFIG:", {
    enabled, mode, seriesTicker, tradeSizeUsd, maxContracts, minConfidence, minEdge, maxEntryPriceCents
  });

  if (!enabled) {
    console.log("Bot disabled — exiting.");
    return;
  }

  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  const direction = String(sig.direction || "none").toLowerCase();
  const confidence = Number(sig.confidence || 0);

  if (direction !== "up" && direction !== "down") {
    console.log("No trade — signal direction NONE");
    return;
  }
  if (confidence < minConfidence) {
    console.log("No trade — confidence too low:", confidence, "<", minConfidence);
    return;
  }

  const desiredSide = direction === "up" ? "yes" : "no";
  const predictedProb = Math.round(probFromSignal(direction, confidence) * 100);

  const picked = await pickTradableMarket(seriesTicker, desiredSide, maxEntryPriceCents);
  if (!picked) {
    console.log("No tradable markets found for series:", seriesTicker);
    return;
  }

  console.log("Selected market:", picked);

  const ask = picked.askCents;
  const edge = predictedProb - ask;

  console.log("Edge check: predicted=" + predictedProb + "¢ market=" + ask + "¢ edge=" + edge + "¢ minEdge=" + minEdge + "¢");

  if (edge < minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: ask });

  const state = (await kvGetJson("bot:last_run")) || {};
  const out = {
    ts: Date.now(),
    action: "consider",
    signalDir: direction,
    confidence,
    predictedProb,
    marketTicker: picked.ticker,
    askCents: ask,
    edgeCents: edge,
    chosenSide: desiredSide,
    mode
  };

  if (mode !== "live") {
    console.log("PAPER: would buy " + desiredSide.toUpperCase() + " " + count + "x " + picked.ticker + " @ " + ask + "¢");
    out.action = "paper";
    out.count = count;
    await kvSetJson("bot:last_run", out);
    return;
  }

  console.log("LIVE: placing order " + desiredSide.toUpperCase() + " " + count + "x " + picked.ticker + " @ " + ask + "¢");
  const res = await placeOrder({ ticker: picked.ticker, side: desiredSide, count, priceCents: ask });

  console.log("ORDER RESULT:", res);

  out.action = "live";
  out.count = count;
  out.order = res?.order || null;
  await kvSetJson("bot:last_run", out);
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
