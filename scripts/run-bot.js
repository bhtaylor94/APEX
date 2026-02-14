import { kvGetJson, kvSetJson, kvIncr } from "./kv.js";
import { getMarketsBySeries, getMarket, getOrderbook, deriveAsksFromBids, createOrder } from "./kalshi.js";
import { getBTCSignal } from "./signal.js";

function nowMs() { return Date.now(); }
function clampInt(n, a, b) { return Math.max(a, Math.min(b, Math.floor(n))); }

function centsToUsd(c) { return (c / 100).toFixed(2); }

function computeTradeCount(tradeSizeUsd, askCents, maxContracts) {
  if (!Number.isFinite(askCents) || askCents <= 0) return 0;
  const budgetCents = Math.floor(Number(tradeSizeUsd) * 100);
  const maxByBudget = Math.floor(budgetCents / askCents);
  return clampInt(Math.min(maxByBudget, Number(maxContracts || 1)), 0, 100000);
}

function predictedYesCents(signalDirection, confidence) {
  // simple mapping: base 50, skew with confidence
  // confidence in [0..1]
  const c = Math.max(0, Math.min(1, Number(confidence || 0)));
  const skew = Math.round(c * 35); // up to 35c away from 50
  if (signalDirection === "up") return 50 + skew;
  if (signalDirection === "down") return 50 - skew;
  return 50;
}

async function pickBestBTC15mMarket(seriesTicker) {
  const resp = await getMarketsBySeries(seriesTicker, 200);
  const markets = Array.isArray(resp?.markets) ? resp.markets : [];
  if (!markets.length) return null;

  // Prefer the highest volume active market
  markets.sort((a, b) => (Number(b.volume || 0) - Number(a.volume || 0)));
  return markets[0] || null;
}

