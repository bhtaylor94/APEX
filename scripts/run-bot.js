import { kvGetJson, kvSetJson } from "./kv.js";
import { getOrderbookTop, getSeriesMarkets, placeOrder } from "./kalshi.js";
import { getBTCSignal } from "./signal.js";

function nowMs() { return Date.now(); }

function clampInt(n, a, b) { return Math.max(a, Math.min(b, Math.floor(n))); }

function cfgDefaults(cfg) {
  const c = cfg || {};
  return {
    enabled: !!c.enabled,
    mode: c.mode || "paper",               // "paper" | "live"
    seriesTicker: (c.seriesTicker || "KXBTC15M").toUpperCase(),
    tradeSizeUsd: Number(c.tradeSizeUsd ?? 5),
    maxContracts: Number(c.maxContracts ?? 5),
    minConfidence: Number(c.minConfidence ?? 0.15),
    minEdge: Number(c.minEdge ?? 5),

    // Exit logic:
    takeProfitPct: Number(c.takeProfitPct ?? 0.20),  // 0.20 = +20% on entry cost
    stopLossPct: Number(c.stopLossPct ?? 0.12),      // 0.12 = -12% on entry cost

    // Safety rails:
    cooldownMinutes: Number(c.cooldownMinutes ?? 8),
    maxTradesPerDay: Number(c.maxTradesPerDay ?? 10),
    dailyMaxLossUsd: Number(c.dailyMaxLossUsd ?? 25),
    maxOpenPositions: Number(c.maxOpenPositions ?? 1),
  };
}

// Very small “market picker”:
// - filters open markets by prefix KXBTC15M-
// - picks the most liquid near-term market (highest volume)
function pickMarket(allMarkets, seriesTicker) {
  const prefix = (seriesTicker + "-").toLowerCase();

  // Kalshi responses may show status like: active/closed/etc. We only want tradable ones.
  const TRADABLE = new Set(["open", "active"]); // treat "active" as tradable

  const ms = (allMarkets || []).filter(m => {
    const t = String(m.ticker || "").toLowerCase();
    const st = String(m.status || "").toLowerCase();
    if (!t.startsWith(prefix)) return false;
    if (st && !TRADABLE.has(st)) return false; // exclude closed/settled/etc
    return true;
  });

  // Pick most liquid
  ms.sort((a, b) => (Number(b.volume || 0) - Number(a.volume || 0)));
  return ms[0] || null;
}

