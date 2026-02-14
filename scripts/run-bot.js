import { kvGetJson, kvSetJson } from "./kv.js";
import { getSeriesMarkets, getOrderbookTop, placeOrder } from "./kalshi.js";
import { getBTCSignal } from "./signal.js";

function nowMs() { return Date.now(); }

function dollarsToCents(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function cfgDefaults(cfg) {
  const c = cfg || {};
  return {
    enabled: !!c.enabled,
    mode: c.mode || "paper", // "paper" | "live"
    seriesTicker: String(c.seriesTicker || "KXBTC15M").toUpperCase(),

    tradeSizeUsd: Number(c.tradeSizeUsd ?? 5),
    maxContracts: Number(c.maxContracts ?? 5),

    minConfidence: Number(c.minConfidence ?? 0.15),
    minEdge: Number(c.minEdge ?? 5),

    takeProfitPct: Number(c.takeProfitPct ?? 0.20),
    stopLossPct: Number(c.stopLossPct ?? 0.12),

    cooldownMinutes: Number(c.cooldownMinutes ?? 8),
    maxTradesPerDay: Number(c.maxTradesPerDay ?? 10),
    dailyMaxLossUsd: Number(c.dailyMaxLossUsd ?? 25),
    maxOpenPositions: Number(c.maxOpenPositions ?? 1),

    maxEntryPriceCents: Number(c.maxEntryPriceCents ?? 85),

    // Entry mode:
    // "maker" = only post bids at fair value
    // "momentum" = only take when strong, even if slightly overpriced
    // "maker+momentum" = maker by default, momentum when strong
    entryPolicy: String(c.entryPolicy || "maker+momentum"),

    // Maker knobs
    makerBufferCents: Number(c.makerBufferCents ?? 2),
    makerPostOnly: c.makerPostOnly !== false, // default true
    makerTif: String(c.makerTif || "good_till_canceled"),

    // Momentum knobs
    momentumMinConfidence: Number(c.momentumMinConfidence ?? 0.45),
    momentumMaxOverpayCents: Number(c.momentumMaxOverpayCents ?? 8),
  };
}

function tradableStatus(s) {
  const st = String(s || "").toLowerCase();
  return st === "active" || st === "open";
}

function snapQuoteCents(market) {
  const yesAsk = market?.yes_ask_dollars != null ? dollarsToCents(market.yes_ask_dollars)
               : (Number.isFinite(Number(market?.yes_ask)) ? Number(market.yes_ask) : null);
  const noAsk  = market?.no_ask_dollars  != null ? dollarsToCents(market.no_ask_dollars)
               : (Number.isFinite(Number(market?.no_ask)) ? Number(market.no_ask) : null);

  const yesBid = market?.yes_bid_dollars != null ? dollarsToCents(market.yes_bid_dollars)
               : (Number.isFinite(Number(market?.yes_bid)) ? Number(market.yes_bid) : null);
  const noBid  = market?.no_bid_dollars  != null ? dollarsToCents(market.no_bid_dollars)
               : (Number.isFinite(Number(market?.no_bid)) ? Number(market.no_bid) : null);

  // Derive asks from bids if asks missing
  const yesAsk2 = yesAsk != null ? yesAsk : (noBid != null ? (100 - noBid) : null);
  const noAsk2  = noAsk  != null ? noAsk  : (yesBid != null ? (100 - yesBid) : null);

  return { yesAsk: yesAsk2, noAsk: noAsk2, yesBid, noBid };
}

function validAsk(a) {
  return a != null && a > 0 && a < 99;
}

async function pickMarketWithLiquidity(markets, seriesTicker, side, maxEntryPriceCents) {
  const prefix = (seriesTicker + "-").toLowerCase();

  const candidates = (markets || [])
    .filter(m => String(m?.ticker || "").toLowerCase().startsWith(prefix))
    .filter(m => tradableStatus(m?.status))
    .sort((a, b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, 50);

  for (const m of candidates) {
    const q = snapQuoteCents(m);
    const askSnap = side === "yes" ? q.yesAsk : q.noAsk;

    if (validAsk(askSnap) && askSnap <= maxEntryPriceCents) {
      return { market: m, ask: askSnap, source: "snapshot" };
    }

    // fallback: orderbook-derived ask
    try {
      const ob = await getOrderbookTop(m.ticker);
      const askOb = side === "yes" ? ob.yesAsk : ob.noAsk;
      if (validAsk(askOb) && askOb <= maxEntryPriceCents) {
        return { market: m, ask: askOb, source: "orderbook" };
      }
    } catch {
      // ignore
    }
  }

  return { market: null, ask: null, source: "none" };
}

function clampCents(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(98, Math.round(n)));
}

async function main() {
  const cfg = cfgDefaults(await kvGetJson("bot:config"));
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled (enabled=false).");
    return;
  }

  const state = (await kvGetJson("bot:state")) || {};
  const pos = state.position || null;

  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  const seriesResp = await getSeriesMarkets(cfg.seriesTicker, { limit: 200 });
  const allMarkets = Array.isArray(seriesResp?.markets) ? seriesResp.markets : [];
  console.log(`Markets source: series(${seriesResp.used || cfg.seriesTicker}) — found: ${allMarkets.length}`);

  // Exit manager (if you already have a position tracked)
  if (pos?.marketTicker) {
    const marketTicker = pos.marketTicker;
    const side = pos.side;
    const count = Number(pos.count);
    const entry = Number(pos.entryPriceCents);

    const ob = await getOrderbookTop(marketTicker);
    const bid = side === "yes" ? ob.bestYesBid : ob.bestNoBid;
    const ask = side === "yes" ? ob.yesAsk : ob.noAsk;
    const mid = (bid != null && ask != null) ? Math.round((bid + ask) / 2) : (bid != null ? bid : ask);

    if (mid == null || bid == null) {
      console.log("POSITION: cannot price/exit (no orderbook). Holding.", { marketTicker, side, count, entryPriceCents: entry });
      return;
    }

    const tp = Math.round(entry * (1 + cfg.takeProfitPct));
    const sl = Math.round(entry * (1 - cfg.stopLossPct));

    const hitTP = mid >= tp;
    const hitSL = mid <= sl;

    const flipExit =
      (side === "yes" && sig.direction === "down" && sig.confidence >= cfg.minConfidence) ||
      (side === "no"  && sig.direction === "up"   && sig.confidence >= cfg.minConfidence);

    console.log("POSITION:", { marketTicker, side, count, entryPriceCents: entry, markCents: mid, bidCents: bid, tp, sl, hitTP, hitSL, flipExit });

    if (!hitTP && !hitSL && !flipExit) {
      console.log("Hold position — no TP/SL/Flip exit.");
      return;
    }

    const reason = hitTP ? "TAKE_PROFIT" : hitSL ? "STOP_LOSS" : "SIGNAL_FLIP";
    console.log(`EXIT: ${reason} — SELL ${side.toUpperCase()} ${count}x ${marketTicker} @ ${bid}¢`);

    if (cfg.mode === "live") {
      const out = await placeOrder({
        ticker: marketTicker,
        side,
        action: "sell",
        count,
        priceCents: bid,
        time_in_force: "fill_or_kill",
        reduce_only: true,
      });
      console.log("EXIT ORDER RESULT:", out);
    } else {
      console.log("(paper) EXIT simulated.");
    }

    state.position = null;
    await kvSetJson("bot:state", state);
    await kvSetJson("bot:last_run", { action: "exit", marketTicker, side, count, priceCents: bid, reason, ts: nowMs() });
    console.log("Done.");
    return;
  }

  // Entry
  if (sig.direction !== "up" && sig.direction !== "down") {
    console.log("No trade — direction:", sig.direction);
    return;
  }
  if (sig.confidence < cfg.minConfidence) {
    console.log("No trade — confidence below min:", sig.confidence, "<", cfg.minConfidence);
    return;
  }

  const side = sig.direction === "up" ? "yes" : "no";

  const pick = await pickMarketWithLiquidity(allMarkets, cfg.seriesTicker, side, cfg.maxEntryPriceCents);
  if (!pick.market || pick.ask == null) {
    console.log("No tradable markets found for series:", cfg.seriesTicker, "(no actionable quotes within maxEntryPrice)");
    return;
  }

  const marketTicker = pick.market.ticker;
  const ask = pick.ask;

  console.log("Selected market:", { ticker: marketTicker, status: pick.market.status, volume: pick.market.volume, askCents: ask, source: pick.source });

  // Simple fair value mapping (yours)
  const predictedProbCents = Math.round(50 + (sig.confidence * 35));
  const edge = predictedProbCents - ask;

  console.log(`Edge check: predicted=${predictedProbCents}¢ market=${ask}¢ edge=${edge}¢ minEdge=${cfg.minEdge}¢`);

  const policy = String(cfg.entryPolicy || "maker+momentum");
  const count = Math.max(1, Math.min(Number(cfg.maxContracts) || 1, 50));

  // VALUE (taker) if good edge
  if (edge >= cfg.minEdge) {
    console.log(`ENTRY (VALUE): BUY ${side.toUpperCase()} ${count}x ${marketTicker} @ ${ask}¢ (FoK taker, mode=${cfg.mode})`);

    if (cfg.mode === "live") {
      const out = await placeOrder({
        ticker: marketTicker,
        side,
        action: "buy",
        count,
        priceCents: ask,
        time_in_force: "fill_or_kill",
        reduce_only: false,
      });
      console.log("ENTRY ORDER RESULT:", out);
    } else {
      console.log("(paper) ENTRY simulated.");
    }

    state.position = { marketTicker, side, count, entryPriceCents: ask, enteredTs: nowMs() };
    await kvSetJson("bot:state", state);
    await kvSetJson("bot:last_run", { action: "enter_value", marketTicker, side, count, priceCents: ask, edge, ts: nowMs() });
    console.log("Done.");
    return;
  }

  // MOMENTUM (taker) if strong and not too overpriced
  const allowMomentum = (policy === "momentum" || policy === "maker+momentum");
  if (allowMomentum && sig.confidence >= cfg.momentumMinConfidence) {
    const maxOverpay = cfg.momentumMaxOverpayCents;
    if (edge >= -maxOverpay) {
      console.log(`ENTRY (MOMENTUM): BUY ${side.toUpperCase()} ${count}x ${marketTicker} @ ${ask}¢ (edge=${edge}¢ cap=-${maxOverpay}¢, mode=${cfg.mode})`);

      if (cfg.mode === "live") {
        const out = await placeOrder({
          ticker: marketTicker,
          side,
          action: "buy",
          count,
          priceCents: ask,
          time_in_force: "fill_or_kill",
          reduce_only: false,
        });
        console.log("ENTRY ORDER RESULT:", out);
      } else {
        console.log("(paper) ENTRY simulated.");
      }

      state.position = { marketTicker, side, count, entryPriceCents: ask, enteredTs: nowMs() };
      await kvSetJson("bot:state", state);
      await kvSetJson("bot:last_run", { action: "enter_momentum", marketTicker, side, count, priceCents: ask, edge, ts: nowMs() });
      console.log("Done.");
      return;
    }
    console.log(`No momentum trade — too overpriced: edge=${edge}¢ < -${maxOverpay}¢`);
  }

  // MAKER (post-only bid near fair value)
  const allowMaker = (policy === "maker" || policy === "maker+momentum");
  if (allowMaker) {
    const buffer = cfg.makerBufferCents;
    let bid = clampCents(predictedProbCents - buffer);
    if (bid == null) {
      console.log("No maker trade — invalid bid calc.");
      return;
    }
    bid = Math.min(bid, cfg.maxEntryPriceCents);

    console.log(`ENTRY (MAKER): POST_ONLY BUY ${side.toUpperCase()} ${count}x ${marketTicker} @ ${bid}¢ (pred=${predictedProbCents}¢ buffer=${buffer}¢)`);

    if (cfg.mode === "live") {
      const out = await placeOrder({
        ticker: marketTicker,
        side,
        action: "buy",
        count,
        priceCents: bid,
        time_in_force: cfg.makerTif,
        post_only: cfg.makerPostOnly,
        reduce_only: false,
      });
      console.log("MAKER ORDER RESULT:", out);
      await kvSetJson("bot:last_run", { action: "place_maker_bid", marketTicker, side, count, priceCents: bid, edge, ts: nowMs() });
    } else {
      console.log("(paper) MAKER bid simulated.");
    }

    console.log("Done.");
    return;
  }

  console.log("No trade — edge too small and policy disallows maker/momentum.");
}

main().catch(e => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
