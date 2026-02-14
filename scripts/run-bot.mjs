import { kvGetJson, kvSetJson } from "./kv.mjs";
import { getMarkets, getMarket, getOrderbook, placeOrder } from "./kalshi_client.mjs";

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

// Minimal: you already have a signal engine; this just reads what your bot:config expects.
// If you store your real signal elsewhere, wire it here.
async function getSignal() {
  // If you have a key like bot:signal, we’ll use it; otherwise we default to neutral-ish behavior.
  const s = await kvGetJson("bot:signal");
  if (s && typeof s === "object" && s.direction && s.confidence != null) return s;
  // fallback (keeps bot alive even if signal store is missing)
  return { direction: "up", confidence: 0.20, price: 0 };
}

function pct(n){ return Math.round(n*1000)/10; }

function validBid(v){
  const n = (typeof v === "number") ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > 99) return null;
  return n;
}

async function getBestBid(ticker, side){
  // snapshot bid first
  try {
    const m = await getMarket(ticker);
    const mm = m?.market || m;
    const y = validBid(mm?.yes_bid ?? mm?.yesBid ?? null);
    const n = validBid(mm?.no_bid  ?? mm?.noBid  ?? null);
    const bid = side === "yes" ? y : n;
    if (bid) return { bidCents: bid, source: "snapshot" };
  } catch (_) {}

  // orderbook fallback
  try {
    const ob = await getOrderbook(ticker, 1);
    const book = ob?.orderbook || ob?.order_book || ob;
    const yesBids = book?.yes_bids || book?.yesBids || [];
    const noBids  = book?.no_bids  || book?.noBids  || [];
    const bid = side === "yes"
      ? validBid(yesBids?.[0]?.price ?? null)
      : validBid(noBids?.[0]?.price  ?? null);
    if (bid) return { bidCents: bid, source: "orderbook" };
  } catch (_) {}

  return { bidCents: null, source: "none" };
}

