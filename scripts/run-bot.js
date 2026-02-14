import { listMarkets, getMarket, getOrderbook, deriveAsksFromOrderbook, createOrder } from "./kalshi.js";

function loadConfig() {
  const cfg = {
    enabled: true,
    mode: "paper",
    seriesTicker: "KXBTC15M",
    tradeSizeUsd: 5,
    maxContracts: 5,
    minConfidence: 0.15,
    minEdge: 5,
    maxEntryPriceCents: 85,
  };

  if (process.env.BOT_MODE) cfg.mode = String(process.env.BOT_MODE).toLowerCase();
  if (process.env.SERIES_TICKER) cfg.seriesTicker = String(process.env.SERIES_TICKER).toUpperCase();
  return cfg;
}

// TODO: replace with your real signal engine; leaving stub so runner is always testable end-to-end
async function getSignalStub() {
  const direction = Math.random() > 0.5 ? "up" : "down";
  return { direction, confidence: 0.2, price: 0 };
}

function sideFromSignal(direction) {
  if (direction === "up") return "yes";
  if (direction === "down") return "no";
  return null;
}

function predictedCentsFromConfidence(side, conf) {
  const tilt = Math.min(Math.max(conf, 0), 1) * 35; // 0..35
  // Value estimate in cents for the side we want
  return Math.round(50 + tilt);
}

function bestCandidates(markets) {
  const ms = Array.isArray(markets) ? markets : [];
  const active = ms.filter(m => String(m?.status || "").toLowerCase() === "active");
  const ranked = (active.length ? active : ms)
    .slice()
    .sort((a,b) => Number(b.volume || 0) - Number(a.volume || 0));
  // Try top N
  return ranked.slice(0, 20);
}

async function resolveAskForSide(ticker, side) {
  // 1) Try market snapshot
  const m = await getMarket(ticker);
  const snapYesAsk = (m?.market?.yes_ask ?? m?.yes_ask);
  const snapNoAsk  = (m?.market?.no_ask  ?? m?.no_ask);

  if (side === "yes" && Number.isFinite(Number(snapYesAsk))) return { askCents: Number(snapYesAsk), source: "snapshot", snapshot: m };
  if (side === "no"  && Number.isFinite(Number(snapNoAsk)))  return { askCents: Number(snapNoAsk),  source: "snapshot", snapshot: m };

  // 2) Derive from orderbook bids (asks implied from opposite bids)  [oai_citation:2‡Kalshi API Documentation](https://docs.kalshi.com/api-reference/market/get-market-orderbook?utm_source=chatgpt.com)
  const ob = await getOrderbook(ticker);
  const book = deriveAsksFromOrderbook(ob);
  const askCents = side === "yes" ? book.yesAsk : book.noAsk;

  return { askCents: askCents ?? null, source: "orderbook", book, snapshot: m };
}

async function main() {
  const cfg = loadConfig();
  console.log("CONFIG:", cfg);

  const signal = await getSignalStub();
  console.log("SIGNAL:", signal);

  if (!cfg.enabled) return console.log("Bot disabled — exiting.");
  if ((signal.confidence ?? 0) < cfg.minConfidence) {
    return console.log(`No trade — confidence ${(signal.confidence ?? 0).toFixed(3)} < minConfidence ${cfg.minConfidence}`);
  }

  const side = sideFromSignal(signal.direction);
  if (!side) return console.log("No trade — neutral signal.");

  const marketsResp = await listMarkets({ seriesTicker: cfg.seriesTicker, status: "active", limit: 100 });
  const markets = Array.isArray(marketsResp?.markets) ? marketsResp.markets : [];
  console.log(`Markets source: series(${cfg.seriesTicker}) — found: ${markets.length}`);

  if (!markets.length) return console.log("No tradable markets found for series:", cfg.seriesTicker);

  const candidates = bestCandidates(markets);

  let chosen = null;

  for (const m of candidates) {
    if (!m?.ticker) continue;

    try {
      const r = await resolveAskForSide(m.ticker, side);
      const ask = r.askCents;

      if (!ask || ask < 1 || ask > 99) {
        console.log(`Skip ${m.ticker} — no ask (${r.source})`, r.book ? `bestYesBid=${r.book.bestYesBid} bestNoBid=${r.book.bestNoBid}` : "");
        continue;
      }
      if (ask > cfg.maxEntryPriceCents) {
        console.log(`Skip ${m.ticker} — ask ${ask}¢ > maxEntryPriceCents ${cfg.maxEntryPriceCents}¢`);
        continue;
      }

      chosen = { market: m, askCents: ask, askSource: r.source, book: r.book };
      break;
    } catch (e) {
      console.log(`Skip ${m.ticker} — pricing error: ${e.message}`);
      continue;
    }
  }

  if (!chosen) {
    return console.log("No trade — no candidate market had a valid ask in top 20 by volume.");
  }

  const predicted = predictedCentsFromConfidence(side, signal.confidence);
  const edge = predicted - chosen.askCents;

  console.log("Selected market:", {
    ticker: chosen.market.ticker,
    status: chosen.market.status,
    volume: chosen.market.volume,
    askCents: chosen.askCents,
    askSource: chosen.askSource
  });

  console.log(`Edge check: predicted=${predicted}¢ market=${chosen.askCents}¢ edge=${edge}¢ minEdge=${cfg.minEdge}¢`);

  if (edge < cfg.minEdge) return console.log("No trade — edge too small.");

  const count = Math.max(1, Math.min(cfg.maxContracts, Math.floor(cfg.tradeSizeUsd / (chosen.askCents / 100))));
  const actionLine = `BUY ${side.toUpperCase()} ${count}x ${chosen.market.ticker} @ ${chosen.askCents}¢ (mode=${cfg.mode})`;
  console.log("Placing order:", actionLine);

  if (cfg.mode !== "live") {
    console.log("PAPER MODE — would have placed:", actionLine);
    return;
  }

  const result = await createOrder({
    ticker: chosen.market.ticker,
    action: "buy",
    side,
    count,
    priceCents: chosen.askCents,
    postOnly: false,
    tif: "fill_or_kill",
  });

  console.log("ORDER RESULT:", result);
  console.log("Done.");
}

main().catch((e) => {
  console.error("Bot runner failed:", e);
  process.exit(1);
});