async function main() {
  const cfg = cfgDefaults(await kvGetJson("bot:config"));
  console.log("CONFIG:", cfg);

  if (!cfg.enabled) {
    console.log("Bot disabled (enabled=false).");
    return;
  }

  // Load state
  const state = (await kvGetJson("bot:state")) || {};
  const pos = state.position || null;

  // Compute signal (your signal.js already returns direction/confidence/price)
  const sig = await getBTCSignal();
  console.log("SIGNAL:", sig);

  // Pull markets by series_ticker (public, reliable)
  const seriesResp = await getSeriesMarkets(cfg.seriesTicker, { limit: 200 });
  const allMarkets = Array.isArray(seriesResp?.markets) ? seriesResp.markets : [];
  console.log(`Markets source: ${seriesResp.method}(${seriesResp.used}) — found: ${allMarkets.length}`);
  const market = pickMarket(allMarkets, cfg.seriesTicker);
if (!market) {
    console.log("No tradable markets found for series:", cfg.seriesTicker);
    return;
  }

  const marketTicker = market.ticker;
  const ob = await getOrderbookTop(marketTicker);

  // ---------- A) If we have an open position, manage exits ----------
  if (pos && pos.marketTicker === marketTicker) {
    const entry = Number(pos.entryPriceCents);
    const count = Number(pos.count);
    const side = pos.side; // "yes" | "no"

    // Mark-to-market using mid of derived bid/ask (fallback to bid if ask missing)
    const bid = side === "yes" ? ob.bestYesBid : ob.bestNoBid;
    const ask = side === "yes" ? ob.yesAsk : ob.noAsk;
    const mid = (bid != null && ask != null) ? Math.round((bid + ask) / 2) : (bid != null ? bid : ask);

    if (mid == null) {
      console.log("No orderbook prices to manage exit. Holding.");
      return;
    }

    const tp = Math.round(entry * (1 + cfg.takeProfitPct));
    const sl = Math.round(entry * (1 - cfg.stopLossPct));

    console.log("POSITION:", { marketTicker, side, count, entryPriceCents: entry, markCents: mid, tp, sl });

    const hitTP = mid >= tp;
    const hitSL = mid <= sl;

    // Optional: exit early if signal flips hard (simple rule)
    const signalFlipExit =
      (side === "yes" && sig.direction === "down" && sig.confidence >= cfg.minConfidence) ||
      (side === "no"  && sig.direction === "up"   && sig.confidence >= cfg.minConfidence);

    if (!hitTP && !hitSL && !signalFlipExit) {
      console.log("Hold position — no TP/SL/Flip exit.");
      return;
    }

    // SELL at best bid to be marketable
    const exitPrice = bid;
    if (exitPrice == null) {
      console.log("No bid to exit at. Holding.");
      return;
    }

    const reason = hitTP ? "TAKE_PROFIT" : hitSL ? "STOP_LOSS" : "SIGNAL_FLIP";
    console.log(`EXIT: ${reason} — Selling ${side.toUpperCase()} ${count}x @ ${exitPrice}¢`);

    if (cfg.mode === "live") {
      const out = await placeOrder({
        ticker: marketTicker,
        side,
        action: "sell",
        count,
        priceCents: exitPrice,
        time_in_force: "fill_or_kill",
        reduce_only: true,
      });
      console.log("EXIT ORDER RESULT:", out);
    } else {
      console.log("(paper) EXIT simulated.");
    }

    // Clear position
    state.position = null;
    await kvSetJson("bot:state", state);
    await kvSetJson("bot:last_run", { action: "exit", marketTicker, side, count, priceCents: exitPrice, reason, ts: nowMs() });
    console.log("Done.");
    return;
  }

  // ---------- B) If we do NOT have a position, consider entry ----------
  // Enforce maxOpenPositions using state only (simple)
  if (state.position) {
    console.log("State says position exists on another market. Not entering.");
    return;
  }

  // Direction mapping: up => buy YES, down => buy NO
  const dir = sig.direction;
  if (dir !== "up" && dir !== "down") {
    console.log("No trade — direction:", dir);
    return;
  }

  if (sig.confidence < cfg.minConfidence) {
    console.log("No trade — confidence below min:", sig.confidence, "<", cfg.minConfidence);
    return;
  }

  const side = dir === "up" ? "yes" : "no";
  const ask = side === "yes" ? ob.yesAsk : ob.noAsk;
  if (ask == null || ask <= 0 || ask >= 99) {
    console.log("No trade — missing/invalid ask:", ask);
    return;
  }

  // Simple “edge”: predictedProb - price (in cents)
  const predictedProbCents = Math.round(50 + (sig.confidence * 35)); // same idea you used earlier
  const edge = predictedProbCents - ask;

  console.log(`Edge check: predicted=${predictedProbCents}¢ market=${ask}¢ edge=${edge}¢ minEdge=${cfg.minEdge}¢`);
  if (edge < cfg.minEdge) {
    console.log("No trade — edge too small.");
    return;
  }

  // Size: fixed maxContracts (simple + safe)
  const count = clampInt(cfg.maxContracts, 1, 50);

  console.log(`ENTRY: BUY ${side.toUpperCase()} ${count}x ${marketTicker} @ ${ask}¢ (mode=${cfg.mode})`);

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

  // Save position state so next cron run can manage exits
  state.position = {
    marketTicker,
    side,
    count,
    entryPriceCents: ask,
    enteredTs: nowMs(),
  };

  await kvSetJson("bot:state", state);
  await kvSetJson("bot:last_run", { action: "enter", marketTicker, side, count, priceCents: ask, edge, ts: nowMs() });

  console.log("Done.");
}

main().catch(e => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