async function maybeExitPosition(cfg){
  const pos = await kvGetJson("bot:position");
  console.log("DEBUG bot:position loaded =>", pos, "type:", typeof pos);
if (!pos) return { exited:false, holding:false };

  const ticker = pos.ticker;
  const side = pos.side;
  const entry = Number(pos.entryPriceCents || 0);
  const count = Number(pos.count || 0);

  if (!ticker || (side !== "yes" && side !== "no") || !entry || !count) {
    console.log("Position invalid — clearing.");
    try { await kvSetJson("bot:position", null); } catch {}
    return { exited:false, holding:false };
  }

  const takeProfitPct = Number(cfg.takeProfitPct ?? 0.20);
  const stopLossPct   = Number(cfg.stopLossPct   ?? 0.12);

  const bid = await getBestBid(ticker, side);
  if (!bid.bidCents) {
    console.log("HOLD — no bid to exit on yet.");
    return { exited:false, holding:true };
  }

  const pnlCentsPer = bid.bidCents - entry;
  const pnlPct = pnlCentsPer / entry;

  console.log(
    "POSITION:",
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
    return { exited:false, holding:true };
  }

  const reason = hitTP ? "TAKE_PROFIT" : "STOP_LOSS";
  const line = "SELL " + side.toUpperCase() + " " + count + "x " + ticker + " @ " + bid.bidCents + "¢ (reason=" + reason + ", mode=" + cfg.mode + ")";
  console.log("EXIT:", line);

  if (String(cfg.mode || "paper").toLowerCase() !== "live") {
    console.log("PAPER MODE — would exit:", line);
    try { await kvSetJson("bot:position", null); } catch {}
    return { exited:true, holding:false };
  }

  const res = await placeOrder({ ticker, side, count, priceCents: bid.bidCents, action: "sell" });
  console.log("EXIT ORDER RESULT:", res);

  try { await kvSetJson("bot:position", null); } catch {}
  return { exited:true, holding:false };
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

async function main() {
  const cfg = (await kvGetJson("bot:config")) || {};

  const enabled = !!cfg.enabled;
  const mode = String(cfg.mode || "paper").toLowerCase();
  const seriesTicker = String(cfg.seriesTicker || "KXBTC15M").toUpperCase();

  const tradeSizeUsd = Number(cfg.tradeSizeUsd ?? 5);
  const maxContracts = Number(cfg.maxContracts ?? 5);
  const minConfidence = Number(cfg.minConfidence ?? 0.15);
  const minEdge = Number(cfg.minEdge ?? 5);
  const maxEntryPriceCents = (cfg.maxEntryPriceCents == null) ? 85 : Number(cfg.maxEntryPriceCents);

  console.log("CONFIG:", {
    enabled, mode, seriesTicker,
    tradeSizeUsd, maxContracts,
    minConfidence, minEdge, maxEntryPriceCents
  });

  if (!enabled) return console.log("Bot disabled — exiting.");

  const sig = await getSignal();
  console.log("SIGNAL:", sig);
// --- Exit management first (sell-to-close) ---
  try {
    const ex = await maybeExitPosition({ ...cfg, mode });
    if (ex.exited) {
      console.log("Exited position — skipping entry this run.");
      return;
    }
    if (ex.holding) {
      console.log("Holding open position (override): continuing to allow new entries.");
}
  } catch (e) {
    console.log("Exit manager error (non-fatal):", e?.message || e);
  }


  const confidence = Number(sig.confidence || 0);
  if (confidence < minConfidence) {
    console.log("No trade — confidence too low:", confidence, "<", minConfidence);
    return;
  }

  const pYes = probYesFromSignal(sig.direction, confidence);
  const predYes = clamp(Math.round(pYes * 100), 1, 99);
  const predNo = 100 - predYes;

  const resp = await getMarkets({ series_ticker: seriesTicker, status: "open", limit: 200, mve_filter: "exclude" });
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  console.log("Markets source: series(" + seriesTicker + ") — found:", markets.length);

  const prefix = seriesTicker + "-";
  const candidates = markets
    .filter(m => typeof m?.ticker === "string" && m.ticker.startsWith(prefix))
    .sort((a,b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 30);

  if (!candidates.length) {
    console.log("No tradable markets found after prefix filter:", prefix);
    return;
  }

  let best = null;

  for (const m of candidates) {
    const ticker = m.ticker;

    const px = await getExecutablePrices(ticker);
    const yesAsk = validPx(px.yesAsk ?? m.yes_ask ?? m.yesAsk ?? null);
    const noAsk  = validPx(px.noAsk  ?? m.no_ask  ?? m.noAsk  ?? null);

    const yesOk = yesAsk && yesAsk <= maxEntryPriceCents;
    const noOk  = noAsk  && noAsk  <= maxEntryPriceCents;

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
    console.log("No trade — no candidate had a valid ask (snapshot+orderbook both missing).");
    return;
  }

  console.log("Selected market:", best);
  console.log(
    "Edge check:",
    "predYES=" + predYes + "¢",
    "predNO=" + predNo + "¢",
    "chosen=" + best.side.toUpperCase(),
    "ask=" + best.askCents + "¢",
    "edge=" + best.edge + "¢",
    "minEdge=" + minEdge + "¢",
    "pxSource=" + best.pxSource
  );

  if (best.edge < minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  const count = calcContracts({ tradeSizeUsd, maxContracts, askCents: best.askCents });
  const line = "BUY " + best.side.toUpperCase() + " " + count + "x " + best.ticker + " @ " + best.askCents + "¢ (mode=" + mode + ")";
  console.log("Decision:", line);

  if (mode !== "live") {
    console.log("PAPER MODE — would place:", line);
    return;
  }

  const res = await placeOrder({ ticker: best.ticker, side: best.side, count, priceCents: best.askCents, action: "buy" });
  console.log("ORDER RESULT:", res);

  // best effort position write (won’t crash if Upstash token is read-only)
  try {
    await kvSetJson("bot:position", {
      ticker: best.ticker,
      side: best.side,
      entryPriceCents: best.askCents,
      count,
      openedTs: Date.now(),
      orderId: res?.order?.order_id || null
    });
    console.log("Saved bot:position");
  } catch (e) {
    console.log("WARN: bot:position not saved (Upstash token likely read-only):", e?.message || e);
  }
}

main().catch((e) => {
  console.error("Bot runner failed:", e?.message || e);
  process.exit(1);
});
