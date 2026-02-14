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

// Replace with your real signal engine when ready.
async function getSignalStub() {
  const direction = Math.random() > 0.5 ? "up" : "down";
  return { direction, confidence: 0.2, price: 0 };
}

function sideFromSignal(direction) {
  if (direction === "up") return "yes";
  if (direction === "down") return "no";
  return null;
}

function predictedCentsFromConfidence(conf) {
  const tilt = Math.min(Math.max(conf, 0), 1) * 35;
  return Math.round(50 + tilt);
}

function topByVolume(markets, n=30) {
  const ms = Array.isArray(markets) ? markets : [];
  return ms
    .slice()
    .sort((a,b) => Number(b.volume || 0) - Number(a.volume || 0))
    .slice(0, n);
}

async function resolveAskForSide(ticker, side) {
  const m = await getMarket(ticker);

  const snapYesAsk = (m?.market?.yes_ask ?? m?.yes_ask);
  const snapNoAsk  = (m?.market?.no_ask  ?? m?.no_ask);

  // Snapshot ask must be 1..99 (avoid null=>0 bug)
  if (side === "yes") {
    const v = Number(snapYesAsk);
    if (Number.isFinite(v) && v >= 1 && v <= 99) return { askCents: v, source: "snapshot" };
  }
  if (side === "no") {
    const v = Number(snapNoAsk);
    if (Number.isFinite(v) && v >= 1 && v <= 99) return { askCents: v, source: "snapshot" };
  }

  const ob = await getOrderbook(ticker);
  const book = deriveAsksFromOrderbook(ob);
  const askCents = side === "yes" ? book.yesAsk : book.noAsk;

  return { askCents: askCents ?? null, source: "orderbook", book };
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

  const prefix = cfg.seriesTicker + "-";

  // 1) Try server-side series filter
  let markets = [];
  try {
    const r = await listMarkets({ seriesTicker: cfg.seriesTicker, status: "active", limit: 300 });
    markets = Array.isArray(r?.markets) ? r.markets : [];
    console.log(`Markets source: series(${cfg.seriesTicker}) — found: ${markets.length}`);
  } catch (e) {
    console.log("listMarkets(series) error:", e.message);
  }

  // Hard-filter to series by ticker prefix (fixes “sports markets” issue)
  let filtered = markets.filter(m => String(m?.ticker || "").startsWith(prefix));

  // 2) If series filter didn’t work, fallback to ALL active markets then prefix filter
  if (filtered.length === 0) {
    console.log(`Series filter returned 0 tickers starting with ${prefix}. Falling back to ALL active markets...`);
    const r2 = await listMarkets({ seriesTicker: undefined, status: "active", limit: 500 });
    const all = Array.isArray(r2?.markets) ? r2.markets : [];
    console.log(`Markets source: ALL_ACTIVE — found: ${all.length}`);
    filtered = all.filter(m => String(m?.ticker || "").startsWith(prefix));
  }

  console.log(`BTC series candidates (${prefix}*): ${filtered.length}`);
  if (filtered.length === 0) {
    // print sample tickers to help debug what the API is returning
    const sample = markets.slice(0, 10).map(m => m?.ticker).filter(Boolean);
    console.log("Sample tickers returned:", sample);
    return console.log("No tradable BTC15M markets found after filtering. Check seriesTicker spelling.");
  }

  // Try the most liquid BTC15M markets first
  const candidates = topByVolume(filtered, 30);

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

      chosen = { market: m, askCents: ask, askSource: r.source };
      break;
    } catch (e) {
      console.log(`Skip ${m.ticker} — pricing error: ${e.message}`);
    }
  }

  if (!chosen) {
    return console.log("No trade — no candidate BTC15M market had a valid ask in top 30 by volume.");
  }

  const predicted = predictedCentsFromConfidence(signal.confidence);
  const edge = predicted - chosen.askCents;

  console.log("Selected market:", {
    ticker: chosen.market.ticker,
    status: chosen.market.status,
    volume: chosen.market.volume,
    askCents: chosen.askCents,
    askSource: chosen.askSource,
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
