import { kvGetJson, kvSetJson } from "./kv.js";
import { getBTCSignal } from "./signal.js";
import { getMarkets, getOrderbook, placeOrder } from "./kalshi.js";
import { getOrderbookDepth } from "./kalshi.js";

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function calcContracts({ tradeSizeUsd, maxContracts, askCents }) {
  if (!askCents || askCents <= 0) return 0;
  const budgetCents = Math.max(1, Math.round((tradeSizeUsd || 5) * 100));
  const byBudget = Math.floor(budgetCents / askCents);
  return clamp(Math.max(1, byBudget), 1, maxContracts || 5);
}

function probYesFromSignal(direction, confidence) {
  // 50% + scaled confidence tilt (simple baseline)
  const c = clamp(confidence || 0, 0, 1);
  const p = 0.5 + c * 0.35;
  if (direction === "down") return 1 - p;
  if (direction === "up") return p;
  return 0.5;
}

function topByVolume(markets, n = 30) {
  const ms = Array.isArray(markets) ? markets : [];
  return ms
    .slice()
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, n);
}

function validAsk(v) {
  const n = (typeof v === "number") ? v : null;
  if (!n) return null;
  if (n < 1 || n >= 99) return null;
  return n;
}

async function resolveAsks(ticker, market) {
  // Prefer snapshot asks when valid
  const snapYes = validAsk(market?.yes_ask);
  const snapNo  = validAsk(market?.no_ask);

  // If both snapshot asks are valid, use snapshot
  if (snapYes && snapNo) {
    return { yesAsk: snapYes, noAsk: snapNo, source: "snapshot", book: null };
  }

  // Otherwise fallback to orderbook depth=1
  const ob = await getOrderbook(ticker, 1);
  const yesAsks = ob?.orderbook?.yes_asks || [];
  const noAsks  = ob?.orderbook?.no_asks  || [];

  const obYes = validAsk(yesAsks?.[0]?.price ?? null);
  const obNo  = validAsk(noAsks?.[0]?.price ?? null);

  return {
    yesAsk: snapYes || obYes || null,
    noAsk:  snapNo  || obNo  || null,
    source: (obYes || obNo) ? "orderbook" : "none",
    book: { bestYesAsk: obYes, bestNoAsk: obNo }
  };
}

