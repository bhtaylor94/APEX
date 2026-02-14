import { kvGetJson, kvSetJson } from "./kv.js";
import { getBTCSignal } from "./signal.js";
import { getBTCMarkets, getOrderbook, placeOrder, getMarket } from "./kalshi.js";
import { calcExitTargets, shouldForceExit } from "./exit_logic.js";

function nowMs() { return Date.now(); }

function normalizeSeries(s) {
  const x = String(s || "").trim();
  if (!x) return "KXBTC15M";
  return x.toUpperCase();
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function pickSideAndEdge({ signalDir, confidence, yesAsk, noAsk }) {
  // Very simple model:
  // predicted YES prob = 0.5 + 0.35*confidence when UP
  // predicted YES prob = 0.5 - 0.35*confidence when DOWN
  const c = clamp(confidence, 0, 1);
  const pYes = signalDir === "up" ? (0.5 + 0.35 * c) : signalDir === "down" ? (0.5 - 0.35 * c) : 0.5;
  const pNo = 1 - pYes;

  const predYesC = Math.round(pYes * 100);
  const predNoC = Math.round(pNo * 100);

  const edgeYes = (yesAsk != null) ? (predYesC - yesAsk) : -999;
  const edgeNo  = (noAsk  != null) ? (predNoC  - noAsk)  : -999;

  if (edgeYes >= edgeNo) {
    return { side: "yes", ask: yesAsk, edge: edgeYes, predYesC, predNoC };
  }
  return { side: "no", ask: noAsk, edge: edgeNo, predYesC, predNoC };
}

async function tryExitPosition({ cfg, pos }) {
  // Validate market still active
  const m = await getMarket(pos.ticker).catch(() => null);
  if (!m || (m.status && String(m.status).toLowerCase() !== "active")) {
    console.log("Position market not active anymore — clearing position.");
    await kvSetJson("bot:position", null);
    return { exited: false, cleared: true };
  }

  // Orderbook best bid needed to taker-exit
  const ob = await getOrderbook(pos.ticker).catch(() => null);
  const bestYesBid = ob?.bestYesBid ?? null;
  const bestNoBid  = ob?.bestNoBid  ?? null;

  const minutesToClose = Number.isFinite(m.close_ts) ? Math.max(0, Math.floor((m.close_ts * 1000 - nowMs()) / 60000)) : null;

  const { tp, sl } = calcExitTargets({
    side: pos.side,
    entryCents: pos.entryPriceCents,
    takeProfitPct: cfg.takeProfitPct ?? 0.20,
    stopLossPct: cfg.stopLossPct ?? 0.12
  });

  const forceExit = shouldForceExit({
    minutesToClose,
    minMinutesToCloseToHold: cfg.minMinutesToCloseToHold ?? 2
  });

  // If YES position, we SELL YES into YES bids. If NO position, SELL NO into NO bids.
  const bestBid = pos.side === "yes" ? bestYesBid : bestNoBid;

  // Decide target exit price:
  // - if forceExit: accept bestBid if exists
  // - else: take profit if bid >= tp, stop if bid <= sl (if exists)
  let decision = null;

  if (bestBid == null) {
    console.log("HOLD — no bid to exit on yet.");
    // Place/refresh a resting maker exit if configured
    // (This is what makes it autonomous even when bids are missing.)
    if (cfg.enableRestingExit !== false) {
      const target = forceExit ? sl : tp; // if near close, try get out at stop-ish price; otherwise target profit
      console.log(`RESTING EXIT: placing GTC SELL ${pos.side.toUpperCase()} @ ${target}¢ (post-only=${!!cfg.makerPostOnly})`);
      if (cfg.mode === "live") {
        await placeOrder({
          ticker: pos.ticker,
          action: "sell",
          side: pos.side,
          count: pos.count,
          priceCents: target,
          timeInForce: "good_till_canceled",
          postOnly: !!cfg.makerPostOnly,
          reduceOnly: true
        });
      } else {
        console.log("PAPER: would place resting exit.");
      }
    }
    return { exited: false };
  }

  if (forceExit) {
    decision = { why: `forceExit minutesToClose=${minutesToClose}`, px: bestBid, tif: "immediate_or_cancel" };
  } else if (bestBid >= tp) {
    decision = { why: `takeProfit bid=${bestBid}>=${tp}`, px: bestBid, tif: "immediate_or_cancel" };
  } else if (bestBid <= sl) {
    decision = { why: `stopLoss bid=${bestBid}<=${sl}`, px: bestBid, tif: "immediate_or_cancel" };
  } else {
    console.log(`HOLD — bid=${bestBid}¢ tp=${tp}¢ sl=${sl}¢ (minutesToClose=${minutesToClose ?? "?"})`);
    return { exited: false };
  }

  console.log(`EXIT NOW (${decision.why}): SELL ${pos.side.toUpperCase()} ${pos.count}x ${pos.ticker} @ ${decision.px}¢ (${cfg.mode})`);
  if (cfg.mode === "live") {
    const r = await placeOrder({
      ticker: pos.ticker,
      action: "sell",
      side: pos.side,
      count: pos.count,
      priceCents: decision.px,
      timeInForce: decision.tif,
      postOnly: false,
      reduceOnly: true
    });
    console.log("EXIT ORDER RESULT:", r);
  } else {
    console.log("PAPER: would exit now.");
  }

  // Clear position after placing exit (conservative)
  await kvSetJson("bot:position", null);
  return { exited: true };
}

async function main() {
  const cfgRaw = await kvGetJson("bot:config");
  const cfg = cfgRaw || {};
  cfg.seriesTicker = normalizeSeries(cfg.seriesTicker);

  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled (enabled=false).");
    return;
  }

  // Load existing position
  const pos = await kvGetJson("bot:position");
  if (pos && cfg.maxOpenPositions === 1) {
    // Try exit first; no new entries while holding
    await tryExitPosition({ cfg, pos });
    console.log("MaxOpenPositions: position exists, skipping entry.");
    return;
  }

  // Signal
  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  if (!sig || !sig.direction || sig.direction === "none" || sig.direction === "neutral") {
    console.log("No directional signal.");
    return;
  }
  if ((sig.confidence ?? 0) < (cfg.minConfidence ?? 0.15)) {
    console.log(`No trade — confidence too low (${sig.confidence} < ${cfg.minConfidence}).`);
    return;
  }

  // Markets
  const markets = await getBTCMarkets(cfg.seriesTicker);
  if (!markets.length) {
    console.log("No tradable markets found for series:", cfg.seriesTicker);
    return;
  }

  // pick best by volume with usable ask from snapshot-derived asks
  // (orderbooks often omit asks; derive from opposite best bid)
  let chosen = null;

  for (const m of markets.slice(0, 50)) {
    const ticker = m.ticker;
    const ob = await getOrderbook(ticker).catch(() => null);

    const yesAsk = ob?.yesAsk ?? null;
    const noAsk  = ob?.noAsk  ?? null;

    if (!yesAsk && !noAsk) continue;

    const decision = pickSideAndEdge({
      signalDir: sig.direction,
      confidence: sig.confidence ?? 0,
      yesAsk,
      noAsk
    });

    const ask = decision.ask;
    if (ask == null || ask <= 0 || ask >= 99) continue;
    if (cfg.maxEntryPriceCents != null && ask > cfg.maxEntryPriceCents) continue;

    if (decision.edge >= (cfg.minEdge ?? 5)) {
      chosen = {
        ticker,
        side: decision.side,
        askCents: ask,
        edge: decision.edge,
        predYesC: decision.predYesC,
        predNoC: decision.predNoC,
        volume: m.volume ?? 0
      };
      break;
    }
  }

  if (!chosen) {
    console.log("No trade — no candidate met edge/ask constraints.");
    return;
  }

  const count = Math.min(cfg.maxContracts ?? 5, Math.max(1, Math.floor((cfg.tradeSizeUsd ?? 5) * 100 / chosen.askCents)));
  console.log(
    `Decision: BUY ${chosen.side.toUpperCase()} ${count}x ${chosen.ticker} @ ${chosen.askCents}¢ | edge=${chosen.edge}¢ predYES=${chosen.predYesC} predNO=${chosen.predNoC} (${cfg.mode})`
  );

  if (cfg.mode === "paper") {
    console.log("PAPER: would place entry order.");
    await kvSetJson("bot:last_run", { action: "paper_entry", ...chosen, count, ts: nowMs() });
    return;
  }

  // LIVE entry (IOC taker)
  const r = await placeOrder({
    ticker: chosen.ticker,
    action: "buy",
    side: chosen.side,
    count,
    priceCents: chosen.askCents,
    timeInForce: "immediate_or_cancel",
    postOnly: false,
    reduceOnly: false
  });

  console.log("ORDER RESULT:", r);

  // Persist position using fill price (prefer API response)
  const filledPrice = chosen.side === "yes" ? (r?.order?.yes_price ?? chosen.askCents) : (r?.order?.no_price ?? chosen.askCents);

  const newPos = {
    ticker: chosen.ticker,
    side: chosen.side,
    count,
    entryPriceCents: filledPrice,
    entryTs: nowMs(),
    orderId: r?.order?.order_id || null
  };

  await kvSetJson("bot:position", newPos);
  console.log("Saved bot:position");
}

main().catch(async (e) => {
  console.error("Bot runner failed:", e);
  try { await kvSetJson("bot:last_run", { action: "error", error: String(e?.message || e), ts: Date.now() }); } catch {}
  process.exit(1);
});