async function main() {
  const cfg = (await kvGetJson("bot:config")) || {};
  const config = {
    enabled: !!cfg.enabled,
    mode: cfg.mode || "paper",
    seriesTicker: (cfg.seriesTicker || "KXBTC15M").toUpperCase(),
    tradeSizeUsd: Number(cfg.tradeSizeUsd ?? 5),
    maxContracts: Number(cfg.maxContracts ?? 5),
    minConfidence: Number(cfg.minConfidence ?? 0.15),
    minEdge: Number(cfg.minEdge ?? 5),
    maxEntryPriceCents: Number(cfg.maxEntryPriceCents ?? 85),
    maxOpenPositions: Number(cfg.maxOpenPositions ?? 1),
    takeProfitPct: Number(cfg.takeProfitPct ?? 0.2),
    stopLossPct: Number(cfg.stopLossPct ?? 0.12),
  };

  console.log("CONFIG:", config);

  if (!config.enabled) {
    console.log("Bot disabled. Set bot:config.enabled=true to run.");
    return;
  }

  // ---- read signal
  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  // Normalize signal
  const direction = String(sig?.direction || sig?.dir || "none").toLowerCase();
  const confidence = Number(sig?.confidence || 0);

  // ---- load open position (if any)
  let pos = await kvGetJson("bot:position");

  // ---- POSITION MANAGEMENT: try to sell-to-close first
  if (pos && pos.ticker && pos.side && pos.count) {
    try {
      const m = await getMarket(pos.ticker);
      const status = (m?.market?.status || m?.status || "").toLowerCase();

      // if market no longer active, clear position (it will settle)
      if (status && status !== "active") {
        console.log("Position market no longer active (" + status + ") — clearing.");
        await kvSetJson("bot:position", null);
        pos = null;
      } else {
        const ob = await getOrderbook(pos.ticker, 10);
        const { bestYesBid, bestNoBid } = deriveAsksFromBids(ob);

        const exitBid = pos.side === "yes" ? bestYesBid : bestNoBid;
        if (!Number.isFinite(exitBid)) {
          console.log("HOLD — no bid to exit on yet.");
          // do not clear pos
        } else {
          const entry = Number(pos.entryCents);
          const tp = Math.round(entry * (1 + config.takeProfitPct));
          const sl = Math.round(entry * (1 - config.stopLossPct));

          console.log(`Position: ${pos.side.toUpperCase()} ${pos.count}x ${pos.ticker} entry=${entry}¢  exitBid=${exitBid}¢  TP=${tp}¢ SL=${sl}¢`);

          const shouldTP = exitBid >= tp;
          const shouldSL = exitBid <= sl;

          if (shouldTP || shouldSL) {
            const reason = shouldTP ? "TAKE_PROFIT" : "STOP_LOSS";
            console.log(`EXIT (${reason}): SELL ${pos.side.toUpperCase()} ${pos.count}x ${pos.ticker} @ ${exitBid}¢ (mode=${config.mode})`);

            if (config.mode === "live") {
              const out = await createOrder({
                ticker: pos.ticker,
                action: "sell",
                side: pos.side,
                count: pos.count,
                priceCents: exitBid,
                tif: "immediate_or_cancel",
              });
              console.log("EXIT ORDER RESULT:", out);
            } else {
              console.log("PAPER: would place exit order here.");
            }

            await kvSetJson("bot:last_exit", { ts: nowMs(), ticker: pos.ticker, side: pos.side, count: pos.count, exitBid, reason });
            await kvSetJson("bot:position", null);
            pos = null;
          } else {
            console.log("HOLD — TP/SL not hit.");
          }
        }
      }
    } catch (e) {
      console.log("Position check error — keeping position for next run:", e?.message || e);
    }
  }

  // ---- ENTRY: do not enter if maxOpenPositions reached
  if (pos && config.maxOpenPositions >= 1) {
    console.log("MaxOpenPositions: position exists, skipping entry.");
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "hold", note: "position_open" });
    return;
  }

  // ---- ENTRY: need a non-neutral direction and enough confidence
  if (direction !== "up" && direction !== "down") {
    console.log("No trade — direction is NONE/NEUTRAL.");
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "neutral" });
    return;
  }
  if (confidence < config.minConfidence) {
    console.log(`No trade — confidence ${confidence.toFixed(3)} < ${config.minConfidence}.`);
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "low_confidence", confidence });
    return;
  }

  // ---- pick market
  const market = await pickBestBTC15mMarket(config.seriesTicker);
  if (!market?.ticker) {
    console.log("No tradable markets found for series:", config.seriesTicker);
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "no_markets" });
    return;
  }

  // ---- use orderbook bids to derive asks
  const ob = await getOrderbook(market.ticker, 10);
  const { bestYesBid, bestNoBid, yesAsk, noAsk } = deriveAsksFromBids(ob);

  // If asks are null, no liquidity
  if (!Number.isFinite(yesAsk) && !Number.isFinite(noAsk)) {
    console.log("No trade — no derived asks. bestYesBid=", bestYesBid, "bestNoBid=", bestNoBid);
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "no_liquidity" });
    return;
  }

  // ---- Option 1: compute edge for BOTH sides, pick best
  const predYES = predictedYesCents(direction, confidence);
  const predNO  = 100 - predYES;

  const edgeYES = Number.isFinite(yesAsk) ? (predYES - yesAsk) : -999;
  const edgeNO  = Number.isFinite(noAsk)  ? (predNO  - noAsk)  : -999;

  let side = null;
  let askCents = null;
  let edge = null;

  if (edgeYES >= edgeNO) { side = "yes"; askCents = yesAsk; edge = edgeYES; }
  else { side = "no"; askCents = noAsk; edge = edgeNO; }

  console.log(`Edge check: predYES=${predYES}¢ predNO=${predNO}¢ yesAsk=${yesAsk}¢ noAsk=${noAsk}¢ edgeYES=${edgeYES}¢ edgeNO=${edgeNO}¢ chosen=${side.toUpperCase()} edge=${edge}¢ minEdge=${config.minEdge}¢`);

  if (!Number.isFinite(askCents) || askCents <= 0 || askCents >= 99) {
    console.log("No trade — invalid ask:", askCents);
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "invalid_ask", askCents });
    return;
  }

  if (askCents > config.maxEntryPriceCents) {
    console.log(`No trade — ask ${askCents}¢ > maxEntryPriceCents ${config.maxEntryPriceCents}¢`);
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "too_expensive", askCents });
    return;
  }

  if (edge < config.minEdge) {
    console.log("No trade — edge too small.");
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "edge_small", edge, askCents });
    return;
  }

  const count = computeTradeCount(config.tradeSizeUsd, askCents, config.maxContracts);
  if (count < 1) {
    console.log("No trade — size calc produced 0 contracts.");
    await kvSetJson("bot:last_run", { ts: nowMs(), action: "no_trade", note: "size_zero" });
    return;
  }

  console.log(`Decision: BUY ${side.toUpperCase()} ${count}x ${market.ticker} @ ${askCents}¢ (mode=${config.mode})`);

  if (config.mode === "live") {
    const out = await createOrder({
      ticker: market.ticker,
      action: "buy",
      side,
      count,
      priceCents: askCents,
      tif: "immediate_or_cancel",
    });
    console.log("ORDER RESULT:", out);
  } else {
    console.log("PAPER: would place entry order here.");
  }

  // Store position so future runs can attempt to exit
  await kvSetJson("bot:position", {
    ticker: market.ticker,
    side,
    count,
    entryCents: askCents,
    entryTs: nowMs(),
  });

  await kvIncr("bot:trades_today");
  await kvSetJson("bot:last_run", {
    ts: nowMs(),
    action: "entry",
    ticker: market.ticker,
    side,
    count,
    askCents,
    edge,
    confidence,
  });

  console.log("Saved bot:position");
}

main().catch(async (e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