async function pickBestCandidate({ seriesTicker, pYes, maxEntryPriceCents }) {
  const series = String(seriesTicker || "KXBTC15M").toUpperCase();

  // Use OPEN markets; exclude MVE combos
  const resp = await getMarkets({ series_ticker: series, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];

  console.log("Markets source: series(" + series + ") — found: " + markets.length);

  // Keep only true series markets (ticker prefix)
  const prefix = series + "-";
  const btc = markets.filter(m => typeof m?.ticker === "string" && m.ticker.startsWith(prefix));

  if (!btc.length) return null;

  const candidates = topByVolume(btc, 30);

  const predictedYes = clamp(Math.round(pYes * 100), 1, 99);
  const predictedNo = 100 - predictedYes;

  let best = null;

  for (const m of candidates) {
    const ticker = m.ticker;

    let asks;
    try {
      asks = await resolveAsks(ticker, m);
    } catch (e) {
      console.log("Skip " + ticker + " — orderbook error: " + e.message);
      continue;
    }

    const yesAsk = asks.yesAsk;
    const noAsk  = asks.noAsk;

    // Enforce max entry price
    const yesOk = yesAsk && yesAsk <= maxEntryPriceCents;
    const noOk  = noAsk  && noAsk  <= maxEntryPriceCents;

    if (!yesOk && !noOk) {
      console.log("Skip " + ticker + " — no valid asks (src=" + asks.source + ")", asks.book || "");
      continue;
    }

    const edgeYes = yesOk ? (predictedYes - yesAsk) : -9999;
    const edgeNo  = noOk  ? (predictedNo  - noAsk)  : -9999;

    const side = edgeYes >= edgeNo ? "yes" : "no";
    const askCents = side === "yes" ? yesAsk : noAsk;
    const edgeCents = side === "yes" ? edgeYes : edgeNo;

    const cand = {
      ticker,
      status: m.status,
      volume: m.volume || 0,
      side,
      askCents,
      source: asks.source,
      predictedYes,
      predictedNo,
      edgeYes,
      edgeNo,
      edgeCents
    };

    // Keep best edge overall
    if (!best || cand.edgeCents > best.edgeCents) best = cand;
  }

  return best;
}

async function getOpenPosition() {
  return (await kvGetJson("bot:position")) || null;
}

async function setOpenPosition(pos) {
  await kvSetJson("bot:position", pos);
}

async function clearOpenPosition() {
  await kvSetJson("bot:position", null);
}

function pct(n) {
  return Math.round(n * 1000) / 10; // 1 decimal percent
}

function validBid(v) {
  const n = (typeof v === "number") ? v : null;
  if (!n) return null;
  if (n < 1 || n >= 99) return null;
  return n;
}

async function getBestBidForSide(ticker, side, marketSnapshot) {
  // Prefer snapshot bid if available
  const snapBid = side === "yes" ? validBid(marketSnapshot?.yes_bid) : validBid(marketSnapshot?.no_bid);
  if (snapBid) return { bidCents: snapBid, source: "snapshot" };

  // Fallback: orderbook top bid
  const ob = await getOrderbookDepth(ticker, 1);
  const book = ob?.orderbook || ob?.order_book || null;

  const yesBids = book?.yes_bids || [];
  const noBids  = book?.no_bids  || [];

  const obBid = side === "yes"
    ? validBid(yesBids?.[0]?.price ?? null)
    : validBid(noBids?.[0]?.price ?? null);

  return { bidCents: obBid || null, source: obBid ? "orderbook" : "none" };
}

async function maybeExitPosition({ cfg, kalshiMarketSnapshot }) {
  const pos = await getOpenPosition();
  if (!pos) return { exited: false };

  const side = pos.side;
  const ticker = pos.ticker;
  const entry = Number(pos.entryPriceCents || 0);
  const count = Number(pos.count || 0);

  if (!ticker || !entry || !count) {
    console.log("Position invalid — clearing.");
    await clearOpenPosition();
    return { exited: false };
  }

  const takeProfitPct = Number(cfg.takeProfitPct ?? 0.20);
  const stopLossPct   = Number(cfg.stopLossPct   ?? 0.12);

  const bid = await getBestBidForSide(ticker, side, kalshiMarketSnapshot);
  if (!bid.bidCents) {
    console.log("Exit check — no valid bid yet (" + bid.source + "). Holding position.");
    return { exited: false };
  }

  const pnlCentsPer = bid.bidCents - entry;
  const pnlPct = pnlCentsPer / entry;

  console.log(
    "OPEN POSITION:",
    side.toUpperCase(),
    count + "x",
    ticker,
    "entry=" + entry + "¢",
    "bestBid=" + bid.bidCents + "¢ (" + bid.source + ")",
    "PnL=" + (pnlCentsPer >= 0 ? "+" : "") + pnlCentsPer + "¢/ct",
    "(" + (pnlPct >= 0 ? "+" : "") + pct(pnlPct) + "%)"
  );

  const hitTP = pnlPct >= takeProfitPct;
  const hitSL = pnlPct <= -stopLossPct;

  if (!hitTP && !hitSL) {
    console.log("No exit — TP/SL not hit. TP=" + pct(takeProfitPct) + "% SL=-" + pct(stopLossPct) + "%");
    return { exited: false };
  }

  const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
  const actionLine = "SELL " + side.toUpperCase() + " " + count + "x " + ticker + " @ " + bid.bidCents + "¢ (reason=" + reason + ", mode=" + cfg.mode + ")";
  console.log("EXIT:", actionLine);

  if (String(cfg.mode || "paper").toLowerCase() !== "live") {
    console.log("PAPER MODE — would exit:", actionLine);
    await kvSetJson("bot:last_run", {
      ts: Date.now(),
      action: "paper_exit",
      reason,
      marketTicker: ticker,
      side,
      count,
      entryPriceCents: entry,
      exitPriceCents: bid.bidCents
    });
    await clearOpenPosition();
    return { exited: true };
  }

  const res = await placeOrder({ ticker, side, count, priceCents: bid.bidCents, action: "sell" });
  console.log("EXIT ORDER RESULT:", res);

  await kvSetJson("bot:last_run", {
    ts: Date.now(),
    action: "live_exit",
    reason,
    marketTicker: ticker,
    side,
    count,
    entryPriceCents: entry,
    exitPriceCents: bid.bidCents,
    order: res?.order || null
  });

  await clearOpenPosition();
  return { exited: true };
}

async function main() {
  const cfg = (await kvGetJson("bot:config")) || {};
  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();

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
// --- Exit management (sell-to-close) ---
  // If we already have an open position, manage it first.
  try {
    // best effort snapshot for the position ticker (optional; may not exist)
    const exitAttempt = await maybeExitPosition({ cfg: { ...cfg, mode }, kalshiMarketSnapshot: null });
    if (exitAttempt.exited) {
      console.log("Exited position — skipping new entry this run.");
      return;
    }
    const existing = await getOpenPosition();
    if (existing) {
      console.log("Holding open position — skipping new entry this run.");
      return;
    }
  } catch (e) {
    console.log("Exit manager error (non-fatal):", e?.message || e);
  }

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

  const pYes = probYesFromSignal(direction, confidence);
  const best = await pickBestCandidate({ seriesTicker, pYes, maxEntryPriceCents });

  if (!best) {
    console.log("No tradable markets found for series:", seriesTicker);
    return;
  }

  console.log("Selected market:", {
    ticker: best.ticker,
    status: best.status,
    volume: best.volume,
    askCents: best.askCents,
    side: best.side,
    source: best.source
  });

  console.log(
    "Edge check:",
    "predYES=" + best.predictedYes + "¢",
    "predNO=" + best.predictedNo + "¢",
    "yesAsk=" + (best.askCents && best.side === "yes" ? best.askCents : (best.edgeYes > -9999 ? (best.predictedYes - best.edgeYes) : "NA")) + "¢",
    "noAsk="  + (best.askCents && best.side === "no"  ? best.askCents : (best.edgeNo  > -9999 ? (best.predictedNo  - best.edgeNo ) : "NA")) + "¢",
    "edgeYES=" + (best.edgeYes > -9999 ? best.edgeYes : "NA") + "¢",
    "edgeNO="  + (best.edgeNo  > -9999 ? best.edgeNo  : "NA") + "¢",
    "chosen=" + best.side.toUpperCase() + " edge=" + best.edgeCents + "¢ minEdge=" + minEdge + "¢"
  );

  if (best.edgeCents < minEdge) {
    console.log("No trade — edge too small.");
    await kvSetJson("bot:last_run", {
      ts: Date.now(),
      action: "skip_edge",
      signalDir: direction,
      confidence,
      marketTicker: best.ticker,
      chosenSide: best.side,
      askCents: best.askCents,
      edgeCents: best.edgeCents
    });
    return;
  }

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.askCents });

  const out = {
    ts: Date.now(),
    action: "consider",
    signalDir: direction,
    confidence,
    marketTicker: best.ticker,
    chosenSide: best.side,
    askCents: best.askCents,
    edgeCents: best.edgeCents,
    mode
  };

  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.askCents + "¢ (mode=" + mode + ")";
  console.log("Decision:", line);

  if (mode !== "live") {
    console.log("PAPER MODE — would place:", line);
    out.action = "paper";
    out.count = count;
    await kvSetJson("bot:last_run", out);
    return;
  }

  console.log("LIVE: placing order:", line);
  const res = await placeOrder({ ticker: best.ticker, side: best.side, count, priceCents: best.askCents });
  console.log("ORDER RESULT:", res);

  
  // Persist open position for autonomous sell-to-close
  try {
    if (String(mode).toLowerCase() === "live") {
      await setOpenPosition({
        ticker: best.ticker,
        side: best.side,
        entryPriceCents: best.askCents,
        count,
        openedTs: Date.now(),
        orderId: res?.order?.order_id || null
      });
      console.log("Saved bot:position");
    }
  } catch (e) {
    console.log("Failed saving bot:position (non-fatal):", e?.message || e);
  }
out.action = "live";
  out.count = count;
  out.order = res?.order || null;
  await kvSetJson("bot:last_run", out);
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
